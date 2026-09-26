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
  readonly maxDepth?: number;
  readonly maxVisitsPerMemory?: number;
}

export interface RecallRequest {
  readonly entrypoints: readonly (MemoryId | MemoryInvocation)[];
  readonly context?: MemoryContext;
  readonly limits?: RuntimeLimits;
}

export interface ExecutionTraceEntry {
  readonly memory: MemoryId;
  readonly depth: number;
  readonly emissions: number;
}

export interface RecallResult {
  readonly messages: readonly TextEmission[];
  readonly trace: readonly ExecutionTraceEntry[];
  readonly executed: number;
}
