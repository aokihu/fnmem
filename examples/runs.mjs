import { readFile } from "node:fs/promises";
import {
  compileMemorySource, FileMemoryRunStore, MemoryRunService,
  LIKELIHOOD_VERSION, parseLikelihoodJudgment,
} from "../dist/src/index.js";

const source = await readFile(new URL("./likelihood.fnm", import.meta.url), "utf8");
const artifact = await compileMemorySource(source);
const directory = "evaluation-results/memory-runs";
const service = new MemoryRunService(new FileMemoryRunStore(directory));
const judgment = parseLikelihoodJudgment({ likelihood: "very_likely" }, { version: LIKELIHOOD_VERSION });
const reference = await service.recall(artifact, {
  entrypoints: [{ ref: "pattern-route", input: {
    likelihoodVersion: judgment.version, likelihood: judgment.likelihood,
  } }],
}, [{ judgment, facts: { repeatedFailures: 3, strategyUnchanged: true } }]);
console.log(JSON.stringify({ recall: reference }));

// Reading from a new service/store requires no recall or model call.
const restarted = new MemoryRunService(new FileMemoryRunStore(directory));
const saved = await restarted.read(reference.id);
console.log(JSON.stringify({ status: saved.status, messages: saved.result.messages, graph: saved.observation, judgments: saved.judgments, metrics: saved.metrics }));
console.log(JSON.stringify({ replay: await restarted.replay(reference.id) }));

const loop = await compileMemorySource(`language fnmem "0";
memory "loop" { emit text "Committed before the limit."; emit memory "loop"; }`);
const failure = await service.recall(loop, { entrypoints: ["loop"], limits: { maxExecutions: 2 } });
const failed = await service.read(failure.id);
console.log(JSON.stringify({ failedRun: failure, status: failed.status, error: failed.error, partial: failed.result, graph: failed.observation }));
console.log(`Saved in ${directory}. Scripted evidence only; no LLM or memory-benefit measurement.`);
