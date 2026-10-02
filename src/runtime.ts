import { InvalidRecallRequestError, MemoryBudgetExceededError, MemoryNotFoundError, MemoryRuntimeError } from "./errors.js";
import { applySchema, checkFields, snapshotJson } from "./validation.js";
import type { MemoryStore } from "./store.js";
import type { ActivationEdge, ExecutionTraceEntry, InvocationRecord, MemoryFunction, MemoryInput, MemoryInvocation, ObservedRecallResult, RecallRequest, RecallResult, RuntimeLimits, TextEmission, MemoryEmission } from "./types.js";

interface QueueItem { readonly id: string; readonly invocation: MemoryInvocation; readonly depth: number; }
const DEFAULT_LIMITS = { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 } as const;

function checkLimits(limits: Required<RuntimeLimits>, ceiling?: Required<RuntimeLimits>): void {
  for (const name of ["maxExecutions", "maxDepth", "maxVisitsPerMemory"] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < (name === "maxDepth" ? 0 : 1)) throw new InvalidRecallRequestError(`Invalid ${name}: expected a bounded safe integer.`);
    if (ceiling && value > ceiling[name]) throw new InvalidRecallRequestError(`${name} exceeds the runtime ceiling (${ceiling[name]}).`);
  }
}

function checkKeys(object: MemoryInput, keys: readonly string[]): void {
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new InvalidRecallRequestError("Unknown recall request fields.");
}

export class MemoryRuntime {
  readonly #limits: Required<RuntimeLimits>;

  constructor(private readonly store: MemoryStore, limits: RuntimeLimits = {}) {
    const ceilings = { ...DEFAULT_LIMITS, ...limits };
    checkLimits(ceilings);
    this.#limits = Object.freeze(ceilings);
  }

  get limits(): Required<RuntimeLimits> { return this.#limits; }

  async recall(request: RecallRequest): Promise<RecallResult> {
    return (await this.recallObserved(request)).result;
  }

  async recallObserved(request: RecallRequest): Promise<ObservedRecallResult> {
    const messages: TextEmission[] = [], trace: ExecutionTraceEntry[] = [];
    const invocations: InvocationRecord[] = [], activations: ActivationEdge[] = [];
    const observation = () => snapshotJson({ invocations, activations }) as ObservedRecallResult["observation"];
    const enqueue = (invocation: MemoryInvocation, depth: number): QueueItem => {
      const id = `invocation-${invocations.length + 1}`;
      invocations.push({ id, ref: invocation.ref, depth, input: invocation.input ?? {}, status: "queued" });
      return { id, invocation, depth };
    };
    const update = (item: QueueItem, fields: Partial<InvocationRecord>) => {
      const index = invocations.findIndex((entry) => entry.id === item.id);
      invocations[index] = { ...invocations[index]!, ...fields };
    };
    let executed = 0;
    let active: QueueItem | undefined;
    const result = (): RecallResult => Object.freeze({ messages: Object.freeze([...messages]), trace: Object.freeze([...trace]), executed });
    try {
      checkFields(request, "request"); checkKeys(request as unknown as MemoryInput, ["entrypoints", "context", "limits"]);
      const query = snapshotJson(request) as RecallRequest;
      const publicLimits = query.limits === undefined ? {} : query.limits;
      checkFields(publicLimits, "limits"); checkKeys(publicLimits as MemoryInput, Object.keys(DEFAULT_LIMITS));
      const limits = { ...this.#limits, ...publicLimits }; checkLimits(limits, this.#limits);
      const context = query.context === undefined ? {} : query.context; checkFields(context, "context");
      if (!Array.isArray(query.entrypoints)) throw new InvalidRecallRequestError("Expected entrypoints.");
      const queue: QueueItem[] = query.entrypoints.map((entry) => {
        if (typeof entry !== "string") { checkFields(entry, "entrypoint"); checkKeys(entry as unknown as MemoryInput, ["ref", "input"]); }
        const invocation = typeof entry === "string" ? { ref: entry } : entry;
        if (!invocation || typeof invocation.ref !== "string" || !invocation.ref.length) throw new InvalidRecallRequestError("Expected memory reference.");
        checkFields(invocation.input === undefined ? {} : invocation.input, "entrypoint input");
        return enqueue({ ref: invocation.ref, ...(invocation.input !== undefined ? { input: invocation.input as MemoryInput } : {}) }, 0);
      });
      const store = this.store.snapshot ? await this.store.snapshot() : this.store;
      const definitions = new Map<string, MemoryFunction>();
      const getMemory = async (id: string): Promise<MemoryFunction> => {
        let memory = definitions.get(id);
        if (!memory) {
          const definition = await store.get(id);
          if (!definition) throw new MemoryNotFoundError(id);
          const loaded: MemoryFunction = Object.freeze({ ...definition }); definitions.set(id, loaded);
          return loaded;
        }
        return memory;
      };
      const inputs = (item: QueueItem, memory: MemoryFunction) => {
        const input = item.invocation.input === undefined ? {} : item.invocation.input;
        checkFields(input, "invocation input");
        return {
          context: applySchema(context, memory.contextSchema, `context[${memory.id}]`, false),
          input: applySchema(input, memory.inputSchema, `input[${memory.id}]`, true),
        };
      };
      // Preflight every selected entrypoint; a bad later entry cannot permit
      // an earlier entry to execute with incomplete evidence.
      for (const item of queue) { active = item; inputs(item, await getMemory(item.invocation.ref)); }
      active = undefined;
      const budgetKey = `__${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
      const visits = new Map<string, number>();
      while (queue.length) {
        active = queue[0];
        if (executed >= limits.maxExecutions) throw new MemoryBudgetExceededError(`Execution budget exceeded (${limits.maxExecutions}).`);
        const item = queue.shift()!; active = item;
        if (item.depth > limits.maxDepth) throw new MemoryBudgetExceededError(`Maximum memory depth exceeded (${limits.maxDepth}).`, "E_MAX_DEPTH");
        const visit = (visits.get(item.invocation.ref) ?? 0) + 1;
        if (visit > limits.maxVisitsPerMemory) throw new MemoryBudgetExceededError(`Memory '${item.invocation.ref}' exceeded visit limit (${limits.maxVisitsPerMemory}).`, "E_MAX_VISITS");
        const memory = await getMemory(item.invocation.ref);
        const view = inputs(item, memory);
        update(item, { resolvedInput: view.input, resolvedContext: view.context });
        const invocationContext = Object.freeze(Object.defineProperty({ ...view.context }, budgetKey, { value: limits.maxExecutions - executed - 1 }));
        const emissions = snapshotJson(await memory.execute(Object.freeze({
          context: invocationContext, input: view.input,
          workingMemory: Object.freeze([...messages]),
          execution: Object.freeze({ depth: item.depth, count: executed + 1 }),
        }))) as readonly MemoryEmission[];
        if (!Array.isArray(emissions)) throw new MemoryRuntimeError("Expected an emission array.", "E_EXECUTION");
        // Validate the whole local result before committing any output.
        for (const emission of emissions) {
          if (!emission || typeof emission !== "object") throw new MemoryRuntimeError("Invalid emission.", "E_EXECUTION");
          if (emission.type === "text") {
            if (typeof emission.content !== "string" || (emission.source !== undefined && (typeof emission.source !== "string" || !emission.source.length))) throw new MemoryRuntimeError("Invalid text emission.", "E_EXECUTION");
          } else if (emission.type === "memory") {
            if (typeof emission.ref !== "string" || !emission.ref.length) throw new MemoryRuntimeError("Invalid memory reference.", "E_EXECUTION");
            checkFields(emission.input === undefined ? {} : emission.input, "emitted input");
          } else throw new MemoryRuntimeError("Unknown emission type.", "E_EXECUTION");
        }
        visits.set(item.invocation.ref, visit); executed++;
        update(item, { status: "completed", emissions });
        trace.push(Object.freeze({ memory: memory.id, depth: item.depth, emissions: emissions.length }));
        for (const [emissionIndex, emission] of emissions.entries()) {
          if (emission.type === "text") messages.push(Object.freeze({ ...emission, source: emission.source ?? memory.id }));
          else {
            const next = enqueue({ ref: emission.ref, ...(emission.input !== undefined ? { input: emission.input } : {}) }, item.depth + 1);
            activations.push({ from: item.id, to: next.id, emissionIndex });
            queue.push(next);
          }
        }
      }
      return Object.freeze({ result: result(), observation: observation() });
    } catch (cause) {
      const error = cause instanceof MemoryRuntimeError ? cause : new MemoryRuntimeError(cause instanceof Error ? cause.message : String(cause), "E_EXECUTION");
      error.partial = result();
      if (active) {
        update(active, { status: "failed" });
        error.invocation = Object.freeze({ ref: active.invocation.ref, depth: active.depth });
      }
      error.observation = observation();
      throw error;
    }
  }
}
