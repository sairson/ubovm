import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInternalTools, MemoryStore } from '../../intools/index.mjs';
import { createKnowledge } from '../index.mjs';
import { LearningLibrary } from '../library.mjs';
import { createKnowledgeReflector } from '../background.mjs';

function record(runtime, id, isError = false) {
  return runtime.onToolResult({ node: { id: 'worker' }, attempt: { id: 'attempt' }, entry: {
    toolCallId: id, toolName: 'read_file', status: 'completed', isError,
    args: { path: '/private/project/file', token: 'private-credential', selector: id },
    result: { content: [{ type: 'text', text: isError ? 'ENOENT: private path missing' : 'Private source contents' }] }
  } });
}
async function setup(t, knowledge = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'passive-learning-'));
  const runtime = await createInternalTools({ sessionId: 'passive', allowedTools: [], knowledge: { libraryFile: join(directory, 'knowledge.sqlite'), ...knowledge } });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, directory };
}

test('actual execution passively learns and persists without exposing a learning tool', async t => {
  const { runtime, directory } = await setup(t);
  assert.deepEqual(await runtime.forWorker('worker'), []);
  await record(runtime, 'first');
  await runtime.flushLearning();
  assert.equal(runtime.learningStatus().processed, 1);
  assert.match(await runtime.contextProvider({ node: { id: 'worker' } }), /Tool practice: read_file/);
  const library = await LearningLibrary.open({ filePath: join(directory, 'knowledge.sqlite') });
  try {
    const lessons = library.list();
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].successes, 0);
    assert.equal(lessons[0].status, 'candidate');
    assert.doesNotMatch(JSON.stringify(lessons), /private-credential|Private source|private\/project/);
    await record(runtime, 'failure', true); await runtime.flushLearning();
    assert.equal(library.list()[0].status, 'needs-review');
    await record(runtime, 'recovery'); await runtime.flushLearning();
    assert.ok(library.list().some(item => item.steps.some(step => /Prior missing resource/.test(step))));
  } finally { library.close(); }
});

test('repair prerequisites survive evidence-window turnover and unrelated library growth', async t => {
  const { runtime, directory } = await setup(t);
  await record(runtime, 'first'); await runtime.flushLearning();
  const library = await LearningLibrary.open({ filePath: join(directory, 'knowledge.sqlite') });
  try {
    const baseline = library.list()[0];
    for (let i = 0; i < 40; i++) library.publish({ title: `read_file unrelated method ${i}`, trigger: 'read_file unrelated usage',
      steps: ['Unrelated candidate'], workerId: 'other', evidence: [{ toolCallId: `other-${i}`, tool: 'read_file' }] }, 'other-session');
    assert.equal(library.list({ title: baseline.title, trigger: baseline.trigger }).length, 1);
    await record(runtime, 'failure', true); await runtime.flushLearning();
    assert.equal(library.list({ title: baseline.title, trigger: baseline.trigger })[0].status, 'needs-review');
    await record(runtime, 'recovery'); await runtime.flushLearning();
    const repaired = library.list({ title: baseline.title, trigger: baseline.trigger })[0];
    assert.equal(repaired.parentId, baseline.id);
    assert.ok(repaired.steps.some(step => /Prior missing resource/.test(step)));
    for (let i = 0; i < 12; i++) { await record(runtime, `later-${i}`); await runtime.flushLearning(); }
    const methods = library.list({ title: baseline.title, trigger: baseline.trigger });
    assert.equal(methods.length, 2);
    assert.equal(methods.find(item => item.id === baseline.id).successes, 0);
    assert.equal(methods.find(item => item.id === baseline.id).status, 'needs-review');
    assert.ok(methods.find(item => item.id === repaired.id).successes > 0);
    assert.ok(runtime.store.knowledgeSnapshot().agentKnowledge.lessons[0].steps.some(step => /Prior missing resource/.test(step)));
    assert.equal(runtime.learningStatus().failed, 0);
    await runtime.close();
    const nextSession = await createInternalTools({ sessionId: 'independent-session', allowedTools: [],
      knowledge: { libraryFile: join(directory, 'knowledge.sqlite') } });
    try {
      await record(nextSession, 'independent-practice'); await nextSession.flushLearning();
      const current = library.list({ title: baseline.title, trigger: baseline.trigger });
      assert.equal(current.length, 2);
      assert.equal(current.find(item => item.id === repaired.id).status, 'practiced');
      assert.equal(current.find(item => item.id === baseline.id).successes, 0);
      assert.ok(nextSession.store.knowledgeSnapshot().agentKnowledge.lessons[0].steps.some(step => /Prior missing resource/.test(step)));
    } finally { await nextSession.close(); }
  } finally { library.close(); }
});

test('slow background reflection does not block tool results and has an independent budget', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime } = await setup(t, { maxReflections: 1, reflect: async () => {
    started(); await gate;
    return [{ title: 'Reusable source inspection', trigger: 'Inspect source', steps: ['Read source', 'Verify contents'], tool_call_ids: ['third'], portable: true }];
  } });
  for (const id of ['first', 'second', 'third']) await record(runtime, id);
  await entered;
  await record(runtime, 'fourth');
  assert.equal(runtime.store.snapshot().toolEvidence.length, 4);
  release(); await runtime.flushLearning();
  assert.equal(runtime.learningStatus().reflections, 1);
  assert.ok(createKnowledge({ store: runtime.store }).inspect({ query: 'Reusable source' }).lessons.some(item => item.title === 'Reusable source inspection'));
});

test('close cancels a non-cooperative reflector and fences late writes', { timeout: 3000 }, async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const { runtime } = await setup(t, { reflect: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  for (const id of ['one', 'two', 'three']) await record(runtime, id);
  await entered;
  await runtime.close();
  const snapshot = runtime.store.snapshot();
  release([{ title: 'Late', trigger: 'Never', steps: ['Late'], tool_call_ids: ['three'], portable: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.store.snapshot(), snapshot);
});

test('invalid reflection evidence stays isolated from foreground execution', async t => {
  const { runtime } = await setup(t, { maxReflections: 1, reflect: async () => [{ title: 'Invented', trigger: 'Any', steps: ['Do it'], tool_call_ids: ['invented'] }] });
  for (const id of ['one', 'two', 'three']) await record(runtime, id);
  await runtime.flushLearning();
  assert.equal(runtime.learningStatus().failures, 1);
  const failed = runtime.store.snapshot().agentKnowledge.queue.jobs.find(job => job.kind === 'reflection');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.errorCode, 'KNOWLEDGE_REFLECTION_INVALID');
  await runtime.flushLearning();
  assert.equal(runtime.learningStatus().reflections, 1);
  assert.equal(runtime.store.snapshot().toolEvidence.length, 3);
  assert.equal(createKnowledge({ store: runtime.store }).inspect({ query: 'Invented' }).lessons.length, 0);
});

test('restoring durable evidence resumes automatic learning without duplicate global feedback', async t => {
  const { runtime, directory } = await setup(t);
  await record(runtime, 'one'); await runtime.flushLearning();
  const store = MemoryStore.fromSnapshot({ snapshot: runtime.store.snapshot() });
  await runtime.close();
  const restored = await createInternalTools({ sessionId: 'passive', store, allowedTools: [], knowledge: { libraryFile: join(directory, 'knowledge.sqlite') } });
  try {
    await restored.flushLearning();
    const library = await LearningLibrary.open({ filePath: join(directory, 'knowledge.sqlite') });
    try { assert.equal(library.list()[0].successes, 0); } finally { library.close(); }
  } finally { await restored.close(); }
});

test('unavailable shared storage does not prevent task execution or local learning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'unavailable-learning-'));
  const events = [];
  const runtime = await createInternalTools({ sessionId: 'local', allowedTools: [], knowledge: { libraryFile: directory, onEvent: event => events.push(event) } });
  try {
    await record(runtime, 'one'); await runtime.flushLearning();
    assert.equal(runtime.store.snapshot().toolEvidence.length, 1);
    assert.equal(runtime.learningStatus().processed, 1);
    assert.ok(events.some(event => event.type === 'knowledge.failed'));
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('model reflection is tool-free and rejects truncated or tool-bearing responses', async () => {
  let request;
  const client = { model: {}, streamFn: async (_model, context, options) => {
    request = { context, options };
    return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '{"lessons":[]}' }] }) };
  } };
  assert.deepEqual(await createKnowledgeReflector(client)({ records: [], signal: new AbortController().signal }), []);
  assert.equal(request.context.tools, undefined);
  assert.equal(request.options.maxTokens, 1200);
  const bad = { ...client, streamFn: async () => ({ result: async () => ({ stopReason: 'length', content: [] }) }) };
  await assert.rejects(createKnowledgeReflector(bad)({ records: [], signal: new AbortController().signal }), /Invalid background/);
});

test('replayed observations do not spend reflection budget; fresh evidence resumes reflection', async t => {
  let reflected = 0;
  const { runtime } = await setup(t, { reflect: async () => { reflected++; return []; } });
  const repeat = id => runtime.onToolResult({ node: { id: 'worker' }, attempt: { id: `attempt-${id}` }, entry: {
    toolCallId: id, toolName: 'read_file', status: 'completed', isError: false,
    args: { path: '/same/file' }, result: { content: [{ type: 'text', text: 'identical output' }] }
  } });
  for (let i = 0; i < 6; i++) await repeat(`repeat-${i}`);
  await runtime.flushLearning();
  assert.equal(reflected, 0);
  for (const id of ['fresh-1', 'fresh-2', 'fresh-3']) await record(runtime, id);
  await runtime.flushLearning();
  assert.equal(reflected, 1);
});

test('reflection compares historical failure methods and preserves host-authenticated failure references', async t => {
  let previous;
  const { runtime, directory } = await setup(t, { reflect: async ({ records, previousLessons }) => {
    previous = previousLessons;
    return [{ title: 'Recovery inspection', trigger: 'Check source after a missing path',
      steps: ['Check the path exists', 'Read the source', 'Verify the requested contents'],
      tool_call_ids: [records.at(-1).toolCallId], failure_call_ids: ['failure'], portable: true }];
  } });
  await record(runtime, 'first'); await runtime.flushLearning();
  await record(runtime, 'failure', true); await runtime.flushLearning();
  await record(runtime, 'recovery'); await runtime.flushLearning();
  assert.ok(previous.some(item => item.status === 'needs-review' || item.familyFailures > 0));
  const library = await LearningLibrary.open({ filePath: join(directory, 'knowledge.sqlite') });
  try {
    const repair = library.list().find(item => item.title === 'Recovery inspection');
    assert.equal(repair.source.failureEvidence[0].toolCallId, 'failure');
    const baseRepair = library.list().find(item => item.parentId);
    assert.equal(baseRepair.familyFailures, 1);
    assert.equal(baseRepair.successes, 0);
    assert.equal(baseRepair.needsValidation, true);
    assert.equal(library.list().find(item => item.id === baseRepair.parentId).successes, 0);
  } finally { library.close(); }
});
