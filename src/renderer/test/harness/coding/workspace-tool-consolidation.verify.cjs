'use strict';
// Independent verification gate for workspace tool consolidation (.tmp-tools/contract.md).
// Contract under test:
//   - model-facing tools advertise read_workspace_code (canonical read, with line
//     paging via startLine/lineCount) and edit_workspace_files (canonical edit, batch
//     + dryRun preflight); the four removed names are NOT advertised anywhere
//     (tools(), workspace base tools, prompts, tool modes, tool timeouts, runtime
//     guidance) while historical UI labels may remain;
//   - read_workspace_code keeps whole-file/offset behavior and gains line paging for
//     small and >1 MiB files (mixed offset+startLine rejected, boundary/dirty/hash
//     semantics preserved);
//   - edit_workspace_files handles files:[one] and dryRun:true does a preflight with
//     no writes/dirs/journal; invalid preflight writes nothing.
// Owned by verifier; implementation files must not be edited by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createCodingService } = require('../../../harness/coding/coding-service.cjs');

const REPO = path.resolve(__dirname, '../../../../..');
const OLD_NAMES = ['read_workspace_file', 'edit_workspace_file', 'preview_workspace_edits', 'analyze_workspace_call_chain'];
const READ = 'read_workspace_code';
const EDIT = 'edit_workspace_files';
const KEEP_TOOLS = [
  'navigate_workspace_code', 'preview_workspace_rename', 'inspect_workspace_project', 'read_workspace_change',
  'read_workspace_code', 'list_workspace_changes', 'recover_workspace_changes', 'edit_workspace_files'
];
const esm = relative => import(pathToFileURL(path.join(REPO, relative)).href);
const fileText = relative => fs.readFile(path.join(REPO, relative), 'utf8');
const mentions = (text, name) => (text.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'ubovm-consolidation-'));
  const documents = [];
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const vscode = {
    Uri: { file: uri, parse: value => ({ scheme: 'ubovm-diff', toString: () => value }) },
    ViewColumn: { Two: 2 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class {},
    TextEdit: { setEndOfLine: value => ({ newEol: value }), insert: (_, text) => ({ text }), replace: (_, text) => ({ text }) },
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: class {
      ops = [];
      createFile(target) { this.ops.push(['create', target]); }
      deleteFile(target) { this.ops.push(['delete', target]); }
      insert(target, _range, text) { this.ops.push(['text', target, text]); }
      replace(target, _range, text) { this.ops.push(['text', target, text]); }
      get() { return []; }
      set(target, edits) { for (const edit of edits) if (edit.text !== undefined) this.ops.push(['text', target, edit.text]); }
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: uri(root) }],
      textDocuments: documents,
      registerTextDocumentContentProvider() { return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(target) {
        let doc = documents.find(item => item.uri.fsPath === target.fsPath);
        if (!doc) {
          doc = {
            uri: target, version: 1, isDirty: false, text: await fs.readFile(target.fsPath, 'utf8'),
            getText() { return this.text; }, positionAt: offset => offset, get lineCount() { return this.text.split('\n').length; },
            lineAt(line) { return { text: this.text.split(/\r?\n/)[line] }; },
            offsetAt(position) { return this.text.split('\n').slice(0, position.line).reduce((total, lineText) => total + lineText.length + 1, 0) + position.character; },
            async save() { await fs.writeFile(target.fsPath, this.text); this.isDirty = false; return true; }
          };
          documents.push(doc);
        }
        return doc;
      },
      async applyEdit(edit) {
        for (const [operation, target, text] of edit.ops) {
          if (operation === 'create') { try { await fs.writeFile(target.fsPath, '', { flag: 'wx' }); } catch { /* already exists */ } }
          if (operation === 'delete') { await fs.unlink(target.fsPath).catch(() => {}); const index = documents.findIndex(doc => doc.uri.fsPath === target.fsPath); if (index >= 0) documents.splice(index, 1); }
          if (operation === 'text') { const doc = await this.openTextDocument(target); doc.text = text; doc.isDirty = true; }
        }
        return true;
      }
    },
    window: { async showInformationMessage() {}, async showQuickPick() { return undefined; } },
    commands: { async executeCommand() {} }
  };
  const context = { workspaceState: { get: (_key, fallback) => structuredClone(fallback), async update() {} } };
  let service = createCodingService(vscode, context, {});
  const tool = name => service.tools('session').find(item => item.name === name) || null;
  const call = async (name, input = {}) => {
    const entry = tool(name);
    assert.ok(entry, `tool ${name} must be advertised`);
    const result = await entry.execute('test', input);
    return result.details;
  };
  const attempt = async (name, input = {}) => {
    try { return { ok: true, details: await call(name, input) }; }
    catch (error) { return { ok: false, message: String(error?.message || error) }; }
  };
  t.after(async () => {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, call, attempt, tool, get service() { return service; }, vscode, documents };
}

// ---------------------------------------------------------------------------
// 1. Model-facing tool list: removed names gone, canonical tools stay.
// ---------------------------------------------------------------------------
test('the advertised tool list drops the four removed names and keeps the canonical read/edit tools', async t => {
  const f = await fixture(t);
  const names = f.service.tools('list').map(tool => tool.name);
  for (const name of OLD_NAMES) assert.equal(names.includes(name), false, `${name} must not be advertised by tools()`);
  assert.ok(names.includes(READ), `${READ} must stay advertised`);
  assert.ok(names.includes(EDIT), `${EDIT} must stay advertised`);
  for (const name of KEEP_TOOLS) assert.ok(names.includes(name), `${name} must stay advertised (unchanged surface)`);
  assert.equal(f.tool('edit_workspace_file'), null, 'the single-file edit tool must be gone');
  assert.equal(f.tool('preview_workspace_edits'), null, 'the preview tool must be gone');
  assert.equal(f.tool('analyze_workspace_call_chain'), null, 'the call-chain tool must be gone');
  // Workspace base (read-only) tools must drop read_workspace_file but keep the rest.
  const workspace = await esm('src/harness/ide/workspace-tools.mjs');
  const base = await workspace.createWorkspaceTools([f.root]);
  const baseNames = base.map(tool => tool.name);
  assert.equal(baseNames.includes('read_workspace_file'), false, 'workspace base tools must not advertise read_workspace_file');
  assert.ok(baseNames.includes('list_workspace_files'), 'list_workspace_files stays in workspace base tools');
  assert.ok(baseNames.includes('read_image'), 'read_image stays in workspace base tools');
});

// ---------------------------------------------------------------------------
// 2. Parallel modes and per-tool timeouts no longer mention removed tools.
// ---------------------------------------------------------------------------
test('tool modes and timeouts no longer reference the removed tools', async t => {
  await fixture(t);
  const modes = await esm('src/harness/intools/shared/tool-modes.mjs');
  const runtime = await esm('src/harness/intools/shared/tool-runtime.mjs');
  for (const name of OLD_NAMES) {
    assert.equal(modes.PARALLEL_READ_TOOLS.includes(name), false, `${name} must not be in PARALLEL_READ_TOOLS`);
    assert.equal(Object.keys(runtime.TOOL_TIMEOUTS).includes(name), false, `${name} must not configure a tool timeout`);
  }
  assert.ok(modes.PARALLEL_READ_TOOLS.includes(READ), 'read_workspace_code keeps its parallel read mode');
  assert.equal(modes.executionModeFor(READ), 'parallel', 'read_workspace_code stays a parallel read tool');
});

// ---------------------------------------------------------------------------
// 3. Prompts: removed tools are never advertised; consolidated usage is taught.
// ---------------------------------------------------------------------------
test('system prompts describe the consolidated tools and never advertise removed names', async t => {
  await fixture(t);
  const prompts = await esm('src/harness/agents/collaboration/prompts.mjs');
  const promptTexts = Object.entries(prompts).filter(([, value]) => typeof value === 'string');
  assert.ok(promptTexts.length >= 3, 'collaboration prompts must be inspectable');
  for (const [name, text] of promptTexts) {
    for (const oldName of OLD_NAMES) {
      assert.equal(mentions(text, oldName), 0, `${name} must not mention ${oldName}`);
    }
  }
  const chat = prompts.chatSystemPrompt;
  assert.match(chat, /read_workspace_code/, 'chat prompt keeps read_workspace_code');
  assert.match(chat, /edit_workspace_files/, 'chat prompt keeps edit_workspace_files');
  assert.match(chat, /startLine|lineCount/, 'chat prompt should teach line paging with startLine/lineCount');
  assert.match(chat, /dryRun/, 'chat prompt should teach edit dryRun preflight');
});

// ---------------------------------------------------------------------------
// 4. Runtime workspace guidance + rename preview guidance use batch/dryRun.
// ---------------------------------------------------------------------------
test('harness workspace guidance and rename preview point at the consolidated tools', async t => {
  await fixture(t);
  const harness = await fileText('src/harness/ide/runtime/harness-service.cjs');
  for (const oldName of OLD_NAMES) {
    assert.equal(mentions(harness, oldName), 0, `runtime workspace guidance must not advertise ${oldName}`);
  }
  assert.match(harness, /read_workspace_code/, 'runtime guidance keeps read_workspace_code');
  assert.match(harness, /edit_workspace_files/, 'runtime guidance keeps edit_workspace_files');
  const f = await fixture(t);
  const rename = f.tool('preview_workspace_rename');
  assert.ok(rename, 'preview_workspace_rename stays advertised');
  assert.match(rename.description, /edit_workspace_files/, 'rename preview must point at edit_workspace_files');
  assert.match(rename.description, /dryRun/i, 'rename preview must point at dryRun:true');
  const renameSource = await fileText('src/renderer/harness/coding/rename-preview.cjs');
  assert.match(renameSource, /edit_workspace_files/, 'rename preview result guidance must use edit_workspace_files');
  assert.match(renameSource, /dryRun/i, 'rename preview result guidance must use dryRun:true');
  assert.equal(mentions(renameSource, 'preview_workspace_edits'), 0, 'rename preview must not reference the removed preview tool');
});

// ---------------------------------------------------------------------------
// 5. read_workspace_code keeps the existing whole-file and offset behavior.
// ---------------------------------------------------------------------------
test('read_workspace_code keeps whole-file, lineNumbers and offset/limit behavior', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'small.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  const whole = await f.call(READ, { path: 'small.txt' });
  assert.equal(whole.exists, true);
  assert.equal(whole.content, 'alpha\nbeta\ngamma\ndelta\n');
  assert.equal(whole.truncated, false);
  assert.equal(typeof whole.hash, 'string');
  const numbered = await f.call(READ, { path: 'small.txt', lineNumbers: true });
  assert.deepEqual(numbered.lines, ['alpha', 'beta', 'gamma', 'delta', '']);
  assert.equal(numbered.startLine, 1);
  assert.match(numbered.contentWithLineNumbers, /^1: alpha/);
  const paged = await f.call(READ, { path: 'small.txt', offset: 6, limit: 4 });
  assert.equal(paged.content, 'beta');
  assert.equal(paged.offset, 6);
  assert.equal(paged.nextOffset, 10);
  assert.equal(paged.hash, whole.hash, 'paged reads keep the whole-file hash for small files');
});

// ---------------------------------------------------------------------------
// 6. read_workspace_code line mode on small files.
// ---------------------------------------------------------------------------
test('read_workspace_code serves a line page with startLine/lineCount on small files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'small.txt'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  const whole = await f.call(READ, { path: 'small.txt' });
  const page = await f.call(READ, { path: 'small.txt', startLine: 2, lineCount: 2 });
  assert.equal(page.exists, true);
  assert.equal(page.startLine, 2, 'a line page must report the requested 1-based startLine');
  assert.equal(page.endLine, 3, 'a line page must report the inclusive endLine');
  const pageLines = page.lines || (page.content || '').split('\n').map(line => line.replace(/^\d+:\s?/, ''));
  assert.deepEqual(pageLines.slice(0, 2), ['beta', 'gamma']);
  assert.equal(page.nextLine, 4, 'nextLine continues the line page');
  assert.ok(page.accessibleLines >= 5 || page.totalLines >= 5, 'line page must expose accessible line count');
  assert.equal(page.fileTruncated, false);
  assert.equal(typeof page.hash, 'string', 'small-file line pages keep a whole-file hash');
  if (page.hashKind !== undefined) assert.notEqual(page.hashKind, 'window');
  assert.equal(page.hash, whole.hash, 'small-file line page hash equals the whole-file hash');
  const tail = await f.call(READ, { path: 'small.txt', startLine: 4, lineCount: 400 });
  const tailLines = tail.lines || (tail.content || '').split('\n').map(line => line.replace(/^\d+:\s?/, ''));
  assert.ok(tailLines.includes('epsilon'), 'the last page reaches the end of the file');
  assert.equal(tail.nextLine ?? null, null, 'the last page reports nextLine:null');
});

// ---------------------------------------------------------------------------
// 7. read line mode bounds + mutual exclusion with offset/limit.
// ---------------------------------------------------------------------------
test('read line mode enforces bounds and rejects mixed offset/line paging', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'small.txt'), 'one\ntwo\nthree\n');
  const defaultStart = await f.call(READ, { path: 'small.txt', lineCount: 2 });
  assert.equal(defaultStart.startLine, 1, 'lineCount alone defaults startLine to 1');
  assert.equal((await f.attempt(READ, { path: 'small.txt', startLine: 0 })).ok, false, 'startLine must be >= 1');
  assert.equal((await f.attempt(READ, { path: 'small.txt', startLine: 99 })).ok, false, 'startLine beyond the file must be rejected');
  assert.equal((await f.attempt(READ, { path: 'small.txt', lineCount: 0 })).ok, false, 'lineCount must be >= 1');
  assert.equal((await f.attempt(READ, { path: 'small.txt', lineCount: 401 })).ok, false, 'lineCount must be <= 400');
  const mixed = await f.attempt(READ, { path: 'small.txt', offset: 0, startLine: 2, lineCount: 2 });
  assert.equal(mixed.ok, false, 'mixing offset and startLine must be rejected');
  assert.match(mixed.message, /offset|startLine|不能|同时|mutually|exclusive/i, 'the mixed-use error must be clear');
  const mixed2 = await f.attempt(READ, { path: 'small.txt', offset: 0, limit: 2, lineCount: 2 });
  assert.equal(mixed2.ok, false, 'mixing limit/line paging must be rejected');
});

// ---------------------------------------------------------------------------
// 8. read line mode on >1 MiB files (large window, no whole-file editing).
// ---------------------------------------------------------------------------
test('read_workspace_code pages lines in files larger than 1 MiB', async t => {
  const f = await fixture(t);
  const line = 'const value = "a fairly long line of code to reach one mebibyte quickly";\n';
  const lineCount = Math.ceil((1.3 * 1024 * 1024) / line.length);
  await fs.writeFile(path.join(f.root, 'large.js'), line.repeat(lineCount));
  const size = (await fs.stat(path.join(f.root, 'large.js'))).size;
  assert.ok(size > 1024 * 1024, 'the fixture must exceed the 1 MiB whole-file limit');
  const page = await f.call(READ, { path: 'large.js', startLine: 1000, lineCount: 400 });
  assert.equal(page.exists, true);
  assert.equal(page.large, true, 'large files must report large:true');
  assert.equal(page.editable, false, 'large files must report editable:false');
  assert.equal(page.startLine, 1000);
  assert.equal(page.endLine, 1399);
  assert.equal(page.nextLine, 1400);
  assert.equal(page.fileTruncated, true, 'a >1 MiB line window must report fileTruncated:true');
  assert.equal(page.truncated, true, 'a >1 MiB line window must report truncated:true');
  const pageLines = page.lines || (page.content || '').split('\n').map(value => value.replace(/^\d+:\s?/, ''));
  assert.equal(pageLines.filter(value => value !== '').length, 400, 'the page must contain lineCount lines');
  assert.equal(typeof page.hash, 'string', 'a large-file line window carries a window hash');
  if (page.hashKind !== undefined) assert.equal(page.hashKind, 'window', 'large-file pages use a window hash kind');
  const next = await f.call(READ, { path: 'large.js', startLine: page.nextLine, lineCount: 400 });
  assert.equal(next.startLine, 1400, 'nextLine continues large-file line paging');
  // Existing >1 MiB whole-file window behavior stays intact.
  const window = await f.call(READ, { path: 'large.js' });
  assert.equal(window.large, true);
  assert.equal(window.editable, false);
  assert.equal(typeof window.nextOffset, 'number');
});

// ---------------------------------------------------------------------------
// 9. read_workspace_code keeps boundary/dirty/missing semantics.
// ---------------------------------------------------------------------------
test('read_workspace_code keeps boundary, dirty-buffer and missing-file semantics', async t => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n');
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const escaped = await f.attempt(READ, { path: path.join(outside, 'secret.txt') });
  assert.equal(escaped.ok, false, 'reading outside the workspace must be rejected');
  assert.match(escaped.message, /工作区|workspace|boundary|根目录/i);
  const missing = await f.call(READ, { path: 'missing.txt' });
  assert.equal(missing.exists, false, 'missing files return exists:false instead of a tool error');
  await fs.writeFile(path.join(f.root, 'dirty.txt'), 'clean\n');
  const doc = await f.vscode.workspace.openTextDocument(f.vscode.Uri.file(path.join(f.root, 'dirty.txt')));
  doc.isDirty = true;
  const dirty = await f.attempt(READ, { path: 'dirty.txt' });
  assert.equal(dirty.ok, false, 'dirty buffers must be rejected for reads');
  doc.isDirty = false;
  const lineDirty = await f.attempt(READ, { path: 'dirty.txt', startLine: 1, lineCount: 1 });
  assert.equal(lineDirty.ok, true, 'clean files work for line reads');
});

// ---------------------------------------------------------------------------
// 10. edit_workspace_files: single-file array behaves like the removed tool.
// ---------------------------------------------------------------------------
test('edit_workspace_files handles a single file array for replace, create and delete', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'single.txt'), 'alpha\nbeta\n');
  const read = await f.call(READ, { path: 'single.txt' });
  const replaced = await f.call(EDIT, { files: [{ path: 'single.txt', operation: 'replace', oldText: 'beta', newText: 'BETA', expectedHash: read.hash }] });
  assert.equal(replaced.status, 'applied', `single-file replace must apply (got ${JSON.stringify(replaced.status)})`);
  assert.equal(await fs.readFile(path.join(f.root, 'single.txt'), 'utf8'), 'alpha\nBETA\n');
  const created = await f.call(EDIT, { files: [{ path: 'created.txt', operation: 'create', newText: 'hello\n' }] });
  assert.equal(created.status, 'applied', 'single-file create must apply through files:[one]');
  assert.equal(await fs.readFile(path.join(f.root, 'created.txt'), 'utf8'), 'hello\n');
  const createdRead = await f.call(READ, { path: 'created.txt' });
  const deleted = await f.call(EDIT, { files: [{ path: 'created.txt', operation: 'delete', expectedHash: createdRead.hash }] });
  assert.equal(deleted.status, 'applied', 'single-file delete must apply through files:[one]');
  await assert.rejects(fs.stat(path.join(f.root, 'created.txt')), /ENOENT/, 'delete must remove the file');
});

// ---------------------------------------------------------------------------
// 11. dryRun:true is a preflight only (no writes, dirs or journal records).
// ---------------------------------------------------------------------------
test('edit_workspace_files dryRun preflights without writing, creating dirs or journal records', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'dry.txt'), 'gamma\n');
  const read = await f.call(READ, { path: 'dry.txt' });
  const dry = await f.call(EDIT, { files: [{ path: 'dry.txt', operation: 'replace', oldText: 'gamma', newText: 'GAMMA', expectedHash: read.hash }], dryRun: true });
  assert.ok(['ready', 'applied', 'planned'].includes(dry.status) || dry.saved === false, `dryRun must preflight (status=${dry.status})`);
  assert.notEqual(dry.status, 'applied_with_writes', 'dryRun must not report writes');
  assert.equal(dry.saved === undefined ? false : dry.saved, false, 'dryRun must report saved:false');
  assert.equal(await fs.readFile(path.join(f.root, 'dry.txt'), 'utf8'), 'gamma\n', 'dryRun must not write the file');
  assert.deepEqual(Object.keys(f.service.turnSummary('session')), [], 'dryRun must not create turn/journal records');
  const changes = await f.call('list_workspace_changes', {});
  assert.equal((changes.changes || []).length, 0, 'dryRun must not record workspace changes');
  const dryCreate = await f.call(EDIT, { files: [{ path: 'dry-dir/dry-file.txt', operation: 'create', newText: 'hello', createParents: true }], dryRun: true });
  assert.equal(dryCreate.saved === undefined ? false : dryCreate.saved, false);
  await assert.rejects(fs.stat(path.join(f.root, 'dry-dir')), /ENOENT/, 'dryRun must not create parent directories');
  // An invalid dryRun reports invalid without writing either.
  const invalid = await f.call(EDIT, { files: [{ path: 'dry.txt', operation: 'replace', oldText: 'gamma', newText: 'X', expectedHash: 'deadbeef' }], dryRun: true });
  assert.equal(invalid.status, 'invalid', 'an invalid dryRun must report status invalid');
  assert.equal(await fs.readFile(path.join(f.root, 'dry.txt'), 'utf8'), 'gamma\n', 'invalid dryRun writes nothing');
  await assert.rejects(fs.stat(path.join(f.root, 'dry-dir')), /ENOENT/, 'invalid dryRun creates no dirs');
  // dryRun:false still applies.
  const applied = await f.call(EDIT, { files: [{ path: 'dry.txt', operation: 'replace', oldText: 'gamma', newText: 'GAMMA', expectedHash: read.hash }], dryRun: false });
  assert.equal(applied.status, 'applied', 'dryRun:false must apply normally');
  assert.equal(await fs.readFile(path.join(f.root, 'dry.txt'), 'utf8'), 'GAMMA\n');
});

// ---------------------------------------------------------------------------
// 12. edit schema: files + dryRun only (no nested removed-tool schema).
// ---------------------------------------------------------------------------
test('edit_workspace_files exposes files and dryRun in its model-facing schema', async t => {
  const f = await fixture(t);
  const edit = f.tool(EDIT);
  assert.ok(edit, 'edit_workspace_files must be advertised');
  const properties = edit.parameters?.properties || {};
  assert.ok(properties.files, 'edit_workspace_files must expose the files array');
  assert.ok(properties.dryRun, 'edit_workspace_files must expose dryRun');
  assert.equal(properties.files.minItems ?? 1, 1);
  assert.equal(properties.files.maxItems ?? 20, 20);
  const read = f.tool(READ);
  const readProperties = read.parameters?.properties || {};
  assert.ok(readProperties.startLine, 'read_workspace_code must expose startLine');
  assert.ok(readProperties.lineCount, 'read_workspace_code must expose lineCount');
  for (const kept of ['path', 'offset', 'limit', 'expectedHash', 'lineNumbers']) {
    assert.ok(readProperties[kept], `read_workspace_code keeps the ${kept} parameter`);
  }
});

// ---------------------------------------------------------------------------
// 13. Historical UI labels for removed names stay (compat only).
// ---------------------------------------------------------------------------
test('historical tool-card labels for removed names remain in the UI layer', async t => {
  await fixture(t);
  const messageView = await fileText('src/renderer/webview/messages/message-view.js');
  for (const [name, label] of Object.entries({
    read_workspace_file: /read_workspace_file:\s*'[^']+'/,
    edit_workspace_file: /edit_workspace_file:\s*'[^']+'/,
    preview_workspace_edits: /preview_workspace_edits:\s*'[^']+'/,
    analyze_workspace_call_chain: /analyze_workspace_call_chain:\s*'[^']+'/
  })) {
    assert.match(messageView, label, `historical label for ${name} must remain so old cards render`);
  }
});
