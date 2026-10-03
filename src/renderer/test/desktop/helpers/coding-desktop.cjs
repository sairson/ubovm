'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodingService } = require('../../../harness/coding/coding-service.cjs');

// Uses actual WorkspaceEdit, saved documents, and native diff editors.
exports.checkCodingDesktop = async (vscode, workspace) => {
  const filename = `coding-${randomUUID()}.txt`, file = path.join(workspace, filename);
  const projectDirectory = path.join(workspace, `project-${randomUUID()}`);
  const state = new Map(), choices = [items => items[0], () => '保留修改'];
  const api = { workspace: vscode.workspace, commands: vscode.commands, Uri: vscode.Uri, ViewColumn: vscode.ViewColumn,
    WorkspaceEdit: vscode.WorkspaceEdit, Position: vscode.Position, Range: vscode.Range, TextEdit: vscode.TextEdit, EndOfLine: vscode.EndOfLine,
    window: { showInformationMessage: vscode.window.showInformationMessage, showQuickPick: async items => choices.shift()?.(items) } };
  const context = { workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, async update(key, value) { state.set(key, structuredClone(value)); } } };
  const service = createCodingService(api, context);
  const call = async (name, input) => (await service.tools('desktop-coding').find(tool => tool.name === name).execute('desktop', input)).details;
  const selector = { scheme: 'file', pattern: `**/${filename}` }, range = new vscode.Range(0, 6, 0, 13);
  const providers = [
    vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: () => [new vscode.DocumentSymbol('message', '', vscode.SymbolKind.Constant, range, range)] }),
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: () => new vscode.Location(vscode.Uri.file(file), range) }),
    vscode.languages.registerReferenceProvider(selector, { provideReferences: () => [new vscode.Location(vscode.Uri.file(file), range)] }),
    vscode.languages.registerImplementationProvider(selector, { provideImplementation: () => new vscode.Location(vscode.Uri.file(file), range) }),
    vscode.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: () => new vscode.Location(vscode.Uri.file(file), range) }),
    vscode.languages.registerRenameProvider(selector, { provideRenameEdits: (document, _position, newName) => {
      const name = document.getText().includes('const message') ? 'message' : 'text';
      const start = document.getText().indexOf(name), edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + name.length)), newName);
      return edit;
    } })
  ];
  try {
    await fs.mkdir(projectDirectory);
    await fs.writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify({ packageManager: 'npm@10.0.0', scripts: { test: 'node --test' } }));
    const project = await call('inspect_workspace_project', { path: path.relative(workspace, path.join(projectDirectory, 'package.json')) });
    assert.equal(project.executed, false);
    assert.deepEqual(project.projects[0].tasks[0].argv, ['npm', 'run', 'test']);
    await call('edit_workspace_file', { path: filename, operation: 'create', newText: 'const message = "你好";\n' });
    const read = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'replace', expectedHash: read.hash, oldText: '你好', newText: 'world' });
    assert.equal(await fs.readFile(file, 'utf8'), 'const message = "world";\n');
    for (const action of ['symbols', 'definition', 'references', 'implementation', 'typeDefinition']) {
      const navigation = await call('navigate_workspace_code', { path: filename, action, line: 1, column: 7 });
      assert(navigation.results.some(item => item.path === filename && item.column === 7), JSON.stringify(navigation));
    }
    const rename = await call('preview_workspace_rename', { path: filename, line: 1, column: 7, newName: 'greeting' });
    assert.equal((await call('preview_workspace_edits', { files: rename.files })).status, 'ready');
    assert.equal(await fs.readFile(file, 'utf8'), 'const message = "world";\n');
    assert.equal((await call('edit_workspace_files', { files: rename.files })).status, 'applied');
    const beforePatch = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'patch', expectedHash: beforePatch.hash, edits: [{ oldText: 'world', newText: 'agent' }] });
    assert.equal(await fs.readFile(file, 'utf8'), 'const greeting = "agent";\n');
    const list = await call('list_workspace_changes', {});
    const snapshot = await call('read_workspace_change', { changeId: list[0].id, side: 'after', limit: 6 });
    assert.equal(snapshot.content, 'const '); assert.equal(snapshot.nextOffset, 6);
    await service.review('desktop-coding');
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'ubovm-diff');
    assert(tab, 'Native diff tab must open');
    assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), '');
    assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), 'const greeting = "agent";\n');
    choices.push(items => items[0], () => '撤销此文件修改');
    await service.review('desktop-coding');
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    assert.deepEqual(await call('list_workspace_changes', {}), []);
    const original = '\uFEFFconst text = "中文";\r\n';
    await fs.writeFile(file, original);
    const bom = await call('read_workspace_code', { path: filename });
    const bomRename = await call('preview_workspace_rename', { path: filename, line: 1, column: 7, newName: 'renamed' });
    assert.equal(bomRename.files[0].edits[0].start, 7);
    assert.equal((await call('preview_workspace_edits', { files: bomRename.files })).status, 'ready');
    await call('edit_workspace_file', { path: filename, operation: 'replace', expectedHash: bom.hash, oldText: '中文', newText: 'updated' });
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('中文', 'updated'));
    const changed = await call('read_workspace_code', { path: filename });
    await call('edit_workspace_file', { path: filename, operation: 'delete', expectedHash: changed.hash });
    choices.push(items => items[0], () => '撤销此文件修改');
    await service.review('desktop-coding');
    assert.equal(await fs.readFile(file, 'utf8'), original);
    return { create: true, replace: true, patch: true, navigation: true, nativeDiff: true, undo: true, utf8Bom: true, crlf: true, delete: true };
  } catch (error) {
    error.message += '\nFixture documents: ' + JSON.stringify(vscode.workspace.textDocuments.filter(doc => doc.uri.fsPath.toLowerCase() === file.toLowerCase()).map(doc => ({ text: doc.getText(), dirty: doc.isDirty })));
    throw error;
  } finally {
    for (const provider of providers) provider.dispose();
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'ubovm-diff');
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    service.dispose();
    await fs.rm(file, { force: true });
    await fs.rm(path.join(projectDirectory, 'package.json'), { force: true });
    await fs.rmdir(projectDirectory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
};
