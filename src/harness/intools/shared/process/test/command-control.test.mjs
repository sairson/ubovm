import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalTools } from '../../../index.mjs';
import { controlledCommand } from '../command-control.mjs';

test('npm run dev style commands auto-retain when the host enables retainBackground', async () => {
  let control;
  const register = value => { control = value; };
  register.retainBackground = true;
  const lifetime = new AbortController();
  const tool = controlledCommand({ name: 'run_linux_ssh_command',
    close() {},
    execute(_id, _args, signal) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }, 'worker', register);
  const call = tool.execute('dev', { command: 'npm run dev' }, lifetime.signal);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await call).details.background, true);
  assert.equal(control.retained, true);
  lifetime.abort();
  await tool.close();
  assert.equal(control.interrupt(), true);
  await control.done().catch(() => {});
});

test('retain:false disables heuristic auto-retain', async () => {
  let control, complete;
  const register = value => { control = value; };
  register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command',
    execute() { return new Promise(resolve => { complete = resolve; }); }
  }, 'worker', register);
  const call = tool.execute('build', { command: 'npm run dev', retain: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(control.retained, false);
  complete({ content: [{ type: 'text', text: 'done' }] });
  assert.equal((await call).details?.background, undefined);
  await tool.close();
});

for (const session of [undefined, 'server']) test(`real resident HTTP server survives runtime close, timeout and log limits (${session ?? 'isolated'})`, { timeout: 15000 }, async t => {
  let control, port, pid, output = '';
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const observe = update => {
    output += update.output ?? update.content?.[0]?.text ?? '';
    const match = output.match(/READY=(\d+):(\d+)/);
    if (match && !port) { port = Number(match[1]); pid = Number(match[2]); readyResolve(); }
  };
  const register = value => { control = value; value.subscribe(observe); };
  register.retainBackground = true;
  const runtime = await createInternalTools({ sessionId: 'resident-server', allowedTools: ['run_local_shell_command'],
    localShell: { defaultTimeoutSeconds: 2, maxOutputBytes: 256 }, onCommand: register });
  t.after(async () => { control?.interrupt(); await control?.done(); await runtime.close(); });
  const [tool] = await runtime.forWorker('server');
  const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'")}'`;
  const code = "const http=require('node:http');const s=http.createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>{console.log('READY='+s.address().port+':'+process.pid);setTimeout(()=>setInterval(()=>console.log('log '.repeat(100)),20),200)});";
  const call = tool.execute('server', { command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}`,
    ...(session ? { session } : {}), purpose: 'code', reason: 'Verify resident server lifetime' }, undefined, observe);
  await Promise.resolve();
  assert.equal(control.background(), true);
  assert.equal((await call).details.background, true);
  await runtime.close();
  await ready;
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })).text(), 'alive');
  assert.equal(control.interrupt(), true);
  await control.done();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

for (const name of ['run_local_shell_command', 'run_linux_ssh_command']) {
  test(`host-owned ${name} background command survives run cancellation and tool cleanup`, async () => {
    let control, commandSignal, disposed = false;
    const register = value => { control = value; };
    register.retainBackground = true;
    const lifetime = new AbortController();
    const tool = controlledCommand({ name,
      close() { disposed = true; },
      execute(id, args, signal) {
        commandSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    }, 'worker', register);
    const call = tool.execute('resident', {}, lifetime.signal);
    await Promise.resolve();
    control.background(); await call;
    lifetime.abort(); await tool.close();
    assert.equal(commandSignal.aborted, false);
    assert.equal(disposed, false);
    assert.equal(control.interrupt(), true);
    await control.done();
    assert.equal(disposed, true);
  });
}

test('command completion waits only for that command and broken observers do not kill siblings', async () => {
  const controls = [], completions = [], register = value => {
    controls.push(value); value.subscribe(() => { throw new Error('observer failed'); });
    return () => { throw new Error('release failed'); };
  };
  register.retainBackground = true;
  let disposed = 0;
  const tool = controlledCommand({ name: 'run_local_shell_command', close() { disposed++; },
    execute() { return new Promise(resolve => completions.push(resolve)); }
  }, 'worker', register);
  for (let i = 0; i < 2; i++) {
    const call = tool.execute(String(i), {}); await Promise.resolve();
    assert.equal(controls[i].background(), true); await call;
  }
  await tool.close();
  completions[0]({ content: [{ type: 'text', text: 'one' }] });
  await controls[0].done();
  assert.equal(disposed, 0);
  completions[1]({ content: [{ type: 'text', text: 'two' }] });
  await controls[1].done();
  assert.equal(disposed, 1);
  await assert.rejects(tool.execute('late', {}), /closed/);
});

test('a command already stopping cannot be falsely reported as resident', async () => {
  let control, complete;
  const register = value => { control = value; }; register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command',
    execute(id, args, signal, update, lifecycle) {
      lifecycle.stopping();
      return new Promise(resolve => { complete = resolve; });
    }
  }, 'worker', register);
  const call = tool.execute('stopping', {}); await Promise.resolve();
  assert.equal(control.background(), false);
  complete({ content: [{ type: 'text', text: 'done' }] });
  assert.equal((await call).details?.background, undefined);
  await tool.close();
});

test('terminal observers cannot re-background or interrupt an already completed command', async () => {
  let control, complete, terminalActions;
  const register = value => { control = value; value.subscribe(update => {
    if (update.status === 'completed') {
      terminalActions = [control.background(), control.interrupt()];
    }
  }); }; register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command', execute() {
    return new Promise(resolve => { complete = resolve; });
  } }, 'worker', register);
  const call = tool.execute('finish', {}); await Promise.resolve();
  control.background(); await call;
  complete({ content: [] }); await control.done(); await tool.close();
  assert.deepEqual(terminalActions, [false, false]);
});

test('unconfirmed process cleanup remains a failure for both task status and host shutdown', async () => {
  let control, rejectCommand;
  const updates = [], register = value => { control = value; value.subscribe(update => updates.push(update)); };
  register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command', execute() {
    return new Promise((resolve, reject) => { rejectCommand = reject; });
  } }, 'worker', register);
  const call = tool.execute('uncertain', {}); await Promise.resolve();
  control.background(); await call;
  rejectCommand(Object.assign(new Error('stop requested'), { code: 'COMMAND_INTERRUPTED', details: { process_closed: false } }));
  await assert.rejects(control.done(), { code: 'COMMAND_CLEANUP_UNCONFIRMED' });
  assert.equal(updates.at(-1).status, 'failed');
  assert.match(updates.at(-1).output, /清理未确认/);
  await tool.close();
});

test('resident progress keeps queue state and reports stopping before process cleanup settles', async () => {
  let control, emit, lifecycle, complete;
  const updates = [], register = value => { control = value; value.subscribe(update => updates.push(update)); };
  register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command', execute(id, args, signal, update, state) {
    emit = update; lifecycle = state;
    return new Promise(resolve => { complete = resolve; });
  } }, 'worker', register);
  const call = tool.execute('queue', {}); await Promise.resolve();
  emit({ content: [], details: { execution_state: 'queued' } });
  control.background(); await call;
  emit({ content: [{ type: 'text', text: 'waiting' }] });
  assert.equal(updates.at(-1).executionState, 'queued');
  lifecycle.stopping();
  assert.equal(updates.at(-1).executionState, 'stopping');
  complete({ content: [] }); await control.done(); await tool.close();
});

test('deferred shell disposal failures propagate to the host completion barrier', async () => {
  let control, complete;
  const closeError = new Error('shell disposal failed');
  const register = value => { control = value; }; register.retainBackground = true;
  const tool = controlledCommand({ name: 'run_local_shell_command', close() { throw closeError; }, execute() {
    return new Promise(resolve => { complete = resolve; });
  } }, 'worker', register);
  const call = tool.execute('dispose', {}); await Promise.resolve();
  control.background(); await call; await tool.close();
  complete({ content: [] });
  await assert.rejects(control.done(), error => error === closeError);
});

test('putting a command aside releases the caller and keeps output and interruption alive', async () => {
  let control, complete, emit;
  const snapshots = [];
  const tool = controlledCommand({ name: 'run_local_shell_command', execute(id, args, signal, update) {
    emit = update;
    return new Promise((resolve, reject) => {
      complete = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } }, 'worker', value => { control = value; value.subscribe(update => snapshots.push(update)); });
  const call = tool.execute('test', {});
  await Promise.resolve();
  emit({ content: [{ type: 'text', text: 'before\n' }] });
  assert.equal(control.background(), true);
  assert.equal(control.background(), false);
  assert.equal((await call).details.background, true);
  emit({ content: [{ type: 'text', text: 'after\n' }] });
  assert.match(snapshots.at(-1).output, /before\nafter/);
  complete({ content: [{ type: 'text', text: 'final output' }] });
  await tool.close();
  assert.equal(snapshots.at(-1).status, 'completed');
  assert.equal(control.interrupt(), false);

  const second = tool.execute('second', {});
  await Promise.resolve();
  control.background();
  await second;
  assert.equal(control.interrupt(), true);
  await tool.close();
  assert.equal(snapshots.at(-1).status, 'interrupted');
});

test('manual interruption terminates a native child process before reporting local cleanup', async t => {
  let control, childPid;
  const runtime = await createInternalTools({ sessionId: 'manual-child', allowedTools: ['run_local_shell_command'], onCommand: value => { control = value; } });
  t.after(() => runtime.close());
  const [tool] = await runtime.forWorker('a');
  const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
  const code = "console.log('CHILD_PID=' + process.pid); setInterval(() => {}, 1000)";
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}`;
  let output = '';
  await assert.rejects(tool.execute('child', { command, session: 'test', purpose: 'code', reason: 'Verify process tree cleanup' }, undefined, update => {
    output += update.content[0].text;
    const match = output.match(/CHILD_PID=(\d+)/);
    if (match && !childPid) { childPid = Number(match[1]); control.interrupt(); }
  }), error => error.code === 'COMMAND_INTERRUPTED' && error.details.process_closed === true);
  assert(childPid);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('user interruption stops a live persistent command, retains output and leaves sibling workers usable', async t => {
  const controls = new Map(), updates = [];
  const runtime = await createInternalTools({ sessionId: 'manual-interrupt', allowedTools: ['run_local_shell_command'],
    onCommand: control => { controls.set(control.id, control); return () => controls.delete(control.id); } });
  t.after(() => runtime.close());
  const [tool] = await runtime.forWorker('a'), [other] = await runtime.forWorker('b');
  const args = { session: 'build', purpose: 'code', reason: 'Verify manual interruption', command: process.platform === 'win32' ? "Write-Output 'before-stop'; Start-Sleep -Seconds 90" : 'echo before-stop; sleep 90' };
  let selected;
  const start = Date.now();
  await assert.rejects(tool.execute('command', args, undefined, update => {
    updates.push(update.content[0].text);
    if (update.details?.command_id) selected = controls.get(update.details.command_id);
    if (updates.join('').includes('before-stop')) { assert.equal(selected.interrupt(), true); assert.equal(selected.interrupt(), false); }
  }), error => error.code === 'COMMAND_INTERRUPTED' && /before-stop/.test(error.message));
  assert(Date.now() - start < 10000);
  assert.equal(controls.size, 0);
  assert.equal(selected.interrupt(), false);
  const result = await other.execute('sibling', { ...args, command: 'echo sibling-alive' });
  assert.match(result.content[0].text, /sibling-alive/);
  assert.equal(controls.size, 0);
});
