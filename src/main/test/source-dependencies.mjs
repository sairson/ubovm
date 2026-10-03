import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateInstallDirectories, validateSourceInputs, isSourceInstallCurrent } from '../source-dependencies.mjs';

test('source preflight checks all working directories before spawning npm', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ubovm-source-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), '{}');
  mkdirSync(path.join(root, 'empty'));
  assert.throws(() => validateInstallDirectories(root, ['', 'missing', 'empty']), error => {
    assert.match(error.message, /missing/); assert.match(error.message, /empty/);
    assert.match(error.message, /before npm/); return true;
  });
  writeFileSync(path.join(root, 'empty/package.json'), '{}');
  assert.doesNotThrow(() => validateInstallDirectories(root, ['', 'empty']));
  assert.throws(() => validateInstallDirectories(root, ['../outside']), /escapes source root/);
});

test('build entry checks real saved state and detects missing required packages', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ubovm-source-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'build/npm'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/example'), { recursive: true });
  for (const file of ['.npmrc', '.nvmrc', '.git-blame-ignore-revs', 'build/npm/preinstall.ts', 'build/npm/postinstall.ts']) {
    writeFileSync(path.join(root, file), '');
  }
  writeFileSync(path.join(root, 'package.json'), '{"type":"module","dependencies":{"example":"1.0.0"}}');
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  writeFileSync(path.join(root, 'node_modules/example/package.json'), '{}');
  writeFileSync(path.join(root, 'build/npm/dirs.ts'), "export const dirs = [''];");
  copyFileSync(new URL('../../../vendor/vscode/build/npm/installStateHash.ts', import.meta.url), path.join(root, 'build/npm/installStateHash.ts'));
  assert.equal(await isSourceInstallCurrent(root), false);
  const { computeState } = await import(pathToFileURL(path.join(root, 'build/npm/installStateHash.ts')).href);
  writeFileSync(path.join(root, 'node_modules/.postinstall-state'), JSON.stringify(computeState()));
  assert.equal(await isSourceInstallCurrent(root), true);
  rmSync(path.join(root, 'node_modules/example'), { recursive: true });
  assert.equal(await isSourceInstallCurrent(root), false);
});

test('trimmed checkout must retain installation configuration and scripts', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ubovm-source-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => validateSourceInputs(root), /\.npmrc[\s\S]*postinstall\.ts/);
  mkdirSync(path.join(root, 'build/npm'), { recursive: true });
  for (const file of ['.npmrc', '.nvmrc', '.git-blame-ignore-revs', 'package.json', 'package-lock.json',
    'build/npm/dirs.ts', 'build/npm/preinstall.ts', 'build/npm/postinstall.ts', 'build/npm/installStateHash.ts']) {
    writeFileSync(path.join(root, file), '');
  }
  assert.doesNotThrow(() => validateSourceInputs(root));
  rmSync(path.join(root, '.nvmrc'));
  assert.throws(() => validateSourceInputs(root), /\.nvmrc/);
});
