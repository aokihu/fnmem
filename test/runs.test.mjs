import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  compileMemorySource, MemoryRunService, FileMemoryRunStore, MemoryRunError,
  LIKELIHOOD_VERSION, parseLikelihoodJudgment,
} from "../dist/src/index.js";

const graph = `language fnmem "0";
memory "entry" {
  input { label: string = "root"; }
  emit text input.label;
  emit memory "shared" with { label: "left" };
  emit memory "branch";
}
memory "branch" { emit text "branch"; emit memory "shared" with { label: "right" }; }
memory "shared" {
  context { topic: string = "original"; }
  input { label: string; }
  emit text input.label + ":" + context.topic;
}`;
const loop = `language fnmem "0";
memory "loop" { emit text "tick"; emit memory "loop"; }`;

async function setup(t, limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fnmem-runs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileMemoryRunStore(directory);
  return { directory, store, service: new MemoryRunService(store, limits) };
}

test("completed Runs preserve FIFO activations, repeated node calls, effective inputs and versioned evidence", async (t) => {
  const { service, directory } = await setup(t);
  const artifact = await compileMemorySource(graph);
  const judgment = parseLikelihoodJudgment({ likelihood: "very_likely" }, { version: LIKELIHOOD_VERSION });
  const request = { entrypoints: ["entry"], context: { topic: "facts" } };
  const evidence = [{ judgment, facts: { failures: 3 } }];
  const pending = service.recall(artifact, request, evidence);
  request.context.topic = "mutated";
  evidence[0].facts.failures = 0;
  const ref = await pending;
  const run = await service.read(ref.id);
  assert.equal(ref.resource, `fnmem://run/${ref.id}`);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result.messages.map((item) => item.content), ["root", "left:facts", "branch", "right:facts"]);
  assert.deepEqual(run.observation.invocations.map((item) => [item.id, item.ref, item.depth, item.status]), [
    ["invocation-1", "entry", 0, "completed"], ["invocation-2", "shared", 1, "completed"],
    ["invocation-3", "branch", 1, "completed"], ["invocation-4", "shared", 2, "completed"],
  ]);
  assert.deepEqual(run.observation.activations, [
    { from: "invocation-1", to: "invocation-2", emissionIndex: 1 },
    { from: "invocation-1", to: "invocation-3", emissionIndex: 2 },
    { from: "invocation-3", to: "invocation-4", emissionIndex: 1 },
  ]);
  assert.deepEqual(run.observation.invocations[0].resolvedInput, { label: "root" });
  assert.deepEqual(run.observation.invocations[1].resolvedContext, { topic: "facts" });
  assert.deepEqual(run.judgments, [{ judgment, facts: { failures: 3 } }]);
  assert.equal(run.artifact.sourceHash, artifact.sourceHash);
  assert.deepEqual(run.runtimeLimits, { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 });
  assert.equal(run.metrics.executions, 4);
  assert.equal(run.metrics.activations, 3);
  assert.equal(run.metrics.memoryCount, 3);
  assert.equal(run.metrics.maxDepth, 2);
  assert(run.metrics.durationMs >= 0);
  assert(Object.isFrozen(run.observation.invocations[0].resolvedInput));
  assert(!JSON.stringify(run).includes("__"));
  assert.deepEqual(await readdir(directory), [`${ref.id}.json`]);
});

test("records survive an independent Node process and read never executes the memory again", async (t) => {
  const { service, store, directory } = await setup(t);
  const ref = await service.recall(await compileMemorySource(graph), { entrypoints: ["entry"] });
  const filename = join(directory, `${ref.id}.json`);
  const before = await readFile(filename, "utf8");
  const moduleUrl = new URL("../dist/src/index.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { FileMemoryRunStore, MemoryRunService, MemoryRuntime } from ${JSON.stringify(moduleUrl)};
    MemoryRuntime.prototype.recallObserved = () => { throw new Error("Read must not execute"); };
    const service = new MemoryRunService(new FileMemoryRunStore(process.argv[1]));
    console.log(JSON.stringify(await service.read(process.argv[2])));
  `, directory, ref.id]);
  assert.deepEqual(JSON.parse(stdout), await store.get(ref.id));
  assert.equal(await readFile(filename, "utf8"), before);
});

test("replay uses saved source and ceilings after current source or service configuration changes", async (t) => {
  const { service, store } = await setup(t, { maxExecutions: 6 });
  const artifact = await compileMemorySource(graph);
  const ref = await service.recall(artifact, { entrypoints: ["entry"] });
  const newer = await compileMemorySource(graph.replace('"root"', '"changed"'));
  const next = await service.recall(newer, { entrypoints: ["entry"] });
  assert.equal((await service.read(next.id)).result.messages[0].content, "changed");
  const replay = await new MemoryRunService(store, { maxExecutions: 1 }).replay(ref.id);
  const run = await service.read(replay.id);
  assert.notEqual(replay.id, ref.id);
  assert.equal(replay.matches, true);
  assert.deepEqual(run.replay, { of: ref.id, matches: true });
  assert.equal(run.result.messages[0].content, "root");
  assert.equal(run.artifact.sourceHash, artifact.sourceHash);
  assert.equal(run.runtimeLimits.maxExecutions, 6);
  assert.deepEqual(run.observation, (await service.read(ref.id)).observation);
});

test("cycle failures keep committed outputs, the blocked invocation and reproducible failure details", async (t) => {
  const { service } = await setup(t, { maxExecutions: 2 });
  const ref = await service.recall(await compileMemorySource(loop), { entrypoints: ["loop"] });
  const run = await service.read(ref.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error.code, "E_MAX_EXECUTIONS");
  assert.deepEqual(run.error.invocation, { ref: "loop", depth: 2 });
  assert.deepEqual(run.result.messages.map((item) => item.content), ["tick", "tick"]);
  assert.equal(run.result.executed, 2);
  assert.deepEqual(run.observation.invocations.map((item) => item.status), ["completed", "completed", "failed"]);
  assert.equal(run.observation.invocations[2].emissions, undefined);
  assert.equal(run.observation.activations.length, 2);
  const replay = await service.replay(ref.id);
  assert.equal(replay.matches, true);
  assert.equal((await service.read(replay.id)).status, "failed");
});

test("preflight and invalid finite queries are persisted as failures without successful output", async (t) => {
  const { service } = await setup(t);
  const artifact = await compileMemorySource(graph);
  for (const [request, code] of [
    [{ entrypoints: ["entry", "missing"] }, "E_MEMORY_NOT_FOUND"],
    [{ entrypoints: ["entry", "shared"] }, "E_INPUT"],
    [{ entrypoints: ["entry"], limits: { maxExecutions: 33 } }, "E_QUERY"],
  ]) {
    const ref = await service.recall(artifact, request);
    const run = await service.read(ref.id);
    assert.equal(run.status, "failed");
    assert.equal(run.error.code, code);
    assert.deepEqual(run.result, { executed: 0, messages: [], trace: [] });
    assert.equal((await service.replay(ref.id)).matches, true);
  }
});

test("Run files cannot be overwritten, including concurrent inserts; IDs cannot escape storage", async (t) => {
  const { service, store, directory } = await setup(t);
  const ref = await service.recall(await compileMemorySource(graph), { entrypoints: ["entry"] });
  const original = await service.read(ref.id);
  const content = await readFile(join(directory, `${ref.id}.json`), "utf8");
  await assert.rejects(store.save(original), (error) => error.code === "E_RUN_STORE");
  assert.equal(await readFile(join(directory, `${ref.id}.json`), "utf8"), content);
  const id = crypto.randomUUID();
  const candidate = { ...original, id, resource: `fnmem://run/${id}` };
  const attempts = await Promise.allSettled([store.save(candidate), store.save(candidate)]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.deepEqual(await store.get(id), candidate);
  for (const id of ["../escape", "", ref.id.toUpperCase()]) await assert.rejects(store.get(id), MemoryRunError);
  assert.equal(await store.get(crypto.randomUUID()), undefined);
  await assert.rejects(service.read(crypto.randomUUID()), (error) => error.code === "E_RUN_NOT_FOUND");
  assert((await readdir(directory)).every((name) => name.endsWith(".json")));
});

test("corrupt files and foreign compiled versions fail; a changed expected result is detected by replay", async (t) => {
  const { service, store, directory } = await setup(t);
  const ref = await service.recall(await compileMemorySource(graph), { entrypoints: ["entry"] });
  const original = await service.read(ref.id);
  const filename = join(directory, `${ref.id}.json`);
  const envelope = JSON.parse(await readFile(filename, "utf8"));
  envelope.run.result.messages[0].content = "corrupted";
  await writeFile(filename, JSON.stringify(envelope));
  await assert.rejects(service.read(ref.id), /hash mismatch/);
  const incorrectId = crypto.randomUUID();
  await store.save({ ...original, id: incorrectId, resource: `fnmem://run/${incorrectId}`, result: envelope.run.result });
  const replay = await service.replay(incorrectId);
  assert.equal(replay.matches, false);
  assert.equal((await service.read(replay.id)).result.messages[0].content, "root");
  const foreignId = crypto.randomUUID();
  await store.save({ ...original, id: foreignId, resource: `fnmem://run/${foreignId}`, artifact: { ...original.artifact, runtimeVersion: "future-version" } });
  const files = await readdir(directory);
  await assert.rejects(service.replay(foreignId), /version mismatch/);
  assert.deepEqual(await readdir(directory), files);
});

test("invalid evidence and non-JSON inputs are rejected before acceptance; storage failure returns no URI", async (t) => {
  const { service, directory } = await setup(t);
  const artifact = await compileMemorySource(graph);
  const judgment = parseLikelihoodJudgment({ likelihood: "confirmed" }, { version: LIKELIHOOD_VERSION, verified: "confirmed" });
  for (const evidence of [
    [{ judgment, facts: {} }],
    [{ judgment, facts: {}, verification: { likelihood: "confirmed" } }],
    [{ judgment: { ...judgment, weight: 0.8 }, facts: {}, verification: { likelihood: "confirmed", evidence: "checked" } }],
  ]) await assert.rejects(service.recall(artifact, { entrypoints: ["entry"] }, evidence));
  await assert.rejects(service.recall(artifact, { entrypoints: ["entry"], context: { value: Infinity } }));
  assert.deepEqual(await readdir(directory), []);
  const ref = await service.recall(artifact, { entrypoints: ["entry"] }, [{ judgment, facts: { failures: 3 }, verification: { likelihood: "confirmed", evidence: { source: "fixture-observation" } } }]);
  assert.equal((await service.read(ref.id)).judgments[0].verification.evidence.source, "fixture-observation");
  const failing = new MemoryRunService({ get: async () => undefined, save: async () => { throw new MemoryRunError("Disk unavailable", "E_RUN_STORE"); } });
  await assert.rejects(failing.recall(artifact, { entrypoints: ["entry"] }), (error) => error.code === "E_RUN_STORE");
});
