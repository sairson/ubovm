'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMessageActions } = require('../../../harness/session/message-actions.cjs');

function fixture() {
  const root = path.resolve('fixture-workspace'), opened = [], external = [];
  const vscode = {
    ViewColumn: { Two: 2 },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), parse: href => ({ href }) },
    Range: class { constructor(...positions) { this.positions = positions; } },
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    window: { showTextDocument: async (uri, options) => opened.push({ uri, options }) },
    env: { openExternal: async uri => { external.push(uri); return true; } }
  };
  const actions = createMessageActions(vscode, { fs: { realpath: async value => value, stat: async () => ({ isFile: () => true }) } });
  return { ...actions, opened, external, root };
}

test('conversation and worker file links target the right editor with their source location', async () => {
  const f = fixture();
  await f.openMessageLink('src/worker.mjs#L12C3', 0);
  assert.equal(f.opened[0].uri.fsPath, path.join(f.root, 'src/worker.mjs'));
  assert.equal(f.opened[0].options.viewColumn, 2);
  assert.equal(f.opened[0].options.preview, false);
  assert.deepEqual(f.opened[0].options.selection.positions, [11, 2, 11, 2]);
});

test('external and rejected links never open a file editor', async () => {
  const f = fixture();
  await f.openMessageLink('https://example.com/docs');
  assert.equal(f.external.length, 1);
  await assert.rejects(f.openMessageLink('../outside.txt'), /未找到工作区/);
  assert.equal(f.opened.length, 0);
});
