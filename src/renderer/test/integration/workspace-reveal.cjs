'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const entry = path.resolve(__dirname, '../../extension.cjs');
const source = readFileSync(entry, 'utf8');

function load({ workspace = 'C:\\work', statType = 2, open = true, statError } = {}) {
  const start = source.indexOf('  async function revealWorkspace');
  const end = source.indexOf('\n  }', start) + 4;
  assert.ok(start >= 0 && end > start, 'extension must keep the revealWorkspace helper');
  const block = source.slice(start, end);
  const calls = { opened: [], stat: [] };
  const vscode = {
    Uri: { file: value => ({ scheme: 'file', fsPath: value }) },
    FileType: { Directory: 2 },
    workspace: { fs: { stat: async uri => { calls.stat.push(uri.fsPath); if (statError) throw statError; return { type: statType }; } } },
    env: { openExternal: async uri => { calls.opened.push(uri.fsPath); return open; } }
  };
  const sessions = {
    current: () => ({ id: 'current', workspace }),
    get: id => id === 'current' ? { workspace } : undefined
  };
  const sandbox = { vscode, sessions };
  vm.runInNewContext("'use strict';\n" + block, sandbox);
  return { reveal: sandbox.revealWorkspace, calls };
}

test('opens the configured local workspace in the OS file manager', async () => {
  const { reveal, calls } = load();
  await reveal('current');
  assert.deepEqual(calls.stat, ['C:\\work']);
  assert.deepEqual(calls.opened, ['C:\\work']);
});

test('defaults to the current session and rejects a missing workspace', async () => {
  const current = load();
  await current.reveal();
  assert.deepEqual(current.calls.opened, ['C:\\work']);
  const missing = load({ workspace: '' });
  await assert.rejects(missing.reveal(), /请先选择工作空间/);
  assert.deepEqual(missing.calls.opened, []);
});

test('reports a deleted folder instead of opening a stale path', async () => {
  const { reveal, calls } = load({ statError: Object.assign(new Error('missing'), { code: 'FileNotFound' }) });
  await assert.rejects(reveal('current'), /工作空间目录不存在，请重新选择/);
  assert.deepEqual(calls.opened, []);
});

test('rejects a file workspace and a refused OS open', async () => {
  const file = load({ statType: 1 });
  await assert.rejects(file.reveal('current'), /工作空间必须是目录/);
  assert.deepEqual(file.calls.opened, []);
  const refused = load({ open: false });
  await assert.rejects(refused.reveal('current'), /无法打开文件资源管理器/);
  assert.deepEqual(refused.calls.opened, ['C:\\work']);
});

test('extension routes the card action and registers the command', () => {
  assert.match(source, /message\.action === 'revealWorkspace'\) await revealWorkspace\(message\.sessionId\)/);
  assert.match(source, /registerCommand\('ubovm\.revealWorkspace', \(\) => revealWorkspace\(\)\)/);
});
