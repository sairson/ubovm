import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../workspace-tools.mjs';

async function fixture(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'data.txt'), bytes);
  const [, tool] = await createWorkspaceTools([root]);
  return input => tool.execute('read', { path: 'data.txt', ...input });
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'data.txt'), 'ok');
  const tools = await createWorkspaceTools([root]);
  return {
    root,
    list: (input = {}) => tools[0].execute('list', input),
    read: (input = {}) => tools[1].execute('read', input)
  };
}

test('workspace text rejects malformed UTF-8 instead of fabricating replacement characters', async t => {
  const read = await fixture(t, Buffer.from([0x61, 0xc3, 0x28]));
  await assert.rejects(read(), error => error.code === 'WORKSPACE_BINARY_FILE');
});

test('workspace text omits a codepoint bisected by its byte cap', async t => {
  const prefix = 'a\n'.repeat(((4 << 20) - 2) / 2);
  const read = await fixture(t, prefix + '😀tail');
  const { details } = await read({ startLine: prefix.length / 2 + 1 });
  assert.equal(details.fileTruncated, true);
  assert.ok(!details.content.includes('\ufffd'));
});

test('oversized lines preserve emoji boundaries and pagination advances to the next line', async t => {
  const read = await fixture(t, 'a' + '😀'.repeat(40000) + '\nnext');
  const { details } = await read();
  assert.equal(details.lineTruncated, true);
  assert.equal(details.nextLine, 2);
  assert.ok(details.content.isWellFormed());
  assert.ok(Buffer.byteLength(details.content) <= 128 << 10);
  assert.match((await read({ startLine: details.nextLine })).details.content, /2: next/);
});

test('workspace pagination preserves CRLF lines and rejects outside paths', async t => {
  const read = await fixture(t, 'first\r\n第二\r\nlast\r\n');
  const first = (await read({ lineCount: 1 })).details;
  assert.equal(first.content, '1: first\n');
  assert.equal(first.nextLine, 2);
  assert.equal((await read({ startLine: 2 })).details.content, '2: 第二\n3: last\n');
  await assert.rejects(read({ path: '../outside' }), error => error.code === 'WORKSPACE_BOUNDARY');
});

test('missing directories and files are observations, not tool failures', async t => {
  const f = await workspace(t);
  const listed = await f.list({ path: 'selftest' });
  assert.equal(listed.isError, undefined);
  assert.equal(listed.details.exists, false);
  assert.equal(listed.details.reason, 'missing');
  assert.deepEqual(listed.details.entries, []);
  assert.match(listed.details.guidance, /not a tool failure/);
  const asFile = await f.list({ path: 'data.txt' });
  assert.equal(asFile.details.exists, true);
  assert.equal(asFile.details.reason, 'not_directory');
  const missing = await f.read({ path: 'selftest/app.js' });
  assert.equal(missing.isError, undefined);
  assert.equal(missing.details.exists, false);
  assert.equal(missing.details.content, null);
  const present = await f.read({ path: 'data.txt' });
  assert.equal(present.details.exists, true);
  assert.match(present.details.content, /1: ok/);
});
