import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, realpath, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createPythonQueue } from '../queue.mjs';
import { createPythonOutput } from '../output.mjs';
import { normalizePythonDomains, privatePythonPaths, pythonPolicy, pythonAllowsHost } from '../policy.mjs';
import { preparePythonOutput, validatePythonPaths, removeEmptyPythonOutput } from '../files.mjs';
import { executePythonRequest } from '../runner-core.mjs';
import { runPythonSandbox } from '../execution.mjs';
import { contained } from '../../../shared/common.mjs';

async function fixture(t) {
  const root = await realpath(tmpdir()), directory = await mkdtemp(join(root, 'ubovm-python-hardening-'));
  t.after(() => {
    const child = relative(root, directory);
    assert(child && !child.startsWith('..') && !isAbsolute(child));
    // Forced-shutdown tests deliberately settle before Windows releases cwd.
    return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  return { directory, request: { workspace, cwd: workspace, executable: process.execPath, readRoots: [], code: 'print(1)', arguments: [],
    outputDirectory: join(workspace, '.ubovm-python-output', `run-${randomUUID()}`), timeout: 5, maxOutputBytes: 1024 } };
}
function backendFixture(overrides = {}) {
  const calls = [];
  const backend = {
    VENDORED_SRT_WIN_EXE: 'test-helper', resolveSrtWin: () => ({}), grantWindowsAcl: () => {},
    checkWindowsSandboxStatusAsync: async () => ({ user: { provisioned: true, credPresent: true, sid: 'fixture' }, wfp: { state: 'installed' } }),
    revokeWindowsAcl: () => { calls.push('revoke'); return []; }, restoreWindowsAcl: () => { calls.push('restore'); return []; },
    SandboxManager: { isSupportedPlatform: () => true, initialize: async () => calls.push('initialize'),
      wrapWithSandboxArgv: async () => ({ argv: ['fixture'] }), reset: async () => calls.push('reset') }, ...overrides
  };
  return { calls, dependencies: { backend, platform: 'win32', protectedRuntimePaths: [],
    lease: async () => () => calls.push('release'), run: async () => { calls.push('run'); return { details: { exit_code: 0 } }; } } };
}

test('FIFO admission bounds pending work and removes cancelled waiters', async () => {
  const queue = createPythonQueue(1, 2), release = await queue.acquire(), controller = new AbortController();
  const second = queue.acquire(controller.signal), third = queue.acquire();
  await assert.rejects(queue.acquire(), { code: 'PYTHON_QUEUE_FULL' });
  controller.abort(new Error('queued cancellation')); await assert.rejects(second, /queued cancellation/);
  release(); release(); const releaseThird = await third; releaseThird();
  const last = await queue.acquire(); last();
});

test('output batches bursts, decodes split Unicode, isolates observers, and caps retention', async () => {
  const updates = [], output = createPythonOutput(4096, item => { updates.push(item.content[0].text); return Promise.reject(new Error('observer')); });
  for (let i = 0; i < 1000; i++) output.write(Buffer.from('a'));
  const unicode = Buffer.from('中文'); output.write(unicode.subarray(0, 2)); output.write(unicode.subarray(2)); output.end();
  assert.equal(output.finish(), 'a'.repeat(1000) + '中文'); assert.equal(updates.length, 1);
  const bounded = createPythonOutput(11); assert.equal(bounded.write(Buffer.from('abcdef'), true), false);
  assert.equal(bounded.finish(), '[stderr] ab'); assert.equal(bounded.bytes, 11);
  const partial = createPythonOutput(4); partial.write(unicode); partial.end(); assert.equal(partial.finish(), '中');
  const malformed = createPythonOutput(10); malformed.write(Buffer.alloc(10, 255)); malformed.end();
  assert(Buffer.byteLength(malformed.finish()) <= 10); assert.equal(malformed.truncated, true);
  await new Promise(resolve => setImmediate(resolve));
});

test('domain allowlist validates labels and ports, normalizes and deduplicates', () => {
  assert.deepEqual(normalizePythonDomains([' EXAMPLE.com ', 'example.com', '*.example.com:443']), ['example.com', '*.example.com:443']);
  assert.deepEqual(normalizePythonDomains(['*', 'pypi.org']), ['*']);
  for (const value of ['a..b', '-example.com', 'a-.com', 'example.com:0', 'example.com:65536', 'http://example.com', 'a'.repeat(64) + '.com'])
    assert.throws(() => normalizePythonDomains([value]), /Invalid/);
  const policy = pythonPolicy({ workspace: '/work', readRoots: ['/work'], controlDirectory: '/control', outputDirectory: '/output', protectedRuntimePaths: ['/runtime'], allowWorkspaceWrite: true }, 'linux');
  assert(policy.filesystem.denyWrite.includes('/runtime')); assert(policy.filesystem.denyWrite.includes('/work'));
  const open = pythonPolicy({ workspace: '/work', readRoots: ['/work'], controlDirectory: '/control', outputDirectory: '/output', allowedDomains: ['*'] }, 'linux');
  assert.deepEqual(open.network.allowedDomains, []);
  assert.equal(pythonAllowsHost(['*'], 'pypi.org'), true);
  assert.equal(pythonAllowsHost(['*.example.com:443'], 'api.example.com', 443), true);
  assert.equal(pythonAllowsHost(['*.example.com:443'], 'api.example.com', 80), false);
  assert.equal(pythonAllowsHost([], 'pypi.org'), false);
});

test('open host setting keeps an empty sandbox allowlist and always-allow ask callback', async t => {
  const { request } = await fixture(t), { dependencies } = backendFixture();
  request.allowedDomains = ['*'];
  let ask;
  dependencies.backend.SandboxManager.initialize = async (policy, callback) => {
    assert.deepEqual(policy.network.allowedDomains, []);
    ask = callback;
  };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.error, undefined);
  assert.equal(typeof ask, 'function');
  assert.equal(await ask({ host: 'files.pythonhosted.org', port: 443 }), true);
});

test('private directory traversal respects cancellation and entry budget', async t => {
  const { directory, request } = await fixture(t);
  await assert.rejects(privatePythonPaths([request.workspace], directory, { maxEntries: 1 }), { code: 'PYTHON_POLICY_LIMIT' });
  await assert.rejects(privatePythonPaths([], directory, { signal: AbortSignal.abort(new Error('stop scan')) }), /stop scan/);
});

test('output cleanup preserves files and rejects redirected directories', async t => {
  const { directory, request } = await fixture(t);
  await preparePythonOutput(request); await writeFile(join(request.outputDirectory, 'keep.txt'), 'keep');
  assert.equal(await removeEmptyPythonOutput(request), false);
  assert.equal(await readFile(join(request.outputDirectory, 'keep.txt'), 'utf8'), 'keep');
  const other = join(directory, 'other'); await mkdir(other);
  const redirect = { ...request, cwd: join(request.workspace, 'redirect') };
  await symlink(other, redirect.cwd, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validatePythonPaths(redirect), { code: 'PYTHON_PATH_CHANGED' });
});

test('unavailable backend fails before creating any output directory', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture({ checkWindowsSandboxStatusAsync: async () => ({ user: {} }) });
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_SANDBOX_UNAVAILABLE'); assert.equal(result.outputDirectory, null);
  assert.deepEqual(await readdir(request.workspace), []); assert.deepEqual(calls, ['release']);
});

test('redirected sensitive paths fail before native grants and release the execution lease', async t => {
  const { directory, request } = await fixture(t), { calls, dependencies } = backendFixture();
  request.allowWorkspaceWrite = true;
  const target = join(directory, 'credentials'); await mkdir(target);
  await writeFile(join(target, 'config'), 'untouched');
  await symlink(target, join(request.workspace, '.ssh'), process.platform === 'win32' ? 'junction' : 'dir');
  dependencies.backend.grantWindowsAcl = () => calls.push('grant');
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_POLICY_PATH_REDIRECTED');
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.outputDirectory, null);
  assert.deepEqual(calls, ['release']);
  assert.equal(await readFile(join(target, 'config'), 'utf8'), 'untouched');
  assert.deepEqual(await readdir(join(request.workspace, '.ubovm-python-output')), []);
});

test('runner prepares output, streams once, and confirms cleanup before success', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture(), messages = [];
  dependencies.run = async (options, signal, update) => {
    assert.equal(options.captureOutput, false); update({ content: [{ text: 'once' }] });
    await writeFile(join(request.outputDirectory, 'result.txt'), 'ok'); return { details: { exit_code: 0 } };
  };
  const result = await executePythonRequest(request, new AbortController().signal, message => messages.push(message), dependencies);
  assert.equal(result.error, undefined); assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.outputDirectory, request.outputDirectory); assert.deepEqual(calls, ['initialize', 'revoke', 'restore', 'reset', 'release']);
  assert.equal(messages.filter(message => message.type === 'output').length, 1);
});

test('shared ACL holders cannot be reported as confirmed cleanup after a successful script', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture();
  dependencies.backend.revokeWindowsAcl = () => [{ status: 'stillHeld' }];
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.errorCode, 'PYTHON_CLEANUP_FAILED');
  assert.match(result.error, /stillHeld/);
  assert(calls.includes('restore')); assert(calls.includes('reset')); assert(calls.includes('release'));
});

test('generated source is staged privately and removed with its control directory', async t => {
  const { request } = await fixture(t), { dependencies } = backendFixture();
  let control, entrypoint;
  dependencies.backend.SandboxManager.initialize = async policy => {
    control = policy.filesystem.allowRead[1];
    const payload = JSON.parse(await readFile(join(control, 'request.json'), 'utf8'));
    entrypoint = payload.codeFile;
    assert.equal(payload.code, undefined);
    assert.equal(await readFile(entrypoint, 'utf8'), request.code);
    assert(contained(control, entrypoint));
    assert(!policy.filesystem.allowWrite.some(path => contained(path, entrypoint)));
  };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.error, undefined);
  await assert.rejects(readFile(entrypoint), { code: 'ENOENT' });
});

test('partial initialization is cleaned up and empty failed output removed', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture();
  dependencies.backend.SandboxManager.initialize = async () => { throw new Error('initialization failed'); };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.match(result.error, /initialization failed/); assert.equal(result.phase, 'preparing'); assert.equal(result.outputDirectory, null);
  assert.deepEqual(await readdir(join(request.workspace, '.ubovm-python-output')), []);
  assert.deepEqual(calls, ['revoke', 'restore', 'reset', 'release']);
});

test('ACL cleanup failure is surfaced even after Python succeeds', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture({ revokeWindowsAcl: () => [{ status: 'accessDenied' }] });
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_CLEANUP_FAILED'); assert.equal(result.cleanupConfirmed, false);
  assert(calls.includes('restore')); assert(calls.includes('reset')); assert(calls.includes('release'));
});

test('cancellation during initialization still resets the backend and releases the lease', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture(), controller = new AbortController();
  dependencies.backend.SandboxManager.initialize = async () => { controller.abort(new Error('cancel initialization')); };
  const result = await executePythonRequest(request, controller.signal, undefined, dependencies);
  assert.match(result.error, /cancel initialization/); assert.equal(result.outputDirectory, null);
  assert(!calls.includes('run')); assert.deepEqual(calls, ['revoke', 'restore', 'reset', 'release']);
});

test('script failure retains generated files and the original exit code', async t => {
  const { request } = await fixture(t), { dependencies } = backendFixture();
  dependencies.run = async () => {
    await writeFile(join(request.outputDirectory, 'partial.txt'), 'partial result');
    throw Object.assign(new Error('script failed'), { details: { exit_code: 7 } });
  };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.exitCode, 7); assert.equal(result.outputDirectory, request.outputDirectory);
  assert.equal(await readFile(join(request.outputDirectory, 'partial.txt'), 'utf8'), 'partial result');
});

test('interpreter/runtime overlap is rejected before creating output', async t => {
  const { request } = await fixture(t), { dependencies } = backendFixture();
  request.readRoots = [request.workspace];
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_UNSAFE_RUNTIME_LOCATION'); assert.deepEqual(await readdir(request.workspace), []);
});

test('host rejects duplicate result messages', async t => {
  const { directory, request } = await fixture(t), runner = join(directory, 'duplicate.mjs');
  await writeFile(runner, `process.once('message',()=>{const result={type:'result',exitCode:0,cleanupConfirmed:true};process.send(result);process.send(result,()=>process.disconnect());});`);
  await assert.rejects(runPythonSandbox(request, undefined, undefined, pathToFileURL(runner)), { code: 'PYTHON_PROTOCOL_ERROR' });
});

test('host enforces decoded output limit when a stream ends in partial UTF-8', async t => {
  const { directory, request } = await fixture(t), runner = join(directory, 'partial.mjs');
  await writeFile(runner, `process.once('message',()=>{process.stdout.write(Buffer.from([97,97,228]));process.send({type:'result',exitCode:0,cleanupConfirmed:true},()=>process.disconnect());});`);
  await assert.rejects(runPythonSandbox({ ...request, maxOutputBytes: 4 }, undefined, undefined, pathToFileURL(runner)),
    error => error.code === 'PYTHON_OUTPUT_LIMIT' && error.details.output_bytes <= 4);
});

test('host rejects unconfirmed cleanup and forcibly stops unresponsive runners', async t => {
  const { directory, request } = await fixture(t), runner = join(directory, 'runner.mjs');
  await writeFile(runner, `process.on('message',m=>{if(m.type!=='run')return;if(m.request.mode==='hang')return;process.send({type:'result',exitCode:0,cleanupConfirmed:false},()=>process.disconnect());});`);
  await assert.rejects(runPythonSandbox(request, undefined, undefined, pathToFileURL(runner)), { code: 'PYTHON_CLEANUP_FAILED' });
  await assert.rejects(runPythonSandbox({ ...request, mode: 'hang', timeout: 0.1 }, undefined, undefined, pathToFileURL(runner), { stopGraceMs: 50, closeGraceMs: 200 }),
    error => error.code === 'PYTHON_TIMEOUT' && error.details.forced_termination === true && error.details.cleanup_confirmed === false);
});

test('failed progress observers cannot interrupt sandbox cleanup', async t => {
  for (const asynchronous of [false, true]) {
    const { request } = await fixture(t), { calls, dependencies } = backendFixture();
    const result = await executePythonRequest(request, new AbortController().signal, () => {
      if (asynchronous) return Promise.reject(new Error('lost observer'));
      throw new Error('lost observer');
    }, dependencies);
    assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(calls, ['initialize', 'run', 'revoke', 'restore', 'reset', 'release']);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('cleanup failure preserves the script exit status', async t => {
  const { request } = await fixture(t), { dependencies } = backendFixture({ revokeWindowsAcl: () => undefined });
  dependencies.run = async () => { throw Object.assign(new Error('script failed'), { details: { exit_code: 7 } }); };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.exitCode, 7); assert.equal(result.errorCode, 'PYTHON_CLEANUP_FAILED');
  assert.match(result.error, /script failed/); assert.equal(result.cleanupConfirmed, false);
});

test('output directory substitution during initialization prevents execution', async t => {
  const { directory, request } = await fixture(t), { calls, dependencies } = backendFixture();
  const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep');
  dependencies.backend.SandboxManager.initialize = async () => {
    // Non-recursive removal of this fixture's known empty directory.
    const { rmdir } = await import('node:fs/promises'); await rmdir(request.outputDirectory);
    await symlink(outside, request.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_PATH_CHANGED'); assert(!calls.includes('run')); assert(calls.includes('reset'));
  assert.equal(result.outputDirectory, null);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('completion and premature IPC disconnect have their own bounded shutdown', async t => {
  const { directory, request } = await fixture(t), runner = join(directory, 'stuck.mjs');
  await writeFile(runner, `process.on('message',m=>{if(m.type!=='run')return;setInterval(()=>{},100);if(m.request.mode==='complete')process.send({type:'result',exitCode:0,cleanupConfirmed:true});else process.disconnect();});`);
  for (const mode of ['complete', 'disconnect']) {
    const started = performance.now();
    await assert.rejects(runPythonSandbox({ ...request, mode, timeout: 30 }, undefined, undefined, pathToFileURL(runner), { closeGraceMs: 100, stopGraceMs: 100 }),
      error => error.code === 'PYTHON_RUNNER_LOST' && error.details.cleanup_confirmed === false);
    assert(performance.now() - started < 5000, 'must settle before the 30-second execution deadline');
  }
});

test('malformed cleanup confirmation cannot be treated as truthy success', async t => {
  const { directory, request } = await fixture(t), runner = join(directory, 'malformed.mjs');
  await writeFile(runner, `process.once('message',()=>process.send({type:'result',exitCode:0,cleanupConfirmed:'true'},()=>process.disconnect()));`);
  await assert.rejects(runPythonSandbox(request, undefined, undefined, pathToFileURL(runner)), { code: 'PYTHON_PROTOCOL_ERROR' });
});

test('process shutdown uncertainty cannot become confirmed cleanup after ACL reset', async t => {
  const { request } = await fixture(t), { calls, dependencies } = backendFixture();
  dependencies.run = async () => { throw Object.assign(new Error('process would not close'), { details: { exit_code: null, process_closed: false } }); };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, dependencies);
  assert.equal(result.errorCode, 'PYTHON_PROCESS_CLEANUP_UNCONFIRMED'); assert.equal(result.cleanupConfirmed, false);
  assert(calls.includes('reset')); assert(calls.includes('release'));
});

test('repeated queued cancellation releases listeners and admission capacity', async () => {
  const queue = createPythonQueue(2, 64);
  for (let wave = 0; wave < 10; wave++) {
    const releases = [await queue.acquire(), await queue.acquire()];
    const controllers = Array.from({ length: 40 }, () => new AbortController());
    const pending = controllers.map(controller => queue.acquire(controller.signal).then(release => { release(); return 'ran'; },
      error => { assert(error instanceof Error); return 'cancelled'; }));
    controllers.forEach((controller, index) => { if (index % 2 === 0) controller.abort(null); });
    releases.forEach(release => release());
    const results = await Promise.all(pending);
    assert.equal(results.filter(result => result === 'cancelled').length, 20);
    assert.equal(results.filter(result => result === 'ran').length, 20);
    for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const release = await queue.acquire(); release();
});

test('non-Error cancellation reasons produce structured failures without spawning', async () => {
  for (const reason of [null, 'stop', { cancelled: true }]) {
    await assert.rejects(runPythonSandbox({ timeout: 30 }, AbortSignal.abort(reason)),
      error => error instanceof Error && error.code === 'PYTHON_CANCELLED' && error.details.phase === 'queued');
  }
});
