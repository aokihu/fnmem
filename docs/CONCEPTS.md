# Concepts

## Functional memory

fnmem distinguishes between **memory content** and **memory behavior**.

A passive memory returns information. A functional memory may return information and activate another memory. This lets remembered procedures participate in an agent's reasoning flow without forcing every behavior into the agent's global prompt.

## Memory graph

All memory definitions are peer nodes in a directed graph. A memory-reference emission creates an activation edge between nodes during recall. A selected entrypoint is just a starting node for that recall; it does not own other memories or establish a permanent level.

Nodes may activate several other nodes, be reached from different nodes, or participate in cycles. The execution queue traverses the activated edges in FIFO order under the shared budget. `execution.depth` counts activation edges from a selected entrypoint for this particular invocation. The same memory may execute at different depths; the number does not assign a hierarchy to its definition.

## Multiple inputs

The current prototype receives structured `context`, invocation `input`, the read-only working-memory view and execution metadata through a TypeScript callback. The planned authoring interface is an independent DSL compiled into Node.js-compatible artifacts, preserving these multiple inputs and the two emission types.

The [DSL v0 specification](./DSL.md) now defines grammar, field types, canonical queries and deterministic execution semantics. Its sources and expected traces are ready for the compiler stage; no DSL compiler has been implemented yet. Handwritten callbacks remain examples for discussing and testing behavior during this transition.

## Multiple outputs

A memory returns an array of emissions. v0.1 defines two emission types:

- `text`: buffered in working memory
- `memory`: appended to the runtime execution queue

A single memory may emit any number of either type.

## Working memory

When text and memory calls are emitted together, text is retained in a temporary working-memory buffer while the runtime continues evaluating queued memories. Subsequent memory functions receive a read-only view of that buffer.

The final recall result contains the accumulated text and a trace of executed memories.

## Why not effects, priorities, or terminal emissions yet?

Those concepts may be useful, but adding them before the two-emission model is validated would blur the boundary between a memory runtime and a workflow engine. v0.1 deliberately keeps the ABI smaller than the internal design space.
