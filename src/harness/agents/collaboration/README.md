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
- `team.mjs`: durable Agent Team Lead roster, named teammate runs, peer inboxes
  and steering, wait-for-change, and the persisted compare-and-set task board.
  Teammates are spawned through `runMember`, which `chat_agent.mjs` implements
  with the same conversational loop and shared middleware as Swarm workers.
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

## Agent Teams

Agent Teams is available during assist (chat) collaboration runs. The running
assist conversation is the durable **Team Lead** (`lead`); named **teammates**
are durable members with their own conversational tool loops that share the same
working directory and filesystem. Team state survives turns and page reloads in
the session database, so the roster and shared task board are restored before
the next turn starts.

Disable the feature per collaboration configuration with:

```json
{ "collaboration": { "team": false } }
```

Default-enabled limits are configured under `collaboration.team`:

| Field | Default | Meaning |
|---|---|---|
| `maxMembers` | `16` | Maximum teammate records, including failed creations. Names are permanent and never reused. |
| `maxTasks` | `256` | Maximum non-deleted tasks on the shared board. |
| `maxMessageBytes` | `65536` | Maximum UTF-8 size of one framed `Team message from <name>:\n<text>` delivery. |

Teammate transcripts use the parent run's chat options and shared runtime
budgets, but teammates do not receive Swarm, `read_worker_result`,
`read_worker_evidence`, `inspect_harness` or `manage_harness_project` tools. Only
the Lead spawns, reassigns and interrupts teammates; there are no nested teams.

### Model-facing tools (`team.toolsFor(actor)`)

`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`
(Lead only), `team_task_create`, `team_task_list`, `team_task_get` and
`team_task_update`. Every tool is registered with `executionMode: 'sequential'`
and returns compact JSON: `{content:[{type:'text',text:JSON.stringify(value)}],
details:value}`. Tool errors are ordinary `Error`s with a stable `code` (for
example `TEAM_TASK_STALE_REVISION`, `TEAM_TASK_NOT_FOUND`,
`TEAM_MEMBER_NAME_TAKEN`, `TEAM_MEMBER_LIMIT`, `TEAM_TASK_LIMIT`,
`TEAM_SELF_MESSAGE`, `TEAM_MESSAGE_TOO_LARGE`, `TEAM_LEAD_REQUIRED`,
`TEAM_MEMBER_NOT_FOUND`, `TEAM_WAIT_ABORTED`, `TEAM_DISABLED`/`TEAM_CLOSED`).

Roster rows are `{name, role, status, description?, context?, error?, activity?,
createdAt, updatedAt}` with the Lead first. `inactive` means no turn is
executing; it does not describe task completion. `provisioning`/`failed`
describe member creation. Model-facing rows also expose `target` (the member
name used by `send_message`/`interrupt_agent`).

### Message delivery

`send_message` frames the text as `Team message from <sender>:\n<text>`, appends
it to the target's durable inbox, then attempts immediate delivery:

- running teammate with a registered steering handler: delivered at its nearest
  step boundary and removed from the inbox;
- inactive teammate: the queued messages become the prompt of a new run;
- Lead running with a registered steering handler: delivered as Lead steering;
- otherwise the message stays queued for the next Lead turn. Before a Lead turn
  starts, `chat_agent.mjs` calls `consumeLeadInbox()` and prepends the framed
  messages to the user prompt.

A successful send means inbox admission only, never that the recipient processed
or completed the message. Interrupting a teammate preserves its undelivered
inbox and task ownership; the next send resumes it with the queued messages.

### Task board

Tasks are full versioned snapshots:
`{id:'task-<n>', revision, subject, description, status, ownerName?, blockedBy,
writeScopes, ready, writeScopeWarnings}`. Every `team_task_update` requires the
current `expected_revision`; stale writes fail with
`TEAM_TASK_STALE_REVISION`, and readiness requires every blocker to be
`completed`. Deleted tasks keep an internal tombstone and id (never reused) but
disappear from `snapshot().tasks`. `writeScopeWarnings` are advisory overlaps
with other `in_progress` tasks and never block a claim.

### Events (for `harness-service.cjs`)

`onEvent` receives, already audited by the collaboration `report()` hook:

- `{type:'team.status', team:{revision, roster, tasks}}` — emitted on every
  durable change and on roster activity/status changes.
- `{type:'team.member.activity', member:<name>, activity:{label,status,at}}` —
  the compact teammate step record; the same value is stored on the roster row
  as `activity` (streaming partials and tool args/results are never duplicated
  into this event).
- `{type:'team.member.run', member:<name>, phase:'start'}` — emitted immediately
  before a teammate `runMember` invocation.
- `{type:'team.member.run', member:<name>, phase:'end', status}` — emitted after
  that run settles, with `status` set to the settled member status (`inactive`
  or `failed`). Every inbox-drain iteration/wake-up emits its own start/end pair
  (`start` always precedes its `end`); interrupt and close paths still end their
  run.

`onLiveEvent` is a separate **un-audited** channel. It receives every raw
`runConversation` event (including `message_start`, `message_update`,
`message_end` and `tool_execution_start/update/end`) as
`{type:'team.member.event', member:<name>, event:<raw event>}`, forwarded after
the compact activity bookkeeping. Streaming partials are presentation-only:
they reach live observers but are never audited or persisted, and a slow,
throwing or rejecting live observer can never delay or fail the teammate.
`chat_agent.mjs` wires `onLiveEvent: event => observe(onEvent, event)` and keeps
teammate `audit: () => {}`, so the SQLite event log does not grow with streaming
deltas.

### Persistence keys

- `team:state` — `{version, sessionId, revision, nextTaskNumber, roster, tasks,
  tombstones, inbox}`; `roster`/`tasks` are the host projection fields and
  `tombstones`/`inbox` retain internal state. `projection.cjs#projectTeam`
  consumes the saved value directly.
- `team:member:<name>:transcript` — bounded teammate conversation history.
- `team:member:<name>:pending-turn` — unresolved tool evidence for the teammate.

### Lifecycle

`createTeam` is created for each assist turn when the Team is enabled, using the
turn `AbortSignal`. `close()` interrupts every live teammate run, awaits bounded
settlement, persists the final inactive roster, resolves all `wait_agent`
waiters and is idempotent. `chat_agent.mjs` awaits `team.close()` before
`swarm.close()`, middlewares and the database, so teammates stop using tools
before storage closes. Aborting the turn signal starts the same close path; no
raw abort rejections escape to the caller.
