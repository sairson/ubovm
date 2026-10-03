import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalProcess } from '../local-process.mjs';
import { createLocalShellTool } from '../../../terminals/local-shell/index.mjs';
import { createSkillScriptTool, localSkillInterpreter, resolveSkillInterpreter } from '../../../skills/scripts.mjs';
import { resolvePython } from '../../../terminals/python/policy.mjs';

test('local tool defaults adapt to a host timeout ceiling below 120 seconds', () => {
  assert.doesNotThrow(() => createLocalShellTool({ maxTimeoutSeconds: 5 }));
  assert.doesNotThrow(() => createSkillScriptTool({ maxTimeoutSeconds: 5 }));
  assert.throws(() => createLocalShellTool({ maxTimeoutSeconds: 5, defaultTimeoutSeconds: 6 }), /defaultTimeoutSeconds/);
  assert.throws(() => createSkillScriptTool({ maxTimeoutSeconds: 5, defaultTimeoutSeconds: 6 }), /defaultTimeoutSeconds/);
});

test('skill scripts support explicit Node ESM and CommonJS extensions', () => {
  for (const path of ['script.js', 'script.mjs', 'script.cjs', 'script.MJS']) assert.deepEqual(localSkillInterpreter(path), [process.execPath, []]);
});

test('skill Python scripts resolve the bundled or host interpreter', async t => {
  let python;
  try { python = await resolvePython(); } catch { t.skip('CPython not installed'); return; }
  assert.deepEqual(await resolveSkillInterpreter('scripts/probe.py'), [python.executable, []]);
  assert.deepEqual(await resolveSkillInterpreter('scripts/run.mjs'), [process.execPath, []]);
});

test('streamed unicode survives split bytes and interleaved stderr', async () => {
  const updates = [];
  const script = `const b = Buffer.from('代码');
    process.stdout.write(b.subarray(0, 1));
    setTimeout(() => { process.stderr.write('warning'); setTimeout(() => process.stdout.write(b.subarray(1)), 80); }, 80);`;
  const result = await runLocalProcess({ executable: process.execPath, args: ['-e', script], cwd: process.cwd(),
    env: process.env, timeout: 5, maxOutputBytes: 1024, label: 'Test process' }, undefined, update => updates.push(update.content[0].text));
  assert.match(result.content[0].text, /代码/);
  assert.match(result.content[0].text, /\[stderr\] warning/);
  assert.equal(updates.join(''), result.content[0].text);
  assert.ok(!updates.join('').includes('\ufffd'));
});

test('output limits do not emit a partial UTF-8 character', async () => {
  await assert.rejects(runLocalProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('代码')"],
    cwd: process.cwd(), env: process.env, timeout: 5, maxOutputBytes: 4, label: 'Test process' }), error => {
    assert.match(error.message, /output exceeds 4 bytes/);
    assert.match(error.message, /代/);
    assert.ok(!error.message.includes('\ufffd'));
    return true;
  });
});

test('stream-only execution does not duplicate output into errors', async () => {
  const updates = [];
  await assert.rejects(runLocalProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('unique-output');process.exitCode=7"],
    cwd: process.cwd(), env: process.env, timeout: 5, maxOutputBytes: 1024, label: 'Stream only', captureOutput: false }, undefined,
  update => updates.push(update.content[0].text)), error => error.details.exit_code === 7 && !error.message.includes('unique-output'));
  assert.equal(updates.join(''), 'unique-output');
});

test('failed output observers do not interrupt execution or leak unhandled rejections', async () => {
  for (const asynchronous of [false, true]) {
    let updates = 0;
    const result = await runLocalProcess({ executable: process.execPath,
      args: ['-e', "process.stdout.write('first'); setTimeout(() => process.stdout.write('last'), 40)"],
      cwd: process.cwd(), env: process.env, timeout: 5, maxOutputBytes: 1024, label: 'Observer test' }, undefined, () => {
        updates++;
        if (asynchronous) return Promise.reject(new Error('observer failed'));
        throw new Error('observer failed');
      });
    assert.equal(result.content[0].text, 'firstlast');
    assert.equal(result.details.exit_code, 0);
    assert(updates > 0);
    await new Promise(resolve => setImmediate(resolve));
  }
});
