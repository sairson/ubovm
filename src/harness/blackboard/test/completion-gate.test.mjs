import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';

const factBody = () => JSON.stringify({
  version: 1,
  statement: 'Observed the scoped result',
  outcome: 'confirmed',
  coverage: [{ point: 'verify', status: 'confirmed', result: 'Passed' }],
  evidence: [{ toolCallId: 'check', observation: 'Control passed' }],
  nextSteps: []
});

async function boardWithEvidence() {
  const board = new Blackboard({ sessionId: 'completion-gate', goal: 'penetration test example.com' });
  const intent = await board.createIntent({ description: 'probe login', keyPoints: ['verify'] });
  const attempt = await board.beginAttempt(intent.id);
  await board.completeAttempt(intent.id, attempt.id, factBody());
  return board;
}

test('a host completion gate rejection re-reviews instead of failing the run', async () => {
  const board = await boardWithEvidence();
  const calls = { reason: 0, guard: 0 };
  const completed = await new BlackboardCoordinator({
    blackboard: board,
    maxRounds: 4,
    reason: async () => { calls.reason++; return { complete: true, summary: 'Scope verified', evidenceIds: ['n3'] }; },
    worker: async () => { throw new Error('no worker should run'); },
    completionGuard: async () => {
      calls.guard++;
      return calls.guard === 1
        ? { issue: 'Coverage gate: 1 of 2 hosts are untested' }
        : { issue: null, surface: { status: 'warn', code: 'COVERAGE_INCOMPLETE' } };
    }
  }).run();
  assert.equal(completed.complete, true);
  assert.equal(calls.guard, 2);
  assert.equal(calls.reason, 2);
  assert.equal(completed.surfaceGate.status, 'warn');
});

test('a permanently blocked completion stops with SURFACE_GATE_BLOCKED', async () => {
  const board = await boardWithEvidence();
  let guardCalls = 0;
  await assert.rejects(new BlackboardCoordinator({
    blackboard: board,
    maxRounds: 10,
    reason: async () => ({ complete: true, summary: 'Scope verified', evidenceIds: ['n3'] }),
    worker: async () => { throw new Error('no worker should run'); },
    completionGuard: async () => { guardCalls++; return { issue: 'Coverage gate: 1 of 2 hosts are untested' }; }
  }).run(), error => error?.code === 'SURFACE_GATE_BLOCKED' && /rejected 6 times/.test(error.message));
  assert.equal(guardCalls, 6);
});
