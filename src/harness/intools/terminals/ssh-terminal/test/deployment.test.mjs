import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createWriteStream, mkdir as mkdirCallback, stat, rename, unlink } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSFTPUploadTool, createRemoteDeployTool, uploadSFTP, buildUploadManifest,
  recommendedUploadTimeoutSeconds, resolveUploadTimeoutSeconds, UPLOAD_LIMITS, formatUploadBytes,
  assertMeaningfulHealthCheck, DEFAULT_UPLOAD_EXCLUDES, mapPool
} from '../deployment.mjs';
import { createInternalTools } from '../../../index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubovm-sftp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'); await mkdir(remote);
  const local = join(root, 'local'); await mkdir(local);
  const channel = new EventEmitter();
  const path = value => join(remote, ...value.split('/').filter(Boolean));
  channel.mkdir = (value, done) => mkdirCallback(path(value), done);
  channel.stat = (value, done) => stat(path(value), done);
  channel.createWriteStream = (value, options) => createWriteStream(path(value), options);
  channel.ext_openssh_rename = (a, b, done) => rename(path(a), path(b), done);
  channel.rename = channel.ext_openssh_rename;
  channel.unlink = (value, done) => unlink(path(value), done);
  channel.end = () => { channel.ended = true; channel.emit('close'); };
  const client = new EventEmitter();
  client.sftp = done => done(null, channel);
  const calls = [];
  const commands = {
    maxCommandTimeoutSeconds: 1800,
    summary: () => ({ id: 'selected' }),
    waitForConnection: async signal => { signal?.throwIfAborted(); return client; },
    execute: async input => { calls.push(input.command); return { content: [{ type: 'text', text: 'ok' }] }; },
    tool: () => ({ name: 'run_linux_ssh_command' })
  };
  return { root, local, remote, channel, client, commands, calls };
}

test('recursive upload preserves bytes and empty directories and atomically replaces files', async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'empty'));
  const bytes = Buffer.from([0, 255, 10, 128]);
  await writeFile(join(f.local, 'a.bin'), bytes);
  await mkdir(join(f.remote, 'release'));
  await writeFile(join(f.remote, 'release', 'a.bin'), 'old');
  const updates = [];
  const result = await createSFTPUploadTool(f.commands).execute('1', { local_path: f.local, remote_path: '/release' }, undefined, update => updates.push(update));
  assert.deepEqual(await readFile(join(f.remote, 'release', 'a.bin')), bytes);
  assert.deepEqual((await readdir(join(f.remote, 'release'))).sort(), ['a.bin', 'empty']);
  assert.equal(result.details.files, 1);
  assert.equal(result.details.bytes, 4);
  assert.equal(result.details.profile_id, 'selected');
  assert.equal(typeof result.details.timeout_seconds, 'number');
  assert.match(updates.map(item => item.content[0].text).join(''), /Starting SFTP upload/);
  assert.match(updates.map(item => item.content[0].text).join(''), /Uploaded \/release\/a\.bin \(4 B\)/);
  assert.match(updates.map(item => item.content[0].text).join(''), /concurrency 1/);
  assert.equal(f.channel.ended, true);
  assert.equal(f.client.listenerCount('close'), 0);
});

test('failed publishing preserves the old destination and removes the temporary file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'new');
  await writeFile(join(f.remote, 'app'), 'old');
  f.channel.ext_openssh_rename = (_a, _b, done) => done(new Error('permission denied'));
  await assert.rejects(uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app' }), /permission denied/);
  assert.equal(await readFile(join(f.remote, 'app'), 'utf8'), 'old');
  assert.deepEqual(await readdir(f.remote), ['app']);
});

test('unsupported POSIX rename falls back to standard SFTP rename', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'new');
  f.channel.ext_openssh_rename = (_a, _b, done) => done(Object.assign(new Error('unsupported'), { code: 8 }));
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app' });
  assert.equal(await readFile(join(f.remote, 'app'), 'utf8'), 'new');
});

test('ssh2 synchronous missing-extension error falls back to standard rename', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'new');
  f.channel.ext_openssh_rename = () => { throw new Error('Server does not support this extended request'); };
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app' });
  assert.equal(await readFile(join(f.remote, 'app'), 'utf8'), 'new');
});

test('upload deadline terminates a stalled subsystem without closing the pooled client', async t => {
  const f = await fixture(t);
  f.client.sftp = () => {};
  // Real sockets keep Node alive; the fake transport needs an equivalent handle.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(uploadSFTP(f.commands, { local_path: f.local, remote_path: '/release', timeout_seconds: 1 }), { name: 'TimeoutError' });
    assert.equal(f.client.listenerCount('close'), 0);
    assert.equal(f.client.listenerCount('error'), 0);
  } finally { clearInterval(keepAlive); }
});

test('abort pending SFTP opening closes late channels and releases listeners', async t => {
  const f = await fixture(t), controller = new AbortController();
  let opened;
  const opening = new Promise(resolve => { f.client.sftp = done => { opened = done; resolve(); }; });
  const operation = uploadSFTP(f.commands, { local_path: f.local, remote_path: '/release' }, controller.signal);
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  await opening; controller.abort(); await rejected;
  opened(null, f.channel);
  assert.equal(f.channel.ended, true);
  assert.equal(f.client.listenerCount('close'), 0);
});

test('disconnect interrupts an unresponsive SFTP request', async t => {
  const f = await fixture(t);
  f.channel.mkdir = () => queueMicrotask(() => f.client.emit('close'));
  await assert.rejects(uploadSFTP(f.commands, { local_path: f.local, remote_path: '/release' }), /transport closed/);
  assert.equal(f.channel.ended, true);
});

test('invalid paths and missing sources cause no remote changes', async t => {
  const f = await fixture(t);
  for (const path of ['/', '//', 'relative', '/a/../b']) {
    await assert.rejects(uploadSFTP(f.commands, { local_path: f.local, remote_path: path }), /absolute remote path/);
  }
  const tool = createRemoteDeployTool(f.commands);
  await assert.rejects(tool.execute('1', { uploads: [{ local_path: f.local, remote_path: '/first' }, { local_path: join(f.local, 'missing'), remote_path: '/second' }], remote_cwd: '/first', commands: ['true'], health_check_command: 'test -d /first' }), /ENOENT/);
  assert.deepEqual(await readdir(f.remote), []);
  assert.deepEqual(f.calls, []);
});

test('deploy uploads before ordered commands and health check, quotes cwd', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'artifact');
  f.commands.execute = async input => {
    assert.equal(await readFile(join(f.remote, 'release', 'app'), 'utf8'), 'artifact');
    f.calls.push(input.command); return { content: [{ type: 'text', text: 'healthy' }] };
  };
  const result = await createRemoteDeployTool(f.commands).execute('1', { uploads: [{ local_path: f.local, remote_path: '/release' }], remote_cwd: "/release's dir", commands: ['install', 'restart'], health_check_command: 'curl -fsS http://127.0.0.1/health' });
  assert.equal(result.details.status, 'healthy');
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0], /cd -- '\/release'"'"'s dir'/);
  assert.match(f.calls[2], /set -e -o pipefail\ncurl -fsS http:\/\/127.0.0.1\/health/);
  assert.equal(result.details.upload_files, 1);
  assert.ok(Array.isArray(result.details.phases));
  assert.match(result.details.note, /user-facing accessibility/i);
});

test('deployment and health-check failures never produce healthy status or retries', async t => {
  for (const failAt of [1, 3]) {
    const f = await fixture(t);
    f.commands.execute = async input => { f.calls.push(input.command); if (f.calls.length === failAt) throw new Error('exit 1'); return {}; };
    await assert.rejects(createRemoteDeployTool(f.commands).execute('1', { uploads: [], remote_cwd: '/app', commands: ['install', 'restart'], health_check_command: 'curl -fsS http://127.0.0.1/health' }), failAt === 1 ? /command 1/ : /health check/);
    assert.equal(f.calls.length, failAt);
  }
});

test('runtime exposes SFTP independently and respects the allowed tool list', async t => {
  const f = await fixture(t);
  const runtime = await createInternalTools({ sessionId: 'sftp', browser: false, allowedTools: ['upload_sftp'], sshPool: { get: () => f.commands, require: () => f.commands } });
  t.after(() => runtime.close());
  assert.deepEqual((await runtime.forWorker('worker')).map(tool => tool.name), ['upload_sftp']);
});

test('cancellation does not wait for a stalled remote stream CLOSE', { timeout: 3000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  await writeFile(join(f.local, 'app'), 'artifact');
  let started, finishDestroy;
  const writing = new Promise(resolve => { started = resolve; });
  const destination = new Writable({
    write(_chunk, _encoding, _done) { started(); },
    destroy(error, done) { finishDestroy = () => done(error); }
  });
  f.channel.createWriteStream = () => destination;
  const end = f.channel.end;
  f.channel.end = () => { end(); finishDestroy?.(); };
  const operation = uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app' }, controller.signal);
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  await writing;
  controller.abort();
  await rejected;
  assert.equal(f.channel.ended, true);
  assert.equal(f.client.listenerCount('close'), 0);
});

test('long destination names do not exceed the SFTP component limit for temporary files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'artifact');
  const create = f.channel.createWriteStream;
  f.channel.createWriteStream = (path, options) => {
    if (Buffer.byteLength(path.split('/').at(-1)) > 255) throw new Error('ENAMETOOLONG');
    return create(path, options);
  };
  // Avoid Windows path-length limits in the fake filesystem destination.
  f.channel.ext_openssh_rename = (a, _b, done) => f.channel.rename(a, '/app', done);
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/' + 'a'.repeat(240) });
  assert.equal(await readFile(join(f.remote, 'app'), 'utf8'), 'artifact');
});

test('explicit executable/private modes reach SFTP and invalid later modes prevent deployment', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'artifact');
  const create = f.channel.createWriteStream;
  let mode;
  f.channel.createWriteStream = (path, options) => { mode = options.mode; return create(path, options); };
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app', file_mode: 0o755 });
  assert.equal(mode, 0o755);
  const g = await fixture(t);
  await assert.rejects(createRemoteDeployTool(g.commands).execute('1', {
    uploads: [{ local_path: g.local, remote_path: '/first' }, { local_path: g.local, remote_path: '/second', file_mode: 0o1000 }],
    remote_cwd: '/app', commands: ['true'], health_check_command: 'test -d /app'
  }), /file_mode/);
  assert.deepEqual(await readdir(g.remote), []);
});

test('manifest and timeout helpers reject oversized payloads and short deadlines', async t => {
  const f = await fixture(t);
  const limits = { ...UPLOAD_LIMITS, maxFileBytes: 8, maxTotalBytes: 12, maxEntries: 100 };
  await writeFile(join(f.local, 'big.bin'), Buffer.alloc(16));
  await assert.rejects(buildUploadManifest({ local_path: join(f.local, 'big.bin'), remote_path: '/big.bin' }, undefined, limits), /File 16 B exceeds 8 B/);
  await mkdir(join(f.local, 'tree'));
  await writeFile(join(f.local, 'tree', 'a'), Buffer.alloc(8));
  await writeFile(join(f.local, 'tree', 'b'), Buffer.alloc(8));
  await assert.rejects(buildUploadManifest({ local_path: join(f.local, 'tree'), remote_path: '/tree' }, undefined, limits), /Upload total 16 B exceeds 12 B/);
  assert.equal(recommendedUploadTimeoutSeconds(0), UPLOAD_LIMITS.defaultTimeoutSeconds);
  assert.ok(recommendedUploadTimeoutSeconds(UPLOAD_LIMITS.minBandwidthBps * 600) > UPLOAD_LIMITS.defaultTimeoutSeconds);
  assert.equal(resolveUploadTimeoutSeconds(0, 1), 1);
  assert.equal(resolveUploadTimeoutSeconds(4096, 30), 30);
  assert.throws(() => resolveUploadTimeoutSeconds(UPLOAD_LIMITS.minBandwidthBps * 600, 30), /timeout_seconds \(30\) is too short/);
  assert.match(formatUploadBytes(1536), /1\.5 KiB/);
});

test('large-file uploads emit byte progress and abort when the stream stalls', async t => {
  const f = await fixture(t);
  const payload = Buffer.alloc(32 * 1024, 7);
  await writeFile(join(f.local, 'blob.bin'), payload);
  const limits = {
    ...UPLOAD_LIMITS,
    streamHighWaterMark: 1024,
    progressMinFileBytes: 1,
    progressBytes: 2048,
    progressIntervalMs: 10_000,
    stallTimeoutMs: 60_000,
    defaultTimeoutSeconds: 30
  };
  const updates = [];
  const result = await uploadSFTP(f.commands, { local_path: join(f.local, 'blob.bin'), remote_path: '/blob.bin' }, undefined, update => updates.push(update), limits);
  assert.equal(result.details.bytes, payload.length);
  assert.ok(updates.some(item => /Uploading \/blob\.bin:/.test(item.content[0].text)));
  assert.ok(updates.some(item => /Uploaded \/blob\.bin/.test(item.content[0].text)));

  const g = await fixture(t);
  await writeFile(join(g.local, 'stuck.bin'), Buffer.alloc(4096, 1));
  g.channel.createWriteStream = () => new Writable({
    highWaterMark: 1024,
    write(_chunk, _encoding, _done) { /* intentionally never complete → stall */ }
  });
  const stallLimits = { ...limits, stallTimeoutMs: 80, defaultTimeoutSeconds: 30 };
  await assert.rejects(
    uploadSFTP(g.commands, { local_path: join(g.local, 'stuck.bin'), remote_path: '/stuck.bin' }, undefined, undefined, stallLimits),
    /stalled/
  );
});

test('deploy preflight blocks oversized aggregates before remote mutation', async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'one')); await writeFile(join(f.local, 'one', 'a'), Buffer.alloc(8));
  await mkdir(join(f.local, 'two')); await writeFile(join(f.local, 'two', 'b'), Buffer.alloc(8));
  let opened = 0;
  const sftp = f.client.sftp;
  f.client.sftp = done => { opened++; sftp(done); };
  const tool = createRemoteDeployTool(f.commands, { ...UPLOAD_LIMITS, maxTotalBytes: 12, maxFileBytes: 64 });
  await assert.rejects(tool.execute('1', {
    uploads: [
      { local_path: join(f.local, 'one'), remote_path: '/one' },
      { local_path: join(f.local, 'two'), remote_path: '/two' }
    ],
    remote_cwd: '/app', commands: ['true'], health_check_command: 'test -d /app'
  }), /Deploy upload total 16 B exceeds 12 B/);
  assert.equal(opened, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.remote), []);
});

test('real Bash rejects failed pipelines in both deployment and health checks', async t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  try { await promisify(execFile)(bash, ['-c', 'true']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Bash is not installed'); return; } throw error; }
  for (const healthFails of [false, true]) {
    const f = await fixture(t);
    let calls = 0;
    f.commands.execute = async input => {
      calls++;
      const result = await promisify(execFile)(bash, ['-c', input.command]);
      return { content: [{ type: 'text', text: result.stdout }] };
    };
    await assert.rejects(createRemoteDeployTool(f.commands).execute('1', {
      uploads: [], remote_cwd: '/tmp',
      commands: healthFails ? ['true'] : ['false | cat', 'echo must-not-run'],
      health_check_command: healthFails ? 'false | cat' : 'test -d /tmp'
    }), healthFails ? /health check/ : /command 1/);
    assert.equal(calls, healthFails ? 2 : 1);
  }
});

test('exclude skips bulky directory basenames and deploy reuses one SFTP session', async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'app'));
  await writeFile(join(f.local, 'app', 'main.js'), 'ok');
  await mkdir(join(f.local, 'app', 'node_modules'));
  await writeFile(join(f.local, 'app', 'node_modules', 'pkg.js'), 'skip-me');
  const manifest = await buildUploadManifest({ local_path: join(f.local, 'app'), remote_path: '/app', exclude: ['node_modules'] });
  assert.equal(manifest.fileCount, 1);
  assert.deepEqual(manifest.skipped, ['/app/node_modules']);
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app', exclude: ['node_modules'] });
  assert.deepEqual((await readdir(join(f.remote, 'app'))).sort(), ['main.js']);

  const g = await fixture(t);
  await mkdir(join(g.local, 'one')); await writeFile(join(g.local, 'one', 'a'), '1');
  await mkdir(join(g.local, 'two')); await writeFile(join(g.local, 'two', 'b'), '2');
  let opens = 0;
  const sftp = g.client.sftp;
  g.client.sftp = done => { opens++; sftp(done); };
  g.commands.execute = async input => { g.calls.push(input.command); return { content: [{ type: 'text', text: 'ok' }] }; };
  const result = await createRemoteDeployTool(g.commands).execute('1', {
    uploads: [
      { local_path: join(g.local, 'one'), remote_path: '/one' },
      { local_path: join(g.local, 'two'), remote_path: '/two' }
    ],
    remote_cwd: '/one', commands: ['install'], health_check_command: 'test -f /one/a'
  });
  assert.equal(opens, 1);
  assert.equal(result.details.uploads.length, 2);
  assert.equal(await readFile(join(g.remote, 'one', 'a'), 'utf8'), '1');
  assert.equal(await readFile(join(g.remote, 'two', 'b'), 'utf8'), '2');
});

test('portable SFTP rename replaces an existing destination after unlink', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'new');
  await writeFile(join(f.remote, 'app'), 'old');
  f.channel.ext_openssh_rename = (_a, _b, done) => done(Object.assign(new Error('unsupported'), { code: 8 }));
  let renameCalls = 0;
  const rename = f.channel.rename;
  f.channel.rename = (a, b, done) => {
    renameCalls++;
    if (renameCalls === 1) return done(Object.assign(new Error('file exists'), { code: 4 }));
    return rename(a, b, done);
  };
  await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app' });
  assert.equal(await readFile(join(f.remote, 'app'), 'utf8'), 'new');
  assert.ok(renameCalls >= 2);
});

test('health check rejects no-op true/echo commands', () => {
  assert.throws(() => assertMeaningfulHealthCheck('true'), /no-op/);
  assert.throws(() => assertMeaningfulHealthCheck('echo ok'), /echo-only/);
  assert.equal(assertMeaningfulHealthCheck('curl -fsS http://127.0.0.1/health'), 'curl -fsS http://127.0.0.1/health');
});

test('mapPool bounds concurrency and preserves result order', async () => {
  let active = 0, peak = 0;
  const values = await mapPool([1, 2, 3, 4, 5], 2, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return value * 10;
  });
  assert.deepEqual(values, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2);
  assert.ok(peak >= 2);
});

test('dry_run plans upload and deploy without opening SFTP', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'app'), 'artifact');
  let opens = 0;
  const sftp = f.client.sftp;
  f.client.sftp = done => { opens++; sftp(done); };
  const planned = await uploadSFTP(f.commands, { local_path: join(f.local, 'app'), remote_path: '/app', dry_run: true });
  assert.equal(planned.details.dry_run, true);
  assert.equal(planned.details.files, 1);
  assert.equal(opens, 0);
  assert.deepEqual(await readdir(f.remote), []);

  const deploy = await createRemoteDeployTool(f.commands).execute('1', {
    uploads: [{ local_path: join(f.local, 'app'), remote_path: '/release' }],
    remote_cwd: '/release', commands: ['install'], health_check_command: 'test -f /release/app', dry_run: true
  });
  assert.equal(deploy.details.status, 'planned');
  assert.equal(deploy.details.dry_run, true);
  assert.equal(opens, 0);
  assert.deepEqual(f.calls, []);
});

test('exclude_defaults and skip_unchanged reduce redeploy work', async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'app'));
  await writeFile(join(f.local, 'app', 'main.js'), 'ok');
  await mkdir(join(f.local, 'app', '.git'));
  await writeFile(join(f.local, 'app', '.git', 'config'), 'skip');
  assert.ok(DEFAULT_UPLOAD_EXCLUDES.includes('.git'));
  const manifest = await buildUploadManifest({ local_path: join(f.local, 'app'), remote_path: '/app', exclude_defaults: true });
  assert.equal(manifest.fileCount, 1);
  assert.ok(manifest.skipped.includes('/app/.git'));

  await mkdir(join(f.remote, 'app'));
  await writeFile(join(f.remote, 'app', 'main.js'), 'ok');
  const result = await uploadSFTP(f.commands, {
    local_path: join(f.local, 'app'), remote_path: '/app', exclude_defaults: true, skip_unchanged: true
  });
  assert.equal(result.details.files, 0);
  assert.equal(result.details.skipped_unchanged, 1);
  assert.equal(result.details.bytes, 0);
});

test('parallel uploads transfer every file under a concurrency cap', async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'tree'));
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(f.local, 'tree', name), name.repeat(8));
  let peak = 0, active = 0;
  const create = f.channel.createWriteStream;
  f.channel.createWriteStream = (path, options) => {
    active++;
    peak = Math.max(peak, active);
    const stream = create(path, options);
    stream.on('close', () => { active--; });
    return stream;
  };
  const result = await uploadSFTP(f.commands, { local_path: join(f.local, 'tree'), remote_path: '/tree' }, undefined, undefined, {
    ...UPLOAD_LIMITS, fileConcurrency: 2
  });
  assert.equal(result.details.files, 4);
  assert.equal(result.details.concurrency, 2);
  assert.ok(peak <= 2);
  assert.deepEqual((await readdir(join(f.remote, 'tree'))).sort(), ['a', 'b', 'c', 'd']);
});
