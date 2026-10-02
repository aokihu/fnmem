# Architecture

## Boundary

fnmem should be usable by an agent without exposing its internal memory graph.

```text
+----------------------+       +----------------------+
| Agent Runtime        |       | fnmem                |
|                      |       |                      |
| conversation         |       | MemoryRuntime        |
| tools                | ----> | MemoryStore          |
| model provider       | recall| MemoryFunction[]     |
| evaluation pipeline  | <---- | Working Memory      |
+----------------------+       +----------------------+
```

The host agent owns conversation orchestration. fnmem owns memory execution.

Memory definitions are peer graph nodes. Emitted references describe directed activation edges; entrypoints select where a recall starts. Execution order and invocation distance describe a particular graph traversal, not a hierarchy of memories.

## Execution algorithm

1. Validate and snapshot the query; snapshot the store when supported. Preflight every selected entrypoint and its field schemas.
2. Check the next queued invocation against execution, hop and visit limits.
3. Load its compiled function and validate its own context/input schemas.
4. Execute with immutable context/input, execution metadata and a working-memory snapshot.
5. Validate all local emissions, then atomically commit the invocation and trace. Append text to working memory and memory references to the FIFO queue.
6. Repeat until the queue is empty; return buffered text and the committed trace.
7. On failure, stop and attach the committed partial result and failing reference/hop count to the error. Partial output is diagnostic only.

Execution is bounded by three independent limits:

- maximum total executions
- maximum activation hops from a recall entrypoint (`maxDepth`)
- maximum visits per memory ID

These guards are required because functional memories may recursively activate one another.

The trusted host configures ceilings through `new MemoryRuntime(store, limits)`; queries may lower them but cannot raise them. Each invocation receives a frozen context containing one non-enumerable `__<random suffix>` field with the remaining total execution budget. All activated nodes in the recall share this budget. Caller-supplied `__` context/input fields are rejected, including inputs supplied along emitted activation edges. The counter is private to the runtime; random names are excluded from canonical queries and comparison results.

## DSL compilation boundary

The [DSL v0 compiler](./DSL.md) parses and checks source before emitting JavaScript at the `MemoryFunction` boundary. Authors supply DSL source; the compiler creates the functions. Artifacts carry source SHA-256, language/spec and compiler/runtime versions. Loading regenerates the artifact from source and verifies every field before importing the generated module.

`parseRecallQuery` enforces the canonical raw JSON boundary, including duplicate-key rejection. Runtime schema validation, immutable inputs/working memory and diagnostic partial failures are implemented. Compiled bundles are immutable; `InMemoryStore.snapshot()` fixes definitions for each recall. Other stores can provide the optional snapshot method and must supply stable definitions if they require the same guarantee. No model call is part of recall execution.

## Observable Run boundary

`MemoryRunService` wraps verified compiled artifacts and `MemoryRuntime.recallObserved()`. It saves terminal completed/failed records before returning `fnmem://run/{id}`. The existing compact recall result is preserved; detailed observations add distinct invocation IDs, resolved inputs/public context, validated emissions and directed activation edges. Failure records retain only committed outputs, plus blocked and pending calls.

`FileMemoryRunStore` persists insert-only JSON envelopes with stable content hashes and atomic publication. Reading requires no execution and works across process restarts. Replay verifies the saved artifact, reuses saved input/host ceilings and saves a new Run with a semantic comparison result. Versioned judgments and host evidence can accompany a Run. See [MEMORY_RUNS.md](./MEMORY_RUNS.md) for API and storage limits.

## Deliberate omissions

The [MCP adapter](./MCP.md) wraps the same immutable bundle and Run service with a recall tool and read-only definitions/Run resources. Default stdio serves an agent-owned process; explicit HTTP uses per-request protocol instances with shared definition/storage state. Recall inputs, limits and Run identity remain isolated per query.

The execution core does not own retrieval ranking, embedding generation, model calls, external tool execution or agent state. Run persistence belongs to the service/store boundary. Memory formation is the next stage.
