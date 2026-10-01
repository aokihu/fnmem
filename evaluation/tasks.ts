import type { Suite } from "./types.js";

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
}

function strings(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${path}: expected an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${path}: duplicate IDs`);
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}: expected nonempty text`);
}

export function parseSuite(value: unknown): Suite {
  object(value, "suite");
  text(value.version, "suite.version");
  if (value.split !== "development" && value.split !== "holdout") throw new Error("suite.split: invalid split");
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("suite.tasks: expected tasks");
  const taskIds = new Set<string>();
  for (const item of value.tasks) {
    object(item, "task");
    text(item.id, "task.id");
    if (taskIds.has(item.id)) throw new Error(`Duplicate task '${item.id}'`);
    taskIds.add(item.id);
    const path = item.id;
    if (!["repeated-failure", "transfer", "irrelevant-memory", "conflict"].includes(String(item.category))) {
      throw new Error(`${path}: unknown category`);
    }
    text(item.prompt, `${path}.prompt`);
    object(item.context, `${path}.context`);
    const ids: Record<string, Set<string>> = {};
    for (const key of ["actions", "memories"]) {
      const list = item[key];
      if (!Array.isArray(list) || list.length === 0) throw new Error(`${path}.${key}: expected a nonempty array`);
      const unique = new Set<string>();
      for (const entry of list) {
        object(entry, `${path}.${key}`);
        text(entry.id, `${path}.${key}.id`);
        text(entry[key === "actions" ? "description" : "text"], `${path}.${key}.text`);
        if (unique.has(entry.id)) throw new Error(`${path}.${key}: duplicate '${entry.id}'`);
        unique.add(entry.id);
      }
      ids[key] = unique;
    }
    strings(item.selectedMemories, `${path}.selectedMemories`);
    strings(item.priorFailures, `${path}.priorFailures`);
    if (item.selectedMemories.length === 0) throw new Error(`${path}: no selected memories`);
    for (const id of item.selectedMemories) {
      if (!ids.memories?.has(id)) throw new Error(`${path}: unknown memory '${id}'`);
    }
    object(item.environment, `${path}.environment`);
    const env = item.environment;
    text(env.initial, `${path}.initial`);
    strings(env.goals, `${path}.goals`);
    if (env.goals.length === 0 || env.goals.includes(env.initial)) throw new Error(`${path}: invalid goals`);
    object(env.states, `${path}.states`);
    if (!Object.hasOwn(env.states, env.initial)) throw new Error(`${path}: missing initial state`);
    for (const goal of env.goals) {
      if (!Object.hasOwn(env.states, goal)) throw new Error(`${path}: missing goal '${goal}'`);
    }
    for (const [state, transitions] of Object.entries(env.states)) {
      object(transitions, `${path}.${state}`);
      if (env.goals.includes(state)) {
        if (Object.keys(transitions).length !== 0) throw new Error(`${path}: goal must be terminal`);
        continue;
      }
      if (Object.keys(transitions).length !== ids.actions?.size) throw new Error(`${path}.${state}: missing actions`);
      for (const [action, rule] of Object.entries(transitions)) {
        if (!ids.actions?.has(action)) throw new Error(`${path}: unknown action '${action}'`);
        object(rule, `${path}.${state}.${action}`);
        text(rule.observation, `${path}.${state}.${action}.observation`);
        text(rule.next, `${path}.${state}.${action}.next`);
        if (!Object.hasOwn(env.states, rule.next)) throw new Error(`${path}: missing next state '${rule.next}'`);
        if (typeof rule.effective !== "boolean") throw new Error(`${path}: expected effective flag`);
        if (!rule.effective && rule.next !== state) throw new Error(`${path}: ineffective action must preserve state`);
      }
    }
    const initial = env.states[env.initial];
    object(initial, `${path}.initial`);
    for (const action of item.priorFailures) {
      const rule = initial[action];
      object(rule, `${path}.priorFailures`);
      if (rule.effective !== false) throw new Error(`${path}: prior failure '${action}' is not ineffective`);
    }
    const reachable = new Set([env.initial]);
    const queue = [env.initial];
    for (const state of queue) {
      const rules = env.states[state];
      object(rules, `${path}.${state}`);
      for (const rule of Object.values(rules)) {
        object(rule, `${path}.${state}`);
        const next = String(rule.next);
        if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
      }
    }
    if (!env.goals.some((goal) => reachable.has(goal))) throw new Error(`${path}: no reachable goal`);
  }
  return value as unknown as Suite;
}
