'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readProjectInput } = require('../../../host/project/project-input.cjs');

function fixture(options = {}) {
  const name = Object.prototype.hasOwnProperty.call(options, 'name') ? options.name : '网站';
  const pick = Object.prototype.hasOwnProperty.call(options, 'pick') ? options.pick : 'suggested';
  const folder = options.folder;
  const cancelDialog = options.cancelDialog === true;
  const stat = options.stat || (async () => { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); });
  const inputs = [], picks = [], dialogs = [], writes = [];
  const vscode = { Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }, FileType: { Directory: 2 },
    commands: { executeCommand: async () => undefined },
    workspace: { fs: { stat, createDirectory: directory => writes.push(directory) } },
    window: {
      showInputBox: async options => { inputs.push(options); return name; },
      showQuickPick: async (items, options) => {
        picks.push({ items, options });
        if (pick === undefined) return undefined;
        return items.find(item => item.action === pick) || items[0];
      },
      showOpenDialog: async options => {
        dialogs.push(options);
        if (cancelDialog) return undefined;
        return [{ fsPath: folder, scheme: 'file' }];
      }
    } };
  return { vscode, inputs, picks, dialogs, writes };
}

test('project creation can accept the suggested directory without browsing', async () => {
  const parent = path.resolve('workspace-root');
  const directory = path.join(parent, '网站');
  const f = fixture({ name: '  网站  ', pick: 'suggested' });
  const result = await readProjectInput(f.vscode, { workspace: path.join(parent, 'old-project'), suggestedName: '网站' });
  assert.equal(result.name, '网站');
  assert.equal(result.folder.fsPath, directory);
  assert.equal(f.inputs[0].value, '网站');
  assert.equal(f.picks[0].options.title, '新建项目 · 选择项目目录');
  assert.equal(f.picks[0].items[0].description, directory);
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.writes, []);
});

test('browsing picks an existing folder as the project directory', async () => {
  const directory = path.resolve('existing-project');
  const f = fixture({ name: '现有', pick: 'browse', folder: directory, stat: async () => ({ type: 2 }) });
  const result = await readProjectInput(f.vscode, { workspace: path.resolve('other', 'old') });
  assert.equal(result.folder.fsPath, directory);
  assert.equal(f.dialogs[0].title, '新建项目 · 选择项目目录');
  assert.deepEqual(f.writes, []);
});

test('project cancellation at either step has no filesystem effects', async () => {
  assert.equal(await readProjectInput(fixture({ name: undefined }).vscode), undefined);
  assert.equal(await readProjectInput(fixture({ pick: undefined }).vscode), undefined);
  const cancelledBrowse = fixture({ pick: 'browse', cancelDialog: true });
  assert.equal(await readProjectInput(cancelledBrowse.vscode), undefined);
  assert.deepEqual(cancelledBrowse.writes, []);
});

test('directory validation rejects files and permission failures', async () => {
  const directory = path.resolve('project');
  await assert.rejects(readProjectInput(fixture({
    name: '项目', pick: 'browse', folder: directory, stat: async () => ({ type: 1 })
  }).vscode), /该路径是文件/);
  await assert.rejects(readProjectInput(fixture({
    name: '项目', pick: 'browse', folder: directory,
    stat: async () => { throw Object.assign(new Error('denied'), { code: 'NoPermissions' }); }
  }).vscode), /无法访问.*denied/);
});
