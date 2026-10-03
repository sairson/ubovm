import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import ssh2 from 'ssh2';
import { SSHCommands } from '../commands.mjs';

async function setup(t, exec, options = {}) {
  const client = new EventEmitter();
  client.connect = () => queueMicrotask(() => client.emit('ready'));
  client.exec = exec;
  client.end = () => client.emit('close');
  t.mock.method(ssh2, 'Client', function () { return client; });
  const commands = new SSHCommands({ host: 'example.test', username: 'test', insecure_ignore_host_key: true, ...options });
  await commands.connect();
  t.after(() => commands.close());
  return { commands, client };
}

test('completed isolated SSH commands release their channel callbacks and preserve external listeners', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  for (let i = 0; i < 50; i++) {
    const pending = commands.execute({ command: 'test' });
    await new Promise(resolve => setImmediate(resolve));
    const channel = new EventEmitter(); channel.stderr = new EventEmitter();
    const external = () => {};
    channel.on('data', external);
    submit(null, channel); channel.emit('close', 0); await pending;
    assert.deepEqual(channel.listeners('data'), [external]);
    for (const name of ['end', 'exit', 'close']) assert.equal(channel.listenerCount(name), 0);
    assert.equal(channel.stderr.listenerCount('data'), 0);
    assert.equal(channel.stderr.listenerCount('end'), 0);
    assert.equal(channel.listenerCount('error'), 1);
    assert.equal(channel.stderr.listenerCount('error'), 1);
    assert.doesNotThrow(() => channel.emit('error', Error('late transport failure')));
  }
});

test('SSH disconnect closes the isolated channel and releases callbacks despite missing channel close events', async t => {
  let submit;
  const { commands, client } = await setup(t, (_command, callback) => { submit = callback; });
  const controller = new AbortController();
  const pending = commands.execute({ command: 'test' }, controller.signal);
  const observed = assert.rejects(pending, error => /transport closed/.test(error.message) && error.details.remote_termination_confirmed === false);
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  let closes = 0;
  channel.signal = () => { throw Error('disconnected transport'); };
  channel.close = () => { closes++; };
  submit(null, channel);
  channel.emit('data', Buffer.from('partial output'));
  client.emit('close');
  await observed;
  assert.equal(closes, 1);
  assert.equal(channel.listenerCount('data'), 0);
  assert.equal(channel.stderr.listenerCount('data'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.doesNotThrow(() => channel.emit('error', Error('late error')));
});

test('hostile SSH stream errors settle the command and cannot interrupt channel cleanup', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const pending = commands.execute({ command: 'test' });
  const observed = assert.rejects(pending, error => error.message.includes('Operation failed') && error.details.remote_termination_confirmed === false);
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  let closes = 0;
  channel.signal = () => {}; channel.close = () => { closes++; };
  submit(null, channel);
  const error = new Proxy({}, { get() { throw Error('hostile error property'); } });
  assert.doesNotThrow(() => channel.emit('error', error));
  await observed;
  assert.equal(closes, 1);
  assert.equal(channel.listenerCount('data'), 0);
});

test('falsy SSH stream error values remain failures and close the channel', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  for (const reason of [undefined, null, false, 0, '']) {
    const pending = commands.execute({ command: 'test' });
    const observed = assert.rejects(pending, error => error.details.remote_termination_confirmed === false);
    await new Promise(resolve => setImmediate(resolve));
    const channel = new EventEmitter(); channel.stderr = new EventEmitter();
    let closes = 0;
    channel.signal = () => {}; channel.close = () => { closes++; };
    submit(null, channel); channel.emit('error', reason);
    await observed; assert.equal(closes, 1);
  }
});

test('SSH streams split UTF-8 on stdout and stderr without corrupting either stream', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const updates = [];
  const pending = commands.execute({ command: 'test' }, undefined, update => updates.push(update.content[0].text));
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  submit(null, channel);
  const out = Buffer.from('代码'), err = Buffer.from('提示');
  channel.emit('data', out.subarray(0, 1));
  channel.stderr.emit('data', err.subarray(0, 2));
  channel.emit('data', out.subarray(1));
  channel.stderr.emit('data', err.subarray(2));
  channel.emit('end'); channel.stderr.emit('end'); channel.emit('close', 0);
  const result = await pending;
  assert.equal(result.content[0].text, '代码[stderr] 提示');
  assert.equal(updates.join(''), result.content[0].text);
});

test('SSH publishes output before the remote channel closes', { timeout: 3000 }, async t => {
  let submit, updated;
  const live = new Promise(resolve => { updated = resolve; });
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  let completed = false;
  const pending = commands.execute({ command: 'test' }, undefined, update => updated(update.content[0].text));
  pending.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  submit(null, channel);
  channel.emit('data', Buffer.from('live-ssh\n'));
  try {
    assert.equal(await live, 'live-ssh\n');
    assert.equal(completed, false);
  } finally { channel.emit('close', 0); await pending; }
});

test('SSH batches tiny packets and flushes all output before command completion', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const updates = [];
  const pending = commands.execute({ command: 'test' }, undefined, update => updates.push(update.content[0].text));
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  submit(null, channel);
  for (let i = 0; i < 10000; i++) channel.emit('data', Buffer.from('x'));
  channel.emit('close', 0);
  const result = await pending;
  assert.equal(result.content[0].text, 'x'.repeat(10000));
  assert.equal(updates.join(''), result.content[0].text);
  assert.ok(updates.length <= 2, `expected coalesced updates, got ${updates.length}`);
});

test('SSH output limit wins over synchronous successful close during termination', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; }, { max_output_bytes: 4 });
  const pending = commands.execute({ command: 'test' });
  const rejected = assert.rejects(pending, /SSH output exceeds 4 bytes/);
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  channel.signal = () => {};
  channel.close = () => channel.emit('close', 0);
  submit(null, channel);
  channel.emit('data', Buffer.from('overflow'));
  await rejected;
});

test('SSH isolates rejected asynchronous output observers', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const pending = commands.execute({ command: 'test' }, undefined, async () => { throw new Error('observer failed'); });
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  submit(null, channel); channel.emit('data', Buffer.from('ok')); channel.emit('close', 0);
  assert.equal((await pending).content[0].text, 'ok');
  await new Promise(resolve => setImmediate(resolve));
});

test('synchronous SSH exec failures release abort and disconnect listeners immediately', async t => {
  const { commands, client } = await setup(t, () => { throw new Error('exec rejected synchronously'); });
  const before = client.listenerCount('close');
  await assert.rejects(commands.execute({ command: 'test' }), /exec rejected synchronously/);
  assert.equal(client.listenerCount('close'), before);
});

test('SSH flushes sparse output within 16ms and never publishes again after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const updates = [];
  const pending = commands.execute({ command: 'test' }, undefined, value => updates.push(value.content[0].text));
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter(); submit(null, channel);
  channel.emit('data', Buffer.from('first'));
  t.mock.timers.tick(15); assert.deepEqual(updates, []);
  t.mock.timers.tick(1); assert.deepEqual(updates, ['first']);
  channel.stderr.emit('data', Buffer.from('last')); channel.emit('close', 0);
  assert.equal((await pending).content[0].text, 'first[stderr] last');
  t.mock.timers.tick(1000);
  assert.deepEqual(updates, ['first', '[stderr] last']);
});

test('SSH flushes sustained output by size without waiting for timers', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const updates = [];
  const pending = commands.execute({ command: 'test' }, undefined, value => updates.push(value.content[0].text));
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter(); submit(null, channel);
  for (let i = 0; i < 100; i++) channel.emit('data', Buffer.alloc(1024, 'a'));
  assert.equal(updates.length, 3);
  channel.emit('close', 0);
  assert.equal((await pending).content[0].text, updates.join(''));
  assert.equal(updates.length, 4);
});

test('SSH cancellation preserves buffered output and ignores late channel data', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const controller = new AbortController(), reason = new Error('cancelled by caller'), updates = [];
  const pending = commands.execute({ command: 'test' }, controller.signal, value => updates.push(value.content[0].text));
  const rejected = assert.rejects(pending, error => error.cause === reason && error.message.endsWith('partial') &&
    error.details.remote_termination_confirmed === false && /termination is unconfirmed/.test(error.message));
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  channel.signal = () => { throw new Error('signal unavailable'); };
  let closes = 0; channel.close = () => { closes++; channel.emit('close', 0); };
  submit(null, channel); channel.emit('data', Buffer.from('partial')); controller.abort(reason);
  channel.emit('data', Buffer.from('late')); channel.stderr.emit('error', new Error('late stream error'));
  await rejected;
  assert.deepEqual(updates, ['partial']); assert.equal(closes, 1);
});

test('SSH stderr errors reject the command and close its channel', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; });
  const pending = commands.execute({ command: 'test' });
  const rejected = assert.rejects(pending, /stderr failed/);
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.signal = () => {};
  let closes = 0; channel.close = () => { closes++; channel.emit('close', 0); };
  submit(null, channel); channel.stderr.emit('error', new Error('stderr failed'));
  await rejected; assert.equal(closes, 1);
});

test('closing one SSH tool stops its isolated command without affecting another tool', async t => {
  const channels = [];
  const { commands, client } = await setup(t, (_command, callback) => {
    const channel = new EventEmitter(); channel.stderr = new EventEmitter();
    channel.signals = []; channel.signal = value => channel.signals.push(value);
    channel.closes = 0; channel.close = () => { channel.closes++; channel.emit('close', 0); };
    channels.push(channel); callback(null, channel);
  });
  const a = commands.tool(), b = commands.tool();
  t.after(() => b.close());
  const pendingA = a.execute('a', { command: 'long-a' });
  const rejected = assert.rejects(pendingA, /SSH shell tool is closed[\s\S]*partial-a/);
  const pendingB = b.execute('b', { command: 'long-b' });
  await new Promise(resolve => setImmediate(resolve));
  channels[0].emit('data', Buffer.from('partial-a'));
  const closing = a.close();
  assert.equal(a.close(), closing);
  await closing; await rejected;
  assert.deepEqual(channels[0].signals, ['KILL']);
  assert.equal(channels[0].closes, 1);
  assert.equal(channels[1].closes, 0);
  assert.equal(await commands.connect(), client);
  channels[1].emit('data', Buffer.from('still-running-b')); channels[1].emit('close', 0);
  assert.equal((await pendingB).content[0].text, 'still-running-b');
  await assert.rejects(a.execute('late', { command: 'never' }), /tool is closed/);
  assert.equal(channels.length, 2);
});

test('closing an SSH tool cancels connection wait and closes late exec channels', async t => {
  let submit, resolveConnection;
  const { commands, client } = await setup(t, (_command, callback) => { submit = callback; });
  const a = commands.tool();
  const pendingA = a.execute('a', { command: 'late-channel' });
  const rejectedA = assert.rejects(pendingA, /tool is closed/);
  await new Promise(resolve => setImmediate(resolve));
  await a.close(); await rejectedA;
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  let closes = 0; channel.signal = () => {}; channel.close = () => { closes++; };
  submit(null, channel);
  assert.equal(closes, 1);

  t.mock.method(commands, 'connect', () => new Promise(resolve => { resolveConnection = resolve; }));
  const b = commands.tool();
  const pendingB = b.execute('b', { command: 'never-submit' });
  const rejectedB = assert.rejects(pendingB, /tool is closed/);
  await new Promise(resolve => setImmediate(resolve));
  await b.close(); await rejectedB;
  let submitted = false; client.exec = () => { submitted = true; };
  resolveConnection(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted, false);
});

test('cancelled SSH connection waiters release listeners before handshake resolves', async t => {
  const { commands, client } = await setup(t, () => assert.fail('must not submit'));
  let resolveConnection;
  const connecting = new Promise(resolve => { resolveConnection = resolve; });
  t.mock.method(commands, 'connect', () => connecting);
  const survivor = commands.waitForConnection();
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    const pending = commands.waitForConnection(controller.signal);
    const rejected = assert.rejects(pending, /cancel waiter/);
    await Promise.resolve();
    controller.abort(new Error('cancel waiter'));
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  resolveConnection(client);
  assert.equal(await survivor, client);
});

test('profile close keeps the shared client while an open tool still holds a resident ref', async t => {
  let submitted, channel;
  const { commands, client } = await setup(t, (command, callback) => {
    submitted = command;
    channel = new EventEmitter(); channel.stderr = new EventEmitter();
    channel.signal = () => {}; channel.close = () => channel.emit('close', 0);
    callback(null, channel);
  });
  let ended = false;
  client.end = () => { ended = true; client.emit('close'); };
  const tool = commands.tool();
  const lifecycle = {
    get resident() { return true; },
    subscribe(callback) { callback(); return () => {}; },
    stopping() {}
  };
  const pending = tool.execute('dev', { command: 'npm run dev', timeout_seconds: 1 }, undefined, undefined, lifecycle);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(submitted, /^bash -lc /);
  assert.doesNotMatch(submitted, /timeout --signal=KILL/);
  await commands.close();
  assert.equal(ended, false, 'resident tool ref must keep the SSH client alive after profile close');
  channel.emit('data', Buffer.from('still-alive\n'));
  channel.emit('close', 0);
  assert.match((await pending).content[0].text, /still-alive/);
  await tool.close();
  assert.equal(ended, true);
});

test('host-managed one-shot SSH residents clear the foreground timeout and keep streaming', async t => {
  let submit;
  const { commands } = await setup(t, (_command, callback) => { submit = callback; }, { default_command_timeout_seconds: 1, max_output_bytes: 64 });
  let resident = false, clearCount = 0;
  const lifecycle = {
    get resident() { return resident; },
    subscribe(callback) { clearCount++; resident = true; callback(); return () => {}; },
    stopping() {}
  };
  const updates = [];
  const pending = commands.execute({ command: 'npm run dev' }, undefined, update => updates.push(update.content[0].text), undefined, lifecycle);
  await new Promise(resolve => setImmediate(resolve));
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  channel.signal = () => {}; channel.close = () => channel.emit('close', 0);
  submit(null, channel);
  channel.emit('data', Buffer.from('ready\n'));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(clearCount, 1);
  assert.match(updates.join(''), /ready/);
  channel.emit('data', Buffer.from('still-serving\n'));
  channel.emit('close', 0);
  assert.match((await pending).content[0].text, /still-serving/);
});
