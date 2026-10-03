import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeLaunchArguments } from '../launch-policy.mjs';

test('ordinary launches reuse the primary window without modifying caller arguments', () => {
  for (const tail of [[], ['C:\\work space'], ['--skip-welcome', 'file.txt'], ['--user-data-dir=C:\\profile']]) {
    const argv = ['UBOVM.exe', ...tail], before = [...argv];
    const result = normalizeLaunchArguments(argv);
    assert.deepEqual(result, [...before, '--reuse-window']);
    assert.deepEqual(argv, before);
    assert.deepEqual(normalizeLaunchArguments(result), result);
  }
});

test('explicit window, development, profile and specialized operations retain native routing', () => {
  for (const flag of ['--new-window', '-n', '--reuse-window', '-r', '--wait', '-w', '--diff', '-d', '--merge', '-m',
    '--profile=other', '--profile-temp', '--extensionDevelopmentPath=C:\\dev', '--extensionTestsPath=test.js', '--agents', '--open-url', '--add', '--remove']) {
    const argv = ['UBOVM.exe', flag, 'target'];
    assert.deepEqual(normalizeLaunchArguments(argv), argv);
  }
});

test('literal file names after the separator do not become launch switches', () => {
  const argv = ['UBOVM.exe', '--', '--new-window', 'file with spaces'];
  assert.deepEqual(normalizeLaunchArguments(argv), ['UBOVM.exe', '--reuse-window', '--', '--new-window', 'file with spaces']);
});

test('bootstrap applies routing before Code OSS and launcher does not force ordinary new windows', () => {
  const bootstrap = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  assert(bootstrap.indexOf('...normalizeLaunchArguments(process.argv)') < bootstrap.indexOf("await import(pathToFileURL"));
  const build = readFileSync(new URL('../../../build/build.ps1', import.meta.url), 'utf8');
  assert.match(build, /if \(\$Smoke\) \{ \$arguments \+= '--new-window' \}/);
  assert.match(build, /elseif \(-not \$Development\) \{ \$arguments \+= '--reuse-window' \}/);
});
