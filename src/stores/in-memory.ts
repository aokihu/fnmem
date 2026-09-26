import type { MutableMemoryStore } from "../store.js";
import type { MemoryFunction, MemoryId } from "../types.js";

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

  register(memory: MemoryFunction): void {
    this.#memories.set(memory.id, memory);
  }

  delete(id: MemoryId): boolean {
    return this.#memories.delete(id);
  }
}
