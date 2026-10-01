export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryBudgetExceededError";
  }
}

export class InvalidRecallRequestError extends Error {
  readonly code = "E_QUERY";

  constructor(message: string) {
    super(message);
    this.name = "InvalidRecallRequestError";
  }
}
