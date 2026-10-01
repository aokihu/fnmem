import type { RuntimeLimits, TextEmission } from "../src/types.js";

export interface RecallQuery {
  readonly context: Readonly<Record<string, unknown>>;
  readonly entrypoints: readonly { readonly ref: string; readonly input: Readonly<Record<string, unknown>> }[];
  readonly limits: Required<RuntimeLimits>;
}

interface MemoryRevision {
  readonly snapshotHash: string;
  readonly compilerVersion: string;
  readonly runtimeVersion: string;
}

export interface ConsistencyPlan {
  readonly version: string;
  readonly mode: "fixture" | "model";
  readonly condition: "text" | "dsl";
  readonly inputMode: "fixed" | "model-generated";
  readonly models: readonly string[];
  readonly repetitions: number;
  readonly memory: MemoryRevision;
  readonly cases: readonly {
    readonly id: string;
    readonly query: RecallQuery;
    readonly expectedMessages: readonly TextEmission[];
  }[];
}

export interface RecallSample {
  readonly id: string;
  readonly case: string;
  readonly model: string;
  readonly repetition: number;
  readonly memory: MemoryRevision;
  readonly query: RecallQuery | null;
  readonly status: "completed" | "failed";
  readonly messages?: readonly TextEmission[];
  readonly error?: string;
}

// Object insertion order is irrelevant; emission order and text are preserved.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Recall inputs and outputs must be finite JSON values");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkQuery(query: RecallQuery): string {
  if (!query || !query.context || typeof query.context !== "object" || Array.isArray(query.context) || !Array.isArray(query.entrypoints)) throw new Error("Invalid canonical recall query");
  if (Object.keys(query.context).some((name) => name.startsWith("__"))) throw new Error("Canonical queries cannot supply reserved '__' context fields");
  for (const entry of query.entrypoints) {
    if (!entry || !nonempty(entry.ref) || !entry.input || typeof entry.input !== "object" || Array.isArray(entry.input)) throw new Error("Canonical entrypoints require ref and input");
    if (Object.keys(entry.input).some((name) => name.startsWith("__"))) throw new Error("Canonical queries cannot supply reserved '__' input fields");
  }
  for (const key of ["maxExecutions", "maxDepth", "maxVisitsPerMemory"] as const) {
    const limit = query.limits?.[key];
    if (!Number.isSafeInteger(limit) || limit < (key === "maxDepth" ? 0 : 1)) throw new Error("Canonical queries require explicit execution limits");
  }
  return canonicalJson(query);
}

function checkMessages(messages: readonly TextEmission[] | undefined): string {
  if (!Array.isArray(messages) || messages.some((message) => !message || message.type !== "text" || typeof message.content !== "string" || (message.source !== undefined && !nonempty(message.source)))) throw new Error("Expected ordered text emissions");
  return canonicalJson(messages);
}

export function createConsistencyReport(plan: ConsistencyPlan, samples: readonly RecallSample[]) {
  if (!nonempty(plan.version) || !["fixture", "model"].includes(plan.mode) || !["text", "dsl"].includes(plan.condition) || !["fixed", "model-generated"].includes(plan.inputMode)) throw new Error("Invalid consistency plan");
  if (!Array.isArray(plan.models) || plan.models.length < 2 || plan.models.some((model) => !nonempty(model)) || new Set(plan.models).size !== plan.models.length) throw new Error("Consistency evaluation requires at least two distinct model identities");
  if (!Number.isSafeInteger(plan.repetitions) || plan.repetitions < 1) throw new Error("Invalid repetition count");
  if (!plan.memory || ![plan.memory.snapshotHash, plan.memory.compilerVersion, plan.memory.runtimeVersion].every(nonempty)) throw new Error("Memory snapshot and compiler/runtime revisions are required");
  if (!Array.isArray(plan.cases) || !plan.cases.length) throw new Error("No consistency cases");
  const cases = new Map<string, { query: string; messages: string }>();
  for (const item of plan.cases) {
    if (!nonempty(item.id) || cases.has(item.id)) throw new Error("Invalid or duplicate consistency case");
    cases.set(item.id, { query: checkQuery(item.query), messages: checkMessages(item.expectedMessages) });
  }
  const rows = new Map<string, { sample: RecallSample; query: string | null; messages: string | null }>();
  const ids = new Set<string>();
  for (const sample of samples) {
    if (!nonempty(sample.id) || ids.has(sample.id)) throw new Error("Invalid or duplicate recall sample ID");
    ids.add(sample.id);
    if (!cases.has(sample.case) || !plan.models.includes(sample.model) || !Number.isSafeInteger(sample.repetition) || sample.repetition < 0 || sample.repetition >= plan.repetitions) throw new Error("Unplanned recall sample");
    if (canonicalJson(sample.memory) !== canonicalJson(plan.memory)) throw new Error("Cannot compare different memory snapshots or compiler/runtime revisions");
    if (!["completed", "failed"].includes(sample.status)) throw new Error("Invalid recall status");
    if (sample.status === "failed" && !nonempty(sample.error)) throw new Error("Failed recall must retain its error");
    if (sample.status === "completed" && (sample.query === null || sample.error !== undefined)) throw new Error("Completed recall requires a query and no error");
    const cell = JSON.stringify([sample.case, sample.repetition, sample.model]);
    if (rows.has(cell)) throw new Error("Duplicate case/repetition/model sample");
    rows.set(cell, {
      sample, query: sample.query === null ? null : checkQuery(sample.query),
      messages: sample.status === "completed" ? checkMessages(sample.messages) : null,
    });
  }
  const missing: string[] = [];
  const groups = [...cases].flatMap(([id, expected]) => Array.from({ length: plan.repetitions }, (_, repetition) => {
    const values = plan.models.map((model) => {
      const cell = JSON.stringify([id, repetition, model]);
      const row = rows.get(cell);
      if (!row) missing.push(cell);
      return row;
    });
    const complete = values.every((row) => row !== undefined);
    const completed = complete && values.every((row) => row!.sample.status === "completed");
    return {
      case: id, repetition, complete,
      queryAgreement: complete ? values.every((row) => row!.query !== null && row!.query === values[0]!.query) : null,
      resultAgreement: complete ? completed && values.every((row) => row!.messages === values[0]!.messages) : null,
      queryMatches: values.map((row, index) => ({ model: plan.models[index]!, matches: row ? row.query === expected.query : null })),
      resultMatches: values.map((row, index) => ({ model: plan.models[index]!, matches: row ? row.sample.status === "completed" && row.messages === expected.messages : null })),
    };
  }));
  const complete = missing.length === 0;
  const plannedSamples = cases.size * plan.repetitions * plan.models.length;
  const errors = [...rows.values()].filter((row) => row.sample.status === "failed").length;
  const queryMatches = groups.reduce((count, group) => count + group.queryMatches.filter((item) => item.matches).length, 0);
  const resultMatches = groups.reduce((count, group) => count + group.resultMatches.filter((item) => item.matches).length, 0);
  const queryAgreementRate = complete ? groups.filter((group) => group.queryAgreement).length / groups.length : null;
  const resultAgreementRate = complete ? groups.filter((group) => group.resultAgreement).length / groups.length : null;
  return {
    schemaVersion: 1, scorerVersion: "consistency-pilot-1", configuration: structuredClone(plan),
    evidence: plan.mode === "fixture" ? "harness-check-only" : "model-observations",
    complete, plannedSamples, recordedSamples: rows.size, missing, errors,
    queryAgreementRate, resultAgreementRate,
    expectedQueryMatchRate: complete ? queryMatches / plannedSamples : null,
    expectedResultMatchRate: complete ? resultMatches / plannedSamples : null,
    passed: complete && errors === 0 && queryAgreementRate === 1 && resultAgreementRate === 1 && queryMatches === plannedSamples && resultMatches === plannedSamples,
    groups,
  };
}
