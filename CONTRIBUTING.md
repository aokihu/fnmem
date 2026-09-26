# Contributing

Thanks for considering a contribution to fnmem.

## What is useful right now

The project is early. The most useful contributions are small and testable:

- execution-semantics edge cases
- recursion/fan-out safety tests
- trace and observability improvements
- agent-framework integration experiments
- documentation that makes the functional-memory model easier to falsify or validate

Large feature additions should begin as an issue so the public ABI does not expand faster than the model can be evaluated.

## Development

```bash
npm install
npm test
npm run example
```

Please include tests for behavior changes. Keep public types minimal and avoid coupling the core runtime to a specific model provider, vector database, or agent framework.

## Pull requests

A focused PR should explain:

1. the behavior being changed,
2. why it belongs in the memory runtime rather than the host agent,
3. how the behavior is bounded/testable,
4. whether it changes the public ABI.
