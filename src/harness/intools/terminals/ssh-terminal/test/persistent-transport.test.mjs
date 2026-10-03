import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openPersistentTransport } from '../persistent-transport.mjs';

function channel() {
  const stream = new EventEmitter(); stream.stderr = new EventEmitter();
  stream.signal = () => {}; stream.close = () => { stream.closed = true; stream.emit('close'); };
  stream.write = () => {};
  return stream;
}

test('a valid split SSH handshake accepts coalesced output without losing or copying its tail', async () => {
  const client = new EventEmitter(), stream = new PassThrough();
  stream.stderr = new PassThrough(); stream.signal = () => {};
  stream.close = () => { stream.destroy(); stream.stderr.destroy(); };
  let startup;
  client.exec = (command, callback) => {
    if (command.startsWith('env ')) { startup = command; callback(null, stream); }
    else { const control = channel(); callback(null, control); queueMicrotask(() => control.emit('close', 0)); }
  };
  const pending = openPersistentTransport(client, new AbortController().signal);
  const token = startup.match(/UBOVM_SHELL_SESSION=([a-f0-9-]+)/)[1];
  const frame = Buffer.from(`\x1e${token}:45678\x1f`), tail = Buffer.alloc(65536, 'x');
  stream.write(frame.subarray(0, 10));
  stream.write(Buffer.concat([frame.subarray(10), tail]));
  const transport = await pending;
  const received = [];
  transport.stdout.on('data', data => received.push(data));
  transport.stdout.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Buffer.concat(received), tail);
  await transport.close();
});

test('oversized SSH startup data is rejected before allocating a second full buffer', async t => {
  const client = new EventEmitter(), stream = channel();
  client.exec = (_command, callback) => callback(null, stream);
  const pending = openPersistentTransport(client, new AbortController().signal);
  const original = Buffer.concat;
  let copiedBytes = 0;
  t.mock.method(Buffer, 'concat', (buffers, ...args) => {
    copiedBytes += buffers.reduce((total, buffer) => total + buffer.length, 0);
    return original(buffers, ...args);
  });
  stream.emit('data', Buffer.alloc(1024 * 1024, 'x'));
  await assert.rejects(pending, /Invalid SSH shell startup frame/);
  assert.equal(copiedBytes, 0, 'oversized packet was copied before admission validation');
  assert.equal(stream.closed, true);
  assert.equal(stream.listenerCount('data'), 0);
});
async function fixture(control) {
  const client = new EventEmitter(), shell = channel();
  let startup;
  client.exec = (command, callback) => {
    if (command.startsWith('env ')) { startup = command; callback(null, shell); }
    else control(command, callback);
  };
  const controller = new AbortController();
  const pending = openPersistentTransport(client, controller.signal);
  const token = startup.match(/UBOVM_SHELL_SESSION=([a-f0-9-]+)/)[1];
  for (const byte of Buffer.from(`\x1e${token}:45678\x1f`)) shell.emit('data', Buffer.from([byte]));
  return { client, shell, controller, token, transport: await pending };
}

test('SSH cancellation uses a fenced process-group kill even if channel signals are ignored', async () => {
  let command;
  const f = await fixture((value, callback) => {
    command = value;
    const stream = channel(); callback(null, stream);
    queueMicrotask(() => { stream.emit('exit', 0); stream.emit('close', 0); });
  });
  const result = await f.transport.close();
  assert.equal(result.remote_termination_confirmed, true);
  assert(command.includes(`UBOVM_SHELL_SESSION=${f.token}`));
  assert.match(command, /\/proc\/45678\/environ/);
  assert.match(command, /&& kill -KILL -- -45678 &&/);
  assert.match(command, /kill -0 -- -45678/);
  assert.equal(f.shell.closed, true);
  assert.equal(f.client.listenerCount('close'), 0);
  assert.deepEqual(await f.transport.close(), result);
});

test('throwing persistent transport observers cannot prevent fenced termination after disconnect', async () => {
  let kills = 0;
  const f = await fixture((_command, callback) => {
    kills++;
    const control = channel(); callback(null, control); queueMicrotask(() => control.emit('close', 0));
  });
  let notifications = 0;
  f.shell.on('error', () => {
    notifications++;
    f.client.emit('error', Error('reentrant transport failure'));
    throw Error('observer failed');
  });
  assert.doesNotThrow(() => f.client.emit('close'));
  const result = await f.transport.close();
  assert.equal(kills, 1);
  assert.equal(notifications, 1);
  assert.equal(result.remote_termination_confirmed, true);
  assert.equal(f.shell.closed, true);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('an unresponsive SSH control channel is bounded and its late result is closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submit;
  const f = await fixture((_command, callback) => { submit = callback; });
  const closing = f.transport.close();
  t.mock.timers.tick(1500);
  assert.equal((await closing).remote_termination_confirmed, false);
  assert.equal(f.shell.closed, true);
  const late = channel(); submit(null, late); assert.equal(late.closed, true);
});

test('failed SSH process identity verification never reports confirmed termination', async () => {
  const f = await fixture((_command, callback) => {
    const stream = channel(); callback(null, stream); queueMicrotask(() => stream.emit('close', 1));
  });
  assert.equal((await f.transport.close()).remote_termination_confirmed, false);
});

test('SSH control timeout removes task callbacks and safely absorbs late errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const control = channel();
  const f = await fixture((_command, callback) => callback(null, control));
  const closing = f.transport.close();
  t.mock.timers.tick(1500);
  assert.equal((await closing).remote_termination_confirmed, false);
  assert.equal(control.listenerCount('close'), 0);
  assert.equal(control.listenerCount('exit'), 0);
  assert.equal(control.listenerCount('data'), 0);
  assert.equal(control.stderr.listenerCount('data'), 0);
  assert.equal(control.listenerCount('error'), 1);
  assert.equal(control.stderr.listenerCount('error'), 1);
  assert.doesNotThrow(() => control.emit('error', Error('late error')));
  assert.doesNotThrow(() => control.stderr.emit('error', Error('late stderr error')));
});

test('SSH startup errors reject promptly rather than waiting for the command timeout', async () => {
  const client = new EventEmitter(), stream = channel();
  client.exec = (_command, callback) => { callback(null, stream); queueMicrotask(() => stream.emit('error', new Error('startup failed'))); };
  await assert.rejects(openPersistentTransport(client, new AbortController().signal), /startup failed/);
  assert.equal(stream.closed, true);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(stream.listenerCount('error'), 1, 'startup error callback must be released');
  assert.equal(stream.stderr.listenerCount('error'), 1, 'stderr task callback must be released');
});

test('closed SSH shell channels release startup callbacks over repeated connections', async () => {
  for (let i = 0; i < 50; i++) {
    const f = await fixture((_command, callback) => {
      const control = channel(); callback(null, control); queueMicrotask(() => control.emit('close', 0));
    });
    await f.transport.close();
    assert.equal(f.shell.listenerCount('data'), 0);
    assert.equal(f.shell.listenerCount('close'), 0);
    assert.equal(f.shell.listenerCount('error'), 1);
    assert.equal(f.shell.stderr.listenerCount('error'), 1);
    assert.equal(f.client.listenerCount('error'), 0);
    assert.equal(f.client.listenerCount('close'), 0);
    assert.doesNotThrow(() => f.shell.emit('error', Error('late shell error')));
    assert.doesNotThrow(() => f.shell.stderr.emit('error', Error('late stderr error')));
  }
});
