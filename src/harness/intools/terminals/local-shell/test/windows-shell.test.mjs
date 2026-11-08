import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePowerShellError, normalizeShellFailure, pwshCandidates, resolveLocalShell } from '../windows-shell.mjs';

const env = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  PATH: 'C:\\Tools;C:\\Windows\\System32'
};

test('pwsh resolution prefers configured, known install roots, then PATH, then Windows PowerShell', () => {
  const configured = 'D:\\PowerShell\\pwsh.exe';
  const candidates = pwshCandidates({ env: { ...env, UBOVM_PWSH_PATH: configured } });
  assert.equal(candidates[0], configured);
  assert.equal(candidates[1], join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'));
  assert(candidates.includes(join('C:\\Tools', 'pwsh.exe')));
  const chosen = resolveLocalShell({ platform: 'win32', env, probe: path => path === join('C:\\Tools', 'pwsh.exe') });
  assert.deepEqual(chosen, { executable: join('C:\\Tools', 'pwsh.exe'), kind: 'pwsh' });
  const fallback = resolveLocalShell({ platform: 'win32', env, probe: () => false });
  assert.equal(fallback.kind, 'powershell');
  assert.match(fallback.executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(resolveLocalShell({ platform: 'linux', env: {}, probe: existsSync }).kind, 'sh');
});

test('CLIXML stderr is decoded to readable PowerShell errors', () => {
  const raw = 'Local shell command exited with code 1\n'
    + '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<S S="Error">New-Item : 对路径“work”的访问被拒绝。_x000D__x000A_</S>'
    + '<S S="Error">所在位置 行:2 字符: 1_x000D__x000A_</S></Objs>';
  const decoded = decodePowerShellError(raw);
  assert.doesNotMatch(decoded, /#< CLIXML|<Objs|<S S=/);
  assert.match(decoded, /New-Item/);
  assert.match(decoded, /访问被拒绝/);
  assert.match(decoded, /所在位置 行:2/);
  assert.equal(decodePowerShellError('plain text'), 'plain text');
});

test('access-denied failures carry a stable code, cwd and hint', () => {
  const raw = Object.assign(new Error('Local shell command exited with code 1\nNew-Item : 对路径“work”的访问被拒绝。'), { details: { exit_code: 1 } });
  const failure = normalizeShellFailure(raw, { cwd: 'C:\\Users\\Administrator\\Desktop\\jinying' });
  assert.equal(failure.code, 'LOCAL_SHELL_ACCESS_DENIED');
  assert.equal(failure.details.denied, true);
  assert.equal(failure.details.exit_code, 1);
  assert.match(failure.message, /没有写权限/);
  const ordinary = normalizeShellFailure(Object.assign(new Error('command failed'), { details: { exit_code: 2 } }), { cwd: 'x' });
  assert.equal(ordinary.code, undefined);
  assert.equal(ordinary.message, 'command failed');
});
