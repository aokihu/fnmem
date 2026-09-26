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
- maximum invocation depth
- maximum visits per memory ID

These guards are required because functional memories may recursively activate one another.

## Deliberate omissions

The runtime does not currently own retrieval ranking, embedding generation, persistence, model calls, tool execution, or agent state. Those can be supplied by future adapters while the execution core remains deterministic and testable.
