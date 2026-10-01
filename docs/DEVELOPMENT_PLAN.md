# Development plan

The first deliverable is an observable experiment comparing text memories with an independently specified, compiled memory language. Estimated effort is four to six weeks for one developer; formal model runtime and inference costs are tracked separately.

A second acceptance goal is **100% correct recall consistency across LLMs**, including different capability levels. Measure both identical canonical queries and queries generated from the same task evidence. Completion after recall can differ by agent; the stored memory result should be independent of caller model identity. Consistency also requires correct expected results, so identical wrong or empty outputs do not qualify.

| Order | Effort | Deliverable | Acceptance criterion |
| --- | --- | --- | --- |
| 1. Evaluation foundations | 3–4 days | Task format, baseline, benefit/consistency scorers and reports | Success, failure, repeats and timeouts score correctly. Incomplete comparisons cannot pass; agreeing on incorrect results fails correctness. |
| 2. DSL specification | 3–4 days | Grammar, types, canonical queries and deterministic semantics | Representative chains and branches have defined results independent of caller model identity, including invalid programs. |
| 3. Compiler/runtime | 5–7 days | Compile DSL into Node.js-compatible artifacts | DSL is the authoring entry point. Conformance and activation-budget tests pass. |
| 4. Memory Runs | 4–5 days | Versioned, persistent records with unique IDs | Completed and failed records retain inputs, results and partial traces. Fixed deterministic DSL executions replay correctly. |
| 5. MCP | 2–3 days | Recall tool and read-only resources | Execute, return URI and read saved results. Reading definitions or Runs does not execute memory. |
| 6. Formal evaluation | 3–5 days plus model runtime | Text-vs-DSL benefit and cross-model consistency experiments | Publish benefit uncertainty and the complete cross-model query/result matrix, including weaker-model errors. |
| 7. Decision | 1–2 days | Continue/revise/stop conclusion | Explain whether memory improves, how much, where, and at what cost. |

Stage one is implemented in `evaluation/` and `scripts/evaluate.mjs`. Synthetic smoke checks demonstrate scoring correctness, not improved agent memory. A formal corpus and live model adapter remain pending. The current callback ABI is a prototype until the compiler stage.

Stage two is specified in [DSL.md](./DSL.md), [dsl-v0.ebnf](./dsl-v0.ebnf) and `dsl/fixtures.json`. The fixtures define successful outputs, rejected sources and failed recalls with partial traces. `npm run dsl:check` verifies specification artifacts and frozen data; it does not parse or execute the language. Stage three is next: implement the parser, static checker and JavaScript backend, then run the same fixtures against compiled artifacts and connect the DSL evaluation condition.

The first language covers structured context and invocation input, read-only working memory, comparisons, boolean combinations, `when`/`if`, Rust-inspired `match`, text emissions and memory references. Match uses ordered first-match routing with literal alternatives, guards and exhaustive branches; independent conditions can produce multiple results. Syntax and type errors are rejected before execution. Arbitrary embedded code and external side effects are outside this subset. Validate the JavaScript compilation target before adding another backend.

```text
DSL source -> parse/check -> compiled JavaScript artifact
           -> MemoryRuntime -> Memory Run -> MCP Resource
```

Definition IDs and Run IDs have different lifetimes. Resource reads return definitions or stored execution facts. First implement synchronous recall: execute, persist the completed/failed Run, then return its URI. Asynchronous jobs and additional resource subtrees require a demonstrated need.

Keep source knowledge and initial selection matched across experimental conditions. Fix the primary endpoint and investment threshold before formal runs. Traces explain behavior; task outcomes determine whether it improved. See [EVALUATION.md](./EVALUATION.md) for formulas and boundaries.
