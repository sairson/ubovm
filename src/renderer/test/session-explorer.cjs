'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionExplorer } = require('../host/session-explorer.cjs');

test('session roots replace each other, clear for unconfigured sessions and skip repeated publications', async () => {
  const calls = [];
  const explorer = createSessionExplorer({ commands: { async executeCommand(...args) { calls.push(args); } } });
  for (const root of [undefined, undefined, 'C:/a', 'C:/a', 'C:/b', undefined, 'C:/a']) await explorer.sync(root);
  assert.deepEqual(calls, [
    ['workbench.view.explorer'],
    ['_ubovm.setExplorerWorkspace', ''], ['workbench.action.closeSidebar'],
    ['_ubovm.setExplorerWorkspace', 'C:/a'], ['workbench.view.explorer'],
    ['_ubovm.setExplorerWorkspace', 'C:/b'], ['workbench.view.explorer'],
    ['_ubovm.setExplorerWorkspace', ''], ['workbench.action.closeSidebar'],
    ['_ubovm.setExplorerWorkspace', 'C:/a'], ['workbench.view.explorer']
  ]);
});

test('slow root updates finish in order and queued obsolete sessions are skipped', async () => {
  const calls = []; let release;
  const explorer = createSessionExplorer({ commands: { async executeCommand(_command, root) {
    calls.push([_command, root]);
    if (root === 'A') await new Promise(resolve => { release = resolve; });
  } } });
  const first = explorer.sync('A');
  await new Promise(resolve => setImmediate(resolve));
  const second = explorer.sync('B'), last = explorer.sync('C');
  release();
  await Promise.all([first, second, last]);
  assert.deepEqual(calls, [['workbench.view.explorer', undefined], ['_ubovm.setExplorerWorkspace', 'A'], ['_ubovm.setExplorerWorkspace', 'C'], ['workbench.view.explorer', undefined]]);
});

test('a rejected update can be retried and disposal prevents queued changes', async () => {
  let attempts = 0;
  const explorer = createSessionExplorer({ commands: { async executeCommand() { if (++attempts === 1) throw Error('unavailable'); } } });
  await assert.rejects(explorer.sync('A'), /unavailable/);
  await explorer.sync('A');
  const queued = explorer.sync('B'); explorer.dispose(); await queued;
  assert.equal(attempts, 4);
});

test('fresh profiles initialize the lazy Explorer service before setting session roots', async () => {
  let registered = false, root;
  const explorer = createSessionExplorer({ commands: { async executeCommand(command, value) {
    if (command === 'workbench.view.explorer') registered = true;
    if (command === '_ubovm.setExplorerWorkspace') {
      assert.equal(registered, true, 'the session command is registered only after Explorer is instantiated');
      root = value;
    }
  } } });
  await explorer.sync('C:/project');
  assert.equal(root, 'C:/project');
});

test('returning to A while B is applying restores the actual tree to A', async () => {
  let actual, release;
  const explorer = createSessionExplorer({ commands: { async executeCommand(command, root) {
    if (command !== '_ubovm.setExplorerWorkspace') return;
    actual = root;
    if (root === 'B') await new Promise(resolve => { release = resolve; });
  } } });
  await explorer.sync('A');
  const switching = explorer.sync('B');
  await new Promise(resolve => setImmediate(resolve));
  const returning = explorer.sync('A');
  release();
  await Promise.all([switching, returning]);
  assert.equal(actual, 'A');
});

test('a partially failed switch does not leave the previous root falsely cached', async () => {
  let actual;
  const explorer = createSessionExplorer({ commands: { async executeCommand(command, root) {
    if (command !== '_ubovm.setExplorerWorkspace') return;
    actual = root;
    if (root === 'B') throw Error('tree refresh failed');
  } } });
  await explorer.sync('A');
  await assert.rejects(explorer.sync('B'), /tree refresh failed/);
  await explorer.sync('A');
  assert.equal(actual, 'A');
});

test('empty-folder monitoring follows the session root and disposes previous watchers', async () => {
  const watchers = [], changes = [];
  const explorer = createSessionExplorer({
    Uri: { file: fsPath => ({ fsPath }) },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    commands: { async executeCommand() {} },
    workspace: { createFileSystemWatcher(pattern) {
      const watcher = { pattern, disposed: false, onDidCreate(fn) { this.create = fn; }, onDidDelete(fn) { this.remove = fn; }, dispose() { this.disposed = true; } };
      watchers.push(watcher);
      return watcher;
    } }
  }, { onDidChangeFiles: event => changes.push(event) });
  await explorer.sync('outside-window/A');
  watchers[0].create('first file');
  await explorer.sync('outside-window/B');
  watchers[1].remove('last file');
  assert.equal(watchers[0].disposed, true);
  assert.equal(watchers[1].pattern.base.fsPath, 'outside-window/B');
  assert.equal(watchers[1].pattern.pattern, '*');
  assert.deepEqual(changes, ['first file', 'last file']);
  await explorer.sync('');
  assert.equal(watchers[1].disposed, true);
  await explorer.sync('outside-window/C');
  explorer.dispose();
  assert.equal(watchers[2].disposed, true);
});
