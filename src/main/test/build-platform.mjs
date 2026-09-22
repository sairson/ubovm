import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCommand } from '../../../build.mjs';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: forwards workspace paths without shell interpolation`, () => {
    const workspace = '/workspace/中文 and spaces/$(touch nope); & project';
    const plan = buildCommand({ platform, args: ['start', workspace], env: { KEEP: 'value', UBOVM_SOURCE_SMOKE: '1' } });
    assert.equal(plan.command, platform === 'win32' ? 'powershell.exe' : 'pwsh');
    assert.equal(plan.env.UBOVM_ARGUMENT, workspace);
    assert.equal(plan.env.KEEP, 'value');
    assert.equal(plan.env.UBOVM_SOURCE_SMOKE, '');
    assert(!plan.args.includes(workspace));
    assert.equal(plan.args.includes('-ExecutionPolicy'), platform === 'win32');
  });
}

test('rejects unsupported platforms and extra arguments', () => {
  assert.throws(() => buildCommand({ platform: 'freebsd', args: [] }), /Unsupported/);
  assert.throws(() => buildCommand({ args: ['start', 'one', 'two'] }), /Usage/);
  assert.equal(buildCommand({ args: [], env: { UBOVM_ARGUMENT: 'stale' } }).env.UBOVM_ARGUMENT, '');
});

test('shared PowerShell functions handle source startup, smoke results and managed paths', () => {
  const plan = buildCommand({ args: ['help'] });
  const result = spawnSync(plan.command, [...plan.args.slice(0, -1),
    fileURLToPath(new URL('./build-platform.ps1', import.meta.url))],
  { encoding: 'utf8', env: plan.env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
