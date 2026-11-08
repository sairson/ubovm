---
name: swarm
description: Swarm delegation procedure for UBOVM collaboration mode. Load before the first spawn_worker, manage_workers, wait_workers, cancel_workers or read_worker_result call. Covers one verifiable slice per worker, disjoint write ownership, priority and preemption, waiting modes, integration and honest reporting.
---

# Swarm delegation

Load this skill before the first Swarm tool call in a turn. Tool schemas describe parameters and admission controls; this skill describes the procedure, write ownership, waiting, integration and reporting rules.

## Delegation with Swarm Workers

Split independent files or concerns across parallel workers; use depends_on (up to 8 existing descendant IDs) when a later task needs earlier changes. Before parallel edits, assign each file to exactly one writer with spawn_worker writes (workspace-relative, disjoint across workers that can run together); the same path may be listed again only with depends_on on the current writer. A worker may edit only its assigned files, and a nested worker's writes must stay inside its parent's assignment. WRITE_OWNERSHIP means another writer owns the file or it is unassigned: wait_workers, or spawn again with disjoint writes—do not retry the old hash. Dependent tasks wait without holding a concurrency slot and receive successful predecessor result summaries automatically; a failed or cancelled prerequisite blocks downstream work, so inspect evidence and replan instead of blindly retrying.

Each spawn_worker task is one verifiable slice, not a longer chain, and workers do not inherit this transcript: include the goal, the paths and hashes, and one acceptance check that can pass or fail. When the next step is another slice, spawn it—do not keep reasoning in this context. Before accepting a result, confirm the same claim with a second method: for a file, a remote sha256 and an IDE read of that file. Workers may spawn further descendants within shared limits. Keep doing useful coordinating or sequential glue work while workers run, then wait_workers and integrate before the final response.

## Slice contract

Write every spawn_worker task so the worker can decide pass/fail without asking anything:

1. **Objective** — one sentence: the observation or change this slice must produce.
2. **Inputs** — workspace-relative paths (and hashes when the content matters), the exact commands or sources to use, and any environment constraint (local, SSH profile, browser).
3. **Acceptance check** — one check that can pass or fail and that the worker can run itself; name the command or tool, not "looks right".
4. **Output** — what to return: observation, evidence (command + output excerpt, file lines or hashes), and what remains unverified.
5. **Write scope** — pass `writes` for any file the worker may edit; omit it for read-only investigation slices.

If you cannot fill all five, the work is not a slice yet — inspect more inline first. Do not put two unrelated questions in one worker, and do not put a sequential chain in one task hoping the worker will "figure it out".

## Nested workers

A worker may spawn descendants inside its own slice (host limit: two levels). Nested work must stay inside the parent's write assignment and must not duplicate the parent's check. Prefer one bounded child for a genuinely parallel sub-check over a tree of workers; the parent owns integration and the final report. Do not spawn a child to ask a question or to report status.

You own admission order: set spawn_worker priority 0-9 (default 0; higher starts first when concurrency is full, ahead of lower-priority workers waiting to reacquire a slot) and pass preempt=true on spawn or manage_workers action=prioritize when a more important descendant is blocked by lower-priority running work; manage_workers preempt only targets the listed ready queued workers, not the rest of the roster. Swarm state and list_workers.admission name who runs next; workers[].blocked.reason is dependencies or concurrency, and admission.releasing means a cancelled runner still holds its slot; skip_preempt=dependencies means the worker is not ready, and skip_preempt=no_ready_queued_target means prioritize+preempt listed no ready queued worker. When wait_workers times out, read blocked/admission and preempt or interrupt instead of waiting on the same occupancy; do not wait for an idle slot if the running work is obsolete or less important. Default wait mode is all; use mode any with unfinished worker_ids to take the first available result. Use manage_workers action=interrupt or cancel_workers for obsolete or redundant descendants and their subtrees; interruption does not undo tool effects, and wait_workers confirms cleanup. Use list_workers to inspect roster, occupancy, priorities and budgets.

Summaries marked resultTruncated are incomplete: read all saved pages with read_worker_result (worker_id + nextOffset). You may read your descendants and explicit dependencies; sourceTruncated means an older record kept only a summary. read_worker_result reporting available:false with queued/running/waiting means the worker is still in progress—wait_workers and read again, and that hint is not a tool failure. Put detailed findings in shared notes or workspace files and tell downstream workers where to verify them. Use read_worker_evidence on failed or interrupted workers before repeating work with unknown effects.

For a complex or repeated role, define a reusable task profile with manage_harness_project (instructions, tool allowlists, tighter budgets) and pass its immutable profile ID to spawn_worker; workers can author profiles for their children. Use action validate to preview a profile or manifest against current tools and inherited budgets before saving. When editing concurrently, list the current revision and pass expectedRevision to define/import, and reconcile conflicts instead of silently superseding another worker; identical definitions reuse IDs. Inspect the actual environment/tools before choosing a profile—unavailable tools cause failure. Export a version-1 JSON project with manage_harness_project and save it through enabled workspace edit tools; import is explicit. Profile instructions stay subordinate to host instructions, parent capabilities and approval. Use profiles plus depends_on for staged investigation, implementation and verification.

Use inspect_harness when planning a long run to check elapsed time and shared call budgets; zero means unlimited. Counts indicate attempted calls, not successful effects. Leave room to integrate results and verify changes; never claim completion merely because a budget is nearly exhausted.

## When not to delegate

Delegation is a cost, not a progress signal. Work inline when there is one lookup, one focused edit, one answer already supported by context, or a strictly sequential chain. Do not spawn a worker to think, to ask the user, to produce a status update, or to retry the same failed method. After a failure, inspect read_worker_evidence and change the method before spawning again; otherwise the same failure repeats with a new ID.

## Efficiency

Dispatch economics are part of correctness. Do not spawn a Worker for a short answer, one obvious lookup, one small file read, a clarifying question, or a single atomic edit you can verify directly. Before spawning, state the independent evidence gap and acceptance check; if there is no separate verifiable slice, work inline. When several workers are active, use wait_workers mode=any when the first terminal result is enough for the next decision, and mode=all only when every selected result is required. A wait timeout is not failure, and a queued or running result is not evidence. If a history gap or a lossy summary affects a claim, recover the source with the relevant evidence tool or mark the claim unverified.

## Acceptance

- One worker = one verifiable slice plus one acceptance check that can pass or fail.
- A queued, running or timed-out worker is not evidence; integrate only terminal results.
- Report the checks that actually ran and what remains unverified.

## Integration checklist

Before the final response:

1. `wait_workers` (mode=all for required results; mode=any only when the first terminal result decides the next step) and re-list after a timeout.
2. Read every terminal result; follow `nextOffset` pages when `resultTruncated`, and use `read_worker_evidence` for failed or interrupted workers.
3. Verify load-bearing claims with a second method; a worker report is a claim, not proof.
4. Resolve write conflicts yourself and run the final build/tests in this context.
5. Cancel or interrupt leftover workers that no longer matter; do not leave them holding slots when you finish.
