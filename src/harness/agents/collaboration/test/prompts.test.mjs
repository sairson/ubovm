import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatSystemPrompt, workerSystemPrompt, TEAM_POLICY, teamPolicy, teammateSystemPrompt } from '../prompts.mjs';

const swarmSkill = readFileSync(new URL('../../skills/swarm/SKILL.md', import.meta.url), 'utf8');
const teamSkill = readFileSync(new URL('../../skills/team/SKILL.md', import.meta.url), 'utf8');

test('assist chat prompt uses a task-first operating loop with least delegation', () => {
  assert.match(chatSystemPrompt, /You are the chat coordinator inside UBOVM IDE collaboration mode/);
  assert.match(chatSystemPrompt, /## Operating loop/);
  assert.match(chatSystemPrompt, /default to doing the work/);
  assert.match(chatSystemPrompt, /Choose the smallest mechanism that can finish it/);
  assert.match(chatSystemPrompt, /## Delegation ladder/);
  assert.match(chatSystemPrompt, /direct workspace tools for local work/);
  assert.match(chatSystemPrompt, /configured remote environment only when the task targets it/);
});

test('assist prompts do not hard-code a CTF, security or remote-engagement default', () => {
  assert.doesNotMatch(chatSystemPrompt, /Capture the Flag|CTF challenge|challenge scope|authorized challenge/i);
  assert.doesNotMatch(workerSystemPrompt, /Capture the Flag|CTF challenge|challenge scope|authorized challenge/i);
  assert.match(chatSystemPrompt, /infer it from the user's request and the files they provide/);
});

test('assist chat prompt defaults to acting instead of asking for options', () => {
  assert.match(chatSystemPrompt, /default to doing the work/);
  assert.match(chatSystemPrompt, /understand the requested outcome/);
  assert.match(chatSystemPrompt, /Ask only when a decision is genuinely the user's/);
  assert.match(chatSystemPrompt, /Never trade work for a menu of options or opinions/);
  assert.match(chatSystemPrompt, /Do not close with an options menu/);
});

test('assist prompts keep long tasks running instead of asking for the next step', () => {
  assert.match(chatSystemPrompt, /## Long tasks/);
  assert.match(chatSystemPrompt, /A long task is not a hand-off/);
  assert.match(chatSystemPrompt, /Starting a long-running command is a checkpoint, not completion/);
  assert.match(chatSystemPrompt, /background_commands/);
  assert.match(chatSystemPrompt, /Do not end the turn merely because the task is long/);
  assert.match(chatSystemPrompt, /Never use ask_human for permission/);
  assert.match(chatSystemPrompt, /do not end an assistant message with a question mark/);
  assert.match(chatSystemPrompt, /never ask the user to plan the next step/);
  assert.match(chatSystemPrompt, /never hand a working phase back by asking the user what to do next/);
  assert.match(workerSystemPrompt, /do not pause to ask the Lead what to do next/);
  assert.match(teammateSystemPrompt, /Do not hand the task back or ask the Lead what to do next/);
});

test('assist prompts require matching the user language', () => {
  assert.match(chatSystemPrompt, /Always reply in the same language the user is using in their messages/);
  assert.match(chatSystemPrompt, /including thinking\/reasoning/);
  assert.match(chatSystemPrompt, /Match that language for thinking\/reasoning traces/);
  assert.match(chatSystemPrompt, /Host\/system framing text does not override the user's language/);
  assert.match(workerSystemPrompt, /matching the language of the assigned task and user steering, including thinking\/reasoning/);
  assert.match(workerSystemPrompt, /Always reply in the same language the user is using in their messages/);
});

test('assist chat replies stay concise and hide internal machinery', () => {
  assert.match(chatSystemPrompt, /lead with the answer or outcome/);
  assert.match(chatSystemPrompt, /Do not mention Swarm, Reason, Blackboard, workers or host internals/);
  assert.match(chatSystemPrompt, /keep visible status short/);
  assert.match(chatSystemPrompt, /Hide coordination machinery unless the user needs it/);
  assert.doesNotMatch(workerSystemPrompt, /Hide coordination machinery unless the user needs it/);
});

test('assist prompts route Swarm procedure through the built-in skill', () => {
  assert.match(chatSystemPrompt, /Swarm delegation rules live in the `swarm` skill/);
  assert.match(chatSystemPrompt, /load_skill\(\{ name: "swarm" \}\)/);
  assert.match(workerSystemPrompt, /load_skill\(\{ name: "swarm" \}\)/);
  assert.match(swarmSkill, /WRITE_OWNERSHIP/);
  assert.match(swarmSkill, /spawn_worker priority 0-9/);
  assert.match(swarmSkill, /preempt=true on spawn/);
  assert.match(swarmSkill, /list_workers\.admission/);
  assert.match(swarmSkill, /skip_preempt=dependencies/);
  assert.match(swarmSkill, /manage_workers action=interrupt or cancel_workers/);
  assert.match(swarmSkill, /workers do not inherit this transcript/i);
});

test('assist prompts load matching skills proactively instead of waiting for a request', () => {
  assert.match(chatSystemPrompt, /## Proactive skill use/);
  assert.match(chatSystemPrompt, /Load matching skills proactively before acting; never wait for the user to name a skill/);
  assert.match(workerSystemPrompt, /Load matching skills proactively before acting/);
  assert.match(chatSystemPrompt, /never wait for the user to name the skill/);
  assert.match(chatSystemPrompt, /loading does not require user approval/);
  assert.match(chatSystemPrompt, /Load it as soon as the turn will use Swarm tools/);
  assert.match(chatSystemPrompt, /Do not wait for the user to ask for Swarm/);
  assert.match(workerSystemPrompt, /## Proactive skill use/);
  assert.match(TEAM_POLICY, /Load the `team` skill as soon as the turn will use team tools/);
  assert.match(TEAM_POLICY, /Do not wait for the user to ask for Agent Teams/);
});

test('assist worker prompt stays bounded and may spawn descendants', () => {
  assert.match(workerSystemPrompt, /You are a Swarm Worker inside UBOVM IDE collaboration mode/);
  assert.match(workerSystemPrompt, /another verifiable slice/);
  assert.match(workerSystemPrompt, /acceptance check/);
  assert.match(workerSystemPrompt, /do not keep thinking in this context/);
  assert.match(workerSystemPrompt, /do not re-delegate the entire assignment/);
  assert.match(chatSystemPrompt, /confirm the result with a second method/);
  assert.match(chatSystemPrompt, /Do not extend one context to think longer/);
  assert.match(chatSystemPrompt, /remote sha256 and an IDE read/);
});

test('assist coding prompt keeps the structured coding discipline', () => {
  // The coding discipline must stay a scannable, structured block: a single
  // run-on paragraph cannot be followed selectively or asserted precisely.
  assert.match(chatSystemPrompt, /## Coding and workspace tools/);
  assert.match(chatSystemPrompt, /### Locate before editing/);
  assert.match(chatSystemPrompt, /### Read fully before editing/);
  assert.match(chatSystemPrompt, /### One writer per file \/ ownership/);
  assert.match(chatSystemPrompt, /### Smallest correct edit/);
  assert.match(chatSystemPrompt, /### Verify after editing/);
  assert.match(chatSystemPrompt, /### Report honestly/);

  // Both the coordinator and the worker must receive the same discipline.
  assert.match(workerSystemPrompt, /### Locate before editing/);
  assert.match(workerSystemPrompt, /### Verify after editing/);

  // Load-bearing tool/API identifiers must survive any future rewrite, and the
  // consolidated read/edit surface must be the only one taught.
  assert.match(chatSystemPrompt, /expectedHash/);
  assert.match(chatSystemPrompt, /edit_workspace_files/);
  assert.match(chatSystemPrompt, /read_workspace_code/);
  assert.match(chatSystemPrompt, /read_workspace_change/);
  assert.match(chatSystemPrompt, /recover_workspace_changes/);
  assert.match(chatSystemPrompt, /startLine\/lineCount/);
  assert.match(chatSystemPrompt, /dryRun/);
  assert.match(chatSystemPrompt, /retrieval/);
  for (const removed of ['read_workspace_file', 'edit_workspace_file', 'preview_workspace_edits', 'analyze_workspace_call_chain']) {
    assert.equal(new RegExp('\\b' + removed + '\\b').test(chatSystemPrompt), false, removed + ' must not be advertised');
    assert.equal(new RegExp('\\b' + removed + '\\b').test(workerSystemPrompt), false, removed + ' must not be advertised to workers');
  }

  // The acceptance discipline must stay word-for-word, and honest reporting
  // must be present so "wrote the file" is never equated with "tests passed".
  assert.match(
    chatSystemPrompt,
    /For implementation requests, carry the work through investigation, edits and appropriate verification instead of stopping at advice or a plan\./,
  );
  assert.match(chatSystemPrompt, /Write completion is not test passing/);
});

test('Agent Teams policy is loaded from the built-in team skill', () => {
  assert.match(TEAM_POLICY, /load_skill\(\{ name: "team" \}\)/);
  assert.match(TEAM_POLICY, /Do not run a team from memory/);
  assert.match(teamSkill, /prefer Agent Teams over Swarm workers/);
  assert.match(teamSkill, /spawn one named teammate per stream/);
  assert.match(teamSkill, /shared task board with write scopes and dependencies/);
  assert.match(teamSkill, /Never put a teammate and a Swarm worker on the same file/);
  assert.match(teamSkill, /The Lead must wait for required teammates before giving the final answer/);
  assert.match(teamSkill, /Only the Team Lead creates or interrupts teammates/);
  assert.match(teamPolicy('lead'), /You are the Team Lead named "lead"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /You are teammate "reviewer"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /send_message\(\{ target: "lead"/);
  assert.match(teammateSystemPrompt, /You are a named teammate inside the UBOVM IDE collaboration mode/);
  assert.match(teammateSystemPrompt, /never create or interrupt teammates/);
  assert.match(teammateSystemPrompt, /send_message\(\{ target: "lead"/);
});

test('delegation ladder separates inline, Swarm and Agent Teams work', () => {
  assert.match(chatSystemPrompt, /## Delegation ladder/);
  assert.match(chatSystemPrompt, /## Collect, verify, integrate/);
  assert.match(chatSystemPrompt, /## Delegation anti-patterns/);
  assert.match(chatSystemPrompt, /Delegation is not a progress signal/);
  assert.match(chatSystemPrompt, /2–4 parallel lanes/);
  assert.match(chatSystemPrompt, /For a one-shot parallel batch, Swarm is cheaper/);
  assert.match(chatSystemPrompt, /a queued, running or timed-out worker is not evidence/i);
  assert.match(chatSystemPrompt, /never spawn a worker just to wait for another worker/);
  assert.match(workerSystemPrompt, /Worker contract:/);
  assert.match(workerSystemPrompt, /host limits nesting to two levels/);
  assert.match(teammateSystemPrompt, /Teammate contract:/);
  assert.match(teammateSystemPrompt, /Claim your shared task before starting/);
  assert.match(TEAM_POLICY, /Lead runbook/);
  assert.match(TEAM_POLICY, /There are no nested teams/);
  assert.match(TEAM_POLICY, /Do not finish while a required member is running/);
  assert.match(teamPolicy('lead'), /do not write the final answer while a required member is still running/);
  assert.match(teamSkill, /## When Teams beat Swarm/);
  assert.match(teamSkill, /## Lead runbook/);
  assert.match(teamSkill, /## Task board conventions/);
  assert.match(teamSkill, /## Member brief template/);
  assert.match(teamSkill, /## Capacity and failure/);
  assert.match(teamSkill, /## Inbox etiquette/);
  assert.match(swarmSkill, /## Slice contract/);
  assert.match(swarmSkill, /## Nested workers/);
  assert.match(swarmSkill, /## When not to delegate/);
  assert.match(swarmSkill, /## Integration checklist/);
});
