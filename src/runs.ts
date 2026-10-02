import { loadMemoryArtifact } from "./dsl/index.js";
import type { CompiledMemoryArtifact } from "./dsl/index.js";
import { MemoryInputError, MemoryRunError, MemoryRuntimeError } from "./errors.js";
import { parseLikelihoodJudgment } from "./likelihood.js";
import type { LikelihoodJudgment, VerifiedLikelihood } from "./likelihood.js";
import { MemoryRuntime } from "./runtime.js";
import { InMemoryStore } from "./stores/in-memory.js";
import type { ExecutionObservation, MemoryInput, RecallRequest, RecallResult, RuntimeLimits } from "./types.js";
import { checkFields, snapshotJson } from "./validation.js";

export interface RunJudgmentEvidence {
  readonly judgment: LikelihoodJudgment;
  readonly facts: MemoryInput;
  /** Supplied by trusted host code after factual verification. */
  readonly verification?: { readonly likelihood: VerifiedLikelihood; readonly evidence: unknown };
}

export interface RunReference {
  readonly id: string;
  readonly resource: string;
}

export interface MemoryRun extends RunReference {
  readonly formatVersion: 1;
  readonly status: "completed" | "failed";
  readonly createdAt: string;
  readonly completedAt: string;
  readonly artifact: CompiledMemoryArtifact;
  readonly request: RecallRequest;
  readonly runtimeLimits: Required<RuntimeLimits>;
  readonly judgments: readonly RunJudgmentEvidence[];
  /** On failure this is diagnostic partial output, not a successful recall. */
  readonly result: RecallResult;
  readonly observation: ExecutionObservation;
  readonly metrics: {
    readonly executions: number;
    readonly activations: number;
    readonly memoryCount: number;
    readonly maxDepth: number;
    readonly durationMs: number;
  };
  readonly error?: { readonly code: string; readonly message: string; readonly invocation?: { readonly ref: string; readonly depth: number } };
  readonly replay?: { readonly of: string; readonly matches: boolean };
}

export interface MemoryRunStore {
  /** Insert once. An existing ID must never be overwritten. */
  save(run: MemoryRun): Promise<void>;
  get(id: string): Promise<MemoryRun | undefined>;
}

export function checkRunId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new MemoryRunError("Expected a canonical UUID v4 Run ID.");
  }
}

/** Stable JSON for record integrity and semantic comparisons, independent of key order. */
export function serializeRunValue(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    return item;
  };
  return JSON.stringify(sort(snapshotJson(value)));
}

/** Validate the stored envelope's basic shape without compiling or executing memories. */
export function parseMemoryRun(value: unknown): MemoryRun {
  try {
    const run = snapshotJson(value);
    checkFields(run, "run");
    checkRunId(run.id as string);
    if (run.formatVersion !== 1 || run.resource !== `fnmem://run/${run.id}` || !["completed", "failed"].includes(run.status as string)) throw new Error("Invalid Run version, resource or status.");
    if (typeof run.createdAt !== "string" || typeof run.completedAt !== "string" || !Number.isFinite(Date.parse(run.createdAt)) || !Number.isFinite(Date.parse(run.completedAt))) throw new Error("Invalid Run timestamps.");
    for (const field of ["artifact", "request", "runtimeLimits", "result", "observation", "metrics"] as const) checkFields(run[field], `run.${field}`);
    const result = run.result as Record<string, unknown>, observation = run.observation as Record<string, unknown>;
    if (!Array.isArray(run.judgments) || !Array.isArray(result.messages) || !Array.isArray(result.trace) || !Number.isSafeInteger(result.executed) || (result.executed as number) < 0 || !Array.isArray(observation.invocations) || !Array.isArray(observation.activations)) throw new Error("Invalid Run result or observation.");
    if (run.status === "failed") {
      checkFields(run.error, "run.error");
      if (typeof run.error.code !== "string" || typeof run.error.message !== "string") throw new Error("Invalid Run failure.");
    } else if (run.error !== undefined) throw new Error("A completed Run cannot contain a failure.");
    return run as unknown as MemoryRun;
  } catch (error) {
    throw new MemoryRunError(error instanceof Error ? error.message : String(error));
  }
}

function parseJudgments(value: readonly RunJudgmentEvidence[]): readonly RunJudgmentEvidence[] {
  const entries = snapshotJson(value) as readonly RunJudgmentEvidence[];
  if (!Array.isArray(entries)) throw new MemoryInputError("Expected judgment evidence array.");
  for (const entry of entries) {
    checkFields(entry, "judgment evidence");
    checkFields(entry.facts, "judgment facts");
    checkFields(entry.judgment, "judgment record");
    if (Object.keys(entry).some((key) => !["judgment", "facts", "verification"].includes(key))) throw new MemoryInputError("Unknown judgment evidence fields.");
    if (entry.verification !== undefined) {
      checkFields(entry.verification, "judgment verification");
      if (Object.keys(entry.verification).sort().join(",") !== "evidence,likelihood") throw new MemoryInputError("Host verification requires retained evidence and a likelihood identifier.");
    }
    const data = entry as unknown as RunJudgmentEvidence;
    const parsed = parseLikelihoodJudgment({ likelihood: data.judgment.likelihood }, {
      version: data.judgment.version,
      ...(data.verification ? { verified: data.verification.likelihood } : {}),
    });
    if (serializeRunValue(parsed) !== serializeRunValue(entry.judgment)) throw new MemoryInputError("Judgment record does not match the versioned vocabulary.");
  }
  return entries;
}

function semanticOutcome(run: MemoryRun): unknown {
  return { result: run.result, observation: run.observation, error: run.error ?? null };
}

export class MemoryRunService {
  readonly #limits: Required<RuntimeLimits>;

  constructor(private readonly store: MemoryRunStore, limits: RuntimeLimits = {}) {
    this.#limits = new MemoryRuntime(new InMemoryStore(), limits).limits;
  }

  async recall(artifact: CompiledMemoryArtifact, request: RecallRequest, judgments: readonly RunJudgmentEvidence[] = []): Promise<RunReference> {
    const run = await this.#execute(artifact, request, judgments, this.#limits);
    return Object.freeze({ id: run.id, resource: run.resource });
  }

  async read(id: string): Promise<MemoryRun> {
    checkRunId(id);
    const record = await this.store.get(id);
    if (!record) throw new MemoryRunError(`Run not found: ${id}`, "E_RUN_NOT_FOUND");
    const run = parseMemoryRun(record);
    if (run.id !== id) throw new MemoryRunError("Stored Run ID mismatch.");
    return run;
  }

  async replay(id: string): Promise<RunReference & { readonly matches: boolean }> {
    const original = await this.read(id);
    // Replay original host ceilings and source, not this service's current defaults.
    const run = await this.#execute(original.artifact, original.request, original.judgments, original.runtimeLimits, original);
    return Object.freeze({ id: run.id, resource: run.resource, matches: run.replay!.matches });
  }

  async #execute(artifact: CompiledMemoryArtifact, request: RecallRequest, judgments: readonly RunJudgmentEvidence[], limits: RuntimeLimits, original?: MemoryRun): Promise<MemoryRun> {
    // Non-JSON requests and invalid artifacts/evidence are rejected before acceptance.
    const query = snapshotJson(request) as RecallRequest;
    checkFields(query, "request");
    const evidence = parseJudgments(judgments);
    const bundle = await loadMemoryArtifact(snapshotJson(artifact) as CompiledMemoryArtifact);
    const runtime = new MemoryRuntime(bundle, limits);
    const id = globalThis.crypto.randomUUID();
    const createdAt = new Date().toISOString(), start = performance.now();
    let status: MemoryRun["status"] = "completed";
    let result: RecallResult, observation: ExecutionObservation, failure: MemoryRun["error"];
    try {
      ({ result, observation } = await runtime.recallObserved(query));
    } catch (error) {
      if (!(error instanceof MemoryRuntimeError)) throw error;
      status = "failed";
      result = error.partial!;
      observation = error.observation!;
      failure = { code: error.code, message: error.message, ...(error.invocation ? { invocation: error.invocation } : {}) };
    }
    const completed = observation.invocations.filter((entry) => entry.status === "completed");
    const draft: MemoryRun = {
      formatVersion: 1, id, resource: `fnmem://run/${id}`, status,
      createdAt, completedAt: new Date().toISOString(),
      artifact: bundle.artifact, request: query, runtimeLimits: runtime.limits, judgments: evidence,
      result, observation,
      metrics: {
        executions: result.executed, activations: observation.activations.length,
        memoryCount: new Set(completed.map((entry) => entry.ref)).size,
        maxDepth: completed.reduce((maximum, entry) => Math.max(maximum, entry.depth), 0), durationMs: performance.now() - start,
      },
      ...(failure ? { error: failure } : {}),
    };
    const run = parseMemoryRun({ ...draft, ...(original ? { replay: { of: original.id, matches: serializeRunValue(semanticOutcome(draft)) === serializeRunValue(semanticOutcome(original)) } } : {}) });
    // No reference is returned unless storage has accepted the terminal record.
    await this.store.save(run);
    return run;
  }
}
