import { scoreTrial } from "./benchmark.js";
import type { Configuration, Condition, Score, Suite, Trial } from "./types.js";

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function measuredMean(values: readonly (number | null)[]): number | null {
  return values.length && values.every((value) => value !== null) ? mean(values as number[]) : null;
}

function configurationKey(config: Configuration): string {
  return JSON.stringify([
    config.mode, [...config.conditions].sort(), config.repetitions,
    config.agent.provider, config.agent.model, config.agent.revision, config.agent.temperature,
    config.limits.maxActions, config.limits.maxMemoryCharacters, config.limits.maxMemoryTokens, config.limits.timeoutMs,
  ]);
}

// Resample tasks, keeping repeated trials together. Repetitions are not independent tasks.
function pairedInterval(taskDifferences: readonly number[]) {
  if (taskDifferences.length < 2) return null;
  let seed = 1729;
  const samples = Array.from({ length: 2000 }, () => {
    const values = taskDifferences.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return taskDifferences[Math.floor(seed / 4294967296 * taskDifferences.length)]!;
    });
    return mean(values);
  }).sort((a, b) => a - b);
  return [samples[Math.floor(samples.length * 0.025)]!, samples[Math.ceil(samples.length * 0.975) - 1]!] as const;
}

export function createReport(suite: Suite, suiteHash: string, trials: readonly Trial[]) {
  if (trials.length === 0) throw new Error("No trials to score");
  const configuration = trials[0]!.configuration;
  const key = configurationKey(configuration);
  const rows = new Map<string, { trial: Trial; score: Score }>();
  const ids = new Set<string>();
  let dslRevision: string | undefined;
  for (const trial of trials) {
    if (trial.suiteHash !== suiteHash) throw new Error("Dataset hash mismatch");
    if (configurationKey(trial.configuration) !== key) throw new Error("Cannot compare different experiment configurations");
    if (ids.has(trial.id)) throw new Error(`Duplicate trial ID '${trial.id}'`);
    ids.add(trial.id);
    const task = suite.tasks.find((entry) => entry.id === trial.task);
    if (!task) throw new Error(`Unknown task '${trial.task}'`);
    const score = scoreTrial(task, trial);
    if (trial.memory.dsl) {
      const memory = trial.memory.dsl;
      const revision = JSON.stringify([memory.sourceHash, memory.compilerVersion, memory.runtimeVersion, memory.limits.maxExecutions, memory.limits.maxDepth, memory.limits.maxVisitsPerMemory]);
      if (dslRevision !== undefined && revision !== dslRevision) throw new Error("Cannot compare different DSL snapshots or runtime limits");
      dslRevision = revision;
    }
    const cell = JSON.stringify([trial.task, trial.repetition, trial.condition]);
    if (rows.has(cell)) throw new Error(`Duplicate task/repetition/condition: ${cell}`);
    rows.set(cell, { trial, score });
  }
  const missing: string[] = [];
  for (const task of suite.tasks) {
    for (let repetition = 0; repetition < configuration.repetitions; repetition += 1) {
      for (const condition of configuration.conditions) {
        const cell = JSON.stringify([task.id, repetition, condition]);
        if (!rows.has(cell)) missing.push(cell);
      }
    }
  }
  const groups = configuration.conditions.map((condition) => {
    const values = [...rows.values()].filter((row) => row.trial.condition === condition);
    const successes = values.filter((row) => row.score.success);
    return {
      condition, trials: values.length, successes: successes.length,
      successRate: values.length ? successes.length / values.length : null,
      meanRepeatedActionRate: values.length ? mean(values.map((row) => row.score.repeatedActionRate)) : null,
      repeatedIneffectiveActions: values.reduce((sum, row) => sum + row.score.repeatedIneffectiveActions, 0),
      invalidActions: values.reduce((sum, row) => sum + row.score.invalidActions, 0),
      errors: values.filter((row) => row.trial.termination === "error").length,
      meanActions: values.length ? mean(values.map((row) => row.score.actions)) : null,
      meanInputTokens: measuredMean(values.map((row) => row.score.inputTokens)),
      meanOutputTokens: measuredMean(values.map((row) => row.score.outputTokens)),
      meanMemoryTokens: measuredMean(values.map((row) => row.trial.memory.tokens)),
      meanMemoryCharacters: values.length ? mean(values.map((row) => row.trial.memory.text.length)) : null,
      meanElapsedMs: values.length ? mean(values.map((row) => row.trial.elapsedMs)) : null,
    };
  });
  function compare(baseline: Condition, candidate: Condition) {
    const successDifferences: number[] = [];
    const repeatDifferences: number[] = [];
    const successfulPairs: { baseline: { trial: Trial; score: Score }; candidate: { trial: Trial; score: Score } }[] = [];
    for (const task of suite.tasks) {
      const success: number[] = [];
      const repetition: number[] = [];
      for (let index = 0; index < configuration.repetitions; index += 1) {
        const a = rows.get(JSON.stringify([task.id, index, baseline]))!;
        const b = rows.get(JSON.stringify([task.id, index, candidate]))!;
        success.push((Number(b.score.success) - Number(a.score.success)) * 100);
        repetition.push((b.score.repeatedActionRate - a.score.repeatedActionRate) * 100);
        if (a.score.success && b.score.success) successfulPairs.push({ baseline: a, candidate: b });
      }
      successDifferences.push(mean(success));
      repeatDifferences.push(mean(repetition));
    }
    const aActions = successfulPairs.map((pair) => pair.baseline.score.actions);
    const bActions = successfulPairs.map((pair) => pair.candidate.score.actions);
    return {
      baseline, candidate, pairedTasks: suite.tasks.length,
      successDifferencePp: mean(successDifferences), successDifferenceCi95Pp: pairedInterval(successDifferences),
      repeatedActionDifferencePp: mean(repeatDifferences), repeatedActionDifferenceCi95Pp: pairedInterval(repeatDifferences),
      successfulPairs: successfulPairs.length,
      successfulPairActionReduction: successfulPairs.length && mean(aActions) > 0 ? 1 - mean(bActions) / mean(aActions) : null,
      successfulPairInputTokens: {
        baseline: measuredMean(successfulPairs.map((pair) => pair.baseline.score.inputTokens)),
        candidate: measuredMean(successfulPairs.map((pair) => pair.candidate.score.inputTokens)),
      },
    };
  }
  const comparisons = missing.length ? [] : [
    ...(configuration.conditions.includes("none") && configuration.conditions.includes("text") ? [compare("none", "text")] : []),
    ...(configuration.conditions.includes("text") && configuration.conditions.includes("dsl") ? [compare("text", "dsl")] : []),
  ];
  return {
    schemaVersion: 1, scorerVersion: "pilot-1", suite: suite.version, split: suite.split, suiteHash, configuration,
    uncertainty: { method: "paired-task-bootstrap", samples: 2000, seed: 1729 },
    evidence: configuration.mode === "fixture" ? "harness-check-only" : "model-observations",
    complete: missing.length === 0, missing, groups, comparisons,
    categories: [...new Set(suite.tasks.map((task) => task.category))].map((category) => {
      const tasks = new Set(suite.tasks.filter((task) => task.category === category).map((task) => task.id));
      return {
        category,
        groups: configuration.conditions.map((condition) => {
          const values = [...rows.values()].filter((row) => tasks.has(row.trial.task) && row.trial.condition === condition);
          return { condition, trials: values.length, successRate: values.length ? mean(values.map((row) => Number(row.score.success))) : null };
        }),
      };
    }),
  };
}
