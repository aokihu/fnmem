# Roadmap

The project proceeds by experiments. Neither agent benefit nor DSL viability is assumed.

## Existing prototype

- [x] Text and memory-reference emissions
- [x] FIFO activation and working-memory buffer
- [x] Execution/depth/visit limits
- [x] Runtime-owned context budget with random `__` name, immutable snapshots and host ceilings
- [x] In-memory store, basic trace and example

The handwritten TypeScript callback ABI remains available to hosts. Authors now use the independent DSL and JavaScript compiler. WASM is a possible later backend.

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

- [x] Parser and static validation
- [x] Compile to Node.js-compatible JavaScript artifacts
- [x] Load compiled memories instead of author-supplied callbacks
- [x] Semantic conformance, cycle and fan-out tests
- [x] Enable the DSL experimental condition

All 109 frozen cases execute against compiled artifacts. Artifact file/JSON round trips, immutable snapshots and failure commits are tested. The DSL smoke check records 48 scripted trials and 32 correct fixed-query samples; live model benefit and query construction remain untested.

## 4 — Observable Memory Runs

### Implemented input prerequisite

- [x] Versioned likelihood word catalog with six weights and two nonnumeric states
- [x] Shared English/Chinese criteria and fixed output identifiers
- [x] Strict host validation, immutable judgments and endpoint verification
- [x] Compiled DSL routing and a correctness-checked fixed fixture matrix

See [LIKELIHOOD.md](./LIKELIHOOD.md). Live multilingual model judgments and probability calibration remain untested.

### Run records

- [x] Unique Run ID per recall
- [x] Source hashes, compiler/runtime versions, inputs and limits
- [x] Invocation identities, directed activation edges, emissions, metrics and partial failure traces
- [x] Persist completed/failed records without rewriting them
- [x] Replay deterministic DSL execution

[Memory Runs](./MEMORY_RUNS.md) now execute verified DSL artifacts, save terminal records in an insert-only local file store and replay saved source/inputs/ceilings into a new Run. `npm run example:runs` demonstrates recall/read/replay and partial failure. Independent-process reads, concurrent insert collisions and corruption checks are tested. MCP now exposes these saved Runs; live model experiments remain later work.

## 5 — Minimal MCP service

- [x] Recall executes and returns `fnmem://run/{id}`
- [x] Read stored Run resources without executing again
- [x] Read definitions at `fnmem://memory/{id}`
- [x] Verify the complete call/URI/read path
- [x] Default stdio mode; explicit `--mode http` for shared access
- [x] Verify concurrent independent recalls and cross-agent Run reads

See [MCP.md](./MCP.md). Real SDK clients exercise child-process stdio and Streamable HTTP, including both protocol eras. Definitions and the Run store are shared; input, budget and Run identity are per recall. The next requested stage is memory formation.

## 6 — Memory formation

- [ ] Immutable Observation records retaining facts and provenance
- [ ] Evidence-linked memory candidates and explicit formation decision criteria
- [ ] Content/function selection, duplication, conflict and revision handling
- [ ] Validate and compile candidate DSL before storing a definition revision
- [ ] Formation Run records linking sources, judgments, decisions and revisions
- [ ] Verify formation and subsequent recall without assuming improved memory

## 7 — Formal comparison and decision

- [ ] Fixed live model adapter, configuration and repetitions
- [ ] Matched source knowledge, initial selection and budgets
- [ ] Text vs compiled DSL, plus no-memory calibration
- [ ] Fixed-query and model-generated-query tests across model families and capability levels; 100% correct recall consistency target
- [ ] Publish per-trial records, effect sizes, intervals and category results
- [ ] Decide whether to continue, revise or stop expansion

Graph optimization, parallel agents, advanced retrieval/storage adapters and WASM are later investments contingent on evidence. See [EVALUATION.md](./EVALUATION.md) and [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md).
