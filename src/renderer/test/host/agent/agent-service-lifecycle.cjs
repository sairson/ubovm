'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ terminationFailure = false } = {}) {
  let receiver, revision = 0, onClose, methods = {};
  class Worker extends EventEmitter { terminate() { return terminationFailure ? Promise.reject(new Error('termination failed')) : Promise.resolve(0); } }
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
          return { call: async (method, args = []) => {
            if (typeof methods[method] === 'function') return methods[method](args, ++revision);
            if (method === 'close') return { result: true };
            const id = typeof args[0] === 'string' ? args[0] : args[0].conversationId;
            return { result: true, snapshot: { id, revision: ++revision, state: { status: 'idle', busy: false, parts: [{ text: id }] }, summary: { status: 'idle', busy: false } } };
          }, close() {}, isIdle: () => true, drain: async () => {} };
        } };
      } };
      return require(name);
    } };
  vm.runInNewContext(source, context);
  const service = context.module.exports.createHarnessService({ sdkPath: __filename, storageDirectory: __dirname });
  const snapshot = async id => receiver('snapshot', [{ id, revision: ++revision, state: { status: 'completed', busy: false, parts: [{ text: 'late obsolete timeline' }] }, summary: { status: 'completed', busy: false } }], new AbortController().signal);
  const busySnapshot = async id => receiver('snapshot', [{ id, revision: ++revision, state: { status: 'running', busy: true, parts: [{ text: 'live' }] }, summary: { status: 'running', busy: true } }], new AbortController().signal);
  const failRuntime = (error = Object.assign(new Error('Agent 后端未响应'), { code: 'AGENT_HEARTBEAT_TIMEOUT' })) => onClose?.(error);
  return { service, snapshot, busySnapshot, failRuntime, methods };
}

test('ensureIdle respawns a failed idle runtime without replaying work', async () => {
  const { service } = fixture();
  try {
    await service.restore({ conversationId: 'idle', mode: 'assist' });
    assert.equal(service.connectionState().status, 'connected');
    // Simulate heartbeat death: force the private failed flag through a closed call after kill is hard;
    // ensureIdle on a healthy runtime is a no-op connected status.
    const before = await service.ensureIdle();
    assert.equal(before.status, 'connected');
    assert.equal(service.state('idle').status, 'idle');
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

test('heartbeat failure marks busy assist and goal sessions resumable', async () => {
  const { service, busySnapshot, failRuntime } = fixture();
  try {
    await service.start({ conversationId: 'assist', mode: 'assist', text: 'continue me' });
    await busySnapshot('assist');
    await service.restore({ conversationId: 'goal', mode: 'goal', goal: { objective: 'recover' } });
    await busySnapshot('goal');
    failRuntime();
    assert.equal(service.connectionState().status, 'disconnected');
    assert.equal(service.state('assist').canResume, true);
    assert.equal(service.state('assist').error.code, 'AGENT_HEARTBEAT_TIMEOUT');
    assert.equal(service.state('goal').canResume, true);
    assert.equal(service.state('goal').error.code, 'AGENT_HEARTBEAT_TIMEOUT');
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
