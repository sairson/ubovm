'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createWorkspaceSearch } = require('../harness/workspace-search.cjs');
const { createWorkspaceValidation } = require('../harness/workspace-validation.cjs');
const appRoot = path.resolve('.runtime/vscodium-1.135.06055/resources/app');

test('search and validation resolve the originating session workspace independently of the window', async t => {
  const f = await fixture(t);
  const a = path.join(f.root, 'a'), b = path.join(f.root, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'only-a.json'), '{}');
  await fs.writeFile(path.join(b, 'only-b.json'), '{bad');
  const workspaceFolders = id => [{ uri: f.vscode.Uri.file(id === 'a' ? a : b) }];
  const search = createWorkspaceSearch(f.vscode, { workspaceFolders });
  const validation = createWorkspaceValidation(f.vscode, f.context, { workspaceFolders });
  t.after(() => validation.dispose());
  for (const id of ['a', 'b']) {
    const found = (await search.tools(id)[0].execute('call', { mode: 'files' })).details;
    assert.deepEqual(found.matches.map(item => item.path), [`only-${id}.json`]);
  }
  const result = (await validation.tools('a')[1].execute('call', { paths: ['only-a.json'] })).details;
  assert.ok(JSON.stringify(result).includes('only-a.json'));
  await assert.rejects(search.tools('a')[0].execute('call', { mode: 'files', root: 1 }), /工作区/);
});

async function fixture(t) {
  const parent = path.resolve(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'ubovm-intelligence-')), root = await fs.realpath(directory);
  const values = new Map(), docs = [], diagnostics = new Map(), listeners = new Set();
  let documentOpens = 0;
  const uri = file => ({ scheme: 'file', fsPath: file });
  const vscode = { env: { appRoot }, Uri: { file: uri },
    languages: { getDiagnostics: uri => diagnostics.get(uri.fsPath) ?? [], onDidChangeDiagnostics: listener => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: docs,
      async openTextDocument(uri) {
        documentOpens++;
        let doc = docs.find(doc => doc.uri.fsPath === uri.fsPath);
        if (!doc) { doc = { uri, text: await fs.readFile(uri.fsPath, 'utf8'), version: 1, isDirty: false, getText() { return this.text; } }; docs.push(doc); }
        return doc;
      }
    } };
  const context = { workspaceState: { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) } };
  const search = createWorkspaceSearch(vscode).tools()[0];
  const validation = createWorkspaceValidation(vscode, context, { changes: async () => [{ root: 0, path: 'code.ts' }] });
  const run = async (name, input = {}, signal) => (await validation.tools('session').find(tool => tool.name === name).execute('id', input, signal)).details;
  t.after(async () => { validation.dispose(); assert.equal(path.dirname(directory), parent); await fs.rm(directory, { recursive: true, force: true }); });
  return { root, vscode, diagnostics, context, validation, run, get documentOpens() { return documentOpens; },
    diagnosticChange: file => { for (const listener of listeners) listener({ uris: [uri(file)] }); },
    search: async (input, signal) => (await search.execute('id', input, signal)).details };
}

test('project search honors ignore files and supports literal/regex, glob, context, UTF-16 columns and pagination', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'src'));
  await fs.writeFile(path.join(f.root, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(f.root, 'ignored.txt'), 'target\n');
  await fs.writeFile(path.join(f.root, 'src/a.ts'), 'before\n中文 target one\nafter\ntarget two\n');
  await fs.writeFile(path.join(f.root, 'src/b.ts'), 'TARGET three\n');
  const first = await f.search({ query: 'target', limit: 1 });
  assert.equal(first.matches.length, 1); assert.equal(first.matches[0].line, 2); assert.equal(first.matches[0].column, 4);
  assert.equal(first.matches[0].before[0].text, 'before'); assert.equal(first.nextOffset, 1);
  const rest = await f.search({ query: 'target', offset: first.nextOffset });
  assert.equal(rest.matches.length, 2); assert.equal(rest.nextOffset, null);
  const names = await f.search({ mode: 'files', include: ['**/*.ts'], exclude: ['**/b.ts'] });
  assert.deepEqual(names.matches.map(match => match.path.replaceAll('\\', '/')), ['src/a.ts']);
  const regex = await f.search({ query: 'target (one|two)', regex: true, caseSensitive: true });
  assert.equal(regex.matches.length, 2);
  await assert.rejects(f.search({ query: '[', regex: true }), /regex|正则|error/i);
  assert.equal((await f.search({ query: 'no matches anywhere' })).matches.length, 0);
});

test('interrupted workspace search resumes from a legacy checkpoint and can read current files', async t => {
  const { createWorkerCheckpoint, restoreWorkerCheckpoint } = await import('../../harness/worker-agents/checkpoint.mjs');
  const { createPiWorker } = await import('../../harness/worker-agents/worker_pi_agent.mjs');
  const f = await fixture(t), options = { intentId: 'search-intent', goal: 'find target' };
  const tool = createWorkspaceSearch(f.vscode).tools()[0];
  const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };
  const checkpoint = createWorkerCheckpoint(options);
  checkpoint.phase = 'execute';
  checkpoint.toolCalls = 1;
  checkpoint.plan = [{ description: 'search project', doneWhen: 'matches observed' }];
  checkpoint.ledger = [{ toolCallId: 'interrupted-search', toolName: tool.name, args: { query: 'target' }, status: 'running' }];
  checkpoint.messages = [{ role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    timestamp: 1, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'interrupted-search', name: tool.name, arguments: { query: 'target' } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  let saved, request;
  const worker = createPiWorker({ model, tools: [tool], streamFn: (_model, transcript) => {
    request = transcript;
    assert.equal(saved.ledger[0].status, 'completed');
    assert.equal(saved.ledger[0].isError, true);
    throw new Error('fixture model reached');
  } });
  await assert.rejects(worker({ node: { id: options.intentId, intent: { description: options.goal, keyPoints: ['matches observed'] } },
    attempt: { id: 'resume' }, checkpoint,
    getContext: () => ({ data: { goal: options.goal, nodes: [] }, text: options.goal }),
    saveCheckpoint: async value => { saved = value; } }), /fixture model reached/);
  const recovered = request.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'interrupted-search');
  assert.equal(recovered.isError, true);
  assert.match(recovered.content[0].text, /No result is available.*new tool call ID/);
  assert.equal(saved.toolCalls, 1, 'restoration must not execute the interrupted search');
  assert.equal(checkpoint.ledger[0].status, 'running', 'legacy input is not mutated');
  assert.deepEqual(restoreWorkerCheckpoint(saved, options), saved, 'repaired checkpoint survives another restart');
  await fs.writeFile(path.join(f.root, 'latest.txt'), 'target after interruption');
  const fresh = await tool.execute('fresh-search', { query: 'target' });
  assert.equal(fresh.details.matches[0].text, 'target after interruption');
});

test('search cancellation, root validation and directory junction boundaries', async t => {
  const f = await fixture(t);
  await assert.rejects(f.search({ query: 'a' }, AbortSignal.abort()));
  await assert.rejects(f.search({ query: 'a', root: 9 }), /工作区/);
  await fs.mkdir(path.join(f.root, 'actual'));
  await fs.writeFile(path.join(f.root, 'actual/a.txt'), 'match');
  await fs.symlink(path.join(f.root, 'actual'), path.join(f.root, 'linked'), 'junction');
  const found = await f.search({ query: 'match' });
  assert.equal(found.matches.length, 1);
  assert(!found.matches[0].path.includes('linked'));
});

test('real no-emit TypeScript validation finds errors then passes after repair, without running tests/build', async t => {
  const f = await fixture(t), file = path.join(f.root, 'code.ts');
  await fs.writeFile(file, 'const value: number = "wrong";\n');
  await fs.writeFile(path.join(f.root, 'tsconfig.json'), '{ // comment\n "compilerOptions": { "strict": true, "skipLibCheck": true, }, "include": ["*.ts"] }');
  const failed = await f.run('validate_workspace_changes');
  assert.equal(failed.status, 'issues_found', JSON.stringify(failed));
  assert(failed.compilerResults[0].diagnostics.some(item => item.code === 2322));
  const doc = f.vscode.workspace.textDocuments[0]; doc.text = 'const value: number = 42;\n'; doc.version++; doc.isDirty = true;
  const passed = await f.run('validate_workspace_changes');
  assert.equal(passed.status, 'selected_checks_passed', JSON.stringify(passed));
  assert.equal(passed.files[0].unsaved, true); assert.equal(passed.tests, 'not_run'); assert.equal(passed.build, 'not_run');
  await assert.rejects(fs.stat(path.join(f.root, 'code.js')), { code: 'ENOENT' });
});

test('diagnostic feedback keeps a pre-edit baseline and reports new and resolved issues', async t => {
  const f = await fixture(t), file = path.join(f.root, 'code.ts');
  await fs.writeFile(file, 'let a = 1;');
  const item = message => ({ message, severity: 0, source: 'test-lint', code: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } });
  f.diagnostics.set(file, [item('old error')]); await f.validation.capture('session', file);
  f.diagnostics.set(file, [item('new error')]);
  const feedback = await f.run('get_workspace_diagnostics');
  assert.equal(feedback.status, 'issues_found'); assert.equal(feedback.files[0].newDiagnostics[0].message, 'new error'); assert.equal(feedback.files[0].resolvedCount, 1);
  f.diagnostics.set(file, []);
  assert.equal((await f.run('get_workspace_diagnostics')).status, 'incomplete', 'No diagnostics alone must not claim validation passed');
});

test('validation reports unsupported files, JSON errors, cancellation and rejects traversal', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'data.json'), '{invalid'); await fs.writeFile(path.join(f.root, 'notes.txt'), 'text');
  const report = await f.run('validate_workspace_changes', { paths: ['data.json', 'notes.txt'] });
  assert.equal(report.status, 'issues_found');
  assert(report.compilerResults[0].checks.some(check => check.status === 'not_supported'));
  await assert.rejects(f.run('validate_workspace_changes', { paths: ['../outside'] }), /超出工作区/);
  await assert.rejects(f.run('validate_workspace_changes', {}, AbortSignal.abort()));
});

test('search verifies a file once per request even with many matched lines', async t => {
  const f = await fixture(t), file = path.join(f.root, 'many.txt');
  await fs.writeFile(file, 'target\n'.repeat(200));
  const original = fs.realpath;
  let resolutions = 0;
  fs.realpath = async (...args) => { if (args[0] === file) resolutions++; return original(...args); };
  try {
    const result = await f.search({ query: 'target', limit: 200 });
    assert.equal(result.matches.length, 200); assert.equal(resolutions, 1);
  } finally { fs.realpath = original; }
});

test('validation reuses opened documents and ignores unrelated diagnostic churn', async t => {
  const f = await fixture(t), file = path.join(f.root, 'data.json');
  await fs.writeFile(file, '{}');
  const timer = setInterval(() => f.diagnosticChange(path.join(f.root, 'unrelated.ts')), 50);
  try {
    const report = await f.run('validate_workspace_changes', { paths: ['data.json'] });
    assert.equal(report.status, 'selected_checks_passed');
    assert(report.observation.waitedMs < 3000, JSON.stringify(report.observation));
    assert(report.observation.observedRevision > 0);
    assert.equal(f.documentOpens, 1);
    await f.run('validate_workspace_changes', { paths: ['data.json'] });
    assert.equal(f.documentOpens, 1, 'repeat validation uses the current open document, not a cached result');
  } finally { clearInterval(timer); }
});

test('disposing validation cancels a pending request and prevents later work', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'code.ts'), 'const value = 1;');
  const pending = f.run('validate_workspace_changes');
  const rejected = assert.rejects(pending, /服务已关闭/);
  await new Promise(resolve => setTimeout(resolve, 100));
  f.validation.dispose();
  await rejected;
  await assert.rejects(f.run('validate_workspace_changes'), /服务已关闭/);
});

test('diagnostic truncation preserves hidden error counts and bounds deltas globally', async t => {
  const f = await fixture(t), paths = ['one.txt', 'two.txt'];
  const item = (message, severity = 1) => ({ message, severity, source: 'test', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
  for (const name of paths) {
    const file = path.join(f.root, name);
    await fs.writeFile(file, 'text'); await f.validation.capture('session', file);
    f.diagnostics.set(file, [...Array.from({ length: 220 }, (_, i) => item('warning ' + i)), item('hidden error', 0)]);
  }
  const report = await f.run('get_workspace_diagnostics', { paths });
  assert.equal(report.status, 'issues_found'); assert.equal(report.outputTruncated, true);
  assert.equal(report.files[0].errorCount, 1); assert.equal(report.files[0].newDiagnosticCount, 221);
  assert.equal(report.files.reduce((n, file) => n + file.diagnostics.length, 0), 100);
  assert.equal(report.files.reduce((n, file) => n + file.newDiagnostics.length, 0), 20);
});
