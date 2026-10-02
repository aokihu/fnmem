import type { MemoryFunction, MemoryId } from "../types.js";
import type { MemoryStore } from "../store.js";
import { snapshotJson } from "../validation.js";
import { compileMemorySource } from "./compiler.js";
import type { CompiledMemoryArtifact } from "./compiler.js";

export * from "./compiler.js";
export { MemoryCompileError } from "./parser.js";
export type { Diagnostic } from "./parser.js";

export class CompiledMemoryBundle implements MemoryStore {
  readonly #memories: ReadonlyMap<MemoryId, MemoryFunction>;

  private constructor(readonly artifact: CompiledMemoryArtifact, memories: readonly MemoryFunction[]) {
    this.#memories = new Map(memories.map((memory) => [memory.id, Object.freeze({
      ...memory,
      contextSchema: snapshotJson(memory.contextSchema) as NonNullable<MemoryFunction["contextSchema"]>,
      inputSchema: snapshotJson(memory.inputSchema) as NonNullable<MemoryFunction["inputSchema"]>,
    })]));
    Object.freeze(this);
  }

  get(id: MemoryId): MemoryFunction | undefined { return this.#memories.get(id); }

  list(): readonly MemoryFunction[] { return Object.freeze([...this.#memories.values()]); }

  static async load(artifact: CompiledMemoryArtifact): Promise<CompiledMemoryBundle> {
    if (!artifact || typeof artifact.source !== "string") throw new Error("Invalid memory artifact.");
    // Verify every field before importing code, including after JSON/file round trips.
    const expected = await compileMemorySource(artifact.source);
    if (Object.keys(artifact).sort().join(",") !== Object.keys(expected).sort().join(",") || Object.entries(expected).some(([key, value]) => artifact[key as keyof CompiledMemoryArtifact] !== value)) {
      throw new Error("Memory artifact source, code or version mismatch.");
    }
    const module = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(expected.javascript)}`);
    return new CompiledMemoryBundle(expected, module.memories);
  }
}

export async function loadMemoryArtifact(artifact: CompiledMemoryArtifact): Promise<CompiledMemoryBundle> {
  return CompiledMemoryBundle.load(artifact);
}
