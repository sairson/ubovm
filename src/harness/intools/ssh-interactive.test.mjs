import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';
import { openInteractiveShell } from './ssh-interactive.mjs';
import { SSHCommands } from './ssh-commands-execute.mjs';
import { SSHCommandsPool } from './ssh-commands-pool-manager.mjs';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  inputs = [];
  windows = [];
  closeCount = 0;
  write(data) { this.inputs.push(data); return true; }
  setWindow(...dimensions) { this.windows.push(dimensions); }
  close() { this.closeCount++; }
}

class Client extends EventEmitter {
  destroyed = false;
  ended = false;
  connect(options) { this.options = options; }
  shell(options, callback) { this.pty = options; this.shellCallback = callback; }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.ended = true; this.emit('close'); }
}

const profile = { id: 'dev', host: 'example.test', username: 'developer', insecure_ignore_host_key: true };

function captureClient(t) {
  let client;
  t.mock.method(ssh2, 'Client', function () { return client = new Client(); });
  return () => client;
}

test('interactive session opens a PTY shell and preserves terminal bytes, control input and small resizes', async () => {
  const client = new Client(), channel = new Channel();
  const opening = openInteractiveShell(client, { columns: 120, rows: 32 });
  assert.deepEqual(client.pty, { term: 'xterm-256color', cols: 120, rows: 32 });
  client.shellCallback(null, channel);
  const session = await opening;
  const output = [], errors = [];
  session.stream.on('data', chunk => output.push(chunk));
  session.stream.stderr.on('data', chunk => errors.push(chunk));
  const ansi = Buffer.from('\x1b[32m你好\x1b[0m\r\n');
  channel.emit('data', ansi.subarray(0, 7));
  channel.emit('data', ansi.subarray(7));
  channel.stderr.emit('data', Buffer.from('diagnostic\r\n'));
  assert.deepEqual(Buffer.concat(output), ansi);
  assert.equal(Buffer.concat(errors).toString(), 'diagnostic\r\n');
  assert.equal(session.write('printf hello\r'), true);
  session.write('\x03');
  session.resize(1, 1);
  assert.deepEqual(channel.inputs, ['printf hello\r', '\x03']);
  assert.deepEqual(channel.windows, [[1, 1, 0, 0]]);
  let exit;
  session.stream.on('exit', (code, signal) => { exit = { code, signal }; });
  channel.emit('exit', 17, undefined);
  channel.emit('close', 17);
  assert.deepEqual(exit, { code: 17, signal: undefined });
  assert.equal(session.write('after exit'), false);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
});

test('abort rejects a pending shell without waiting for its callback and closes a late channel', async () => {
  const client = new Client(), controller = new AbortController();
  const opening = openInteractiveShell(client, { signal: controller.signal });
  const rejected = assert.rejects(opening, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
  const late = new Channel();
  client.shellCallback(null, late);
  assert.equal(late.closeCount, 1);
  assert.doesNotThrow(() => late.emit('error', new Error('late channel shutdown')));
});

test('a transport close rejects a pending shell and safely disposes its late channel', async () => {
  const client = new Client();
  const opening = openInteractiveShell(client);
  client.emit('close');
  await assert.rejects(opening, /transport closed/);
  const late = new Channel();
  client.shellCallback(null, late);
  assert.equal(late.closeCount, 1);
});

test('transport errors reach an open terminal and closing is idempotent', async () => {
  const client = new Client(), channel = new Channel();
  const opening = openInteractiveShell(client);
  client.shellCallback(null, channel);
  const session = await opening, errors = [];
  session.stream.on('error', error => errors.push(error));
  client.emit('error', new Error('connection lost'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'connection lost');
  assert.equal(channel.closeCount, 1);
  session.close(); session.close();
  assert.equal(channel.closeCount, 1);
  assert.equal(session.write('\r'), false);
  session.resize(80, 24);
  assert.deepEqual(channel.windows, []);
  assert.equal(client.listenerCount('close'), 0);
});

test('aborting an open shell closes the channel and detaches its transport listeners', async () => {
  const client = new Client(), channel = new Channel(), controller = new AbortController();
  const opening = openInteractiveShell(client, { signal: controller.signal });
  client.shellCallback(null, channel);
  const session = await opening, errors = [];
  session.stream.on('error', error => errors.push(error));
  controller.abort();
  assert.equal(channel.closeCount, 1);
  assert.equal(errors[0].name, 'AbortError');
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('close'), 0);
  session.close();
  assert.equal(channel.closeCount, 1);
});

test('channel errors and shell rejection release listeners without unhandled shutdown errors', async () => {
  const client = new Client(), channel = new Channel();
  const opening = openInteractiveShell(client);
  client.shellCallback(null, channel);
  const session = await opening;
  channel.emit('error', new Error('channel failed'));
  assert.equal(channel.closeCount, 1);
  assert.equal(session.write('closed'), false);
  assert.equal(client.listenerCount('error'), 0);
  assert.doesNotThrow(() => channel.emit('error', new Error('late error')));
  const rejectedClient = new Client();
  const rejected = openInteractiveShell(rejectedClient);
  rejectedClient.shellCallback(new Error('PTY denied'));
  await assert.rejects(rejected, /PTY denied/);
  assert.equal(rejectedClient.listenerCount('close'), 0);
});

test('invalid dimensions and pre-aborted signals never submit a shell request', () => {
  const client = new Client();
  assert.throws(() => openInteractiveShell(client, { columns: 0 }), /columns/);
  assert.throws(() => openInteractiveShell(client, { rows: 1.5 }), /rows/);
  assert.throws(() => openInteractiveShell(client, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(client.shellCallback, undefined);
});

test('closing SSHCommands cancels an in-flight authentication immediately', async t => {
  const getClient = captureClient(t);
  const commands = new SSHCommands(profile);
  const connecting = commands.connect();
  const rejected = assert.rejects(connecting, /closed before ready/);
  const client = getClient();
  assert.ok(client);
  await commands.close();
  await rejected;
  assert.equal(client.destroyed, true);
  client.emit('ready');
  assert.doesNotThrow(() => client.emit('error', new Error('late authentication error')));
  await assert.rejects(commands.connect(), /connection is closed/);
});

test('synchronous connection failures are rejected and dispose the pending client', async t => {
  const getClient = captureClient(t);
  t.mock.method(Client.prototype, 'connect', function () { throw new Error('Invalid authentication configuration'); });
  const commands = new SSHCommands(profile);
  await assert.rejects(commands.connect(), /Invalid authentication configuration/);
  assert.equal(getClient().destroyed, true);
  await commands.close();
});

test('interactive SSH reuses fingerprint checks and configured password, private key, passphrase and agent', async t => {
  const getClient = captureClient(t);
  const key = Buffer.from('trusted host public key');
  const fingerprint = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const commands = new SSHCommands({ ...profile, insecure_ignore_host_key: false, host_key_sha256: `SHA256:${fingerprint}`,
    password: 'test-password', privateKey: 'test-private-key', private_key_passphrase: 'test-passphrase', agent: 'test-agent' });
  const opening = commands.openInteractive({ columns: 1, rows: 1 });
  const client = getClient();
  assert.equal(client.options.password, 'test-password');
  assert.equal(client.options.privateKey, 'test-private-key');
  assert.equal(client.options.passphrase, 'test-passphrase');
  assert.equal(client.options.agent, 'test-agent');
  assert.equal(client.options.hostVerifier(key), true);
  assert.equal(client.options.hostVerifier(Buffer.from('changed host key')), false);
  client.emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  const channel = new Channel();
  client.shellCallback(null, channel);
  const session = await opening;
  session.close();
  await commands.close();
  assert.equal(client.ended, true);
});

test('known_hosts and private key files are shared by the interactive connection path', { timeout: 5000 }, async t => {
  const getClient = captureClient(t);
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-ssh-test-'));
  const knownHosts = join(directory, 'known_hosts'), privateKey = join(directory, 'identity');
  t.after(async () => { await unlink(knownHosts); await unlink(privateKey); await rmdir(directory); });
  const key = Buffer.from('known host key');
  await writeFile(knownHosts, `[example.test]:2222 ssh-ed25519 ${key.toString('base64')}\n`);
  await writeFile(privateKey, 'private key fixture');
  const commands = new SSHCommands({ ...profile, port: 2222, insecure_ignore_host_key: false, known_hosts_file: knownHosts, private_key_file: privateKey });
  const connecting = commands.connect();
  while (!getClient()) await new Promise(resolve => setImmediate(resolve));
  const client = getClient();
  assert.equal(client.options.privateKey.toString(), 'private key fixture');
  assert.equal(client.options.hostVerifier(key), true);
  assert.equal(client.options.hostVerifier(Buffer.from('wrong key')), false);
  client.emit('ready');
  await connecting;
  await commands.close();
});

test('the configured default profile remains selectable for an independent terminal connection', async () => {
  const pool = new SSHCommandsPool({ profiles: [{ ...profile, id: 'first' }, { ...profile, id: 'selected' }], defaultId: 'selected' });
  assert.equal(pool.require().summary().id, 'selected');
  await pool.close();
});
