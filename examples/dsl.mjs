import { readFile } from "node:fs/promises";
import { compileMemorySource, loadMemoryArtifact, MemoryRuntime } from "../dist/src/index.js";

const source = await readFile(new URL("../dsl/examples/branches.fnm", import.meta.url), "utf8");
const artifact = await compileMemorySource(source);
const memories = await loadMemoryArtifact(artifact);
const result = await new MemoryRuntime(memories).recall({
  entrypoints: ["route"],
  context: { error: "timeout", hasProxy: true },
});

console.log(result.messages.map((message) => `[${message.source}] ${message.content}`).join("\n"));
console.log("\nTrace:", result.trace);
console.log("\nSource:", artifact.sourceHash);
