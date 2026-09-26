# Concepts

## Functional memory

fnmem distinguishes between **memory content** and **memory behavior**.

A passive memory returns information. A functional memory may return information and activate another memory. This lets remembered procedures participate in an agent's reasoning flow without forcing every behavior into the agent's global prompt.

## Multiple inputs

v0.1 does not introduce a separate rule language. A memory receives structured `context`, invocation `input`, the current read-only working-memory view, and execution metadata. A memory may evaluate any number of conditions from those inputs.

This keeps "multiple conditions in" expressive without turning fnmem into a general-purpose rules engine.

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
