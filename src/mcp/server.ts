import { McpServer, ResourceTemplate, ResourceNotFoundError } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { CompiledMemoryBundle } from "../dsl/index.js";
import { MemoryRunError } from "../errors.js";
import { LIKELIHOOD_CATALOG, LIKELIHOOD_VALUE_SCHEMA, LIKELIHOOD_VERSION, parseLikelihoodJudgment } from "../likelihood.js";
import type { MemoryRunService } from "../runs.js";
import { checkRunId } from "../runs.js";
import type { RecallRequest } from "../types.js";

const fields = z.record(z.string(), z.json());
const requestSchema = z.strictObject({
  entrypoints: z.array(z.union([
    z.string().min(1),
    z.strictObject({ ref: z.string().min(1), input: fields.optional() }),
  ])).describe("Ordered IDs or memory invocations selected from the definition resources."),
  context: fields.optional().describe("Shared public facts. Fields beginning with __ are reserved."),
  limits: z.strictObject({
    maxExecutions: z.number().int().min(1).optional(),
    maxDepth: z.number().int().min(0).optional(),
    maxVisitsPerMemory: z.number().int().min(1).optional(),
  }).optional().describe("Optional lower limits; cannot exceed the server's host ceilings."),
  judgments: z.array(z.strictObject({
    likelihood: z.enum(LIKELIHOOD_VALUE_SCHEMA.enum),
    facts: fields,
  })).optional().describe("Optional applicability judgments retained with supplied facts. The host derives version and weight; no verification flags are accepted."),
});

export function memoryResourceUri(id: string): string {
  // Escape the encoded ID again so URL parsing cannot turn '.'/'..' into path traversal.
  return `fnmem://memory/${encodeURIComponent(encodeURIComponent(id).replaceAll(".", "%2E"))}`;
}

/** Both transports create instances from this factory around the same immutable bundle/store. */
export function createMemoryMcpServer(bundle: CompiledMemoryBundle, runs: MemoryRunService): McpServer {
  const server = new McpServer({ name: "fnmem", version: "0.1.0" });
  server.registerTool("recall", {
    title: "Recall memory",
    description: [
      "Execute selected compiled memories and persist a completed or failed Memory Run. Returns a resource reference only; read it to inspect status, results and trace. No model is called. This creates a new Run on every call.",
      `Optional judgments use ${LIKELIHOOD_VERSION}. Select canonical identifiers regardless of user language; never supply numeric weights or translated synonyms.`,
      ...LIKELIHOOD_CATALOG.options.map((option) => `${option.id}: ${option.criteria.en}`),
      "Endpoint judgments require trusted host verification. No verifier is registered through this tool, so confirmed and ruled_out in judgments are rejected. Judgments are audit records; associate them with the relevant query inputs explicitly.",
    ].join("\n"),
    inputSchema: requestSchema,
    outputSchema: z.strictObject({ id: z.string().uuid(), resource: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ judgments = [], ...query }) => {
    try {
      const evidence = judgments.map(({ likelihood, facts }) => ({
        judgment: parseLikelihoodJudgment({ likelihood }, { version: LIKELIHOOD_VERSION }), facts,
      }));
      const reference = await runs.recall(bundle.artifact, query as RecallRequest, evidence);
      return {
        content: [
          { type: "text", text: JSON.stringify(reference) },
          { type: "resource_link", uri: reference.resource, name: `Memory Run ${reference.id}`, mimeType: "application/json" },
        ],
        structuredContent: { ...reference },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "E_MCP_RECALL";
      return { isError: true, content: [{ type: "text", text: `${code}: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });

  for (const memory of bundle.list()) {
    const uri = memoryResourceUri(memory.id);
    const { source, sourceHash, languageVersion, specRevision, compilerVersion, runtimeVersion } = bundle.artifact;
    const definition = { id: memory.id, contextSchema: memory.contextSchema, inputSchema: memory.inputSchema, source, sourceHash, languageVersion, specRevision, compilerVersion, runtimeVersion };
    server.registerResource(`memory:${memory.id}`, uri, {
      title: memory.id, description: "Compiled peer memory definition and shared bundle source. Reading does not execute it.", mimeType: "application/json",
    }, async () => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(definition) }] }));
  }

  server.registerResource("memory-run", new ResourceTemplate("fnmem://run/{id}", { list: undefined }), {
    title: "Memory Run", description: "Read an immutable saved completed/failed execution. No recall or model inference occurs.", mimeType: "application/json",
  }, async (uri, variables) => {
    if (typeof variables.id !== "string") throw new ResourceNotFoundError(uri.href);
    try { checkRunId(variables.id); } catch { throw new ResourceNotFoundError(uri.href); }
    try {
      const run = await runs.read(variables.id);
      return { contents: [{ uri: run.resource, mimeType: "application/json", text: JSON.stringify(run) }] };
    } catch (error) {
      if (error instanceof MemoryRunError && error.code === "E_RUN_NOT_FOUND") throw new ResourceNotFoundError(uri.href, error.message);
      throw error;
    }
  });
  return server;
}
