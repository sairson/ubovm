'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHarnessService } = require('../../../../harness/ide/runtime/harness-service.cjs');
const { cleanTimelineParts } = require('../../../harness/session/sessions.cjs');

test('resident Worker task remains visible and controllable after worker removal and a new turn', async t => {
  const f = await fixture(t);
  const id = '33333333-3333-4333-8333-333333333333';
  let publish, stopped = false;
  const register = f.running.configuration.intools.onCommand;
  register({ id, workerId: 'child', toolCallId: 'server', name: 'run_local_shell_command',
    subscribe: callback => { publish = callback; },
    background: () => { publish({ status: 'running', output: 'ready' }); return true; },
    interrupt: () => { stopped = true; publish({ status: 'interrupted', output: 'stopped' }); return true; } });
  const workerEvent = event => f.event({ type: 'swarm.worker.event', workerId: 'child', event });
  const base = { toolName: 'run_local_shell_command', toolCallId: 'server' };
  workerEvent({ ...base, type: 'tool_execution_start', args: { command: 'npm run dev' } });
  workerEvent({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
  f.service.backgroundCommand('current', id);
  workerEvent({ ...base, type: 'tool_execution_end', result: { content: [], details: { background: true } } });
  f.event({ type: 'swarm.status', workers: [] });
  f.complete('done'); await f.completion;
  assert.equal(f.service.state('current').parts.find(part => part.commandId === id).status, 'running');
  await f.service.start({ conversationId: 'current', mode: 'assist', text: 'next', messages: [] });
  while (f.currentRunning === f.running) await new Promise(resolve => setTimeout(resolve, 5));
  publish({ status: 'running', output: 'serving in next turn' });
  assert.equal(f.service.state('current').parts.find(part => part.commandId === id).output, 'serving in next turn');
  f.complete('next done');
  while (f.service.isBusy('current')) await new Promise(resolve => setTimeout(resolve, 5));
  await f.service.releaseWorkspace('current');
  assert.equal(stopped, true);
  assert.equal(f.service.state('current').parts.find(part => part.commandId === id).status, 'interrupted');
});

test('resident stop marker survives projection updates after the Worker view is removed', async t => {
  const f = await fixture(t);
  const id = '55555555-5555-4555-8555-555555555555';
  let publish;
  f.running.configuration.intools.onCommand({ id, workerId: 'child', toolCallId: 'server', name: 'run_local_shell_command',
    args: { command: 'npm run dev' }, subscribe: callback => { publish = callback; },
    background: () => { publish({ status: 'running', output: 'ready' }); return true; }, interrupt: () => true });
  f.service.backgroundCommand('current', id);
  f.complete('done'); await f.completion;
  assert.equal(f.service.interruptCommand('current', id), true);
  const part = () => f.service.state('current').parts.find(part => part.commandId === id);
  assert.equal(part().interruptRequested, true);
  assert.equal(part().executionState, 'stopping');
  publish({ status: 'running', output: 'last output' });
  assert.equal(part().interruptRequested, true);
  assert.equal(part().executionState, 'stopping');
});

test('resident admission is bounded even before timeline projection attaches the command', async t => {
  const f = await fixture(t);
  const { controlledCommand } = await import('../../../../harness/intools/shared/process/command-control.mjs');
  const hostRegister = f.running.configuration.intools.onCommand;
  const calls = [], completions = [], controls = [];
  const register = control => { controls.push(control); return hostRegister(control); };
  register.retainBackground = true; register.canRetain = hostRegister.canRetain;
  const tool = controlledCommand({ name: 'run_local_shell_command', execute() {
    return new Promise(resolve => completions.push(resolve));
  } }, 'worker', register);
  try {
    for (let i = 0; i < 33; i++) {
      // Use a non-heuristic command so admission is driven only by explicit background().
      calls.push(tool.execute('server-' + i, { command: 'node server.js --port ' + (3000 + i) }));
      await Promise.resolve();
      assert.equal(controls[i].background(), i < 32);
      if (i < 32) await calls[i];
    }
    assert.equal(f.service.state('current').parts.filter(part => part.background).length, 32);
  } finally {
    for (const resolve of completions) resolve({ content: [] });
    await Promise.all(calls); await Promise.all(controls.map(control => control.done()));
    await tool.close(); f.complete('done'); await f.completion;
  }
});

for (const damaged of ['{broken', 'null', 'x'.repeat((4 << 20) + 1)]) test(`damaged resident history is isolated and repair can be retried (${damaged.length})`, async t => {
  const f = await fixture(t);
  f.complete('done'); await f.completion; await f.service.close();
  const destination = path.join(f.running.directory, 'resident-tasks.json');
  await writeFile(destination, damaged);
  const restored = createHarnessService({ workspaceRoots: [f.directory], sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: path.join(f.directory, 'storage'), readConfiguration: () => { throw Error('restore must not call model'); } });
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'assist' });
    assert.equal(state.workerViewError.code, 'INVALID_RESIDENT_TASKS');
    assert.equal(state.error, null);
    const retry = await restored.restore({ conversationId: 'current', mode: 'assist' });
    assert.equal(retry.workerViewError.code, 'INVALID_RESIDENT_TASKS');
    const { readFile } = require('node:fs/promises');
    assert.equal(await readFile(destination, 'utf8'), damaged, 'keep the original file for diagnosis');
    await writeFile(destination, JSON.stringify({ schemaVersion: 1, sessionId: f.running.sessionId, parts: [] }));
    const repaired = await restored.restore({ conversationId: 'current', mode: 'assist' });
    assert.equal(repaired.workerViewError, undefined);
    assert.equal(repaired.error, null);
  } finally { await restored.close(); }
});

test('resident history survives service restart and stale running records lose their live status', async t => {
  const f = await fixture(t);
  const id = '44444444-4444-4444-8444-444444444444';
  let publish;
  f.running.configuration.intools.onCommand({ id, workerId: 'server', toolCallId: 'server', name: 'run_local_shell_command',
    subscribe: callback => { publish = callback; },
    background: () => { publish({ status: 'running', output: 'server log' }); return true; },
    interrupt: () => { publish({ status: 'interrupted', output: 'server stopped' }); return true; } });
  const base = { toolName: 'run_local_shell_command', toolCallId: 'server' };
  f.event({ ...base, type: 'tool_execution_start', args: { command: 'npm run dev' } });
  f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
  f.service.backgroundCommand('current', id);
  f.event({ ...base, type: 'tool_execution_end', result: { content: [], details: { background: true } } });
  f.complete('done'); await f.completion;
  await f.service.close();
  const { readFile, readdir } = require('node:fs/promises');
  const storage = path.join(f.directory, 'storage');
  const conversation = path.join(storage, (await readdir(storage))[0]);
  const directory = path.join(conversation, (await readdir(conversation)).find(name => name === 'assist'));
  const destination = path.join(directory, 'resident-tasks.json');
  const record = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(record.parts[0].status, 'interrupted');
  record.parts[0].status = 'running';
  await writeFile(destination, JSON.stringify(record));
  const restored = createHarnessService({ workspaceRoots: [f.directory], sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: storage, readConfiguration: () => { throw Error('restore must not call model'); } });
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'assist' });
    const part = state.parts.find(part => part.commandId === id);
    assert.equal(part.status, 'interrupted');
    assert.match(part.output, /server stopped/);
    assert.equal(restored.interruptCommand('current', id), false);
  } finally { await restored.close(); }
});

test('backgroundCommand works after the agent turn is no longer busy', async t => {
  const f = await fixture(t);
  const register = f.running.configuration.intools.onCommand;
  const id = 'a3333333-3333-4333-8333-333333333333';
  let publish, backgrounded = false;
  register({ id, workerId: 'worker-1', toolCallId: 'late', name: 'run_local_shell_command',
    interrupt: () => true,
    subscribe: callback => { publish = callback; },
    background: () => { backgrounded = true; publish({ status: 'running', output: 'kept' }); return true; } });
  const base = { toolName: 'run_local_shell_command', toolCallId: 'late' };
  f.event({ ...base, type: 'tool_execution_start', args: { command: 'sleep 999' } });
  f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
  f.complete('done'); await f.completion;
  assert.equal(f.service.state('current').busy, false);
  assert.equal(f.service.backgroundCommand('current', id), true);
  assert.equal(backgrounded, true);
  assert.equal(f.service.state('current').parts.find(part => part.commandId === id).status, 'running');
});

test('cancel auto-retains long-running shell commands before aborting the run', async t => {
  const f = await fixture(t);
  const register = f.running.configuration.intools.onCommand;
  const id = 'a5555555-5555-4555-8555-555555555555';
  let publish, backgrounded = false;
  register({ id, workerId: 'worker-1', toolCallId: 'dev', name: 'run_local_shell_command', args: { command: 'npm run dev' },
    interrupt: () => true,
    subscribe: callback => { publish = callback; },
    background: () => { backgrounded = true; publish({ status: 'running', output: 'dev ready' }); return true; } });
  const base = { toolName: 'run_local_shell_command', toolCallId: 'dev' };
  f.event({ ...base, type: 'tool_execution_start', args: { command: 'npm run dev' } });
  f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
  assert.equal(f.service.cancel('current'), true);
  assert.equal(backgrounded, true);
  await f.completion;
  assert.equal(f.service.state('current').parts.find(part => part.commandId === id)?.status, 'running');
});

for (const mode of ['assist', 'goal']) for (const toolName of ['run_local_shell_command', 'run_linux_ssh_command']) {
  test(`${mode} retains ${toolName} background controls after agent completion`, async t => {
    const f = await fixture(t, mode);
    const register = mode === 'goal' ? f.running.intools.onCommand : f.running.configuration.intools.onCommand;
    assert.equal(register.retainBackground, true);
    const id = '22222222-2222-4222-8222-222222222222';
    let publish, stopped = false;
    register({ id, workerId: 'worker-1', toolCallId: 'resident', name: toolName,
      interrupt: () => { stopped = true; publish({ status: 'interrupted', output: 'stopped' }); return true; },
      subscribe: callback => { publish = callback; },
      background: () => { publish({ status: 'running', output: 'ready' }); return true; } });
    const event = value => mode === 'goal' ? f.event({ type: 'worker.event', event: { type: 'pi_event', intentId: 'worker-1', event: value } }) : f.event(value);
    const base = { toolName, toolCallId: 'resident' };
    event({ ...base, type: 'tool_execution_start', args: { command: 'npm run dev' } });
    event({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
    f.service.backgroundCommand('current', id);
    event({ ...base, type: 'tool_execution_end', result: { content: [], details: { background: true } } });
    f.complete(mode === 'goal' ? { complete: true, revision: 1, summary: 'done' } : 'done');
    await f.completion;
    const part = () => mode === 'goal' ? f.service.state('current').workers[0].parts.find(part => part.commandId === id) : f.service.state('current').parts.find(part => part.commandId === id);
    assert.equal(part().status, 'running');
    assert.equal((f.service.state('current').activities || []).some(item => item.label === toolName), false);
    publish({ status: 'running', output: 'still serving' });
    assert.equal(part().output, 'still serving');
    assert.equal(f.service.interruptCommand('current', id), true);
    assert.equal(stopped, true);
    assert.equal(part().status, 'interrupted');
  });
}

for (const mode of ['assist', 'goal']) test(`${mode} puts commands aside without losing live output or marking them completed`, async t => {
  const f = await fixture(t, mode);
  const register = mode === 'goal' ? f.running.intools.onCommand : f.running.configuration.intools.onCommand;
  const id = '11111111-1111-4111-8111-111111111111';
  let publish;
  register({ id, workerId: 'worker-1', toolCallId: 'shell', name: 'run_linux_ssh_command',
    subscribe: callback => { publish = callback; },
    background: () => { publish({ status: 'running', output: 'before' }); return true; } });
  const event = value => mode === 'goal' ? f.event({ type: 'worker.event', event: { type: 'pi_event', intentId: 'worker-1', event: value } }) : f.event(value);
  const base = { toolName: 'run_linux_ssh_command', toolCallId: 'shell' };
  event({ ...base, type: 'tool_execution_start', args: { command: 'sleep 999' } });
  event({ ...base, type: 'tool_execution_update', partialResult: { content: [], details: { command_id: id } } });
  const part = () => mode === 'goal' ? f.service.state('current').workers[0].parts.find(part => part.type === 'tool') : f.service.state('current').parts.find(part => part.type === 'tool');
  assert.equal(f.service.backgroundCommand('other', id), false);
  assert.equal(f.service.backgroundCommand('current', id), true);
  event({ ...base, type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'put aside' }], details: { background: true } } });
  assert.equal(part().background, true);
  assert.equal(part().status, 'running');
  assert.equal((f.service.state('current').activities || []).some(item => item.label === 'run_linux_ssh_command' && ['queued', 'running', 'waiting'].includes(item.status)), false);
  assert.equal(part().output, 'before');
  publish({ status: 'running', output: 'before\nafter' });
  assert.equal(part().output, 'before\nafter');
  publish({ status: 'completed', output: 'done' });
  assert.equal(part().status, 'completed');
  assert.equal(f.running.signal.aborted, false);
});

for (const mode of ['assist', 'goal']) test(`${mode} supports command-scoped interruption without cancelling the run`, async t => {
  const f = await fixture(t, mode);
  const register = mode === 'goal' ? f.running.intools.onCommand : f.running.configuration.intools.onCommand;
  const id = '11111111-1111-4111-8111-111111111111';
  let interrupted = false;
  const release = register({ id, workerId: 'worker-1', toolCallId: 'shell', name: 'run_linux_ssh_command', interrupt: () => { if (interrupted) return false; interrupted = true; return true; } });
  const event = value => mode === 'goal' ? f.event({ type: 'worker.event', event: { type: 'pi_event', intentId: 'worker-1', event: value } }) : f.event(value);
  const base = { toolName: 'run_linux_ssh_command', toolCallId: 'shell' };
  event({ ...base, type: 'tool_execution_start', args: { command: 'sleep 999', session: 'build' } });
  event({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'before-stop' }], details: { command_id: id } } });
  const part = () => mode === 'goal' ? f.service.state('current').workers[0].parts.find(part => part.type === 'tool') : f.service.state('current').parts.find(part => part.type === 'tool');
  assert.equal(part().commandId, id);
  event({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: '' }], details: { execution_state: 'queued' } } });
  assert.equal(part().executionState, 'queued');
  assert.equal(f.service.interruptCommand('other-session', id), false);
  assert.equal(interrupted, false);
  assert.equal(f.service.interruptCommand('current', id), true);
  assert.equal(f.service.interruptCommand('current', id), false);
  assert.equal(f.running.signal.aborted, false);
  assert.equal(part().interruptRequested, true);
  release();
  event({ ...base, type: 'tool_execution_end', isError: true, result: { content: [{ type: 'text', text: '用户中断\nbefore-stop' }] } });
  assert.equal(part().status, 'interrupted');
  assert.equal(part().executionState, undefined);
  assert.match(part().output, /before-stop/);
  assert.equal(f.service.interruptCommand('current', id), false);
});

async function fixture(t, mode = 'assist', initialFacts = '', configuration = {}, approvalMode, goalExtras = {}) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'ubovm-streaming-'));
  let service;
  t.after(async () => {
    await service?.close();
    const relative = path.relative(parent, directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'ide'));
  await mkdir(path.join(directory, 'agents/collaboration'), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'index.mjs'), `
      export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../../harness/blackboard/database/database.mjs')).href)};
      export async function createHarness(options) {
        const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
        const memory = { notes: [] };
        return { snapshot: () => board, memory: () => structuredClone(memory), middlewareStatus: () => ({}), close: async () => {}, cancel() {},
          addFact: async fact => { board.nodes.push({ id: 'fact', kind: 'fact', parentIds: fact.parentIds, childIds: [], fact, attempts: [] }); board.revision++; },
          run: ({ signal }) => options.fixture({ ...options, signal, memory, route: 'goal' }) };
      }`),
    writeFile(path.join(directory, 'agents/collaboration/index.mjs'), "export const runCollaboration = options => options.configuration.fixture({ ...options, route: 'collaboration' });"),
    writeFile(path.join(directory, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];')
  ]);
  let latestRunning, started, complete, finished, observedBusy = false, deliveryError = false;
  const ready = new Promise(resolve => { started = resolve; });
  const completion = new Promise(resolve => { finished = resolve; });
  const delivered = [];
  service = createHarnessService({
    workspaceRoots: id => { assert.equal(id, 'current'); return [directory]; },
    additionalTools: conversationId => [{ name: 'fixture_coding_tool', conversationId }],
    sdkPath: path.join(directory, 'index.mjs'), storageDirectory: path.join(directory, 'storage'),
    readConfiguration: async () => ({ ...configuration, fixture: options => new Promise((resolve, reject) => {
      latestRunning = options; complete = resolve;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started(options);
    }) }),
    onMessage: async (_, message) => { if (deliveryError) throw Error('history storage unavailable'); delivered.push(message); },
    onChange: id => { if (service.isBusy(id)) observedBusy = true; else if (observedBusy) finished(); }
  });
  await service.start({ conversationId: 'current', mode, approvalMode, text: 'fixture', messages: [], ...(mode === 'goal' ? { goal: { objective: 'Verify the goal route', initialFacts, ...goalExtras } } : {}) });
  const running = await ready;
  if (mode === 'goal') { assert.equal(running.intools.localShell.cwd, directory); assert.equal(running.intools.python.cwd, directory); }
  else {
    assert.deepEqual(running.workspaceRoots, [directory]);
    assert.equal(running.configuration.intools.localShell.cwd, directory);
    assert.equal(running.configuration.intools.python.cwd, directory);
  }
  const suppliedTools = mode === 'goal' ? running.tools : await running.configuration.tools({ workerId: 'test' });
  assert(suppliedTools.some(tool => tool.name === 'fixture_coding_tool' && tool.conversationId === 'current'), 'Coding tools must be bound to the originating conversation in both execution modes');
  return { service, directory, running, get currentRunning() { return latestRunning; }, memory: running.memory, route: running.route, event: running.onEvent, delivered, completion, complete: text => complete(text), failDelivery: value => { deliveryError = value; } };
}

test('stopping preserves partial text and tool evidence in durable history before the next run', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_update', message: { role: 'assistant', content: '已经定位问题，正在修改' } });
  f.event({ type: 'tool_execution_start', toolName: 'edit_file', toolCallId: 'edit', args: { path: 'a.js' } });
  f.service.cancel('current'); await f.completion;
  assert.equal(f.delivered.length, 1);
  const saved = structuredClone(f.delivered[0]);
  assert.match(saved.text, /已经定位问题/);
  assert.equal(saved.parts.find(part => part.type === 'tool').status, 'interrupted');
  assert.equal(saved.parts.find(part => part.type === 'text').status, 'completed');
  await f.service.start({ conversationId: 'current', mode: 'assist', text: '继续' });
  assert.deepEqual(f.delivered[0], saved);
  assert.equal(f.service.state('current').parts.length, 0, 'new live state must not own the prior history');
});

test('undelivered interruption survives restart and restores without a model call', async t => {
  const f = await fixture(t);
  f.failDelivery(true);
  f.event({ type: 'message_update', message: { role: 'assistant', content: '重启后仍应可见' } });
  f.service.cancel('current'); await f.completion;
  assert.equal(f.service.state('current').status, 'failed');
  await assert.rejects(f.service.start({ conversationId: 'current', mode: 'assist', text: '继续' }), /history storage/);
  assert(f.service.state('current').parts.length > 0);
  await f.service.close();
  const delivered = [];
  const restored = createHarnessService({ sdkPath: path.join(f.directory, 'index.mjs'), storageDirectory: path.join(f.directory, 'storage'),
    workspaceRoots: () => [f.directory], readConfiguration: () => { throw Error('must not run model'); }, onMessage: (_, message) => delivered.push(message) });
  t.after(() => restored.close());
  await restored.restore({ conversationId: 'current', mode: 'assist' });
  assert.equal(delivered.length, 1); assert.match(delivered[0].text, /重启后仍应可见/);
  await restored.restore({ conversationId: 'current', mode: 'assist' });
  assert.equal(delivered.length, 1);
});

test('rewind branches isolate stored assist memory while preserving the previous execution', async t => {
  const f = await fixture(t);
  const { HarnessDatabase } = await import('../../../../harness/blackboard/database/database.mjs');
  const database = await HarnessDatabase.open({ filePath: path.join(f.running.directory, 'assist.sqlite') });
  database.ensureSession({ sessionId: f.running.sessionId, goal: 'old input' });
  database.close();
  f.complete('old answer'); await f.completion;
  await f.service.restore({ conversationId: 'current', mode: 'assist', executionBranch: 'rewound-branch' });
  assert.equal(f.service.state('current').status, 'idle');
  assert.equal(f.service.state('current').parts.length, 0);
  const { access } = require('node:fs/promises');
  await access(path.join(f.running.directory, 'assist.sqlite'));
  await f.service.restore({ conversationId: 'current', mode: 'assist', executionBranch: 'rewound-branch' });
  assert.equal(f.service.state('current').parts.length, 0);
});

test('goal notes refresh before the running worker returns', async t => {
  const f = await fixture(t, 'goal');
  f.memory.notes.push({ id: 'live-note', content: 'Saved during execution' });
  f.event({ type: 'memory.changed', revision: 1 });
  assert.equal(f.service.isBusy('current'), true);
  assert.equal(f.service.state('current').memory.notes[0].content, 'Saved during execution');
  f.memory.notes[0].content = 'Updated during execution';
  f.event({ type: 'memory.changed', revision: 2 });
  assert.equal(f.service.state('current').memory.notes[0].content, 'Updated during execution');
  f.complete({ complete: true, revision: 1, summary: 'goal verified' });
  await f.completion;
});

test('assist notes survive service restart and repeated view restoration without a model call', async t => {
  const f = await fixture(t);
  const { HarnessDatabase } = await import('../../../../harness/blackboard/database/database.mjs');
  const database = await HarnessDatabase.open({ filePath: path.join(f.running.directory, 'assist.sqlite') });
  const memory = { schemaVersion: 1, sessionId: f.running.sessionId, revision: 1, todos: [], workers: [], promotions: [], audit: [], notes: [{ id: 'persisted-note', content: '关闭面板后仍然保留' }] };
  try {
    database.ensureSession({ sessionId: f.running.sessionId, goal: 'IDE assist conversation' });
    const lease = database.acquireSession(f.running.sessionId);
    try { database.saveMemory(f.running.sessionId, memory); } finally { lease.release(); }
  } finally { database.close(); }
  f.complete('Done'); await f.completion; await f.service.close();
  const restored = createHarnessService({
    workspaceRoots: () => [f.directory], sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: path.join(f.directory, 'storage'),
    readConfiguration: () => { throw new Error('Restoring notes must not start the model'); }
  });
  try {
    for (let index = 0; index < 3; index++) {
      const state = await restored.restore({ conversationId: 'current', mode: 'assist' });
      assert.deepEqual(state.memory, memory);
    }
    const other = await restored.restore({ conversationId: 'other', mode: 'assist' });
    assert.equal(other.memory, undefined, 'notes must remain scoped to their conversation');
  } finally { await restored.close(); }
});

test('completed goal runs reject late Reason and Worker callbacks without altering saved results', async t => {
  const f = await fixture(t, 'goal');
  f.complete({ complete: true, revision: 1, summary: 'Goal result' });
  await f.completion;
  const before = f.service.state('current');
  f.event({ type: 'reason.start' });
  f.event({ type: 'worker.start', intentId: 'late-worker' });
  f.event({ type: 'reason.event', event: { type: 'pi_event', event: {
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Late thinking' }] }
  } } });
  assert.deepEqual(f.service.state('current'), before);
  assert.equal(f.delivered.length, 1);
});

test('initial facts enter the blackboard separately from the desired goal', async t => {
  const f = await fixture(t, 'goal', '现有桌面框架\n数据保存在本地');
  const board = f.service.state('current').blackboard;
  const runtime = f.service.runtimeSummary('current');
  assert.equal(runtime.busy, true);
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.workerCount, f.service.state('current').workers.length);
  assert.equal(Object.hasOwn(runtime, 'blackboard'), false, 'background status does not copy the board');
  assert.equal(Object.hasOwn(runtime, 'parts'), false, 'background status does not copy the transcript');
  assert.equal(board.goal, 'Verify the goal route');
  assert.ok(board.nodes.some(node => node.fact?.content.includes('现有桌面框架\n数据保存在本地')));
  f.complete({ complete: true, revision: board.revision, summary: 'Done' });
  await f.completion;
  assert.equal(f.service.runtimeSummary('current').busy, false);
});

test('user-selected assist sourceEvidence seeds foundational blackboard facts', async t => {
  const f = await fixture(t, 'goal', '用户初始事实', {}, undefined, {
    sourceEvidence: [{
      id: 'ev-1',
      statement: '协助模式选定端点',
      observations: ['响应码 200'],
      toolCallIds: ['tool-9'],
      createdAt: Date.now()
    }]
  });
  const contents = (f.service.state('current').blackboard?.nodes || [])
    .filter(node => node.kind === 'fact')
    .map(node => node.fact?.content || '');
  assert.ok(contents.some(text => text.includes('用户初始事实')), contents.join('\n---\n'));
  assert.ok(contents.some(text => /Assist-mode foundational evidence[\s\S]*not completion proof[\s\S]*协助模式选定端点/.test(text)), contents.join('\n---\n'));
  assert.ok(contents.some(text => text.includes('响应码 200') && text.includes('tool-9')), contents.join('\n---\n'));
  f.complete({ complete: true, revision: 1, summary: 'Done' });
  await f.completion;
});

test('completed goals re-run when newly attached assist sourceEvidence is not yet on the board', async t => {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'ubovm-late-evidence-'));
  let service;
  t.after(async () => {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'ide'));
  await mkdir(path.join(directory, 'agents/collaboration'), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'index.mjs'), `
      export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../../harness/blackboard/database/database.mjs')).href)};
      export async function createHarness(options) {
        const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
        return { snapshot: () => board, memory: () => ({ notes: [] }), middlewareStatus: () => ({}), close: async () => {}, cancel() {},
          addFact: async fact => { board.nodes.push({ id: 'fact-' + board.nodes.length, kind: 'fact', parentIds: fact.parentIds, childIds: [], fact, attempts: [] }); board.revision++; },
          run: async () => ({ complete: true, summary: 'seeded', evidenceIds: [], rounds: 1, revision: board.revision }),
          resume: async () => ({ complete: true, summary: 'seeded', evidenceIds: [], rounds: 1, revision: board.revision }) };
      }`),
    writeFile(path.join(directory, 'agents/collaboration/index.mjs'), 'export const runCollaboration = async () => "unused";'),
    writeFile(path.join(directory, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];')
  ]);
  const waitIdle = () => new Promise(resolve => {
    const timer = setInterval(() => {
      if (!service.isBusy('late')) { clearInterval(timer); resolve(); }
    }, 5);
  });
  service = createHarnessService({
    workspaceRoots: () => [directory],
    sdkPath: path.join(directory, 'index.mjs'),
    storageDirectory: path.join(directory, 'storage'),
    readConfiguration: async () => ({}),
    onChange: () => {}
  });
  await service.start({ conversationId: 'late', mode: 'goal', goal: { objective: 'Late attach goal', initialFacts: '初始' } });
  await waitIdle();
  assert.equal(service.state('late').status, 'completed');
  const noop = await service.start({ conversationId: 'late', mode: 'goal', goal: { objective: 'Late attach goal', initialFacts: '初始' } });
  assert.equal(noop.status, 'completed');
  await service.start({
    conversationId: 'late',
    mode: 'goal',
    goal: {
      objective: 'Late attach goal',
      initialFacts: '初始',
      sourceEvidence: [{ id: 'ev-late', statement: '完成后附加的协助证据', observations: ['应在下次启动注入'], createdAt: Date.now() }]
    }
  });
  await waitIdle();
  const contents = (service.state('late').blackboard?.nodes || [])
    .filter(node => node.kind === 'fact')
    .map(node => node.fact?.content || '');
  assert.ok(contents.some(text => /完成后附加的协助证据/.test(text)), contents.join('\n---\n'));
  assert.equal(service.state('late').status, 'completed');
});

test('removal rejects running sessions and clears only the deleted conversation storage after completion', async t => {
  const f = await fixture(t, 'goal');
  const { access, readFile } = require('node:fs/promises');
  const { createHash } = require('node:crypto');
  const key = id => createHash('sha256').update(id).digest('hex').slice(0, 32);
  const removed = path.join(f.directory, 'storage', key('current'));
  const retained = path.join(f.directory, 'storage', key('other'));
  await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, 'retain.txt'), 'untouched');
  await assert.rejects(f.service.remove('current'), { code: 'SESSION_BUSY' });
  await assert.rejects(f.service.releaseWorkspace('current'), { code: 'SESSION_BUSY' });
  await access(removed);
  f.complete({ complete: true, revision: 1, summary: 'Done' }); await f.completion;
  await f.service.remove('current');
  await assert.rejects(access(removed), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(retained, 'retain.txt'), 'utf8'), 'untouched');
  assert.equal(f.service.state('current').status, 'idle');
  assert.equal(f.service.state('current').canResume, false);
});

for (const toolName of ['run_python', 'manage_python_environment', 'run_local_shell_command', 'run_linux_ssh_command', 'run_local_skill_script', 'upload_sftp', 'deploy_remote_service']) test(`${toolName} deltas accumulate and the final tool result replaces the preview`, async t => {
  const f = await fixture(t);
  const base = { toolName, toolCallId: 'process-1' };
  f.event({ ...base, type: 'tool_execution_start', args: { code: 'print(1)', reason: 'test' } });
  for (const text of ['first\n', 'second\n']) f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text }] } });
  assert.equal(f.service.state('current').parts.find(part => part.type === 'tool').output, 'first\nsecond\n');
  f.event({ ...base, type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'first\nsecond\nexit_code: 0' }] } });
  const part = f.service.state('current').parts.find(part => part.type === 'tool');
  assert.equal(part.status, 'completed'); assert.equal(part.output, 'first\nsecond\nexit_code: 0');
  f.complete('Done'); await f.completion;
});

test('long process output keeps advancing within the UI budget and retains the final tail', async t => {
  const f = await fixture(t);
  const base = { toolName: 'run_local_shell_command', toolCallId: 'long-process' };
  f.event({ ...base, type: 'tool_execution_start', args: {} });
  let full = '';
  for (const text of ['first\n' + 'x'.repeat(15000), '\nsecond\n', '\nlast\npassword=hidden-value\n']) {
    full += text;
    f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text }] } });
    const part = f.service.state('current').parts.find(part => part.type === 'tool');
    assert(part.output.length <= 12000);
    assert.equal(part.outputTail, true);
    assert.equal(part.status, 'running');
    assert(!part.output.includes('hidden-value'));
    if (text.includes('second')) assert(part.output.endsWith('second\n'));
    if (text.includes('last')) assert(part.output.includes('last\n'));
  }
  f.event({ ...base, type: 'tool_execution_end', result: { content: [{ type: 'text', text: full + 'finished\n' }] } });
  const part = f.service.state('current').parts.find(part => part.type === 'tool');
  assert(part.output.endsWith('finished\n')); assert.equal(part.status, 'completed');
  assert.equal(part.outputTail, true); assert(!part.output.includes('hidden-value'));
  assert.deepEqual(cleanTimelineParts([part]), [part]);
  f.complete('Done'); await f.completion;
});

test('process bursts preserve completed history, bounded output and snapshot isolation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 80; i++) {
    const base = { toolName: 'run_local_shell_command', toolCallId: `completed-${i}` };
    f.event({ ...base, type: 'tool_execution_start', args: { command: `command-${i}` } });
    f.event({ ...base, type: 'tool_execution_end', result: { content: [{ type: 'text', text: `history-${i}\n` + 'line\n'.repeat(200) }] } });
  }
  const before = f.service.state('current').parts;
  const base = { toolName: 'run_linux_ssh_command', toolCallId: 'live-burst' };
  f.event({ ...base, type: 'tool_execution_start', args: {} });
  for (let i = 0; i < 1000; i++) f.event({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: `progress-${i}\n` }] } });
  const snapshot = f.service.state('current');
  assert.deepEqual(snapshot.parts.slice(0, -1), before);
  assert(snapshot.parts.at(-1).output.endsWith('progress-999\n'));
  assert(snapshot.parts.at(-1).output.length <= 12000);
  snapshot.parts[0].output = 'changed externally';
  assert.deepEqual(f.service.state('current').parts.slice(0, -1), before);
  f.complete('Done'); await f.completion;
});

test('stream bursts project the latest text once while keeping snapshots detached and redacted', async t => {
  const f = await fixture(t);
  assert.equal(f.service.isBusy('current'), true);
  assert.equal(f.service.isBusy('missing'), false);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  let contentReads = 0, latest = '';
  const message = { role: 'assistant', get content() { contentReads++; return [{ type: 'text', text: latest }]; } };
  for (let index = 0; index < 1000; index++) {
    latest = `chunk ${index} api_key=supersecret`;
    f.event({ type: 'message_update', message });
  }
  assert.equal(contentReads, 0, 'unobserved token updates do not repeatedly traverse message contents');
  const snapshot = f.service.state('current');
  assert(contentReads > 0 && contentReads < 10, 'only the last token snapshot is projected');
  assert.match(snapshot.parts[0].text, /chunk 999/);
  assert(!JSON.stringify(snapshot).includes('supersecret'));
  snapshot.parts[0].text = 'tampered';
  snapshot.activities.push({ label: 'tampered' });
  snapshot.workers.push({ id: 'tampered' });
  const clean = f.service.state('current');
  assert.match(clean.parts[0].text, /chunk 999/);
  assert.equal(clean.activities.length, 0);
  assert.equal(clean.workers.length, 0);
  f.complete('finished');
  await f.completion;
  assert.equal(f.service.isBusy('current'), false);
  assert.equal(f.delivered[0].text, 'finished');
});

test('deferred text preserves ordering across tools and commits the final answer once', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'before tool' } });
  f.event({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-1', args: { path: 'fixture.txt' } });
  f.event({ type: 'tool_execution_end', toolName: 'read_file', toolCallId: 'tool-1', result: 'file text' });
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'stale partial' } });
  f.event({ type: 'message_end', message: { role: 'assistant', content: 'final answer' } });
  f.complete('final answer');
  await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text', 'tool', 'text']);
  assert.deepEqual(f.delivered[0].parts.filter(part => part.type === 'text').map(part => part.text), ['before tool', 'final answer']);
  assert.equal(f.delivered[0].parts[1].status, 'completed');
});

test('cancellation retains the latest unpublished partial text', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'last visible progress' } });
  f.service.cancel('current');
  await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted');
  assert.equal(state.busy, false);
  assert.equal(state.parts[0].text, 'last visible progress');
  assert.equal(f.delivered.length, 1);
});

test('collaboration worker events expose status and tools without replacing the root chat response', async t => {
  const f = await fixture(t);
  assert.equal(f.route, 'collaboration');
  assert.equal(f.service.state('current').phase, 'chat');
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'root progress' } });
  f.event({ type: 'swarm.status', workers: [{ id: 'worker-1', parentId: 'root', task: 'Inspect a file', depth: 1, status: 'running' }] });
  const workerEvent = event => f.event({ type: 'swarm.worker.event', workerId: 'worker-1', parentId: 'root', event });
  workerEvent({ type: 'message_start', message: { role: 'assistant' } });
  workerEvent({ type: 'message_update', message: { role: 'assistant', content: 'private worker response' } });
  workerEvent({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-1', args: { path: 'fixture.txt' } });
  workerEvent({ type: 'tool_execution_end', toolName: 'read_file', toolCallId: 'tool-1', result: 'worker evidence' });
  workerEvent({ type: 'message_end', message: { role: 'assistant', content: 'private worker response' } });
  const working = f.service.state('current');
  assert.equal(working.streamText, 'root progress');
  assert.equal(working.workers[0].description, 'Inspect a file');
  assert.equal(working.workers[0].status, 'running');
  const workerTool = working.workers[0].parts.find(part => part.type === 'tool');
  assert.equal(workerTool.workerId, 'worker-1');
  assert.equal(workerTool.output, 'worker evidence');
  assert(!JSON.stringify(working.parts).includes('private worker response'));
  f.event({ type: 'swarm.status', workers: [{ id: 'worker-1', parentId: 'root', task: 'Inspect a file', depth: 1, status: 'completed' }] });
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_end', message: { role: 'assistant', content: 'root final answer' } });
  f.complete('root final answer');
  await f.completion;
  assert.equal(f.service.state('current').workers[0].status, 'completed');
  assert.equal(f.delivered[0].text, 'root final answer');
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text', 'text']);
  assert(!JSON.stringify(f.delivered).includes('private worker response'));
});

test('goal mode continues to use the Reason/Worker harness instead of collaboration Chat', async t => {
  const f = await fixture(t, 'goal');
  assert.equal(f.route, 'goal');
  assert.equal(f.service.state('current').phase, 'reason');
  f.event({ type: 'reason.start' });
  f.event({ type: 'reason.decision' });
  f.complete({ complete: true, revision: 1, summary: 'goal verified' });
  await f.completion;
  assert.equal(f.service.state('current').status, 'completed');
  assert.equal(f.delivered[0].text, 'goal verified');
  assert(f.delivered[0].id.startsWith('goal:'));
});

test('cancellation settles projected queued and waiting collaboration workers', async t => {
  const f = await fixture(t);
  f.event({ type: 'swarm.status', workers: [
    { id: 'parent', parentId: 'root', task: 'Await the nested worker', depth: 1, status: 'waiting' },
    { id: 'child', parentId: 'parent', task: 'Queued nested task', depth: 2, status: 'queued' }
  ] });
  f.service.cancel('current');
  await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted');
  assert(state.workers.every(worker => worker.status === 'interrupted'));
  assert(state.activities.every(item => item.status === 'interrupted'));
});

const assistant = content => ({ role: 'assistant', content });
const thought = thinking => ({ type: 'thinking', thinking, thinkingSignature: 'provider-signature-never-display' });
const thinkingEvent = (type, content, contentIndex = 0) => ({ type: 'message_update', message: assistant(content), assistantMessageEvent: { type, contentIndex } });

test('thinking streams separately, coalesces snapshots and completes before the final answer', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_start', [thought('')]));
  assert.deepEqual(f.service.state('current').parts, [], 'an empty thinking start does not invent display text');
  let reads = 0, latest = '';
  const message = { role: 'assistant', get content() { reads++; return [thought(latest)]; } };
  for (let i = 0; i < 1000; i++) { latest = `Inspect ${i} api_key=thinking-secret`; f.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: String(i) } }); }
  assert.equal(reads, 0);
  const running = f.service.state('current');
  assert(reads > 0 && reads < 10);
  assert.equal(running.streamText, '');
  assert.equal(running.parts.length, 1);
  assert.equal(running.parts[0].source, 'assistant');
  assert.equal(running.parts[0].status, 'running');
  assert.match(running.parts[0].text, /Inspect 999/);
  assert(!JSON.stringify(running).includes('thinking-secret'));
  assert(!JSON.stringify(running).includes('provider-signature'));
  f.event(thinkingEvent('thinking_end', [thought('Inspect the result.')]));
  const completed = f.service.state('current').parts[0];
  assert.equal(completed.id, running.parts[0].id);
  assert.equal(completed.status, 'completed');
  assert(completed.startedAt > 0 && completed.endedAt >= completed.startedAt);
  const content = [thought('Inspect the result.'), { type: 'text', text: 'Verified answer.' }];
  f.event(thinkingEvent('text_start', content, 1));
  f.event({ type: 'message_end', message: assistant(content) });
  f.complete('Verified answer.'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['thinking', 'text']);
  assert.equal(f.delivered[0].parts[0].endedAt, completed.endedAt);
  assert.equal(f.delivered[0].parts[1].text, f.delivered[0].text);
});

test('redacted provider blocks stay hidden and ordinary think tags remain ordinary prose', async t => {
  const f = await fixture(t);
  const content = [{ ...thought('encrypted-payload-never-display'), redacted: true }, { type: 'thinking', thinkingSignature: 'signature-only-never-display' }, { type: 'redacted_thinking', data: 'raw-secret' }, { type: 'text', text: '<think>ordinary text</think>' }];
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_delta', [thought('temporary plaintext later withdrawn')]));
  assert.equal(f.service.state('current').parts[0].text, 'temporary plaintext later withdrawn');
  f.event(thinkingEvent('thinking_delta', [content[0]]));
  assert.deepEqual(f.service.state('current').parts, []);
  f.event(thinkingEvent('thinking_end', [thought('temporary plaintext later withdrawn')]));
  assert.deepEqual(f.service.state('current').parts, [], 'a later stale snapshot cannot resurrect a redacted block');
  f.event({ type: 'message_end', message: assistant(content) });
  f.complete('<think>ordinary text</think>'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text']);
  assert.equal(f.delivered[0].parts[0].text, '<think>ordinary text</think>');
  assert(!JSON.stringify(f.delivered).includes('never-display'));
  assert(!JSON.stringify(f.delivered).includes('raw-secret'));
});

test('cancellation retains an unpublished thinking-only response as interrupted', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_start', [thought('')]));
  f.event(thinkingEvent('thinking_delta', [thought('Partial visible reasoning.')]));
  f.service.cancel('current'); await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted'); assert.equal(state.streamText, '');
  assert.equal(state.parts.length, 1); assert.equal(state.parts[0].type, 'thinking');
  assert.equal(state.parts[0].status, 'interrupted');
  assert(state.parts[0].endedAt >= state.parts[0].startedAt);
  assert.equal(f.delivered.length, 1);
});

test('worker thinking identities and timers do not overwrite root or sibling messages', async t => {
  const f = await fixture(t);
  const worker = (id, event) => f.event({ type: 'swarm.worker.event', workerId: id, event });
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_delta', [thought('Root analysis')]));
  const rootId = f.service.state('current').parts[0].id;
  for (const id of ['one', 'two']) {
    worker(id, { type: 'message_start', message: assistant([]) });
    worker(id, thinkingEvent('thinking_delta', [thought(`Worker ${id}`)]));
  }
  worker('one', thinkingEvent('thinking_end', [thought('Worker one finished')]));
  worker('two', thinkingEvent('thinking_delta', [thought('Worker two still running')]));
  f.event(thinkingEvent('text_start', [thought('Root analysis'), { type: 'text', text: 'Root progress' }], 1));
  const snapshot = f.service.state('current');
  assert.equal(snapshot.parts[0].id, rootId); assert.equal(snapshot.parts[0].status, 'completed');
  const one = snapshot.workers.find(worker => worker.id === 'one').parts[0], two = snapshot.workers.find(worker => worker.id === 'two').parts[0];
  assert.equal(one.workerId, 'one'); assert.equal(one.status, 'completed');
  assert.equal(two.workerId, 'two'); assert.equal(two.status, 'running');
  assert.equal(new Set([...snapshot.parts, one, two].map(part => part.id)).size, snapshot.parts.length + 2);
  assert.equal(snapshot.streamText, 'Root progress');
  worker('two', { type: 'message_end', message: assistant([thought('Worker two still running'), { type: 'text', text: 'private-worker-protocol' }]) });
  f.event({ type: 'message_end', message: assistant([thought('Root analysis'), { type: 'text', text: 'Root final' }]) });
  f.complete('Root final'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['thinking', 'text']);
  assert.equal(f.delivered[0].parts[0].id, rootId);
  assert(!JSON.stringify(f.delivered).includes('private-worker-protocol'));
});

test('Reason and goal Worker thinking retain sources while protocol JSON stays hidden', async t => {
  const f = await fixture(t, 'goal');
  const reason = event => f.event({ type: 'reason.event', event: { type: 'pi_event', event } });
  const worker = event => f.event({ type: 'worker.event', timestamp: '2026-09-21T08:00:00.000Z', event: { type: 'pi_event', intentId: 'goal-worker', attemptId: 'attempt-1', event } });
  reason({ type: 'message_start', message: assistant([]) });
  reason(thinkingEvent('thinking_delta', [thought('Choose an evidence check.')]));
  worker({ type: 'message_start', message: assistant([]) });
  worker(thinkingEvent('thinking_delta', [thought('Inspect the file.')]));
  reason({ type: 'message_end', message: assistant([thought('Choose an evidence check.'), { type: 'text', text: '{"intents":[]}' }]) });
  worker({ type: 'message_end', message: assistant([thought('Inspect the file.'), { type: 'text', text: '{"steps":[]}' }]) });
  f.complete({ complete: true, revision: 1, summary: 'Goal complete' }); await f.completion;
  const parts = f.delivered[0].parts;
  assert.deepEqual(parts.map(part => part.type), ['thinking', 'text']);
  const workerThinking = f.service.state('current').workers.find(worker => worker.id === 'goal-worker').parts[0];
  assert.equal(parts[0].source, 'reason'); assert.equal(workerThinking.source, 'worker');
  assert.equal(workerThinking.workerId, 'goal-worker'); assert.equal(workerThinking.startedAt, Date.parse('2026-09-21T08:00:00.000Z'));
  assert(!JSON.stringify(parts).includes('intents')); assert(!JSON.stringify(parts).includes('steps'));
  const { readFile, readdir } = require('node:fs/promises');
  const storage = path.join(f.directory, 'storage');
  const conversation = path.join(storage, (await readdir(storage))[0]);
  const goal = path.join(conversation, (await readdir(conversation))[0]);
  const saved = JSON.parse(await readFile(path.join(goal, 'goal-timeline.json'), 'utf8'));
  assert.deepEqual(saved.parts, parts);
  assert(!JSON.stringify(saved).includes('provider-signature'));
});

test('long timelines keep all earlier fragments without an omission placeholder', () => {
  const input = Array.from({ length: 240 }, (_, i) => ({ id: 'part-' + i, type: 'text', text: '记录 ' + i + ' 内容'.repeat(2000), status: 'completed' }));
  const cleaned = cleanTimelineParts(input);
  assert.deepEqual(cleaned, input);
  assert.deepEqual(cleanTimelineParts(JSON.parse(JSON.stringify(cleaned))), input);
});

test('thinking cleaners whitelist plaintext, redact credentials and retain every earlier fragment', () => {
  const thinking = { id: 'thinking', type: 'thinking', source: 'assistant', status: 'completed', text: 'api_key=private-secret\n' + 'analysis '.repeat(5000), startedAt: 100, endedAt: 150, signature: 'signature-secret', thinkingSignature: 'secret-signature', encrypted: 'opaque-secret' };
  const parts = cleanTimelineParts([thinking, { ...thinking, id: 'redacted', redacted: true }, ...Array.from({ length: 10 }, (_, index) => ({ ...thinking, id: `thinking-${index}` })), { id: 'final', type: 'text', text: 'Final '.repeat(12000), status: 'completed' }]);
  assert(parts.every(part => part.type !== 'thinking' || part.text.length <= 12000));
  assert.equal(parts.at(-1).text.length, 64000);
  assert.equal(parts.filter(part => part.type === 'thinking').length, 11);
  assert(parts.filter(part => part.type === 'thinking').every(part => part.text.length === 12000));
  assert(parts.some(part => part.truncated));
  assert(!parts.some(part => part.id === 'redacted'));
  assert(!/private-secret|signature-secret|secret-signature|opaque-secret/.test(JSON.stringify(parts)));
  assert.deepEqual(cleanTimelineParts(parts), parts);
});

test('context summary reminders keep their identity, content and estimates in the timeline without duplicate activities', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event({ type: 'message_update', message: assistant([{ type: 'text', text: 'Before compaction' }]) });
  const start = { type: 'context.summary_start', scope: 'chat:fixture', operationId: 'summary-1', startedAt: 100 };
  f.event(start);
  const initial = f.service.state('current');
  assert.deepEqual(initial.parts.map(part => part.type), ['text', 'summary']);
  assert.equal(initial.parts[1].status, 'running');
  assert.equal(initial.parts[1].text, '');
  const end = { ...start, type: 'context.summary_end', status: 'completed', endedAt: 350, text: 'Keep verified findings. api_key=summary-secret', beforeTokens: 9000, afterTokens: 2000, fallback: true };
  f.event({ type: 'context.summary', scope: start.scope, artifactId: 'artifact', fallback: true });
  f.event(end); f.event(end); f.event(start);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event({ type: 'message_end', message: assistant([{ type: 'text', text: 'Final answer' }]) });
  f.complete('Final answer'); await f.completion;
  const parts = f.delivered[0].parts;
  assert.deepEqual(parts.map(part => part.type), ['text', 'summary', 'text']);
  assert.equal(parts[1].id, initial.parts[1].id);
  assert.equal(parts[1].status, 'completed'); assert.equal(parts[1].endedAt, 350);
  assert.equal(parts[1].beforeTokens, 9000); assert.equal(parts[1].afterTokens, 2000); assert.equal(parts[1].fallback, true);
  assert(!JSON.stringify(parts).includes('summary-secret'));
  assert(!f.service.state('current').activities.some(item => item.label.startsWith('context.')));
  assert.deepEqual(cleanTimelineParts(parts), parts);
});

test('summary reminders remain scoped to worker views and cancelled root summaries stop', async t => {
  const f = await fixture(t);
  f.event({ type: 'context.summary_start', scope: 'worker:child', operationId: 'child-summary', startedAt: 100 });
  f.event({ type: 'context.summary_end', scope: 'worker:child', operationId: 'child-summary', startedAt: 100, endedAt: 200, status: 'failed', text: '' });
  const state = f.service.state('current');
  assert.equal(state.parts.length, 0);
  const part = state.workers.find(worker => worker.id === 'child').parts[0];
  assert.equal(part.type, 'summary'); assert.equal(part.source, 'worker'); assert.equal(part.status, 'failed');
  f.event({ type: 'context.summary_start', scope: 'chat:fixture', operationId: 'root-summary', startedAt: 100 });
  f.service.cancel('current'); await f.completion;
  assert.equal(f.service.state('current').parts[0].status, 'interrupted');
});

test('goal middleware summaries use the same persisted inline reminder', async t => {
  const f = await fixture(t, 'goal');
  for (const event of [
    { type: 'context.summary_start', scope: 'reason', operationId: 'reason-summary', startedAt: 100 },
    { type: 'context.summary_end', scope: 'reason', operationId: 'reason-summary', startedAt: 100, endedAt: 200, status: 'completed', text: 'Evidence summary', beforeTokens: 5000, afterTokens: 900 }
  ]) f.event({ type: 'middleware.event', event });
  f.complete({ complete: true, revision: 1, summary: 'Goal done' }); await f.completion;
  assert.equal(f.delivered[0].parts[0].type, 'summary');
  assert.equal(f.delivered[0].parts[0].source, 'reason');
  assert.equal(f.delivered[0].parts[0].text, 'Evidence summary');
});

test('desktop assistance installs fail-closed approval by default, switch disables it, goal mode is unchanged', async t => {
  const enabled = await fixture(t);
  assert.equal(typeof enabled.running.requestToolApproval, 'function');
  assert.throws(() => enabled.running.requestToolApproval({ toolName: 'test' }), /人工审核界面不可用/);
  enabled.complete('done'); await enabled.completion;
  const disabled = await fixture(t, 'assist', '', { worker: { requireToolApproval: false } });
  assert.equal(disabled.running.requestToolApproval, undefined);
  disabled.complete('done'); await disabled.completion;
  const goal = await fixture(t, 'goal');
  assert.equal(goal.running.requestToolApproval, undefined);
  goal.complete({ complete: true, revision: 1, summary: 'done' }); await goal.completion;
});

test('composer mode overrides settings for each submitted assistance turn', async t => {
  const automatic = await fixture(t, 'assist', '', { worker: { requireToolApproval: true } }, 'auto');
  assert.equal(automatic.running.requestToolApproval, undefined);
  automatic.complete('done'); await automatic.completion;
  const manual = await fixture(t, 'assist', '', { worker: { requireToolApproval: false } }, 'manual');
  assert.equal(typeof manual.running.requestToolApproval, 'function');
  manual.complete('done'); await manual.completion;
  await assert.rejects(manual.service.start({ conversationId: 'bad', mode: 'assist', text: 'test', approvalMode: 'invalid' }), /无效的工具执行方式/);
});
