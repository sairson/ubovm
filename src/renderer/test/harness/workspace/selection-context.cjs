'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { captureSelection } = require('../../../harness/workspace/selection-context.cjs');

function fixture(text = 'outside\nselected 中文\nlast') {
  const lines = () => text.split('\n');
  const position = (line, character) => ({ line, character });
  const selection = { start: position(1, 0), end: position(2, 0), isEmpty: false };
  const document = { uri: { scheme: 'file', fsPath: 'C:\\project\\sample.js' }, languageId: 'javascript', version: 3, isDirty: true,
    getText(range) { if (!range) return text; const offset = p => lines().slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character; return text.slice(offset(range.start), offset(range.end)); } };
  const vscode = { window: { activeTextEditor: { document, selections: [selection] } }, workspace: { asRelativePath: () => 'sample.js', textDocuments: [] } };
  return { vscode, document, selection, change: value => { text = value; document.version++; } };
}

test('selection snapshot preserves exact text, exclusive positions, language and unsaved state', () => {
  const f = fixture();
  const result = captureSelection(f.vscode);
  assert.equal(result.snapshot.content, 'selected 中文\n');
  assert.equal(result.rangeLabel, 'L2');
  assert.equal(result.snapshot.ranges[0].endLine, 3);
  assert.equal(result.snapshot.ranges[0].endColumn, 1);
  assert.equal(result.snapshot.languageId, 'javascript');
  assert.equal(result.snapshot.unsaved, true);
  f.change('different file');
  assert.equal(result.snapshot.content, 'selected 中文\n');
});

test('multiple selections, empty selection and bounded context', () => {
  const f = fixture();
  f.vscode.window.activeTextEditor.selections.push({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, isEmpty: false });
  assert.equal(captureSelection(f.vscode).snapshot.ranges.length, 2);
  f.vscode.window.activeTextEditor.selections = [];
  assert.throws(() => captureSelection(f.vscode), /先选中/);
  f.vscode.window.activeTextEditor.selections = [f.selection];
  f.change('first\n' + 'x'.repeat(16001) + '\nlast');
  assert.throws(() => captureSelection(f.vscode), /16,000/);
});

test('explicit untitled and diff selections are snapshots, unsupported resources are rejected', () => {
  const f = fixture();
  for (const scheme of ['untitled', 'ubovm-diff']) {
    f.document.uri = { scheme, toString: () => `${scheme}:/example` };
    assert.equal(captureSelection(f.vscode).snapshot.file, `${scheme}:/example`);
  }
  f.document.uri.scheme = 'output';
  assert.throws(() => captureSelection(f.vscode), /代码编辑器/);
});

// Exercise the actual extension closures, with only their surrounding host mocked.
function hostFixture() {
  const f = fixture();
  const source = readFileSync(path.join(__dirname, '../../../extension.cjs'), 'utf8');
  const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  let current = 'one', busy = false, focus = 0, release;
  const contexts = new Map(), sessions = new Map([['one', { id: 'one' }], ['two', { id: 'two' }]]);
  const gate = new Promise(resolve => { release = resolve; });
  const sandbox = { vscode: f.vscode, captureSelection, structuredClone, fileContexts: contexts, messageQueue: gate,
    sessions: { current: () => sessions.get(current), get: id => sessions.get(id) },
    ensureDefaultWorkspace: async () => {},
    assertIdle: () => { if (busy) throw new Error('busy'); }, publishState() {}, workspaceName: () => 'project',
    openAssistant: async () => { focus++; f.vscode.window.activeTextEditor = undefined; }, welcome: { webview: { postMessage: async () => {} } } };
  vm.createContext(sandbox);
  vm.runInContext(extract('  async function executionContext(', '  function saveGoal(') + extract('  async function attachSelection(', '  async function attachFile('), sandbox);
  return { ...f, sandbox, contexts, release, switchSession: () => { current = 'two'; }, busy: () => { busy = true; }, focused: () => focus };
}

test('context reaches execution as selected snapshot even after editor changes or loses focus', async () => {
  const f = hostFixture();
  const added = f.sandbox.attachSelection();
  f.change('changed before queue completed'); f.release(); await added;
  assert.equal(f.focused(), 1);
  const context = await f.sandbox.executionContext({ id: 'one' });
  assert.equal(context.content, 'selected 中文\n');
  assert.equal(context.source, 'selection');
  context.ranges[0].content = 'mutated';
  assert.equal((await f.sandbox.executionContext({ id: 'one' })).ranges[0].content, 'selected 中文\n');
  f.contexts.set('one', null);
  assert.equal((await f.sandbox.executionContext({ id: 'one' })).content, undefined);
});

test('queued attachments stay with the original conversation and reject a newly busy session', async () => {
  const f = hostFixture();
  const added = f.sandbox.attachSelection();
  f.switchSession(); f.release(); await added;
  assert(f.contexts.has('one')); assert(!f.contexts.has('two')); assert.equal(f.focused(), 0);
  const g = hostFixture();
  const pending = g.sandbox.attachSelection();
  g.busy(); g.release(); await assert.rejects(pending, /busy/);
  assert.equal(g.contexts.size, 0);
});
