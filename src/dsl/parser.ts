import type { MemoryField } from "../types.js";
import { validUnicode } from "../validation.js";

export type Primitive = string | number | boolean;
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly memory?: string;
  readonly field?: string;
}

export function diagnostic(source: string, offset: number, code: string, message: string): Diagnostic {
  const lines = source.slice(0, offset).split(/\r\n|\r|\n/);
  return { code, message, offset, line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

export class MemoryCompileError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((item) => `${item.code} ${item.line}:${item.column} ${item.message}`).join("\n"));
    this.name = "MemoryCompileError";
  }
}

interface Position { readonly offset: number; }
export type Expression = Position & (
  | { readonly kind: "literal"; readonly value: Primitive }
  | { readonly kind: "access"; readonly scope: string; readonly field: string }
  | { readonly kind: "source"; readonly ref: string }
  | { readonly kind: "not"; readonly value: Expression }
  | { readonly kind: "binary"; readonly operator: string; readonly left: Expression; readonly right: Expression }
);
export interface Argument extends Position { readonly name: string; readonly value: Expression; }
export interface Arm extends Position {
  readonly patterns: readonly Primitive[] | null;
  readonly guard?: Expression;
  readonly body: readonly Statement[];
}
export type Statement = Position & (
  | { readonly kind: "text"; readonly value: Expression }
  | { readonly kind: "call"; readonly ref: string; readonly arguments: readonly Argument[] }
  | { readonly kind: "when"; readonly condition: Expression; readonly body: readonly Statement[]; readonly otherwise: readonly Statement[] }
  | { readonly kind: "match"; readonly value: Expression; readonly arms: readonly Arm[] }
);
export interface Field extends MemoryField, Position {}
export interface Definition extends Position {
  readonly id: string;
  readonly context: readonly Field[];
  readonly input: readonly Field[];
  readonly body: readonly Statement[];
}

interface Token extends Position {
  readonly kind: "word" | "literal" | "symbol" | "eof";
  readonly text: string;
  readonly value?: Primitive;
}
const keywords = new Set("language fnmem memory context input string number boolean when if else match emit text with or and not true false execution workingMemory depth count hasSource _".split(" "));

export function parseMemorySource(source: string): readonly Definition[] {
  const fail = (offset: number, message: string, code = "E_SYNTAX"): never => {
    throw new MemoryCompileError([diagnostic(source, offset, code, message)]);
  };
  if (!validUnicode(source)) fail(0, "Source must contain valid Unicode.");
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset]!;
    if (/[\x20\t\r\n]/.test(char)) { offset++; continue; }
    if (source.startsWith("//", offset)) {
      while (offset < source.length && !/[\r\n]/.test(source[offset]!)) offset++;
      continue;
    }
    const start = offset;
    if (char === '"') {
      offset++;
      let ended = false;
      while (offset < source.length) {
        const next = source[offset++];
        if (next === "\\") offset++;
        else if (next === '"') { ended = true; break; }
      }
      if (!ended) fail(start, "Unterminated string.");
      let value: string;
      try { value = JSON.parse(source.slice(start, offset)); } catch { return fail(start, "Invalid string escape or control character."); }
      if (!validUnicode(value)) fail(start, "Invalid Unicode string.");
      tokens.push({ kind: "literal", text: source.slice(start, offset), value, offset: start });
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset))?.[0];
    if (number) {
      let value = Number(number);
      if (!Number.isFinite(value)) fail(start, "Number must be finite.");
      if (Object.is(value, -0)) value = 0;
      offset += number.length;
      tokens.push({ kind: "literal", text: number, value, offset: start });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(offset))?.[0];
    if (word) {
      offset += word.length;
      tokens.push(word === "true" || word === "false"
        ? { kind: "literal", text: word, value: word === "true", offset: start }
        : { kind: "word", text: word, offset: start });
      continue;
    }
    const symbol = /^(?:<=|>=|==|!=|=>|[{}();:,.+|<>=])/.exec(source.slice(offset))?.[0];
    if (!symbol) return fail(start, `Unexpected character ${char}.`);
    offset += symbol.length;
    tokens.push({ kind: "symbol", text: symbol, offset: start });
  }
  tokens.push({ kind: "eof", text: "", offset });
  let index = 0;
  const peek = () => tokens[index]!;
  const take = () => tokens[index++]!;
  const accept = (text: string) => peek().text === text ? (take(), true) : false;
  const expect = (text: string) => { if (!accept(text)) fail(peek().offset, `Expected '${text}'.`); };
  const identifier = () => {
    const token = take();
    if (token.kind !== "word" || keywords.has(token.text)) fail(token.offset, "Expected a field identifier.");
    return token;
  };
  const literal = (): Primitive => {
    const token = take();
    if (token.kind !== "literal") fail(token.offset, "Expected a primitive literal.");
    return token.value!;
  };
  const reference = (): string => {
    const token = take();
    if (token.kind !== "literal" || typeof token.value !== "string") fail(token.offset, "Memory references must be string literals.", "E_REFERENCE");
    return token.value as string;
  };
  const levels = [["or"], ["and"], ["==", "!="], ["<", "<=", ">", ">="], ["+"]];
  function expression(level = 0): Expression {
    if (level < levels.length) {
      let left = expression(level + 1);
      while (levels[level]!.includes(peek().text)) {
        const operator = take();
        left = { kind: "binary", operator: operator.text, left, right: expression(level + 1), offset: operator.offset };
        if (level === 2 || level === 3) break;
      }
      return left;
    }
    const token = peek();
    if (accept("not")) return { kind: "not", value: expression(level), offset: token.offset };
    if (accept("(")) { const value = expression(); expect(")"); return value; }
    if (token.kind === "literal") return { kind: "literal", value: literal(), offset: token.offset };
    if (!["context", "input", "execution", "workingMemory"].includes(token.text)) fail(token.offset, "Expected a DSL expression.");
    take(); expect(".");
    const field = take();
    if (field.kind !== "word") fail(field.offset, "Expected a field name.");
    if (token.text === "workingMemory" && field.text === "hasSource") {
      expect("("); const ref = reference(); expect(")");
      return { kind: "source", ref, offset: token.offset };
    }
    return { kind: "access", scope: token.text, field: field.text, offset: field.offset };
  }
  function block(): Statement[] {
    expect("{"); const statements: Statement[] = [];
    while (peek().text !== "}") {
      if (peek().kind === "eof") fail(peek().offset, "Unterminated block.");
      statements.push(statement());
    }
    expect("}"); return statements;
  }
  function statement(): Statement {
    const token = take();
    if (token.text === "when" || token.text === "if") {
      const condition = expression(); const body = block();
      let otherwise: Statement[] = [];
      if (accept("else")) {
        if (peek().text !== "{" && !["when", "if"].includes(peek().text)) fail(peek().offset, "Else requires a block or condition.");
        otherwise = peek().text === "{" ? block() : [statement()];
      }
      return { kind: "when", condition, body, otherwise, offset: token.offset };
    }
    if (token.text === "match") {
      const value = expression(); const arms: Arm[] = []; expect("{");
      if (peek().text === "}") fail(peek().offset, "Match requires at least one arm.");
      while (peek().text !== "}") {
        const armOffset = peek().offset;
        let patterns: Primitive[] | null = null;
        if (!accept("_")) {
          patterns = [literal()];
          while (accept("|")) patterns.push(literal());
        }
        let guard: Expression | undefined;
        if (accept("when") || accept("if")) guard = expression();
        expect("=>"); const body = block();
        arms.push({ patterns, ...(guard ? { guard } : {}), body, offset: armOffset });
        if (!accept(",")) break;
      }
      expect("}"); return { kind: "match", value, arms, offset: token.offset };
    }
    if (token.text === "emit") {
      if (accept("text")) { const value = expression(); expect(";"); return { kind: "text", value, offset: token.offset }; }
      expect("memory"); const ref = reference(); const args: Argument[] = [];
      if (accept("with")) {
        expect("{");
        if (peek().text !== "}") {
          do { const name = identifier(); expect(":"); args.push({ name: name.text, value: expression(), offset: name.offset }); } while (accept(","));
        }
        expect("}");
      }
      expect(";"); return { kind: "call", ref, arguments: args, offset: token.offset };
    }
    return fail(token.offset, "Expected when, if, match or emit.");
  }
  function schema(): Field[] {
    expect("{"); const fields: Field[] = [];
    while (peek().text !== "}") {
      const name = identifier(); expect(":"); const type = take();
      if (!["string", "number", "boolean"].includes(type.text)) fail(type.offset, "Unknown field type.");
      const defaultValue = accept("=") ? literal() : undefined; expect(";");
      fields.push({ name: name.text, type: type.text as MemoryField["type"], ...(defaultValue !== undefined ? { defaultValue } : {}), offset: name.offset });
    }
    expect("}"); return fields;
  }
  expect("language"); expect("fnmem");
  if (literal() !== "0") fail(0, "Unsupported language version.");
  expect(";");
  const definitions: Definition[] = [];
  while (peek().kind !== "eof") {
    const start = peek().offset; expect("memory"); const id = reference(); expect("{");
    let context: Field[] = [], input: Field[] = [];
    const seen = new Set<string>();
    while (peek().text === "context" || peek().text === "input") {
      const section = take();
      if (seen.has(section.text)) fail(section.offset, "Duplicate schema block.", "E_DUPLICATE");
      if (section.text === "context" && seen.has("input")) fail(section.offset, "Context schema must precede input schema.");
      seen.add(section.text);
      if (section.text === "context") context = schema(); else input = schema();
    }
    const body: Statement[] = [];
    while (peek().text !== "}") {
      if (peek().kind === "eof") fail(peek().offset, "Unterminated memory.");
      body.push(statement());
    }
    expect("}"); definitions.push({ id, context, input, body, offset: start });
  }
  if (!definitions.length) fail(0, "A bundle requires at least one memory.");
  return definitions;
}
