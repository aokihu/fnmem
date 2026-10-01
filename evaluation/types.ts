export type Condition = "none" | "text" | "dsl";
export type Category = "repeated-failure" | "transfer" | "irrelevant-memory" | "conflict";

export interface Transition {
  readonly observation: string;
  readonly next: string;
  readonly effective: boolean;
}

export interface Task {
  readonly id: string;
  readonly category: Category;
  readonly prompt: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly actions: readonly { readonly id: string; readonly description: string }[];
  readonly memories: readonly { readonly id: string; readonly text: string }[];
  readonly selectedMemories: readonly string[];
  readonly priorFailures: readonly string[];
  readonly environment: {
    readonly initial: string;
    readonly goals: readonly string[];
    readonly states: Readonly<Record<string, Readonly<Record<string, Transition>>>>;
  };
}

export interface Suite {
  readonly version: string;
  readonly split: "development" | "holdout";
  readonly tasks: readonly Task[];
}

export interface AgentInput {
  readonly task: Pick<Task, "id" | "prompt" | "context" | "actions">;
  readonly memory: string;
  readonly history: readonly { readonly action: string; readonly observation: string }[];
  readonly remainingActions: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Agent {
  countMemoryTokens?(text: string): number;
  act(input: AgentInput, signal: AbortSignal): Promise<{ action: string; usage?: Usage }>;
}

export interface Configuration {
  readonly mode: "fixture" | "model";
  readonly conditions: readonly Condition[];
  readonly repetitions: number;
  readonly agent: {
    readonly provider: string;
    readonly model: string;
    readonly revision: string;
    readonly temperature: number;
  };
  readonly limits: {
    readonly maxActions: number;
    readonly maxMemoryCharacters: number;
    readonly maxMemoryTokens: number;
    readonly timeoutMs: number;
  };
}

export interface Trial {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly suiteHash: string;
  readonly task: string;
  readonly repetition: number;
  readonly condition: Condition;
  readonly configuration: Configuration;
  readonly memory: {
    readonly ids: readonly string[];
    readonly text: string;
    readonly tokens: number | null;
    readonly dsl?: { readonly sourceHash: string; readonly compilerVersion: string };
  };
  readonly steps: readonly { readonly action: string; readonly observation: string; readonly usage?: Usage }[];
  readonly termination: "goal" | "budget" | "invalid-action" | "error";
  readonly elapsedMs: number;
  readonly error?: string;
}

export interface Score {
  readonly success: boolean;
  readonly actions: number;
  readonly repeatedIneffectiveActions: number;
  readonly repeatedActionRate: number;
  readonly invalidActions: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}
