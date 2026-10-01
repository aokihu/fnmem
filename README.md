# fnmem

<p align="center">
  <img src="assets/logo.png" width="180" alt="fnmem logo" />
</p>

**Functional Memory Runtime for AI Agents**

> Memory is not only something an agent retrieves. It can also be something an agent executes.

`fnmem` is an experimental TypeScript runtime for **functional memory**: memories that can emit useful context *and* activate other memories. Instead of treating memory only as stored text retrieved by similarity, fnmem explores memory as a small executable unit inside an agent's cognitive loop.

The project is intentionally narrow. It is **not** a vector database, a RAG framework, or a replacement for long-term storage. It focuses on the execution semantics that begin *after* a memory has been selected.

## Why fnmem?

Most agent memory pipelines can be simplified to:

```text
query -> retrieve relevant text -> add text to context -> LLM
```

fnmem experiments with a second model:

```text
context
  |
  v
Memory Function
  |--- text -------> Working Memory
  |--- memory -----> Execution Queue
  |--- memory -----> Execution Queue
                         |
                         v
                    continue evaluation
                         |
                         v
                  final memory context
```

A memory can therefore produce more than one result. Text is buffered while emitted memory references continue to execute. This allows a remembered strategy to activate related strategies without forcing the agent runtime itself to understand the internal memory graph.

## Core model

A memory is a function:

```ts
interface MemoryFunction {
  id: string;

  execute(input: MemoryFunctionInput):
    | readonly MemoryEmission[]
    | Promise<readonly MemoryEmission[]>;
}
```

It currently emits only two primitives:

```ts
type MemoryEmission =
  | { type: "text"; content: string }
  | { type: "memory"; ref: string; input?: Record<string, unknown> };
```

That small ABI is deliberate. Scheduling, recursion guards and the working-memory buffer belong to the runtime rather than individual memories.

## Quick example

```ts
import { InMemoryStore, MemoryRuntime } from "fnmem";

const store = new InMemoryStore([
  {
    id: "detect-stuck",
    execute({ context }) {
      if (Number(context.failures ?? 0) < 3) {
        return [{ type: "text", content: "Continue the current approach." }];
      }

      return [
        { type: "text", content: "Repeated failure detected." },
        { type: "memory", ref: "rethink-strategy" },
      ];
    },
  },
  {
    id: "rethink-strategy",
    execute() {
      return [
        {
          type: "text",
          content: "Generate a structurally different approach before retrying.",
        },
      ];
    },
  },
]);

const memory = new MemoryRuntime(store);

const result = await memory.recall({
  entrypoints: ["detect-stuck"],
  context: { failures: 3 },
});

console.log(result.messages);
```

## Design principles

1. **Memory and agent runtime stay decoupled.** An agent should call fnmem through a small provider boundary rather than understand fnmem's internal execution graph.
2. **Executable memory is additive.** Retrieval, embeddings and graph stores can select memories; fnmem focuses on what happens when a selected memory executes.
3. **The public ABI stays small.** v0.1 intentionally supports only text emissions and memory-call emissions.
4. **Execution must be bounded.** The runtime includes execution, depth and per-memory visit limits.
   The host configures ceilings; callers may only lower them. A random `__` context field holds the remaining shared budget internally, and caller-supplied `__` fields are rejected. This private field is excluded from normal JSON output and the DSL's readable fields.
5. **Behavior should be inspectable.** Each recall returns an execution trace so memory activation can be tested and debugged.

## Project status

**Experimental / v0.1 development.** The core execution model is implemented and covered by initial tests. APIs may change while the functional-memory model is validated with real agents.

The intended memory authoring interface is an independent DSL compiled into Node.js-compatible artifacts. The callbacks above are the current prototype, not the final source format. Development starts with a text-memory comparison harness, followed by the DSL/compiler, observable Memory Runs and a minimal MCP service. See the [development plan](./docs/DEVELOPMENT_PLAN.md).

The evaluation foundation includes eight synthetic development tasks, eight reserved pilot variants, an environment scorer and paired reports. `npm run eval:smoke` validates the harness using identical scripted actions across conditions; it calls no model and does not demonstrate a memory improvement. See the [evaluation protocol](./docs/EVALUATION.md).

Another experimental goal is 100% correct recall consistency across models: compare both fixed queries and model-generated queries against frozen expected results. `npm run eval:consistency -- --plan PLAN.json --records SAMPLES.jsonl` scores this separately from task completion. Real cross-model results remain pending.

Stage two now defines the [DSL v0 language](./docs/DSL.md), its [formal grammar](./docs/dsl-v0.ebnf) and [conformance fixtures](./dsl/README.md). The subset supports typed context/input, read-only working memory, `when`/`if`, Rust-inspired `match` and text/memory emissions. `npm run dsl:check` checks the specification artifacts. Parsing, JavaScript compilation and semantic conformance execution are the next stage; the DSL examples are not runnable yet.

Current scope:

- functional memory ABI
- multiple emissions per memory
- working-memory text buffer
- queued memory activation
- depth, visit and execution budgets
- in-memory store
- execution trace
- runnable example and tests

Upcoming experimental stages:

- DSL parser, static checker and JavaScript compiler
- versioned, observable Memory Runs
- minimal MCP recall tool and read-only resources

Deferred pending evidence:

- vector/semantic retrieval
- persistent storage adapters
- automatic memory learning
- graph databases
- priorities and parallel scheduling
- model-generated memory functions

## Relationship to agent frameworks

fnmem is designed to sit behind a minimal `MemoryProvider` boundary:

```text
Agent / Runtime
      |
      | recall(...)
      v
    fnmem
      |
      +-- select/execute memory functions
      +-- buffer text emissions
      +-- follow memory emissions
      +-- return context + trace
```

The first planned reference integration is **ATOM**, but fnmem is intentionally agent-framework agnostic.

## Repository layout

```text
src/
  runtime.ts          # bounded execution queue
  types.ts            # public functional-memory ABI
  store.ts            # storage interface
  stores/in-memory.ts # minimal reference store
examples/
  basic.ts
test/
  runtime.test.mjs
docs/
  CONCEPTS.md
  ARCHITECTURE.md
  ROADMAP.md
```

## Development

Requirements: Node.js 20+ and TypeScript 5.8+.

```bash
npm install
npm test
npm run example
npm run eval:smoke
```

## Contributing

fnmem is at an early stage and design feedback is useful, especially around execution semantics, bounded recursion, observability, interoperability with agent runtimes, and reproducible evaluation.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [roadmap](./docs/ROADMAP.md).

## Security

Executable memory introduces a different trust boundary from passive retrieval. Memory functions should be treated as code. See [SECURITY.md](./SECURITY.md) for the current threat model and reporting process.

## License

Apache-2.0.
