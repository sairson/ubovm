import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ShellQueue } from '../shell-queue.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('FIFO queue bounds admission and immediately reclaims cancelled waiters and listeners', async () => {
  const queue = new ShellQueue(2), order = [];
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  await tick();
  for (let i = 0; i < 200; i++) {
    const controller = new AbortController();
    const waiting = queue.run(() => assert.fail('cancelled call ran'), { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(new Error('cancel queued'));
    await assert.rejects(waiting, /cancel queued/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const second = queue.run(() => order.push(2));
  const third = queue.run(() => order.push(3));
  await assert.rejects(queue.run(() => order.push(4)), { code: 'SHELL_QUEUE_FULL' });
  release(); await Promise.all([first, second, third]); await queue.close();
  assert.deepEqual(order, [2, 3]);
});

test('a queued timeout never executes later and does not interrupt the active job', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new ShellQueue();
  let release, queued = false;
  const first = queue.run(() => new Promise(resolve => { release = resolve; })); await tick();
  const waiting = queue.run(() => assert.fail('timed out call ran'), { waitSeconds: 1, onQueued: () => { queued = true; } });
  const rejected = assert.rejects(waiting, { code: 'SHELL_QUEUE_TIMEOUT' });
  t.mock.timers.tick(1000); await rejected; assert.equal(queued, true);
  release('active survived'); assert.equal(await first, 'active survived'); await queue.close();
});

test('park frees the active slot so a resident command does not block the next caller', async () => {
  const queue = new ShellQueue(), order = [];
  let park, release;
  const first = queue.run((_wait, control) => {
    park = control.park;
    return new Promise(resolve => { release = resolve; });
  });
  await tick();
  assert.equal(park(), true);
  assert.equal(park(), false);
  const second = queue.run(() => { order.push('second'); return 'ok'; });
  assert.equal(await second, 'ok');
  assert.deepEqual(order, ['second']);
  release('first');
  assert.equal(await first, 'first');
  await queue.close();
});

test('close rejects waiters immediately and waits for active cleanup; observer cancellation is reentrant', async () => {
  const queue = new ShellQueue(); let release, drained = false;
  const first = queue.run(() => new Promise(resolve => { release = resolve; })); await tick();
  const controller = new AbortController();
  await assert.rejects(queue.run(() => assert.fail('observer-cancelled call ran'), {
    signal: controller.signal, onQueued: () => controller.abort(new Error('cancel inside observer'))
  }), /cancel inside observer/);
  const waiting = assert.rejects(queue.run(() => assert.fail('closed call ran')), /closed/);
  const closing = queue.close().then(() => { drained = true; });
  await waiting; assert.equal(drained, false);
  release(); await first; await closing;
  await assert.rejects(queue.run(() => {}), /closed/);
});
