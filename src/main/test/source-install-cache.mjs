import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync(new URL('../../../vendor/vscode/build/npm/installStateHash.ts', import.meta.url), 'utf8');
const functions = source.slice(0, source.indexOf('// When run directly'))
  .replace(/^import .*;\r?$/gm, '')
  .replace(/^export /gm, '')
  .replace(/const root = .*;/, 'const root = fixtureRoot;');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ubovm-install-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build/npm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'node_modules/example'));
  fs.writeFileSync(path.join(root, 'node_modules/example/package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.writeFileSync(path.join(root, '.nvmrc'), '24');
  for (const name of ['postinstall.ts', 'preinstall.ts', 'dirs.ts', 'installStateHash.ts']) {
    fs.writeFileSync(path.join(root, 'build/npm', name), '// original');
  }
  const context = vm.createContext({ fs, path, crypto, process, dirs: [''], fixtureRoot: root });
  vm.runInContext(stripTypeScriptTypes(functions), context);
  fs.writeFileSync(path.join(root, 'node_modules/.postinstall-state'), JSON.stringify(context.computeState()));
  return { root, context };
}
test('install logic changes invalidate a matching dependency cache', t => {
  const { root, context } = fixture(t);
  assert.equal(context.isUpToDate(), true);
  fs.appendFileSync(path.join(root, 'build/npm/postinstall.ts'), '\n// changed');
  assert.equal(context.isUpToDate(), false);
});

test('copied dependencies from another architecture or platform invalidate cache', t => {
  const { context } = fixture(t);
  const original = process;
  for (const runtime of [
    { ...original, arch: original.arch === 'x64' ? 'arm64' : 'x64' },
    { ...original, platform: original.platform === 'win32' ? 'linux' : 'win32' }
  ]) {
    context.process = runtime;
    assert.equal(context.isUpToDate(), false);
  }
});

test('legacy and truncated success markers require a fresh install', t => {
  const { root, context } = fixture(t);
  const state = context.computeState();
  delete state.platform;
  delete state.arch;
  writeState(JSON.stringify(state));
  assert.equal(context.isUpToDate(), false);
  writeState('{');
  assert.equal(context.isUpToDate(), false);
  function writeState(value) { fs.writeFileSync(path.join(root, 'node_modules/.postinstall-state'), value); }
});

test('remaining node_modules directory cannot mask a deleted required package', t => {
  const { root, context } = fixture(t);
  fs.rmSync(path.join(root, 'node_modules/example'), { recursive: true });
  assert.equal(context.isUpToDate(), false);
});

test('hoisted required packages and unavailable optional packages remain valid', t => {
  const { root, context } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested/package.json'), JSON.stringify({
    dependencies: { example: '1.0.0', unavailable: '1.0.0' },
    optionalDependencies: { unavailable: '1.0.0' }
  }));
  context.dirs.push('nested');
  fs.writeFileSync(path.join(root, 'node_modules/.postinstall-state'), JSON.stringify(context.computeState()));
  assert.equal(context.isUpToDate(), true);
});
test('cleaned nested dependencies invalidate cache without changing manifests', t => {
  const { root, context } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested/package.json'), '{"dependencies":{"example":"1.0.0"}}');
  context.dirs.push('nested');
  fs.writeFileSync(path.join(root, 'node_modules/.postinstall-state'), JSON.stringify(context.computeState()));
  assert.equal(context.isUpToDate(), true);
  fs.rmSync(path.join(root, 'nested/node_modules'), { recursive: true });
  assert.equal(context.isUpToDate(), false);
});
test('packages without dependencies do not require empty node_modules directories', t => {
  const { root, context } = fixture(t);
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'empty/package.json'), '{}');
  context.dirs.push('empty');
  fs.writeFileSync(path.join(root, 'node_modules/.postinstall-state'), JSON.stringify(context.computeState()));
  assert.equal(context.isUpToDate(), true);
});
