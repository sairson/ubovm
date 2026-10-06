import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createKnowledge } from '../index.mjs';
import { enqueueLearningWork } from '../queue.mjs';
import { evaluateLearningGate } from '../gate.mjs';
import { learningFingerprint, learningRequestFingerprint } from '../fingerprint.mjs';

const call = (id, tool, observation, isError = true, extra = {}) => ({
  sessionId: 's', workerId: 'worker', attemptId: 'attempt', toolCallId: id, toolName: tool, status: 'completed',
  isError, digest: id, observations: observation, ...extra,
  learningFingerprint: learningFingerprint({ toolName: tool, args: { id }, isError, result: { observation } }),
  learningRequestFingerprint: learningRequestFingerprint({ toolName: tool, args: { id } })
});

test('caller errors and probe bursts do not indict a tool or enter the learning queue', async () => {
  const store = new MemoryStore({ sessionId: 's' });
  await store.commit(state => {
    state.toolEvidence = [
      call('spawn', 'spawn_worker', "must NOT have additional properties: 'description'"),
      call('list', 'list_workspace_files', "ENOENT: realpath 'selftest'"),
      call('search', 'search_workspace', 'rg: regex parse error: unclosed group'),
      call('python', 'run_python', 'No such file or directory: data.csv'),
      call('ok', 'read_workspace_file', 'exists:true', false)
    ];
    enqueueLearningWork(state);
  });
  const knowledge = createKnowledge({ store });
  const byTool = Object.fromEntries(knowledge.inspect({ limit: 32 }).capabilities.map(item => [item.tool, item]));
  assert.equal(byTool.spawn_worker.callerErrors, 1);
  assert.equal(byTool.spawn_worker.failures, 0);
  assert.equal(byTool.spawn_worker.retryAdvice, 'none');
  assert.equal(byTool.list_workspace_files.attribution, 'env_prereq');
  assert.match(byTool.list_workspace_files.retryAdvice, /confirm the directory exists/);
  assert.equal(byTool.search_workspace.callerErrors, 1);
  assert.match(byTool.run_python.retryAdvice, /workspace directory or an absolute path/);
  assert.equal(knowledge.inspect({ limit: 32 }).warnings.some(item => item.id === 'tool:spawn_worker'), false);
  assert.equal(knowledge.inspect({ limit: 32 }).warnings.find(item => item.id === 'tool:list_workspace_files').status, 'prerequisite');
  const queued = new Set(store.snapshot().agentKnowledge.queue.jobs.flatMap(job => job.refs.map(ref => ref.toolCallId)));
  assert.equal(queued.has('spawn'), false);
  assert.equal(queued.has('search'), false);
  assert.equal(queued.has('list'), true);
});

test('a caller-error burst across tools is probe noise and stays out of the failure rate', async () => {
  const store = new MemoryStore({ sessionId: 's' });
  await store.commit(state => {
    state.toolEvidence = [
      call('a', 'spawn_worker', 'unexpected property description'),
      call('b', 'search_workspace', 'invalid regex'),
      call('c', 'list_workspace_files', 'must NOT have additional properties'),
      call('kept', 'read_workspace_file', 'internal error: engine missing')
    ];
  });
  const capability = createKnowledge({ store }).inspect({ limit: 32 }).capabilities;
  const read = capability.find(item => item.tool === 'read_workspace_file');
  const spawned = capability.find(item => item.tool === 'spawn_worker');
  assert.equal(read.attribution, 'tool_defect');
  assert.equal(read.successRate, 0);
  assert.equal(spawned.probes, 1);
  assert.equal(spawned.failures, 0);
  assert.equal(spawned.retryAdvice, 'none');
  assert.equal(createKnowledge({ store }).inspect({ limit: 32 }).warnings.filter(item => item.status === 'needs-review').length, 1);
});

test('a tool-behavior claim without the raw observation is inferred', async () => {
  const store = new MemoryStore({ sessionId: 's' });
  const seen = 'read_workspace_file returned exists:false for selftest/app.js';
  await store.commit(state => {
    state.toolEvidence = [call('read', 'read_workspace_file', seen, false)];
  });
  const knowledge = createKnowledge({ store });
  await knowledge.tool('worker').execute('learn', {
    action: 'learn', title: 'read_workspace_file throws ENOENT', trigger: 'Before asserting tool behavior',
    steps: ['Treat a missing file as a hard error'], tool_call_ids: ['read']
  });
  assert.equal(knowledge.inspect({ query: 'ENOENT' }).lessons[0].status, 'inferred');
  await knowledge.tool('worker').execute('learn', {
    action: 'learn', title: 'Missing reads are soft', trigger: 'Assert only this session output',
    steps: [`Quote the raw result: ${seen}`], tool_call_ids: ['read']
  });
  assert.equal(knowledge.inspect({ query: 'Missing reads' }).lessons[0].status, 'candidate');
  assert.equal((await knowledge.context({ query: 'ENOENT' })).includes('throws ENOENT'), false);
});

test('a soft missing path is not a success, and the identical call stops after one confirmation', async () => {
  const args = { path: 'selftest' };
  const fingerprint = learningRequestFingerprint({ toolName: 'list_workspace_files', args });
  const soft = (id) => ({ ...call(id, 'list_workspace_files', JSON.stringify({ exists: false, reason: 'missing', path: 'selftest', guidance: 'Create it if needed' }), false),
    learningRequestFingerprint: fingerprint });
  const store = new MemoryStore({ sessionId: 's' });
  await store.commit(state => { state.toolEvidence = [soft('once')]; });
  const capability = createKnowledge({ store }).inspect({ limit: 32 }).capabilities.find(item => item.tool === 'list_workspace_files');
  assert.equal(capability.successes, 0);
  assert.equal(capability.prerequisites, 1);
  assert.equal(capability.failures, 0);
  assert.equal(capability.successRate, null);
  const first = evaluateLearningGate(store.learningGateRecords('worker'), { workerId: 'worker', toolName: 'list_workspace_files', args });
  assert.equal(first, null);
  await store.commit(state => { state.toolEvidence.push(soft('twice')); });
  const blocked = evaluateLearningGate(store.learningGateRecords('worker'), { workerId: 'worker', toolName: 'list_workspace_files', args });
  assert.equal(blocked.code, 'LEARNING_GATE');
  assert.equal(blocked.attribution, 'env_prereq');
  assert.match(blocked.message, /confirm the directory exists/);
  await store.commit(state => { state.toolEvidence.push({ ...soft('created'), isError: false, observations: JSON.stringify({ exists: true, entries: [] }) }); });
  assert.equal(evaluateLearningGate(store.learningGateRecords('worker'), { workerId: 'worker', toolName: 'list_workspace_files', args }), null);
  const changed = evaluateLearningGate(store.learningGateRecords('worker'), { workerId: 'worker', toolName: 'list_workspace_files', args: { path: 'src' } });
  assert.equal(changed, null);
});

test('a later success overturns a shared tool_defect and other sessions inherit the recovery', async () => {
  const args = { path: 'engine' };
  const fingerprint = learningRequestFingerprint({ toolName: 'read_workspace_file', args });
  const shared = [{ tool: 'read_workspace_file', class: 'tool_defect', fingerprint, lessonId: 'shared', sessionId: 'old' }];
  const blocked = evaluateLearningGate([], { workerId: 'other', toolName: 'read_workspace_file', args, shared });
  assert.equal(blocked.attribution, 'tool_defect');
  const recovered = [{ ...shared[0], class: 'recovered' }];
  assert.equal(evaluateLearningGate([], { workerId: 'other', toolName: 'read_workspace_file', args, shared: recovered }), null);
});
