import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFingerprint, learningRequestFingerprint } from '../fingerprint.mjs';
import { LearningLibrary } from '../library.mjs';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createKnowledge } from '../index.mjs';

const record = (id, sessionId = 's', workerId = 'w', args = { resource: id }, isError = false) => ({
  sessionId, workerId, toolCallId: id, attemptId: `attempt-${id}`, toolName: 'read_file', status: 'completed', isError,
  learningRequestFingerprint: learningRequestFingerprint({ toolName: 'read_file', args }),
  learningFingerprint: learningFingerprint({ toolName: 'read_file', args, isError, result: { content: [{ type: 'text', text: isError ? 'ENOENT' : 'Source' }] } })
});
const method = (source, steps = ['Read source', 'Check result']) => ({
  title: 'Inspect source', trigger: 'Source inspection', steps, workerId: source.workerId,
  evidence: [{ toolCallId: source.toolCallId, tool: source.toolName, learningFingerprint: source.learningFingerprint,
    learningRequestFingerprint: source.learningRequestFingerprint }]
});
const assess = (library, id, source, outcome = source.isError ? 'failure' : 'success') => library.feedback(id, {
  sessionId: source.sessionId, workerId: source.workerId, records: [source], outcome
});

test('execution fingerprint ignores IDs and object ordering but retains inputs and outputs', () => {
  const entry = { toolName: 'read_file', args: { b: 2, a: { y: 4, x: 3 } }, result: { content: [{ type: 'text', text: 'data' }] } };
  const duplicate = { ...entry, toolCallId: 'new', durationMs: 100, args: { a: { x: 3, y: 4 }, b: 2 } };
  assert.equal(learningFingerprint(entry), learningFingerprint(duplicate));
  assert.notEqual(learningFingerprint(entry), learningFingerprint({ ...entry, args: { a: 5 } }));
  assert.notEqual(learningFingerprint(entry), learningFingerprint({ ...entry, result: { content: [] } }));
  assert.equal(learningRequestFingerprint(entry), learningRequestFingerprint({ ...entry, result: { content: [] } }));
});

test('replay across sessions and workers never earns credit; novel cross-session observations can', async t => {
  const library = await LearningLibrary.open({ filePath: ':memory:' });
  t.after(() => library.close());
  const origin = record('origin');
  const { id } = library.publish(method(origin), origin.sessionId);
  assert.equal(assess(library, id, record('clone', 'different', 'other', { resource: 'origin' })).recorded, false);
  assert.equal(assess(library, id, { ...record('volatile', 'other-session', 'other', { resource: 'origin' }),
    learningFingerprint: learningFingerprint({ toolName: 'read_file', args: { resource: 'origin' }, result: { durationMs: 1234 } }) }).recorded, false);
  const fresh = record('fresh', 'second');
  assert.equal(assess(library, id, fresh).recorded, true);
  assert.equal(assess(library, id, record('clone-fresh', 'third', 'another', { resource: 'fresh' })).recorded, false);
  assert.equal(library.list()[0].successes, 1);
  assess(library, id, record('other-fresh', 'third'));
  assert.equal(library.list()[0].status, 'practiced');
  assert.equal(library.list()[0].independentSessions, 2);
  assert.throws(() => assess(library, id, { ...record('foreign'), toolName: 'send_email' }), /does not match/);
  assert.equal(assess(library, id, { ...record('legacy'), learningFingerprint: undefined }).recorded, false);
});

test('repairs preserve lineage and warnings without transferring credit or recycling evidence', async t => {
  const library = await LearningLibrary.open({ filePath: ':memory:' });
  t.after(() => library.close());
  const origin = record('origin');
  const first = library.publish(method(origin), 's');
  assess(library, first.id, record('failure', 's', 'w', undefined, true));
  assert.throws(() => library.publish(method(origin, ['Read source', 'Retry']), 's'), /new host-recorded/);
  const revised = library.publish(method(record('repair'), ['Verify path', 'Read source', 'Check result']), 's');
  const next = library.list().find(item => item.id === revised.id);
  assert.equal(next.parentId, first.id);
  assert.equal(next.familyFailures, 1);
  assert.equal(next.successes, 0);
  assert.equal(next.needsValidation, true);
  const trial = record('trial', 'second');
  assess(library, revised.id, trial);
  assert.equal(assess(library, first.id, trial).recorded, false);
  assert.equal(library.list().find(item => item.id === first.id).status, 'needs-review');
  assert.equal(library.list().find(item => item.id === revised.id).successes, 1);
  assess(library, first.id, record('recovery', 'third'));
  assert.equal(library.list().find(item => item.id === first.id).failures, 0);
  assert.notEqual(library.list().find(item => item.id === first.id).status, 'needs-review');
});

test('local capability assessment cannot be improved by repeating identical observations', async () => {
  const store = new MemoryStore({ sessionId: 's' });
  await store.commit(state => { state.toolEvidence = Array.from({ length: 25 }, (_, i) => ({ ...record(`call-${i}`, 's', `worker-${i}`, { resource: 'same' }), digest: `digest-${i}` })); });
  const knowledge = createKnowledge({ store });
  const capability = knowledge.inspect().capabilities[0];
  assert.equal(capability.successes, 25);
  assert.equal(capability.novelObservations, 1);
  assert.equal(capability.distinctPracticeAttempts, 1);
  assert.equal(capability.needsPractice, true);
  await store.flush();
});

test('independent library writers cannot claim the same observation twice and claims survive reopen', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'knowledge-claims-'));
  const path = join(root, 'library.sqlite');
  const a = await LearningLibrary.open({ filePath: path });
  const b = await LearningLibrary.open({ filePath: path });
  t.after(async () => { a.close(); b.close(); await rm(root, { recursive: true, force: true }); });
  const { id } = a.publish(method(record('origin')), 's');
  const fresh = record('trial', 'second');
  assert.equal(assess(a, id, fresh).recorded, true);
  assert.equal(assess(b, id, record('replay', 'third', 'other', { resource: 'trial' })).recorded, false);
  a.close(); b.close();
  const reopened = await LearningLibrary.open({ filePath: path });
  try {
    assert.equal(assess(reopened, id, record('replayed-again', 'fourth', 'another', { resource: 'trial' })).recorded, false);
    assert.equal(reopened.list()[0].successes, 1);
  } finally { reopened.close(); }
});

test('renaming methods cannot multiply credit or recycle another methods publication evidence', async t => {
  const library = await LearningLibrary.open({ filePath: ':memory:' });
  t.after(() => library.close());
  const first = library.publish(method(record('origin')), 's');
  const renamed = library.publish({ ...method(record('different-origin')), title: 'Renamed inspection' }, 's');
  const trial = record('fresh', 'second');
  assert.equal(assess(library, first.id, trial).recorded, true);
  assert.equal(assess(library, renamed.id, trial).recorded, false);
  assert.equal(assess(library, renamed.id, record('cloned', 'third', 'other', { resource: 'fresh' })).recorded, false);
  assert.equal(assess(library, renamed.id, record('source-clone', 'fourth', 'other', { resource: 'origin' })).recorded, false);
  assert.equal(library.list().find(item => item.id === renamed.id).successes, 0);
});

test('rejected mixed feedback rolls back all global claims before a valid retry', async t => {
  const library = await LearningLibrary.open({ filePath: ':memory:' });
  t.after(() => library.close());
  const { id } = library.publish(method(record('origin')), 's');
  const good = record('valid', 'second');
  const foreign = { ...record('foreign', 'second'), toolName: 'send_email' };
  assert.throws(() => library.feedback(id, { sessionId: 'second', workerId: 'w', records: [good, foreign], outcome: 'success' }), /does not match/);
  assert.equal(library.list()[0].successes, 0);
  assert.equal(assess(library, id, good).recorded, true);
  assert.equal(library.list()[0].successes, 1);
});
