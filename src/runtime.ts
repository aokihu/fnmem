import {
  InvalidRecallRequestError,
  MemoryBudgetExceededError,
  MemoryNotFoundError,
} from "./errors.js";
import type { MemoryStore } from "./store.js";
import type {
  ExecutionTraceEntry,
  MemoryInput,
  MemoryInvocation,
  RecallRequest,
  RecallResult,
  RuntimeLimits,
  TextEmission,
} from "./types.js";

interface QueueItem {
  readonly invocation: MemoryInvocation;
  readonly depth: number;
}

const DEFAULT_LIMITS = {
  maxExecutions: 32,
  maxDepth: 8,
  maxVisitsPerMemory: 4,
} as const;

function checkLimits(limits: Required<RuntimeLimits>, ceiling?: Required<RuntimeLimits>): void {
  for (const name of ["maxExecutions", "maxDepth", "maxVisitsPerMemory"] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < (name === "maxDepth" ? 0 : 1)) {
      throw new InvalidRecallRequestError(`Invalid ${name}: expected a bounded safe integer.`);
    }
    if (ceiling && value > ceiling[name]) {
      throw new InvalidRecallRequestError(`${name} exceeds the runtime ceiling (${ceiling[name]}).`);
    }
  }
}

function checkReservedFields(fields: MemoryInput, label: string): void {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new InvalidRecallRequestError(`${label} must be an object.`);
  }
  if (Object.getOwnPropertyNames(fields).some((name) => name.startsWith("__"))) {
    throw new InvalidRecallRequestError(`${label} cannot supply reserved '__' fields.`);
  }
}

export class MemoryRuntime {
  readonly #limits: Required<RuntimeLimits>;

  constructor(private readonly store: MemoryStore, limits: RuntimeLimits = {}) {
    const ceilings = { ...DEFAULT_LIMITS, ...limits };
    checkLimits(ceilings);
    this.#limits = Object.freeze(ceilings);
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const limits = { ...this.#limits, ...request.limits };
    checkLimits(limits, this.#limits);
    const publicContext = request.context === undefined ? {} : request.context;
    checkReservedFields(publicContext, "context");
    const context = Object.freeze({ ...publicContext });
    const budgetKey = `__${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    const messages: TextEmission[] = [];
    const trace: ExecutionTraceEntry[] = [];
    const visits = new Map<string, number>();

    const queue: QueueItem[] = request.entrypoints.map((entrypoint) => ({
      invocation:
        typeof entrypoint === "string"
          ? { ref: entrypoint }
          : entrypoint,
      depth: 0,
    }));
    for (const item of queue) {
      checkReservedFields(item.invocation.input === undefined ? {} : item.invocation.input, "entrypoint input");
    }

    let executed = 0;

    while (queue.length > 0) {
      if (executed >= limits.maxExecutions) {
        throw new MemoryBudgetExceededError(
          `Execution budget exceeded (${limits.maxExecutions}).`,
        );
      }

      const item = queue.shift();
      if (!item) break;

      if (item.depth > limits.maxDepth) {
        throw new MemoryBudgetExceededError(
          `Maximum memory depth exceeded (${limits.maxDepth}).`,
        );
      }

      const visitCount = (visits.get(item.invocation.ref) ?? 0) + 1;
      if (visitCount > limits.maxVisitsPerMemory) {
        throw new MemoryBudgetExceededError(
          `Memory '${item.invocation.ref}' exceeded visit limit (${limits.maxVisitsPerMemory}).`,
        );
      }
      visits.set(item.invocation.ref, visitCount);

      const memory = await this.store.get(item.invocation.ref);
      if (!memory) {
        throw new MemoryNotFoundError(item.invocation.ref);
      }

      const input: MemoryInput = item.invocation.input === undefined ? {} : item.invocation.input;
      checkReservedFields(input, "invocation input");
      executed += 1;
      // One private key per recall; immutable snapshots share a global budget.
      // Non-enumerability keeps it out of normal JSON/context projections.
      const invocationContext = Object.freeze(Object.defineProperty({ ...context }, budgetKey, {
        value: limits.maxExecutions - executed,
      }));
      const emissions = await memory.execute({
        context: invocationContext,
        input,
        workingMemory: messages,
        execution: {
          depth: item.depth,
          count: executed,
        },
      });

      trace.push({
        memory: memory.id,
        depth: item.depth,
        emissions: emissions.length,
      });

      for (const emission of emissions) {
        if (emission.type === "text") {
          messages.push({
            ...emission,
            source: emission.source ?? memory.id,
          });
          continue;
        }

        queue.push({
          invocation: {
            ref: emission.ref,
            ...(emission.input === undefined ? {} : { input: emission.input }),
          },
          depth: item.depth + 1,
        });
      }
    }

    return {
      messages,
      trace,
      executed,
    };
  }
}
