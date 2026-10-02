import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runTrial } from "../dist/evaluation/benchmark.js";
import { createReport } from "../dist/evaluation/report.js";
import { parseSuite } from "../dist/evaluation/tasks.js";
import { createConsistencyReport } from "../dist/evaluation/consistency.js";
import { compileMemorySource, loadMemoryArtifact, MemoryRuntime } from "../dist/src/index.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const [command, ...args] = process.argv.slice(2);
const usage = "Usage: evaluate.mjs smoke|dsl-smoke [--out DIR] | score --records FILE [--split development|holdout] [--out DIR] | consistency --plan FILE --records FILE [--out DIR]";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--out", "--records", "--split", "--plan"].includes(key) || !value || value.startsWith("--") || key in options) {
      throw new Error(usage);
    }
    options[key] = value;
  }
  return options;
}

async function readRecords(file) {
  const content = await readFile(resolve(file), "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON at record line ${index + 1}`); }
  });
}

async function loadSuite(split) {
  if (split !== "development" && split !== "holdout") throw new Error("Unknown dataset split");
  const data = new URL(`../evaluation/data/${split}.json`, import.meta.url);
  const content = await readFile(data, "utf8");
  const manifest = JSON.parse(await readFile(new URL("../evaluation/data/manifest.json", import.meta.url), "utf8"));
  const suiteHash = hash(content);
  if (manifest.files[`${split}.json`] !== suiteHash) throw new Error("Frozen dataset changed; create a new dataset revision before running");
  const suite = parseSuite(JSON.parse(content));
  if (suite.version !== manifest.version || suite.split !== split) throw new Error("Dataset metadata mismatch");
  return { suite, suiteHash };
}

async function saveReport(directory, report, trials) {
  const output = resolve(directory);
  await mkdir(resolve(output, ".."), { recursive: true });
  await mkdir(output); // A new experiment must not overwrite an earlier one.
  if (trials) await writeFile(resolve(output, "trials.jsonl"), trials.map((trial) => JSON.stringify(trial)).join("\n") + "\n");
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return output;
}

async function main() {
  const options = parseArguments(args);
  if (command === "smoke" || command === "dsl-smoke") {
    if (options["--plan"] || options["--records"] || (options["--split"] && options["--split"] !== "development")) {
      throw new Error("Smoke checks use development fixtures only");
    }
    const { suite, suiteHash } = await loadSuite("development");
    const fixtureSource = await readFile(new URL("../evaluation/data/development-trajectories.json", import.meta.url), "utf8");
    const trajectories = JSON.parse(fixtureSource);
    let dsl;
    if (command === "dsl-smoke") {
      const source = await readFile(new URL("../dsl/examples/development.fnm", import.meta.url), "utf8");
      dsl = await loadMemoryArtifact(await compileMemorySource(source));
    }
    const configuration = {
      mode: "fixture", conditions: dsl ? ["none", "text", "dsl"] : ["none", "text"], repetitions: 2,
      agent: { provider: "local-fixture", model: "scripted-actions", revision: hash(fixtureSource), temperature: 0 },
      limits: { maxActions: 4, maxMemoryCharacters: 4000, maxMemoryTokens: 1024, timeoutMs: 1000 },
    };
    const trials = [];
    for (const task of suite.tasks) {
      for (let repetition = 0; repetition < configuration.repetitions; repetition += 1) {
        for (const condition of configuration.conditions) {
          const schedule = trajectories[task.id]?.[repetition === 0 ? "success" : "failure"];
          if (!schedule) throw new Error(`Missing fixture for '${task.id}'`);
          let index = 0;
          trials.push(await runTrial({
            task, suiteHash, id: randomUUID(), repetition, condition, configuration,
            agent: { async act() { return { action: schedule[index++] }; } },
            ...(dsl ? { dsl } : {}),
          }));
        }
      }
    }
    const report = createReport(suite, suiteHash, trials);
    const directory = options["--out"] ?? `evaluation-results/smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const output = await saveReport(directory, report, trials);
    if (dsl) {
      const fixtures = JSON.parse(await readFile(new URL("../dsl/fixtures.json", import.meta.url), "utf8"));
      const plan = {
        version: "dsl-development-1", mode: "fixture", condition: "dsl", inputMode: "fixed",
        models: ["fixture-caller-a", "fixture-caller-b"], repetitions: 2,
        memory: { snapshotHash: dsl.artifact.sourceHash, compilerVersion: dsl.artifact.compilerVersion, runtimeVersion: dsl.artifact.runtimeVersion },
        cases: fixtures.cases.filter((item) => item.task).map((item) => ({ id: item.task, query: item.query, expectedMessages: item.expected.messages })),
      };
      const recalls = [];
      for (const item of plan.cases) {
        for (let repetition = 0; repetition < plan.repetitions; repetition++) {
          for (const model of plan.models) {
            const result = await new MemoryRuntime(dsl).recall(item.query);
            recalls.push({ id: randomUUID(), case: item.id, model, repetition, memory: plan.memory, query: item.query, status: "completed", messages: result.messages });
          }
        }
      }
      const planSource = JSON.stringify(plan, null, 2) + "\n";
      const consistency = { ...createConsistencyReport(plan, recalls), planHash: hash(planSource) };
      await writeFile(resolve(output, "artifact.json"), JSON.stringify(dsl.artifact, null, 2) + "\n");
      await writeFile(resolve(output, "consistency-plan.json"), planSource);
      await writeFile(resolve(output, "recalls.jsonl"), recalls.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
      await writeFile(resolve(output, "consistency.json"), JSON.stringify(consistency, null, 2) + "\n");
      console.log(`Compiled recall check: ${recalls.length} fixture samples; correct agreement ${consistency.expectedResultMatchRate * 100}%.`);
      if (!consistency.passed) throw new Error("Compiled development recall did not match the fixed expected results");
    }
    console.log(`Harness check only: ${trials.length} scripted trials, ${suite.tasks.length} development tasks.`);
    console.log(`Identical scripted actions are used for all conditions. No model was called; this is not evidence of memory improvement.`);
    console.log(`Records and report: ${output}`);
    if (!report.complete) throw new Error("Smoke experiment is incomplete");
    return;
  }
  if (command === "score" && options["--records"]) {
    if (options["--plan"]) throw new Error(usage);
    const { suite, suiteHash } = await loadSuite(options["--split"] ?? "development");
    const trials = await readRecords(options["--records"]);
    const report = createReport(suite, suiteHash, trials);
    if (options["--out"]) console.log(`Report: ${await saveReport(options["--out"], report)}`);
    else console.log(JSON.stringify(report, null, 2));
    if (!report.complete) throw new Error(`Incomplete experiment: ${report.missing.length} planned trials missing; no paired comparison produced`);
    return;
  }
  if (command === "consistency" && options["--plan"] && options["--records"] && !options["--split"]) {
    const source = await readFile(resolve(options["--plan"]), "utf8");
    const report = { ...createConsistencyReport(JSON.parse(source), await readRecords(options["--records"])), planHash: hash(source) };
    if (options["--out"]) console.log(`Report: ${await saveReport(options["--out"], report)}`);
    else console.log(JSON.stringify(report, null, 2));
    if (!report.passed) throw new Error(`Consistency check failed: ${report.missing.length} missing samples, ${report.errors} errors; inspect result/query matches`);
    return;
  }
  throw new Error(usage);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
