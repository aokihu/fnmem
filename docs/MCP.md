# MCP interface

The MCP adapter exposes the same compiled memory bundle and persistent Run service over **stdio** and **Streamable HTTP**. With no `--mode` argument it starts in stdio mode. HTTP permits multiple agents to access the same memory definitions and saved execution resources; every recall keeps independent inputs, budgets and a unique Run ID.

The implementation uses the [official TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html). The MCP integration tests use real clients over child-process stdio and listening HTTP sockets, including 2025-era and 2026-07-28 clients.

## Start locally

```sh
npm install
npm run build

# Default mode: stdio, suitable for an agent-owned child process.
node dist/src/mcp/cli.js --source examples/likelihood.fnm

# Explicit equivalent.
node dist/src/mcp/cli.js --mode stdio --source examples/likelihood.fnm

# Shared service: http://127.0.0.1:3333/mcp
node dist/src/mcp/cli.js --mode http --source examples/likelihood.fnm
```

The packaged executable is `fnmem-mcp` and accepts the same arguments. For agent configuration, invoke `node` with the compiled CLI directly, or the packaged executable. This keeps stdout reserved for MCP messages. Startup messages and errors go to stderr. Build before an agent starts the process.

Supply exactly one of `--source` (UTF-8 `.fnm` source) or `--artifact` (a JSON artifact created by `dsl:compile`). The compiler/loader validates it before serving. The bundle is fixed for the server lifetime; restart after changing a definition. Agents cannot upload JavaScript or replace the bundle through this interface.

| Option | Default | Meaning |
| --- | --- | --- |
| `--mode` | `stdio` | `stdio` or `http` |
| `--source` | Required alternative | DSL source file |
| `--artifact` | Required alternative | Verified compiled artifact file |
| `--runs-dir` | `.fnmem/runs` | Shared insert-only Run directory |
| `--host` | `127.0.0.1` | HTTP bind address |
| `--port` | `3333` | HTTP port; `0` selects an available port |
| `--help` | — | Show usage |

`--host` and `--port` require HTTP mode. Unknown, repeated or conflicting options fail before serving. Relative paths resolve against the process working directory. Use absolute source/storage paths when integrating an agent.

Example stdio host configuration:

```json
{
  "mcpServers": {
    "fnmem": {
      "command": "node",
      "args": [
        "/absolute/path/fnmem/dist/src/mcp/cli.js",
        "--source", "/absolute/path/fnmem/examples/likelihood.fnm",
        "--runs-dir", "/absolute/path/fnmem/.fnmem/runs"
      ]
    }
  }
}
```

Adapt the host's configuration format as needed. The process communicates over its stdin/stdout pipes and opens no HTTP listener in this mode.

## Share with several agents

Bind the HTTP service to a reachable interface:

```sh
node dist/src/mcp/cli.js --mode http --host 0.0.0.0 --port 3333 \
  --source examples/likelihood.fnm --runs-dir .fnmem/shared-runs
```

Agents connect to `http://<server-address>:3333/mcp` using a Streamable HTTP client. Protocol instances are created per request by the SDK; the immutable bundle and file Run store are shared outside those instances. A Run URI returned to agent A can be read by agent B. Disconnecting one agent does not clear other agents' Runs or budgets.

The default bind is loopback. Host and Origin headers are validated, including when binding a wildcard address. Non-browser clients can omit Origin. HTTP supports an optional shared bearer token from the `FNMEM_HTTP_TOKEN` environment variable; clients then send `Authorization: Bearer <token>` on every request. The token is not printed or accepted as a command-line flag. Use a trusted network or an authenticated TLS proxy for remote access. This is a shared workspace: there is no per-agent identity, permission isolation or built-in TLS/OAuth server.

SIGINT/SIGTERM close the transports. Closing stdin ends the stdio connection. HTTP shutdown is idempotent and closes its listener and transport instances. Local Run storage retains the [stage-four persistence limits](./MEMORY_RUNS.md).

## Tool: recall

`tools/list` exposes one tool named `recall`. Its arguments reuse the runtime's query shape, with optional judgment evidence:

```json
{
  "entrypoints": [{
    "ref": "pattern-route",
    "input": {
      "likelihoodVersion": "likelihood-v1",
      "likelihood": "very_likely"
    }
  }],
  "context": {},
  "limits": { "maxExecutions": 8 },
  "judgments": [{
    "likelihood": "very_likely",
    "facts": { "repeatedFailures": 3, "strategyUnchanged": true }
  }]
}
```

Context and invocation fields remain governed by their DSL schemas. Callers may lower execution/hop/visit limits but cannot raise server ceilings. The runtime owns its private `__` budget field. Extra tool fields are rejected rather than silently ignored.

Optional `judgments` use [likelihood-v1](./LIKELIHOOD.md). Models supply canonical word IDs and facts; the server derives immutable version/weight records. Numeric weights, translated aliases and host-verification flags are rejected. No factual verifier is registered in this MCP adapter, so `confirmed` and `ruled_out` in judgment evidence are rejected. Trusted hosts can still use the underlying Run service with their own verification evidence. The adapter does not infer whether arbitrary string fields in an invocation are likelihood judgments; hosts must associate validated judgments with DSL inputs explicitly.

After executing and saving a terminal Run, the tool returns a small reference:

```json
{
  "id": "<UUID>",
  "resource": "fnmem://run/<UUID>"
}
```

This appears in both text and `structuredContent`; a resource link is also returned. Memory contents are read separately. Every tool call creates a new Run, so the tool is not idempotent. Retrying a disconnected request can create another Run; there is no request deduplication in this stage.

A runtime failure, including a budget stop, still returns an inspectable saved Run with `status: "failed"`. Check the resource status before using messages. Invalid tool arguments, rejected judgment evidence and storage failure return tool errors without a successful reference. The adapter makes no LLM calls.

## Read-only resources

| Resource | Read result |
| --- | --- |
| `fnmem://memory/{encoded-id}` | Definition ID, field schemas, bundle source/hash and language/compiler/runtime versions |
| `fnmem://run/{id}` | Saved completed/failed Run, result, evidence, invocation graph and metrics |

`resources/list` lists the loaded definitions. `resources/templates/list` advertises the Run template; Run IDs are obtained from recall results rather than listing all history. Unknown resources fail instead of returning empty results.

Use listed definition URIs as opaque resource identifiers. `memoryResourceUri(id)` generates them, escaping ID components so Unicode, slashes, literal percent signs and dot IDs remain distinct after URL parsing. The original definition ID in the resource body is what entrypoints use. A definition resource contains the shared source bundle, not an executable callback.

Neither resource read executes a memory, creates a Run or asks a model to judge again. Reading a Run after restart uses the stored artifact and results, even if a newer definition is now loaded. Replay remains an explicit host-service operation; no replay or creation tool is exposed in this stage.

## Embed in a Node agent

```ts
import { loadMemoryArtifact, FileMemoryRunStore, MemoryRunService } from "fnmem";
import { createMemoryMcpServer, startHttpMcp, startStdioMcp } from "fnmem/mcp";

const bundle = await loadMemoryArtifact(artifact);
const runs = new MemoryRunService(new FileMemoryRunStore(runDirectory));

// Choose a transport in the host application.
const stdio = startStdioMcp(bundle, runs);
// Or: const http = await startHttpMcp(bundle, runs, { host: "127.0.0.1", port: 3333 });

// A host with its own SDK transport can connect createMemoryMcpServer(bundle, runs).
```

These exports are isolated under `fnmem/mcp`; importing the execution core does not start a server.

## Verified scope and next stage

The integration tests cover discovery, definition reads, actual recall→URI→read, repeated reads, concurrent independent agent calls, shared Run access after restart, failed Runs, word-choice validation, header/token checks, both CLI modes and shutdown. These demonstrate the interface and storage behavior; they do not measure memory improvement or live model agreement.

The next development stage is memory creation: Observation → Candidate → formation decisions → validated DSL/content revision → Formation Run. That workflow is not implemented by this adapter.
