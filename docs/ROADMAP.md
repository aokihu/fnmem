# Roadmap

The roadmap is ordered around evidence, not feature count.

## v0.1 — Execution semantics

- [x] Functional memory interface
- [x] Multi-emission results
- [x] Working-memory buffer
- [x] Memory-call queue
- [x] Execution/depth/visit budgets
- [x] In-memory store
- [x] Execution trace
- [x] Runnable example
- [x] Initial tests

## v0.2 — Host integration

- [ ] Stable `MemoryProvider` adapter interface
- [ ] ATOM reference integration
- [ ] Structured trace events
- [ ] JSON-serializable memory definitions where possible
- [ ] More cycle and fan-out tests

## v0.3 — Persistence and retrieval adapters

- [ ] Persistent store interface
- [ ] SQLite reference adapter
- [ ] Retrieval adapter boundary
- [ ] Optional embedding-based selector example

## Research track

- [ ] Compare passive retrieval with executable memory on repeat-failure tasks
- [ ] Define reproducible functional-memory benchmarks
- [ ] Explore learned memory-function generation behind an explicit trust boundary
- [ ] Evaluate conflict resolution when multiple memories emit incompatible guidance

## Deferred until evidence justifies them

Parallel branch execution, priorities, effect emissions, terminal emissions, a dedicated graph compiler, distributed execution, and automatic model-generated executable code.
