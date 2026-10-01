# fnmem DSL v0

Status: specification for stage three, `fnmem-dsl-0`, draft revision `runtime-budget-1`. Sources use `.fnm` and begin with `language fnmem "0";`. This pre-compiler revision includes `when`, Rust-inspired `match`, the `if` alias and a runtime-owned context budget. The grammar is [dsl-v0.ebnf](./dsl-v0.ebnf). No parser or compiler implements this specification yet. Conformance expectations are reviewed examples, not measured language execution or evidence of agent benefit.

## Minimal program

```text
language fnmem "0";

memory "detect-stuck" {
  context { failureCount: number; }
  input { topic: string = "current task"; }

  when context.failureCount >= 3 {
    emit text "Repeated failures in " + input.topic + ".";
    emit memory "rethink" with { topic: input.topic };
  }
}

memory "rethink" {
  input { topic: string; }
  when workingMemory.hasSource("detect-stuck") {
    emit text "Try a structurally different strategy for " + input.topic + ".";
  }
}
```

`context` belongs to the recall; `input` belongs to each invocation. `emit memory` schedules another memory; it does not call an LLM or perform the suggested task. Two entrypoints may supply different inputs while sharing the same recall context.

All memory definitions are peer nodes. `emit memory` creates a directed activation edge; chain and graph traversal express their relationships. An entrypoint only selects a starting node for a query. A node may be activated from multiple nodes or participate in cycles, without acquiring a permanent level or ownership relationship.

## Source and declarations

- A bundle is one UTF-8 source file with one language header and at least one memory. All definitions and references are resolved inside this bundle. Stage three need not implement imports or multi-file linking.
- IDs are nonempty JSON string literals, unique after decoding. They are opaque, case-sensitive strings: `rethink` and `fnmem://memory/rethink` are distinct. An ID resembling a URI never triggers network access. The later MCP adapter must map resource URIs explicitly.
- Each memory has at most one `context` block followed by at most one `input` block, both before statements. Missing blocks are empty schemas. Field names are ASCII identifiers, unique within their block; keywords are reserved. The two blocks may use the same field name.
- Names beginning with `__` are reserved for the runtime. Authors cannot declare or access them in context/input, or use them as named call arguments (`E_RESERVED`). Memory IDs and text strings are unaffected.
- Fields have exactly one of `string`, `number`, `boolean`. A literal default must have that exact type. There are no nullable, optional, array or object fields in v0. Omission is allowed only for a field with an explicit default.
- `//` comments end at the next newline or end of file. Whitespace is insignificant outside strings. Strings use JSON escapes, disallow raw control characters and unpaired UTF-16 surrogates. Numeric literals use JSON number syntax and must decode to finite IEEE-754 binary64 values; negative zero becomes zero. Strings receive no Unicode normalization or trimming.
- Source order is authoritative. There are no assignments, local variables, user functions, loops, imports or embedded JavaScript. A memory may contain no statements and emit nothing.

## Expressions and static types

| Expression | Type and rule |
| --- | --- |
| String / number / `true` / `false` | Exact literal type; `null` is not a DSL literal |
| `context.field`, `input.field` | Declared field type; undeclared access is a compile error |
| `execution.depth`, `execution.count` | Number; activation hops from this invocation's entrypoint (0 at entry), and 1-based execution count across recall; not a hierarchy of memory definitions |
| `workingMemory.count` | Number of text emissions committed before this invocation |
| `workingMemory.hasSource("id")` | Boolean; exact source equality; ID must be defined in the bundle |
| `a + b` | String concatenation; both operands must be strings; no implicit conversion |
| `a == b`, `a != b` | Both operands have the same primitive type; exact value comparison |
| `a < b`, `a <= b`, `a > b`, `a >= b` | Both operands are numbers |
| `not a`, `a and b`, `a or b` | Boolean operands; `and` / `or` short-circuit left to right |

Precedence from low to high: `or`, `and`, equality, ordering, `+`, `not`, primary expressions. Concatenation is left-associative. Chained equality/ordering operators are not allowed at the same level; use `a < b and b < c`. Parentheses override precedence. All branches and both operands of boolean operators are type checked even when unreachable.

## Conditions: `when` and `if`

`when condition { ... }` is the preferred spelling. `if condition { ... }` has exactly the same semantics and compiles to the same conditional operation. Parentheses around the condition are optional for both, so existing `if (condition)` sources remain valid. Conditions must be boolean; bodies must be braced blocks.

`else` is optional and accepts a block or another `when`/`if`, including mixed chains:

```text
when context.failureCount >= 3 {
  emit text "Change strategy.";
} else if context.failureCount == 2 {
  emit text "Recheck the current hypothesis.";
} else {
  emit text "Continue observing.";
}
```

Only the first true branch in a chain executes. Separate `when`/`if` statements are independent; all true conditions can emit results. This is how to express multiple applicable memories in one function.

## Value matching: `match`

`match expression` evaluates a primitive value once and checks its arms in source order. The first matching pattern with a true guard executes its block; execution then continues after the `match`. No fall-through or execution of all matching arms occurs. `match` is a statement in v0 and does not return a value.

```text
match context.error {
  "timeout" | "connection-reset" when context.hasProxy => {
    emit text "Inspect the proxy connection settings.";
  },
  "timeout" => {
    emit text "Inspect the connection timeout.";
  },
  "access-denied" => {
    emit memory "inspect-permissions";
  },
  _ => {
    emit text "Collect more evidence.";
  },
}
```

This fragment assumes `error: string`, `hasProxy: boolean` and a declared `inspect-permissions` memory without required input. Arm blocks support the same text emissions, memory emissions, nested conditions and nested matches as a memory body.

- Patterns are literals of the subject's exact type, alternatives joined by `|`, or the standalone wildcard `_`. Matching uses the existing exact equality semantics. A wildcard cannot be mixed with alternatives. There are no bindings, destructuring, ranges, regular expressions or semantic text matching in this revision.
- A guard follows the pattern using `when expression` or Rust-style `if expression`; both require a boolean and are equivalent. Guards run only after the pattern matches. They read the same immutable inputs and working-memory snapshot as other conditions.
- Commas separate arms; a final comma is optional. Every arm body requires braces. At least one arm is required.
- Matches must be exhaustive. String and number subjects require a final unguarded `_` arm. Boolean subjects may instead cover both `true` and `false` with unguarded literal patterns. Guarded arms never contribute to guaranteed coverage. An explicit empty `_ => {}` permits intentional silence.
- An unguarded wildcard must be last. A literal already covered by an earlier unguarded literal arm cannot appear later, even with a guard. After both boolean values are covered by unguarded literal patterns, any further arm is unreachable, including a wildcard. Repeated literals inside one alternative pattern are duplicate errors. Overlap after a guarded arm is allowed: a false guard lets subsequent arms try the value.
- Pattern/subject type mismatches use `E_TYPE`; duplicates within one pattern use `E_DUPLICATE`; non-exhaustive matches and unreachable arms use `E_MATCH`. Unsupported pattern structures use `E_SYNTAX`. These checks apply even in an inactive outer condition.

For several boolean conditions, use `match true { _ when condition => { ... }, _ => { ... } }` to choose the first applicable strategy. Use separate `when` statements when every applicable condition should produce an output. `match` routes by explicit values and conditions; it does not interpret the meaning of natural-language strings.

## Emissions

`emit text expression;` requires a string and produces `{type:"text", content, source: currentMemoryId}`. Empty and duplicate strings are retained. Authors cannot override `source` or emit metadata in v0.

`emit memory "id" with { field: expression, ... };` requires a literal, declared target ID. Each named argument must exist in the target input schema and match its type. Duplicate arguments and missing required arguments are compile errors. A missing `with` is an empty argument object; defaulted fields may be omitted. Arguments evaluate immediately from the caller's inputs and become a new immutable object. No context or input forwarding is implicit. Calls and cycles are allowed; budgets bound their execution.

## Input validation and canonical queries

The evaluation contract already defines `RecallQuery` in `evaluation/consistency.ts`:

```json
{
  "context": { "failureCount": 3 },
  "entrypoints": [{ "ref": "detect-stuck", "input": {} }],
  "limits": { "maxExecutions": 32, "maxDepth": 8, "maxVisitsPerMemory": 4 }
}
```

1. Accept finite JSON trees only. Context and input are objects, not arrays or null. Reject duplicate keys at the raw JSON boundary, nonfinite numbers, unpaired surrogates and non-JSON host values; do not coerce strings into numbers or booleans. Normalize negative zero to zero.
2. Canonical queries have exactly these three top-level keys. Entrypoints have exactly `ref` and `input`; limits have exactly the three limit keys. References are nonempty strings. Entrypoint order and duplicates are retained; an empty list is valid and returns an empty completed result.
3. Limits must be safe integers: `maxExecutions` and `maxVisitsPerMemory` >= 1, `maxDepth` >= 0. The trusted runtime owner configures ceilings, defaulting to 32/8/4. Query limits cannot exceed those ceilings (`E_QUERY`); a caller can only lower them. A host convenience adapter may fill omissions from configured ceilings and convert string entrypoints to `{ref,input:{}}`. It must record the resulting explicit query before execution. The conformance input is always explicit; fix host ceilings as part of runtime configuration for replay/comparison.
4. Reject caller-supplied top-level context or input keys beginning with `__` (`E_QUERY`), including inputs supplied along activation edges. Before execution, resolve all entrypoints and validate their schemas in list order. Missing required fields, wrong types and unknown input keys fail. Unknown **non-reserved context** fields are preserved in the canonical query but invisible unless declared by the executing memory. This permits the existing task context to be shared by memories with different field schemas.
5. Defaults fill a private invocation view; they do not add fields to the recorded query. Explicit null never selects a default. Every invoked memory validates its own context schema; inactive memories do not require their fields. Context validation for a newly activated node happens when its invocation is dequeued. Argument schemas on activation edges are already checked by the compiler.
6. Canonical comparison sorts object keys by UTF-16 code units, recursively, with JSON string/number encoding. Array order, exact text and sources remain significant. Omitted and explicit default values remain different queries, even if their results happen to agree. The host must retain raw model query output separately when generating queries; it must not repair a wrong reference or fill required evidence from the golden answer.

Model identity, provider, wall-clock time and random state are not language inputs or built-ins. Additional context fields cannot affect execution unless explicitly declared and read. For experiments, fix the source snapshot, compiler/runtime versions, query and limits; exclude caller identity from the declared task schemas. In model-generated-query experiments, compare canonical queries as well as correct results. Identical execution given identical valid inputs is a semantic guarantee; an LLM producing the right query is still an empirical question.

The current consistency scorer covers structural JSON comparison, explicit limits and reserved-field rejection. The prototype runtime implements ceilings, reserved-field rejection and internal budget injection. Full JSON boundary and DSL schema validation remain stage-three work.

## Runtime-owned context budget

Every executed invocation must receive an internal context field named `__` followed by a cryptographically random 32-hex-character suffix, generated once per recall. For example, `__8d5a…` is illustrative, never a fixed name or a caller-provided value. Its numeric value is the **remaining total execution budget after admitting this invocation**. A query limited to three executions produces snapshots containing 2, 1, then 0; a further queued call fails with `E_MAX_EXECUTIONS`.

- Runtime injection is mandatory even if the source declares no context schema. External queries contain only public fields; callers neither provide this field nor need to know its name.
- All activated nodes share one total budget. Following an activation edge does not create or reset it. Each invocation receives a fresh immutable context view with the same private key and the updated remaining value. Earlier views retain their original snapshot value.
- The field is non-enumerable, non-writable and non-configurable. It is excluded from JSON projection, DSL field lookup, canonical queries and successful result payloads. Compiler field projection preserves the internal runtime view without exposing the field to source expressions.
- The runtime's private execution counter and configured ceilings are authoritative. Check limits before scheduling the next execution regardless of conditions/emissions in the memory. Random naming prevents guessing; field immutability, namespace rejection and runtime checks prevent budget modification/reset. Prefixing a known name alone would not provide unpredictability.
- Random keys are execution metadata and never branch inputs. They are excluded from consistency comparison and semantic replay; a replay generates its own private key while deriving the same remaining values from the recorded limits. Trusted diagnostics may record remaining counts without exposing the key.

This bounds memory-chain activation. It does not interrupt a single arbitrary JavaScript callback that never returns; DSL v0 has no authored loops or external callbacks, and its actual compiled conformance is still pending.

## Deterministic execution

1. Snapshot the compiled bundle and canonical query for the whole recall. Definition replacement cannot affect a recall already started. Start with no messages and no visits; initialize the FIFO queue from the ordered entrypoints at depth 0.
2. When the queue is nonempty, check in this order: total execution limit, dequeue, depth limit, visit limit, reference existence, invocation field validation. Exceeding a limit means `>` for depth/visits and `>=` before the next execution for total count. Limits never silently truncate output.
3. An invocation that passes these checks sees the next 1-based execution count, the runtime-owned context budget snapshot and a read-only snapshot of text messages committed before it started. Public context values and invocation input are immutable. Emissions made by the same invocation are not visible through `workingMemory` during that invocation.
4. Evaluate statements and collect emissions locally. Commit the whole invocation only on success: increment its visit counter and execution count, append its trace entry, then process emissions in order. Text is appended to working memory; activations are appended to the queue at the current invocation's hop count + 1. No deduplication by graph position occurs. A subsequently executed node sees all text from earlier completed invocations, including the invocation that activated it, even if the reference was emitted before a later text statement in that invocation.
5. When the queue is empty, return `messages`, `trace`, `executed`. Each trace entry uses the current prototype shape `{memory, depth, emissions}`; `emissions` counts both output kinds. These entries describe successful committed invocations. Invocation identities and directed activation-edge records are deferred to Memory Runs.
6. Any error fails the recall. Retain previously committed messages/trace/count as diagnostic partial data; publish no emissions from the failing invocation and stop processing the queue. Partial data must never be counted as completed recall or substituted for the expected successful result. Stage four persists it in failed Runs.

For example, entrypoints A and B activate C and D respectively: execution is A, B, C, D, then any subsequently activated nodes. A cycle without text still consumes execution and visit budgets. A duplicate entrypoint executes twice if budgets allow. No priority, hidden ranking, parallel execution or global conflict resolver is introduced.

This preserves the prototype's FIFO/emission behavior. Its context budget views and ceilings are already implemented. Stage three must add complete input/schema validation, definition/input/working-memory snapshots and diagnostic failure data; the prototype still allows arbitrary callbacks, resolves a mutable store during execution, increments count before callback completion and throws without exposing partial data.

## Diagnostics

Diagnostics have a stable `code`, human-readable `message` and location. Compile errors use 1-based line/column (UTF-16 code units, CRLF treated as one newline), plus offending memory/field when available. Boundary errors use JSON paths. Runtime errors identify the queued reference and depth. If several static errors exist, fail without publishing an artifact; sort diagnostics by source offset then code. A conformance fixture expects its named error among diagnostics, not arbitrary message wording or an exclusive first error.

| Code | Phase | Cause |
| --- | --- | --- |
| `E_SYNTAX` | Compile | Invalid token/structure, escape, unsupported language version or construct |
| `E_DUPLICATE` | Compile | Repeated memory ID, field, block or argument name |
| `E_FIELD` | Compile | Undeclared field or unknown built-in |
| `E_TYPE` | Compile | Wrong default, operand, condition, argument or text type |
| `E_REFERENCE` | Compile | Unknown/nonliteral target or unknown `hasSource` ID |
| `E_ARGUMENT` | Compile | Unknown argument or missing required target input |
| `E_RESERVED` | Compile | Declaring/accessing a `__` field or supplying a reserved named argument |
| `E_MATCH` | Compile | Non-exhaustive match or unreachable arm |
| `E_QUERY` | Boundary | Invalid canonical shape, JSON or limits |
| `E_INPUT` | Preflight/runtime | Missing/wrong field, unknown invocation input key |
| `E_MEMORY_NOT_FOUND` | Preflight/runtime | Undefined entrypoint/queued reference |
| `E_MAX_EXECUTIONS` | Runtime | Next invocation exceeds total count |
| `E_MAX_DEPTH` | Runtime | Queued depth exceeds limit |
| `E_MAX_VISITS` | Runtime | Next visit exceeds per-ID count |

The parser cannot generally recover every error; reporting the named isolated fixture error is sufficient. Compiler bugs and artifact/version failures are host failures, never empty successful recalls. Stage three can map these codes onto existing error classes while preserving the typed cause.

## Stage-three acceptance fixtures

[dsl/fixtures.json](../dsl/fixtures.json) contains:

- Eight development task queries, using their current contexts and selected memory order. [development.fnm](../dsl/examples/development.fnm) is a manually authored translation of public experience text. It contains no judge states, transitions or held-out answers. The task golden messages are expected recall output, not task-success labels.
- [semantics.fnm](../dsl/examples/semantics.fnm) covering input defaults/forwarding, branches, boolean precedence, multiple entrypoints/outputs, working-memory snapshots, execution metadata, duplicate visits, cycles and limit boundaries.
- [branches.fnm](../dsl/examples/branches.fnm) covering `when`/`if` chains, independent conditions, literal/alternative patterns, guards, exhaustive booleans and first-match routing. The `if.fnm`/`when.fnm` sources have identical IDs, queries and expected outputs to specify alias equivalence.
- Invalid source files with expected compile diagnostics, and invalid queries with expected preflight/runtime errors and diagnostic partial traces.

`npm run dsl:check` checks the artifact inventory, development-query correspondence, trace/result shapes, phase/code consistency and unchanged frozen evaluation hashes. It does **not** parse or execute DSL. Stage three must replace this boundary with actual parse/check/compile/recall conformance against every fixture, including exact ordered text and trace equality. Add a separate compiled-artifact round trip to show handwritten callbacks are no longer the authoring entry point.

Before formal benefit evaluation, audit the translated knowledge against the text baseline: guards/defaults, omission of inactive facts, helper definitions and current-context text can change what the agent receives. Both conditions must retain the same source knowledge and initial selection. These small draft examples do not certify experimental fairness or justify a memory improvement claim.

The first backend emits JavaScript compatible with the existing Node.js package. Parsing, static validation and emission from checked nodes must precede artifact loading; source text is never interpolated as JavaScript code. Pin `fnmem-dsl-0`, source SHA-256 and compiler/runtime versions in the artifact. Implementation format and bundling are stage-three decisions. WASM, arithmetic, nullable/nested data and additional working-memory searches require a demonstrated need and a new specification version.
