import type { MemoryFunction, MemoryId } from "./types.js";

export interface MemoryStore {
  snapshot?(): MemoryStore | Promise<MemoryStore>;
  get(id: MemoryId): MemoryFunction | undefined | Promise<MemoryFunction | undefined>;
}

export interface MutableMemoryStore extends MemoryStore {
  register(memory: MemoryFunction): void | Promise<void>;
  delete(id: MemoryId): boolean | Promise<boolean>;
}
