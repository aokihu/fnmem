# DSL specification fixtures

The normative language document is [DSL.md](../docs/DSL.md), with a separate [EBNF grammar](../docs/dsl-v0.ebnf). These sources and expected outputs are frozen stage-two specification artifacts. Stage-three tests now compile and execute them against the JavaScript backend.

```sh
npm run dsl:check
```

This command checks file hashes, fixture structure, development-query coverage and frozen evaluation data. It does not recognize DSL syntax or execute memory functions.

Run `npm run dsl:test` for all 109 actual parse/check/compile/recall conformance cases. Run `npm run example` for the compiled branch example, or `npm run dsl:compile -- dsl/examples/branches.fnm --out evaluation-results/branches.json` to save an artifact.

`fixtures.json` records `schemaVersion`, `specVersion`, source SHA-256 values and cases:

`specRevision` identifies the current draft and `runtimeCeilings` fixes trusted runtime configuration for these cases.

- `phase: compile`: reject the named source with `expected.error.code` among diagnostics. No artifact may be published.
- `phase: recall`: compile the source first, execute the explicit canonical query and compare the ordered `messages`, `trace`, `executed` and status. A failed case additionally requires the named error code and diagnostic partial result. An `E_QUERY` case deliberately violates the boundary schema.
- `task`: connects exactly one case to each public development task. Match its context and initial selection; do not read held-out judge labels to change the language or draft translations.
- `tags`: a coverage inventory for review. Tags do not demonstrate that semantics work.
- `equivalentTo`: the other source case must have the same query and exact expected result. This specifies `when`/`if` alias equivalence for stage-three execution tests.

`examples/development.fnm` translates public experience text; formal experimental knowledge equivalence still needs review. `examples/semantics.fnm` exercises language and runtime rules separately from agent task success. `examples/branches.fnm` covers `when`, chains and Rust-inspired `match`; `if.fnm` and `when.fnm` specify equivalent spellings. `invalid/` isolates compile-time rejection cases, including attempts to use reserved `__` names. Source hashes ensure expectations are reconsidered when examples change. The current draft revision is `runtime-budget-1`.

Fixture queries never contain the random internal budget key. Namespace violations and requests above default runtime ceilings deliberately expect `E_QUERY`. Current runtime tests verify actual injection, per-recall random names, immutable budget snapshots, shared fan-out limits and ceiling enforcement. The same fixtures now pass compiled execution tests, including committed partial data on failures.

`npm run eval:dsl-smoke` executes eight development queries for two fixture caller identities and two repetitions: 32 samples with 100% correct recall consistency. These identities are labels, not live models. Fixture metadata remains `specification-only` because it describes expectations; measured results are stored separately. Model-generated query consistency and agent-benefit evidence require later live experiments.
