import {
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

export class MemoryRuntime {
  constructor(private readonly store: MemoryStore) {}

  async recall(request: RecallRequest): Promise<RecallResult> {
    const limits = { ...DEFAULT_LIMITS, ...request.limits };
    const context = request.context ?? {};
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

      executed += 1;
      const input: MemoryInput = item.invocation.input ?? {};
      const emissions = await memory.execute({
        context,
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
