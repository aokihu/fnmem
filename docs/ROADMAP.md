# Roadmap

The project proceeds by experiments. Neither agent benefit nor DSL viability is assumed.

## Existing prototype

- [x] Text and memory-reference emissions
- [x] FIFO activation and working-memory buffer
- [x] Execution/depth/visit limits
- [x] Runtime-owned context budget with random `__` name, immutable snapshots and host ceilings
- [x] In-memory store, basic trace and example

The handwritten TypeScript callback ABI is a prototype. The intended authoring interface is an independent DSL compiled into Node.js-compatible artifacts. JavaScript is the first target; WASM is a possible later backend.

## 1 — Evaluation foundations

- [x] Conditions and metric formulas
- [x] Synthetic development tasks and reserved pilot variants
- [x] Data versioning with SHA-256 manifest
- [x] Provider-independent runner and text baseline
- [x] Environment scorer, paired reports and scripted smoke check
- [x] Cross-model query/result consistency scorer with correctness and coverage checks
- [ ] Independent real-world corpus and formal sample-size estimate, before benefit claims

## 2 — DSL specification

- [x] Independent syntax and formal grammar
- [x] Context, invocation input and read-only working memory
- [x] Comparisons, `when`/`if` conditions, Rust-inspired `match` and multiple emissions
- [x] Field types, missing values, references, ordering and errors
- [x] Canonical queries and deterministic outputs independent of caller model identity
- [x] Valid/invalid examples and expected execution traces

These checks mean the contracts and expectations are specified, not that a compiler has executed them. See [DSL.md](./DSL.md) and `dsl/fixtures.json`; run `npm run dsl:check` to validate the artifact inventory.

## 3 — Compiler and runtime

- [ ] Parser and static validation
- [ ] Compile to Node.js-compatible JavaScript artifacts
- [ ] Load compiled memories instead of author-supplied callbacks
- [ ] Semantic conformance, cycle and fan-out tests
- [ ] Enable the DSL experimental condition

## 4 — Observable Memory Runs

- [ ] Unique Run ID per recall
- [ ] Source hashes, compiler/runtime versions, inputs and limits
- [ ] Invocation identities, directed activation edges, emissions, metrics and partial failure traces
- [ ] Persist completed/failed records without rewriting them
- [ ] Replay deterministic DSL execution

## 5 — Minimal MCP service

- [ ] Recall executes and returns `fnmem://run/{id}`
- [ ] Read stored Run resources without executing again
- [ ] Read definitions at `fnmem://memory/{id}`
- [ ] Verify the complete call/URI/read path

## 6 — Formal comparison and decision

- [ ] Fixed live model adapter, configuration and repetitions
- [ ] Matched source knowledge, initial selection and budgets
- [ ] Text vs compiled DSL, plus no-memory calibration
- [ ] Fixed-query and model-generated-query tests across model families and capability levels; 100% correct recall consistency target
- [ ] Publish per-trial records, effect sizes, intervals and category results
- [ ] Decide whether to continue, revise or stop expansion

Automatic learning, graph optimization, parallel agents, advanced retrieval/storage adapters and WASM are later investments contingent on evidence. See [EVALUATION.md](./EVALUATION.md) and [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md).
