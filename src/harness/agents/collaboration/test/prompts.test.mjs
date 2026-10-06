import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSystemPrompt, workerSystemPrompt } from '../prompts.mjs';

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
  assert.match(workerSystemPrompt, /Spawn further Swarm Workers for independent subtasks/);
  assert.match(workerSystemPrompt, /do not re-delegate the entire assignment/);
  assert.match(workerSystemPrompt, /workers do not inherit this transcript/i);
});
