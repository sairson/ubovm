import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { buildExplorationAgenda, agendaDuplicate, renderAgenda, EXPLORATION_STOP_MARKER } from '../agenda.mjs';

async function fixture() {
  const board = new Blackboard({ sessionId: 'agenda-board', goal: 'verify the target' });
  const pending = await board.createIntent({ description: 'Queued header audit', keyPoints: ['headers'], priority: 'high' });
  const running = await board.createIntent({ description: 'Running CSP audit', keyPoints: ['csp'] });
  const runningAttempt = await board.beginAttempt(running.id);
  await board.saveCheckpoint(running.id, runningAttempt.id, { kind: 'ubovm.pi-worker', version: 1, phase: 'execute',
    plan: [{ description: 'Collect response headers' }, { description: 'Compare CSP directives' }], completed: [] });
  const done = await board.createIntent({ description: 'Completed TLS audit', keyPoints: ['tls'] });
  const doneAttempt = await board.beginAttempt(done.id);
  const fact = {
    version: 1, outcome: 'partial', statement: 'TLS present but cipher list incomplete',
    coverage: [{ point: 'tls', status: 'partial', result: 'handshake verified, ciphers unread' }],
    evidence: [], limitations: ['cipher list requires an extra probe']
  };
  await board.completeAttempt(done.id, doneAttempt.id, JSON.stringify(fact));
  const failed = await board.createIntent({ description: 'Failed DNS audit', keyPoints: ['dns'] });
  const failedAttempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, failedAttempt.id, 'resolver timed out');
  const dropped = await board.createIntent({ description: 'Dropped duplicate audit', keyPoints: ['duplicate'] });
  const droppedAttempt = await board.beginAttempt(dropped.id);
  await board.failAttempt(dropped.id, droppedAttempt.id, EXPLORATION_STOP_MARKER + 'duplicate of n2', { interrupted: true });
  const store = new MemoryStore({ sessionId: 'agenda-board' });
  await store.commit(state => {
    state.agenda = [
      { id: 'direction-1', worker_id: 'reason', content: 'Check cache poisoning via CDN edge', status: 'planned',
        dedupe_key: 'cache poisoning via cdn edge', method: 'send conflicting cache headers', acceptance: 'edge returns both variants', created_at: 'x', updated_at: 'x' },
      { id: 'direction-2', worker_id: 'reason', content: 'Old direction', status: 'dropped', created_at: 'x', updated_at: 'x' }
    ];
  });
  return { board, store, ids: { pending: pending.id, running: running.id, done: done.id, failed: failed.id, dropped: dropped.id } };
}

test('agenda projects intent status, Worker plan steps, evidence and gaps', async () => {
  const { board, store } = await fixture();
  const agenda = buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  const byTitle = title => agenda.items.find(item => item.title === title);
  assert.equal(byTitle('Queued header audit').status, 'planned');
  assert.equal(byTitle('Queued header audit').priority, 'high');
  const running = byTitle('Running CSP audit');
  assert.equal(running.status, 'active');
  assert.deepEqual(running.planSteps, ['Collect response headers', 'Compare CSP directives']);
  assert.equal(running.currentStep, 'Collect response headers');
  const done = byTitle('Completed TLS audit');
  assert.equal(done.status, 'done');
  assert.match(done.evidenceRef, /^n\d+$/);
  assert.equal(done.gaps.length, 2, 'partial coverage and self-reported limitation become gaps');
  assert.equal(byTitle('Failed DNS audit').status, 'blocked');
  assert.equal(byTitle('Failed DNS audit').blocker, 'resolver timed out');
  assert.equal(byTitle('Dropped duplicate audit').status, 'dropped');
  assert.equal(byTitle('Check cache poisoning via CDN edge').kind, 'direction');
  assert.equal(byTitle('Check cache poisoning via CDN edge').method, 'send conflicting cache headers');
  assert.equal(byTitle('Old direction').status, 'dropped');
  assert.equal(agenda.counts.planned >= 1, true);
  assert.equal(agenda.counts.active, 1);
  assert.equal(agenda.counts.done, 1);
  assert.equal(agenda.counts.blocked, 1);
  assert.equal(agenda.counts.dropped, 2);
  // Derived suggestions never create work; they only point at the gap / different method.
  assert(agenda.items.some(item => item.kind === 'suggestion' && /换一种方法/.test(item.title)));
  assert(agenda.items.some(item => item.kind === 'suggestion' && /补充验证/.test(item.title)));
  const text = renderAgenda(agenda);
  assert.match(text, /# Shared exploration agenda/);
  assert.match(text, /never rerun completed content/);
  assert.match(text, /current: Collect response headers/);
  assert.match(text, /blocker: resolver timed out/);
});

test('agenda duplicate lookup catches identical and agenda-recorded descriptions', async () => {
  const { board, store } = await fixture();
  const agenda = buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  assert.equal(agendaDuplicate(agenda, '  running csp AUDIT ')?.kind, 'intent');
  assert.equal(agendaDuplicate(agenda, 'Cache poisoning via CDN edge')?.kind, 'direction');
  assert.equal(agendaDuplicate(agenda, 'a genuinely new check'), undefined);
});

test('memory store persists Reason agenda directions and accepts legacy snapshots without the field', async () => {
  const { store } = await fixture();
  const restored = MemoryStore.fromSnapshot({ snapshot: store.snapshot() });
  assert.equal(restored.snapshot(['agenda']).agenda.length, 2);
  const legacy = store.snapshot();
  delete legacy.agenda;
  assert.deepEqual(MemoryStore.fromSnapshot({ snapshot: legacy }).snapshot(['agenda']).agenda, []);
  await assert.rejects(store.commit(state => { state.agenda[0].status = 'unknown'; }), /Invalid memory agenda/);
  await assert.rejects(store.commit(state => { state.agenda[0].worker_id = 'worker'; }), /Invalid agenda owner/);
});
