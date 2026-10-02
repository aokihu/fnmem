import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { CompiledMemoryBundle } from "../dsl/index.js";
import type { MemoryRunService } from "../runs.js";
import { createMemoryMcpServer } from "./server.js";

export function startStdioMcp(bundle: CompiledMemoryBundle, runs: MemoryRunService) {
  return serveStdio(() => createMemoryMcpServer(bundle, runs), { onerror: (error) => console.error(error.message) });
}

export interface HttpMcpOptions {
  readonly host?: string;
  readonly port?: number;
  /** Optional trusted-network access token, kept out of command-line arguments. */
  readonly token?: string;
}

export async function startHttpMcp(bundle: CompiledMemoryBundle, runs: MemoryRunService, options: HttpMcpOptions = {}) {
  const host = options.host ?? "127.0.0.1", port = options.port ?? 3333;
  if (!host.length || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HTTP host or port.");
  const handler = createMcpHandler(() => createMemoryMcpServer(bundle, runs), { onerror: (error) => console.error(error.message) });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => console.error(error.message) });
  const http = createServer((request, response) => {
    // Wildcard binds accept the concrete receiving interface, never arbitrary Host names.
    const address = request.socket.localAddress?.replace(/^::ffff:/, "");
    const allowed = ["localhost", "127.0.0.1", "[::1]", host, ...(address ? [address.includes(":") ? `[${address}]` : address] : [])];
    if (!hostHeaderValidation(allowed)(request, response) || !originValidation(allowed)(request, response)) return;
    if (request.url !== "/mcp") { response.writeHead(404); response.end("Not found"); return; }
    if (options.token !== undefined && request.headers.authorization !== `Bearer ${options.token}`) {
      response.writeHead(401, { "WWW-Authenticate": "Bearer" }); response.end("Unauthorized"); return;
    }
    // Node's optional fields include explicit undefined; the SDK adapter handles them.
    void nodeHandler(request as NodeIncomingMessageLike, response);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => { http.removeListener("error", reject); resolve(); });
    });
  } catch (error) { await handler.close(); throw error; }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listening address.");
  const hostname = address.address.includes(":") ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${hostname}:${address.port}/mcp`,
    close(): Promise<void> {
      return closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
        await handler.close();
        http.closeAllConnections();
        await closed;
      })();
    },
  };
}
