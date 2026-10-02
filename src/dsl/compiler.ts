import type { MemoryField } from "../types.js";
import { diagnostic, MemoryCompileError, parseMemorySource } from "./parser.js";
import type { Definition, Diagnostic, Expression, Statement } from "./parser.js";

export const LANGUAGE_VERSION = "fnmem-dsl-0";
export const SPEC_REVISION = "runtime-budget-1";
export const COMPILER_VERSION = "fnmem-compiler-0.1.0";
export const RUNTIME_VERSION = "fnmem-runtime-0.1.0";

export interface CompiledMemoryArtifact {
  readonly formatVersion: 1;
  readonly languageVersion: typeof LANGUAGE_VERSION;
  readonly specRevision: typeof SPEC_REVISION;
  readonly compilerVersion: typeof COMPILER_VERSION;
  readonly runtimeVersion: typeof RUNTIME_VERSION;
  readonly source: string;
  readonly sourceHash: string;
  readonly javascript: string;
}

function checkProgram(source: string, definitions: readonly Definition[]): void {
  const diagnostics: Diagnostic[] = [];
  let memoryId: string;
  const report = (offset: number, code: string, message: string, field?: string) => diagnostics.push({
    ...diagnostic(source, offset, code, message), memory: memoryId, ...(field !== undefined ? { field } : {}),
  });
  const memories = new Map<string, Definition>();
  for (const memory of definitions) {
    memoryId = memory.id;
    if (!memory.id.length) report(memory.offset, "E_REFERENCE", "Memory IDs must be nonempty.");
    if (memories.has(memory.id)) report(memory.offset, "E_DUPLICATE", `Duplicate memory '${memory.id}'.`);
    else memories.set(memory.id, memory);
    for (const schema of [memory.context, memory.input]) {
      const names = new Set<string>();
      for (const field of schema) {
        if (field.name.startsWith("__")) report(field.offset, "E_RESERVED", "Runtime field names are reserved.", field.name);
        if (names.has(field.name)) report(field.offset, "E_DUPLICATE", `Duplicate field '${field.name}'.`, field.name);
        names.add(field.name);
        if (field.defaultValue !== undefined && typeof field.defaultValue !== field.type) report(field.offset, "E_TYPE", "Default does not match field type.", field.name);
      }
    }
  }
  for (const memory of definitions) {
    memoryId = memory.id;
    const requireType = (actual: MemoryField["type"] | undefined, expected: MemoryField["type"], offset: number) => {
      if (actual !== undefined && actual !== expected) report(offset, "E_TYPE", `Expected ${expected}, received ${actual}.`);
    };
    function infer(value: Expression): MemoryField["type"] | undefined {
      if (value.kind === "literal") return typeof value.value as MemoryField["type"];
      if (value.kind === "source") {
        if (!memories.has(value.ref)) report(value.offset, "E_REFERENCE", `Unknown source '${value.ref}'.`);
        return "boolean";
      }
      if (value.kind === "access") {
        if (value.field.startsWith("__")) { report(value.offset, "E_RESERVED", "Runtime fields cannot be accessed.", value.field); return; }
        if (value.scope === "execution" && ["depth", "count"].includes(value.field)) return "number";
        if (value.scope === "workingMemory" && value.field === "count") return "number";
        const schema = value.scope === "context" ? memory.context : value.scope === "input" ? memory.input : [];
        const field = schema.find((field) => field.name === value.field);
        if (!field) report(value.offset, "E_FIELD", `Unknown ${value.scope} field '${value.field}'.`, value.field);
        return field?.type;
      }
      if (value.kind === "not") { requireType(infer(value.value), "boolean", value.offset); return "boolean"; }
      const left = infer(value.left), right = infer(value.right);
      if (["==", "!="].includes(value.operator)) {
        if (left !== undefined && right !== undefined && left !== right) report(value.offset, "E_TYPE", "Equality requires matching types.");
        return "boolean";
      }
      const type = value.operator === "+" ? "string" : ["and", "or"].includes(value.operator) ? "boolean" : "number";
      requireType(left, type, value.offset); requireType(right, type, value.offset);
      return value.operator === "+" ? "string" : "boolean";
    }
    function checkStatements(statements: readonly Statement[]): void {
      for (const statement of statements) {
        if (statement.kind === "text") { requireType(infer(statement.value), "string", statement.offset); continue; }
        if (statement.kind === "call") {
          const target = memories.get(statement.ref);
          if (!target) report(statement.offset, "E_REFERENCE", `Unknown memory '${statement.ref}'.`);
          const names = new Set<string>();
          for (const argument of statement.arguments) {
            if (argument.name.startsWith("__")) report(argument.offset, "E_RESERVED", "Reserved call argument.");
            if (names.has(argument.name)) report(argument.offset, "E_DUPLICATE", `Duplicate argument '${argument.name}'.`);
            names.add(argument.name);
            const type = infer(argument.value);
            const field = target?.input.find((field) => field.name === argument.name);
            if (target && !field) report(argument.offset, "E_ARGUMENT", `Unknown argument '${argument.name}'.`);
            if (field) requireType(type, field.type, argument.offset);
          }
          for (const field of target?.input ?? []) {
            if (field.defaultValue === undefined && !names.has(field.name)) report(statement.offset, "E_ARGUMENT", `Missing argument '${field.name}'.`);
          }
          continue;
        }
        if (statement.kind === "when") {
          requireType(infer(statement.condition), "boolean", statement.offset);
          checkStatements(statement.body); checkStatements(statement.otherwise); continue;
        }
        const type = infer(statement.value);
        const covered = new Set<string | number | boolean>();
        let wildcard = false;
        for (const arm of statement.arms) {
          if (wildcard || (type === "boolean" && covered.has(true) && covered.has(false))) report(arm.offset, "E_MATCH", "Unreachable match arm.");
          const local = new Set<string | number | boolean>();
          for (const pattern of arm.patterns ?? []) {
            if (type !== undefined && typeof pattern !== type) report(arm.offset, "E_TYPE", "Pattern type must match the subject.");
            if (local.has(pattern)) report(arm.offset, "E_DUPLICATE", "Repeated alternative pattern.");
            if (covered.has(pattern)) report(arm.offset, "E_MATCH", "Pattern was already covered by an unguarded arm.");
            local.add(pattern);
          }
          if (arm.guard) requireType(infer(arm.guard), "boolean", arm.guard.offset);
          else if (arm.patterns === null) wildcard = true;
          else arm.patterns.forEach((pattern) => covered.add(pattern));
          checkStatements(arm.body);
        }
        if (!wildcard && !(type === "boolean" && covered.has(true) && covered.has(false))) report(statement.offset, "E_MATCH", "Match requires exhaustive unguarded coverage.");
      }
    }
    checkStatements(memory.body);
  }
  if (diagnostics.length) throw new MemoryCompileError(diagnostics.sort((a, b) => a.offset - b.offset || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
}

function emitProgram(definitions: readonly Definition[]): string {
  const quote = (value: unknown) => JSON.stringify(value);
  function expression(value: Expression): string {
    if (value.kind === "literal") return quote(value.value);
    if (value.kind === "access") {
      if (value.scope === "workingMemory") return "p.workingMemory.length";
      return `p.${value.scope}[${quote(value.field)}]`;
    }
    if (value.kind === "source") return `p.workingMemory.some(m => m.source === ${quote(value.ref)})`;
    if (value.kind === "not") return `(!${expression(value.value)})`;
    const operator = ({ and: "&&", or: "||", "==": "===", "!=": "!==" } as Record<string, string>)[value.operator] ?? value.operator;
    return `(${expression(value.left)} ${operator} ${expression(value.right)})`;
  }
  let nextMatch = 0;
  function statements(body: readonly Statement[]): string {
    return body.map((statement) => {
      if (statement.kind === "text") return `emissions.push({type:"text",content:${expression(statement.value)}});`;
      if (statement.kind === "call") {
        const args = statement.arguments.map((argument) => `[${quote(argument.name)}]:${expression(argument.value)}`).join(",");
        return `emissions.push({type:"memory",ref:${quote(statement.ref)},input:{${args}}});`;
      }
      if (statement.kind === "when") return `if (${expression(statement.condition)}) {${statements(statement.body)}} else {${statements(statement.otherwise)}}`;
      const variable = `v${nextMatch++}`;
      const arms = statement.arms.map((arm, index) => {
        const pattern = arm.patterns === null ? "true" : `(${arm.patterns.map((pattern) => `${variable} === ${quote(pattern)}`).join(" || ")})`;
        const condition = arm.guard ? `(${pattern} && ${expression(arm.guard)})` : pattern;
        return `${index ? "else " : ""}if (${condition}) {${statements(arm.body)}}`;
      }).join("\n");
      return `{const ${variable} = ${expression(statement.value)}; ${arms}}`;
    }).join("\n");
  }
  const schema = (fields: readonly MemoryField[]) => fields.map((field) => ({ name: field.name, type: field.type, ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}) }));
  return `// Generated by ${COMPILER_VERSION}; source text is never executed.\nexport const memories = [\n${definitions.map((memory) => `{
id:${quote(memory.id)},
contextSchema:${quote(schema(memory.context))},
inputSchema:${quote(schema(memory.input))},
execute(p) {const emissions = [];\n${statements(memory.body)}\nreturn emissions;}
}`).join(",\n")}\n];\n`;
}

export async function compileMemorySource(source: string): Promise<CompiledMemoryArtifact> {
  const definitions = parseMemorySource(source);
  checkProgram(source, definitions);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const sourceHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ formatVersion: 1, languageVersion: LANGUAGE_VERSION, specRevision: SPEC_REVISION, compilerVersion: COMPILER_VERSION, runtimeVersion: RUNTIME_VERSION, source, sourceHash, javascript: emitProgram(definitions) });
}
