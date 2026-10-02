# Observable Memory Runs

Stage four implements persisted terminal records for compiled DSL recalls. Memory definitions remain peer graph nodes. A Run records one traversal; repeated calls to one definition receive different invocation IDs.

## Recall, read and replay

```ts
import {
  compileMemorySource, FileMemoryRunStore, MemoryRunService,
} from "fnmem";

const artifact = await compileMemorySource(source);
const runs = new MemoryRunService(
  new FileMemoryRunStore("./evaluation-results/memory-runs"),
  { maxExecutions: 32, maxDepth: 8, maxVisitsPerMemory: 4 },
);

const reference = await runs.recall(artifact, {
  entrypoints: ["detect-stuck"], context: { failures: 3 },
});
// { id: "<UUID>", resource: "fnmem://run/<UUID>" }

const record = await runs.read(reference.id);
if (record.status === "completed") console.log(record.result.messages);
else console.log(record.error, record.result); // Diagnostic partial output.

const replay = await runs.replay(reference.id);
// New ID and resource, plus matches: true/false.
```

`recall` finishes execution, saves the completed or failed record, then returns its reference. Runtime errors are represented by failed Run resources. Artifact validation, invalid evidence, non-JSON requests, non-object requests and reserved top-level request fields fail before Run acceptance. Other finite request/schema/entrypoint errors are saved as failed Runs. Storage errors propagate: no usable reference is returned if saving fails.

`read` only reads the saved record. It does not recall, compile or call a model. A new process can construct the same file store and read the record after restart. The [MCP adapter](./MCP.md) exposes `fnmem://run/` as read-only resources over stdio and HTTP.

There is no background job or persisted `running` state in this stage. Process interruption before publication leaves no terminal Run resource. The local example uses an ignored development directory:

```sh
npm run example:runs
```

It demonstrates likelihood evidence, restart-style reading, matching replay, and a cyclic query stopped by its execution budget. Its judgments are scripted; it measures no LLM or memory benefit.

## Stored record

Each version-1 Run includes:

| Field | Meaning |
| --- | --- |
| `id`, `resource` | UUID v4 and corresponding `fnmem://run/{id}` |
| `status`, timestamps | Terminal completion/failure and wall-clock times |
| `artifact` | Original DSL source, source SHA-256, generated JavaScript, language/spec/compiler/runtime versions |
| `request` | Immutable original public context, ordered entrypoints/inputs and any caller limits |
| `runtimeLimits` | Explicit host ceilings; effective limits are these ceilings overridden by valid lower request limits |
| `judgments` | Versioned likelihood records, supplied facts and optional host verification evidence |
| `result` | Buffered text, original compact trace and committed execution count |
| `observation` | Invocation identities, statuses, inputs, resolved defaults/public context, validated emissions and activation edges |
| `metrics` | Committed executions, activation count, distinct executed memories, greatest executed hop count, execution duration |
| `error` | Failure code/message and failing reference/hop count where available |
| `replay` | Original Run ID and whether semantic output matches, for replay records only |

The duration excludes artifact loading and file persistence. Queued or blocked nodes are visible in the graph but do not increase committed execution metrics.

Invocation IDs (`invocation-1`, etc.) are local to a Run and deterministic in queue creation order. Activation edges link invocation IDs and record the originating emission index. Multiple entrypoints have no incoming activation edge; these starting calls do not give definitions a permanent level. Two calls to the same memory are distinct execution events.

`completed` invocations have fully validated emissions. The blocked/failed invocation is marked `failed`; other unprocessed calls remain `queued`. No emission from a failed invocation is committed. Preflight failure may mark a selected entrypoint failed before any call executes. Invalid query structure can fail without an identifiable invocation.

The random private `__` budget field is omitted from saved contexts. Original request limits and explicit host ceilings are retained for replay, and the runtime regenerates its private counter.

The existing `MemoryRuntime.recall()` result shape is unchanged. Hosts needing detailed observations without persistence can use `recallObserved()`; runtime failures also expose `error.observation` alongside `error.partial`.

## Retaining word judgments

Pass previously validated [likelihood-v1](./LIKELIHOOD.md) records as the optional third argument to `recall`:

```ts
await runs.recall(artifact, request, [{
  judgment, // { version, likelihood, weight } from parseLikelihoodJudgment.
  facts: { repeatedFailures: 3, strategyUnchanged: true },
}]);
```

Endpoint judgments (`confirmed`, `ruled_out`) additionally require matching trusted host verification with retained evidence:

```ts
{
  judgment,
  facts: { repeatedFailures: 3 },
  verification: {
    likelihood: "confirmed",
    evidence: { observationId: "fixture-observation-1" },
  },
}
```

The service verifies the vocabulary version, canonical identifier and derived weight. It does not discover facts or validate their truth. Hosts must select and verify evidence themselves and associate judgments with the appropriate DSL invocation inputs. Judgment records are audit data; they do not silently inject or replace query fields. Replay uses recorded inputs without asking a model to judge again.

## Persistence and integrity

`MemoryRunStore` defines insert-only `save` and read-only `get`. `FileMemoryRunStore` saves one JSON envelope per Run, containing format version, record and SHA-256 of stable JSON. It checks basic record shape, ID consistency, duplicate JSON keys and hash integrity during reading. Deep semantic equivalence is checked by replay.

The writer synchronizes a temporary file and atomically publishes it with a hard link. Publication cannot overwrite an existing ID, even with concurrent writers. The directory must support local filesystem hard links. An interrupted writer can leave a dot-prefixed temporary file; readers only access final `{id}.json` paths. This implementation does not guarantee directory metadata durability across power loss.

The checksum detects content corruption; it is not authentication against someone who can replace both content and checksum. The containing directory is trusted host storage. No retention, access control, redaction or remote database adapter is added here. Stored sources, inputs and evidence should be treated as local project data.

## Deterministic replay

Replay reloads and verifies the saved artifact, including source hash and compiler/runtime versions, then executes the saved request using the saved host ceilings. It does not select current memory definitions or rerun model inference. Version mismatches are rejected instead of silently upgrading an old artifact. Future compiler/runtime migrations need an explicit compatibility policy.

Each replay receives a new Run ID and leaves the original file unchanged. Comparison covers complete ordered text/trace, invocation identities/inputs/statuses/emissions, activation edges and failure details. Object key order is ignored. Run IDs, timestamps, private budget names and elapsed time are excluded from semantic comparison. A reproduced budget failure can match with both Runs marked failed.

The original Run's host ceilings are trusted for replay, including when the current service has different ceilings. Only replay records from the trusted store.

## Verification

Tests execute compiled DSL through the file store, check graph routing against independent expected outputs, read from a separate Node process with execution disabled, replay after source/ceiling changes, and reproduce partial failures. They also cover concurrent insert collisions, corrupted files, altered expected results, foreign artifact versions, invalid evidence and storage failure.

These are implementation checks. Live multilingual judgments, downstream memory benefit and cross-model query construction remain separate experiments.
