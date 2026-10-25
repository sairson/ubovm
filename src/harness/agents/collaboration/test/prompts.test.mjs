import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSystemPrompt, workerSystemPrompt, TEAM_POLICY, teamPolicy, teammateSystemPrompt } from '../prompts.mjs';

test('assist chat prompt defaults to Swarm for assisting tasks', () => {
  assert.match(chatSystemPrompt, /You are the chat coordinator inside UBOVM IDE collaboration mode/);
  assert.match(chatSystemPrompt, /Always reply in the same language the user is using/);
  assert.match(chatSystemPrompt, /default to coordinating Swarm Workers/);
  assert.match(chatSystemPrompt, /Default to Swarm for assisting tasks/);
  assert.match(chatSystemPrompt, /Prefer spawn_worker/);
  assert.match(chatSystemPrompt, /explicit user request to work without workers/);
  assert.doesNotMatch(chatSystemPrompt, /Delegation is optional for simple questions/);
  assert.doesNotMatch(chatSystemPrompt, /coordinate Swarm Workers when useful/);
});

test('assist chat prompt defaults to acting instead of asking for options', () => {
  assert.match(chatSystemPrompt, /default to doing the work/);
  assert.match(chatSystemPrompt, /choose the best reasonable interpretation/);
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

test('assist prompts tell coordinators to prioritize and interrupt workers', () => {
  assert.match(chatSystemPrompt, /spawn_worker writes/);
  assert.match(chatSystemPrompt, /WRITE_OWNERSHIP/);
  assert.match(chatSystemPrompt, /spawn_worker priority 0-9/);
  assert.match(chatSystemPrompt, /preempt=true on spawn/);
  assert.match(chatSystemPrompt, /list_workers.admission/);
  assert.match(chatSystemPrompt, /blocked.reason/);
  assert.match(chatSystemPrompt, /skip_preempt=dependencies/);
  assert.match(chatSystemPrompt, /skip_preempt=no_ready_queued_target/);
  assert.match(chatSystemPrompt, /manage_workers action=prioritize/);
  assert.match(chatSystemPrompt, /manage_workers action=interrupt or cancel_workers/);
  assert.match(workerSystemPrompt, /manage_workers action=prioritize/);
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
  assert.match(workerSystemPrompt, /workers do not inherit this transcript/i);
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

  // Load-bearing tool/API identifiers must survive any future rewrite.
  assert.match(chatSystemPrompt, /expectedHash/);
  assert.match(chatSystemPrompt, /edit_workspace_files/);
  assert.match(chatSystemPrompt, /edit_workspace_file/);
  assert.match(chatSystemPrompt, /read_workspace_code/);
  assert.match(chatSystemPrompt, /read_workspace_change/);
  assert.match(chatSystemPrompt, /recover_workspace_changes/);
  assert.match(chatSystemPrompt, /retrieval/);

  // The acceptance discipline must stay word-for-word, and honest reporting
  // must be present so "wrote the file" is never equated with "tests passed".
  assert.match(
    chatSystemPrompt,
    /For implementation requests, carry the work through investigation, edits and appropriate verification instead of stopping at advice or a plan\./,
  );
  assert.match(chatSystemPrompt, /Write completion is not test passing/);
});

test('Agent Teams policy prefers named teammates for independent workstreams', () => {
  assert.match(TEAM_POLICY, /prefer Agent Teams over Swarm workers/);
  assert.match(TEAM_POLICY, /spawn one named teammate per stream/);
  assert.match(TEAM_POLICY, /shared task board with write scopes and dependencies/);
  assert.match(TEAM_POLICY, /Never put a teammate and a Swarm worker on the same file/);
  assert.match(TEAM_POLICY, /The Lead must wait for required teammates before giving the final answer/);
  assert.match(TEAM_POLICY, /Only the Team Lead creates or interrupts teammates/);
  assert.match(teamPolicy('lead'), /You are the Team Lead named "lead"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /You are teammate "reviewer"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /send_message\(\{ target: "lead"/);
  assert.match(teammateSystemPrompt, /You are a named teammate inside the UBOVM IDE collaboration mode/);
  assert.match(teammateSystemPrompt, /never create or interrupt teammates/);
  assert.match(teammateSystemPrompt, /send_message\(\{ target: "lead"/);
});
