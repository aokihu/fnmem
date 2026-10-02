import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { compileMemorySource } from "../dist/src/index.js";

const [input, flag, output, ...extra] = process.argv.slice(2);
try {
  if (!input || flag !== "--out" || !output || extra.length) throw new Error("Usage: compile-memory.mjs SOURCE.fnm --out ARTIFACT.json");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(resolve(input)));
  const artifact = await compileMemorySource(source);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  console.log(`Compiled ${input}: ${artifact.sourceHash}\nArtifact: ${resolve(output)}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
