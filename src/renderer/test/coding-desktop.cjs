'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodingService } = require('../harness/coding-service.cjs');

// Uses actual WorkspaceEdit, saved documents, and native diff editors.
exports.checkCodingDesktop = async (vscode, workspace) => {
  const filename = `coding-${randomUUID()}.txt`, file = path.join(workspace, filename);
  const state = new Map(), choices = [items => items[0], () => '保留修改'];
  const api = { workspace: vscode.workspace, commands: vscode.commands, Uri: vscode.Uri, ViewColumn: vscode.ViewColumn,
    WorkspaceEdit: vscode.WorkspaceEdit, Position: vscode.Position, Range: vscode.Range, TextEdit: vscode.TextEdit, EndOfLine: vscode.EndOfLine,
    window: { showInformationMessage: vscode.window.showInformationMessage, showQuickPick: async items => choices.shift()?.(items) } };
  const context = { workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, async update(key, value) { state.set(key, structuredClone(value)); } } };
  const service = createCodingService(api, context);
  const call = async (name, input) => (await service.tools('desktop-coding').find(tool => tool.name === name).execute('desktop', input)).details;
  try {
    await call('edit_workspace_file', { path: filename, operation: 'create', newText: 'const message = "你好";\n' });
    const read = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'replace', expectedHash: read.hash, oldText: '你好', newText: 'world' });
    assert.equal(await fs.readFile(file, 'utf8'), 'const message = "world";\n');
    await service.review('desktop-coding');
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'ubovm-diff');
    assert(tab, 'Native diff tab must open');
    assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), '');
    assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), 'const message = "world";\n');
    choices.push(items => items[0], () => '撤销此文件修改');
    await service.review('desktop-coding');
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    assert.deepEqual(await call('list_workspace_changes', {}), []);
    const original = '\uFEFFconst text = "中文";\r\n';
    await fs.writeFile(file, original);
    const bom = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'replace', expectedHash: bom.hash, oldText: '中文', newText: 'updated' });
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('中文', 'updated'));
    const changed = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'delete', expectedHash: changed.hash });
    choices.push(items => items[0], () => '撤销此文件修改');
    await service.review('desktop-coding');
    assert.equal(await fs.readFile(file, 'utf8'), original);
    return { create: true, replace: true, nativeDiff: true, undo: true, utf8Bom: true, crlf: true, delete: true };
  } catch (error) {
    error.message += '\nFixture documents: ' + JSON.stringify(vscode.workspace.textDocuments.filter(doc => doc.uri.fsPath.toLowerCase() === file.toLowerCase()).map(doc => ({ text: doc.getText(), dirty: doc.isDirty })));
    throw error;
  } finally {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'ubovm-diff');
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    service.dispose();
    await fs.rm(file, { force: true });
  }
};
