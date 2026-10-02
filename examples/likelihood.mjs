import { readFile } from "node:fs/promises";
import {
  compileMemorySource, loadMemoryArtifact, MemoryRuntime,
  LIKELIHOOD_VERSION, LIKELIHOOD_CATALOG, parseLikelihoodJudgment,
} from "../dist/src/index.js";

const source = await readFile(new URL("./likelihood.fnm", import.meta.url), "utf8");
const runtime = new MemoryRuntime(await loadMemoryArtifact(await compileMemorySource(source)));

// Scripted responses, not model judgments. Endpoint verification belongs to the host.
for (const option of LIKELIHOOD_CATALOG.options) {
  const verified = ["ruled_out", "confirmed"].includes(option.id) ? option.id : undefined;
  const judgment = parseLikelihoodJudgment({ likelihood: option.id }, {
    version: LIKELIHOOD_VERSION, ...(verified ? { verified } : {}),
  });
  const result = await runtime.recall({
    entrypoints: [{ ref: "pattern-route", input: {
      likelihoodVersion: judgment.version, likelihood: judgment.likelihood,
    } }],
  });
  console.log(JSON.stringify({ judgment, result }));
}
console.log("Fixture check only: no LLM called; no calibration or multilingual model agreement measured.");
