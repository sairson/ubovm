---
name: team
description: Agent Teams policy for UBOVM collaboration mode. Load before the first spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent or team_task_* call while Team mode is enabled. Covers named teammates, the shared workspace and task board, steering, waiting, persistence, approval boundaries and reporting duties.
---

# Agent Teams

Load this skill before the first team tool call in a turn. The host appends your role identity (Team Lead or the teammate name) separately; follow it. Teammates run their own tool loop with their own history and inbox, and every edit they make is real.

When a task has independent workstreams that outlive one turn, prefer Agent Teams over Swarm workers: spawn one named teammate per stream with one verifiable task, put each stream on the shared task board with write scopes and dependencies, and use Swarm workers only for short-lived parallel subtasks inside one already-coordinated stream. Never put a teammate and a Swarm worker on the same file.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.

Only the Team Lead creates or interrupts teammates; there are no nested teams. A teammate must report its final answer to the Lead with send_message({ target: "lead" }), including the checks it actually ran and any unresolved limitation. Teammates are full agents: their edits, commands and task-board changes are real, so verify work before reporting it complete.

## When Teams beat Swarm

| Situation | Use |
|---|---|
| One lookup, one edit or a strictly sequential chain | Inline — do not delegate |
| Two or more independent slices inside this turn | Swarm — cheaper, no durable identity needed |
| Workstreams that span turns, need their own identity/inbox, or the user asked for named members | Agent Teams |
| Parallel modules owned over time with separate reporting lines | Agent Teams, one member per module |

A team is not a way to run more agents at once; it is a way to keep several owners accountable across turns. If everything finishes in one turn, Swarm is the smaller tool.

## Lead runbook

1. **Plan lanes** — split the request into independent workstreams with disjoint write scopes; a lane that depends on another lane is a `blocked_by` edge, not a parallel lane.
2. **Create the task** — `team_task_create` with subject, description containing the acceptance criteria and the evidence expected, `write_scopes`, and `blocked_by`. The task is the contract; the spawn prompt references its id.
3. **Spawn one member per lane** — name it for the role (lower-kebab-case), describe the responsibility, and include the task id, acceptance check, write scope and reporting format. Do not spawn placeholders or a member for a one-shot lookup.
4. **Do useful inline work** — keep integrating, reading or preparing verification while members run; do not idle.
5. **Wait and read** — `list_agents` then `wait_agent`; before waiting, make sure a required member is running or provisioning, otherwise use `send_message` to wake it. After wakeup or timeout, re-list instead of polling.
6. **Verify and integrate** — read each report, confirm load-bearing claims with a second method, resolve write conflicts yourself, and run the final checks.
7. **Close the loop** — complete each task with evidence, interrupt obsolete members, and only then write the final answer.

## Task board conventions

- One task per lane, not per file and not one umbrella task for the whole team.
- The description must contain the acceptance criteria and the evidence the member must return; a task that only says "implement X" is underspecified.
- `write_scopes` are workspace-relative path prefixes; keep concurrent tasks disjoint. Overlap is advisory, but overlapping writers are a coordination bug, not a warning to ignore.
- Use `blocked_by` for real ordering, claim with the current revision, and complete only with evidence. A stale revision means re-read with `team_task_get` and reapply, never force.

## Member brief template

Every spawn prompt should contain: the task id and subject; the objective in one sentence; the acceptance check that can pass or fail; the exact write scope; the inputs (paths, hashes, commands, environment); the report format (pass/fail, evidence, files/lines, commands run, unverified points); and the rule "report once at completion or at a concrete blocker, do not ask the Lead what to do next".

## Capacity and failure

Typical team size equals the number of independent lanes, usually 2–4; the host allows up to 16 member records, but more members add coordination cost without throughput. There are no nested teams: only the Lead creates or interrupts members, and a name is permanent even after failure. If a member fails, reassign its task to a new member with the failure context or finish it inline; `inactive` means no turn is executing, not that work is complete.

## Inbox etiquette

`send_message` is for actionable steering: new evidence, a scope change, a blocker, or a corrected acceptance check. Do not send status pings, do not ask a member what it is doing, and do not re-send the same instruction. A running member receives the message at its next step boundary; success only means inbox admission, so verify the effect through the task board and the member's report.

## Approval and workspace boundaries

Teammates inherit the session's tool approval and workspace policy. Do not ask a teammate to bypass approval, widen the workspace boundary, or repeat work whose effects are unknown. When a task needs a genuinely irreversible or user-owned decision, batch it into one question with a recommended default instead of delegating the decision.
