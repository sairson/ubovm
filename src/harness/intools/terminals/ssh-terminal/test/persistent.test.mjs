import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import ssh2 from 'ssh2';
import { SSHCommands } from '../commands.mjs';

async function setup(t, onWrite = () => {}, { initialOutput } = {}) {
  const client = new EventEmitter(), channels = [];
  client.connect = () => queueMicrotask(() => client.emit('ready'));
  client.end = () => client.emit('close');
  client.exec = (command, callback) => {
    if (command.startsWith('test ')) {
      const control = new EventEmitter(); control.stderr = new EventEmitter(); control.close = () => {};
      assert.match(command, /kill -KILL -- -12345 &&/);
      callback(null, control); queueMicrotask(() => control.emit('close', 0)); return;
    }
    assert.match(command, /setsid bash --noprofile --norc/);
    const identity = command.match(/UBOVM_SHELL_SESSION=([a-f0-9-]+)/)[1];
    const channel = initialOutput === undefined ? new EventEmitter() : new PassThrough(); channel.stderr = new EventEmitter();
    channel.signal = () => {}; channel.close = () => { channel.destroy?.(); channel.emit('close'); };
    channel.write = script => {
      channel.token = script.match(/\nubovm_([a-f0-9]+)=\$\?/)[1];
      channel.script = script;
      onWrite(channel);
    };
    channels.push(channel); callback(null, channel);
    queueMicrotask(() => {
      const identityFrame = Buffer.from(`\x1e${identity}:12345\x1f`);
      if (initialOutput === undefined) channel.emit('data', identityFrame);
      else channel.push(Buffer.concat([identityFrame, Buffer.from(initialOutput)]));
    });
  };
  t.mock.method(ssh2, 'Client', function () { return client; });
  const commands = new SSHCommands({ host: 'example.test', username: 'test', insecure_ignore_host_key: true });
  t.after(() => commands.close());
  await commands.connect();
  return { commands, channels, client };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = (channel, code = 0) => Buffer.from(`\x1eubovm_${channel.token}:${code}\x1f`);
const complete = (channel, code = 0) => { channel.emit('data', frame(channel, code)); channel.stderr.emit('data', frame(channel, code)); };

test('SSH commands consume coalesced startup output before completion and preserve session reuse', async t => {
  const initialOutput = '启动日志\n' + 'x'.repeat(4096);
  const { commands, channels } = await setup(t, channel => {
    channel.push(Buffer.concat([Buffer.from('command-output'), frame(channel)]));
    channel.stderr.emit('data', frame(channel));
  }, { initialOutput });
  const updates = [];
  const first = await commands.execute({ command: 'first', session: 'buffered' }, undefined, result => updates.push(result.content[0].text));
  assert.equal(first.content[0].text, initialOutput + 'command-output');
  assert.equal(updates.join(''), first.content[0].text);
  const second = await commands.execute({ command: 'second', session: 'buffered' });
  assert.equal(second.content[0].text, 'command-output');
  assert.equal(channels.length, 1);
});

test('SSH persistent commands reuse a channel, strip split frames and await late stderr', async t => {
  const { commands, channels } = await setup(t);
  const updates = [];
  let settled = false;
  const pending = commands.execute({ command: 'printf test', session: 'build' }, undefined, result => updates.push(result.content[0].text));
  pending.then(() => { settled = true; });
  await tick();
  const [channel] = channels;
  const out = Buffer.concat([Buffer.from('无换行'), frame(channel)]);
  for (const byte of out) channel.emit('data', Buffer.from([byte]));
  await tick(); assert.equal(settled, false);
  for (const byte of Buffer.from('warning')) channel.stderr.emit('data', Buffer.from([byte]));
  for (const byte of frame(channel)) channel.stderr.emit('data', Buffer.from([byte]));
  const result = await pending;
  assert.equal(result.content[0].text, '无换行[stderr] warning');
  assert.equal(updates.join(''), result.content[0].text);
  const next = commands.execute({ command: 'echo next', session: 'build' });
  await tick(); assert.equal(channels.length, 1); complete(channel); await next;
});

test('SSH disconnect invalidates an idle session and the next call soft-resets it', async t => {
  const { commands, channels, client } = await setup(t, complete);
  await commands.execute({ command: 'true', session: 'build' });
  client.emit('close');
  const recovered = await commands.execute({ command: 'true', session: 'build' });
  assert.equal(recovered.details.session_auto_reset, true);
  assert.equal(channels.length, 2);
  await commands.execute({ command: 'true', session: 'build', reset_session: true });
  assert.equal(channels.length, 3);
});

test('SSH queued cancellation does not kill the active command or run the cancelled command', async t => {
  const { commands, channels } = await setup(t);
  const active = commands.execute({ command: 'active', session: 'build' });
  await tick();
  const controller = new AbortController();
  const queued = commands.execute({ command: 'never-run', session: 'build' }, controller.signal);
  controller.abort(new Error('cancel queued'));
  await assert.rejects(queued, /cancel queued/);
  complete(channels[0]); await active; await tick();
  assert.doesNotMatch(channels[0].script, /never-run/);
  const next = commands.execute({ command: 'next', session: 'build' });
  await tick(); complete(channels[0]); await next;
});

test('SSH active cancellation preserves output and invalidates the shell without retry', async t => {
  const { commands, channels } = await setup(t);
  const controller = new AbortController();
  const pending = commands.execute({ command: 'active', session: 'build' }, controller.signal);
  await tick(); channels[0].emit('data', Buffer.from('before-cancel'));
  controller.abort(new Error('cancel active'));
  await assert.rejects(pending, error => /before-cancel/.test(error.message) && error.details.session_lost);
  const next = commands.execute({ command: 'next', session: 'build' });
  await tick();
  assert.equal(channels.length, 2);
  complete(channels[1]);
  const recovered = await next;
  assert.equal(recovered.details.session_auto_reset, true);
});

test('separate SSH tools isolate session names and close their channels independently', async t => {
  const { commands, channels } = await setup(t, complete);
  const a = commands.tool(), b = commands.tool();
  await a.execute('a', { command: 'true', session: 'same' });
  await b.execute('b', { command: 'true', session: 'same' });
  assert.equal(channels.length, 2);
  await a.close();
  await b.execute('b', { command: 'true', session: 'same' });
  assert.equal(channels.length, 2);
  await b.close();
});

test('SSH cancellation while opening closes a late channel', async t => {
  const { commands, client } = await setup(t);
  let submit;
  client.exec = (_command, callback) => { submit = callback; };
  const controller = new AbortController();
  const pending = commands.execute({ command: 'never-run', session: 'build' }, controller.signal);
  await tick(); controller.abort(new Error('cancel opening'));
  await assert.rejects(pending, /cancel opening/);
  let closed = false;
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  channel.signal = () => {}; channel.close = () => { closed = true; };
  submit(null, channel); assert.equal(closed, true);
});
