'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, access } = require('node:fs/promises');
const { join, resolve, relative, isAbsolute, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { createHarnessService } = require('../../../../harness/ide/runtime/harness-service.cjs');
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32);

async function fixture(t) {
  // Keep dynamic-import fixtures in the workspace: Windows short-name TEMP
  // paths may be inaccessible to the sandbox's module realpath resolution.
  const parent = resolve(__dirname, '../../../../../.cache');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'ubovm-worker-views-'));
  const services = [], requests = [];
  await mkdir(join(directory, 'agents/collaboration'), { recursive: true }); await mkdir(join(directory, 'ide'));
  await writeFile(join(directory, 'index.mjs'), 'export const unused = true;');
  await writeFile(join(directory, 'agents/collaboration/index.mjs'), 'export const runCollaboration = options => options.configuration.fixture(options);');
  await writeFile(join(directory, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];');
  const create = ({ requestToolApproval, onMessage, additionalTools } = {}) => {
    const service = createHarnessService({ sdkPath: join(directory, 'index.mjs'), storageDirectory: join(directory, 'storage'), workspaceRoots: [directory],
      requestToolApproval, onMessage, ...(additionalTools ? { additionalTools } : {}),
      readConfiguration: async () => ({ fixture: input => new Promise((complete, reject) => {
        requests.push({ ...input, complete }); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      }) }) }); services.push(service); return service;
  };
  const start = async (service, id = 'chat') => {
    const count = requests.length;
    await service.start({ conversationId: id, mode: 'assist', text: 'Inspect the project' });
    for (let attempt = 0; requests.length === count && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(requests.length, count + 1, JSON.stringify(service.state(id).error)); return requests.at(-1);
  };
  const idle = async (service, id = 'chat') => {
    for (let attempt = 0; service.isBusy(id) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.isBusy(id), false);
  };
  t.after(async () => { for (const service of services) await service.close(); const path = relative(parent, directory); assert(path && !path.startsWith('..') && !isAbsolute(path)); await rm(directory, { recursive: true, force: true }); });
  return { create, start, idle, requests, sdkFile: join(directory, 'index.mjs'), file: join(directory, 'storage', hash('chat'), 'assist', 'worker-views.json') };
}
const event = (run, workerId, value) => run.onEvent({ type: 'swarm.worker.event', workerId, parentId: 'root', event: value });
const message = text => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('stopping during asynchronous tool preparation never starts the model afterwards', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = f.create({ additionalTools: async id => {
    if (id === 'preparing') { enter(); await gate; }
    return [];
  } });
  await service.start({ conversationId: 'preparing', mode: 'assist', text: 'Prepare tools' });
  let preparationTimer;
  try {
    await Promise.race([entered, new Promise((resolve, reject) => {
      preparationTimer = setTimeout(() => reject(Error('Tool preparation did not start: ' + JSON.stringify(service.state('preparing')))), 3000);
    })]);
  } catch (error) { release(); throw error; }
  finally { clearTimeout(preparationTimer); }
  const other = await f.start(service, 'other');
  assert.equal(service.cancel('preparing'), true);
  release();
  // If an obsolete launch occurs, complete it so the test still cleans up.
  for (let attempt = 0; service.isBusy('preparing') && attempt < 100; attempt++) {
    for (const request of f.requests) if (request !== other) request.complete('Must not have run');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(service.isBusy('preparing'), false);
  assert.equal(f.requests.length, 1, 'only the unaffected conversation may call the model');
  assert.equal(service.state('preparing').status, 'interrupted');
  assert.equal(other.signal.aborted, false);
  other.complete('Other completed'); await f.idle(service, 'other');
  const retried = await f.start(service, 'preparing'); retried.complete('Retry completed'); await f.idle(service, 'preparing');
  assert.equal(service.state('preparing').status, 'completed');
});

for (const end of ['completed', 'cancelled']) test(`late events from a ${end} run cannot overwrite the next run in the same conversation`, async t => {
  const f = await fixture(t); let approvalCalls = 0;
  const service = f.create({ requestToolApproval: () => { approvalCalls++; return true; } }), previous = await f.start(service);
  if (end === 'cancelled') service.cancel('chat'); else previous.complete('Previous answer');
  await f.idle(service);
  previous.onEvent({ type: 'message_end', message: message('late-before-restart') });
  assert(!JSON.stringify(service.state('chat')).includes('late-before-restart'));
  const current = await f.start(service);
  current.onEvent({ type: 'swarm.status', workers: [{ id: 'same-worker', task: 'Current work', status: 'running' }] });
  current.onEvent({ type: 'message_end', message: message('Current progress') });
  const before = service.state('chat');
  previous.onEvent({ type: 'message_end', message: message('late-old-answer') });
  previous.onEvent({ type: 'swarm.status', workers: [{ id: 'same-worker', task: 'late-old-worker', status: 'failed' }] });
  event(previous, 'same-worker', { type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'late-call', args: {} });
  assert.deepEqual(service.state('chat'), before);
  assert.equal(await previous.requestToolApproval({ toolName: 'read_file', args: {} }), false);
  assert.equal(approvalCalls, 0, 'stale runs cannot create new approval cards');
  assert.equal(await current.requestToolApproval({ toolName: 'read_file', args: {} }), true);
  assert.equal(approvalCalls, 1);
  event(current, 'same-worker', { type: 'message_end', message: message('Current worker progress') });
  assert.match(JSON.stringify(service.state('chat')), /Current worker progress/);
  current.complete('Current answer'); await f.idle(service);
  assert.equal(service.state('chat').status, 'completed');
});

test('stopping goal tool preparation prevents creation of the Reason/Worker runtime', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { pathToFileURL } = require('node:url');
  await writeFile(f.sdkFile, `
    export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(resolve(__dirname, '../../../../harness/blackboard/database/database.mjs')).href)};
    export let created = 0;
    export function createHarness() { created++; throw new Error('Unexpected runtime startup'); }
  `);
  const sdk = await import(pathToFileURL(f.sdkFile).href);
  const service = f.create({ additionalTools: async () => { enter(); await gate; return []; } });
  await service.start({ conversationId: 'goal', mode: 'goal', goal: { objective: 'Prepare goal tools' } });
  await entered;
  service.cancel('goal'); release(); await f.idle(service, 'goal');
  assert.equal(sdk.created, 0);
  assert.equal(service.state('goal').status, 'interrupted');
  assert.equal(service.state('goal').canResume, true);
});

test('conversation boundaries isolate background agents, approvals, cancellation and reply delivery', async t => {
  const f = await fixture(t), delivered = [];
  const approvals = require('../../../host/agent/tool-approvals.cjs').createToolApprovals();
  t.after(() => approvals.dispose());
  const service = f.create({ requestToolApproval: request => approvals.request(request), onMessage: (id, value) => delivered.push({ id, value }) });
  const first = await f.start(service, 'conversation-a'), second = await f.start(service, 'conversation-b');
  assert(service.isBusy('conversation-a') && service.isBusy('conversation-b'));
  for (const [run, text] of [[first, 'A progress'], [second, 'B progress']]) {
    run.onEvent({ type: 'swarm.status', workers: [{ id: 'same-worker', task: text, status: 'running', depth: 1 }] });
    event(run, 'same-worker', { type: 'message_end', message: message(text) });
  }
  const request = run => run.requestToolApproval({ workerId: 'same-worker', toolCallId: 'same-call', toolName: 'read_file', args: { path: 'file.txt' }, signal: run.signal });
  const firstApproval = request(first), secondApproval = request(second);
  const secondId = approvals.snapshot('conversation-b')[0].id;
  assert.equal(approvals.respond({ id: secondId, conversationId: 'conversation-a', decision: 'approve' }), false);
  service.cancel('conversation-a'); await f.idle(service, 'conversation-a');
  assert.equal(await firstApproval, false);
  assert.equal(second.signal.aborted, false);
  assert.equal(approvals.snapshot('conversation-b')[0].status, 'pending');
  await service.remove('conversation-a');
  assert.equal(service.isBusy('conversation-b'), true);
  assert.match(JSON.stringify(service.state('conversation-b').workers), /B progress/);
  assert(!JSON.stringify(service.state('conversation-b')).includes('A progress'));
  assert.equal(approvals.respond({ id: secondId, conversationId: 'conversation-b', decision: 'approve' }), true);
  assert.equal(await secondApproval, true);
  second.complete('B final answer'); await f.idle(service, 'conversation-b');
  assert.deepEqual(delivered.map(item => [item.id, item.value.text]), [['conversation-b', 'B final answer']]);
});

async function saveWorkerCache(f, workers) {
  await mkdir(dirname(f.file), { recursive: true });
  await writeFile(f.file, JSON.stringify({ schemaVersion: 1, sessionId: 'ide_' + hash('chat:assist'), workers }));
}

test('closing during initial cache lookup cannot recreate a closed session', async t => {
  const f = await fixture(t), reader = f.create();
  await saveWorkerCache(f, [{ id: 'saved', description: 'Saved work', status: 'completed', result: 'Saved answer' }]);
  const loading = reader.restore({ conversationId: 'chat', mode: 'assist' });
  const settled = Promise.allSettled([loading]);
  await reader.close();
  await settled;
  assert.deepEqual(reader.state('chat').workers, []);
  await assert.rejects(async () => reader.restore({ conversationId: 'chat', mode: 'assist' }), { code: 'SERVICE_CLOSED' });
  assert.equal((await f.create().restore({ conversationId: 'chat', mode: 'assist' })).workers[0].result, 'Saved answer');
});

test('deleting during the first cache lookup drains recovery and removes the entire record', async t => {
  const f = await fixture(t), reader = f.create();
  await saveWorkerCache(f, [{ id: 'saved', description: 'Saved work', status: 'completed', result: 'Saved answer' }]);
  const loading = Promise.allSettled([reader.restore({ conversationId: 'chat', mode: 'assist' })]);
  await reader.remove('chat');
  await loading;
  assert.deepEqual(reader.state('chat').workers, []);
  await assert.rejects(access(dirname(dirname(f.file))), { code: 'ENOENT' });
  await reader.close();
  await assert.rejects(access(dirname(dirname(f.file))), { code: 'ENOENT' });
});

test('workspace release waits for recovery and rejects new reads until the transition finishes', async t => {
  const f = await fixture(t), reader = f.create(), input = { conversationId: 'chat', mode: 'assist' };
  await saveWorkerCache(f, [{ id: 'saved', description: 'Saved work', status: 'completed', result: 'Saved answer' }]);
  const loading = reader.restore(input);
  const releasing = reader.releaseWorkspace('chat');
  const overlapping = Promise.allSettled([reader.restore(input), reader.start({ ...input, text: 'Must not start' }), reader.remove('chat')]);
  const independent = reader.restore({ conversationId: 'other', mode: 'assist' });
  await releasing;
  const results = await overlapping;
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'SESSION_BUSY');
  }
  await loading;
  assert.deepEqual((await independent).workers, []);
  assert.equal((await reader.restore(input)).workers[0].result, 'Saved answer');
});

test('close waits for an in-flight database recovery to finish before disposing history', async t => {
  const f = await fixture(t), key = 'goal-' + hash('Slow recovery');
  const directory = join(dirname(dirname(f.file)), key);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'harness.sqlite'), 'fixture');
  await writeFile(f.sdkFile, `
    let enter, release;
    export const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    export const finish = () => release();
    export let disposed = false;
    export const HarnessDatabase = { async open() {
      enter(); await gate;
      return { loadSession: () => undefined, close() { disposed = true; } };
    } };`);
  const control = await import(require('node:url').pathToFileURL(f.sdkFile).href);
  const reader = f.create(), input = { conversationId: 'chat', mode: 'goal', goal: { objective: 'Slow recovery' } };
  const loading = reader.restore(input);
  await control.entered;
  const starting = Promise.allSettled([reader.start(input)]);
  await new Promise(resolve => setImmediate(resolve));
  let closed = false;
  const closing = reader.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must wait for recovery');
  } finally { control.finish(); await Promise.allSettled([loading, closing]); }
  assert.equal(control.disposed, true);
  const [started] = await starting;
  assert.equal(started.status, 'rejected');
  assert.equal(started.reason.code, 'SERVICE_CLOSED');
  assert.equal(reader.state('chat').status, 'idle');
});

test('a failed worker cache read remains retryable and clears its error after repair', async t => {
  const f = await fixture(t), reader = f.create(), input = { conversationId: 'chat', mode: 'assist' };
  await mkdir(dirname(f.file), { recursive: true });
  await writeFile(f.file, '{broken');
  assert.ok((await reader.restore(input)).workerViewError);
  await saveWorkerCache(f, [{ id: 'repaired', description: 'Recovered worker', status: 'completed', result: 'Saved answer' }]);
  const restored = await reader.restore(input);
  assert.equal(restored.workerViewError, undefined);
  assert.equal(restored.workers[0].id, 'repaired');
  await writeFile(f.file, '{broken');
  assert.equal((await reader.restore(input)).workers[0].id, 'repaired', 'successful recovery stays cached');
});

test('changing execution scope waits for old recovery and concurrent readers share the replacement', async t => {
  const f = await fixture(t), key = 'goal-' + hash('Previous goal');
  const directory = join(dirname(dirname(f.file)), key);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'harness.sqlite'), 'fixture');
  await writeFile(f.sdkFile, `
    let enter, release;
    export const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    export const finish = () => release();
    export const HarnessDatabase = { async open() {
      enter(); await gate;
      return { loadSession: () => ({ record: { status: 'failed', error: 'Previous failure' } }), close() {} };
    } };`);
  await saveWorkerCache(f, [{ id: 'new-worker', description: 'New scope', status: 'completed', result: 'New output' }]);
  const control = await import(require('node:url').pathToFileURL(f.sdkFile).href);
  const reader = f.create(), old = reader.restore({ conversationId: 'chat', mode: 'goal', goal: { objective: 'Previous goal' } });
  await control.entered;
  let changed = false;
  const replacements = Promise.all([reader.restore({ conversationId: 'chat', mode: 'assist' }), reader.restore({ conversationId: 'chat', mode: 'assist' })])
    .then(value => { changed = true; return value; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(changed, false, 'old history must settle before its entry is replaced');
  } finally { control.finish(); await Promise.allSettled([old, replacements]); }
  assert.equal((await old).status, 'failed');
  for (const snapshot of await replacements) {
    assert.equal(snapshot.status, 'idle'); assert.equal(snapshot.workers[0].result, 'New output');
  }
  assert.equal(reader.state('chat').workers.length, 1);
});

test('legacy worker stream text survives recovery and reload without duplicating timeline text', async t => {
  const f = await fixture(t), input = { conversationId: 'chat', mode: 'assist' };
  await saveWorkerCache(f, [
    { id: 'legacy', description: 'Legacy work', status: 'running', streamText: 'Saved partial api_key=hidden-secret',
      parts: [{ id: 'tool', type: 'tool', name: 'read_file', status: 'running' }] },
    { id: 'modern', description: 'Modern work', status: 'completed', streamText: 'Outdated preview',
      parts: [{ id: 'answer', type: 'text', text: 'Final answer', status: 'completed' }] }
  ]);
  const reader = f.create();
  const restored = await reader.restore(input);
  assert.equal(restored.workers[0].status, 'interrupted');
  assert.equal(restored.workers[0].parts[0].status, 'interrupted');
  const parts = restored.workers[0].parts.filter(part => part.type === 'text');
  assert.equal(parts.length, 1); assert.match(parts[0].text, /Saved partial/);
  assert(!JSON.stringify(restored).includes('hidden-secret'));
  assert.deepEqual(restored.workers[1].parts.map(part => part.text), ['Final answer']);
  await reader.close();
  const reloaded = await f.create().restore(input);
  assert.deepEqual(reloaded.workers[0].parts, restored.workers[0].parts);
});

test('retrying goal worker history preserves authoritative metadata and does not reopen the database', async t => {
  const f = await fixture(t), key = 'goal-' + hash('Saved goal');
  const directory = join(dirname(dirname(f.file)), key), sessionId = 'ide_' + hash('chat:' + key);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'harness.sqlite'), 'fixture');
  const saved = { blackboard: { sessionId, goal: 'Saved goal', revision: 1, rootId: 'root', nodes: [
    { id: 'worker', kind: 'intent', intent: { description: 'Database task', status: 'completed' }, attempts: [] }
  ] }, record: { status: 'completed', result: { revision: 1 } } };
  await writeFile(f.sdkFile, `let opens = 0; export const HarnessDatabase = { async open() {
    if (++opens > 1) throw new Error('Database should stay cached');
    return { loadSession: () => (${JSON.stringify(saved)}), close() {} };
  } };`);
  const file = join(directory, 'worker-views.json');
  await writeFile(file, '{broken');
  const reader = f.create(), input = { conversationId: 'chat', mode: 'goal', goal: { objective: 'Saved goal' } };
  assert.ok((await reader.restore(input)).workerViewError);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, sessionId, workers: [
    { id: 'worker', description: 'Old cached task', status: 'running', streamText: 'Recovered output' }
  ] }));
  const restored = await reader.restore(input);
  assert.equal(restored.workerViewError, undefined);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.workers[0].description, 'Database task');
  assert.equal(restored.workers[0].status, 'completed');
  assert.equal(restored.workers[0].parts[0].text, 'Recovered output');
});

test('concurrent history readers all wait for complete worker restoration', async t => {
  const f = await fixture(t);
  // Obtain the persisted identity through the same writer used in production.
  const writer = f.create(), run = await f.start(writer);
  run.onEvent({ type: 'swarm.status', workers: [{ id: 'saved', task: 'Saved work', status: 'completed', result: 'Saved result', depth: 1 }] });
  run.complete('Done'); await f.idle(writer); await writer.close();
  const reader = f.create();
  const snapshots = await Promise.all(Array.from({ length: 12 }, () => reader.restore({ conversationId: 'chat', mode: 'assist' })));
  for (const snapshot of snapshots) {
    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.workers[0].result, 'Saved result');
  }
});

test('failed shared recovery rejects every reader and can retry after the cache is repaired', async t => {
  const f = await fixture(t), reader = f.create();
  const objective = 'Restore saved goal', key = 'goal-' + hash(objective);
  const directory = join(dirname(dirname(f.file)), key);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'goal-timeline.json');
  await writeFile(file, '{broken');
  const input = { conversationId: 'chat', mode: 'goal', goal: { objective } };
  const failures = await Promise.allSettled(Array.from({ length: 4 }, () => reader.restore(input)));
  for (const result of failures) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'INVALID_GOAL_TIMELINE');
  }
  await writeFile(file, JSON.stringify({ schemaVersion: 1, sessionId: 'ide_' + hash('chat:' + key),
    requestId: null, runId: 'saved-run', status: 'interrupted', revision: null,
    parts: [{ id: 'saved-text', type: 'text', text: 'Recovered history', status: 'completed' }] }));
  const restored = await reader.restore(input);
  assert.equal(restored.parts[0].text, 'Recovered history');
});

test('worker streams are isolated, credential-redacted, durable and restored without restarting execution', async t => {
  const f = await fixture(t), service = f.create(), run = await f.start(service);
  run.onEvent({ type: 'swarm.status', workers: [{ id: 'first', name: 'Inspect', task: 'Read the file', status: 'running', depth: 1 }] });
  run.onEvent({ type: 'message_start', message: message('') });
  run.onEvent({ type: 'message_update', message: message('Root response') });
  event(run, 'first', { type: 'message_start', message: message('') });
  let reads = 0;
  const streamed = { role: 'assistant', get content() { reads++; return [{ type: 'text', text: 'Worker progress api_key=hidden-secret' }]; } };
  for (let i = 0; i < 500; i++) event(run, 'first', { type: 'message_update', message: streamed });
  const snapshot = service.state('chat');
  assert(reads < 10, 'worker token bursts should coalesce');
  assert.equal(snapshot.streamText, 'Root response');
  assert.equal(snapshot.parts.length, 1);
  assert.match(snapshot.workers[0].parts[0].text, /Worker progress/);
  assert(!JSON.stringify(snapshot).includes('hidden-secret'));
  snapshot.workers[0].parts[0].text = 'tampered';
  assert(!JSON.stringify(service.state('chat')).includes('tampered'));
  event(run, 'first', { type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'same-id', args: { path: 'one.txt' } });
  event(run, 'first', { type: 'tool_execution_end', toolName: 'read_file', toolCallId: 'same-id', result: { content: [{ type: 'text', text: 'observed file' }] } });
  event(run, 'first', { type: 'message_start', message: message('') });
  event(run, 'first', { type: 'message_end', message: message('File verified') });
  run.onEvent({ type: 'swarm.status', workers: [{ id: 'first', name: 'Inspect', task: 'Read the file', status: 'completed', result: 'File verified', depth: 1 }] });
  run.complete('Root final'); await f.idle(service); await service.close();
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert(!JSON.stringify(saved).includes('hidden-secret'));
  const restored = f.create(); await restored.restore({ conversationId: 'chat', mode: 'assist' });
  const workers = restored.state('chat').workers;
  assert.equal(workers[0].status, 'completed');
  assert.equal(workers[0].parts.filter(part => part.text === 'File verified').length, 1);
  assert.equal(workers[0].parts.find(part => part.type === 'tool').output, 'observed file');
  await restored.restore({ conversationId: 'other', mode: 'assist' }); assert.deepEqual(restored.state('other').workers, []);
});

test('cancellation retains worker partials, interrupts active tools and never accepts late events', async t => {
  const f = await fixture(t), service = f.create(), run = await f.start(service);
  run.onEvent({ type: 'swarm.status', workers: [{ id: 'child', task: 'Work', status: 'running', depth: 1 }] });
  event(run, 'child', { type: 'message_start', message: message('') });
  event(run, 'child', { type: 'message_update', message: message('Partial child response') });
  event(run, 'child', { type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'unfinished', args: { path: 'unfinished.txt' } });
  service.cancel('chat'); await f.idle(service);
  event(run, 'child', { type: 'message_end', message: message('late result') });
  const view = service.state('chat').workers[0];
  assert.equal(view.status, 'interrupted'); assert.equal(view.parts.find(part => part.type === 'tool').status, 'interrupted');
  assert.equal(view.parts[0].text, 'Partial child response'); assert(!JSON.stringify(view).includes('late result'));
  await service.close();
  const restored = f.create(); await restored.restore({ conversationId: 'chat', mode: 'assist' });
  assert.equal(restored.state('chat').workers[0].status, 'interrupted');
});

test('clearing the worker list persists an empty record instead of resurrecting stale workers', async t => {
  const f = await fixture(t), service = f.create(), first = await f.start(service);
  first.onEvent({ type: 'swarm.status', workers: [{ id: 'old', task: 'Old work', status: 'completed', result: 'done' }] });
  first.complete('Done'); await f.idle(service);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).workers.length, 1);
  const next = await f.start(service);
  next.onEvent({ type: 'swarm.status', workers: [] });
  next.complete('No workers'); await f.idle(service); await service.close();
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(saved.workers, []);
  const restored = f.create();
  assert.deepEqual((await restored.restore({ conversationId: 'chat', mode: 'assist' })).workers, []);
});

test('more than 500 workers persist and restore the latest 100 with stable omission counts', async t => {
  const f = await fixture(t), service = f.create(), run = await f.start(service);
  run.onEvent({ type: 'swarm.status', workers: Array.from({ length: 601 }, (_, i) => ({ id: 'worker-' + i, task: 'Work ' + i, status: 'completed' })) });
  run.complete('Done'); await f.idle(service); await service.close();
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.workers.length, 100);
  assert.equal(saved.workers[0].id, 'worker-501');
  assert.equal(saved.workers.at(-1).id, 'worker-600');
  assert.equal(saved.omittedWorkers, 501);
  const restored = f.create();
  assert.equal((await restored.restore({ conversationId: 'chat', mode: 'assist' })).workers.at(-1).id, 'worker-600');
  await restored.close();
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).omittedWorkers, 501);
});

test('a byte-bounded large worker record can be restored and closed without losing recent history', async t => {
  const { workerRecord, WORKER_RECORD_LIMIT } = require('../../../../harness/ide/runtime/worker-record.cjs');
  const f = await fixture(t);
  const parts = Array.from({ length: 200 }, (_, i) => ({ id: 'part-' + i, type: 'text', text: '中文🙂'.repeat(10000), status: 'completed' }));
  const record = workerRecord('ide_' + hash('chat:assist'), [{ id: 'large', description: 'Large worker', status: 'completed', parts }], 1);
  await mkdir(dirname(f.file), { recursive: true });
  await writeFile(f.file, JSON.stringify(record));
  const service = f.create();
  const state = await service.restore({ conversationId: 'chat', mode: 'assist' });
  assert.equal(state.workerViewError, undefined);
  assert.equal(state.workers[0].parts.at(-1).id, 'part-199');
  await service.close();
  const rewritten = await readFile(f.file);
  assert(rewritten.length <= WORKER_RECORD_LIMIT);
  assert.equal(JSON.parse(rewritten).workers[0].omittedParts, record.workers[0].omittedParts);
});
