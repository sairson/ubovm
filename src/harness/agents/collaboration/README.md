# Collaboration Harness management

The IDE owns views and cached projections. Agent execution and lifecycle belong
to the backend worker (`ide/runtime/harness-thread.cjs`). Closing a view does
not cancel a run or delete its durable records.

Swarm shutdown waits for both running workers and pending worker admissions,
including their final interrupted-state journal writes, before storage closes.
Cancelled waits and concurrency-slot reacquisition reject even when the abort
reason is `false`, `0`, or an empty string. Resource cleanup attempts every service,
subscription, lease and database release and reports collected failures together.

## Responsibilities

- `chat_agent.mjs`: session lease, database, shared middleware and resource cleanup.
- `run-manager.mjs`: per-turn shared model/tool budgets, optional deadline and
  runtime inspection. One manager covers the coordinator and all descendants.
- `harness-project.mjs`: immutable task profile versions, declarative JSON
  import/export, durable project state and capability/budget narrowing.
- `swarm.mjs`: concurrency slots, worker ownership, dependencies, priority
  admission, cancellation/preemption, durable dispatch and result summaries.
  Waiting dependencies consume no slot. Coordinators set `spawn_worker.priority`
  (0–9) and call `manage_workers` to reorder or interrupt descendants.
- `conversation.mjs`: model/tool loop, per-worker limits, call-ID deduplication,
  approval, task-context protection and execution evidence.
- `history.mjs`: persisted conversation history limits. Message sizes are measured
  once in UTF-8, and old complete turns are removed without repeatedly serializing
  the remaining transcript. Oversized single turns retain clipped user/final-answer
  text within the byte limit; metadata that cannot fit fails explicitly with
  `COLLABORATION_HISTORY_LIMIT`. Inputs are not mutated.
- `context-summary.mjs`: provider-context compaction and separately bounded
  auxiliary summary requests; original execution evidence remains in storage.

## Optional shared limits

Configure these in the existing backend configuration:

```json
{
  "collaboration": {
    "runLimits": {
      "maxModelCalls": 500,
      "maxToolCalls": 1500,
      "maxDurationMs": 14400000
    }
  }
}
```

Every field defaults to `0` (unlimited). These are per collaboration turn,
not account-wide or persistent lifetime budgets. Existing per-worker limits
still apply. Counts are reserved before external model invocation or tool
approval; they measure attempts, not successful effects. Summary model calls
remain subject to the context-summary module's own limits.

`inspect_harness` returns elapsed time, limits, shared counts and per-worker
counts. It is a backend Agent tool, not a new IDE settings page. Inspection
itself is a tool call. No prompts, credentials or tool arguments are returned.

Budget exhaustion aborts the shared signal with `HARNESS_CALL_LIMIT`; deadlines
use `HARNESS_TIME_LIMIT`. Cooperative tools/models must honor cancellation;
cleanup is awaited rather than overlapping a replacement run with old writes.
This deadline cannot forcibly interrupt synchronous code blocking the worker;
the IDE transport heartbeat remains responsible for detecting an unresponsive
backend. Completed effects are not rolled back or automatically replayed.

This manager currently covers collaboration/assist execution. Goal-mode
Reason/Worker scheduling and checkpoints retain their existing management.

## Long-run context memory

The context-summary middleware uses a least-recently-used cache when both
durable `load` and `save` callbacks are configured (as in IDE sessions).
`contextSummary.maxCacheBytes` defaults to 8388608 and `maxCacheEntries` to 256.
Oversized records bypass the cache; evicted artifacts and summaries reload from
storage, preserving exact evidence and avoiding repeated summary model calls.
These limits bound serialized cache content, not total V8 heap or process RSS.
Standalone middleware without a complete persistence adapter retains evidence
in memory rather than silently discarding the only copy.

`inspect_harness.contextCache` reports entries, serialized bytes, configured
limits, evictions and whether the cache is bounded. It is null when context
summarization is disabled. Repeated worker context contains shortened task,
result and error text with explicit truncation flags. Read full completed
results through `read_worker_result`, full task/status through `list_workers`,
and retained execution evidence through `read_worker_evidence`.

## Worker-authored Harness projects

Both the coordinator and unrestricted Workers receive `manage_harness_project`.
The tool supports `validate`, `define`, `list`, `import` and `export`. Define a role:

```json
{
  "action": "define",
  "profile": {
    "name": "runtime-reviewer",
    "instructions": "Inspect runtime usage. Report observed limits and unresolved questions; do not modify files.",
    "allowedTools": ["inspect_harness"],
    "maxModelCalls": 8,
    "maxToolCalls": 4
  }
}
```

Use the returned ID, for example `runtime-reviewer@1`, with
`spawn_worker({ task, profile: "runtime-reviewer@1", depends_on: [...], priority: 7, preempt: true })`.
Never guess a profile ID. Coordinators also call `manage_workers` to raise
priority, preempt lower-priority running descendants, or interrupt obsolete
work. `list_workers.admission` reports who runs next, which runners can be
preempted, and which cancelled runners still occupy slots (`releasing`).
Queued records include `blocked.reason` (`dependencies` or `concurrency`).
`manage_workers` `preempt=true` only interrupts for the listed *ready queued*
targets; prioritizing a running worker alone does not cancel peers.
A profile revision cannot be edited in place; defining
changed content under the same name produces a new ID. Repeating identical
content reuses the latest ID without a write or capacity cost. Tool lists are
normalized, so order and duplicate names do not create needless revisions.
Running/queued tasks retain the old ID. The
effective profile and enabled tool names are saved with the worker's evidence.

Export returns a portable `{ "version": 1, "profiles": [...] }` manifest,
containing the latest version of each name. Workers can save it as
`.ubovm/harness.json` using enabled workspace edit tools and later read/import
it using the same workspace tools. Import is explicit; files are not loaded or
executed automatically. Import validates the complete manifest before publishing
any profile, and returns the new IDs for that session. Project state itself is
stored in the session database and survives restarts. Up to 64 immutable profile
versions are retained; exporting to a new session provides a reusable project.

Before saving, call `validate` with `profile` or `project`. The live Agent tool
returns a report per profile with effective tools and call ceilings, or a
specific environment mismatch. Validation does not save or start workers.
The preview uses current tools; host tool factories that differ for each worker
are revalidated at dispatch. A parent-scope violation is rejected before worker
creation, preserving the remaining worker budget.

For concurrent editing, read `revision` with `list` and pass it as
`expectedRevision` to `define`/`import`. A stale write fails with
`HARNESS_PROJECT_CONFLICT`; read the current project and reconcile intentionally.
Imports are atomic, including mixtures of unchanged and changed profiles.
Reads wait for previously submitted writes. Failed persistence never publishes
a new revision; retrying the same successful import remains safe even at capacity.

An omitted tool list inherits the enabled host tools, narrowed by the parent
Worker's effective list. An empty list disables tools. A profile cannot grant
unavailable tools, widen a parent's tool list, increase finite host/parent call
limits, change credentials/model endpoints, disable approval or bypass shared
run limits. `0` removes only the profile's own limit, not a finite inherited
limit. Profile instructions are task context subordinate to host instructions.

Use different profiles for investigation, implementation and verification;
combine them with `depends_on` for staged workflows and `read_worker_result`
for handoffs. Environment access still comes from host-configured workspace,
MCP, shell and skills tools. This is a declarative execution-project facility,
not a mechanism for loading arbitrary JavaScript or replacing the backend.
