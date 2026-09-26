# Evaluation Plan

fnmem should be evaluated as an execution model, not by feature count.

## Primary question

When an agent encounters a situation it has seen before, does executable memory produce more reliable behavioral adaptation than injecting retrieved text alone?

## Initial benchmark shape

A benchmark case should define:

- a task state,
- one or more relevant prior experiences,
- a passive-memory baseline,
- an equivalent functional-memory setup,
- an observable target behavior,
- a fixed model/provider configuration.

The first target class is repeated-failure recovery: after several failed attempts, can a remembered recovery strategy activate a different problem-solving path without placing the whole procedure permanently in the system prompt?

## Metrics under consideration

- task completion rate,
- repeated-action rate after failure,
- context tokens added by memory,
- number of memory activations,
- runtime execution depth/fan-out,
- trace reproducibility,
- latency added by memory execution.

No benchmark result should be claimed until the harness and evaluation data are published alongside it.
