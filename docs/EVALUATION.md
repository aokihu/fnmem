# Evaluation protocol — pilot-1

fnmem is an experiment. The primary question is whether memories written in an independent DSL, compiled and executed by fnmem, improve task outcomes compared with equivalent memories injected as text. DSL feasibility and agent benefit are separate hypotheses.

This revision delivers a task environment, text baseline, trial runner and scorer. The DSL condition is reserved and the runner rejects it until a compiler exists. Scripted fixtures validate the harness; they are not evidence of memory effectiveness.

## Conditions and fairness

| Condition | Memory supplied to the agent |
| --- | --- |
| `none` | Empty memory; calibration only. |
| `text` | Selected experiences, including their conditions and strategies, rendered in stable selection order as `[id]` followed by text. |
| `dsl` | Working-memory output of DSL programs compiled and executed by fnmem; added in the compiler stage. |

The main comparison is `dsl - text`. `text - none` checks whether the task set responds to memory at all. Handwritten JavaScript callbacks are not the functional-memory experimental condition.

Keep source experiences, initial selected memory IDs, public task state, agent prompt revision, provider/model configuration, action budget and memory-token budget identical across conditions. Every strategy encoded in DSL must have an equivalent expression in the passive baseline. Graph calls cannot introduce additional knowledge available only to the DSL group. Record all activated memories when the run layer is implemented.

The agent supplies one action ID per turn. It receives public task information, memory text and observations, including evidence of prior failures. It does not receive environment transitions, goal states, effectiveness flags or expected trajectories. Prepare public structured context once and reuse it across conditions; do not give one condition a stronger semantic extractor.

Start each trial with a fresh agent session and environment. Run every planned task/repetition/condition. In formal model experiments, alternate or randomize condition order and record it. The fixture runner uses fixed order because it performs no inference.

## Tasks and frozen data

`evaluation/data/development.json` contains eight synthetic tasks, two each for repeated-failure recovery, transfer, irrelevant-memory interference and conflicts. `development-trajectories.json` contains independently specified success and failure sequences for harness checks.

`holdout.json` reserves eight synthetic variants. They are template-related pilot tasks, not an independent real-world generalization benchmark. No golden trajectories are included for them. Smoke checks use development tasks only. Do not tune DSL rules using reserved outcomes. SHA-256 hashes in `manifest.json` pin the exact data revision. Changing prompts, memories, transitions or scoring requires a new documented revision before publishing another experiment.

Public fields are `id`, `prompt`, `context` and `actions`; selected memory definitions supply the condition's memory input. Private judging data includes the initial state, terminal goal states and transition table. Ineffective actions preserve state. Completion means reaching a goal within the budget, not the agent claiming success.

These fixtures validate measurement and provide language-development examples. Before formal benefit claims, add independent scenario families with source-separated development/test splits, freeze the corpus and estimate the sample size for the selected minimum useful effect. Repeating eight templates does not create more independent tasks.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Completion rate | Goal-reaching trials divided by all planned, recorded trials in a condition. Invalid actions, provider errors, timeouts and budget exhaustion are failures. Missing trials make comparisons incomplete. |
| Repeated ineffective actions | Actions already disproved by an observation in the same environment state. The first failed attempt is not a repeat unless disproved before the trial. A state change allows a new attempt to be evaluated independently. |
| Mean repeated-action rate | Per trial: repeated ineffective actions divided by actions taken, or zero if no actions. Average trials equally and always inspect completion and errors alongside this rate: crashing cannot be considered improved behavior. |
| Action reduction | On task/repetition pairs where both conditions succeed: `1 - candidate mean actions / baseline mean actions`. Report the number of pairs and all-trial action counts to expose selection effects. |
| Tokens | Actual provider input/output usage and model-tokenizer memory counts. Unknown usage is `null`, never zero. Error trials may consume unmeasured tokens, so their usage is unknown. |
| Latency | End-to-end trial duration, including attempted turns. Memory and resource-reading overhead will be recorded separately by the run layer. |

The runner also bounds memory by JavaScript string length, without silent truncation. Model runs require `Agent.countMemoryTokens` and enforce the shared token budget. The fixture adapter has no tokenizer; its text-memory tokens and provider usage are unknown. Token averages remain unavailable if any contributing trial has unknown usage.

The scorer reconstructs state from action IDs and checks observations, completion status, baseline text and budgets. Provider errors stay in the denominator. Malformed records are rejected, never silently dropped.

## Cross-model recall consistency

A second project goal is that the memory query yields the same correct result across LLMs, including less capable models. This is a **100% consistency requirement**, evaluated independently of task completion: different agents may act differently after receiving identical memory.

Use two complementary experiments, with a preregistered matrix covering different capability levels and model families:

1. **Fixed-query test:** give every model/session the identical canonical query, memory snapshot, compiler/runtime versions and execution limits. Compare the stored recall payload before the model interprets it. The memory service's resolution and DSL execution must not depend on caller model identity. Identical inputs must also produce identical results across repeated runs.
2. **Model-generated-query test:** give each model identical task evidence and intent, let it produce a query through the same schema/adapter, and compare against a frozen correct canonical query and result. Record invalid query construction as a failed sample. This tests the full path rather than assuming weaker models will construct correct queries.

The runtime should obtain observed facts from the host and define defaults in the query schema. Keep interpretation inside the memory service deterministic for the first DSL. Free-form model-dependent rewriting, model-specific truncation and model decisions inside recall would threaten this goal. Model tokenizers may affect downstream prompt packaging; they must not change the stored memory result. Agent model identity belongs in Run metadata, outside the canonical query.

| Metric | Definition and target |
| --- | --- |
| Query agreement | Fraction of complete case/repetition groups in which all planned models submit identical canonical queries. Target 100%. |
| Result agreement | Fraction of complete case/repetition groups in which every planned model completes recall with the same ordered emissions. Any failed recall makes its group disagree. Target 100%. |
| Expected-query match | Correct canonical queries divided by all planned samples. Target 100%; models can agree on an incorrect query. |
| Expected-result match | Successfully returned payloads matching the case's correct result divided by all planned samples. Target 100%; constant empty/wrong results cannot pass by agreeing. |
| Coverage and errors | Report every planned model/case/repetition, missing samples and failures. An incomplete matrix suppresses overall rates and cannot pass. |

The correct queries and results are defined by the test cases before runs, not by another LLM. Compare JSON structurally: ignore object key insertion order, preserve array/emission order, duplicates, text, sources and deterministic metadata. Compare result payloads separately from Run IDs, timestamps, latency and token counts, which naturally differ. Also inspect dynamic activation paths when Memory Run trace recording becomes available.

`evaluation/consistency.ts` implements these scores without relaxing the single-model benefit report's configuration checks. A `ConsistencyPlan` specifies model identities (including provider/model/adapter revisions), repetitions, memory revisions, canonical queries and expected messages. Canonical queries explicitly include context, each entrypoint's input and execution limits. Each `RecallSample` records the actual query, returned messages or failure. The CLI pins the exact plan content with SHA-256.

```bash
npm run eval:consistency -- --plan PLAN.json --records SAMPLES.jsonl --out NEW_DIRECTORY
```

Failed checks still produce an inspectable report and exit unsuccessfully. Fixture plans are marked `harness-check-only`; scorer self-tests do not show that real models or the not-yet-implemented DSL satisfy the requirement. Live adapters, canonical query construction and the real cross-model matrix remain later implementation and evaluation work. Run text and DSL consistency experiments separately, then compare them alongside within-model benefit reports. Keep golden outputs correct and diverse, including valid empty results and near-neighbor queries requiring different results.

## Pairing and uncertainty

Pair by dataset hash, task ID, repetition and experiment configuration. Reject duplicate cells or changed model, prompt/adapter revision, temperature or budgets. Suppress paired comparisons whenever a planned cell is missing.

Report completion and repeated-action-rate differences in **percentage points**, with a 95% paired bootstrap interval. Average repetition differences within each task, then resample tasks 2,000 times, retaining paired conditions. The deterministic bootstrap seed is 1729. Tasks, rather than repetitions, are the sampling unit. Pilot intervals are diagnostic and do not establish generalization.

Show completion by category, invalid actions and provider errors. Publish per-trial records with aggregate reports. Freeze data, experiment configuration, scorer revision and primary endpoint before formal runs. Rescoring saved records reproduces scores; it does not reproduce stochastic model responses.

## Proposed decision rules

Default primary endpoint: completion rate. A minimum useful improvement is **5 percentage points**, with the paired 95% interval excluding zero. This is a provisional project investment threshold, not an established property of memory systems.

An efficiency experiment may instead be registered before running: target at least **20% fewer actions on jointly successful pairs**, while completion is noninferior within **2 percentage points**. This requires a success-difference interval above -2 points and an interval supporting action reduction. The pilot report currently provides only the action-reduction point estimate; its uncertainty and sample-size checks must be added before an efficiency claim. Do not choose the more favorable endpoint after seeing results.

Report uncertain evidence as inconclusive and preserve regressions or category-specific findings. Compiler correctness alone does not satisfy a benefit rule.

## Running the stage-one harness

```bash
npm install
npm test
npm run eval:smoke
npm run eval:score -- --records evaluation-results/<smoke-directory>/trials.jsonl
```

Smoke creates a new directory with `trials.jsonl` and `report.json`, without overwriting earlier experiments. It runs 32 scripted trials with identical schedules in `none` and `text`. Expected completion is 50% in both conditions, and the paired completion difference is zero. No model is called; no DSL memory executes.

Use `--out NEW_DIRECTORY` to select output. Scoring accepts `--split development|holdout` and verifies data hashes. An incomplete experiment saves a report for inspection, suppresses paired comparisons and exits unsuccessfully.

`runTrial` accepts a provider-independent `Agent` adapter. `createReport` independently scores stored trials. These helpers live outside the published runtime API. A live model adapter and compiled DSL memory preparation remain subsequent stages.
