import type { Agent, Condition, Configuration, Score, Task, Trial, Usage } from "./types.js";
import { CompiledMemoryBundle, MemoryRuntime } from "../src/index.js";
import type { RecallResult } from "../src/types.js";

const RECALL_LIMITS = { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 } as const;

export function formatRecallMemory(result: RecallResult): string {
  return result.messages.map((message) => `[${message.source}]\n${message.content}`).join("\n\n");
}

export function getTextMemory(task: Task): string {
  return task.selectedMemories.map((id) => {
    const memory = task.memories.find((entry) => entry.id === id);
    if (!memory) throw new Error(`Unknown selected memory '${id}'`);
    return `[${id}]\n${memory.text}`;
  }).join("\n\n");
}

function checkUsage(usage: Usage | undefined): void {
  if (usage && (![usage.inputTokens, usage.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0))) {
    throw new Error("Token usage must contain nonnegative integers");
  }
}

export function checkConfiguration(config: Configuration): void {
  if (config.mode !== "fixture" && config.mode !== "model") throw new Error("Invalid evaluation mode");
  if (!Array.isArray(config.conditions) || config.conditions.length < 2 || new Set(config.conditions).size !== config.conditions.length || config.conditions.some((c) => !["none", "text", "dsl"].includes(c))) throw new Error("Expected distinct comparison conditions");
  if (!Number.isSafeInteger(config.repetitions) || config.repetitions < 1) throw new Error("Invalid repetition count");
  if (![config.agent.provider, config.agent.model, config.agent.revision].every((s) => typeof s === "string" && s.length > 0)) {
    throw new Error("Agent identity and revision are required");
  }
  if (!Number.isFinite(config.agent.temperature) || config.agent.temperature < 0) throw new Error("Invalid temperature");
  for (const key of ["maxActions", "maxMemoryCharacters", "maxMemoryTokens", "timeoutMs"] as const) {
    const limit = config.limits[key];
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid limit '${key}'`);
  }
}

function transition(task: Task, state: string, action: string) {
  const rules = task.environment.states[state];
  return rules && Object.hasOwn(rules, action) ? rules[action] : undefined;
}

export async function runTrial(options: {
  task: Task;
  suiteHash: string;
  id: string;
  repetition: number;
  condition: Condition;
  configuration: Configuration;
  agent: Agent;
  dsl?: CompiledMemoryBundle;
}): Promise<Trial> {
  const { task, suiteHash, id, repetition, condition, configuration, agent, dsl } = options;
  checkConfiguration(configuration);
  if (!Number.isSafeInteger(repetition) || repetition < 0 || repetition >= configuration.repetitions) throw new Error("Invalid repetition");
  if (!configuration.conditions.includes(condition)) throw new Error("Unplanned condition");
  if (condition === "dsl" && !(dsl instanceof CompiledMemoryBundle)) throw new Error("DSL evaluation requires a verified compiled bundle");
  if (!["none", "text", "dsl"].includes(condition)) throw new Error("Unknown condition");
  if (condition !== "none" && configuration.mode === "model" && !agent.countMemoryTokens) throw new Error("Model experiments require the model's memory tokenizer");
  const start = Date.now();
  let memory = condition === "text" ? getTextMemory(task) : "";
  let dslRecord: Trial["memory"]["dsl"];
  let recallError: string | undefined;
  if (condition === "dsl" && dsl) {
    let recall: NonNullable<Trial["memory"]["dsl"]>["recall"];
    try {
      const result = await new MemoryRuntime(dsl).recall({ context: task.context, entrypoints: task.selectedMemories, limits: RECALL_LIMITS });
      memory = formatRecallMemory(result);
      recall = { status: "completed", result };
    } catch (cause) {
      const failure = cause as { code?: string; partial?: RecallResult; message?: string };
      recallError = `${failure.code ?? "E_EXECUTION"}: ${failure.message ?? String(cause)}`;
      recall = { status: "failed", result: failure.partial ?? { messages: [], trace: [], executed: 0 }, error: recallError };
    }
    dslRecord = { sourceHash: dsl.artifact.sourceHash, compilerVersion: dsl.artifact.compilerVersion, runtimeVersion: dsl.artifact.runtimeVersion, limits: RECALL_LIMITS, recall };
  }
  if (memory.length > configuration.limits.maxMemoryCharacters) throw new Error("Memory exceeds character budget; do not silently truncate");
  const memoryTokens = condition === "none" ? 0 : agent.countMemoryTokens?.(memory) ?? null;
  if (configuration.mode === "model" && memoryTokens === null) throw new Error("Model experiments require the model's memory tokenizer");
  if (memoryTokens !== null && (!Number.isSafeInteger(memoryTokens) || memoryTokens < 0 || memoryTokens > configuration.limits.maxMemoryTokens)) throw new Error("Invalid or over-budget memory token count");
  const steps: Trial["steps"][number][] = [];
  const history = task.priorFailures.map((action) => ({
    action, observation: transition(task, task.environment.initial, action)!.observation,
  }));
  let state = task.environment.initial;
  let termination: Trial["termination"] = recallError ? "error" : "budget";
  let error: string | undefined = recallError;
  for (let index = 0; !recallError && index < configuration.limits.maxActions; index += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        agent.act(structuredClone({
          task: { id: task.id, prompt: task.prompt, context: task.context, actions: task.actions },
          memory, history, remainingActions: configuration.limits.maxActions - index,
        }), controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new Error("Agent action timed out")); controller.abort(); }, configuration.limits.timeoutMs);
        }),
      ]);
      checkUsage(response.usage);
      if (typeof response.action !== "string" || response.action.length === 0) throw new Error("Agent must return a nonempty action ID");
      const rule = transition(task, state, response.action);
      const observation = rule?.observation ?? `Unknown action: ${response.action}`;
      steps.push({ action: response.action, observation, ...(response.usage ? { usage: { ...response.usage } } : {}) });
      history.push({ action: response.action, observation });
      if (!rule) { termination = "invalid-action"; break; }
      state = rule.next;
      if (task.environment.goals.includes(state)) { termination = "goal"; break; }
    } catch (cause) {
      termination = "error";
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return {
    schemaVersion: 1, id, suiteHash, task: task.id, repetition, condition,
    configuration: structuredClone(configuration),
    memory: { ids: condition === "none" ? [] : [...task.selectedMemories], text: memory, tokens: memoryTokens, ...(dslRecord ? { dsl: dslRecord } : {}) },
    steps, termination, elapsedMs: Date.now() - start, ...(error ? { error } : {}),
  };
}

// Reconstruct the environment from actions. Never trust a recorded success flag.
export function scoreTrial(task: Task, trial: Trial): Score {
  checkConfiguration(trial.configuration);
  if (trial.schemaVersion !== 1 || trial.task !== task.id || !trial.id || !trial.suiteHash) throw new Error("Trial identity mismatch");
  if (!Number.isSafeInteger(trial.repetition) || trial.repetition < 0 || trial.repetition >= trial.configuration.repetitions) throw new Error("Invalid repetition");
  if (!trial.configuration.conditions.includes(trial.condition)) throw new Error("Unplanned condition");
  if (!["none", "text", "dsl"].includes(trial.condition)) throw new Error("Unknown condition");
  if (!Array.isArray(trial.steps) || trial.steps.length > trial.configuration.limits.maxActions) throw new Error("Action budget exceeded");
  if (!Number.isFinite(trial.elapsedMs) || trial.elapsedMs < 0) throw new Error("Invalid duration");
  if (trial.memory.tokens !== null && (!Number.isSafeInteger(trial.memory.tokens) || trial.memory.tokens < 0 || trial.memory.tokens > trial.configuration.limits.maxMemoryTokens)) throw new Error("Invalid memory token count");
  if (trial.configuration.mode === "model" && trial.memory.tokens === null) throw new Error("Missing model memory token count");
  if (typeof trial.memory.text !== "string" || trial.memory.text.length > trial.configuration.limits.maxMemoryCharacters) throw new Error("Memory budget exceeded");
  const expectedIds = trial.condition === "none" ? [] : task.selectedMemories;
  if (JSON.stringify(trial.memory.ids) !== JSON.stringify(expectedIds)) throw new Error("Initial memory selection changed");
  if (trial.condition === "none" && trial.memory.text !== "") throw new Error("No-memory trial contains memory");
  if (trial.condition === "none" && trial.memory.tokens !== 0) throw new Error("No-memory token count must be zero");
  if (trial.condition === "text" && trial.memory.text !== getTextMemory(task)) throw new Error("Text baseline was modified");
  if (trial.condition === "dsl") {
    const record = trial.memory.dsl;
    if (!record?.sourceHash || !record.compilerVersion || !record.runtimeVersion || !record.recall) throw new Error("DSL source and compiler/runtime versions are required");
    if (record.recall.result.executed !== record.recall.result.trace.length) throw new Error("Invalid DSL execution trace");
    if (record.recall.status === "completed") {
      if (record.recall.error || trial.memory.text !== formatRecallMemory(record.recall.result)) throw new Error("DSL recall content was modified");
    } else if (record.recall.status !== "failed" || !record.recall.error || trial.termination !== "error" || trial.steps.length || trial.memory.text !== "") {
      throw new Error("Failed DSL recall cannot publish partial memory or agent actions");
    }
  }
  let state = task.environment.initial;
  const disproved = new Set(task.priorFailures.map((action) => JSON.stringify([state, action])));
  let repeated = 0;
  let invalid = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let completeUsage = trial.steps.length > 0;
  for (const [index, step] of trial.steps.entries()) {
    if (task.environment.goals.includes(state) || invalid) throw new Error("Actions recorded after termination");
    if (typeof step.action !== "string" || step.action.length === 0) throw new Error("Invalid action ID");
    const rule = transition(task, state, step.action);
    if (step.observation !== (rule?.observation ?? `Unknown action: ${step.action}`)) throw new Error(`Observation mismatch at step ${index}`);
    checkUsage(step.usage);
    if (step.usage) { inputTokens += step.usage.inputTokens; outputTokens += step.usage.outputTokens; }
    else completeUsage = false;
    if (!rule) { invalid += 1; continue; }
    const key = JSON.stringify([state, step.action]);
    if (!rule.effective) {
      if (disproved.has(key)) repeated += 1;
      disproved.add(key);
    }
    state = rule.next;
  }
  const success = task.environment.goals.includes(state);
  if (success ? trial.termination !== "goal" : trial.termination === "goal") throw new Error("Forged completion status");
  if (invalid ? trial.termination !== "invalid-action" : trial.termination === "invalid-action") throw new Error("Invalid-action status mismatch");
  if (trial.termination === "budget" && trial.steps.length !== trial.configuration.limits.maxActions) throw new Error("Premature budget termination");
  if (!["goal", "budget", "invalid-action", "error"].includes(trial.termination)) throw new Error("Unknown termination");
  if (trial.termination === "error" && !trial.error) throw new Error("Missing error details");
  return {
    success, actions: trial.steps.length, repeatedIneffectiveActions: repeated,
    repeatedActionRate: trial.steps.length ? repeated / trial.steps.length : 0, invalidActions: invalid,
    inputTokens: completeUsage && trial.termination !== "error" ? inputTokens : null,
    outputTokens: completeUsage && trial.termination !== "error" ? outputTokens : null,
  };
}
