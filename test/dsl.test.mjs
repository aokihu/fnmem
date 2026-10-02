import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compileMemorySource, loadMemoryArtifact, MemoryCompileError, MemoryRuntime, InMemoryStore, parseRecallQuery } from "../dist/src/index.js";

const fixtures = JSON.parse(await readFile(new URL("../dsl/fixtures.json", import.meta.url), "utf8"));
const bundles = new Map();
const empty = { messages: [], trace: [], executed: 0 };
async function bundle(path) {
  if (!bundles.has(path)) {
    const source = await readFile(new URL(`../dsl/${path}`, import.meta.url), "utf8");
    bundles.set(path, loadMemoryArtifact(JSON.parse(JSON.stringify(await compileMemorySource(source)))));
  }
  return bundles.get(path);
}

for (const item of fixtures.cases) {
  test(`DSL conformance: ${item.id}`, async () => {
    if (item.phase === "compile") {
      const source = await readFile(new URL(`../dsl/${item.source}`, import.meta.url), "utf8");
      await assert.rejects(compileMemorySource(source), (error) => {
        assert(error instanceof MemoryCompileError);
        assert(error.diagnostics.some((diagnostic) => diagnostic.code === item.expected.error.code), error.message);
        assert(error.diagnostics.every((diagnostic) => diagnostic.line >= 1 && diagnostic.column >= 1 && diagnostic.offset >= 0));
        return true;
      });
      return;
    }
    const runtime = new MemoryRuntime(await bundle(item.source), fixtures.runtimeCeilings);
    const run = async () => {
      try {
        const result = await runtime.recall(parseRecallQuery(JSON.stringify(item.query)));
        return { status: "completed", ...result };
      } catch (error) {
        assert.equal(error.code, item.expected.error?.code, error.stack);
        return { status: "failed", ...(error.partial ?? empty), error: { code: error.code } };
      }
    };
    assert.deepEqual(await run(), item.expected);
    // Caller identity is outside the query; new random runtime keys cannot
    // change either the golden output or a failed recall's committed trace.
    assert.deepEqual(await run(), item.expected);
  });
}

test("compiled JavaScript survives file/JSON round trips and preserves source identity", async () => {
  const source = await readFile(new URL("../dsl/examples/branches.fnm", import.meta.url), "utf8");
  const artifact = await compileMemorySource(source);
  assert.equal(artifact.sourceHash, createHash("sha256").update(source).digest("hex"));
  const directory = await mkdtemp(join(tmpdir(), "fnmem-compiler-"));
  try {
    const json = join(directory, "memory.json"), js = join(directory, "memory.mjs");
    await writeFile(json, JSON.stringify(artifact)); await writeFile(js, artifact.javascript);
    const loaded = await loadMemoryArtifact(JSON.parse(await readFile(json, "utf8")));
    const module = await import(pathToFileURL(js).href);
    const query = { entrypoints: ["route"], context: { error: "timeout", hasProxy: true } };
    assert.deepEqual(await new MemoryRuntime(loaded).recall(query), await new MemoryRuntime(new InMemoryStore(module.memories)).recall(query));
    assert(Object.isFrozen(loaded.get("route")));
    assert(Object.isFrozen(loaded.get("route").contextSchema));
    for (const key of ["javascript", "sourceHash", "compilerVersion", "runtimeVersion", "specRevision"]) {
      await assert.rejects(loadMemoryArtifact({ ...artifact, [key]: "tampered" }), /mismatch/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("raw canonical queries reject duplicate keys, invalid Unicode, host values and nonfinite numbers", async () => {
  const query = JSON.stringify({ context: {}, entrypoints: [], limits: fixtures.runtimeCeilings });
  for (const bad of [query.replace('"context":{}', '"context":{},"context":{}'), query.replace('"context":{}', '"context":{"x":1,"x":2}'), query.replace('"context":{}', '"context":{"x":"\\uD800"}'), query.replace('"context":{}', '"context":{"x":1e400}'), query.replace('"context":{}', '"context":{"x":1,}')]) {
    assert.throws(() => parseRecallQuery(bad), (error) => error.code === "E_QUERY");
  }
  const runtime = new MemoryRuntime(await bundle("examples/semantics.fnm"));
  for (const context of [{ x: new Date() }, { x: undefined }, { x: NaN }, { x: "\ud800" }, null]) {
    await assert.rejects(runtime.recall({ entrypoints: ["empty"], context }), (error) => error.code === "E_QUERY" && error.partial.executed === 0);
  }
  assert.equal(parseRecallQuery(query.replace('"context":{}', '"context":{"x":-0}')).context.x, 0);
});

test("runtime snapshots definitions, inputs and working memory and commits invocations atomically", async () => {
  const store = new InMemoryStore();
  const query = { entrypoints: ["entry"], context: { evidence: { value: "original" } } };
  store.register({ id: "entry", execute({ context, workingMemory }) {
    assert.throws(() => { context.evidence.value = "changed"; }, TypeError);
    assert.throws(() => workingMemory.push({ type: "text", content: "forged" }), TypeError);
    query.context.evidence.value = "outside change";
    store.register({ id: "linked", execute: () => [{ type: "text", content: "replacement" }] });
    return [{ type: "text", content: "committed" }, { type: "memory", ref: "linked" }];
  } });
  store.register({ id: "linked", execute: ({ context }) => [{ type: "text", content: context.evidence.value }] });
  const result = await new MemoryRuntime(store).recall(query);
  assert.deepEqual(result.messages.map((message) => message.content), ["committed", "original"]);
  const bad = new MemoryRuntime(new InMemoryStore([{ id: "bad", execute: () => [{ type: "text", content: "uncommitted" }, { type: "memory", ref: "" }] }]));
  await assert.rejects(bad.recall({ entrypoints: ["bad"] }), (error) => error.code === "E_EXECUTION" && error.partial.messages.length === 0 && error.partial.executed === 0);
});

test("source strings cannot inject JavaScript and diagnostics preserve CRLF positions", async () => {
  const content = '"; globalThis.__fnmemInjected = true; // 中文🙂';
  const source = `language fnmem "0"; memory "safe" { emit text ${JSON.stringify(content)}; }`;
  const runtime = new MemoryRuntime(await loadMemoryArtifact(await compileMemorySource(source)));
  assert.equal((await runtime.recall({ entrypoints: ["safe"] })).messages[0].content, content);
  assert.equal(globalThis.__fnmemInjected, undefined);
  await assert.rejects(compileMemorySource('language fnmem "0";\r\nmemory "x" {\r\n  emit text 1;\r\n}'), (error) => error.diagnostics[0].line === 3 && error.diagnostics[0].column === 3 && error.diagnostics[0].memory === "x");
  await assert.rejects(compileMemorySource('language fnmem "0"; memory "x" { emit text context.missing; }'), (error) => error.diagnostics[0].field === "missing");
});


test("compiler CLI writes loadable artifacts and rejects overwrites and invalid source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fnmem-compile-cli-"));
  const script = fileURLToPath(new URL("../scripts/compile-memory.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../dsl/examples/branches.fnm", import.meta.url));
  const output = join(directory, "memory.json");
  const compile = (input, artifact) => spawnSync(process.execPath, [script, input, "--out", artifact], { encoding: "utf8" });
  try {
    const valid = compile(source, output);
    assert.equal(valid.status, 0, valid.stderr);
    const saved = await readFile(output, "utf8");
    const runtime = new MemoryRuntime(await loadMemoryArtifact(JSON.parse(saved)));
    assert.deepEqual((await runtime.recall({ entrypoints: ["route"], context: { error: "timeout", hasProxy: true } })).messages.map((item) => item.content), ["check proxy", "routing complete", "inspect proxy"]);
    assert.equal(compile(source, output).status, 1);
    assert.equal(await readFile(output, "utf8"), saved);
    const invalid = fileURLToPath(new URL("../dsl/invalid/wrong-text.fnm", import.meta.url));
    const failed = compile(invalid, join(directory, "invalid.json"));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /E_TYPE/);
    await assert.rejects(readFile(join(directory, "invalid.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
