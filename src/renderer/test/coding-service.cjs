'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCodingService } = require('../harness/coding-service.cjs');

async function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'ubovm-coding-'));
  const values = new Map(), documents = [], diffs = [], choices = [];
  let provider;
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const vscode = {
    Uri: { file: uri, parse: value => ({ scheme: 'ubovm-diff', toString: () => value }) },
    ViewColumn: { Two: 2 }, Position: class {}, Range: class {},
    TextEdit: { setEndOfLine: value => ({ newEol: value }), insert: (_, text) => ({ text }), replace: (_, text) => ({ text }) }, EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: class {
      ops = [];
      createFile(uri) { this.ops.push(['create', uri]); }
      deleteFile(uri) { this.ops.push(['delete', uri]); }
      insert(uri, _, text) { this.ops.push(['text', uri, text]); }
      replace(uri, _, text) { this.ops.push(['text', uri, text]); }
      get() { return []; }
      set(uri, edits) { for (const edit of edits) if (edit.text !== undefined) this.ops.push(['text', uri, edit.text]); }
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
      registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(uri) {
        let doc = documents.find(doc => doc.uri.fsPath === uri.fsPath);
        if (!doc) {
          doc = { uri, isDirty: false, text: await fs.readFile(uri.fsPath, 'utf8'), getText() { return this.text; }, positionAt: offset => offset,
            async save() { await fs.writeFile(uri.fsPath, this.text); this.isDirty = false; return true; } };
          documents.push(doc);
        }
        return doc;
      },
      async applyEdit(edit) {
        for (const [operation, uri, text] of edit.ops) {
          if (operation === 'create') await fs.writeFile(uri.fsPath, '', { flag: 'wx' });
          if (operation === 'delete') { await fs.unlink(uri.fsPath); const index = documents.findIndex(doc => doc.uri.fsPath === uri.fsPath); if (index >= 0) documents.splice(index, 1); }
          if (operation === 'text') { const doc = await this.openTextDocument(uri); doc.text = text; doc.isDirty = true; }
        }
        return true;
      }
    },
    window: { async showInformationMessage() {}, async showQuickPick(items) { return choices.shift()?.(items); } },
    commands: { async executeCommand(name, left, right, title, options) { diffs.push({ name, before: provider.provideTextDocumentContent(left), after: provider.provideTextDocumentContent(right), title, options }); } }
  };
  const context = { workspaceState: { get: (key, fallback) => structuredClone(values.get(key) ?? fallback), async update(key, value) { values.set(key, structuredClone(value)); } } };
  let service = createCodingService(vscode, context);
  const call = async (name, input = {}, session = 'one', signal) => (await service.tools(session).find(tool => tool.name === name).execute('test', input, signal)).details;
  t.after(async () => { service.dispose(); assert(path.dirname(root) === parent); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vscode, context, diffs, choices, call, get service() { return service; }, reload() { service.dispose(); documents.length = 0; service = createCodingService(vscode, context); } };
}

test('create, versioned replace, durable diff, session isolation and undo', async t => {
  const f = await fixture(t);
  await f.call('edit_workspace_file', { path: 'hello.js', operation: 'create', newText: 'const n = 1;\r\n' });
  const original = await f.call('read_workspace_code', { path: 'hello.js' });
  await f.call('edit_workspace_file', { path: 'hello.js', operation: 'replace', expectedHash: original.hash, oldText: 'n = 1', newText: 'n = 2' });
  assert.equal(await fs.readFile(path.join(f.root, 'hello.js'), 'utf8'), 'const n = 2;\r\n');
  assert.equal((await f.call('list_workspace_changes')).length, 1);
  assert.deepEqual(await f.call('list_workspace_changes', {}, 'other'), []);
  f.reload();
  f.choices.push(items => items[0], () => '撤销此文件修改');
  await f.service.review('one');
  assert.equal(f.diffs[0].name, 'vscode.diff');
  assert.equal(f.diffs[0].before, '');
  assert.equal(f.diffs[0].after, 'const n = 2;\r\n');
  assert.equal(f.diffs[0].options.viewColumn, 2);
  await assert.rejects(fs.stat(path.join(f.root, 'hello.js')), { code: 'ENOENT' });
});

test('delete and undo retain original bytes including Chinese and CRLF', async t => {
  const f = await fixture(t), original = '中文\r\nlast line';
  await fs.writeFile(path.join(f.root, 'source.txt'), original);
  const read = await f.call('read_workspace_code', { path: 'source.txt' });
  await f.call('edit_workspace_file', { path: 'source.txt', operation: 'delete', expectedHash: read.hash });
  f.choices.push(items => items[0], () => '撤销此文件修改');
  await f.service.review('one');
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), original);
});

test('stale hashes, ambiguous replacements, dirty editors and untrusted workspace never write', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'a.txt'), 'same same');
  const read = await f.call('read_workspace_code', { path: 'a.txt' });
  const edit = { path: 'a.txt', operation: 'replace', oldText: 'same', newText: 'new', expectedHash: read.hash };
  await assert.rejects(f.call('edit_workspace_file', { ...edit, expectedHash: 'stale' }), /版本不匹配/);
  await assert.rejects(f.call('edit_workspace_file', edit), /仅出现一次/);
  const document = await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(path.join(f.root, 'a.txt')));
  document.isDirty = true;
  await assert.rejects(f.call('edit_workspace_file', edit), /未保存/);
  document.isDirty = false; f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.call('edit_workspace_file', edit), /信任工作区/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'same same');
  assert.deepEqual(await f.call('list_workspace_changes'), []);
});

test('undo refuses external changes and failed persistence prevents writes', async t => {
  const f = await fixture(t);
  await f.call('edit_workspace_file', { path: 'a.txt', operation: 'create', newText: 'agent' });
  await fs.writeFile(path.join(f.root, 'a.txt'), 'user');
  f.choices.push(items => items[0], () => '撤销此文件修改');
  await assert.rejects(f.service.review('one'), /文件已变化/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'user');
  f.context.workspaceState.update = async () => { throw new Error('storage failed'); };
  await assert.rejects(f.call('edit_workspace_file', { path: 'b.txt', operation: 'create', newText: 'x' }), /storage failed/);
  await assert.rejects(fs.stat(path.join(f.root, 'b.txt')), { code: 'ENOENT' });
});

test('boundaries, binary content, cancellation and concurrent edits', async t => {
  const f = await fixture(t);
  for (const file of ['../escape.txt', '.git/config', 'name:stream', 'NUL.txt', 'dir./file']) {
    await assert.rejects(f.call('edit_workspace_file', { path: file, operation: 'create', newText: 'x' }));
  }
  await fs.writeFile(path.join(f.root, 'binary'), Buffer.from([0xff]));
  await assert.rejects(f.call('read_workspace_code', { path: 'binary' }), /UTF-8/);
  const signal = AbortSignal.abort();
  await assert.rejects(f.call('edit_workspace_file', { path: 'cancel.txt', operation: 'create', newText: '' }, 'one', signal));
  const results = await Promise.allSettled(['one', 'two'].map(session => f.call('edit_workspace_file', { path: 'race.txt', operation: 'create', newText: session }, session)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('create followed by delete leaves no net change or unusable undo record', async t => {
  const f = await fixture(t);
  const created = await f.call('edit_workspace_file', { path: 'temp.txt', operation: 'create', newText: 'temporary' });
  await f.call('edit_workspace_file', { path: 'temp.txt', operation: 'delete', expectedHash: created.hash });
  assert.deepEqual(await f.call('list_workspace_changes'), []);
});

test('failed save retains the original snapshot for the dirty edit', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'unsaved.txt');
  await fs.writeFile(file, 'original');
  const read = await f.call('read_workspace_code', { path: 'unsaved.txt' });
  const target = await fs.realpath(file);
  const document = await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(target));
  document.save = async () => false;
  await assert.rejects(f.call('edit_workspace_file', { path: 'unsaved.txt', operation: 'replace', expectedHash: read.hash, oldText: 'original', newText: 'changed' }), /未能保存/);
  assert.equal(document.isDirty, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal((await f.call('list_workspace_changes')).length, 1);
});

test('directory junctions and oversized files are rejected', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'actual'));
  await fs.symlink(path.join(f.root, 'actual'), path.join(f.root, 'linked'), 'junction');
  await assert.rejects(f.call('edit_workspace_file', { path: 'linked/file.txt', operation: 'create', newText: 'no' }), /符号链接/);
  await fs.writeFile(path.join(f.root, 'large.txt'), 'a'.repeat(256 * 1024 + 1));
  await assert.rejects(f.call('read_workspace_code', { path: 'large.txt' }), /256 KiB/);
});

async function journal(f, values) {
  const root = await fs.realpath(f.root);
  await f.context.workspaceState.update('ubovm.codeChanges.v1', [{ id: 'pending', sessionId: 'one', root, rootIndex: 0, file: path.join(root, 'recover.txt'), path: 'recover.txt', before: 'original', after: 'proposed', ...values }]);
  f.reload();
}

test('restart before disk write removes unapplied journal and accepts a fresh edit', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'recover.txt'), 'original');
  await journal(f, { state: 'pending', pending: 'write', previousAfter: 'original' });
  assert.deepEqual(await f.call('recover_workspace_changes'), []);
  const read = await f.call('read_workspace_code', { path: 'recover.txt' });
  await f.call('edit_workspace_file', { path: 'recover.txt', operation: 'replace', oldText: 'original', newText: 'retry', expectedHash: read.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'recover.txt'), 'utf8'), 'retry');
});

test('restart after disk write publishes applied state; failed later edit retains earlier changes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'recover.txt'), 'proposed');
  await journal(f, { state: 'pending', pending: 'write', previousAfter: 'original' });
  assert.equal((await f.call('recover_workspace_changes'))[0].state, 'applied');
  await journal(f, { state: 'pending', pending: 'write', previousAfter: 'proposed', after: 'not written' });
  assert.equal((await f.call('recover_workspace_changes'))[0].state, 'applied');
  f.choices.push(items => items[0], () => '撤销此文件修改');
  await f.service.review('one');
  assert.equal(f.diffs[0].before, 'original'); assert.equal(f.diffs[0].after, 'proposed');
  assert.equal(await fs.readFile(path.join(f.root, 'recover.txt'), 'utf8'), 'original');
});

test('external changes remain conflicts and unavailable workspace can recover later', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'recover.txt'), 'user edits');
  await journal(f, { state: 'pending', pending: 'write', previousAfter: 'original' });
  assert.equal((await f.call('recover_workspace_changes'))[0].state, 'conflict');
  const folders = f.vscode.workspace.workspaceFolders;
  f.vscode.workspace.workspaceFolders = [];
  assert.equal((await f.call('recover_workspace_changes'))[0].state, 'unavailable');
  f.vscode.workspace.workspaceFolders = folders;
  await fs.writeFile(path.join(f.root, 'recover.txt'), 'proposed');
  assert.equal((await f.call('recover_workspace_changes'))[0].state, 'applied');
});

test('interrupted undo and legacy unapplied journals reconcile without writing files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'recover.txt'), 'original');
  await journal(f, { state: 'pending', pending: 'undo', previousAfter: 'proposed', after: 'original' });
  assert.deepEqual(await f.call('recover_workspace_changes'), []);
  await journal(f, {});
  assert.deepEqual(await f.call('recover_workspace_changes'), []);
  assert.equal(await fs.readFile(path.join(f.root, 'recover.txt'), 'utf8'), 'original');
});

test('editing one file avoids scanning sibling snapshots; listing still detects sibling conflicts', async t => {
  const f = await fixture(t);
  const first = await f.call('edit_workspace_file', { path: 'one.txt', operation: 'create', newText: 'one' });
  await f.call('edit_workspace_file', { path: 'two.txt', operation: 'create', newText: 'two' });
  const sibling = await fs.realpath(path.join(f.root, 'two.txt'));
  await fs.writeFile(sibling, 'external change');
  const original = fs.open;
  let siblingReads = 0;
  fs.open = async (...args) => { if (args[0] === sibling) siblingReads++; return original(...args); };
  try {
    await f.call('edit_workspace_file', { path: 'one.txt', operation: 'replace', expectedHash: first.hash, oldText: 'one', newText: 'updated' });
    assert.equal(siblingReads, 0);
    const list = await f.call('list_workspace_changes');
    assert.equal(list.find(item => item.path === 'two.txt').state, 'conflict');
    assert.equal(siblingReads, 1);
  } finally { fs.open = original; }
});
