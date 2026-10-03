'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCodingService } = require('../../../harness/coding/coding-service.cjs');

async function fixture(t, executeCommand) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'ubovm-chain-'));
  const values = new Map(), documents = [];
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const vscode = {
    Uri: { file: uri },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
      registerTextDocumentContentProvider() { return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(target) {
        let doc = documents.find(doc => doc.uri.fsPath === target.fsPath);
        if (!doc) {
          const text = await fs.readFile(target.fsPath, 'utf8');
          doc = {
            uri: target, version: 1, isDirty: false, text,
            getText() { return this.text; },
            get lineCount() { return this.text.split(/\r?\n/).length; },
            lineAt(line) { return { text: this.text.split(/\r?\n/)[line] ?? '' }; }
          };
          documents.push(doc);
        }
        return doc;
      }
    },
    commands: { executeCommand: executeCommand ?? (async () => []) }
  };
  const context = { workspaceState: { get: (_key, fallback) => structuredClone(values.get(_key) ?? fallback), async update(key, value) { values.set(key, structuredClone(value)); } } };
  const service = createCodingService(vscode, context, {});
  const call = async (input = {}, signal) => (await service.tools('one').find(tool => tool.name === 'analyze_workspace_call_chain').execute('test', input, signal)).details;
  t.after(async () => { service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    root, vscode, documents, call,
    write: (name, text) => fs.writeFile(path.join(root, name), text),
    loc: (rel, line, column) => ({
      uri: uri(path.join(root, rel)),
      range: { start: { line: line - 1, character: column - 1 }, end: { line: line - 1, character: column } }
    })
  };
}

test('analyze_workspace_call_chain follows definitions within depth and node caps', async t => {
  const graph = {
    'a.js:1:1': [['b.js', 1, 1]],
    'b.js:1:1': [['c.js', 1, 1]],
    'c.js:1:1': [['d.js', 1, 1]]
  };
  let f;
  f = await fixture(t, async (name, fileUri, position) => {
    if (name !== 'vscode.executeDefinitionProvider' && name !== 'vscode.executeImplementationProvider') return [];
    const rel = path.relative(f.root, fileUri.fsPath).split(path.sep).join('/');
    const key = `${rel}:${position.line + 1}:${position.character + 1}`;
    return (graph[key] ?? []).map(([r, l, c]) => f.loc(r, l, c));
  });
  await f.write('a.js', 'start()\n');
  await f.write('b.js', 'mid()\n');
  await f.write('c.js', 'end()\n');
  await f.write('d.js', 'extra()\n');
  const details = await f.call({ path: 'a.js', line: 1, column: 1, direction: 'callees', maxDepth: 2, maxNodes: 10 });
  assert.equal(details.start.path, 'a.js');
  assert.deepEqual(details.nodes.map(node => node.path), ['a.js', 'b.js', 'c.js']);
  assert.equal(details.truncated, false);
  assert(details.edges.some(edge => edge.via === 'callees'));
});

test('analyze_workspace_call_chain omits results outside workspace roots', async t => {
  const outsideDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ubovm-chain-secret-'));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  const outsideFile = path.join(outsideDir, 'secret.js');
  await fs.writeFile(outsideFile, 'secret()\n');
  const f = await fixture(t, async () => [{
    uri: { fsPath: outsideFile, scheme: 'file' },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  }]);
  await f.write('a.js', 'start()\n');
  const details = await f.call({ path: 'a.js', line: 1, column: 1, direction: 'callees' });
  assert.equal(details.nodes.length, 1);
  assert.equal(details.omitted >= 1, true);
});

test('analyze_workspace_call_chain rejects dirty buffers and respects abort', async t => {
  const f = await fixture(t);
  await f.write('a.js', 'start()\n');
  await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(path.join(f.root, 'a.js')));
  f.documents[0].isDirty = true;
  await assert.rejects(f.call({ path: 'a.js', line: 1, column: 1 }), /未保存/);
  f.documents[0].isDirty = false;
  const controller = new AbortController();
  controller.abort(new Error('cancel chain'));
  await assert.rejects(f.call({ path: 'a.js', line: 1, column: 1 }, controller.signal), /cancel chain/);
});

test('analyze_workspace_call_chain truncates when maxNodes is reached', async t => {
  let f;
  f = await fixture(t, async (name, fileUri) => {
    if (name !== 'vscode.executeDefinitionProvider') return [];
    const rel = path.relative(f.root, fileUri.fsPath).split(path.sep).join('/');
    if (rel !== 'a.js') return [];
    return [f.loc('b.js', 1, 1), f.loc('c.js', 1, 1), f.loc('d.js', 1, 1)];
  });
  await f.write('a.js', 'start()\n');
  await f.write('b.js', 'b()\n');
  await f.write('c.js', 'c()\n');
  await f.write('d.js', 'd()\n');
  const details = await f.call({ path: 'a.js', line: 1, column: 1, direction: 'callees', maxDepth: 3, maxNodes: 2 });
  assert.equal(details.nodes.length, 2);
  assert.equal(details.truncated, true);
});
