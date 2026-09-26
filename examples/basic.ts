import {
  InMemoryStore,
  MemoryRuntime,
  type MemoryFunction,
} from "../src/index.js";

const detectStuck: MemoryFunction = {
  id: "detect-stuck",
  description: "Activates recovery memories after repeated failures.",
  execute({ context }) {
    const failures = Number(context.failures ?? 0);

    if (failures < 3) {
      return [{ type: "text", content: "The current approach is still viable." }];
    }

    return [
      {
        type: "text",
        content: "The current approach has failed repeatedly.",
      },
      { type: "memory", ref: "rethink-strategy" },
      { type: "memory", ref: "recall-previous-success" },
    ];
  },
};

const rethinkStrategy: MemoryFunction = {
  id: "rethink-strategy",
  execute() {
    return [
      {
        type: "text",
        content: "Pause the current path and generate a structurally different approach.",
      },
    ];
  },
};

const recallPreviousSuccess: MemoryFunction = {
  id: "recall-previous-success",
  execute({ context }) {
    const previous = String(context.previousSuccess ?? "No prior success recorded.");
    return [{ type: "text", content: `Previous successful pattern: ${previous}` }];
  },
};

const store = new InMemoryStore([
  detectStuck,
  rethinkStrategy,
  recallPreviousSuccess,
]);

const runtime = new MemoryRuntime(store);

const result = await runtime.recall({
  entrypoints: ["detect-stuck"],
  context: {
    failures: 3,
    previousSuccess: "Reduce the problem and validate assumptions independently.",
  },
});

console.log(result.messages.map((message) => message.content).join("\n"));
console.log("\nTrace:", result.trace);
