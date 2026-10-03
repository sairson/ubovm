import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { terminateProcessTree } from '../process-tree.mjs';
import { runLocalProcess } from '../local-process.mjs';

const options = { executable: process.execPath, args: [], cwd: process.cwd(), env: process.env,
  timeout: 30, maxOutputBytes: 1024, label: 'Stability fixture' };
function fakeProcess() {
  const child = new EventEmitter();
  // No real PID: deterministic event injection cannot terminate an OS process.
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    kill() { throw new Error('kill denied'); }, unref() { child.unreferenced = true; } });
  return child;
}

test('completed local commands release owned listeners and preserve external output subscriptions', async () => {
  for (let i = 0; i < 50; i++) {
    const child = fakeProcess(), external = () => {};
    child.stdout.on('data', external);
    const pending = runLocalProcess(options, undefined, undefined, { spawnProcess: () => child });
    child.emit('close', 0); await pending;
    assert.deepEqual(child.stdout.listeners('data'), [external]);
    assert.equal(child.stderr.listenerCount('data'), 0);
    for (const target of [child, child.stdout, child.stderr]) {
      assert.equal(target.listenerCount('error'), 1);
      assert.equal(target.listenerCount('end'), 0);
      assert.doesNotThrow(() => target.emit('error', Error('late failure')));
    }
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('close'), 0);
    child.stdout.destroy(); child.stderr.destroy();
  }
});

test('hostile local process errors cannot escape reporting or strand cleanup completion', async () => {
  const child = fakeProcess();
  const pending = runLocalProcess(options, undefined, undefined, { spawnProcess: () => child, closeGraceMs: 10 });
  const observed = assert.rejects(pending, /Operation failed/);
  const error = new Proxy({}, { get() { throw Error('unreadable local error'); } });
  assert.doesNotThrow(() => child.emit('error', error));
  await observed;
  child.stdout.destroy(); child.stderr.destroy();
});

test('hostile local output errors settle after bounded process cleanup', async () => {
  const child = fakeProcess();
  const pending = runLocalProcess(options, undefined, undefined, { spawnProcess: () => child, closeGraceMs: 10 });
  const observed = assert.rejects(pending, error => /Operation failed/.test(error.message) && error.details.process_closed === false);
  child.stdout.emit('error', new Proxy({}, { get() { throw Error('unreadable output error'); } }));
  await observed;
  assert.equal(child.unreferenced, true);
  assert(child.stdout.destroyed); assert(child.stderr.destroyed);
});

test('lifecycle subscription failure terminates the already spawned local process', async () => {
  const child = fakeProcess();
  const pending = runLocalProcess({ ...options, lifecycle: { subscribe() { throw Error('subscription failed'); } } },
    undefined, undefined, { spawnProcess: () => child, closeGraceMs: 10 });
  await assert.rejects(pending, /subscription failed/);
  assert.equal(child.unreferenced, true);
  assert(child.stdout.destroyed); assert(child.stderr.destroyed);
});

test('lifecycle unsubscribe failure settles local execution and releases its abort listener', async () => {
  const child = fakeProcess(), controller = new AbortController();
  const pending = runLocalProcess({ ...options, lifecycle: { subscribe() { return () => { throw Error('unsubscribe failed'); }; } } },
    controller.signal, undefined, { spawnProcess: () => child, closeGraceMs: 10 });
  const observed = assert.rejects(pending, /unsubscribe failed/);
  assert.doesNotThrow(() => child.emit('close', 0));
  await observed;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.stdout.destroy(); child.stderr.destroy();
});

test('a failing stopping observer cannot prevent output-limit termination', async () => {
  const child = fakeProcess();
  const pending = runLocalProcess({ ...options, lifecycle: { subscribe() { return () => {}; }, stopping() { throw Error('observer failure'); } } },
    undefined, undefined, { spawnProcess: () => child, closeGraceMs: 10 });
  const observed = assert.rejects(pending, /output exceeds/);
  assert.doesNotThrow(() => child.stdout.emit('data', Buffer.alloc(2048)));
  await observed;
  assert.equal(child.unreferenced, true);
  assert(child.stdout.destroyed); assert(child.stderr.destroyed);
});

test('local process batches tiny packets and delivers the final batch before settling', async () => {
  const child = fakeProcess(), updates = [];
  const pending = runLocalProcess({ ...options, maxOutputBytes: 20000 }, undefined,
    item => updates.push(item.content[0].text), { spawnProcess: () => child });
  for (let i = 0; i < 10000; i++) child.stdout.write('x');
  assert.equal(updates.length, 0);
  child.emit('close', 0);
  assert.equal((await pending).content[0].text, 'x'.repeat(10000));
  assert.deepEqual(updates, ['x'.repeat(10000)]);
  child.stdout.write('late'); child.stdout.destroy(); child.stderr.destroy();
  assert.equal(updates.length, 1);
});

test('local malformed UTF-8 cannot expand retained output beyond its byte limit', async () => {
  const child = fakeProcess(), updates = [];
  const pending = runLocalProcess({ ...options, maxOutputBytes: 10 }, undefined,
    item => updates.push(item.content[0].text), { spawnProcess: () => child, closeGraceMs: 20 });
  child.stdout.write(Buffer.alloc(10, 255)); child.emit('close', 0);
  await assert.rejects(pending, /output exceeds 10 bytes/);
  assert(Buffer.byteLength(updates.join('')) <= 10);
  child.stdout.destroy(); child.stderr.destroy();
});

test('termination helper handles synchronous and asynchronous OS failures without throwing', () => {
  let fallbackCalls = 0;
  const child = { pid: 123, kill() { fallbackCalls++; throw new Error('access denied'); } };
  assert.doesNotThrow(() => terminateProcessTree(child, () => false, { platform: 'win32', spawnProcess() { throw new Error('spawn denied'); } }));
  const helper = new EventEmitter(); helper.unref = () => {};
  terminateProcessTree(child, () => false, { platform: 'win32', spawnProcess: () => helper });
  assert.doesNotThrow(() => helper.emit('error', new Error('taskkill failed')));
  assert.doesNotThrow(() => helper.emit('close', 1));
  assert.doesNotThrow(() => terminateProcessTree(child, () => false, { platform: 'linux', killGroup() { throw new Error('group gone'); } }));
  assert.equal(fallbackCalls, 4);
});

test('late Windows termination callbacks do not target an exited process', () => {
  let exited = false, killed = 0, spawns = 0;
  const child = { pid: 123, kill() { killed++; } }, helper = new EventEmitter(); helper.unref = () => {};
  const dependencies = { platform: 'win32', spawnProcess() { spawns++; return helper; } };
  terminateProcessTree(child, () => exited, dependencies); exited = true;
  helper.emit('error', new Error('late failure')); helper.emit('close', 1);
  terminateProcessTree(child, () => exited, dependencies);
  assert.equal(killed, 0); assert.equal(spawns, 1);
});

test('stream errors settle even when kill throws and process never closes', async () => {
  const child = fakeProcess();
  const pending = runLocalProcess(options, undefined, undefined, { spawnProcess: () => child, closeGraceMs: 20 });
  child.stdout.emit('error', new Error('broken pipe'));
  await assert.rejects(pending, error => /broken pipe/.test(error.message) && error.details.process_closed === false);
  assert.equal(child.unreferenced, true); assert(child.stdout.destroyed); assert(child.stderr.destroyed);
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('late pipe failure')));
});

test('exit with inherited open output pipes has a separate bounded deadline', async () => {
  const child = fakeProcess(); child.exitCode = 0;
  const pending = runLocalProcess(options, undefined, undefined, { spawnProcess: () => child, closeGraceMs: 20 });
  child.emit('exit', 0);
  await assert.rejects(pending, error => error.code === 'PROCESS_PIPE_TIMEOUT' && error.details.process_closed === false && error.details.exit_code === 0);
});

test('close cancels the pipe watchdog and late cancellation cannot change success', async () => {
  const child = fakeProcess(), controller = new AbortController();
  const pending = runLocalProcess(options, controller.signal, undefined, { spawnProcess: () => child, closeGraceMs: 20 });
  child.stdout.write('done'); child.emit('exit', 0); child.emit('close', 0);
  controller.abort(new Error('late cancellation'));
  const result = await pending; assert.equal(result.content[0].text, 'done'); assert.equal(result.details.process_closed, true);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(child.unreferenced, undefined);
  child.stdout.destroy(); child.stderr.destroy();
});

test('frozen cancellation reasons survive racing error, exit and close unchanged', async () => {
  const child = fakeProcess(), controller = new AbortController(), reason = Object.freeze(new Error('cancelled by owner'));
  const pending = runLocalProcess(options, controller.signal, undefined, { spawnProcess: () => child, closeGraceMs: 20 });
  controller.abort(reason); child.stderr.emit('error', new Error('pipe error')); child.emit('exit', 1); child.emit('close', 1);
  await assert.rejects(pending, error => error.message === reason.message && error !== reason && error.details.process_closed === true);
  assert.equal(reason.details, undefined); child.stdout.destroy(); child.stderr.destroy();
});

test('repeated cancellation and close races release abort listeners', async () => {
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const child = fakeProcess(), controller = new AbortController();
    const pending = runLocalProcess(options, controller.signal, undefined, { spawnProcess: () => child, closeGraceMs: 20 });
    const observed = pending.then(result => result, error => error);
    if (index % 2 === 0) controller.abort(new Error('stress cancellation'));
    child.emit('exit', index % 2); child.emit('close', index % 2);
    controller.abort(new Error('late abort'));
    await observed;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    child.stdout.destroy(); child.stderr.destroy();
  }));
});
