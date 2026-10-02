# Development plan

The first deliverable is an observable experiment comparing text memories with an independently specified, compiled memory language. Original estimated effort was four to six weeks for one developer; the newly requested formation stage is not yet estimated. Formal model runtime and inference costs are tracked separately.

A second acceptance goal is **100% correct recall consistency across LLMs**, including different capability levels. Measure both identical canonical queries and queries generated from the same task evidence. Completion after recall can differ by agent; the stored memory result should be independent of caller model identity. Consistency also requires correct expected results, so identical wrong or empty outputs do not qualify.

| Order | Effort | Deliverable | Acceptance criterion |
| --- | --- | --- | --- |
| 1. Evaluation foundations | 3–4 days | Task format, baseline, benefit/consistency scorers and reports | Success, failure, repeats and timeouts score correctly. Incomplete comparisons cannot pass; agreeing on incorrect results fails correctness. |
| 2. DSL specification | 3–4 days | Grammar, types, canonical queries and deterministic semantics | Representative chains and branches have defined results independent of caller model identity, including invalid programs. |
| 3. Compiler/runtime | 5–7 days | Compile DSL into Node.js-compatible artifacts | DSL is the authoring entry point. Conformance and activation-budget tests pass. |
| 4. Memory Runs | 4–5 days | Versioned, persistent records with unique IDs | Completed and failed records retain inputs, results and partial traces. Fixed deterministic DSL executions replay correctly. |
| 5. MCP | 2–3 days | Recall tool and read-only resources over stdio/HTTP | Execute, return URI and read saved results. Default stdio; HTTP agents share definitions and Runs while calls remain independent. |
| 6. Memory formation | To be estimated | Observation, candidates, formation decisions, definition revisions and Formation Runs | Retain original evidence, validate candidate DSL and record every accepted/rejected revision before subsequent recall. |
| 7. Formal evaluation | 3–5 days plus model runtime | Text-vs-DSL benefit and cross-model consistency experiments | Publish benefit uncertainty and the complete cross-model query/result matrix, including weaker-model errors. |
| 8. Decision | 1–2 days | Continue/revise/stop conclusion | Explain whether memory improves, how much, where, and at what cost. |

Stage one is implemented in `evaluation/` and `scripts/evaluate.mjs`. Synthetic smoke checks demonstrate scoring correctness, not improved agent memory. A formal corpus and live model adapter remain pending. The callback ABI remains available for compatibility; authored memories now use compiled DSL.

Stage two is specified in [DSL.md](./DSL.md), [dsl-v0.ebnf](./dsl-v0.ebnf) and `dsl/fixtures.json`. The fixtures define successful outputs, rejected sources and failed recalls with partial traces. `npm run dsl:check` verifies specification artifacts and frozen data; it does not parse or execute the language. Stage three is implemented in `src/dsl/`: parser, static checker, JavaScript artifacts and verified loading. `npm run dsl:test` executes all 109 fixtures; `npm run eval:dsl-smoke` connects the DSL condition and checks fixed-query results.

Stage four is implemented in `src/runs.ts` and `src/stores/file-runs.ts`: unique IDs, insert-only completed/failed records, invocation/activation details, versioned evidence and deterministic replay using saved DSL artifacts and host ceilings. Independent-process reading and partial-failure replay are tested. See [MEMORY_RUNS.md](./MEMORY_RUNS.md).

Stage five is implemented in `src/mcp/`: one recall tool, saved Run resources and definition resources over default stdio or explicit Streamable HTTP. Real client tests cover both CLI modes, protocol eras, concurrency, shared reads and shutdown. See [MCP.md](./MCP.md). The next requested stage is the creation workflow: Observation → Candidate → formation decisions → validated definition revision → Formation Run. Its formation-specific judgment criteria must be defined before reusing likelihood choices; pattern applicability is not automatically a judgment of memory value.

The [likelihood-v1](./LIKELIHOOD.md) prerequisite defines and implements the agreed judgment boundary: six canonical word choices at 0.2 intervals, distinct `unknown`/`undetermined` states, shared English/Chinese descriptions, strict response validation and host verification of endpoint labels. A compiled example consumes the identifier and vocabulary version without changing DSL grammar. Memory Runs can retain these versioned judgments, supplied facts and host verification evidence. Live model judgment correctness and multilingual agreement remain experimental work.

The first language covers structured context and invocation input, read-only working memory, comparisons, boolean combinations, `when`/`if`, Rust-inspired `match`, text emissions and memory references. Match uses ordered first-match routing with literal alternatives, guards and exhaustive branches; independent conditions can produce multiple results. Syntax and type errors are rejected before execution. Arbitrary embedded code and external side effects are outside this subset. Validate the JavaScript compilation target before adding another backend.

```text
DSL source -> parse/check -> compiled JavaScript artifact
           -> MemoryRuntime -> Memory Run -> MCP Resource
```

Definition IDs and Run IDs have different lifetimes. Resource reads return definitions or stored execution facts. First implement synchronous recall: execute, persist the completed/failed Run, then return its URI. Asynchronous jobs and additional resource subtrees require a demonstrated need.

Keep source knowledge and initial selection matched across experimental conditions. Fix the primary endpoint and investment threshold before formal runs. Traces explain behavior; task outcomes determine whether it improved. See [EVALUATION.md](./EVALUATION.md) for formulas and boundaries.
