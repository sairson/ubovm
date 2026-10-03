import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync(new URL('../../../vendor/vscode/build/npm/postinstall.ts', import.meta.url), 'utf8');
const linkFunction = source.slice(source.indexOf('function ensureAgentHarnessLink('), source.indexOf('\nasync function runWithConcurrency'));
const mainFunction = source.slice(source.indexOf('async function main()'), source.indexOf('\nmain().catch'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ubovm-postinstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = vm.createContext({ fs, path, os, process: { platform: process.platform, env: {} }, root,
    stateFile: path.join(root, 'state'), stateContentsFile: path.join(root, 'contents'), dirs: [],
    isUpToDate: () => false, computeState: () => ({ complete: true }), computeContents: () => ({}),
    child_process: { execFileSync() {} }, runWithConcurrency: async () => {}, log() {} });
  vm.runInContext(stripTypeScriptTypes(linkFunction + '\n' + mainFunction), context);
  return context;
}
test('trimmed checkout completes without optional instructions or skills', async t => {
  const c = fixture(t);
  await c.main();
  assert.deepEqual(JSON.parse(fs.readFileSync(c.stateFile)), { complete: true });
  assert.equal(fs.existsSync(path.join(c.root, '.claude/CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(c.root, '.claude/skills')), false);
});
test('postinstall failure does not publish successful install state', async t => {
  const c = fixture(t);
  fs.writeFileSync(c.stateFile, JSON.stringify({ complete: true }));
  c.ensureAgentHarnessLink = () => { throw new Error('link failure'); };
  await assert.rejects(c.main(), /link failure/);
  assert.equal(fs.existsSync(c.stateFile), false);
  assert.equal(fs.existsSync(c.stateContentsFile), false);
});
test('Windows file permission fallback and existing links remain supported', t => {
  const c = fixture(t);
  c.process.platform = 'win32';
  fs.writeFileSync(path.join(c.root, 'instructions.md'), 'instructions');
  c.fs = { ...fs, symlinkSync() { throw Object.assign(new Error('permission'), { code: 'EPERM' }); } };
  const link = path.join(c.root, 'CLAUDE.md');
  assert.equal(c.ensureAgentHarnessLink('instructions.md', link), 'hard link');
  assert.equal(c.ensureAgentHarnessLink('instructions.md', link), 'existing');
  assert.equal(fs.readFileSync(link, 'utf8'), 'instructions');
});

test('cached and fresh installs scope Git configuration to the source checkout', async t => {
  for (const cached of [false, true]) {
    const c = fixture(t);
    const calls = [];
    c.isUpToDate = () => cached;
    c.child_process.execFileSync = (command, args) => calls.push([command, Array.from(args)]);
    await c.main();
    assert.deepEqual(calls, [
      ['git', ['-c', `safe.directory=${c.root}`, '-C', c.root, 'config', '--local', 'pull.rebase', 'merges']],
      ['git', ['-c', `safe.directory=${c.root}`, '-C', c.root, 'config', '--local', 'blame.ignoreRevsFile', '.git-blame-ignore-revs']]
    ]);
  }
});

test('failed contents publication cannot leave an install success marker', async t => {
  const c = fixture(t);
  c.fs = { ...fs, writeFileSync(file, ...args) {
    if (file === c.stateContentsFile) throw new Error('disk full');
    return fs.writeFileSync(file, ...args);
  } };
  await assert.rejects(c.main(), /disk full/);
  assert.equal(fs.existsSync(c.stateFile), false);
});
