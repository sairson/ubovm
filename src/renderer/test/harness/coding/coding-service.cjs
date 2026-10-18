'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCodingService, withLines } = require('../../../harness/coding/coding-service.cjs');

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'ubovm-coding-'));
  const values = new Map(), documents = [], diffs = [], choices = [];
  let provider, closeDocument;
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const vscode = {
    Uri: { file: uri, parse: value => ({ scheme: 'ubovm-diff', toString: () => value }) },
    ViewColumn: { Two: 2 }, Position: class { constructor(line, character) { this.line = line; this.character = character; } }, Range: class {},
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
      onDidCloseTextDocument(callback) { closeDocument = callback; return { dispose() {} }; },
      async openTextDocument(uri) {
        let doc = documents.find(doc => doc.uri.fsPath === uri.fsPath);
        if (!doc) {
          doc = { uri, version: 1, isDirty: false, text: await fs.readFile(uri.fsPath, 'utf8'), getText() { return this.text; }, positionAt: offset => offset,
            get lineCount() { return this.text.split('\n').length; }, lineAt(line) { return { text: this.text.split(/\r?\n/)[line] }; },
            offsetAt(position) { return this.text.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character; },
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
  let currentTurn;
  const options = { turnId: () => currentTurn };
  let service = createCodingService(vscode, context, options);
  const call = async (name, input = {}, session = 'one', signal) => (await service.tools(session).find(tool => tool.name === name).execute('test', input, signal)).details;
  t.after(async () => { service.dispose(); assert(path.dirname(root) === parent); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vscode, context, diffs, choices, call, closeDiff(uri) { closeDocument({ uri }); }, turn(id) { currentTurn = id; }, get service() { return service; }, reload() { service.dispose(); documents.length = 0; service = createCodingService(vscode, context, options); } };
}

test('turn summaries count net lines, isolate rounds and survive restart with reverse-order undo', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '中文.txt'), '第一行\r\n第二行\r\n');
  f.turn('round-one');
  let read = await f.call('read_workspace_code', { path: '中文.txt' });
  await f.call('edit_workspace_file', { path: '中文.txt', operation: 'replace', oldText: '第二行', newText: '新行\r\n第三行', expectedHash: read.hash });
  let first = f.service.turnSummary('one')['round-one'];
  assert.equal(JSON.stringify(first).includes('第三行'), false, 'webview summary never includes source snapshots');
  assert.equal(first.added, 2); assert.equal(first.removed, 1);
  assert.equal(first.files.length, 1); assert.equal(first.approximate, false);
  assert.deepEqual(Object.keys(f.service.turnSummary('two')), []);
  f.turn('round-two');
  read = await f.call('read_workspace_code', { path: '中文.txt' });
  await f.call('edit_workspace_file', { path: '中文.txt', operation: 'replace', oldText: '第三行', newText: '第四行', expectedHash: read.hash });
  f.reload();
  first = f.service.turnSummary('one')['round-one'];
  await assert.rejects(f.service.undoTurn('one', 'round-one', first.revision), /后续/);
  const second = f.service.turnSummary('one')['round-two'];
  await assert.rejects(f.service.undoTurn('two', 'round-two', second.revision), /更新/);
  await assert.rejects(f.service.showTurnFile('two', 'round-two', second.files[0].id), /不存在/);
  await f.service.showTurnFile('one', 'round-two', second.files[0].id);
  assert.match(f.diffs.at(-1).before, /第三行/); assert.match(f.diffs.at(-1).after, /第四行/);
  await f.service.undoTurn('one', 'round-two', second.revision);
  assert.equal(f.service.turnSummary('one')['round-two'].undone, true);
  await f.service.undoTurn('one', 'round-one', f.service.turnSummary('one')['round-one'].revision);
  assert.equal(await fs.readFile(path.join(f.root, '中文.txt'), 'utf8'), '第一行\r\n第二行\r\n');
  assert.equal(f.service.turnSummary('one')['round-one'].undone, true);
});

test('turn undo preflights all files and never overwrites later manual or dirty edits', async t => {
  const f = await fixture(t); f.turn('turn');
  for (const name of ['a.txt', 'b.txt']) await f.call('edit_workspace_file', { path: name, operation: 'create', newText: 'created\n' });
  const original = f.service.turnSummary('one').turn;
  await fs.writeFile(path.join(f.root, 'b.txt'), 'manual\n');
  await assert.rejects(f.service.undoTurn('one', 'turn', original.revision), /更新|修改/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'created\n');
  assert.equal(await fs.readFile(path.join(f.root, 'b.txt'), 'utf8'), 'manual\n');
  await fs.writeFile(path.join(f.root, 'b.txt'), 'created\n'); await f.service.recover('one');
  f.vscode.workspace.textDocuments[1].isDirty = true;
  await assert.rejects(f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision), /更新|未保存/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'created\n');
  f.vscode.workspace.textDocuments[1].isDirty = false; await f.service.recover('one');
  await f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision);
  await assert.rejects(fs.stat(path.join(f.root, 'a.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, 'b.txt')), { code: 'ENOENT' });
});

test('partial turn undo reports progress and resumes only remaining files', async t => {
  const f = await fixture(t); f.turn('turn');
  for (const name of ['a.txt', 'b.txt']) await f.call('edit_workspace_file', { path: name, operation: 'create', newText: 'created\n' });
  const apply = f.vscode.workspace.applyEdit.bind(f.vscode.workspace);
  f.vscode.workspace.applyEdit = async edit => edit.ops.some(([, uri]) => uri.fsPath.endsWith('b.txt')) ? false : apply(edit);
  await assert.rejects(f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision), /已撤销 1\/2/);
  assert.equal(f.service.turnSummary('one').turn.files.filter(file => file.undone).length, 1);
  f.reload(); f.vscode.workspace.applyEdit = apply;
  await f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision);
  assert.equal(f.service.turnSummary('one').turn.undone, true);
});

test('turns keep create-delete history even when the conversation has no net changes', async t => {
  const f = await fixture(t); f.turn('create');
  await f.call('edit_workspace_file', { path: 'new.txt', operation: 'create', newText: 'new\n' });
  f.turn('delete');
  const read = await f.call('read_workspace_code', { path: 'new.txt' });
  await f.call('edit_workspace_file', { path: 'new.txt', operation: 'delete', expectedHash: read.hash });
  assert.equal((await f.call('list_workspace_changes')).length, 0);
  assert.deepEqual(Object.keys(f.service.turnSummary('one')), ['create', 'delete']);
  await f.service.undoTurn('one', 'delete', f.service.turnSummary('one').delete.revision);
  assert.equal(await fs.readFile(path.join(f.root, 'new.txt'), 'utf8'), 'new\n');
  await f.service.undoTurn('one', 'create', f.service.turnSummary('one').create.revision);
  await assert.rejects(fs.stat(path.join(f.root, 'new.txt')), { code: 'ENOENT' });
});

test('failed save during turn undo never reports an unconfirmed file as undone', async t => {
  const f = await fixture(t); f.turn('turn');
  await fs.writeFile(path.join(f.root, 'existing.txt'), 'original\n');
  const before = await f.call('read_workspace_code', { path: 'existing.txt' });
  await f.call('edit_workspace_file', { path: 'existing.txt', operation: 'replace', oldText: 'original', newText: 'changed', expectedHash: before.hash });
  const document = f.vscode.workspace.textDocuments[0], save = document.save;
  document.save = async () => false;
  await assert.rejects(f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision), /未能保存/);
  assert.equal(f.service.turnSummary('one').turn.undone, false);
  await assert.rejects(f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision), /冲突|未保存/);
  document.save = save; await document.save();
  await f.service.recover('one');
  assert.equal(f.service.turnSummary('one').turn.undone, true);
  assert.equal(await fs.readFile(path.join(f.root, 'existing.txt'), 'utf8'), 'original\n');
});

test('turn undo persistence failure cannot modify files', async t => {
  const f = await fixture(t); f.turn('turn');
  await f.call('edit_workspace_file', { path: 'new.txt', operation: 'create', newText: 'preserved\n' });
  f.context.workspaceState.update = async () => { throw Error('journal unavailable'); };
  await assert.rejects(f.service.undoTurn('one', 'turn', f.service.turnSummary('one').turn.revision), /journal unavailable/);
  assert.equal(await fs.readFile(path.join(f.root, 'new.txt'), 'utf8'), 'preserved\n');
  assert.equal(f.service.turnSummary('one').turn.undone, false);
});

test('turn summary visits history linearly and reuses an unchanged cached summary', async t => {
  const f = await fixture(t); let visits = 0;
  const turns = Array.from({ length: 200 }, (_, index) => ({ get id() { visits++; return 'turn-' + index; }, before: 'before\n', after: 'after\n' }));
  const service = createCodingService(f.vscode, { workspaceState: { get: () => [{ id: 'file', sessionId: 'one', path: 'a.txt', rootIndex: 0, state: 'applied', turns }] } });
  t.after(() => service.dispose());
  const summary = service.turnSummary('one');
  assert.equal(Object.keys(summary).length, 200);
  assert(visits < 200 * 8, `history scanned too often: ${visits}`);
  const before = visits;
  assert.equal(service.turnSummary('one'), summary); assert.equal(visits, before);
});

test('turn diff reuses snapshot URIs, coalesces concurrent opens and releases closed entries', async t => {
  const f = await fixture(t); f.turn('round');
  await f.call('edit_workspace_file', { path: 'a.txt', operation: 'create', newText: 'content\n' });
  const fileId = f.service.turnSummary('one').round.files[0].id;
  const calls = []; let release, fail = false;
  f.vscode.commands.executeCommand = async (...args) => {
    calls.push(args);
    if (release) await release.promise;
    if (fail) throw Error('diff editor unavailable');
  };
  await f.service.showTurnFile('one', 'round', fileId);
  await f.service.showTurnFile('one', 'round', fileId);
  assert.equal(calls[0][1].toString(), calls[1][1].toString());
  f.closeDiff(calls[0][1]); f.closeDiff(calls[0][2]);
  let resolve;
  release = { promise: new Promise(done => { resolve = done; }) };
  const opens = Array.from({ length: 10 }, () => f.service.showTurnFile('one', 'round', fileId));
  // Each lookup validates the workspace asynchronously before joining the open.
  const deadline = Date.now() + 3000;
  while (calls.length < 3) { assert(Date.now() < deadline, 'diff open did not start'); await new Promise(done => setImmediate(done)); }
  await new Promise(done => setTimeout(done, 30));
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2][1].toString(), calls[0][1].toString());
  resolve(); await Promise.all(opens); release = undefined;
  fail = true;
  await assert.rejects(f.service.showTurnFile('one', 'round', fileId), /unavailable/);
  fail = false;
  await f.service.showTurnFile('one', 'round', fileId);
  assert.notEqual(calls.at(-1)[1].toString(), calls.at(-2)[1].toString());
});

test('undo failure reports files confirmed restored during journal recovery', async t => {
  const f = await fixture(t); f.turn('round');
  await f.call('edit_workspace_file', { path: 'new.txt', operation: 'create', newText: 'created\n' });
  const persist = f.context.workspaceState.update; let calls = 0;
  f.context.workspaceState.update = async (...args) => {
    if (++calls === 2) throw Error('one-time journal failure');
    return persist(...args);
  };
  await assert.rejects(f.service.undoTurn('one', 'round', f.service.turnSummary('one').round.revision), /已撤销 1\/1/);
  assert.equal(f.service.turnSummary('one').round.undone, true);
  await assert.rejects(fs.stat(path.join(f.root, 'new.txt')), { code: 'ENOENT' });
});

test('undo rechecks a file changed externally after preflight and never overwrites it', async t => {
  const f = await fixture(t); f.turn('round');
  await f.call('edit_workspace_file', { path: 'a.txt', operation: 'create', newText: 'agent\n' });
  const persist = f.context.workspaceState.update; let changed = false;
  f.context.workspaceState.update = async (...args) => {
    await persist(...args);
    if (!changed && args[1].some(record => record.pending && record.turns?.some(turn => turn.undone))) {
      changed = true; await fs.writeFile(path.join(f.root, 'a.txt'), 'external edit during undo\n');
    }
  };
  await assert.rejects(f.service.undoTurn('one', 'round', f.service.turnSummary('one').round.revision), /文件已变化/);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'external edit during undo\n');
  assert.equal(f.service.turnSummary('one').round.undone, false);
  assert.equal(f.service.turnSummary('one').round.files[0].state, 'conflict');
});

test('project inspection finds nested scripts, inherited manager and lifecycle hooks without executing', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'packages/app/src'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', workspaces: ['packages/*'], scripts: { test: 'do not run' } }));
  await fs.writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await fs.writeFile(path.join(f.root, 'packages/app/package.json'), JSON.stringify({ name: 'app', scripts: { 'test:unit': 'node --test', 'pretest:unit': 'node prepare.cjs', build: 'tsc', 'unsafe;name': 'echo data' } }));
  const report = await f.call('inspect_workspace_project', { path: 'packages/app/src/new.ts' });
  assert.equal(report.executed, false); assert.equal(report.projects.length, 2);
  const child = report.projects[0];
  assert.equal(child.manager, 'pnpm'); assert.equal(child.managerInheritedFrom, '.');
  assert.deepEqual(child.tasks[0].argv, ['pnpm', 'run', 'test:unit']);
  assert.deepEqual(child.tasks[0].lifecycleHooks, ['pretest:unit']);
  assert.equal(child.tasks[0].category, 'test');
  assert.deepEqual(child.tasks[3].argv, ['pnpm', 'run', 'unsafe;name']);
  assert.equal((await f.call('list_workspace_changes')).length, 0);
});

test('project inspection reports manager conflicts, malformed manifests and task omissions', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`test:${i}`, 'node --test'])) }));
  await fs.writeFile(path.join(f.root, 'yarn.lock'), ''); await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}');
  const report = await f.call('inspect_workspace_project');
  assert.equal(report.projects[0].managerConflict, true);
  assert.equal(report.projects[0].omittedTasks, 5);
  assert(report.projects[0].tasks.every(task => task.argv === null));
  await fs.writeFile(path.join(f.root, 'package.json'), '{invalid');
  assert.equal((await f.call('inspect_workspace_project')).issues.length, 1);
  await assert.rejects(f.call('inspect_workspace_project', { path: '../outside.txt' }), /超出/);
  await assert.rejects(f.call('inspect_workspace_project', {}, 'one', AbortSignal.abort()));
});

test('project inspection does not offer scripts from unsaved manifests', async t => {
  const f = await fixture(t), file = path.join(f.root, 'package.json');
  await fs.writeFile(file, '{"scripts":{"test":"old"}}');
  const doc = await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(file)); doc.isDirty = true;
  const report = await f.call('inspect_workspace_project');
  assert.equal(report.issues.length, 1); assert.match(report.issues[0].error, /未保存/);
  assert(report.projects.every(project => project.tasks.length === 0));
});

test('cross-file preview finds all invalid edits without writing files or journals', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'a.txt'), 'same same😀');
  const original = await f.call('read_workspace_code', { path: 'a.txt' });
  f.context.workspaceState.update = async () => { throw new Error('preview must not persist'); };
  const results = await f.call('preview_workspace_edits', { files: [
    { path: 'a.txt', operation: 'ranges', expectedHash: original.hash, edits: [{ start: 5, end: 9, newText: 'new' }] },
    { path: 'new/folder/b.txt', operation: 'create', createParents: true, newText: 'new' },
    { path: './a.txt', operation: 'delete', expectedHash: original.hash },
    { path: 'missing', operation: 'delete', expectedHash: 'stale' }
  ] });
  assert.equal(results.status, 'invalid');
  assert.deepEqual(results.results.map(i => i.valid), [true, true, false, false]);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'same same😀');
  await assert.rejects(fs.stat(path.join(f.root, 'new')), { code: 'ENOENT' });
});

test('range edits target repeated text, insertions and reject overlap, stale hashes and split unicode', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'a.txt'), 'same same😀');
  const original = await f.call('read_workspace_code', { path: 'a.txt' });
  const base = { path: 'a.txt', operation: 'ranges', expectedHash: original.hash };
  await assert.rejects(f.call('edit_workspace_file', { ...base, edits: [{ start: 10, end: 11, newText: '' }] }), /代理对/);
  await assert.rejects(f.call('edit_workspace_file', { ...base, edits: [{ start: 0, end: 4, newText: '' }, { start: 1, end: 3, newText: '' }] }), /重叠/);
  await f.call('edit_workspace_file', { ...base, edits: [{ start: 5, end: 9, newText: 'other' }, { start: 11, end: 11, newText: '!' }] });
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'same other😀!');
  await assert.rejects(f.call('edit_workspace_file', { ...base, edits: [{ start: 0, end: 0, newText: 'x' }] }), /版本不匹配/);
  f.choices.push(items => items[0], () => '撤销此文件修改'); await f.service.review('one');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'same same😀');
});

test('rename preview converts cross-file provider ranges and refuses outside or changing source', async t => {
  const f = await fixture(t);
  for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(f.root, name), 'const same = same;\r\n');
  const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } };
  const input = { path: 'a.txt', line: 1, column: 7, newName: 'renamed' };
  const entries = ['a.txt', 'b.txt'].map(name => [f.vscode.Uri.file(path.join(f.root, name)), [{ range, newText: 'renamed' }]]);
  f.vscode.commands.executeCommand = async command => { assert.equal(command, 'vscode.executeDocumentRenameProvider'); return { entries: () => entries }; };
  const proposal = await f.call('preview_workspace_rename', input);
  assert.equal(proposal.files.length, 2); assert.equal(proposal.saved, false);
  assert.equal((await f.call('preview_workspace_edits', { files: proposal.files })).status, 'ready');
  assert.equal((await f.call('edit_workspace_files', { files: proposal.files })).status, 'applied');
  assert.equal(await fs.readFile(path.join(f.root, 'b.txt'), 'utf8'), 'const renamed = same;\r\n');
  entries.push([f.vscode.Uri.file(__filename), [{ range, newText: 'x' }]]);
  await assert.rejects(f.call('preview_workspace_rename', input), /超出/);
  f.vscode.commands.executeCommand = async () => { f.vscode.workspace.textDocuments[0].version++; return { entries: () => entries }; };
  await assert.rejects(f.call('preview_workspace_rename', input), /源文件已变化/);
});

test('patch validates all original ranges before a single saved edit and supports undo', async t => {
  const f = await fixture(t), original = 'const first = 1;\r\nconst second = 2;\r\n';
  await fs.writeFile(path.join(f.root, 'patch.js'), original);
  const read = await f.call('read_workspace_code', { path: 'patch.js' });
  const input = { path: 'patch.js', operation: 'patch', expectedHash: read.hash, edits: [{ oldText: 'first = 1', newText: 'first = 10' }, { oldText: 'second = 2', newText: 'second = 20' }] };
  await assert.rejects(f.call('edit_workspace_file', { ...input, edits: [...input.edits, { oldText: 'missing', newText: 'x' }] }), /仅出现一次/);
  await assert.rejects(f.call('edit_workspace_file', { ...input, edits: [{ oldText: 'first = 1', newText: 'a' }, { oldText: '= 1', newText: 'b' }] }), /重叠/);
  assert.equal(await fs.readFile(path.join(f.root, 'patch.js'), 'utf8'), original);
  assert.deepEqual(await f.call('list_workspace_changes'), []);
  await f.call('edit_workspace_file', input);
  assert.equal(await fs.readFile(path.join(f.root, 'patch.js'), 'utf8'), 'const first = 10;\r\nconst second = 20;\r\n');
  await assert.rejects(f.call('edit_workspace_file', input), /版本不匹配/);
  assert.equal((await f.call('list_workspace_changes')).length, 1);
  f.choices.push(items => items[0], () => '撤销此文件修改');
  await f.service.review('one');
  assert.equal(await fs.readFile(path.join(f.root, 'patch.js'), 'utf8'), original);
});

test('paged reads preserve unicode and reject changed versions and dirty buffers', async t => {
  const f = await fixture(t), file = path.join(f.root, 'page.txt'), original = 'a😀中文\r\nlast';
  await fs.writeFile(file, original);
  let offset = 0, content = '', version;
  do {
    const result = await f.call('read_workspace_code', { path: 'page.txt', offset, limit: 2, ...(version ? { expectedHash: version } : {}) });
    version = result.hash; content += result.content; offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(content, original);
  await fs.writeFile(file, 'changed');
  await assert.rejects(f.call('read_workspace_code', { path: 'page.txt', expectedHash: version }), /版本不匹配/);
  const doc = await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(file)); doc.isDirty = true;
  await assert.rejects(f.call('read_workspace_code', { path: 'page.txt' }), /未保存/);
});

test('batch edits preflight every file before writing and stay reviewable', async t => {
  const f = await fixture(t);
  const invalid = await f.call('edit_workspace_files', { files: [
    { path: 'nested/src/a.js', operation: 'create', createParents: true, newText: 'first' },
    { path: 'nested/src/a.js', operation: 'create', newText: 'duplicate entry for the same file' },
    { path: 'gone.txt', operation: 'replace', expectedHash: 'stale', oldText: 'x', newText: 'y' }
  ] });
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual(invalid.applied, [], 'a preflight failure applies nothing');
  assert.equal(invalid.results[0].valid, true, 'the first entry is individually valid');
  assert.equal(invalid.results[1].valid, false); assert.match(invalid.results[1].error, /只能出现一次/);
  assert.equal(invalid.results[2].valid, false);
  await assert.rejects(fs.stat(path.join(f.root, 'nested/src/a.js')), { code: 'ENOENT' }, 'nothing may be written when preflight fails');
  // A valid batch applies and keeps scoped, reviewable snapshots.
  const result = await f.call('edit_workspace_files', { files: [{ path: 'nested/src/a.js', operation: 'create', createParents: true, newText: 'first' }] });
  assert.equal(result.status, 'applied');
  const changeId = result.completed[0].changeId;
  const after = await f.call('read_workspace_change', { changeId, side: 'after', limit: 2 });
  assert.equal(after.content, 'fi'); assert.equal(after.nextOffset, 2);
  assert.equal((await f.call('read_workspace_change', { changeId, side: 'before' })).exists, false);
  await assert.rejects(f.call('read_workspace_change', { changeId, side: 'after' }, 'another'), /不存在/);
  await fs.writeFile(path.join(f.root, 'nested/src/a.js'), 'external');
  assert.equal((await f.call('read_workspace_change', { changeId, side: 'after' })).state, 'conflict');
  assert.equal(await fs.readFile(path.join(f.root, 'nested/src/a.js'), 'utf8'), 'external');
});

test('replaceAll replaces every occurrence and honours expectedCount', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'r.js'), 'let a = 1;\nlet b = 1;\nlet c = 2;\n');
  const read = await f.call('read_workspace_code', { path: 'r.js' });
  await assert.rejects(f.call('edit_workspace_file', { path: 'r.js', operation: 'replaceAll', oldText: '= 9', newText: '= 0', expectedHash: read.hash }), /不存在/);
  await assert.rejects(f.call('edit_workspace_file', { path: 'r.js', operation: 'replaceAll', oldText: '= 1', newText: '= 0', expectedCount: 3, expectedHash: read.hash }), /不符/);
  assert.equal(await fs.readFile(path.join(f.root, 'r.js'), 'utf8'), 'let a = 1;\nlet b = 1;\nlet c = 2;\n');
  const result = await f.call('edit_workspace_file', { path: 'r.js', operation: 'replaceAll', oldText: '= 1', newText: '= 0', expectedCount: 2, expectedHash: read.hash });
  assert.equal(result.replacements, 2);
  assert.equal(result.diff.added, 2); assert.equal(result.diff.removed, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'r.js'), 'utf8'), 'let a = 0;\nlet b = 0;\nlet c = 2;\n');
});

test('insert places text by line without manual offsets', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'i.txt'), 'one\ntwo\nthree\n');
  const read = await f.call('read_workspace_code', { path: 'i.txt' });
  const head = await f.call('edit_workspace_file', { path: 'i.txt', operation: 'insert', afterLine: 0, newText: 'zero\n', expectedHash: read.hash });
  assert.equal(head.diff.firstChangedLine, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'i.txt'), 'utf8'), 'zero\none\ntwo\nthree\n');
  const mid = await f.call('edit_workspace_file', { path: 'i.txt', operation: 'insert', afterLine: 2, newText: 'middle\n', expectedHash: head.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'i.txt'), 'utf8'), 'zero\none\nmiddle\ntwo\nthree\n');
  await assert.rejects(f.call('edit_workspace_file', { path: 'i.txt', operation: 'insert', afterLine: 99, newText: 'x', expectedHash: mid.hash }), /afterLine/);
  const tail = await f.call('edit_workspace_file', { path: 'i.txt', operation: 'insert', afterLine: 6, newText: 'end\n', expectedHash: mid.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'i.txt'), 'utf8'), 'zero\none\nmiddle\ntwo\nthree\nend\n');
  assert.equal(tail.diff.firstChangedLine, 6);
});

test('applyPatch applies unified diff hunks located by context', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'p.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const read = await f.call('read_workspace_code', { path: 'p.js' });
  const single = ['@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 20;', ' const c = 3;', ''].join('\n');
  const result = await f.call('edit_workspace_file', { path: 'p.js', operation: 'applyPatch', patch: single, expectedHash: read.hash });
  assert.equal(result.hunks, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'p.js'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  const next = await f.call('read_workspace_code', { path: 'p.js' });
  const two = ['@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 0;', ' const b = 20;', '@@ -3,1 +3,2 @@', ' const c = 3;', '+const d = 4;', ''].join('\n');
  const applied = await f.call('edit_workspace_file', { path: 'p.js', operation: 'applyPatch', patch: two, expectedHash: next.hash });
  assert.equal(applied.hunks, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'p.js'), 'utf8'), 'const a = 0;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n');
  const stale = await f.call('read_workspace_code', { path: 'p.js' });
  await assert.rejects(f.call('edit_workspace_file', { path: 'p.js', operation: 'applyPatch', patch: '@@ -1,1 +1,1 @@\n-const z = 9;\n+const z = 0;\n', expectedHash: stale.hash }), /不匹配/);
  assert.equal(await fs.readFile(path.join(f.root, 'p.js'), 'utf8'), 'const a = 0;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n');
});

test('replaceLines replaces and inserts by line range', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'l.txt'), 'one\ntwo\nthree\nfour\n');
  const read = await f.call('read_workspace_code', { path: 'l.txt' });
  const rep = await f.call('edit_workspace_file', { path: 'l.txt', operation: 'replaceLines', startLine: 2, endLine: 3, newText: 'TWO\nTHREE', expectedHash: read.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'l.txt'), 'utf8'), 'one\nTWO\nTHREE\nfour\n');
  assert.equal(rep.diff.added, 2); assert.equal(rep.diff.removed, 2);
  const ins = await f.call('edit_workspace_file', { path: 'l.txt', operation: 'replaceLines', startLine: 1, endLine: 0, newText: 'head\n', expectedHash: rep.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'l.txt'), 'utf8'), 'head\none\nTWO\nTHREE\nfour\n');
  await assert.rejects(f.call('edit_workspace_file', { path: 'l.txt', operation: 'replaceLines', startLine: 9, endLine: 9, newText: 'x', expectedHash: ins.hash }), /startLine/);
});

test('replace occurrence targets the Nth match without requiring uniqueness', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'o.txt'), 'x = 1;\nx = 1;\nx = 1;\n');
  const read = await f.call('read_workspace_code', { path: 'o.txt' });
  await assert.rejects(f.call('edit_workspace_file', { path: 'o.txt', operation: 'replace', oldText: 'x = 1', newText: 'x = 2', expectedHash: read.hash }), /仅出现一次/);
  const second = await f.call('edit_workspace_file', { path: 'o.txt', operation: 'replace', oldText: 'x = 1', newText: 'x = 2', occurrence: 2, expectedHash: read.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'o.txt'), 'utf8'), 'x = 1;\nx = 2;\nx = 1;\n');
  await assert.rejects(f.call('edit_workspace_file', { path: 'o.txt', operation: 'replace', oldText: 'x = 1', newText: 'x = 3', occurrence: 9, expectedHash: second.hash }), /少于/);
});

test('successful edits suggest the project checks to run next', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@10.0.0', scripts: { lint: 'eslint .', test: 'node --test' } }));
  await fs.writeFile(path.join(f.root, 'pkg.js'), 'const n = 1;\n');
  const read = await f.call('read_workspace_code', { path: 'pkg.js' });
  const result = await f.call('edit_workspace_file', { path: 'pkg.js', operation: 'replace', oldText: 'n = 1', newText: 'n = 2', expectedHash: read.hash });
  assert.equal(result.checks.validate, 'validate_workspace_changes');
  assert.equal(result.checks.manager, 'npm');
  assert.equal(result.checks.cwd, f.root);
  assert.deepEqual(result.checks.check, [{ name: 'lint', argv: ['npm', 'run', 'lint'] }]);
  assert.deepEqual(result.checks.test, [{ name: 'test', argv: ['npm', 'run', 'test'] }]);
  assert.match(result.checks.note, /nothing was executed/);
});

test('dryRun validates and returns a diff without writing or recording a change', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'd.txt'), 'hello\nworld\n');
  const read = await f.call('read_workspace_code', { path: 'd.txt' });
  const preview = await f.call('edit_workspace_file', { path: 'd.txt', operation: 'replace', oldText: 'world', newText: 'there', expectedHash: read.hash, dryRun: true });
  assert.equal(preview.saved, false);
  assert.equal(preview.changed, true);
  assert.match(preview.diff.snippet, /there/);
  assert.notEqual(preview.beforeHash, preview.afterHash);
  assert.equal(await fs.readFile(path.join(f.root, 'd.txt'), 'utf8'), 'hello\nworld\n');
  assert.deepEqual(await f.call('list_workspace_changes'), []);
});

test('hash mismatches report the current hash and size for a cheap retry', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'h.txt'), 'one\n');
  const read = await f.call('read_workspace_code', { path: 'h.txt' });
  await fs.writeFile(path.join(f.root, 'h.txt'), 'two\n');
  const stale = await f.call('edit_workspace_file', { path: 'h.txt', operation: 'replace', oldText: 'two', newText: 'three', expectedHash: read.hash }).then(() => null, error => error);
  assert(stale, 'a stale hash must reject');
  assert.equal(stale.details.reason, 'hash_mismatch');
  assert.equal(stale.details.currentHash, (await f.call('read_workspace_code', { path: 'h.txt' })).hash);
  assert.equal(stale.details.currentBytes, 4);
});

test('a missing expectedHash is named as such, and edits return the next hash to chain', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'chain.txt'), 'a\nb\n');
  const missing = await f.call('edit_workspace_file', { path: 'chain.txt', operation: 'replace', oldText: 'a', newText: 'A' }).then(() => null, error => error);
  assert(missing, 'an edit without expectedHash must reject');
  assert.equal(missing.details.reason, 'missing_hash');
  assert.match(missing.message, /缺少 expectedHash/);
  assert.ok(missing.details.currentHash);
  const read = await f.call('read_workspace_code', { path: 'chain.txt' });
  const first = await f.call('edit_workspace_file', { path: 'chain.txt', operation: 'replace', oldText: 'a', newText: 'A', expectedHash: read.hash });
  assert.equal(first.nextExpectedHash, first.hash);
  const second = await f.call('edit_workspace_file', { path: 'chain.txt', operation: 'replace', oldText: 'b', newText: 'B', expectedHash: first.nextExpectedHash });
  assert.equal(second.nextExpectedHash, second.hash);
  assert.equal(await fs.readFile(path.join(f.root, 'chain.txt'), 'utf8'), 'A\nB\n');
});

test('parent creation rejects invalid content before creating directories', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('edit_workspace_file', { path: 'invalid/deep/a.js', operation: 'create', createParents: true, newText: 'mixed\r\nline\n' }), /换行符/);
  await assert.rejects(fs.stat(path.join(f.root, 'invalid')), { code: 'ENOENT' });
});

test('read includes scoped instructions in ancestor order and marks oversized instructions', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'src/deep'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'root conventions');
  await fs.writeFile(path.join(f.root, 'src/AGENTS.md'), 'src conventions');
  await fs.writeFile(path.join(f.root, 'src/deep/AGENTS.md'), 'x'.repeat(65536));
  const read = await f.call('read_workspace_code', { path: 'src/deep/new.js' });
  assert.equal(read.exists, false);
  assert.deepEqual(read.projectInstructions.slice(0, 2).map(i => i.content), ['root conventions', 'src conventions']);
  assert.equal(read.projectInstructions[2].omitted, true);
});

test('navigation handles location links, nested symbols, pagination and workspace boundaries', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'source.js'), 'const a = 1;\n');
  const uri = f.vscode.Uri.file(path.join(f.root, 'source.js'));
  const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } };
  let invoked;
  f.vscode.commands.executeCommand = async (command, _uri, position) => {
    invoked = { command, position };
    return [{ targetUri: uri, targetSelectionRange: range }, { uri, range }, { uri: f.vscode.Uri.file(__filename), range }];
  };
  const input = { path: 'source.js', action: 'definition', line: 1, column: 7 };
  const result = await f.call('navigate_workspace_code', input);
  assert.equal(invoked.command, 'vscode.executeDefinitionProvider');
  assert.deepEqual({ ...invoked.position }, { line: 0, character: 6 });
  assert.equal(result.total, 1); assert.equal(result.omitted, 1);
  assert.equal(result.results[0].column, 7);
  for (const [action, command] of [['implementation', 'vscode.executeImplementationProvider'], ['typeDefinition', 'vscode.executeTypeDefinitionProvider']]) {
    assert.equal((await f.call('navigate_workspace_code', { ...input, action })).total, 1);
    assert.equal(invoked.command, command);
  }
  f.vscode.commands.executeCommand = async () => [{ name: 'parent', kind: 4, range, children: [{ name: 'child', kind: 11, range }] }];
  const first = await f.call('navigate_workspace_code', { path: 'source.js', action: 'symbols', limit: 1 });
  assert.equal(first.nextOffset, 1);
  const second = await f.call('navigate_workspace_code', { path: 'source.js', action: 'symbols', offset: first.nextOffset });
  assert.equal(second.results[0].container, 'parent');
  assert.equal(second.nextOffset, null);
  f.vscode.commands.executeCommand = async () => undefined;
  assert.equal((await f.call('navigate_workspace_code', input)).providerResult, 'unavailable_or_empty');
});

test('navigation rejects invalid positions, dirty or changing documents and cancels hanging providers', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'source.js'), 'const a = 1;');
  const input = { path: 'source.js', action: 'references', line: 1, column: 7 };
  await assert.rejects(f.call('navigate_workspace_code', { ...input, line: 9 }), /位置/);
  const doc = f.vscode.workspace.textDocuments[0];
  doc.isDirty = true;
  await assert.rejects(f.call('navigate_workspace_code', input), /未保存/);
  doc.isDirty = false;
  f.vscode.commands.executeCommand = async () => { doc.version++; return []; };
  await assert.rejects(f.call('navigate_workspace_code', input), /文件已变化/);
  const controller = new AbortController();
  f.vscode.commands.executeCommand = () => { controller.abort(new Error('cancel navigation')); return new Promise(() => {}); };
  await assert.rejects(f.call('navigate_workspace_code', input, 'one', controller.signal), /cancel navigation/);
});

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

test('directory junctions are rejected and oversized files are readable but not editable', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'actual'));
  await fs.symlink(path.join(f.root, 'actual'), path.join(f.root, 'linked'), 'junction');
  await assert.rejects(f.call('edit_workspace_file', { path: 'linked/file.txt', operation: 'create', newText: 'no' }), /符号链接/);
  // A file above the whole-file limit is still readable page by page...
  const large = 'l'.repeat(1024 * 1024 + 10);
  await fs.writeFile(path.join(f.root, 'large.txt'), large);
  const first = await f.call('read_workspace_code', { path: 'large.txt', offset: 0, limit: 100 });
  assert.equal(first.large, true); assert.equal(first.editable, false);
  assert.equal(first.content.length, 100); assert.equal(first.totalCharacters, large.length);
  assert.equal(first.nextOffset, 100); assert.equal(first.hashKind, 'sha256-window');
  assert.equal(first.hash, first.hash);
  const deep = await f.call('read_workspace_code', { path: 'large.txt', offset: 500000, limit: 32, lineNumbers: true });
  assert.equal(deep.content, large.slice(500000, 500032));
  assert.equal(deep.startLine, 1);
  // ...but whole-file editing is refused.
  await assert.rejects(f.call('edit_workspace_file', { path: 'large.txt', operation: 'replace', oldText: 'll', newText: 'x', expectedHash: first.hash }), /1 MiB/);
});

test('windowed large reads stay valid UTF-8 and never split surrogate pairs', async t => {
  const f = await fixture(t);
  const source = 'a'.repeat(1024 * 1024) + '😀中文';
  await fs.writeFile(path.join(f.root, 'big.txt'), source);
  const at = 1024 * 1024;
  const window = await f.call('read_workspace_code', { path: 'big.txt', offset: at, limit: 4 });
  assert.equal(window.content.isWellFormed(), true);
  assert.equal(source.slice(window.offset, window.offset + window.content.length), window.content);
  // Invalid UTF-8 is rejected instead of silently replaced.
  await fs.writeFile(path.join(f.root, 'bad.txt'), Buffer.concat([Buffer.from('x'.repeat(1024 * 1024)), Buffer.from([0xff, 0xfe, 0x80])]));
  await assert.rejects(f.call('read_workspace_code', { path: 'bad.txt', offset: 0, limit: 16 }), /UTF-8/);
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

test('missing code files return exists:false without throwing', async t => {
  const f = await fixture(t);
  const missing = await f.call('read_workspace_code', { path: 'never.js' });
  assert.equal(missing.exists, false);
  assert.equal(missing.content, null);
  assert.equal(missing.hash, null);
  assert.match(missing.guidance, /not a tool failure/);
});

test('withLines derives 1-based startLine and splits CRLF without disturbing offsets', async t => {
  assert.deepEqual(withLines('a\nb\r\nc', 0, 'a\nb\r\nc'), { startLine: 1, lines: ['a', 'b', 'c'], contentWithLineNumbers: '1: a\n2: b\n3: c' });
  assert.equal(withLines('line1\nline2\nline3', 6, 'line2\nline3').startLine, 2);
  assert.deepEqual(withLines('line1\r\nline2\r\nline3', 7, 'line2\r\nline3').lines, ['line2', 'line3']);
  assert.equal(withLines('line1\r\nline2', 7, 'line2').startLine, 2);
  const emoji = 'a\uD83D\uDE00\nnext';
  assert.deepEqual(withLines(emoji, 0, emoji).lines, ['a\uD83D\uDE00', 'next']);
});

test('read_workspace_code lineNumbers adds derived fields and keeps pagination semantics', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'lines.txt'), 'a\nb\r\nc\n\uD83D\uDE00d');
  const plain = await f.call('read_workspace_code', { path: 'lines.txt' });
  assert.equal(plain.content, 'a\nb\r\nc\n\uD83D\uDE00d');
  assert.equal(plain.truncated, false);
  assert.equal(plain.startLine, undefined);
  assert.equal(plain.lines, undefined);
  assert.equal(plain.contentWithLineNumbers, undefined);
  const numbered = await f.call('read_workspace_code', { path: 'lines.txt', lineNumbers: true });
  assert.equal(numbered.startLine, 1);
  assert.deepEqual(numbered.lines, ['a', 'b', 'c', '\uD83D\uDE00d']);
  assert.equal(numbered.contentWithLineNumbers, '1: a\n2: b\n3: c\n4: \uD83D\uDE00d');
  assert.equal(numbered.content, plain.content);
  assert.equal(numbered.hash, plain.hash);
  assert.equal(numbered.truncated, false);
  let offset = 0, content = '', numberedContent = '', version;
  do {
    const result = await f.call('read_workspace_code', { path: 'lines.txt', offset, limit: 3, lineNumbers: true, ...(version ? { expectedHash: version } : {}) });
    version = result.hash;
    content += result.content;
    numberedContent += result.contentWithLineNumbers + '|';
    assert.equal(typeof result.startLine, 'number');
    assert.ok(Array.isArray(result.lines));
    assert.equal(result.offset !== undefined, true);
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(content, 'a\nb\r\nc\n\uD83D\uDE00d');
  await assert.rejects(f.call('read_workspace_code', { path: 'lines.txt', lineNumbers: 'yes' }), /lineNumbers/);
});

test('replace tolerates CRLF/LF and trailing whitespace, and aligns the replacement EOL', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'tol.js'), 'const a = 1;   \r\nconst b = 2;\r\n');
  const read = await f.call('read_workspace_code', { path: 'tol.js' });
  // LF oldText with no trailing spaces against a CRLF file with trailing spaces.
  const result = await f.call('edit_workspace_file', { path: 'tol.js', operation: 'replace',
    oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 10;\nconst b = 2;', expectedHash: read.hash });
  assert.equal(result.match, 'trimEnd');
  assert.equal(await fs.readFile(path.join(f.root, 'tol.js'), 'utf8'), 'const a = 10;\r\nconst b = 2;\r\n');
  // LF replacement text is aligned to the file's CRLF instead of being rejected.
  const next = await f.call('read_workspace_code', { path: 'tol.js' });
  const aligned = await f.call('edit_workspace_file', { path: 'tol.js', operation: 'replaceLines',
    startLine: 1, endLine: 1, newText: 'let a = 10;\nlet c = 3;', expectedHash: next.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'tol.js'), 'utf8'), 'let a = 10;\r\nlet c = 3;\r\nconst b = 2;\r\n');
  assert.equal(aligned.saved, true);
});

test('insert after the last line works even without a trailing newline', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'noeol.txt'), 'first');
  const read = await f.call('read_workspace_code', { path: 'noeol.txt' });
  await f.call('edit_workspace_file', { path: 'noeol.txt', operation: 'insert', afterLine: 1, newText: 'second\n', expectedHash: read.hash });
  assert.equal(await fs.readFile(path.join(f.root, 'noeol.txt'), 'utf8'), 'first\nsecond\n');
});

test('replaceAll tolerates CRLF/LF and trailing whitespace when counting occurrences', async t => {
  const f = await fixture(t);
  // Uniform CRLF file; the first occurrence has trailing spaces and oldText is LF.
  await fs.writeFile(path.join(f.root, 'all.js'), 'a  \r\nb\r\na\r\nb\r\n');
  const read = await f.call('read_workspace_code', { path: 'all.js' });
  const result = await f.call('edit_workspace_file', { path: 'all.js', operation: 'replaceAll', oldText: 'a\nb', newText: 'a\nB', expectedCount: 2, expectedHash: read.hash });
  assert.equal(result.replacements, 2);
  assert.equal(result.match, 'trimEnd');
  assert.equal(await fs.readFile(path.join(f.root, 'all.js'), 'utf8'), 'a\r\nB\r\na\r\nB\r\n');
  // Without expectedCount the tolerant sweep still replaces both occurrences.
  const next = await f.call('read_workspace_code', { path: 'all.js' });
  const auto = await f.call('edit_workspace_file', { path: 'all.js', operation: 'replaceAll', oldText: 'a\nB', newText: 'a\nC', expectedHash: next.hash });
  assert.equal(auto.replacements, 2);
  // A count that can never match explains the exact and tolerant numbers.
  const version = (await f.call('read_workspace_code', { path: 'all.js' })).hash;
  const failure = await f.call('edit_workspace_file', { path: 'all.js', operation: 'replaceAll', oldText: 'a\nC', newText: 'z', expectedCount: 3, expectedHash: version }).then(() => null, error => error);
  assert(failure);
  assert.match(failure.message, /与 expectedCount=3 不符/);
  assert.match(failure.message, /去掉 expectedCount/);
});

test('indentation-insensitive replace and applyPatch reindent to the file', async t => {
  const f = await fixture(t);
  const original = 'class C {\n    run() {\n        if (x) {\n            go();\n        }\n    }\n}\n';
  await fs.writeFile(path.join(f.root, 'ind.js'), original);
  const read = await f.call('read_workspace_code', { path: 'ind.js' });
  // The model writes the block with a 4-space base instead of the file's 8.
  const replaced = await f.call('edit_workspace_file', { path: 'ind.js', operation: 'replace',
    oldText: '    if (x) {\n        go();\n    }',
    newText: '    if (x) {\n        go();\n        stop();\n    }',
    expectedHash: read.hash });
  assert.equal(replaced.match, 'trim');
  assert.equal(await fs.readFile(path.join(f.root, 'ind.js'), 'utf8'),
    'class C {\n    run() {\n        if (x) {\n            go();\n            stop();\n        }\n    }\n}\n');
  // applyPatch with a uniformly under-indented hunk is re-indented too. Each body
  // line keeps its unified-diff marker, then the 4-space base indentation.
  const next = await f.call('read_workspace_code', { path: 'ind.js' });
  const patch = ['@@ -3,4 +3,4 @@', '     if (x) {', '         go();', '-        stop();', '+        halt();', '     }', ''].join('\n');
  const patched = await f.call('edit_workspace_file', { path: 'ind.js', operation: 'applyPatch', patch, expectedHash: next.hash });
  assert.equal(patched.match, 'fuzzy');
  assert.equal(await fs.readFile(path.join(f.root, 'ind.js'), 'utf8'),
    'class C {\n    run() {\n        if (x) {\n            go();\n            halt();\n        }\n    }\n}\n');
  // Indentation that differs non-uniformly is refused rather than mis-indented.
  const version = (await f.call('read_workspace_code', { path: 'ind.js' })).hash;
  const failure = await f.call('edit_workspace_file', { path: 'ind.js', operation: 'replace',
    oldText: 'if (x) {\n            go();\n            halt();\n}', newText: 'if (x) {\nrun();\n}', expectedHash: version }).then(() => null, error => error);
  assert(failure);
  assert.match(failure.message, /缩进/);
});

test('edit results include a re-applicable unified diff', async t => {
  const f = await fixture(t);
  const content = 'one\ntwo\nthree\nfour\nfive\n';
  await fs.writeFile(path.join(f.root, 'd.js'), content);
  const read = await f.call('read_workspace_code', { path: 'd.js' });
  const result = await f.call('edit_workspace_file', { path: 'd.js', operation: 'replace', oldText: 'three', newText: 'THREE', expectedHash: read.hash });
  assert.match(result.diff.patch, /^@@ -1,5 \+1,5 @@/);
  assert.match(result.diff.patch, /^-three$/m);
  assert.match(result.diff.patch, /^\+THREE$/m);
  // The reported patch re-applies cleanly to an identical file.
  await fs.writeFile(path.join(f.root, 'e.js'), content);
  const eread = await f.call('read_workspace_code', { path: 'e.js' });
  const applied = await f.call('edit_workspace_file', { path: 'e.js', operation: 'applyPatch', patch: result.diff.patch, expectedHash: eread.hash });
  assert.equal(applied.hunks, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'e.js'), 'utf8'), await fs.readFile(path.join(f.root, 'd.js'), 'utf8'));
});

test('an ambiguous replace reports the candidate line numbers and occurrence fixes it', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'amb.js'), 'const v = 1;\nrun();\nconst v = 2;\nrun();\n');
  const read = await f.call('read_workspace_code', { path: 'amb.js' });
  const failure = await f.call('edit_workspace_file', { path: 'amb.js', operation: 'replace', oldText: 'run();', newText: 'go();', expectedHash: read.hash }).then(() => null, error => error);
  assert(failure, 'an ambiguous replace must reject');
  assert.match(failure.message, /匹配到 2 处：第 2、4 行/);
  assert.equal(failure.details.reason, 'ambiguous_match');
  assert.deepEqual(failure.details.candidates.map(item => item.line), [2, 4]);
  // occurrence:N resolves it in a single step.
  const fixed = await f.call('edit_workspace_file', { path: 'amb.js', operation: 'replace', oldText: 'run();', newText: 'go();', occurrence: 2, expectedHash: read.hash });
  assert.equal(fixed.changed, true);
  assert.equal(await fs.readFile(path.join(f.root, 'amb.js'), 'utf8'), 'const v = 1;\nrun();\nconst v = 2;\ngo();\n');
});

test('dryRun returns the complete patch without writing', async t => {
  const f = await fixture(t);
  const content = 'a\nb\nc\n';
  await fs.writeFile(path.join(f.root, 'dry.js'), content);
  const read = await f.call('read_workspace_code', { path: 'dry.js' });
  const preview = await f.call('edit_workspace_file', { path: 'dry.js', operation: 'replace', oldText: 'b', newText: 'B', expectedHash: read.hash, dryRun: true });
  assert.equal(preview.saved, false);
  assert.match(preview.patch, /^@@ -1,3 \+1,3 @@/);
  assert.match(preview.patch, /^-b$/m);
  assert.match(preview.patch, /^\+B$/m);
  assert.equal(await fs.readFile(path.join(f.root, 'dry.js'), 'utf8'), content);
  // A create preview shows an all-add patch.
  const created = await f.call('edit_workspace_file', { path: 'new.txt', operation: 'create', newText: 'x\ny\n', dryRun: true });
  assert.match(created.patch, /^@@ -0,0 \+1,2 @@/);
  assert.match(created.patch, /^\+x$/m);
  assert.match(created.patch, /^\+y$/m);
});

test('applyPatch inserts at the top with no context and accepts unmarked context lines', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'ins.js'), 'const a = 1;\n');
  const read = await f.call('read_workspace_code', { path: 'ins.js' });
  const insert = ['@@ -0,0 +1,2 @@', '+// header one', '+// header two', ''].join('\n');
  const inserted = await f.call('edit_workspace_file', { path: 'ins.js', operation: 'applyPatch', patch: insert, expectedHash: read.hash });
  assert.equal(inserted.hunks, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'ins.js'), 'utf8'), '// header one\n// header two\nconst a = 1;\n');
  // Context lines without the leading space marker are still accepted.
  const next = await f.call('read_workspace_code', { path: 'ins.js' });
  const unmarked = ['@@ -2,2 +2,2 @@', '// header two', '-const a = 1;', '+const a = 2;'].join('\n');
  const patched = await f.call('edit_workspace_file', { path: 'ins.js', operation: 'applyPatch', patch: unmarked, expectedHash: next.hash });
  assert.equal(patched.hunks, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'ins.js'), 'utf8'), '// header one\n// header two\nconst a = 2;\n');
});

test('applyPatch reports an already-applied hunk instead of failing, and hints on a real mismatch', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'idem.js'), 'const a = 1;\nconst b = 2;\n');
  const read = await f.call('read_workspace_code', { path: 'idem.js' });
  const patch = ['@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 20;', ''].join('\n');
  await f.call('edit_workspace_file', { path: 'idem.js', operation: 'applyPatch', patch, expectedHash: read.hash });
  const current = await f.call('read_workspace_code', { path: 'idem.js' });
  const again = await f.call('edit_workspace_file', { path: 'idem.js', operation: 'applyPatch', patch, expectedHash: current.hash });
  assert.equal(again.already_applied, 1);
  assert.equal(again.changed, false);
  assert.equal(await fs.readFile(path.join(f.root, 'idem.js'), 'utf8'), 'const a = 1;\nconst b = 20;\n');
  // A genuinely wrong hunk fails and points at the nearest content.
  const version = (await f.call('read_workspace_code', { path: 'idem.js' })).hash;
  const bad = ['@@ -1,1 +1,1 @@', '-const zzz = 9;', '+const zzz = 0;', ''].join('\n');
  const failure = await f.call('edit_workspace_file', { path: 'idem.js', operation: 'applyPatch', patch: bad, expectedHash: version }).then(() => null, error => error);
  assert(failure, 'a mismatched patch must reject');
  assert.match(failure.message, /补丁上下文与当前文件不匹配/);
  assert.match(failure.message, /第 1 行/);
});
