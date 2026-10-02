import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { request } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { compileMemorySource, loadMemoryArtifact, FileMemoryRunStore, MemoryRunService } from "../dist/src/index.js";
import { memoryResourceUri, startHttpMcp } from "../dist/src/mcp/index.js";

const source = `language fnmem "0";
memory "entry" {
  context { topic: string; }
  emit text context.topic;
  emit memory "linked" with { message: context.topic };
}
memory "linked" { input { message: string; } emit text "linked:" + input.message; }
memory "loop" { emit text "tick"; emit memory "loop"; }
memory "资料/环 %?" { emit text "Unicode definition"; }
memory "." { emit text "dot"; }
memory ".." { emit text "dots"; }
memory "%2E" { emit text "escaped dot"; }`;
const cli = resolve("dist/src/mcp/cli.js");

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "fnmem-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memories.fnm"), runsPath = join(directory, "runs");
  await writeFile(path, source);
  const artifact = await compileMemorySource(source);
  const bundle = await loadMemoryArtifact(artifact);
  const store = new FileMemoryRunStore(runsPath);
  return { directory, path, runsPath, artifact, bundle, store, runs: new MemoryRunService(store) };
}

async function httpClient(t, url, name, options = {}, clientOptions = {}) {
  const client = new Client({ name, version: "1.0.0" }, clientOptions);
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), options));
  return client;
}

async function readRun(client, resource) {
  const response = await client.readResource({ uri: resource });
  assert.equal(response.contents[0].uri, resource);
  assert.equal(response.contents[0].mimeType, "application/json");
  return JSON.parse(response.contents[0].text);
}

test("default stdio CLI completes discovery, recall, Run resource reads and definition reads through a real MCP client", async (t) => {
  const { path, runsPath, artifact, store } = await setup(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--source", path, "--runs-dir", runsPath], stderr: "pipe" });
  const errors = [];
  transport.onerror = (error) => errors.push(error);
  const client = new Client({ name: "stdio-agent", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, "fnmem");
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["recall"]);
  assert.equal(tools.tools[0].annotations.idempotentHint, false);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 7);
  for (const id of ["entry", "资料/环 %?", ".", "..", "%2E"]) {
    const uri = memoryResourceUri(id);
    assert.equal(new URL(uri).href, uri);
    assert(resources.resources.some((resource) => resource.uri === uri));
    const definition = await readRun(client, uri);
    assert.equal(definition.id, id);
    assert.equal(definition.sourceHash, artifact.sourceHash);
    assert.equal(definition.source, source);
  }
  const templates = await client.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates.map((item) => item.uriTemplate), ["fnmem://run/{id}"]);
  const result = await client.callTool({ name: "recall", arguments: {
    entrypoints: ["entry"], context: { topic: "用户事实" },
    judgments: [{ likelihood: "very_likely", facts: { failures: 3 } }],
  } });
  assert.equal(result.isError, undefined);
  const reference = result.structuredContent;
  assert.equal(result.content[1].type, "resource_link");
  assert.equal(result.content[1].uri, reference.resource);
  const run = await readRun(client, reference.resource);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result.messages.map((message) => message.content), ["用户事实", "linked:用户事实"]);
  assert.deepEqual(run.judgments[0].judgment, { version: "likelihood-v1", likelihood: "very_likely", weight: 0.8 });
  assert.deepEqual(await store.get(reference.id), run);
  const before = await readFile(join(runsPath, `${reference.id}.json`), "utf8");
  await readRun(client, reference.resource);
  await readRun(client, memoryResourceUri("entry"));
  assert.equal(await readFile(join(runsPath, `${reference.id}.json`), "utf8"), before);
  assert.deepEqual(await readdir(runsPath), [`${reference.id}.json`]);
  assert.deepEqual(errors, []);
});

test("HTTP agents share definitions and stored Runs while concurrent recalls keep inputs, budgets and IDs independent", async (t) => {
  const { bundle, runs, runsPath } = await setup(t);
  const http = await startHttpMcp(bundle, runs, { port: 0 });
  t.after(() => http.close());
  const a = await httpClient(t, http.url, "agent-a");
  const b = await httpClient(t, http.url, "agent-b", {}, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  assert.deepEqual((await a.listResources()).resources, (await b.listResources()).resources);
  const [first, second] = await Promise.all([
    a.callTool({ name: "recall", arguments: { entrypoints: ["entry"], context: { topic: "A" } } }),
    b.callTool({ name: "recall", arguments: { entrypoints: ["entry"], context: { topic: "B" } } }),
  ]);
  const refA = first.structuredContent, refB = second.structuredContent;
  assert.notEqual(refA.id, refB.id);
  assert.deepEqual((await readRun(b, refA.resource)).result.messages.map((item) => item.content), ["A", "linked:A"]);
  assert.deepEqual((await readRun(a, refB.resource)).result.messages.map((item) => item.content), ["B", "linked:B"]);
  const [limited, successful] = await Promise.all([
    a.callTool({ name: "recall", arguments: { entrypoints: ["loop"], limits: { maxExecutions: 2 } } }),
    b.callTool({ name: "recall", arguments: { entrypoints: ["entry"], context: { topic: "after-cycle" } } }),
  ]);
  const failed = await readRun(b, limited.structuredContent.resource);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "E_MAX_EXECUTIONS");
  assert.equal(failed.result.executed, 2);
  assert.equal((await readRun(a, successful.structuredContent.resource)).status, "completed");
  const files = await readdir(runsPath);
  assert.equal(files.length, 4);
  await a.close();
  await b.close();
  await http.close();
  const restarted = await startHttpMcp(bundle, runs, { port: 0 });
  t.after(() => restarted.close());
  const c = await httpClient(t, restarted.url, "agent-c");
  assert.deepEqual((await readRun(c, refA.resource)).result.messages.map((item) => item.content), ["A", "linked:A"]);
  assert.deepEqual(await readdir(runsPath), files);
});

test("MCP rejects extra fields, numeric judgments and forged verification; valid runtime failures remain inspectable resources", async (t) => {
  const { bundle, runs, runsPath } = await setup(t);
  const http = await startHttpMcp(bundle, runs, { port: 0 });
  t.after(() => http.close());
  const client = await httpClient(t, http.url, "invalid-input-agent");
  for (const extra of [
    { extra: "ignored?" },
    { judgments: [{ likelihood: 0.8, facts: {} }] },
    { judgments: [{ likelihood: "很可能", facts: {} }] },
    { judgments: [{ likelihood: "likely", facts: {}, verified: "confirmed" }] },
    { judgments: [{ likelihood: "confirmed", facts: {} }] },
  ]) {
    const result = await client.callTool({ name: "recall", arguments: { entrypoints: ["entry"], context: { topic: "test" }, ...extra } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
  await assert.rejects(readdir(runsPath), (error) => error.code === "ENOENT");
  const response = await client.callTool({ name: "recall", arguments: { entrypoints: ["missing"] } });
  const failed = await readRun(client, response.structuredContent.resource);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "E_MEMORY_NOT_FOUND");
  await assert.rejects(client.readResource({ uri: `fnmem://run/${crypto.randomUUID()}` }));
  await assert.rejects(client.readResource({ uri: "fnmem://run/invalid" }));
  await assert.rejects(client.readResource({ uri: memoryResourceUri("unknown") }));
  assert.equal((await readdir(runsPath)).length, 1);
});

test("HTTP enforces Host, Origin, optional bearer access and the /mcp endpoint", async (t) => {
  const { bundle, runs } = await setup(t);
  const http = await startHttpMcp(bundle, runs, { host: "0.0.0.0", port: 0, token: "test-only-token" });
  t.after(() => http.close());
  const url = http.url.replace("0.0.0.0", "127.0.0.1");
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  const badHost = await new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers: { Host: "attacker.invalid" } }, (response) => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject); outgoing.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await fetch(url.replace("/mcp", "/unknown"))).status, 404);
  const client = await httpClient(t, url, "authorized-agent", { requestInit: { headers: { Authorization: "Bearer test-only-token" } } });
  assert.equal((await client.listTools()).tools[0].name, "recall");
});

test("CLI accepts artifact loading and explicit stdio, and rejects invalid transport options before starting", async (t) => {
  const { directory, path, runsPath, artifact } = await setup(t);
  const artifactPath = join(directory, "memory.json");
  await writeFile(artifactPath, JSON.stringify(artifact));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--mode=stdio", "--artifact", artifactPath, "--runs-dir", runsPath], stderr: "pipe" });
  const client = new Client({ name: "artifact-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listResources()).resources.length, 7);
  const invoke = promisify(execFile);
  for (const args of [
    ["--mode", "other"], ["--source", path, "--port", "3333"],
    ["--source", path, "--mode", "http", "--port", "3.2"],
    ["--source", path, "--mode", "http", "--port", "65536"],
    ["--source", path, "--artifact", artifactPath],
    ["--source", path, "--mode", "stdio", "--mode", "http"],
  ]) await assert.rejects(invoke(process.execPath, [cli, ...args], { timeout: 5000 }), (error) => error.code === 1 && error.stdout === "" && error.stderr.length > 0);
});

test("HTTP CLI starts with --mode http, serves a real client, and exits cleanly on SIGTERM", async (t) => {
  const { path, runsPath } = await setup(t);
  const child = spawn(process.execPath, [cli, "--source", path, "--runs-dir", runsPath, "--mode", "http", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exit; });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP CLI startup timed out")), 5000);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /fnmem MCP listening at (http:\/\/[^\s]+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr || "HTTP CLI exited before startup")); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const client = await httpClient(t, url, "http-cli-agent");
  const result = await client.callTool({ name: "recall", arguments: { entrypoints: ["entry"], context: { topic: "CLI" } } });
  assert.deepEqual((await readRun(client, result.structuredContent.resource)).result.messages.map((item) => item.content), ["CLI", "linked:CLI"]);
  await client.close();
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stdout, "");
});
