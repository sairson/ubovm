import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createInternalTools } from '../../intools/index.mjs';
import { createKnowledge } from '../index.mjs';

const lesson = { action: 'learn', title: 'Read source', trigger: 'Inspect source code', steps: ['Read the requested file', 'Check the returned contents'], tool_call_ids: ['read-1'] };
const observation = (id, isError = false, toolName = 'read_file') => ({
  sessionId: 'test', workerId: 'worker', attemptId: 'attempt', toolCallId: id, toolName,
  status: 'completed', isError, digest: `digest-${id}`, observations: isError ? 'File missing: inspect the path before retry' : 'Source code was read', imageCount: 0
});

test('recall warns when local evidence changes and ranks practiced methods before equal candidates', async () => {
  const library = { list: () => [
    { id: 'review', title: 'Read source', trigger: 'Inspect source', steps: ['Check'], status: 'needs-review', updatedAt: '2099-01-01', scope: 'library' },
    { id: 'practiced', title: 'Read source', trigger: 'Inspect source', steps: ['Check'], status: 'practiced', updatedAt: '2000-01-01', scope: 'library' }
  ] };
  const { store, knowledge } = await setup({ library });
  await knowledge.tool('worker').execute('learn', lesson);
  assert.equal(knowledge.inspect({ query: 'source' }).lessons[0].id, 'practiced');
  await store.commit(state => { state.toolEvidence[0].digest = 'changed'; });
  assert.equal(knowledge.inspect({ limit: 32 }).lessons.find(item => item.scope === 'session').status, 'needs-review');
  assert.match(await knowledge.context(), /needs-review/);
});

test('metadata tools cannot establish learning and failed revision evidence is authenticated', async () => {
  const { store, knowledge } = await setup();
  await store.commit(state => { state.toolEvidence.push(observation('metadata', false, 'load_skill'), observation('failed', true)); });
  await assert.rejects(knowledge.tool('worker').execute('learn', { ...lesson, tool_call_ids: ['metadata'] }), /successful host-recorded/);
  await assert.rejects(knowledge.tool('worker').execute('learn', { ...lesson, failure_call_ids: ['read-1'] }), /actual failed evidence/);
  await assert.rejects(knowledge.tool('worker').execute('learn', { ...lesson, failure_call_ids: ['missing'] }), /actual failed evidence/);
  await assert.rejects(knowledge.tool('worker').execute('learn', { ...lesson, failure_call_ids: ['failed'] }), /followed by successful/);
  await store.commit(state => { state.toolEvidence.push(observation('recovered')); });
  const learned = (await knowledge.tool('worker').execute('learn', { ...lesson, tool_call_ids: ['recovered'], failure_call_ids: ['failed'] })).details;
  assert.equal(learned.failureEvidence[0].toolCallId, 'failed');
  assert.equal(knowledge.inspect().capabilities.some(item => item.tool === 'load_skill'), false);
});

test('failure warnings survive ranking limits and a tight context budget', async () => {
  const library = { list: () => [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `candidate-${i}`, title: 'Read source', trigger: 'Inspect source',
      steps: ['Read', 'Check'], status: 'candidate', scope: 'library', updatedAt: '2099-01-01' })),
    { id: 'failed-method', familyId: 'failed-family', title: 'Read source', trigger: 'Inspect source', steps: ['Check'],
      status: 'needs-review', familyFailures: 1, scope: 'library', updatedAt: '2000-01-01' }
  ] };
  const { store, knowledge } = await setup({ library, maxContextChars: 1000 });
  const result = knowledge.inspect({ query: 'source', limit: 1 });
  assert.equal(result.lessons[0].id, 'candidate-0');
  assert.equal(result.warnings[0].id, 'failed-method');
  const context = await knowledge.context({ query: 'source' });
  assert.ok(context.length <= 1000);
  assert.equal(JSON.parse(context.slice(context.indexOf('\n') + 1)).warnings[0].id, 'failed-method');
  await knowledge.tool('worker').execute('learn', { ...lesson, tool_call_ids: ['read-1'] });
  await store.commit(state => { state.toolEvidence.push(observation('failed', true), observation('recovery')); });
  await knowledge.tool('worker').execute('learn', { ...lesson, tool_call_ids: ['recovery'], failure_call_ids: ['failed'] });
  await store.commit(state => { state.toolEvidence.find(item => item.toolCallId === 'failed').digest = 'changed'; });
  assert.equal(knowledge.inspect({ limit: 32 }).lessons.find(item => item.scope === 'session').status, 'needs-review');
});

test('host method lookup reads detached lessons without copying evidence or the learning queue', async () => {
  const { store, knowledge } = await setup();
  await knowledge.tool('worker').execute('learn', lesson);
  await store.commit(state => { state.agentKnowledge.queue = { version: 1, cursor: 0, jobs: [], windows: [] }; });
  const original = store.snapshot;
  store.snapshot = () => { throw new Error('Whole memory must not be read for method lookup'); };
  try {
    const result = knowledge.methods({ title: lesson.title, trigger: lesson.trigger });
    assert.equal(result.length, 1);
    result[0].steps[0] = 'modified';
    const snapshot = store.knowledgeSnapshot();
    assert.equal(snapshot.agentKnowledge.queue, undefined);
    assert.equal(snapshot.toolEvidence, undefined);
    assert.equal(knowledge.methods({ title: lesson.title, trigger: lesson.trigger })[0].steps[0], lesson.steps[0]);
    assert.equal(knowledge.methods({ title: 'unrelated', trigger: 'other' }).length, 0);
  } finally { store.snapshot = original; }
});
async function setup(options = {}) {
  const store = new MemoryStore({ sessionId: 'test' });
  await store.commit(state => { state.toolEvidence = [observation('read-1')]; });
  return { store, knowledge: createKnowledge({ store, ...options }) };
}

test('automatically derives weaknesses, recovery and bounded evidence from tool outcomes', async () => {
  const { store, knowledge } = await setup();
  await store.commit(state => { state.toolEvidence.push(observation('read-2', true)); });
  let capability = knowledge.inspect().capabilities[0];
  assert.equal(capability.successRate, 0.5);
  assert.equal(capability.needsPractice, true);
  assert.equal(capability.lastFailure.toolCallId, 'read-2');
  await store.commit(state => { state.toolEvidence.push(observation('read-3')); });
  capability = knowledge.inspect().capabilities[0];
  assert.equal(capability.needsPractice, true);
  assert.equal(capability.distinctPracticeAttempts, 0);
  assert.equal(capability.successes, 2);
  assert.match(await knowledge.context(), /candidate methods/);
});

test('learning rejects missing, failed and other-worker evidence; remains a candidate', async () => {
  const { store, knowledge } = await setup();
  await store.commit(state => { state.toolEvidence.push(observation('failed', true)); });
  for (const id of ['missing', 'failed']) {
    await assert.rejects(knowledge.tool('worker').execute('learn', { ...lesson, tool_call_ids: [id] }), /successful host-recorded/);
  }
  await assert.rejects(knowledge.tool('other').execute('learn', lesson), /owned by this worker/);
  const result = await knowledge.tool('worker').execute('learn', lesson);
  assert.equal(result.details.status, 'candidate');
  assert.equal(result.details.evidence[0].digest, 'digest-read-1');
  assert.equal(knowledge.inspect({ query: 'Inspect source' }).lessons.length, 1);
  assert.equal(knowledge.inspect({ query: 'Read source' }).lessons.length, 1);
});

test('concurrent duplicate learning updates one lesson and capacity is enforced', async () => {
  const { knowledge } = await setup({ maxLessons: 1 });
  const tool = knowledge.tool('worker');
  await Promise.all(Array.from({ length: 4 }, () => tool.execute('learn', lesson)));
  assert.equal(knowledge.inspect().lessons.length, 1);
  await assert.rejects(tool.execute('learn', { ...lesson, title: 'Different' }), /capacity/);
  const id = knowledge.inspect().lessons[0].id;
  await assert.rejects(knowledge.tool('other').execute('forget', { action: 'forget', id }), /owner/);
  await tool.execute('forget', { action: 'forget', id });
  assert.equal(knowledge.inspect().lessons.length, 0);
});

test('evidence and procedures survive file-backed store reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'memory.json');
  const store = await MemoryStore.open({ filePath, sessionId: 'test' });
  await store.commit(state => { state.toolEvidence = [observation('read-1')]; });
  const first = createKnowledge({ store });
  await first.tool('worker').execute('learn', lesson);
  const restored = createKnowledge({ store: await MemoryStore.open({ filePath, sessionId: 'test' }) });
  assert.deepEqual(restored.inspect(), first.inspect());
});

test('failed persistence and cancellation publish no learned state', async () => {
  const { store } = await setup();
  const failing = MemoryStore.fromSnapshot({ snapshot: store.snapshot(), persist: async () => { throw new Error('disk full'); } });
  const tool = createKnowledge({ store: failing }).tool('worker');
  await assert.rejects(tool.execute('learn', lesson), /disk full/);
  assert.equal(failing.snapshot().agentKnowledge, undefined);
  await assert.rejects(tool.execute('learn', lesson, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
});

test('context budget preserves complete JSON and multilingual retrieval works', async () => {
  const { knowledge, store } = await setup({ maxContextChars: 1000 });
  await knowledge.tool('worker').execute('learn', { ...lesson, title: '读取文件', trigger: '检查源码', steps: ['读取代码文件'] });
  assert.equal(knowledge.inspect({ query: '源码检查' }).lessons.length, 1);
  const context = await knowledge.context();
  assert.ok(context.length <= 1000);
  assert.doesNotThrow(() => JSON.parse(context.slice(context.indexOf('\n') + 1)));
  assert.equal(await createKnowledge({ store, maxContextChars: 10 }).context(), '');
});

test('runtime learns automatically, deduplicates evidence and injects experience next turn', async t => {
  const runtime = await createInternalTools({ sessionId: 'test', allowedTools: ['learn_capability'] });
  t.after(() => runtime.close());
  const binding = { node: { id: 'worker' }, attempt: { id: 'attempt' } };
  const entry = { toolCallId: 'read-1', toolName: 'read_file', status: 'completed', isError: false, result: { content: [{ type: 'text', text: 'Source code was read' }] } };
  await runtime.onToolResult({ ...binding, entry });
  await runtime.onToolResult({ ...binding, entry });
  const [tool] = await runtime.tools(binding);
  await tool.execute('learn', lesson);
  assert.equal(createKnowledge({ store: runtime.store }).inspect().capabilities[0].successes, 1);
  assert.match(await runtime.contextProvider(binding), /Read source/);
  await assert.doesNotReject(runtime.contextProvider({ node: { id: 'worker', intent: { description: 'source '.repeat(1000) } } }));
});

test('learning can be disabled and tool allowlists remain enforced', async t => {
  const disabled = await createInternalTools({ sessionId: 'test', knowledge: false, allowedTools: ['learn_capability'] });
  const restricted = await createInternalTools({ sessionId: 'test', allowedTools: [] });
  t.after(() => Promise.all([disabled.close(), restricted.close()]));
  assert.deepEqual(await disabled.forWorker('worker'), []);
  assert.deepEqual(await restricted.forWorker('worker'), []);
  assert.doesNotMatch(await disabled.contextProvider({ node: { id: 'worker' } }), /Learned experience/);
});

test('corrupted knowledge versions and lessons fail explicitly', async () => {
  const { store } = await setup();
  for (const agentKnowledge of [{ version: 2, lessons: [] }, { version: 1, lessons: [{}] }]) {
    const restored = MemoryStore.fromSnapshot({ snapshot: { ...store.snapshot(), agentKnowledge } });
    assert.throws(() => createKnowledge({ store: restored }), /knowledge/);
  }
});
