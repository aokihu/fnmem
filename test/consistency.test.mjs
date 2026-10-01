import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsistencyReport } from "../dist/evaluation/consistency.js";

const plan = {
  version: "consistency-pilot-1", mode: "fixture", condition: "text", inputMode: "fixed",
  models: ["fixture-model-a", "fixture-model-b"], repetitions: 2,
  memory: {
    snapshotHash: createHash("sha256").update("fixed fixture memories").digest("hex"),
    compilerVersion: "not-applicable", runtimeVersion: "fixture-only",
  },
  cases: [
    {
      id: "recover",
      query: {
        context: { failures: 3, proxy: true }, entrypoints: [{ ref: "recover", input: {} }],
        limits: { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 },
      },
      expectedMessages: [
        { type: "text", content: "Repeated failures observed.", source: "recover" },
        { type: "text", content: "Inspect the proxy.", source: "proxy", metadata: { scope: "network", confidence: 1 } },
      ],
    },
    {
      id: "continue",
      query: {
        context: { failures: 0, proxy: false }, entrypoints: [{ ref: "recover", input: {} }],
        limits: { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 },
      },
      expectedMessages: [{ type: "text", content: "Continue.", source: "recover" }],
    },
  ],
};

function samples() {
  return plan.cases.flatMap((item) => Array.from({ length: plan.repetitions }, (_, repetition) => plan.models.map((model) => ({
    id: `${item.id}-${repetition}-${model}`, case: item.id, model, repetition,
    memory: structuredClone(plan.memory), query: structuredClone(item.query),
    status: "completed", messages: structuredClone(item.expectedMessages),
  })))).flat();
}

test("same recall payloads across model identities pass despite different object insertion order", () => {
  const records = samples();
  records[0].query.context = { proxy: true, failures: 3 };
  records[0].messages[1].metadata = { confidence: 1, scope: "network" };
  records[0].createdAt = "different-run-timestamp";
  const report = createConsistencyReport(plan, records);
  assert.equal(report.passed, true);
  assert.equal(report.queryAgreementRate, 1);
  assert.equal(report.resultAgreementRate, 1);
  assert.equal(report.expectedResultMatchRate, 1);
  assert.equal(report.evidence, "harness-check-only");
});

test("one model returning different content or a different emission order fails exact agreement", () => {
  const changed = samples();
  changed[0].messages[1].content = "Keep retrying.";
  const report = createConsistencyReport(plan, changed);
  assert.equal(report.resultAgreementRate, 0.75);
  assert.equal(report.expectedResultMatchRate, 0.875);
  assert.equal(report.queryAgreementRate, 1);
  assert.equal(report.passed, false);
  const reordered = samples();
  reordered[0].messages.reverse();
  assert.equal(createConsistencyReport(plan, reordered).passed, false);
});

test("identical but incorrect or empty results do not satisfy correctness", () => {
  for (const messages of [[], [{ type: "text", content: "constant wrong answer" }]]) {
    const records = samples().map((sample) => ({ ...sample, messages }));
    const report = createConsistencyReport(plan, records);
    assert.equal(report.resultAgreementRate, 1);
    assert.equal(report.expectedResultMatchRate, 0);
    assert.equal(report.passed, false);
  }
});

test("query construction differences remain visible even when returned messages agree", () => {
  const records = samples();
  records[0].query.context.failures = 0;
  const report = createConsistencyReport({ ...plan, inputMode: "model-generated" }, records);
  assert.equal(report.queryAgreementRate, 0.75);
  assert.equal(report.expectedQueryMatchRate, 0.875);
  assert.equal(report.resultAgreementRate, 1);
  assert.equal(report.passed, false);
  const allWrong = samples();
  for (const sample of allWrong) sample.query.context.failures = 999;
  const wrongReport = createConsistencyReport(plan, allWrong);
  assert.equal(wrongReport.queryAgreementRate, 1);
  assert.equal(wrongReport.expectedQueryMatchRate, 0);
  assert.equal(wrongReport.passed, false);
});

test("missing, failed, duplicate, or unplanned model samples cannot give a passing report", () => {
  const incomplete = createConsistencyReport(plan, samples().slice(1));
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.missing.length, 1);
  assert.equal(incomplete.resultAgreementRate, null);
  assert.equal(incomplete.passed, false);
  const failed = samples();
  failed[0] = { ...failed[0], status: "failed", query: null, error: "invalid query from model" };
  const report = createConsistencyReport(plan, failed);
  assert.equal(report.errors, 1);
  assert.equal(report.resultAgreementRate, 0.75);
  assert.equal(report.expectedResultMatchRate, 0.875);
  assert.equal(report.passed, false);
  const duplicate = samples();
  assert.throws(() => createConsistencyReport(plan, [...duplicate, { ...duplicate[0], id: "other-run" }]), /Duplicate case/);
  const unexpected = samples();
  unexpected[0].model = "unregistered-model";
  assert.throws(() => createConsistencyReport(plan, unexpected), /Unplanned recall/);
  assert.throws(() => createConsistencyReport({ ...plan, models: ["one-model"] }, []), /two distinct model/);
});

test("memory and execution revisions must match; invalid JSON is rejected", () => {
  const records = samples();
  records[0].memory.snapshotHash = "different-memory";
  assert.throws(() => createConsistencyReport(plan, records), /different memory snapshots/);
  const changedCompiler = samples();
  changedCompiler[0].memory.compilerVersion = "another-compiler";
  assert.throws(() => createConsistencyReport(plan, changedCompiler), /compiler\/runtime revisions/);
  const malformed = samples();
  malformed[0].query.context.failures = NaN;
  assert.throws(() => createConsistencyReport(plan, malformed), /finite JSON/);
  const implicit = samples();
  delete implicit[0].query.limits.maxDepth;
  assert.throws(() => createConsistencyReport(plan, implicit), /explicit execution limits/);
});

test("random internal context keys cannot enter the cross-model query contract", () => {
  const forged = samples();
  forged[0].query.context.__budget = 999;
  assert.throws(() => createConsistencyReport(plan, forged), /reserved/);
  const argument = samples();
  argument[0].query.entrypoints[0].input.__budget = 999;
  assert.throws(() => createConsistencyReport(plan, argument), /reserved/);
});

test("consistency CLI saves inspectable reports and exits unsuccessfully on mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fnmem-consistency-"));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const planFile = join(directory, "plan.json");
  const recordsFile = join(directory, "samples.jsonl");
  try {
    await writeFile(planFile, JSON.stringify(plan));
    await writeFile(recordsFile, samples().map((sample) => JSON.stringify(sample)).join("\n"));
    const args = ["scripts/evaluate.mjs", "consistency", "--plan", planFile, "--records", recordsFile];
    const good = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).passed, true);
    assert.equal(JSON.parse(good.stdout).planHash.length, 64);
    const changed = samples();
    changed[0].messages = [];
    await writeFile(recordsFile, changed.map((sample) => JSON.stringify(sample)).join("\n"));
    const output = join(directory, "failed-report");
    const bad = spawnSync(process.execPath, [...args, "--out", output], { cwd, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Consistency check failed/);
    const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    assert.equal(report.passed, false);
    assert.equal(report.expectedResultMatchRate, 0.875);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
