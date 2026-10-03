'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { droppedFile } = require('../../../harness/workspace/dropped-file.cjs');
const { fileURLToPath, pathToFileURL } = require('node:url');
const vscode = { Uri: { parse(text) { const uri = new URL(text); return { scheme: uri.protocol.slice(0, -1), fsPath: uri.protocol === 'file:' ? fileURLToPath(uri) : '', query: uri.search, fragment: uri.hash }; } }, workspace: { asRelativePath: uri => uri.fsPath } };
test('dropped text is a detached bounded snapshot, never an arbitrary host path', async () => {
  const input = { name: 'example.txt', content: '中文内容', truncated: false };
  const result = await droppedFile(vscode, input);
  input.content = 'changed';
  assert.equal(result.snapshot.content, '中文内容');
  assert.equal(result.path, undefined);
  for (const change of [{ name: '../file' }, { content: 'a\0b' }, { content: '中'.repeat(22000) }, { truncated: 'false' }]) {
    await assert.rejects(droppedFile(vscode, { ...input, ...change }), /无效/);
  }
});
test('IDE file links accept existing files and reject directories or remote URLs', async () => {
  const result = await droppedFile(vscode, { uri: pathToFileURL(__filename).href });
  assert.equal(result.path, __filename);
  await assert.rejects(droppedFile(vscode, { uri: pathToFileURL(__dirname).href }), /文件夹/);
  await assert.rejects(droppedFile(vscode, { uri: 'https://example.com/file.txt' }), /本地文件/);
});
