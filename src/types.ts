export type MemoryId = string;
export type MemoryContext = Readonly<Record<string, unknown>>;
export type MemoryInput = Readonly<Record<string, unknown>>;

export interface MemoryField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly defaultValue?: string | number | boolean;
}

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
  readonly contextSchema?: readonly MemoryField[];
  readonly inputSchema?: readonly MemoryField[];
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

export interface InvocationRecord {
  /** Unique within this recall, even for repeated visits to the same memory. */
  readonly id: string;
  readonly ref: MemoryId;
  readonly depth: number;
  readonly input: MemoryInput;
  readonly status: "queued" | "completed" | "failed";
  readonly resolvedInput?: MemoryInput;
  readonly resolvedContext?: MemoryContext;
  readonly emissions?: readonly MemoryEmission[];
}

export interface ActivationEdge {
  readonly from: string;
  readonly to: string;
  /** Position in the emitting invocation's validated output array. */
  readonly emissionIndex: number;
}

export interface ExecutionObservation {
  readonly invocations: readonly InvocationRecord[];
  readonly activations: readonly ActivationEdge[];
}

export interface ObservedRecallResult {
  readonly result: RecallResult;
  readonly observation: ExecutionObservation;
}
