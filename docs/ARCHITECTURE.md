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

1. Normalize recall entrypoints into a FIFO queue.
2. Load a `MemoryFunction` from `MemoryStore`.
3. Execute it with context, invocation input and a read-only working-memory view.
4. Append text emissions to working memory.
5. Append memory-call emissions to the queue.
6. Repeat until the queue is empty.
7. Return buffered text and an execution trace.

Execution is bounded by three independent limits:

- maximum total executions
- maximum activation hops from a recall entrypoint (`maxDepth`)
- maximum visits per memory ID

These guards are required because functional memories may recursively activate one another.

The trusted host configures ceilings through `new MemoryRuntime(store, limits)`; queries may lower them but cannot raise them. Each invocation receives a frozen context containing one non-enumerable `__<random suffix>` field with the remaining total execution budget. All activated nodes in the recall share this budget. Caller-supplied `__` context/input fields are rejected, including inputs supplied along emitted activation edges. The counter is private to the runtime; random names are excluded from canonical queries and comparison results.

## DSL compilation boundary

The [DSL v0 specification](./DSL.md) preserves FIFO scheduling and both emission types. Stage three adds parsing, static types and a JavaScript backend before the existing `MemoryFunction` execution boundary. Authors supply DSL source; the compiler creates the functions. This is specified but not implemented.

The compiler/runtime must additionally validate canonical queries and field schemas, snapshot definitions and input data, supply a read-only working-memory snapshot per invocation and retain diagnostic partial data on failure. Source/version identity must be available to the later Memory Run layer. No model call is part of recall execution.

## Deliberate omissions

The runtime does not currently own retrieval ranking, embedding generation, persistence, model calls, tool execution, or agent state. Those can be supplied by future adapters while the execution core remains deterministic and testable.
