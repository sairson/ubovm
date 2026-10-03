import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalShellTool } from '../index.mjs';
import { createInternalTools } from '../../../index.mjs';

const win = process.platform === 'win32';
const input = command => ({ command, session: 'test', purpose: 'code', reason: 'Test persistent shells' });

test('standalone tool close cancels active isolated commands and returns after process cleanup', async () => {
  const tool = createLocalShellTool();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = tool.execute('single', { ...input(win ? "Write-Output 'ready'; Start-Sleep -Seconds 60" : 'echo ready; sleep 60'), session: undefined }, undefined,
    update => { if (update.content[0].text.includes('ready')) started(); });
  const rejected = assert.rejects(pending, error => /closed/.test(error.message) && error.details.process_closed === true);
  try { await ready; await tool.close(); await rejected; }
  finally { await tool.close(); }
});

test('invalid cwd does not poison a new session or discard existing variables', async t => {
  const tool = createLocalShellTool(); t.after(() => tool.close());
  const invalid = { ...input('echo never-run'), cwd: 'ubovm-nonexistent-cwd-test' };
  await assert.rejects(tool.execute('bad', invalid), /ENOENT/);
  await tool.execute('set', input(win ? "$saved='retained'" : 'saved=retained'));
  await assert.rejects(tool.execute('bad-again', invalid), /ENOENT/);
  assert.match((await tool.execute('read', input(win ? 'Write-Output $saved' : 'echo "$saved"'))).content[0].text, /retained/);
});

test('named local shell preserves variables, environment and cwd with clean streamed Unicode output', async t => {
  const tool = createLocalShellTool(); t.after(() => tool.close());
  const updates = [];
  const run = command => tool.execute('test', input(command), undefined, result => updates.push(result.content[0].text));
  await run(win ? "$saved='代码'; $env:UBOVM_TEST='kept'; Set-Location .." : "saved='代码'; export UBOVM_TEST=kept; cd ..");
  const result = await run(win ? "Write-Output $saved; Write-Output $env:UBOVM_TEST; (Get-Location).Path" : 'printf "%s\\n%s\\n" "$saved" "$UBOVM_TEST"; pwd');
  assert.match(result.content[0].text, /代码/);
  assert.match(result.content[0].text, /kept/);
  assert.doesNotMatch(result.content[0].text, /ubovm_|\x1e|\x1f/);
  assert.equal(updates.join(''), result.content[0].text);
  assert.equal(result.details.exit_code, 0);
});

test('same-session calls serialize and command failures retain the shell', async t => {
  const tool = createLocalShellTool(); t.after(() => tool.close());
  const first = tool.execute('first', input(win ? "Start-Sleep -Milliseconds 150; $saved='ordered'" : 'sleep 0.15; saved=ordered'));
  const second = tool.execute('second', input(win ? 'Write-Output $saved' : 'echo "$saved"'));
  await first;
  assert.match((await second).content[0].text, /ordered/);
  await assert.rejects(tool.execute('fail', input(win ? "Write-Error 'expected-failure'" : 'false')), error => error.details.exit_code === 1);
  assert.match((await tool.execute('after', input(win ? 'Write-Output $saved' : 'echo "$saved"'))).content[0].text, /ordered/);
});

test('timeout invalidates a session and the next call soft-resets it', async t => {
  const tool = createLocalShellTool(); t.after(() => tool.close());
  await assert.rejects(tool.execute('timeout', { ...input(win ? "Write-Output 'before-timeout'; Start-Sleep -Seconds 30" : 'echo before-timeout; sleep 30'), timeout_seconds: 2 }), /before-timeout/);
  const recovered = await tool.execute('lost', input(win ? 'Write-Output after' : 'echo after'));
  assert.match(recovered.content[0].text, /after/);
  assert.equal(recovered.details.session_auto_reset, true);
  const result = await tool.execute('reset', { ...input(win ? 'Write-Output fresh' : 'echo fresh'), reset_session: true });
  assert.match(result.content[0].text, /fresh/);
});

test('runtime isolates named shells per worker and closes idle sessions', async () => {
  const runtime = await createInternalTools({ sessionId: 'persistent', allowedTools: ['run_local_shell_command'] });
  try {
    const [a] = await runtime.forWorker('a'), [b] = await runtime.forWorker('b');
    await a.execute('a', input(win ? "$saved='worker-a'" : 'saved=worker-a'));
    const result = await b.execute('b', input(win ? "Write-Output ('value:' + $saved)" : 'echo "value:$saved"'));
    assert.doesNotMatch(result.content[0].text, /worker-a/);
  } finally { await runtime.close(); }
});

test('closing during local cwd validation cannot create a late session', async () => {
  const tool = createLocalShellTool();
  const pending = tool.execute('late', input('echo never-run'));
  await tool.close();
  await assert.rejects(pending, /closed/);
});

test('persistent local output limits lose the session and soft-reset on reuse', async t => {
  const tool = createLocalShellTool({ maxOutputBytes: 32 }); t.after(() => tool.close());
  await assert.rejects(tool.execute('limit', input(win ? "Write-Output ('x' * 100)" : "printf '%0100d' 0")), error => /output exceeds/.test(error.message) && error.details.session_lost);
  const recovered = await tool.execute('lost', input(win ? 'Write-Output next' : 'echo next'));
  assert.match(recovered.content[0].text, /next/);
  assert.equal(recovered.details.session_auto_reset, true);
});
