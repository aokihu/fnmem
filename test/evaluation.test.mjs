import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSuite } from "../dist/evaluation/tasks.js";
import { getTextMemory, runTrial, scoreTrial } from "../dist/evaluation/benchmark.js";
import { createReport } from "../dist/evaluation/report.js";
import { compileMemorySource, loadMemoryArtifact } from "../dist/src/index.js";

const source = await readFile(new URL("../evaluation/data/development.json", import.meta.url), "utf8");
const suiteHash = createHash("sha256").update(source).digest("hex");
const suite = parseSuite(JSON.parse(source));
const trajectories = JSON.parse(await readFile(new URL("../evaluation/data/development-trajectories.json", import.meta.url), "utf8"));
const config = {
  mode: "fixture", conditions: ["none", "text"], repetitions: 2,
  agent: { provider: "local", model: "fixture", revision: "1", temperature: 0 },
  limits: { maxActions: 4, maxMemoryCharacters: 4000, maxMemoryTokens: 1024, timeoutMs: 100 },
};

async function trial(task, schedule, options = {}) {
  let index = 0;
  return runTrial({
    task, suiteHash, id: `${task.id}-${options.repetition ?? 0}-${options.condition ?? "text"}`,
    repetition: 0, condition: "text", configuration: config,
    agent: { async act() { return { action: schedule[index++] }; } }, ...options,
  });
}

test("dataset snapshots validate and match their frozen hashes", async () => {
  const manifest = JSON.parse(await readFile(new URL("../evaluation/data/manifest.json", import.meta.url), "utf8"));
  for (const split of ["development", "holdout"]) {
    const source = await readFile(new URL(`../evaluation/data/${split}.json`, import.meta.url), "utf8");
    const suite = parseSuite(JSON.parse(source));
    assert.equal(suite.split, split);
    assert.equal(createHash("sha256").update(source).digest("hex"), manifest.files[`${split}.json`]);
    assert.equal(suite.tasks.length, 8);
  }
  const broken = structuredClone(suite);
  broken.tasks[0].environment.states.s0[broken.tasks[0].actions[0].id].next = "missing";
  assert.throws(() => parseSuite(broken), /missing next state/);
});

test("every development task has independently specified success and failure trajectories", async () => {
  for (const task of suite.tasks) {
    const good = scoreTrial(task, await trial(task, trajectories[task.id].success));
    const bad = scoreTrial(task, await trial(task, trajectories[task.id].failure));
    assert.equal(good.success, true, task.id);
    assert.equal(bad.success, false, task.id);
    assert.equal(bad.actions, 4);
    assert.equal(bad.repeatedIneffectiveActions, task.priorFailures.includes(trajectories[task.id].failure[0]) ? 4 : 3);
    assert.equal(good.inputTokens, null);
  }
});

test("agent sees the same public state and text baseline, without environment or scoring rules", async () => {
  const task = suite.tasks[0];
  let calls = 0;
  const record = await trial(task, [], { agent: { async act(input) {
    assert.deepEqual(Object.keys(input.task).sort(), ["actions", "context", "id", "prompt"]);
    assert.equal(input.memory, getTextMemory(task));
    assert.equal(input.history[0].action, task.priorFailures[0]);
    input.task.context.failureCount = 999;
    return { action: trajectories[task.id].success[calls++] };
  } } });
  assert.equal(scoreTrial(task, record).success, true);
  assert.equal(task.context.failureCount, 3);
  await assert.rejects(() => trial(task, [], { condition: "dsl", configuration: { ...config, conditions: ["text", "dsl"] } }), /requires a verified compiled bundle/);
});

test("DSL trials use verified compilation and retain failed recall without exposing partial memory", async () => {
  const dsl = await loadMemoryArtifact(await compileMemorySource(await readFile(new URL("../dsl/examples/development.fnm", import.meta.url), "utf8")));
  const task = suite.tasks[0];
  const configuration = { ...config, conditions: ["text", "dsl"] };
  let calls = 0;
  const record = await trial(task, [], { condition: "dsl", dsl, configuration, agent: { async act(input) {
    assert.match(input.memory, /Inspect proxy timeout/);
    assert.deepEqual(input.task.context, task.context);
    return { action: trajectories[task.id].success[calls++] };
  } } });
  assert.equal(scoreTrial(task, record).success, true);
  assert.equal(record.memory.dsl.sourceHash, dsl.artifact.sourceHash);
  assert.equal(record.memory.dsl.recall.status, "completed");
  assert.throws(() => scoreTrial(task, { ...record, memory: { ...record.memory, text: "forged" } }), /content was modified/);
  const failureTask = { ...task, context: {} };
  const failed = await trial(failureTask, [], { condition: "dsl", dsl, configuration, agent: { async act() { assert.fail("An invalid recall must not call the agent"); } } });
  assert.equal(failed.termination, "error");
  assert.equal(failed.memory.dsl.recall.status, "failed");
  assert.equal(scoreTrial(failureTask, failed).success, false);
  assert.equal(failed.memory.text, "");
  assert.equal(failed.steps.length, 0);
});

test("prior and newly observed failures count as repeats only in the same state", async () => {
  const task = suite.tasks[0];
  const record = await trial(task, ["tune-reconnect", "check-proxy", "check-proxy", "fix-proxy"]);
  const score = scoreTrial(task, record);
  assert.equal(score.success, true);
  assert.equal(score.repeatedIneffectiveActions, 1); // First check in the new state has no prior failure there.
  assert.equal(score.repeatedActionRate, 0.25);
});

test("scorer rejects forged success, observations, baseline content, and over-budget records", async () => {
  const task = suite.tasks[0];
  const bad = await trial(task, trajectories[task.id].failure);
  assert.throws(() => scoreTrial(task, { ...bad, termination: "goal" }), /completion status/);
  const tampered = structuredClone(bad);
  tampered.steps[0].observation = "Task complete";
  assert.throws(() => scoreTrial(task, tampered), /Observation mismatch/);
  assert.throws(() => scoreTrial(task, { ...bad, memory: { ...bad.memory, text: "extra knowledge" } }), /baseline was modified/);
  assert.throws(() => scoreTrial(task, { ...bad, steps: [...bad.steps, bad.steps[0]] }), /budget exceeded/);
});

test("unknown actions, agent errors and timeouts remain failed trials", async () => {
  const task = suite.tasks[0];
  const invalid = await trial(task, ["invented-action"]);
  assert.equal(scoreTrial(task, invalid).invalidActions, 1);
  const failure = await trial(task, [], { agent: { async act() { throw new Error("provider unavailable"); } } });
  assert.equal(failure.termination, "error");
  assert.equal(scoreTrial(task, failure).success, false);
  let signal;
  const timeout = await trial(task, [], {
    configuration: { ...config, limits: { ...config.limits, timeoutMs: 5 } },
    agent: { act(_, value) { signal = value; return new Promise(() => {}); } },
  });
  assert.equal(timeout.termination, "error");
  assert.equal(signal.aborted, true);
  assert.equal(scoreTrial(task, timeout).inputTokens, null);
  const lateResponse = await trial(task, [], {
    configuration: { ...config, limits: { ...config.limits, timeoutMs: 5 } },
    agent: { act(_, signal) { return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ action: "check-proxy" }))); } },
  });
  assert.equal(lateResponse.termination, "error");
  assert.equal(lateResponse.steps.length, 0);
});

test("reports compare complete matched experiments and mark fixtures as checks", async () => {
  const records = [];
  for (const task of suite.tasks) {
    for (let repetition = 0; repetition < 2; repetition++) {
      for (const condition of config.conditions) {
        records.push(await trial(task, trajectories[task.id][repetition === 0 ? "success" : "failure"], { repetition, condition }));
      }
    }
  }
  const report = createReport(suite, suiteHash, records);
  assert.equal(report.complete, true);
  assert.equal(report.evidence, "harness-check-only");
  assert.equal(report.groups[0].successRate, 0.5);
  assert.equal(report.groups[1].meanInputTokens, null);
  assert.equal(report.comparisons[0].successDifferencePp, 0);
  assert.deepEqual(report.comparisons[0].successDifferenceCi95Pp, [0, 0]);
  assert.equal(report.comparisons[0].successfulPairActionReduction, 0);
  const partial = createReport(suite, suiteHash, records.slice(1));
  assert.equal(partial.complete, false);
  assert.equal(partial.missing.length, 1);
  assert.deepEqual(partial.comparisons, []);
  assert.throws(() => createReport(suite, suiteHash, [...records, { ...records[0], id: "duplicate-cell" }]), /Duplicate task/);
  assert.throws(() => createReport(suite, "different-dataset", records), /hash mismatch/);
  const changed = structuredClone(records);
  changed[0].configuration.agent.revision = "different-model";
  assert.throws(() => createReport(suite, suiteHash, changed), /different experiment configurations/);
});

test("paired confidence intervals vary when task outcomes disagree", async () => {
  const records = [];
  for (const [index, task] of suite.tasks.entries()) {
    for (let repetition = 0; repetition < 2; repetition++) {
      records.push(await trial(task, trajectories[task.id].failure, { condition: "none", repetition }));
      records.push(await trial(task, trajectories[task.id][index < 4 ? "success" : "failure"], { condition: "text", repetition }));
    }
  }
  const comparison = createReport(suite, suiteHash, records).comparisons[0];
  assert.equal(comparison.successDifferencePp, 50);
  assert.ok(comparison.successDifferenceCi95Pp[0] < 50);
  assert.ok(comparison.successDifferenceCi95Pp[1] > 50);
  assert.equal(comparison.successfulPairs, 0);
  assert.equal(comparison.successfulPairActionReduction, null);
});

test("memory budgets, required limits and measured token usage are enforced", async () => {
  const task = suite.tasks[0];
  await assert.rejects(() => trial(task, [], {
    configuration: { ...config, limits: { ...config.limits, maxActions: undefined } },
  }), /Invalid limit/);
  await assert.rejects(() => trial(task, [], {
    configuration: { ...config, limits: { ...config.limits, maxMemoryCharacters: 2 } },
  }), /character budget/);
  const modelConfig = { ...config, mode: "model" };
  await assert.rejects(() => trial(task, [], { configuration: modelConfig }), /require.*tokenizer/);
  await assert.rejects(() => trial(task, [], {
    configuration: modelConfig,
    agent: { countMemoryTokens() { return 1025; }, async act() { throw new Error("must not call"); } },
  }), /over-budget/);
  let index = 0;
  const record = await trial(task, [], {
    configuration: modelConfig,
    agent: {
      countMemoryTokens() { return 100; },
      async act() { return { action: trajectories[task.id].success[index++], usage: { inputTokens: 200, outputTokens: 10 } }; },
    },
  });
  assert.equal(record.memory.tokens, 100);
  const score = scoreTrial(task, record);
  assert.equal(score.inputTokens, 400);
  assert.equal(score.outputTokens, 20);
  const missingUsage = structuredClone(record);
  delete missingUsage.steps[0].usage;
  assert.equal(scoreTrial(task, missingUsage).inputTokens, null);
  const negativeUsage = structuredClone(record);
  negativeUsage.steps[0].usage.inputTokens = -1;
  assert.throws(() => scoreTrial(task, negativeUsage), /nonnegative integers/);
});

test("CLI smoke, rescore, incomplete reports and overwrite protection work end to end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fnmem-evaluation-"));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const cli = ["scripts/evaluate.mjs"];
  const output = join(directory, "smoke");
  try {
    execFileSync(process.execPath, [...cli, "smoke", "--out", output], { cwd });
    const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    const records = await readFile(join(output, "trials.jsonl"), "utf8");
    const rescored = JSON.parse(execFileSync(process.execPath, [...cli, "score", "--records", join(output, "trials.jsonl")], { cwd, encoding: "utf8" }));
    assert.deepEqual(rescored, report);
    assert.equal(report.evidence, "harness-check-only");
    assert.equal(spawnSync(process.execPath, [...cli, "smoke", "--out", output], { cwd }).status, 1);
    assert.equal(await readFile(join(output, "trials.jsonl"), "utf8"), records);
    const partial = join(directory, "partial.jsonl");
    await writeFile(partial, records.trim().split("\n").slice(1).join("\n") + "\n");
    const result = spawnSync(process.execPath, [...cli, "score", "--records", partial], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).complete, false);
    assert.deepEqual(JSON.parse(result.stdout).comparisons, []);
    assert.match(result.stderr, /planned trials missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
