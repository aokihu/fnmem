import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryStore,
  MemoryBudgetExceededError,
  MemoryRuntime,
} from "../dist/src/index.js";

test("buffers text while following emitted memory calls", async () => {
  const root = {
    id: "root",
    execute: () => [
      { type: "text", content: "root observation" },
      { type: "memory", ref: "child-a" },
      { type: "memory", ref: "child-b" },
    ],
  };

  const childA = {
    id: "child-a",
    execute: () => [{ type: "text", content: "A" }],
  };

  const childB = {
    id: "child-b",
    execute: ({ workingMemory }) => [
      {
        type: "text",
        content: `B saw ${workingMemory.length} buffered messages`,
      },
    ],
  };

  const runtime = new MemoryRuntime(new InMemoryStore([root, childA, childB]));
  const result = await runtime.recall({ entrypoints: ["root"] });

  assert.deepEqual(
    result.messages.map((message) => message.content),
    ["root observation", "A", "B saw 2 buffered messages"],
  );
  assert.equal(result.executed, 3);
});

test("guards recursive memory execution", async () => {
  const loop = {
    id: "loop",
    execute: () => [{ type: "memory", ref: "loop" }],
  };

  const runtime = new MemoryRuntime(new InMemoryStore([loop]));

  await assert.rejects(
    runtime.recall({
      entrypoints: ["loop"],
      limits: { maxVisitsPerMemory: 2 },
    }),
    MemoryBudgetExceededError,
  );
});
