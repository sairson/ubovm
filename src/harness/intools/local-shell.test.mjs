import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalShellTool } from './local-shell.mjs';
import { createInternalTools } from './index.mjs';
import { createSkillScriptTool } from './skill-script-command.mjs';

const win = process.platform === 'win32';
const input = command => ({ command, purpose: 'code', reason: 'Verify local execution for project tests' });
const wait = win ? 'Start-Sleep -Seconds 30' : 'sleep 30';

test('executes in configured cwd with unicode output and streams results', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ubovm-shell-'));
  try {
    const updates = [];
    const result = await createLocalShellTool({ cwd }).execute('ok', input(win ? "Write-Output '代码'; (Get-Location).Path" : "printf '代码\n'; pwd"), undefined, update => updates.push(update));
    assert.equal(result.details.exit_code, 0);
    assert.equal(result.details.cwd, await realpath(cwd));
    assert.match(result.content[0].text, /代码/);
    assert.ok(result.content[0].text.includes(await realpath(cwd)));
    assert.ok(updates.length);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('rejects unsupported purposes and missing reasons before execution', async () => {
  const tool = createLocalShellTool();
  for (const purpose of [undefined, 'browsing', 'office']) await assert.rejects(tool.execute('invalid', { ...input('exit 0'), purpose }), /restricted/);
  await assert.rejects(tool.execute('invalid', { ...input('exit 0'), reason: '' }), /reason/);
  const result = await tool.execute('env', { ...input('exit 0'), purpose: 'environment_setup' });
  assert.equal(result.details.purpose, 'environment_setup');
});

test('reports nonzero exit and PowerShell errors with retained output', async () => {
  await assert.rejects(createLocalShellTool().execute('fail', input(win ? "Write-Output 'before'; exit 7" : "echo before; exit 7")), error => error.details.exit_code === 7 && /before/.test(error.message));
  if (win) await assert.rejects(createLocalShellTool().execute('fail', input("Write-Error 'failed-operation'")), /failed-operation/);
});

test('timeout, output limit, and cancellation terminate pending calls', async () => {
  await assert.rejects(createLocalShellTool({ defaultTimeoutSeconds: 1 }).execute('timeout', input(wait)), /timed out/);
  await assert.rejects(createLocalShellTool({ maxOutputBytes: 16 }).execute('limit', input(win ? "Write-Output ('x' * 1000)" : "printf '%01000d' 0")), /output exceeds/);
  const controller = new AbortController();
  const reason = Object.freeze(new Error('cancel shell'));
  const pending = createLocalShellTool().execute('cancel', input(wait), controller.signal);
  const timer = setTimeout(() => controller.abort(reason), 300);
  try { await assert.rejects(pending, /cancel shell/); } finally { clearTimeout(timer); }
  assert.equal(reason.message, 'cancel shell');
  await assert.rejects(createLocalShellTool().execute('pre-abort', input('exit 0'), controller.signal), /cancel shell/);
});

test('runtime registration, opt-out, and close cancel active shell commands', async () => {
  const runtime = await createInternalTools({ sessionId: 'local-shell-test', allowedTools: ['run_local_shell_command'] });
  const [tool] = await runtime.forWorker('worker');
  assert.equal(tool.name, 'run_local_shell_command');
  const pending = tool.execute('close', input(wait));
  const rejected = assert.rejects(pending, /closed/);
  await new Promise(resolve => setTimeout(resolve, 300));
  await runtime.close();
  await rejected;
  const disabled = await createInternalTools({ sessionId: 'disabled', allowedTools: ['run_local_shell_command'], localShell: false });
  try { assert.deepEqual(await disabled.forWorker('worker'), []); } finally { await disabled.close(); }
});

test('shared process runner preserves skill script execution', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-skill-')));
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(join(cwd, 'scripts'));
    const path = join(cwd, 'scripts', 'check.js');
    await writeFile(path, "console.log('skill-ok')");
    const registry = { names: () => ['test'], resolve: async () => ({ directory: cwd, path: await realpath(path) }) };
    const result = await createSkillScriptTool({ registry }).execute('skill', { skill: 'test', script: 'scripts/check.js' });
    assert.match(result.content[0].text, /skill-ok/);
    assert.equal(result.details.exit_code, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
