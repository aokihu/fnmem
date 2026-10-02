import { InvalidRecallRequestError, MemoryInputError } from "./errors.js";
import type { MemoryField, MemoryInput, RecallRequest } from "./types.js";

export function validUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// Snapshot finite JSON; host objects/getters must not become hidden inputs.
export function snapshotJson(value: unknown, path = "$", ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && validUnicode(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new InvalidRecallRequestError(`Expected finite JSON at ${path}.`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InvalidRecallRequestError(`Non-JSON object at ${path}.`);
  if (Object.getOwnPropertySymbols(value).length) throw new InvalidRecallRequestError(`Non-JSON keys at ${path}.`);
  ancestors.add(value);
  const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length + (Array.isArray(value) ? 1 : 0)) throw new InvalidRecallRequestError(`Non-JSON properties at ${path}.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !validUnicode(key)) throw new InvalidRecallRequestError(`Invalid JSON field at ${path}.${key}.`);
    Object.defineProperty(result, key, { value: snapshotJson(descriptor.value, `${path}.${key}`, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

export function checkFields(value: unknown, path: string): asserts value is MemoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRecallRequestError(`${path} must be an object.`);
  if (Object.getOwnPropertyNames(value).some((name) => name.startsWith("__"))) throw new InvalidRecallRequestError(`${path} cannot supply reserved '__' fields.`);
}

export function applySchema(fields: MemoryInput, schema: readonly MemoryField[] | undefined, path: string, strict: boolean): MemoryInput {
  if (!schema) return fields;
  const result: Record<string, unknown> = { ...fields };
  if (strict) {
    const allowed = new Set(schema.map((field) => field.name));
    for (const name of Object.keys(fields)) if (!allowed.has(name)) throw new MemoryInputError(`Unknown field ${path}.${name}.`);
  }
  for (const field of schema) {
    const value = Object.hasOwn(fields, field.name) ? fields[field.name] : field.defaultValue;
    if (value === undefined || typeof value !== field.type) throw new MemoryInputError(`Expected ${field.type} at ${path}.${field.name}.`);
    Object.defineProperty(result, field.name, { value, enumerable: true, configurable: true });
  }
  return Object.freeze(result);
}

// Unlike JSON.parse, reject duplicate object keys at the raw JSON boundary.
export function parseJson(text: string): unknown {
  let index = 0;
  const fail = (): never => { throw new InvalidRecallRequestError(`Invalid JSON at offset ${index}.`); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[index] ?? "\0")) index++; };
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === "\\") index++;
      else if (char === '"') {
        try { const value = JSON.parse(text.slice(start, index)); if (validUnicode(value)) return value; } catch {}
        return fail();
      }
    }
    return fail();
  }
  function value(): unknown {
    space();
    const char = text[index];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      const array = char === "[";
      const close = array ? "]" : "}";
      const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
      index++; space();
      if (text[index] === close) { index++; return result; }
      while (index < text.length) {
        let key = String((result as unknown[]).length);
        if (!array) {
          if (text[index] !== '"') return fail();
          key = string(); space();
          if (Object.hasOwn(result, key) || text[index++] !== ":") return fail();
        }
        Object.defineProperty(result, key, { value: value(), enumerable: true, configurable: true });
        space();
        if (text[index] === close) { index++; return result; }
        if (text[index++] !== ",") return fail();
        space();
      }
      return fail();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index))?.[0];
    if (!token) return fail();
    index += token.length;
    return JSON.parse(token);
  }
  const result = value(); space();
  if (index !== text.length) return fail();
  return snapshotJson(result);
}

export function parseRecallQuery(text: string): RecallRequest {
  const query = parseJson(text);
  checkFields(query, "query");
  const keys = (object: MemoryInput, expected: string[]) => {
    if (Object.keys(object).sort().join(",") !== expected.sort().join(",")) throw new InvalidRecallRequestError("Invalid canonical query keys.");
  };
  keys(query, ["context", "entrypoints", "limits"]);
  checkFields(query.context, "context"); checkFields(query.limits, "limits");
  keys(query.limits, ["maxExecutions", "maxDepth", "maxVisitsPerMemory"]);
  for (const [name, limit] of Object.entries(query.limits)) {
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < (name === "maxDepth" ? 0 : 1)) throw new InvalidRecallRequestError(`Invalid ${name}.`);
  }
  if (!Array.isArray(query.entrypoints)) throw new InvalidRecallRequestError("Expected ordered entrypoints.");
  for (const entry of query.entrypoints) {
    checkFields(entry, "entrypoint"); keys(entry, ["ref", "input"]);
    if (typeof entry.ref !== "string" || !entry.ref.length) throw new InvalidRecallRequestError("Expected memory reference.");
    checkFields(entry.input, "input");
  }
  return query as unknown as RecallRequest;
}
