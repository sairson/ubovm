'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ terminationFailure = false, bootFailure = false } = {}) {
  let receiver, revision = 0, onClose, methods = {}, spawns = 0;
  class Worker extends EventEmitter {
    constructor() { super(); spawns++; if (bootFailure) throw Error('fixture boot failure'); }
    terminate() { return terminationFailure ? Promise.reject(new Error('termination failed')) : Promise.resolve(0); }
  }
  const source = readFileSync(path.join(__dirname, '../../../host/agent/agent-service.cjs'), 'utf8');
  const context = { module: { exports: {} }, structuredClone, AbortController, Promise, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:worker_threads') return { Worker };
      if (name === './agent-backend.cjs') return { backendModule(module) {
        if (module === 'errors.cjs') return { serializeError: error => ({ message: error.message, code: error.code }) };
        if (module === 'projection.cjs') return { interruptExecution: (state, error) => ({ ...state, status: 'failed', busy: false, error }) };
        return { createRPC(_worker, handle, options = {}) {
          receiver = handle;
          onClose = options.onClose;
          const api = {
            call: async (method, args = []) => {
              if (typeof methods[method] === 'function') return methods[method](args, ++revision);
              if (method === 'close') return { result: true };
              const id = typeof args[0] === 'string' ? args[0] : args[0].conversationId;
              return { result: true, snapshot: { id, revision: ++revision, state: { status: 'idle', busy: false, parts: [{ text: id }] }, summary: { status: 'idle', busy: false } } };
            },
            close() {}, isIdle: () => true, drain: async () => {}, isStalled: () => false,
            stall(stalled = true) {
              options.onStallChange?.(stalled, stalled ? Object.assign(new Error('slow'), { code: 'AGENT_HEARTBEAT_STALLED' }) : undefined);
            }
          };
          methods.__rpc = api;
          return api;
        } };
      } };
      return require(name);
    } };
  vm.runInNewContext(source, context);
  const service = context.module.exports.createHarnessService({ sdkPath: __filename, storageDirectory: __dirname });
  const snapshot = async id => receiver('snapshot', [{ id, revision: ++revision, state: { status: 'completed', busy: false, parts: [{ text: 'late obsolete timeline' }] }, summary: { status: 'completed', busy: false } }], new AbortController().signal);
  const busySnapshot = async id => receiver('snapshot', [{ id, revision: ++revision, state: { status: 'running', busy: true, parts: [{ text: 'live' }] }, summary: { status: 'running', busy: true } }], new AbortController().signal);
  const failRuntime = (error = Object.assign(new Error('Agent thread exited'), { code: 'AGENT_THREAD_EXIT' })) => onClose?.(error);
  return { service, snapshot, busySnapshot, failRuntime, methods, spawns: () => spawns };
}

test('recovery boot failures back off instead of spawning on every probe', async () => {
  const { service, spawns } = fixture({ bootFailure: true });
  try {
    const first = await service.ensureIdle();
    assert.equal(first.status, 'disconnected');
    assert.equal(spawns(), 1);
    for (let index = 0; index < 8; index++) {
      const result = await service.ensureIdle();
      assert.equal(result.status, 'disconnected');
      assert.ok(result.retryAt > Date.now() || result.retryAt === undefined, 'a retry deadline is surfaced');
    }
    assert.equal(spawns(), 1, 'consecutive probes stay inside the backoff window');
    assert.equal(service.connectionState().recovering, true);
  } finally { await service.close(); }
});

test('ensureIdle respawns a failed idle runtime without replaying work', async () => {
  const { service, failRuntime, spawns } = fixture();
  try {
    await service.restore({ conversationId: 'idle', mode: 'assist' });
    assert.equal(service.connectionState().status, 'connected');
    assert.equal((await service.ensureIdle()).status, 'connected');
    assert.equal(spawns(), 1);
    failRuntime();
    assert.equal(service.connectionState().status, 'disconnected');
    const recovered = await service.ensureIdle();
    assert.equal(recovered.status, 'connected');
    assert.equal(spawns(), 2, 'a dead idle runtime is respawned by the next recovery probe');
    assert.equal(service.state('idle').status, 'idle', 'recovery does not replay the task');
  } finally { await service.close(); }
});

test('late snapshots cannot resurrect removed session state', async () => {
  const { service, snapshot } = fixture();
  try {
    await service.restore({ conversationId: 'deleted', mode: 'assist' });
    await service.remove('deleted');
    await snapshot('deleted');
    assert.equal(service.state('deleted').status, 'idle');
    assert.equal(service.state('deleted').parts.length, 0);
    await service.restore({ conversationId: 'deleted', mode: 'assist' });
    await snapshot('deleted');
    assert.equal(service.state('deleted').status, 'completed', 'explicit restore admits new snapshots');
  } finally { await service.close(); }
});

test('repeated remove and workspace release fence old timelines without preventing restoration', async () => {
  const { service, snapshot } = fixture();
  try {
    for (let index = 0; index < 500; index++) {
      const id = `session-${index}`;
      await service.restore({ conversationId: id, mode: 'assist' });
      await service.releaseWorkspace(id);
      await snapshot(id);
      assert.equal(service.state(id).status, 'idle');
      await service.remove(id);
      await snapshot(id);
      assert.equal(service.state(id).parts.length, 0);
    }
    await service.restore({ conversationId: 'session-0', mode: 'assist' });
    await snapshot('session-0');
    assert.equal(service.state('session-0').status, 'completed');
  } finally { await service.close(); }
});

for (const terminationFailure of [false, true]) test(`shutdown releases cached timelines even when termination fails=${terminationFailure}`, async () => {
  const { service, snapshot } = fixture({ terminationFailure });
  for (let index = 0; index < 100; index++) {
    await service.restore({ conversationId: `closed-${index}`, mode: 'assist' });
    await snapshot(`closed-${index}`);
  }
  const closing = service.close();
  assert.equal(service.close(), closing);
  if (terminationFailure) await assert.rejects(closing, /termination failed/); else await closing;
  for (let index = 0; index < 100; index++) {
    assert.equal(service.state(`closed-${index}`).parts.length, 0);
    assert.equal(service.runtimeSummary(`closed-${index}`).status, 'idle');
  }
  await assert.rejects(service.restore({ conversationId: 'after-close', mode: 'assist' }), /closed/);
});

test('heartbeat stall keeps sessions running until the thread really exits', async () => {
  const { service, busySnapshot, failRuntime, methods } = fixture();
  try {
    await service.start({ conversationId: 'assist', mode: 'assist', text: 'continue me' });
    await busySnapshot('assist');
    await service.restore({ conversationId: 'goal', mode: 'goal', goal: { objective: 'recover' } });
    await busySnapshot('goal');
    methods.__rpc.stall(true);
    assert.equal(service.connectionState().status, 'stalled');
    assert.equal(service.state('assist').busy, true, 'soft stall must not interrupt work');
    assert.equal(service.state('goal').busy, true);
    assert.equal(await service.authoritative('assist'), null, 'a stalled worker keeps its own projection');
    methods.__rpc.stall(false);
    assert.equal(service.connectionState().status, 'connected');
    failRuntime();
    assert.equal(service.connectionState().status, 'disconnected');
    assert.equal(service.state('assist').canResume, true);
    assert.equal(service.state('assist').error.code, 'AGENT_THREAD_EXIT');
    assert.equal(service.state('goal').canResume, true);
    assert.equal(service.state('goal').error.code, 'AGENT_THREAD_EXIT');
  } finally { await service.close().catch(() => {}); }
});

test('manual restart ends the live runtime and keeps the checkpoint resumable', async () => {
  const { service, busySnapshot, spawns } = fixture();
  try {
    await service.start({ conversationId: 'restart-me', mode: 'assist', text: 'long task' });
    await busySnapshot('restart-me');
    assert.equal(service.connectionState().status, 'connected');
    assert.equal(spawns(), 1);
    const result = await service.restart();
    assert.equal(result.status, 'connected');
    assert.equal(spawns(), 2, 'the old worker is terminated and a fresh one starts');
    const state = service.state('restart-me');
    assert.equal(state.busy, false);
    assert.equal(state.canResume, true, 'the checkpoint stays explicitly resumable');
    assert.equal(state.error.code, 'AGENT_MANUAL_RESTART');
    assert.equal(service.connectionState().status, 'connected');
  } finally { await service.close().catch(() => {}); }
});

test('reconnection reads the backend projection instead of replaying a task', async () => {
  const { service, methods } = fixture();
  try {
    await service.restore({ conversationId: 'resume-me', mode: 'assist' });
    const calls = [];
    methods.authoritative = (args, revision) => {
      calls.push(args[0]);
      return { result: { loaded: true }, snapshot: { id: 'resume-me', revision, state: { status: 'interrupted', busy: false, canResume: true, parts: [{ text: 'checkpoint state' }] }, summary: { status: 'interrupted', busy: false } } };
    };
    const state = await service.authoritative('resume-me');
    assert.deepEqual(calls, ['resume-me']);
    assert.equal(state.status, 'interrupted');
    assert.equal(state.canResume, true);
    assert.equal(state.parts[0].text, 'checkpoint state');
    assert.equal(service.state('resume-me').parts[0].text, 'checkpoint state', 'the host adopts the backend projection');
    methods.authoritative = () => ({ result: { loaded: false }, snapshot: { id: 'resume-me', revision: 1, state: { status: 'idle' }, summary: { status: 'idle' } } });
    assert.equal(await service.authoritative('resume-me'), null, 'an unloaded session is restored from disk by the host');
  } finally { await service.close().catch(() => {}); }
});

test('assist resume after runtime failure restores then resumes without replaying automatically', async () => {
  const { service, busySnapshot, failRuntime, methods } = fixture();
  const calls = [];
  try {
    await service.start({ conversationId: 'assist', mode: 'assist', text: 'retry this turn' });
    await busySnapshot('assist');
    failRuntime();
    methods.restore = (args, revision) => {
      calls.push(['restore', args[0]?.lastInput?.text]);
      return { result: true, snapshot: { id: 'assist', revision, state: { status: 'interrupted', busy: false, canResume: true, parts: [] }, summary: { status: 'interrupted', busy: false } } };
    };
    methods.resume = (args, revision) => {
      calls.push(['resume', args[0]]);
      return { result: true, snapshot: { id: 'assist', revision, state: { status: 'running', busy: true, canResume: false, parts: [] }, summary: { status: 'running', busy: true } } };
    };
    await service.resume('assist');
    assert.deepEqual(calls, [['restore', 'retry this turn'], ['resume', 'assist']]);
    assert.equal(service.connectionState().status, 'connected');
    assert.equal(service.state('assist').busy, true);
  } finally { await service.close().catch(() => {}); }
});
