#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { compileMemorySource, loadMemoryArtifact } from "../dsl/index.js";
import type { CompiledMemoryArtifact } from "../dsl/index.js";
import { MemoryRunService } from "../runs.js";
import { FileMemoryRunStore } from "../stores/file-runs.js";
import { parseJson } from "../validation.js";
import { startHttpMcp, startStdioMcp } from "./transports.js";

const usage = `Usage: fnmem-mcp (--source SOURCE.fnm | --artifact ARTIFACT.json) [options]
  --mode stdio|http    Default: stdio
  --runs-dir PATH      Default: .fnmem/runs
  --host HOST          HTTP bind address. Default: 127.0.0.1
  --port PORT          HTTP port. Default: 3333
  --help               Show this help
HTTP clients connect to /mcp. Optional bearer token: FNMEM_HTTP_TOKEN environment variable.`;

try {
  const { values, tokens } = parseArgs({
    options: {
      mode: { type: "string" }, source: { type: "string" }, artifact: { type: "string" },
      "runs-dir": { type: "string" }, host: { type: "string" }, port: { type: "string" }, help: { type: "boolean" },
    }, tokens: true, allowPositionals: false,
  });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === "option") {
    if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
    seen.add(token.name);
  }
  if (values.help) console.log(usage);
  else {
    const mode = values.mode ?? "stdio";
    if (mode !== "stdio" && mode !== "http") throw new Error("--mode must be stdio or http.");
    if (!!values.source === !!values.artifact) throw new Error("Supply exactly one of --source or --artifact.");
    if (mode === "stdio" && (values.host !== undefined || values.port !== undefined)) throw new Error("--host and --port require --mode http.");
    const port = values.port === undefined ? 3333 : Number(values.port);
    if (values.port !== undefined && (!/^\d+$/.test(values.port) || !Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be an integer from 0 to 65535.");
    const file = await readFile(resolve(values.source ?? values.artifact!));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file);
    const artifact = values.source ? await compileMemorySource(text) : parseJson(text) as CompiledMemoryArtifact;
    const bundle = await loadMemoryArtifact(artifact);
    const runs = new MemoryRunService(new FileMemoryRunStore(values["runs-dir"] ?? ".fnmem/runs"));
    const token = process.env.FNMEM_HTTP_TOKEN;
    if (mode === "http" && token !== undefined && !token.trim().length) throw new Error("FNMEM_HTTP_TOKEN must not be empty.");
    const service = mode === "stdio" ? startStdioMcp(bundle, runs) : await startHttpMcp(bundle, runs, {
      host: values.host ?? "127.0.0.1", port, ...(token !== undefined ? { token } : {}),
    });
    if ("url" in service) console.error(`fnmem MCP listening at ${service.url}`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await service.close(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
