export type MemoryId = string;
export type MemoryContext = Readonly<Record<string, unknown>>;
export type MemoryInput = Readonly<Record<string, unknown>>;

export interface TextEmission {
  readonly type: "text";
  readonly content: string;
  readonly source?: MemoryId;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryCallEmission {
  readonly type: "memory";
  readonly ref: MemoryId;
  readonly input?: MemoryInput;
}

export type MemoryEmission = TextEmission | MemoryCallEmission;

export interface MemoryFunctionInput {
  readonly context: MemoryContext;
  readonly input: MemoryInput;
  readonly workingMemory: readonly TextEmission[];
  readonly execution: {
    /** Activation hops from a recall entrypoint for this invocation. */
    readonly depth: number;
    readonly count: number;
  };
}

export interface MemoryFunction {
  readonly id: MemoryId;
  readonly description?: string;
  execute(
    input: MemoryFunctionInput,
  ): readonly MemoryEmission[] | Promise<readonly MemoryEmission[]>;
}

export interface MemoryInvocation {
  readonly ref: MemoryId;
  readonly input?: MemoryInput;
}

export interface RuntimeLimits {
  readonly maxExecutions?: number;
  /** Maximum activation hops from an entrypoint, not a memory hierarchy. */
  readonly maxDepth?: number;
  readonly maxVisitsPerMemory?: number;
}

export interface RecallRequest {
  readonly entrypoints: readonly (MemoryId | MemoryInvocation)[];
  /** Public context. Names beginning with '__' belong to the runtime. */
  readonly context?: MemoryContext;
  /** A caller may lower, but cannot raise, the runtime's configured ceilings. */
  readonly limits?: RuntimeLimits;
}

export interface ExecutionTraceEntry {
  readonly memory: MemoryId;
  /** Activation hops for this invocation; the same node may have other values. */
  readonly depth: number;
  readonly emissions: number;
}

export interface RecallResult {
  readonly messages: readonly TextEmission[];
  readonly trace: readonly ExecutionTraceEntry[];
  readonly executed: number;
}
