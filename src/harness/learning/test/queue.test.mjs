import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { jobEvidence } from '../queue.mjs';
import { createBackgroundLearning } from '../runner.mjs';

test('scheduler processes evidence and reports status without copying full snapshots', async t => {
  const store = new MemoryStore({ sessionId: 'lightweight' });
  assert.deepEqual(store.learningJobs(), []);
  await store.commit(state => {
    state.toolEvidence = [{ workerId: 'worker', toolCallId: 'call', digest: 'hash', status: 'completed',
      toolName: 'read_file', isError: true, observations: 'ENOENT', learningInputKeys: [] }];
  });
  t.mock.method(store, 'snapshot', () => { throw new Error('full snapshot must not be read by scheduler'); });
  const knowledge = { tool: () => ({ execute: async () => { throw new Error('no successful evidence to learn'); } }),
    inspect: () => ({ libraryAvailable: false, lessons: [] }) };
  const runtime = createBackgroundLearning({ store, knowledge });
  t.after(() => runtime.close());
  await runtime.flush();
  assert.equal(runtime.status().processed, 1);
  assert.equal(runtime.status().completed, 1);
  const jobs = store.learningJobs();
  jobs[0].status = 'pending'; jobs.push({ id: 'injected' });
  assert.equal(store.learningJobs().length, 1);
  assert.equal(runtime.status().completed, 1);
});

test('selected learning evidence remains detached and rejects stale digests', async () => {
  const store = new MemoryStore({ sessionId: 'evidence' });
  await store.commit(state => { state.toolEvidence = [
    { workerId: 'other', toolCallId: 'call', digest: 'hash', text: 'other' },
    { workerId: 'worker', toolCallId: 'call', digest: 'hash', text: 'original' }
  ]; });
  const job = { workerId: 'worker', refs: [{ toolCallId: 'call', digest: 'hash' }] };
  jobEvidence(store, job)[0].text = 'changed';
  assert.equal(jobEvidence(store, job)[0].text, 'original');
  job.refs[0].digest = 'stale';
  assert.throws(() => jobEvidence(store, job), /missing or changed/);
  job.refs[0].toolCallId = 'missing';
  assert.throws(() => jobEvidence(store, job), /missing or changed/);
});

test('job metadata preserves checkpoint presence without copying candidate bodies', async () => {
  const store = new MemoryStore({ sessionId: 'candidates' });
  await store.commit(state => { state.agentKnowledge = { queue: { jobs: [
    { id: 'saved', kind: 'reflection', status: 'pending', nextAttemptAt: 0, candidates: [] },
    { id: 'new', kind: 'reflection', status: 'pending', nextAttemptAt: 1 }
  ] } }; });
  assert.deepEqual(store.learningJobs(), [
    { id: 'saved', kind: 'reflection', status: 'pending', nextAttemptAt: 0, hasCandidates: true },
    { id: 'new', kind: 'reflection', status: 'pending', nextAttemptAt: 1, hasCandidates: false }
  ]);
});
