'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { createHash } = require('node:crypto');
const { createHarnessService } = require('../harness/harness-service.cjs');
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32);

async function fixture(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'ubovm-worker-views-'));
  const services = [], requests = [];
  await mkdir(join(directory, 'agents/collaboration'), { recursive: true }); await mkdir(join(directory, 'ide'));
  await writeFile(join(directory, 'index.mjs'), 'export const unused = true;');
  await writeFile(join(directory, 'agents/collaboration/index.mjs'), 'export const runCollaboration = options => options.configuration.fixture(options);');
  await writeFile(join(directory, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];');
  const create = () => {
    const service = createHarnessService({ sdkPath: join(directory, 'index.mjs'), storageDirectory: join(directory, 'storage'),
      readConfiguration: async () => ({ fixture: input => new Promise((complete, reject) => {
        requests.push({ ...input, complete }); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      }) }) }); services.push(service); return service;
  };
  const start = async (service, id = 'chat') => {
    const count = requests.length;
    await service.start({ conversationId: id, mode: 'assist', text: 'Inspect the project' });
    for (let attempt = 0; requests.length === count && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(requests.length, count + 1); return requests.at(-1);
  };
  const idle = async (service, id = 'chat') => {
    for (let attempt = 0; service.isBusy(id) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.isBusy(id), false);
  };
  t.after(async () => { for (const service of services) await service.close(); const path = relative(parent, directory); assert(path && !path.startsWith('..') && !isAbsolute(path)); await rm(directory, { recursive: true, force: true }); });
  return { create, start, idle, file: join(directory, 'storage', hash('chat'), 'assist', 'worker-views.json') };
}
const event = (run, workerId, value) => run.onEvent({ type: 'swarm.worker.event', workerId, parentId: 'root', event: value });
const message = text => ({ role: 'assistant', content: [{ type: 'text', text }] });

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
