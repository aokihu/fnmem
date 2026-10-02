# Versioned word choices — likelihood-v1

The first judgment protocol asks one question: **does this memory pattern apply to the supplied current facts?** It does not estimate task-success probability, memory importance or model confidence. Those need separate definitions and experiments.

Models select a canonical word identifier. The host validates that choice and derives a control weight. These weights are not calibrated probabilities. All language labels share the same version, identifiers, rubric and mapping.

## Vocabulary

| Identifier | English | Chinese | Weight | Criterion |
| --- | --- | --- | --- | --- |
| `ruled_out` | Ruled out | 明确不适用 | 0 | A necessary condition is verified false, or external evidence has disproved applicability. Host verification required. |
| `very_unlikely` | Very unlikely | 很不可能适用 | 0.2 | Evidence strongly opposes applicability, with limited support. |
| `unlikely` | Unlikely | 不太可能适用 | 0.4 | Opposing evidence slightly outweighs supporting evidence. |
| `likely` | Likely | 较有可能适用 | 0.6 | Supporting evidence slightly outweighs opposing evidence. |
| `very_likely` | Very likely | 很可能适用 | 0.8 | Key conditions match and strong evidence supports applicability, with checks still outstanding. |
| `confirmed` | Confirmed applicable | 已确认适用 | 1 | Required applicability conditions have been verified by external facts. Host verification required. |
| `unknown` | Insufficient information | 信息不足 | `null` | A necessary fact is missing. |
| `undetermined` | No clear inclination | 暂无法倾向 | `null` | Necessary facts are available but supporting and opposing evidence is balanced. |

There is no 0.5 tier. Do not force balanced evidence into 0.4 or 0.6. Do not turn either nonnumeric state into zero or a default probability. Confirmed applicability does not imply that using the pattern will succeed.

`LIKELIHOOD_CATALOG`, including translations and criteria, and both response schemas are immutable. A change to identifiers, mapping or rubric semantics requires a new vocabulary version; never silently reinterpret a saved `likelihood-v1` judgment.

## Tool descriptions and model responses

`getLikelihoodPrompt()` returns the fixed English description. It can be used regardless of the user's language. `getLikelihoodPrompt("zh")` provides the Chinese rendering of the same rubric. Keep the prompt language fixed in an experiment unless language is the factor under test. Only `en` and `zh` renderings are implemented; unsupported language codes are rejected.

`LIKELIHOOD_VALUE_SCHEMA` defines the enum for a tool argument. `LIKELIHOOD_RESPONSE_SCHEMA` defines the complete constrained model response:

```json
{ "likelihood": "very_likely" }
```

Models do not output numeric weights, vocabulary versions or host-verification flags. Translated labels, alternative spellings, unknown identifiers and extra fields are errors. There is no automatic synonym conversion. Optional explanations can be given separately in the user's language; they do not control routing.

These are provider-independent descriptions and JSON schemas for a future tool/model adapter. They do not register an MCP tool or make an inference call. A schema constrains output form; it does not guarantee a correct judgment.

## Host validation and version records

```ts
import {
  LIKELIHOOD_VERSION, LIKELIHOOD_RESPONSE_SCHEMA,
  getLikelihoodPrompt, parseLikelihoodJudgment,
} from "fnmem";

const description = getLikelihoodPrompt();
const responseSchema = LIKELIHOOD_RESPONSE_SCHEMA;
// Obtain a response with these constraints from your chosen model adapter.
const response = '{"likelihood":"very_likely"}';
const judgment = parseLikelihoodJudgment(response, {
  version: LIKELIHOOD_VERSION,
});
// { version: "likelihood-v1", likelihood: "very_likely", weight: 0.8 }
```

`parseLikelihoodJudgment` accepts raw JSON or a plain object. It reuses the finite-JSON boundary, rejects duplicate decoded keys and invalid host values, and returns a frozen record. Invalid judgments or vocabulary versions raise `MemoryInputError` (`E_INPUT`); callers should record the failure rather than substitute a low-confidence success.

For `ruled_out` or `confirmed`, the trusted host must additionally pass matching verification:

```ts
const judgment = parseLikelihoodJudgment(response, {
  version: LIKELIHOOD_VERSION,
  verified: "confirmed", // Only after checking the supplied external facts.
});
```

This configuration belongs to host code, outside the model response/tool arguments. Never copy a model claim into `verified`. The helper enforces the separation; the host remains responsible for the factual check and retaining its evidence. A missing or contradictory verification rejects the endpoint label. The helper does not itself discover or verify external facts.

Keep the complete judgment record alongside the facts and verification evidence in a [Memory Run](./MEMORY_RUNS.md) using the service's optional judgment-evidence argument. Replaying a numeric weight requires its vocabulary version as well as the original identifier. Vocabulary versions are explicit inputs to the parser; only `likelihood-v1` is currently supported.

## Compiled DSL integration

DSL v0 already supports string inputs and `match`. Validate a model response first, then pass its identifier and version to the memory invocation:

```ts
const result = await runtime.recall({
  entrypoints: [{
    ref: "pattern-route",
    input: {
      likelihoodVersion: judgment.version,
      likelihood: judgment.likelihood,
    },
  }],
});
```

The runtime's generic string schema does not automatically recognize likelihood fields. Host adapters must call `parseLikelihoodJudgment` before constructing the query. No natural-language judgment or model call occurs inside a compiled memory.

[likelihood.fnm](../examples/likelihood.fnm) shows peer nodes connected by an activation edge. Its example policy activates another pattern for `very_likely` and `confirmed`, distinguishes each lower tier, and produces different guidance for missing and balanced evidence. This routing policy is illustrative, not a measured optimum. Multiple pattern weights should not be multiplied as independent probabilities without a justified composition model.

```sh
npm run example:likelihood
```

This command runs eight scripted responses through host validation and actual DSL compilation/recall, printing the versioned judgments and results. Endpoint verification is supplied by the fixture, not inferred from real observations.

## Evidence and remaining evaluation

`test/likelihood.test.mjs` checks hostile/invalid responses, version identity, endpoint verification, immutable records, schema/prompt consistency and compiled routing. Its consistency matrix contains eight cases, two fixture caller labels and two repetitions: 32 fixed samples compared against independent expected messages with the existing correctness scorer.

These checks demonstrate protocol and routing behavior only. The `fixture-en`/`fixture-zh` labels are not actual LLMs. No probability calibration, language-understanding equivalence or memory benefit has been measured. Live evaluation must separately test label correctness, repeated judgments, paraphrases, languages/model identities, calibrated outcomes, and downstream effects. Comparing languages must hold task facts, evidence, rubric and memory versions fixed.
