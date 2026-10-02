import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  LIKELIHOOD_VERSION, LIKELIHOOD_CATALOG, LIKELIHOOD_VALUE_SCHEMA,
  LIKELIHOOD_RESPONSE_SCHEMA, getLikelihoodPrompt, parseLikelihoodJudgment,
  compileMemorySource, loadMemoryArtifact, MemoryRuntime, MemoryInputError,
} from "../dist/src/index.js";
import { createConsistencyReport } from "../dist/evaluation/consistency.js";

const version = LIKELIHOOD_VERSION;
const expected = [
  ["ruled_out", 0], ["very_unlikely", 0.2], ["unlikely", 0.4],
  ["likely", 0.6], ["very_likely", 0.8], ["confirmed", 1],
  ["unknown", null], ["undetermined", null],
];
const parse = (likelihood, verified) => parseLikelihoodJudgment(JSON.stringify({ likelihood }), {
  version, ...(verified ? { verified } : {}),
});

test("six weights and two nonnumeric states survive JSON storage without locale-dependent values", () => {
  for (const [id, weight] of expected) {
    const judgment = parse(id, id === "confirmed" || id === "ruled_out" ? id : undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(judgment)), { version, likelihood: id, weight });
    assert(Object.isFrozen(judgment));
    assert.equal(Object.is(judgment.weight, -0), false);
  }
  assert.notEqual(parse("unknown").likelihood, parse("undetermined").likelihood);
  assert.equal(parse("unknown").weight, null);
  assert.equal(parse("undetermined").weight, null);
  assert(Object.isFrozen(LIKELIHOOD_CATALOG.options[0].criteria));
  assert.throws(() => { LIKELIHOOD_CATALOG.options[0].weight = 0.5; }, TypeError);
});

test("judgment boundary rejects numbers, localized words, aliases, duplicate keys and caller-provided weights", () => {
  for (const likelihood of [0.8, null, "很可能", "Likely", "LIKELY", "likely ", "__proto__", "possible", true]) {
    assert.throws(() => parse(likelihood), (error) => error instanceof MemoryInputError && error.code === "E_INPUT");
  }
  const getter = { get likelihood() { throw new Error("getter must not execute"); } };
  for (const response of [
    {}, { likelihood: "likely", weight: 0.6 }, { likelihood: "likely", verified: "confirmed" },
    { likelihood: "likely", version }, { likelihood: "likely", extra: undefined },
    getter, ["likely"], '{"likelihood":"likely","likelihood":"unknown"}',
    '{"likelihood":"likely","\\u006cikelihood":"unknown"}',
    '{"likelihood":"\\uD800"}', '{"likelihood":"likely",}',
  ]) {
    assert.throws(() => parseLikelihoodJudgment(response, { version }), MemoryInputError);
  }
  assert.throws(() => parseLikelihoodJudgment({ likelihood: "likely" }, { version: "likelihood-v2" }), /version/);
});

test("endpoint labels require matching host verification outside the model response", () => {
  for (const id of ["confirmed", "ruled_out"]) {
    assert.throws(() => parse(id), /host verification/);
    assert.throws(() => parse(id, id === "confirmed" ? "ruled_out" : "confirmed"), /host verification/);
    assert.equal(parse(id, id).likelihood, id);
  }
  assert.throws(() => parse("likely", "very_likely"), /Invalid host verification/);
});

test("Chinese and English prompts share the exact schema and version while excluding numeric response instructions", () => {
  assert.deepEqual(LIKELIHOOD_VALUE_SCHEMA.enum, expected.map(([id]) => id));
  assert.deepEqual(LIKELIHOOD_RESPONSE_SCHEMA.required, ["likelihood"]);
  assert.equal(LIKELIHOOD_RESPONSE_SCHEMA.additionalProperties, false);
  for (const language of ["en", "zh"]) {
    const prompt = getLikelihoodPrompt(language);
    assert(prompt.includes(version));
    assert(prompt.includes('{"likelihood":"likely"}'));
    assert(!prompt.includes("0.8"));
    for (const option of LIKELIHOOD_CATALOG.options) {
      assert(prompt.includes(`- ${option.id} (${option.label[language]}): ${option.criteria[language]}`));
    }
  }
  assert.equal(getLikelihoodPrompt(), getLikelihoodPrompt("en"));
  assert.throws(() => getLikelihoodPrompt("fr"), /language/);
});

test("validated word choices route compiled DSL and produce a complete correctness-checked fixture matrix", async () => {
  const source = await readFile(new URL("../examples/likelihood.fnm", import.meta.url), "utf8");
  const artifact = await compileMemorySource(source);
  const runtime = new MemoryRuntime(await loadMemoryArtifact(artifact));
  const messages = [
    ["This pattern does not apply."],
    ["Strong evidence opposes this pattern."],
    ["Evidence slightly opposes this pattern."],
    ["Consider this pattern and verify it."],
    ["This pattern is supported.", "Recheck the assumptions before repeating the same strategy."],
    ["This pattern is supported.", "Recheck the assumptions before repeating the same strategy."],
    ["Collect the missing necessary facts."],
    ["Compare the supporting and opposing evidence."],
  ];
  const memory = { snapshotHash: artifact.sourceHash, compilerVersion: artifact.compilerVersion, runtimeVersion: artifact.runtimeVersion };
  const cases = expected.map(([id], index) => ({
    id,
    query: {
      context: {}, entrypoints: [{ ref: "pattern-route", input: { likelihoodVersion: version, likelihood: id } }],
      limits: { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 },
    },
    expectedMessages: messages[index].map((content, position) => ({ type: "text", content, source: position ? "recheck-assumptions" : "pattern-route" })),
  }));
  const plan = { version: "likelihood-fixture-1", mode: "fixture", condition: "dsl", inputMode: "fixed", models: ["fixture-en", "fixture-zh"], repetitions: 2, memory, cases };
  const records = [];
  for (const item of cases) {
    for (let repetition = 0; repetition < plan.repetitions; repetition++) {
      for (const model of plan.models) {
        const judgment = parse(item.id, ["confirmed", "ruled_out"].includes(item.id) ? item.id : undefined);
        const query = structuredClone(item.query);
        query.entrypoints[0].input = { likelihoodVersion: judgment.version, likelihood: judgment.likelihood };
        const result = await runtime.recall(query);
        assert.deepEqual(result.messages, item.expectedMessages);
        assert.equal(result.executed, item.id === "very_likely" || item.id === "confirmed" ? 2 : 1);
        records.push({ id: `${item.id}-${model}-${repetition}`, case: item.id, model, repetition, memory, query, status: "completed", messages: result.messages });
      }
    }
  }
  const report = createConsistencyReport(plan, records);
  assert.equal(report.evidence, "harness-check-only");
  assert.equal(report.passed, true);
  assert.equal(report.expectedResultMatchRate, 1);
  const incorrect = structuredClone(records);
  incorrect[0].query.entrypoints[0].input.likelihoodVersion = "likelihood-v2";
  assert.equal(createConsistencyReport(plan, incorrect).passed, false);
});
