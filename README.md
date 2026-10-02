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

Write memories in `.fnm` using the independent DSL:

```text
language fnmem "0";

memory "detect-stuck" {
  context { failures: number = 0; }
  when context.failures >= 3 {
    emit text "Repeated failure detected.";
    emit memory "rethink-strategy";
  } else {
    emit text "Continue the current approach.";
  }
}

memory "rethink-strategy" {
  emit text "Generate a structurally different approach before retrying.";
}
```

Compile and execute from Node.js (where `source` is the file's UTF-8 text):

```ts
import { compileMemorySource, loadMemoryArtifact, MemoryRuntime } from "fnmem";

const artifact = await compileMemorySource(source);
const bundle = await loadMemoryArtifact(artifact);
const result = await new MemoryRuntime(bundle).recall({
  entrypoints: ["detect-stuck"],
  context: { failures: 3 },
});
console.log(result.messages);
```

`npm run example` runs [branches.fnm](./dsl/examples/branches.fnm) through this path. Use `npm run dsl:compile -- dsl/examples/branches.fnm --out evaluation-results/branches.json` to save a compiled artifact. The loader verifies source, generated code and versions before loading it.

## Design principles

1. **Memory and agent runtime stay decoupled.** An agent should call fnmem through a small provider boundary rather than understand fnmem's internal execution graph.
2. **Executable memory is additive.** Retrieval, embeddings and graph stores can select memories; fnmem focuses on what happens when a selected memory executes.
3. **The public ABI stays small.** v0.1 intentionally supports only text emissions and memory-call emissions.
4. **Execution must be bounded.** The runtime includes execution, depth and per-memory visit limits.
   The host configures ceilings; callers may only lower them. A random `__` context field holds the remaining shared budget internally, and caller-supplied `__` fields are rejected. This private field is excluded from normal JSON output and the DSL's readable fields.
5. **Behavior should be inspectable.** Each recall returns an execution trace so memory activation can be tested and debugged.

## Project status

**Experimental / v0.1 development.** The core execution model is implemented and covered by initial tests. APIs may change while the functional-memory model is validated with real agents.

Memory authors now use an independent DSL compiled into Node.js-compatible JavaScript artifacts. The original callback ABI remains available for host compatibility. Evaluation foundations, the compiler, persistent Memory Runs and stdio/HTTP MCP interfaces are implemented. Memory formation comes next. See the [development plan](./docs/DEVELOPMENT_PLAN.md).

The evaluation foundation includes eight synthetic development tasks, eight reserved pilot variants, an environment scorer and paired reports. `npm run eval:smoke` validates the harness using identical scripted actions across conditions; it calls no model and does not demonstrate a memory improvement. See the [evaluation protocol](./docs/EVALUATION.md).

Another experimental goal is 100% correct recall consistency across models: compare both fixed queries and model-generated queries against frozen expected results. `npm run eval:consistency -- --plan PLAN.json --records SAMPLES.jsonl` scores this separately from task completion. Real cross-model results remain pending.

The specification defines the [DSL v0 language](./docs/DSL.md), its [formal grammar](./docs/dsl-v0.ebnf) and [conformance fixtures](./dsl/README.md). The subset supports typed context/input, read-only working memory, `when`/`if`, Rust-inspired `match` and text/memory emissions. `npm run dsl:check` checks the specification inventory; `npm run dsl:test` actually parses, checks, compiles and executes all 109 frozen conformance cases. `npm run eval:dsl-smoke` runs all three evaluation conditions and 32 fixed-query recall samples. These use scripted callers, with no real LLM or benefit claim.

Current scope:

- functional memory ABI
- multiple emissions per memory
- working-memory text buffer
- queued memory activation
- depth, visit and execution budgets
- in-memory store
- execution trace
- independent DSL parser, static checker and JavaScript compiler
- immutable compiled bundles and validated query/schema boundaries
- diagnostic partial results on failure
- insert-only file storage of completed/failed Memory Runs
- invocation identities, activation edges and replay from saved DSL artifacts
- default stdio and shared HTTP MCP recall/resources
- runnable DSL example and conformance tests

The [likelihood input protocol](./docs/LIKELIHOOD.md) adds six word choices at 0.2 intervals, plus separate missing-information and balanced-evidence states. Models return fixed identifiers; the host validates them and records the vocabulary version and control weight. English and Chinese descriptions share one catalog. `npm run example:likelihood` runs the protocol through compiled DSL; it uses scripted responses and does not measure live model calibration.

[Memory Runs](./docs/MEMORY_RUNS.md) save the original artifact, request, host ceilings, graph observations, results and optional judgment evidence. `MemoryRunService.recall()` returns a Run resource reference after saving; `read()` inspects it without execution; `replay()` uses its snapshot and records whether semantic output matches. `npm run example:runs` demonstrates successful and failed records in `evaluation-results/memory-runs/`.

The [MCP interface](./docs/MCP.md) exposes `recall` and read-only definitions/Run resources. Build once, then use either mode:

```sh
npm run build
node dist/src/mcp/cli.js --source examples/likelihood.fnm
node dist/src/mcp/cli.js --mode http --source examples/likelihood.fnm
```

No `--mode` means stdio. HTTP listens at `http://127.0.0.1:3333/mcp` by default; use `--host` for a shared network interface. All connected agents share definitions and persisted Runs, while each query has its own input and budget. The executable is also available as `fnmem-mcp` when the package is installed. Use the compiled CLI directly in agent launch configuration.

Upcoming experimental stages:

- memory formation with retained observations, candidate validation and Formation Runs
- live memory-benefit and cross-model evaluation

Deferred pending evidence:

- vector/semantic retrieval
- remote memory/storage adapters
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
  dsl/                # parser, static checker, JavaScript compiler and artifact loader
  validation.ts       # finite JSON, canonical queries and field schemas
  runtime.ts          # bounded execution queue
  runs.ts             # persistent recall/read/replay service and Run records
  mcp/                # recall/resources, stdio/HTTP transports and CLI
  types.ts            # public functional-memory ABI
  store.ts            # storage interface
  stores/in-memory.ts # minimal reference store
  stores/file-runs.ts # insert-only local Run records
examples/
  dsl.mjs             # compiled .fnm example
  basic.ts            # original callback example
test/
  runtime.test.mjs
  dsl.test.mjs
dsl/
  examples/           # authoring examples
  fixtures.json       # frozen conformance expectations
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
npm run example:likelihood
npm run example:runs
npm run eval:smoke
npm run eval:dsl-smoke
```

## Contributing

fnmem is at an early stage and design feedback is useful, especially around execution semantics, bounded recursion, observability, interoperability with agent runtimes, and reproducible evaluation.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [roadmap](./docs/ROADMAP.md).

## Security

Executable memory introduces a different trust boundary from passive retrieval. Memory functions should be treated as code. See [SECURITY.md](./SECURITY.md) for the current threat model and reporting process.

## License

Apache-2.0.
