import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { PersistentShell } from '../persistent-shell.mjs';
import { terminateProcessTree } from '../process-tree.mjs';
import { EventEmitter } from 'node:events';

test('hostile persistent transport errors settle after cleanup without unhandled rejections', async () => {
  const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
  let closes = 0;
  const shell = new PersistentShell(async () => ({ events, stdout, stderr, write() {}, close() { closes++; } }));
  const pending = shell.execute('test', { timeout: 5, maxOutputBytes: 32 });
  const observed = assert.rejects(pending, /Operation failed/);
  await new Promise(resolve => setImmediate(resolve));
  events.emit('error', new Proxy({}, { get() { throw Error('unreadable transport error'); } }));
  await observed;
  await shell.close();
  assert.equal(closes, 1);
  assert.equal(stdout.listenerCount('data'), 0);
});

test('falsy persistent transport errors cannot report successful command completion', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    const shell = new PersistentShell(async () => ({ events, stdout, stderr, write() {}, close() {} }));
    const pending = shell.execute('test', { timeout: 5, maxOutputBytes: 32 });
    const observed = assert.rejects(pending, error => error.details.session_lost === true);
    await new Promise(resolve => setImmediate(resolve));
    events.emit('error', reason);
    await observed;
    await shell.close();
  }
});

test('a failing stopping observer cannot strand persistent output-limit cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0, closes = 0, opens = 0;
  let firstStdout;
  const shell = new PersistentShell(async () => {
    opens++;
    const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    if (opens === 1) firstStdout = stdout;
    return { events, stdout, stderr, write(script) {
      writes++;
      if (opens > 1) {
        const token = script.match(/(ubovm_[a-f0-9]+)=\$\?/)[1];
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
          stderr.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
        });
      }
    }, close() { closes++; } };
  });
  t.after(() => { void shell.close(); });
  const lifecycle = { subscribe() { return () => {}; }, stopping() { throw Error('broken stopping observer'); } };
  const pending = shell.execute('test', { timeout: 5, maxOutputBytes: 32, lifecycle });
  const observed = assert.rejects(pending, /output exceeds 32 bytes/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.doesNotThrow(() => firstStdout.emit('data', Buffer.alloc(64, 'x')));
  await observed;
  assert.equal(closes, 1);
  assert.equal(firstStdout.listenerCount('data'), 0);
  const recovered = await shell.execute('test', { timeout: 5, maxOutputBytes: 32 });
  assert.equal(recovered.details.session_auto_reset, true);
  assert.equal(opens, 2);
});

test('repeated shell resets detach transport lifecycle listeners', async () => {
  const retired = [];
  const shell = new PersistentShell(async () => {
    const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    retired.push(events);
    return { events, stdout, stderr, close() {}, write(script) {
      const token = script.match(/(ubovm_[a-f0-9]+)=\$\?/)[1];
      stdout.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
      stderr.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
    } };
  });
  try {
    for (let i = 0; i < 50; i++) await shell.execute('true', { timeout: 5, maxOutputBytes: 100, reset: i > 0 });
  } finally { await shell.close(); }
  for (const events of retired) {
    assert.equal(events.listenerCount('close'), 0, 'retired transport still retains the shell close closure');
    assert.equal(events.listenerCount('error'), 1, 'retain only a safe late-error sink');
    assert.equal(events.listeners('error')[0], retired[0].listeners('error')[0], 'late-error sink must not capture each shell');
    assert.doesNotThrow(() => events.emit('error', Error('late transport error')));
  }
});

test('a failing stopping observer cannot defeat active persistent cancellation', async () => {
  const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
  let closes = 0;
  const shell = new PersistentShell(async () => ({ events, stdout, stderr, write() {}, close() { closes++; } }));
  const controller = new AbortController();
  const lifecycle = { subscribe() { return () => {}; }, stopping() { throw Error('observer failure'); } };
  const pending = shell.execute('test', { timeout: 5, maxOutputBytes: 32, lifecycle }, controller.signal);
  const observed = assert.rejects(pending, /requested cancellation/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(Error('requested cancellation'));
  await observed;
  await shell.close();
  assert.equal(closes, 1);
  assert.equal(stdout.listenerCount('data'), 0);
  assert.equal(stderr.listenerCount('data'), 0);
});

test('lifecycle subscription failures release the command deadline', async t => {
  const timers = new Set();
  const schedule = globalThis.setTimeout, clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args); timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return clear(timer); });
  t.after(() => { for (const timer of timers) clear(timer); });
  for (const where of ['subscribe', 'unsubscribe']) {
    const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    const shell = new PersistentShell(async () => ({ events, stdout, stderr, close() {}, write(script) {
      const token = script.match(/(ubovm_[a-f0-9]+)=\$\?/)[1];
      stdout.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
      stderr.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
    } }));
    const lifecycle = { subscribe() {
      if (where === 'subscribe') throw Error('subscribe failure');
      return () => { throw Error('unsubscribe failure'); };
    } };
    await assert.rejects(shell.execute('true', { timeout: 5, maxOutputBytes: 100, lifecycle }), new RegExp(where + ' failure'));
    assert.equal(timers.size, 0, `${where} failure retained its deadline`);
    await shell.close();
  }
});

test('directory preparation preserves admission order and can be cancelled without opening a shell', async () => {
  let prepared, release;
  const shell = new PersistentShell(() => assert.fail('cancelled preparation opened a shell'));
  const controller = new AbortController();
  const first = shell.execute('never-run', { timeout: 5, maxOutputBytes: 100,
    prepare: () => { prepared = true; return new Promise(resolve => { release = resolve; }); } }, controller.signal);
  const phases = [];
  const secondController = new AbortController();
  const second = shell.execute('also-never-run', { timeout: 5, maxOutputBytes: 100 }, secondController.signal, update => phases.push(update.details.execution_state));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared, true); assert.deepEqual(phases, ['queued']);
  secondController.abort(new Error('cancel waiting')); await assert.rejects(second, /cancel waiting/);
  controller.abort(new Error('cancel preparation')); await assert.rejects(first, /cancel preparation/);
  release({}); await shell.close();
});

test('cancelling from the running-state update prevents command submission', async () => {
  const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
  const shell = new PersistentShell(async () => ({ events, stdout, stderr, close() {}, write() { assert.fail('cancelled command submitted'); } }));
  const controller = new AbortController();
  await assert.rejects(shell.execute('never-run', { timeout: 5, maxOutputBytes: 100 }, controller.signal,
    update => { if (update.details.execution_state === 'running') controller.abort(new Error('stop before write')); }), /stop before write/);
  await shell.close();
});

test('conflicting stdout and stderr completion frames invalidate the shell', async () => {
  let opens = 0;
  const shell = new PersistentShell(async () => {
    opens++;
    const events = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    return { events, stdout, stderr, close() {}, write(script) {
      const token = script.match(/(ubovm_[a-f0-9]+)=\$\?/)[1];
      if (opens === 1) {
        stdout.emit('data', Buffer.from(`output\x1e${token}:0\x1f`));
        stderr.emit('data', Buffer.from(`\x1e${token}:1\x1f`));
      } else {
        stdout.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
        stderr.emit('data', Buffer.from(`\x1e${token}:0\x1f`));
      }
    } };
  });
  await assert.rejects(shell.execute('test', { timeout: 5, maxOutputBytes: 100 }), error => /frames disagree/.test(error.message) && error.details.session_lost);
  const recovered = await shell.execute('test', { timeout: 5, maxOutputBytes: 100 });
  assert.equal(recovered.details.session_auto_reset, true);
  assert.equal(opens, 2);
  await shell.close();
});

test('an unresponsive shell opener cannot defeat cancellation and a late transport is disposed', async () => {
  let provide, disposed = false;
  const shell = new PersistentShell(() => new Promise(resolve => { provide = resolve; }));
  const controller = new AbortController();
  const pending = shell.execute('never-run', { timeout: 10, maxOutputBytes: 100 }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('manual stop during startup'));
  await assert.rejects(pending, /manual stop/);
  await shell.close();
  provide({ close: () => { disposed = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
});

test('real Bash retains state, handles multiline quoting, failures, explicit cwd and shell exit', async t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  try { await access(bash); } catch { t.skip('Bash is not installed'); return; }
  const shell = new PersistentShell(async () => {
    const child = spawn(bash, ['--noprofile', '--norc', '-s'], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => {});
    child.stdin.on('error', error => child.emit('error', error));
    return { stdout: child.stdout, stderr: child.stderr, events: child, write: script => child.stdin.write(script),
      close() { terminateProcessTree(child); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); } };
  });
  t.after(() => shell.close());
  const run = (command, options = {}) => shell.execute(command, { timeout: 5, maxOutputBytes: 10000, ...options });
  await run("saved='代码'; export UBOVM_STATE=kept; cd /; helper() { printf '%s' \"$saved\"; }");
  const result = await run("helper; printf '\\n%s\\n' \"$UBOVM_STATE\"; pwd; cat <<'EOF'\nquote ' and \" and $literal\nEOF");
  assert.equal(result.content[0].text.replaceAll('\r', ''), '代码\nkept\n/\nquote \' and " and $literal\n');
  await assert.rejects(run('printf failure >&2; false'), error => error.details.exit_code === 1 && /failure/.test(error.message));
  assert.equal((await run('helper')).content[0].text, '代码');
  assert.match((await run('pwd', { cwd: '/tmp' })).content[0].text, /\/tmp/);
  await assert.rejects(run('printf goodbye; exit 0'), /goodbye/);
  assert.equal((await run('true')).details.session_auto_reset, true);
  assert.equal((await run('printf fresh', { reset: true })).content[0].text, 'fresh');
});
