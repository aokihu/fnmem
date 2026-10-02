import type { MutableMemoryStore } from "../store.js";
import type { MemoryFunction, MemoryId } from "../types.js";
import { snapshotJson } from "../validation.js";

export class InMemoryStore implements MutableMemoryStore {
  readonly #memories = new Map<MemoryId, MemoryFunction>();

  constructor(memories: readonly MemoryFunction[] = []) {
    for (const memory of memories) {
      this.register(memory);
    }
  }

  get(id: MemoryId): MemoryFunction | undefined {
    return this.#memories.get(id);
  }

  snapshot(): InMemoryStore {
    return new InMemoryStore([...this.#memories.values()].map((memory) => Object.freeze({
      ...memory,
      ...(memory.contextSchema ? { contextSchema: snapshotJson(memory.contextSchema) as NonNullable<MemoryFunction["contextSchema"]> } : {}),
      ...(memory.inputSchema ? { inputSchema: snapshotJson(memory.inputSchema) as NonNullable<MemoryFunction["inputSchema"]> } : {}),
    })));
  }

  register(memory: MemoryFunction): void {
    this.#memories.set(memory.id, memory);
  }

  delete(id: MemoryId): boolean {
    return this.#memories.delete(id);
  }
}
