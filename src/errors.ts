import type { RecallResult, ExecutionObservation } from "./types.js";

export class MemoryRuntimeError extends Error {
  partial?: RecallResult;
  observation?: ExecutionObservation;
  invocation?: { readonly ref: string; readonly depth: number };

  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MemoryRuntimeError";
  }
}

export class MemoryNotFoundError extends MemoryRuntimeError {
  constructor(id: string) {
    super(`Memory not found: ${id}`, "E_MEMORY_NOT_FOUND");
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryBudgetExceededError extends MemoryRuntimeError {
  constructor(message: string, code = "E_MAX_EXECUTIONS") {
    super(message, code);
    this.name = "MemoryBudgetExceededError";
  }
}

export class InvalidRecallRequestError extends MemoryRuntimeError {
  constructor(message: string) {
    super(message, "E_QUERY");
    this.name = "InvalidRecallRequestError";
  }
}

export class MemoryInputError extends MemoryRuntimeError {
  constructor(message: string) {
    super(message, "E_INPUT");
    this.name = "MemoryInputError";
  }
}

export class MemoryRunError extends Error {
  constructor(message: string, readonly code = "E_RUN_RECORD") {
    super(message);
    this.name = "MemoryRunError";
  }
}
