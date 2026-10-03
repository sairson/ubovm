'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHarnessService } = require('../../host/agent/agent-service.cjs');

test('closing a real worker service releases its cached timeline', async t => {
  const f = await fixture(t, "return 'completed before close';");
  await f.start(); await f.done;
  assert(f.service.state('test').parts.length > 0);
  await f.close();
  assert.equal(f.service.state('test').parts.length, 0);
  assert.equal(f.service.runtimeSummary('test').status, 'idle');
});

test('manual command interruption crosses the worker boundary without stopping the agent', async t => {
  const id = '22222222-2222-4222-8222-222222222222';
  const f = await fixture(t, `
    let done;
    const interrupted = new Promise(resolve => { done = resolve; });
    const release = options.configuration.intools.onCommand({ id: '${id}', toolCallId: 'shell', name: 'run_local_shell_command', workerId: 'root', interrupt() { done(); return true; } });
    const base = { toolName: 'run_local_shell_command', toolCallId: 'shell' };
    options.onEvent({ ...base, type: 'tool_execution_start', args: { command: 'long-running-command' } });
    options.onEvent({ ...base, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'partial output' }], details: { command_id: '${id}' } } });
    await interrupted; release();
    options.signal.throwIfAborted();
    options.onEvent({ ...base, type: 'tool_execution_end', isError: true, result: { content: [{ type: 'text', text: 'user stopped; partial output' }] } });
    return 'agent continued';
  `);
  await f.start();
  await waitFor(() => f.service.state('test').parts.some(part => part.commandId === id));
  assert.equal(await f.service.interruptCommand('other', id), false);
  assert.equal(await f.service.interruptCommand('test', id), true);
  await f.done;
  assert.equal(f.messages[0].text, 'agent continued');
  assert.equal(f.messages[0].parts.find(part => part.commandId === id).status, 'interrupted');
  assert.equal(await f.service.interruptCommand('test', id), false);
});
async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'state transition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, body, overrides = {}) {
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'ubovm-thread-'));
  let service;
  t.after(async () => {
    await service?.close();
    const relative = path.relative(parent, root);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'agents/collaboration'), { recursive: true });
  await fs.mkdir(path.join(root, 'ide'));
  await fs.cp(path.resolve(__dirname, '../../../harness/ide/runtime'), path.join(root, 'ide/runtime'), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../../../harness/assist-evidence.cjs'), path.join(root, 'assist-evidence.cjs'));
  await fs.writeFile(path.join(root, 'index.mjs'), `export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../harness/blackboard/database/database.mjs')).href)};`);
  await fs.writeFile(path.join(root, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];');
  await fs.writeFile(path.join(root, 'agents/collaboration/index.mjs'), `import { threadId } from 'node:worker_threads'; export async function runCollaboration(options) { ${body} }`);
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  let wasBusy = false;
  const messages = [];
  service = createHarnessService({ sdkPath: path.join(root, 'index.mjs'), storageDirectory: path.join(root, 'storage'),
    workspaceRoots: () => [root], readConfiguration: async () => ({}),
    onMessage: (id, message) => messages.push(message),
    onChange: id => { if (service.isBusy(id)) wasBusy = true; else if (wasBusy) complete(); }, ...overrides });
  return { root, service, done, messages,
    async close() { try { await service.close(); } finally { service = undefined; } },
    start: () => service.start({ conversationId: 'test', mode: 'assist', text: 'hello' }) };
}

test('start pins the request before synchronous observers and async session preparation', async t => {
  let release, entered = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const input = { conversationId: 'test', mode: 'assist', text: 'original' };
  const messages = [];
  const f = await fixture(t, 'return options.text;', {
    beforeSession: async () => { entered++; await gate; },
    onChange: () => { input.conversationId = 'wrong'; input.text = 'changed by observer'; },
    onMessage: (id, message) => messages.push({ id, text: message.text })
  });
  const starting = f.service.start(input);
  assert.equal(entered, 1);
  input.text = 'changed while waiting'; release(); await starting;
  await waitFor(() => messages.length === 1);
  assert.deepEqual(messages, [{ id: 'test', text: 'original' }]);
  assert.equal(f.service.isBusy('wrong'), false);
});

test('restore pins its session before workspace preparation', async t => {
  let release;
  const changed = [];
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, "throw Error('restore must not run the model');", { beforeSession: () => gate, onChange: id => changed.push(id) });
  const input = { conversationId: 'original', mode: 'assist' };
  const restoring = f.service.restore(input);
  input.conversationId = 'changed'; input.mode = 'goal';
  release(); await restoring;
  assert(changed.includes('original'));
  assert.equal(changed.includes('changed'), false);
});

test('uncloneable session requests reject before taking locks or notifying launch observers', async t => {
  let preparations = 0, notifications = 0;
  const f = await fixture(t, "return 'recovered';", {
    beforeSession: () => { preparations++; }, onChange: () => { notifications++; }
  });
  for (const method of ['start', 'restore']) {
    await assert.rejects(f.service[method]({ conversationId: 'test', mode: 'assist', context: { callback() {} } }), { name: 'DataCloneError' });
    assert.equal(f.service.isBusy('test'), false);
    assert.equal(f.service.connectionState().status, 'idle');
  }
  assert.equal(preparations, 0); assert.equal(notifications, 0);
  await f.start(); await waitFor(() => f.messages.length === 1);
  assert.equal(f.messages[0].text, 'recovered');
});

test('steering crosses the worker boundary and remains scoped to a running conversation', async t => {
  const f = await fixture(t, `return await new Promise(resolve => {
    options.registerSteering(input => resolve('steered: ' + input.text));
  });`);
  await f.start();
  assert.equal(await f.service.steer('other', { id: 'direction', runId: 'wrong', text: 'wrong session' }), false);
  await waitFor(() => f.service.state('test').canSteer === true);
  assert.equal(await f.service.steer('test', { id: 'direction', runId: f.service.state('test').runId, text: 'new direction' }), true);
  await f.done;
  assert.equal(f.messages[0].text, 'steered: new direction');
  await waitFor(() => !f.service.isBusy('test') && f.service.state('test').canSteer !== true);
  assert.equal(await f.service.steer('test', { id: 'direction', runId: f.service.state('test').runId, text: 'too late' }), false);
});

test('steering rejects stale runs and deduplicates a repeated input before delivery', async t => {
  const f = await fixture(t, `let calls = 0; return await new Promise(resolve => {
    options.registerSteering(input => { calls++; if (input.text === 'finish') resolve(String(calls)); });
  });`);
  await f.start();
  await waitFor(() => f.service.state('test').canSteer === true);
  const input = { id: 'direction', runId: f.service.state('test').runId, text: 'adjust' };
  assert.equal(await f.service.steer('test', { ...input, runId: 'old' }), false);
  assert.equal(await f.service.steer('test', input), true);
  assert.equal(await f.service.steer('test', input), true);
  await assert.rejects(f.service.steer('test', { ...input, text: 'changed' }), /不同内容/);
  assert.equal(await f.service.steer('test', { ...input, id: 'end', text: 'finish' }), true);
  await f.done;
  assert.equal(f.messages[0].text, '2');
});

test('steering captures caller input before async transport setup', async t => {
  const f = await fixture(t, `return await new Promise(resolve => {
    options.registerSteering(input => resolve(JSON.stringify(input)));
  });`);
  await f.start(); await waitFor(() => f.service.state('test').canSteer === true);
  const input = { id: 'capture', runId: f.service.state('test').runId, text: 'original', context: { file: 'original.js' } };
  const sending = f.service.steer('test', input);
  input.text = 'mutated'; input.context.file = 'mutated.js';
  assert.equal(await sending, true); await f.done;
  const received = JSON.parse(f.messages[0].text);
  assert.equal(received.text, 'original'); assert.equal(received.context.file, 'original.js');
});

test('an SDK error after steering admission cannot claim a safe pre-delivery rejection', async t => {
  const f = await fixture(t, `return await new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    options.registerSteering(() => { throw Object.assign(Error('after admission'), { code: 'STEERING_NOT_SENT' }); });
  });`);
  await f.start(); await waitFor(() => f.service.state('test').canSteer === true);
  await assert.rejects(f.service.steer('test', { id: 'direction', runId: f.service.state('test').runId, text: 'new direction' }), { code: 'STEERING_DELIVERY_ERROR' });
  f.service.cancel('test'); await f.done;
});

test('a hung worker soft-stalls then is killed without replaying its task', { timeout: 15000 }, async t => {
  const f = await fixture(t, "setTimeout(() => { while (true) {} }, 10); await new Promise(() => {});", {
    heartbeatInterval: 25, heartbeatTimeout: 200, heartbeatKillTimeout: 600
  });
  await f.start();
  await waitFor(() => f.service.connectionState().status === 'stalled');
  assert.equal(f.service.isBusy('test'), true, 'soft stall must keep the hung turn alive');
  await waitFor(() => f.service.connectionState().status === 'disconnected');
  await waitFor(() => !f.service.isBusy('test'));
  assert.equal(f.service.state('test').status, 'failed');
  assert.equal(f.service.state('test').error.code, 'AGENT_HEARTBEAT_TIMEOUT');
  assert.equal(f.service.state('test').canResume, true, 'assist becomes explicitly resumable after thread loss');
  assert.equal(f.messages.length, 0);
});

test('foreground sessions wait for local learning to release storage and always release the pause', async t => {
  let enter, resume, released = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const f = await fixture(t, "return 'done';", { beforeSession: async () => { enter(); await gate; return () => { released++; }; } });
  const starting = f.start();
  await entered;
  assert.equal(f.service.connectionState().status, 'idle');
  resume(); await starting;
  assert.equal(released, 1);
  await assert.rejects(f.service.restore({ conversationId: 'invalid', mode: 'invalid' }));
  assert.equal(released, 2);
});

test('a disconnected backend cancels local work and persists cleanup before exiting', { timeout: 10000 }, async t => {
  const f = await fixture(t, `
    const { parentPort } = await import('node:worker_threads');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.directory + '/started', 'ready');
    try {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        setTimeout(() => parentPort.close(), 50);
      });
    } finally {
      await new Promise(resolve => setTimeout(resolve, 30));
      await writeFile(options.directory + '/cleaned', 'cancelled=' + options.signal.aborted);
    }
  `);
  const { Worker } = require('node:worker_threads');
  const { once } = require('node:events');
  const { createRPC } = require('../../../harness/ide/runtime/thread-rpc.cjs');
  const worker = new Worker(path.join(f.root, 'ide/runtime/harness-thread.cjs'), {
    workerData: { sdkPath: path.join(f.root, 'index.mjs'), storageDirectory: path.join(f.root, 'storage') }
  });
  const exited = once(worker, 'exit');
  const rpc = createRPC(worker, method => {
    if (method === 'roots') return [f.root];
    if (method === 'configuration') return {};
    if (method === 'tools') return [];
  });
  t.after(async () => { rpc.close(); await worker.terminate(); });
  await rpc.call('start', [{ conversationId: 'disconnect', mode: 'assist', text: 'run' }]);
  assert.deepEqual(await exited, [0]);
  const files = await fs.readdir(path.join(f.root, 'storage'), { recursive: true });
  const cleaned = files.find(file => path.basename(file) === 'cleaned');
  assert(cleaned, 'transport loss must await local task cleanup');
  assert.equal(await fs.readFile(path.join(f.root, 'storage', cleaned), 'utf8'), 'cancelled=true');
});

test('an asynchronous SDK event failure settles only its run and keeps the agent thread alive', { timeout: 10000 }, async t => {
  const f = await fixture(t, `
    if (options.text === 'bad') await new Promise(resolve => setTimeout(() => { options.onEvent(null); resolve(); }, 5));
    return 'thread:' + threadId;`);
  await f.start(); await f.done;
  const first = f.messages.at(-1).text;
  await f.service.start({ conversationId: 'broken', mode: 'assist', text: 'bad' });
  await waitFor(() => !f.service.isBusy('broken'));
  assert.equal(f.service.state('broken').status, 'failed');
  assert.equal(f.service.state('broken').error.code, 'AGENT_EVENT_ERROR');
  assert.equal(f.service.state('test').status, 'completed');
  await f.service.start({ conversationId: 'after', mode: 'assist', text: 'good' });
  await waitFor(() => !f.service.isBusy('after'));
  assert.equal(f.messages.at(-1).text, first, 'the same backend thread survives');
  assert.equal(f.messages.length, 2, 'failed event processing cannot publish a success');
});

test('host edits can bind to the exact run ID used by the final assistant message', async t => {
  let observed;
  const f = await fixture(t, `const tools = await options.configuration.tools({});
    await tools[0].execute('edit', {}, options.signal); return 'done';`, {
    additionalTools: () => [{ name: 'record-edit', parameters: { type: 'object' }, execute: async () => {
      observed = f.service.state('test').runId; return { content: [] };
    } }]
  });
  await f.start(); await f.done;
  assert.equal(typeof observed, 'string'); assert(observed);
  assert.equal(f.messages[0].id, 'assist:' + observed);
});

test('CPU-bound agent runs on another thread while host timers and tool RPC remain responsive', { timeout: 10000 }, async t => {
  let announce;
  const announced = new Promise(resolve => { announce = resolve; });
  const f = await fixture(t, `
    const tools = await options.configuration.tools({});
    await tools[0].execute('call', { threadId }, options.signal);
    const until = Date.now() + 600;
    while (Date.now() < until) {}
    return 'done';`, {
    additionalTools: () => [{ name: 'probe', parameters: { type: 'object' }, execute: async (_id, input) => {
      assert(input.threadId > 0); announce(); return { content: [] };
    } }]
  });
  await f.start(); await announced;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.service.isBusy('test'), true, 'host timer fires before CPU-bound worker completes');
  await f.done;
  assert.equal(f.service.state('test').status, 'completed');
  assert.equal(f.messages[0].text, 'done');
});

test('cancelling an agent aborts an in-flight host tool', { timeout: 10000 }, async t => {
  let entered, aborted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, `const tools = await options.configuration.tools({});
    await tools[0].execute('call', {}, options.signal); return 'unexpected';`, {
    additionalTools: () => [{ name: 'wait', execute: (_id, _input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); entered();
    }) }]
  });
  await f.start(); await ready;
  assert.equal(f.service.cancel('test'), true);
  await f.done;
  assert.equal(aborted, true);
  assert.equal(f.service.state('test').status, 'interrupted');
  assert.equal(f.messages.length, 0);
});

test('worker exit releases pending requests and marks execution failed', { timeout: 10000 }, async t => {
  const failures = [];
  const f = await fixture(t, 'process.exit(7);', { onError(error) { failures.push(error); return Promise.reject(new Error('logger failed')); } });
  await f.start(); await f.done;
  assert.equal(f.service.isBusy('test'), false);
  assert.equal(f.service.state('test').status, 'failed');
  assert.equal(f.service.state('test').canResume, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /exited \(7\)/);
  // Explicit resume may rebuild the runtime; prior thread exit must not hard-block it.
  await f.service.resume('test');
  await waitFor(() => f.service.state('test').status === 'failed' && !f.service.isBusy('test'));
  assert.equal(f.service.state('test').canResume, true);
});

test('approval signals cross the bridge and cancellation closes pending approval', { timeout: 10000 }, async t => {
  let entered, aborted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, `await options.requestToolApproval({ toolName: 'probe', args: {}, signal: options.signal });
    options.signal.throwIfAborted(); return 'done';`, {
    requestToolApproval: request => new Promise(resolve => {
      assert.equal(request.conversationId, 'test');
      request.signal.addEventListener('abort', () => { aborted = true; resolve(false); }, { once: true }); entered();
    })
  });
  await f.start(); await ready; f.service.cancel('test'); await f.done;
  assert.equal(aborted, true);
  assert.equal(f.service.state('test').status, 'interrupted');
});

test('goal execution and durable delivery also run in the worker', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'throw new Error("goal must not run collaboration");');
  await fs.appendFile(path.join(f.root, 'index.mjs'), `
    import { threadId } from 'node:worker_threads';
    export async function createHarness(options) {
      if (!threadId) throw new Error('not isolated');
      const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
      return { snapshot: () => board, memory: () => ({}), middlewareStatus: () => ({}), close: async () => {},
        addFact: async fact => { board.nodes.push({ id: 'fact', kind: 'fact', parentIds: fact.parentIds, childIds: [], fact, attempts: [] }); board.revision++; },
        run: async () => ({ complete: true, revision: board.revision, summary: 'goal done' }) };
    }`);
  await f.service.start({ conversationId: 'test', mode: 'goal', goal: { objective: 'verify isolation' }, text: 'begin' });
  await f.done;
  assert.equal(f.service.state('test').status, 'completed');
  assert.equal(f.messages[0].text, 'goal done');
  await f.service.releaseWorkspace('test');
  await f.service.remove('test');
  assert.equal(f.service.state('test').status, 'idle');
});

test('crash recovery preserves completed sessions and creates one new runtime without replay', { timeout: 10000 }, async t => {
  const f = await fixture(t, "if (options.text === 'crash') process.exit(8); return String(threadId);");
  await f.start(); await f.done;
  const original = f.messages[0].text;
  await f.service.start({ conversationId: 'crash', mode: 'assist', text: 'crash' });
  await waitFor(() => f.service.state('crash').status === 'failed');
  assert.equal(f.service.state('test').status, 'completed');
  assert.equal(f.messages.length, 1, 'no replay on failure');
  await Promise.all(['one', 'two'].map(conversationId => f.service.restore({ conversationId, mode: 'assist' })));
  for (const conversationId of ['one', 'two']) {
    await f.service.start({ conversationId, mode: 'assist', text: 'new' });
    await waitFor(() => f.service.state(conversationId).status === 'completed');
  }
  assert.equal(f.messages.length, 3);
  assert.notEqual(f.messages[1].text, original);
  assert.equal(f.messages[1].text, f.messages[2].text, 'concurrent restores share one replacement thread');
});

test('shutdown rejects new operations and is idempotent even before first use', async () => {
  const service = createHarnessService({});
  const closing = service.close();
  assert.equal(service.close(), closing);
  await assert.rejects(service.start({ conversationId: 'late', mode: 'assist', text: 'no' }), { code: 'SERVICE_CLOSED' });
  await closing;
  await assert.rejects(service.restore({ conversationId: 'late', mode: 'assist' }), { code: 'SERVICE_CLOSED' });
});

test('IDE reserves a starting session and remembers stop clicks before thread startup', { timeout: 10000 }, async t => {
  let configure;
  const configuration = new Promise(resolve => { configure = resolve; });
  const f = await fixture(t, "throw new Error('model must not run after stop');", { readConfiguration: () => configuration });
  const starting = f.start();
  assert.equal(f.service.isBusy('test'), true);
  assert.equal(f.service.state('test').status, 'starting');
  await assert.rejects(f.start(), { code: 'SESSION_BUSY' });
  await assert.rejects(f.service.releaseWorkspace('test'), { code: 'SESSION_BUSY' });
  assert.equal(f.service.cancel('test'), true);
  await starting; configure({}); await f.done;
  assert.equal(f.service.state('test').status, 'interrupted');
  assert.equal(f.messages.length, 0);
});

test('received timelines and summaries cannot be mutated through IDE cache reads', { timeout: 10000 }, async t => {
  const f = await fixture(t, "return 'saved answer';");
  await f.start(); await f.done;
  const snapshot = f.service.state('test');
  assert.equal(snapshot.parts[0].text, 'saved answer');
  assert.throws(() => { snapshot.busy = true; }, TypeError);
  assert.throws(() => { snapshot.parts[0].text = 'modified'; }, TypeError);
  assert.throws(() => { f.service.runtimeSummary('test').status = 'running'; }, TypeError);
  assert.equal(f.service.state('test'), snapshot, 'reads reuse the immutable snapshot');
  assert.equal(f.service.isBusy('test'), false);
  const restored = await f.service.restore({ conversationId: 'test', mode: 'assist' });
  assert.equal(restored, f.service.state('test'), 'command response and cache share one transported timeline');
});

test('installed host and backend operate without a renderer source tree or SDK environment variable', { timeout: 10000 }, async t => {
  const f = await fixture(t, "return 'unused';");
  const appRoot = path.join(f.root, 'installed');
  const sdk = path.join(appRoot, 'ubovm/harness');
  const host = path.join(appRoot, 'extensions/ubovm-core/host');
  await fs.mkdir(sdk, { recursive: true });
  await fs.mkdir(host, { recursive: true });
  await fs.cp(path.join(f.root, 'ide'), path.join(sdk, 'ide'), { recursive: true });
  await fs.copyFile(path.join(f.root, 'assist-evidence.cjs'), path.join(sdk, 'assist-evidence.cjs'));
  await fs.writeFile(path.join(sdk, 'index.mjs'), 'export {};');
  for (const name of ['agent-backend.cjs', 'agent-service.cjs']) {
    await fs.copyFile(path.resolve(__dirname, '../../host/agent', name), path.join(host, name));
  }
  // VS Code provides this virtual module in production; model only its app path.
  const vscode = path.join(appRoot, 'extensions/ubovm-core/node_modules/vscode');
  await fs.mkdir(vscode, { recursive: true });
  await fs.writeFile(path.join(vscode, 'index.js'), `exports.env = { appRoot: ${JSON.stringify(appRoot)} };`);
  const script = `
    const { createHarnessService } = require(process.argv[1]);
    const service = createHarnessService({ sdkPath: process.argv[2], storageDirectory: process.argv[3], readConfiguration: async () => ({}) });
    (async () => { try {
      const state = await service.restore({ conversationId: 'installed', mode: 'assist' });
      if (state.status !== 'idle' || service.isBusy('installed')) throw new Error('incorrect installed state');
      console.log('installed backend ready');
    } finally { await service.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = await promisify(execFile)(process.execPath, ['-e', script, path.join(host, 'agent-service.cjs'), path.join(sdk, 'index.mjs'), path.join(f.root, 'installed-storage')], {
    env: { ...process.env, UBOVM_HARNESS_ENTRY: '' }, windowsHide: true, timeout: 8000
  });
  assert.match(result.stdout, /installed backend ready/);
});

test('rapid stop clicks coalesce and cannot cancel the next execution', { timeout: 10000 }, async t => {
  let entered, aborts = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, `
    if (options.text === 'next') return 'next answer';
    const tools = await options.configuration.tools({});
    await tools[0].execute('wait', {}, options.signal);
    return 'unexpected';`, {
    additionalTools: () => [{ name: 'wait', execute: (_id, _input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborts++; reject(signal.reason); }, { once: true }); entered();
    }) }]
  });
  await f.start(); await ready;
  for (let index = 0; index < 2000; index++) f.service.cancel('test');
  await f.done;
  assert.equal(aborts, 1);
  assert.equal(f.service.state('test').status, 'interrupted');
  await f.service.start({ conversationId: 'test', mode: 'assist', text: 'next' });
  await waitFor(() => f.service.state('test').status === 'completed');
  assert.equal(f.messages[0].text, 'next answer');
});

test('SDK errors with throwing properties fail one session without restarting the backend', { timeout: 10000 }, async t => {
  const f = await fixture(t, `if (options.text === 'bad') throw new Proxy({}, { get() { throw new Error('error getter'); } }); return String(threadId);`);
  await f.start(); await f.done;
  const originalThread = f.messages[0].text;
  await f.service.start({ conversationId: 'bad', mode: 'assist', text: 'bad' });
  await waitFor(() => !f.service.isBusy('bad'));
  assert.equal(f.service.state('bad').status, 'failed');
  assert.equal(f.service.state('bad').error.message, 'Agent operation failed');
  await f.service.start({ conversationId: 'next', mode: 'assist', text: 'good' });
  await waitFor(() => f.service.state('next').status === 'completed');
  assert.equal(f.messages[1].text, originalThread);
});

test('failure while handling a failed SDK snapshot releases the session without crashing', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'return String(threadId);');
  await fs.appendFile(path.join(f.root, 'index.mjs'), `
    export async function createHarness(options) {
      let broken = false;
      const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
      return { snapshot() { if (broken) throw new Error('snapshot cleanup failed'); return board; },
        memory: () => ({}), middlewareStatus: () => ({}), close: async () => {},
        addFact: async () => {}, run: async () => { broken = true; throw new Error('run failed'); } };
    }`);
  await f.start(); await f.done;
  const originalThread = f.messages[0].text;
  await f.service.start({ conversationId: 'goal', mode: 'goal', goal: { objective: 'test failure' } });
  await waitFor(() => !f.service.isBusy('goal'));
  assert.equal(f.service.state('goal').status, 'failed');
  assert.match(f.service.state('goal').error.message, /snapshot cleanup failed/);
  await f.service.start({ conversationId: 'next', mode: 'assist', text: 'good' });
  await waitFor(() => f.service.state('next').status === 'completed');
  assert.equal(f.messages[1].text, originalThread);
});

test('stream projection failure is reported without losing cancellation or later snapshots', { timeout: 10000 }, async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, `
    if (options.text === 'next') return 'recovered';
    const tools = await options.configuration.tools({});
    await tools[0].execute('wait', {}, options.signal); return 'unexpected';`, {
    additionalTools: () => [{ name: 'wait', execute: (_id, _input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered();
    }) }]
  });
  await fs.appendFile(path.join(f.root, 'ide/runtime/projection.cjs'), `
    const originalProjection = module.exports.redactDisplayObject;
    module.exports.redactDisplayObject = value => {
      if (value.status === 'running' && 'parts' in value) throw new Error('projection fault');
      return originalProjection(value);
    };`);
  await f.start(); await ready;
  await waitFor(() => f.service.state('test').error?.message === 'projection fault');
  assert.equal(f.service.isBusy('test'), true);
  f.service.cancel('test'); await f.done;
  assert.equal(f.service.state('test').status, 'interrupted');
  await f.service.start({ conversationId: 'next', mode: 'assist', text: 'next' });
  await waitFor(() => f.service.state('next').status === 'completed');
  assert.equal(f.service.state('next').error, null);
  assert.equal(f.messages[0].text, 'recovered');
});

test('rejected IDE change observers do not reject execution or crash the host', { timeout: 10000 }, async t => {
  const f = await fixture(t, "return 'done';", { onChange: async () => { throw new Error('UI observer failed'); } });
  await f.start(); await waitFor(() => f.service.state('test').status === 'completed');
  assert.equal(f.messages[0].text, 'done');
});

test('crash recovery waits for old host tools to finish cleanup before allowing new execution', { timeout: 10000 }, async t => {
  let entered, release, sawAbort;
  const ready = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { sawAbort = resolve; });
  const f = await fixture(t, `
    if (options.text === 'crash') process.exit(9);
    if (options.text === 'next') return 'safe restart';
    const tools = await options.configuration.tools({});
    await tools[0].execute('write', {}, options.signal); return 'late';`, {
    additionalTools: () => [{ name: 'write', execute: (_id, _input, signal) => new Promise(resolve => {
      release = resolve; signal.addEventListener('abort', sawAbort, { once: true }); entered();
    }) }]
  });
  t.after(() => release?.());
  await f.start(); await ready;
  await f.service.start({ conversationId: 'crash', mode: 'assist', text: 'crash' });
  await aborted;
  await waitFor(() => f.service.state('test').status === 'failed');
  await assert.rejects(f.service.start({ conversationId: 'next', mode: 'assist', text: 'next' }), { code: 'AGENT_HOST_CLEANUP_PENDING' });
  release(); await new Promise(resolve => setImmediate(resolve));
  await f.service.start({ conversationId: 'next', mode: 'assist', text: 'next' });
  await waitFor(() => f.service.state('next').status === 'completed');
  assert.equal(f.messages[0].text, 'safe restart');
});

test('shutdown cleans every goal session even when SDK cancellation throws', { timeout: 10000 }, async t => {
  let root, entered;
  const running = new Set();
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, "throw new Error('unexpected assist');", {
    readConfiguration: async () => ({ closeLog: path.join(root, 'closed.log') }),
    additionalTools: id => [{ name: 'ready', execute: async () => { running.add(id); if (running.size === 2) entered(); return {}; } }]
  });
  root = f.root;
  await fs.appendFile(path.join(root, 'index.mjs'), `
    import { appendFile } from 'node:fs/promises';
    export async function createHarness(options) {
      const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
      return { snapshot: () => board, memory: () => ({}), middlewareStatus: () => ({}),
        close: () => appendFile(options.closeLog, options.sessionId + '\\n'),
        cancel() { throw new Error('SDK cancellation failed'); }, addFact: async () => {},
        run: async ({ signal }) => {
          await options.tools[0].execute('ready', {}, signal); signal.throwIfAborted();
          return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } };
    }`);
  for (const conversationId of ['first', 'second']) await f.service.start({ conversationId, mode: 'goal', goal: { objective: 'verify shutdown' } });
  await ready;
  await assert.rejects(f.close(), /could not close cleanly/);
  const cleaned = (await fs.readFile(path.join(root, 'closed.log'), 'utf8')).trim().split('\n');
  assert.equal(new Set(cleaned).size, 2);
});

test('runtime failure settles cached worker and tool progress while preserving output', { timeout: 10000 }, async t => {
  let release;
  const f = await fixture(t, `
    options.onEvent({ type: 'message_start', message: { role: 'assistant' } });
    options.onEvent({ type: 'message_update', message: { role: 'assistant', content: 'partial answer' } });
    options.onEvent({ type: 'tool_execution_start', toolName: 'root_tool', toolCallId: 'root-call', args: {} });
    options.onEvent({ type: 'swarm.status', workers: [
      { id: 'active', task: 'working', status: 'running' },
      { id: 'finished', task: 'done', status: 'completed', result: 'saved evidence' }
    ] });
    options.onEvent({ type: 'swarm.worker.event', workerId: 'active', event: { type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'worker-call', args: {} } });
    const tools = await options.configuration.tools({});
    await tools[0].execute('gate', {}, options.signal);
    process.exit(7);`, {
    additionalTools: () => [{ name: 'gate', execute: () => new Promise(resolve => { release = resolve; }) }]
  });
  await f.start();
  await waitFor(() => Boolean(release) && f.service.state('test').workers.some(worker => worker.id === 'active' && worker.parts?.length));
  const before = f.service.state('test');
  release(); await f.done;
  const after = f.service.state('test');
  assert.equal(after.status, 'failed');
  assert.equal(after.workers.find(worker => worker.id === 'active').status, 'interrupted');
  assert.equal(after.workers.find(worker => worker.id === 'active').parts[0].status, 'interrupted');
  assert.equal(after.workers.find(worker => worker.id === 'finished').status, 'completed');
  assert.equal(after.parts.find(part => part.type === 'tool').status, 'interrupted');
  assert(after.parts.some(part => part.type === 'text' && part.text === 'partial answer'));
  assert(after.activities.every(item => !['queued', 'running', 'waiting'].includes(item.status)));
  assert.equal(f.service.runtimeSummary('test').activeWorkers, 0);
  assert.equal(before.workers[0].status, 'running', 'previous immutable snapshot was not changed');
});

async function crashedGoal(t, overrides = {}) {
  const f = await fixture(t, "throw new Error('unexpected collaboration');", overrides);
  const marker = path.join(f.root, 'first-import');
  await fs.appendFile(path.join(f.root, 'index.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    export async function createHarness(options) {
      if (!existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, 'crashed'); process.exit(7);
      }
      const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
      return { status: 'idle', snapshot: () => board, memory: () => ({}), middlewareStatus: () => ({}), close: async () => {},
        addFact: async () => {}, run: async () => ({ complete: true, revision: 0, summary: 'recovered goal' }),
        resume: async () => ({ complete: true, revision: 0, summary: 'recovered goal' }) };
    }`);
  const input = { conversationId: 'goal', mode: 'goal', goal: { objective: 'recover accepted request' } };
  await f.service.start(input);
  await waitFor(() => f.service.state('goal').status === 'failed');
  return { ...f, input };
}

test('explicit resume rebuilds a crashed runtime and restores the goal before execution', { timeout: 10000 }, async t => {
  let configurations = 0;
  const f = await crashedGoal(t, { readConfiguration: async () => { configurations++; return {}; } });
  assert.equal(f.service.state('goal').canResume, true);
  assert.equal(configurations, 1, 'failure never automatically reruns the model');
  await f.service.resume('goal');
  await waitFor(() => f.service.state('goal').status === 'completed');
  assert.equal(configurations, 2);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].text, 'recovered goal');
});

test('a rejected start still publishes the checkpoint state recovered by the backend', { timeout: 10000 }, async t => {
  const f = await crashedGoal(t);
  await assert.rejects(f.service.start(f.input), { code: 'RESUME_REQUIRED' });
  assert.equal(f.service.state('goal').status, 'interrupted');
  assert.equal(f.service.state('goal').canResume, true);
  assert.equal(f.service.isBusy('goal'), false);
  assert.equal(f.messages.length, 0);
  await f.service.resume('goal');
  await waitFor(() => f.service.state('goal').status === 'completed');
  assert.equal(f.messages.length, 1);
});

test('stopping during post-crash checkpoint recovery prevents model execution', { timeout: 10000 }, async t => {
  let hold = false, entered, release, configurations = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await crashedGoal(t, {
    workspaceRoots: () => hold ? new Promise(resolve => { release = () => resolve([]); entered(); }) : [],
    readConfiguration: async () => { configurations++; return {}; }
  });
  hold = true;
  const cancelled = assert.rejects(f.service.resume('goal'), { code: 'ABORT_ERR' });
  await waiting; f.service.cancel('goal'); hold = false; release(); await cancelled;
  assert.equal(configurations, 1);
  assert.equal(f.service.isBusy('goal'), false);
  assert.equal(f.service.state('goal').canResume, true);
  await f.service.resume('goal'); await waitFor(() => f.service.state('goal').status === 'completed');
  assert.equal(configurations, 2);
});

test('post-crash resume rechecks workspace ownership before executing a checkpoint', { timeout: 10000 }, async t => {
  let roots = [], configurations = 0;
  const f = await crashedGoal(t, {
    workspaceRoots: () => roots,
    readConfiguration: async () => { configurations++; return {}; }
  });
  roots = [path.join(f.root, 'different-workspace')];
  await assert.rejects(f.service.resume('goal'), { code: 'RESUME_UNAVAILABLE' });
  assert.equal(configurations, 1);
  assert.equal(f.service.state('goal').canResume, false);
  roots = [];
  await f.service.resume('goal');
  await waitFor(() => f.service.state('goal').status === 'completed');
  assert.equal(configurations, 2);
  assert.equal(f.messages.length, 1);
});
