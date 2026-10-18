import assert from 'node:assert/strict';
import test from 'node:test';

import { applyExecutionModes } from '../tool-modes.mjs';
import {
  applyToolRuntime,
  createParallelGate,
  timeoutMsFor,
  withParallelGate,
  withToolTimeout,
} from '../tool-runtime.mjs';

const ok = text => ({ content: [{ type: 'text', text }], details: { text } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('parallel gate caps concurrent holders and drains in order', async () => {
  const gate = createParallelGate(2);
  let active = 0, peak = 0;
  const seen = [];
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => (async () => {
    const release = await gate.acquire();
    active++;
    peak = Math.max(peak, active);
    seen.push(index);
    await delay(10);
    active--;
    release();
    return index;
  })()));
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test('an aborted waiter never consumes a slot', async () => {
  const gate = createParallelGate(1);
  const release = await gate.acquire();
  const controller = new AbortController();
  const queued = gate.acquire(controller.signal);
  controller.abort(new Error('stop waiting'));
  await assert.rejects(queued, /stop waiting/);
  assert.equal(gate.queued, 0);
  assert.equal(gate.active, 1);
  release();
  assert.equal(gate.active, 0);
});

test('gate rejects an already-aborted acquisition', async () => {
  const gate = createParallelGate(1);
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  await assert.rejects(gate.acquire(controller.signal), /already stopped/);
});

test('tool timeout rejects with a structured error and leaves other calls alone', async () => {
  const wrapped = withToolTimeout({
    name: 'read_workspace_file',
    execute: () => new Promise(() => {}),
  }, 20);
  await assert.rejects(wrapped.execute('call-1', {}), error => {
    assert.equal(error.code, 'TOOL_TIMEOUT');
    assert.equal(error.details.tool, 'read_workspace_file');
    assert.equal(error.details.timeoutMs, 20);
    assert.match(error.message, /\[TOOL_TIMEOUT\]/);
    return true;
  });

  const fast = withToolTimeout({ name: 'fast', execute: async () => ok('done') }, 100);
  assert.deepEqual(await fast.execute('call-2', {}), ok('done'));
});

test('a parent abort wins over the timeout and does not leave the timer behind', async () => {
  const controller = new AbortController();
  const wrapped = withToolTimeout({
    name: 'read_workspace_file',
    execute: (_id, _args, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }, 1000);
  setTimeout(() => controller.abort(new Error('user stopped')), 5);
  await assert.rejects(wrapped.execute('call-3', {}, controller.signal), /user stopped/);
});

test('parallel gate wrapper releases the slot when the tool throws', async () => {
  const gate = createParallelGate(1);
  const wrapped = withParallelGate({
    name: 'read_workspace_file',
    execute: async () => { throw new Error('boom'); },
  }, gate);
  await assert.rejects(wrapped.execute('call-4', {}), /boom/);
  assert.equal(gate.active, 0);
  const release = await gate.acquire();
  release();
});

test('timeout policy distinguishes process tools from read tools', () => {
  assert.equal(timeoutMsFor('read_workspace_file'), 30_000);
  assert.equal(timeoutMsFor('search_workspace'), 60_000);
  assert.equal(timeoutMsFor('mcp_github_create_issue'), 60_000);
  assert.equal(timeoutMsFor('run_local_shell_command'), undefined);
  assert.equal(timeoutMsFor('run_python'), undefined);
  assert.equal(timeoutMsFor('ask_human'), undefined);
  assert.equal(timeoutMsFor('todo'), undefined);
  assert.equal(timeoutMsFor('browser_action'), undefined);
  assert.equal(timeoutMsFor('load_skill'), undefined);
  assert.equal(timeoutMsFor('unknown_tool'), undefined);
});

test('applyToolRuntime adds the gate only to parallel tools and preserves timeouts', async () => {
  const gate = createParallelGate(2);
  let active = 0, peak = 0;
  const read = {
    name: 'read_workspace_file',
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(10);
      active--;
      return ok('read');
    },
  };
  const shell = {
    name: 'run_local_shell_command',
    execute: async () => ok('shell'),
  };
  const tools = applyToolRuntime(applyExecutionModes([read, shell]), {
    gate,
    timeouts: { read_workspace_file: 100, run_local_shell_command: 1 },
  });
  assert.equal(tools[0].executionMode, 'parallel');
  assert.equal(tools[1].executionMode, 'sequential');
  await Promise.all([
    tools[0].execute('a', {}),
    tools[0].execute('b', {}),
    tools[0].execute('c', {}),
  ]);
  assert.equal(peak, 2);
  // The process tool is excluded from the wrapper even when a caller supplies a
  // short timeout for it.
  await delay(5);
  assert.deepEqual(await tools[1].execute('d', {}), ok('shell'));
});

test('applyToolRuntime rejects malformed tool arrays', () => {
  assert.throws(() => applyToolRuntime('nope'), /array/);
  assert.throws(() => applyToolRuntime([{ name: '' }]), /nonempty name/);
  assert.throws(() => createParallelGate(0), /positive integer/);
});
