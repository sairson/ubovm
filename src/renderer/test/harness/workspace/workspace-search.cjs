'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createWorkspaceSearch } = require('../../../harness/workspace/workspace-search.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-rg-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vscode = { workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] } };
  const service = createWorkspaceSearch(vscode, { executable: process.env.UBOVM_TEST_RG || 'rg', ...options });
  const tool = service.tools('session')[0];
  return { root, tool, service, write: (name, text) => fs.writeFile(path.join(root, name), text),
    search: async (input, signal) => (await tool.execute('test', input, signal)).details };
}

function fakeProcesses() {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter(); child.pid = 1;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); return false; };
    children.push(child); return child;
  };
  return { children, spawnProcess };
}

test('cancelled searches settle even without close, while physical capacity remains reserved', async t => {
  const process = fakeProcesses();
  const f = await fixture(t, { ...process, maxConcurrent: 1, maxPerSession: 1, stopTimeoutMs: 10 });
  const controller = new AbortController();
  const first = f.search({ mode: 'files' }, controller.signal);
  const rejected = assert.rejects(first, /cancel original/);
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel original')); await rejected;
  assert.deepEqual(process.children[0].kills, [undefined, 'SIGKILL']);
  await assert.rejects(f.search({ mode: 'files' }), { code: 'SEARCH_BUSY' });
  process.children[0].stdout.emit('data', Buffer.from('late-file\0'));
  process.children[0].emit('close', 0);
  const next = f.search({ mode: 'files' });
  while (process.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  process.children[1].emit('close', 0);
  assert.deepEqual((await next).matches, []);
});

test('capacity is reserved before filesystem awaits and independent sessions stay usable', async t => {
  const process = fakeProcesses();
  const f = await fixture(t, { ...process, maxConcurrent: 2, maxPerSession: 1 });
  const first = f.search({ mode: 'files' });
  await assert.rejects(f.search({ mode: 'files' }), { code: 'SEARCH_BUSY' });
  const other = f.service.tools('other')[0].execute('test', { mode: 'files' });
  await assert.rejects(f.service.tools('third')[0].execute('test', { mode: 'files' }), { code: 'SEARCH_BUSY' });
  while (process.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  for (const child of process.children) child.emit('close', 0);
  await Promise.all([first, other]);
  await assert.rejects(f.search({ mode: 'invalid' }));
  const retry = f.search({ mode: 'files' });
  while (process.children.length < 3) await new Promise(resolve => setImmediate(resolve));
  process.children[2].emit('close', 0); await retry;
});

test('timeout and spawn failure do not leave logical callers hanging', async t => {
  const process = fakeProcesses();
  const f = await fixture(t, { ...process, timeoutMs: 10, stopTimeoutMs: 10 });
  await assert.rejects(f.search({ mode: 'files' }), { code: 'SEARCH_TERMINATION_TIMEOUT' });
  process.children[0].emit('close', 0);
  const failed = f.search({ mode: 'files' });
  const rejected = assert.rejects(failed, /spawn unavailable/);
  while (process.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  const child = process.children[1]; child.pid = undefined; child.emit('error', new Error('spawn unavailable'));
  await rejected;
  child.emit('close', -1);
  const next = f.search({ mode: 'files' });
  while (process.children.length < 3) await new Promise(resolve => setImmediate(resolve));
  process.children[2].emit('close', 0); await next;
});

test('a workspace change discards old search results without leaking them to the replacement', async t => {
  const process = fakeProcesses(); let folder;
  const f = await fixture(t, { ...process, workspaceFolders: () => [{ uri: { scheme: 'file', fsPath: folder } }] });
  folder = f.root;
  await f.write('old.txt', 'private old result');
  const first = f.search({ mode: 'files' });
  const rejected = assert.rejects(first, { code: 'SEARCH_WORKSPACE_CHANGED' });
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  process.children[0].stdout.emit('data', Buffer.from('old.txt\0'));
  folder = path.join(f.root, 'replacement'); await fs.mkdir(folder);
  process.children[0].emit('close', 0); await rejected;
  const next = f.search({ mode: 'files' });
  while (process.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  process.children[1].emit('close', 0);
  assert.deepEqual((await next).matches, []);
});

test('untrusted result paths cannot escape the root through traversal or directory links', async t => {
  const process = fakeProcesses(), f = await fixture(t, process);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-search-private-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private'); await f.write('safe.txt', 'safe');
  await fs.symlink(outside, path.join(f.root, 'linked'), globalThis.process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.search({ mode: 'files' });
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  process.children[0].stdout.emit('data', Buffer.from(['safe.txt', '../secret.txt', path.join(outside, 'secret.txt'), 'linked/secret.txt', ''].join('\0')));
  process.children[0].emit('close', 0);
  assert.deepEqual((await result).matches, [{ path: 'safe.txt' }]);
});

test('invalid process data fails locally and cannot occupy unbounded retry capacity', async t => {
  const process = fakeProcesses(), f = await fixture(t, { ...process, maxConcurrent: 1, stopTimeoutMs: 10 });
  const first = f.search({ query: 'target' }); const rejected = assert.rejects(first, SyntaxError);
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  process.children[0].stdout.emit('data', Buffer.from('invalid JSON\n'));
  await rejected;
  await assert.rejects(f.search({ mode: 'files' }), { code: 'SEARCH_BUSY' });
  process.children[0].emit('close', 0);
  const next = f.search({ mode: 'files' });
  while (process.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  process.children[1].emit('close', 0); await next;
});

test('rg modes distinguish filename listing, matching files, matching lines and occurrence counts', async t => {
  const f = await fixture(t);
  await f.write('a.ts', 'target target\nother\ntarget\n');
  await f.write('b.ts', 'target\n'); await f.write('c.ts', 'no matches\n');
  const count = await f.search({ mode: 'count', query: 'target', limit: 1 });
  assert.deepEqual(count.matches, [{ path: 'a.ts', count: 3, matchedLines: 2 }]);
  assert.equal(count.nextOffset, 1);
  const next = await f.search({ mode: 'count', query: 'target', offset: count.nextOffset });
  assert.deepEqual(next.matches, [{ path: 'b.ts', count: 1, matchedLines: 1 }]);
  assert.equal(next.nextOffset, null);
  const files = await f.search({ mode: 'matchingFiles', query: 'target' });
  assert.deepEqual(files.matches, [{ path: 'a.ts' }, { path: 'b.ts' }]);
  const first = await f.search({ mode: 'matchingFiles', query: 'target', limit: 1 });
  assert.equal(first.nextOffset, 1);
  assert.deepEqual((await f.search({ mode: 'matchingFiles', query: 'target', offset: first.nextOffset })).matches, [{ path: 'b.ts' }]);
  assert.equal((await f.search({ mode: 'files', include: ['*.ts'] })).matches.length, 3);
  assert.equal((await f.search({ query: 'target' })).matches.length, 3);
  assert.equal(files.engine, 'ripgrep');
  for (const mode of ['count', 'matchingFiles', 'text']) {
    const absent = await f.search({ mode, query: 'absent' });
    assert.deepEqual(absent.matches, []);
    assert.equal(absent.cannotSearch, false);
  }
});

test('rg multiple patterns, type filters, regex and all UTF-16 match ranges work together', async t => {
  const f = await fixture(t);
  await f.write('中文.ts', '😀你好 foo bar foo\nfood BAR\n');
  await f.write('other.py', 'foo');
  const found = await f.search({ patterns: ['foo', 'bar'], types: ['ts'], wholeWord: true, contextLines: 0 });
  assert.equal(found.matches.length, 2);
  assert.deepEqual(found.matches[0].ranges, [{ column: 6, endColumn: 9 }, { column: 10, endColumn: 13 }, { column: 14, endColumn: 17 }]);
  assert.equal(found.matches[0].matchCount, 3);
  assert.equal(found.matches[0].rangesTruncated, false);
  const count = await f.search({ mode: 'count', patterns: ['foo', 'bar'], wholeWord: true, types: ['ts'] });
  assert.deepEqual(count.matches, [{ path: '中文.ts', count: 4, matchedLines: 2 }]);
  assert.equal((await f.search({ query: '\\bB[A-Z]+\\b', regex: true, caseSensitive: true, types: ['ts'] })).matches[0].line, 2);
});

test('rg bounds match ranges and preserves literal patterns starting with flags', async t => {
  const f = await fixture(t);
  await f.write('many.txt', 'a '.repeat(250) + '\n--version\n');
  const found = await f.search({ query: 'a' });
  assert.equal(found.matches[0].matchCount, 250);
  assert.equal(found.matches[0].ranges.length, 200);
  assert.equal(found.matches[0].rangesTruncated, true);
  assert.equal((await f.search({ query: '--version' })).matches[0].line, 2);
});

test('rg mandatory directory exclusions survive broad globs and errors are surfaced', async t => {
  const f = await fixture(t);
  for (const name of ['.git', 'node_modules', '.cache', '.runtime']) { await fs.mkdir(path.join(f.root, name)); await f.write(name + '/private.ts', 'target'); }
  await f.write('code.ts', 'target'); await f.write('.ignore', 'ignored.ts\n'); await f.write('ignored.ts', 'target');
  assert.deepEqual((await f.search({ query: 'target', include: ['**/*'], exclude: ['ignored.ts'] })).matches.map(item => item.path), ['code.ts']);
  assert.deepEqual((await f.search({ mode: 'matchingFiles', query: 'target' })).matches, [{ path: 'code.ts' }]);
  const invalidRegex = await f.tool.execute('test', { query: '[', regex: true });
  assert.equal(invalidRegex.isError, true);
  assert.equal(invalidRegex.details.cannotSearch, true);
  assert.equal(invalidRegex.details.reason, 'invalid_regex');
  assert.deepEqual(invalidRegex.details.matches, []);
  const invalidType = await f.tool.execute('test', { query: 'target', types: ['not-a-real-language'] });
  assert.equal(invalidType.isError, true);
  assert.equal(invalidType.details.cannotSearch, true);
  assert.equal(invalidType.details.reason, 'unrecognized_type');
  for (const input of [{ patterns: [] }, { query: 'a', patterns: ['b'] }, { query: 'a', types: ['--help'] }, { query: 'a', regex: 'false' }]) await assert.rejects(f.search(input));
  await assert.rejects(f.search({ mode: 'count', query: 'target' }, AbortSignal.abort()));
});
