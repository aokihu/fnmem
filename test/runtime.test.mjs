import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryStore,
  InvalidRecallRequestError,
  MemoryBudgetExceededError,
  MemoryRuntime,
} from "../dist/src/index.js";

test("buffers text while following emitted memory calls", async () => {
  const entry = {
    id: "entry",
    execute: () => [
      { type: "text", content: "entry observation" },
      { type: "memory", ref: "linked-a" },
      { type: "memory", ref: "linked-b" },
    ],
  };

  const linkedA = {
    id: "linked-a",
    execute: () => [{ type: "text", content: "A" }],
  };

  const linkedB = {
    id: "linked-b",
    execute: ({ workingMemory }) => [
      {
        type: "text",
        content: `B saw ${workingMemory.length} buffered messages`,
      },
    ],
  };

  const runtime = new MemoryRuntime(new InMemoryStore([entry, linkedA, linkedB]));
  const result = await runtime.recall({ entrypoints: ["entry"] });

  assert.deepEqual(
    result.messages.map((message) => message.content),
    ["entry observation", "A", "B saw 2 buffered messages"],
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

test("each recall owns an unpredictable immutable context budget across fan-out and cycles", async () => {
  const snapshots = [];
  const request = { entrypoints: ["loop"], context: { topic: "test" }, limits: { maxExecutions: 3 } };
  const loop = {
    id: "loop",
    execute({ context }) {
      const keys = Object.getOwnPropertyNames(context).filter((key) => key.startsWith("__"));
      assert.equal(keys.length, 1);
      const key = keys[0];
      assert.match(key, /^__[0-9a-f]{32}$/);
      assert.equal(Object.isFrozen(context), true);
      assert.throws(() => { context[key] = 999; }, TypeError);
      assert.deepEqual(Object.keys(context), ["topic"]);
      assert.equal(JSON.stringify(context), '{"topic":"test"}');
      snapshots.push({ key, remaining: context[key] });
      request.limits.maxExecutions = 999;
      return [{ type: "memory", ref: "loop" }, { type: "memory", ref: "loop" }];
    },
  };
  const runtime = new MemoryRuntime(new InMemoryStore([loop]));
  await assert.rejects(runtime.recall(request), MemoryBudgetExceededError);
  assert.deepEqual(snapshots.map((item) => item.remaining), [2, 1, 0]);
  assert.equal(new Set(snapshots.map((item) => item.key)).size, 1);
  assert.deepEqual(request.context, { topic: "test" });
  const firstKey = snapshots[0].key;
  snapshots.length = 0;
  request.limits.maxExecutions = 3;
  await assert.rejects(runtime.recall(request), MemoryBudgetExceededError);
  assert.deepEqual(snapshots.map((item) => item.remaining), [2, 1, 0]);
  assert.notEqual(snapshots[0].key, firstKey);
});

test("reserved context and invocation fields are rejected before entrypoints execute", async () => {
  let executions = 0;
  const entry = { id: "entry", execute() { executions++; return []; } };
  const runtime = new MemoryRuntime(new InMemoryStore([entry]));
  for (const name of ["__budget", "__unexpected", "__"]) {
    await assert.rejects(runtime.recall({ entrypoints: ["entry"], context: { [name]: 999 } }), InvalidRecallRequestError);
    await assert.rejects(runtime.recall({ entrypoints: ["entry", { ref: "entry", input: { [name]: 999 } }] }), InvalidRecallRequestError);
  }
  assert.equal(executions, 0);
  const trigger = { id: "trigger", execute: () => [{ type: "memory", ref: "entry", input: { __budget: 999 } }] };
  await assert.rejects(new MemoryRuntime(new InMemoryStore([trigger, entry])).recall({ entrypoints: ["trigger"] }), InvalidRecallRequestError);
  assert.equal(executions, 0);
});

test("invalid or caller-raised budgets cannot bypass configured ceilings", async () => {
  const runtime = new MemoryRuntime(new InMemoryStore());
  for (const value of [Infinity, NaN, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 33, undefined]) {
    await assert.rejects(runtime.recall({ entrypoints: [], limits: { maxExecutions: value } }), InvalidRecallRequestError);
  }
  for (const limits of [{ maxDepth: 9 }, { maxVisitsPerMemory: 5 }]) {
    await assert.rejects(runtime.recall({ entrypoints: [], limits }), InvalidRecallRequestError);
  }
  const loop = { id: "loop", execute: () => [{ type: "memory", ref: "loop" }] };
  const capped = new MemoryRuntime(new InMemoryStore([loop]), { maxExecutions: 2 });
  await assert.rejects(capped.recall({ entrypoints: ["loop"] }), MemoryBudgetExceededError);
  await assert.rejects(capped.recall({ entrypoints: ["loop"], limits: { maxExecutions: 3 } }), InvalidRecallRequestError);
  assert.throws(() => new MemoryRuntime(new InMemoryStore(), { maxDepth: Infinity }), InvalidRecallRequestError);
});
