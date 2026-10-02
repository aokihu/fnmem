import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFile(resolve(root, path));
const json = async (path) => JSON.parse(await read(path));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const compileCodes = new Set(["E_SYNTAX", "E_DUPLICATE", "E_FIELD", "E_TYPE", "E_REFERENCE", "E_ARGUMENT", "E_MATCH", "E_RESERVED"]);
const recallCodes = new Set(["E_QUERY", "E_INPUT", "E_MEMORY_NOT_FOUND", "E_MAX_EXECUTIONS", "E_MAX_DEPTH", "E_MAX_VISITS"]);

async function listSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listSources(path));
    else if (entry.name.endsWith(".fnm")) files.push(relative(resolve(root, "dsl"), path));
  }
  return files.sort();
}

function checkQuery(query) {
  assert(object(query), "Expected a query object");
  assert.deepEqual(Object.keys(query).sort(), ["context", "entrypoints", "limits"]);
  assert(object(query.context) && Array.isArray(query.entrypoints));
  assert(!Object.keys(query.context).some((name) => name.startsWith("__")));
  for (const entry of query.entrypoints) {
    assert(object(entry) && nonempty(entry.ref) && object(entry.input));
    assert(!Object.keys(entry.input).some((name) => name.startsWith("__")));
    assert.deepEqual(Object.keys(entry).sort(), ["input", "ref"]);
  }
  assert(object(query.limits));
  assert.deepEqual(Object.keys(query.limits).sort(), ["maxDepth", "maxExecutions", "maxVisitsPerMemory"]);
  for (const [key, value] of Object.entries(query.limits)) {
    assert(Number.isSafeInteger(value) && value >= (key === "maxDepth" ? 0 : 1));
  }
}

function checkResult(expected) {
  assert(["completed", "failed"].includes(expected.status));
  assert(Array.isArray(expected.messages) && Array.isArray(expected.trace));
  assert.equal(expected.executed, expected.trace.length);
  for (const item of expected.trace) {
    assert.deepEqual(Object.keys(item).sort(), ["depth", "emissions", "memory"]);
    assert(nonempty(item.memory) && Number.isSafeInteger(item.depth) && item.depth >= 0);
    assert(Number.isSafeInteger(item.emissions) && item.emissions >= 0);
  }
  for (const item of expected.messages) {
    assert.deepEqual(Object.keys(item).sort(), ["content", "source", "type"]);
    assert(item.type === "text" && typeof item.content === "string" && nonempty(item.source));
    assert(expected.trace.some((entry) => entry.memory === item.source), "Text source must occur in the committed trace");
  }
  assert(expected.messages.length <= expected.trace.reduce((count, item) => count + item.emissions, 0));
  if (expected.status === "failed") assert(recallCodes.has(expected.error?.code));
  else assert.equal(expected.error, undefined);
}

async function main() {
  const fixture = await json("dsl/fixtures.json");
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.specVersion, "fnmem-dsl-0");
  assert.equal(fixture.specRevision, "runtime-budget-1");
  assert.equal(fixture.evidence, "specification-only");
  assert.deepEqual(fixture.runtimeCeilings, { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 });
  assert(object(fixture.sources) && Array.isArray(fixture.cases));
  assert.deepEqual(Object.keys(fixture.sources).sort(), await listSources(resolve(root, "dsl")));
  for (const [path, expectedHash] of Object.entries(fixture.sources)) {
    assert.equal(hash(await read(`dsl/${path}`)), expectedHash, `Changed DSL source: ${path}`);
  }

  // Hash reserved bytes without reading judge labels into language examples.
  const manifest = await json("evaluation/data/manifest.json");
  for (const [path, expectedHash] of Object.entries(manifest.files)) {
    assert.equal(hash(await read(`evaluation/data/${path}`)), expectedHash, `Frozen dataset changed: ${path}`);
  }
  const development = await json("evaluation/data/development.json");
  assert.equal(fixture.development.version, development.version);
  assert.equal(fixture.development.sha256, manifest.files["development.json"]);
  const tasks = new Map(development.tasks.map((task) => [task.id, task]));
  const coveredTasks = new Set();
  const ids = new Set();
  const tags = new Set();
  const usedSources = new Set();
  let compileRejections = 0, completed = 0, recallFailures = 0;
  for (const item of fixture.cases) {
    try {
      assert(nonempty(item.id) && !ids.has(item.id), "Invalid or repeated case ID");
      ids.add(item.id);
      assert(Object.hasOwn(fixture.sources, item.source), "Unregistered source");
      usedSources.add(item.source);
      assert(Array.isArray(item.tags) && item.tags.every(nonempty));
      item.tags.forEach((tag) => tags.add(tag));
      if (item.phase === "compile") {
        assert.equal(item.expected.status, "rejected");
        assert(compileCodes.has(item.expected.error?.code));
        assert.equal(item.query, undefined);
        compileRejections++;
      } else {
        assert.equal(item.phase, "recall");
        if (item.expected.error?.code !== "E_QUERY") {
          checkQuery(item.query);
          for (const [key, ceiling] of Object.entries(fixture.runtimeCeilings)) assert(item.query.limits[key] <= ceiling);
        }
        else assert.notEqual(item.query, undefined);
        checkResult(item.expected);
        if (item.expected.status === "completed") completed++;
        else recallFailures++;
      }
      if (item.task !== undefined) {
        const task = tasks.get(item.task);
        assert(task && !coveredTasks.has(task.id), "Unknown or repeated development task");
        coveredTasks.add(task.id);
        assert.equal(item.source, "examples/development.fnm");
        assert.equal(item.expected.status, "completed");
        assert.deepEqual(item.query.context, task.context);
        assert.deepEqual(item.query.entrypoints, task.selectedMemories.map((ref) => ({ ref, input: {} })));
        assert.deepEqual(item.expected.trace.map((entry) => entry.memory), task.selectedMemories);
      }
    } catch (error) {
      throw new Error(`${item.id}: ${error.message}`);
    }
  }
  assert.deepEqual([...coveredTasks].sort(), [...tasks.keys()].sort(), "Every development task needs one expected recall");
  assert.deepEqual([...usedSources].sort(), Object.keys(fixture.sources).sort(), "Unused source fixture");
  for (const tag of ["fifo", "fanout", "forwarding", "snapshot", "execution", "defaults", "else", "precedence", "duplicates", "unicode", "duplicate-text", "exact-budget", "cycle", "execution-limit", "visit-limit", "depth-limit", "limit-precedence", "linked-validation", "preflight", "no-coercion", "unknown-context", "invalid-query", "when-alias", "else-chain", "independent-conditions", "match-alternatives", "match-guard", "match-first", "match-fallback", "match-boolean", "match-number", "match-nested", "match-invalid"]) {
    assert(tags.has(tag), `Missing specification coverage: ${tag}`);
  }
  for (const item of fixture.cases.filter((item) => item.equivalentTo)) {
    const other = fixture.cases.find((candidate) => candidate.id === item.equivalentTo);
    assert(other && other.source !== item.source, "Alias equivalence requires another source");
    assert.deepEqual(item.query, other.query);
    assert.deepEqual(item.expected, other.expected, "Alias expectations must be identical");
  }
  for (const tag of ["reserved-declaration", "reserved-access", "reserved-argument", "reserved-query", "runtime-ceiling"]) {
    assert(tags.has(tag), `Missing internal-budget coverage: ${tag}`);
  }
  console.log(JSON.stringify({ evidence: fixture.evidence, sources: usedSources.size, cases: ids.size, developmentTasks: coveredTasks.size, completedExpectations: completed, recallFailureExpectations: recallFailures, compileRejectionExpectations: compileRejections }, null, 2));
  console.log("Artifact checks passed. This command checks inventory only; use npm run dsl:test for compiled semantic conformance.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
