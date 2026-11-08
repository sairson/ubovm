import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../workspace-tools.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'data.txt'), 'ok');
  await writeFile(join(root, 'nested', 'inner.txt'), 'inner');
  const tools = await createWorkspaceTools([root]);
  return {
    root,
    tools,
    list: (input = {}) => tools.find(tool => tool.name === 'list_workspace_files').execute('list', input),
  };
}

test('base workspace tools advertise listing and image reads but not read_workspace_file', async t => {
  const f = await workspace(t);
  assert.deepEqual(f.tools.map(tool => tool.name), ['list_workspace_files', 'read_image'],
    'read_workspace_code is the canonical file read; the base read tool is gone');
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
  assert.deepEqual(asFile.details.entries, []);
  const present = await f.list({});
  assert.equal(present.details.exists, true);
  assert.deepEqual(present.details.entries.map(entry => [entry.name, entry.type]), [['data.txt', 'file'], ['nested', 'directory']]);
});

test('directory pages continue with nextOffset and truncate cleanly', async t => {
  const f = await workspace(t);
  const first = await f.list({ limit: 1 });
  assert.equal(first.details.entries.length, 1);
  assert.equal(first.details.totalEntries, 2);
  assert.equal(first.details.nextOffset, 1);
  assert.equal(first.details.truncated, true);
  const second = await f.list({ offset: first.details.nextOffset, limit: 1 });
  assert.equal(second.details.nextOffset, null);
  assert.equal(second.details.truncated, false);
  await assert.rejects(f.list({ limit: 501 }), () => true);
});

test('完全模式 lifts the workspace boundary while the default mode still rejects escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-full-'));
  const outside = await mkdtemp(join(tmpdir(), 'workspace-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, 'far.txt'), 'outside the workspace root');

  // Default (人工/自动) keeps the boundary contract.
  const confined = await createWorkspaceTools([root]);
  const confinedList = confined.find(tool => tool.name === 'list_workspace_files');
  await assert.rejects(confinedList.execute('list', { path: '..' + join('/', 'escape') }), error => error.code === 'WORKSPACE_BOUNDARY');
  await assert.rejects(confinedList.execute('list', { path: join(outside, 'far.txt') }), error => error.code === 'WORKSPACE_BOUNDARY');

  // 完全模式 lists any absolute path on the machine.
  const open = await createWorkspaceTools([root], { unbounded: true });
  const openList = open.find(tool => tool.name === 'list_workspace_files');
  const far = await openList.execute('list', { path: outside });
  assert.equal(far.details.exists, true);
  assert.deepEqual(far.details.entries.map(entry => entry.name), ['far.txt']);
});

test('read_image is the only base tool that may widen to absolute external paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-image-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'workspace-image-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(outside, 'screen.png'), png);

  const tools = await createWorkspaceTools([root]);
  // The listing stays bounded; only the read-only image tool accepts the file.
  await assert.rejects(tools.find(tool => tool.name === 'list_workspace_files').execute('list', { path: outside }), error => error.code === 'WORKSPACE_BOUNDARY');
  const read = await tools.find(tool => tool.name === 'read_image').execute('read', { path: join(outside, 'screen.png') });
  assert.equal(read.details.external, true);
  assert.equal(read.details.mimeType, 'image/png');
  assert.equal(read.details.width, 1);
  assert.equal(read.details.height, 1);
  assert.equal(read.content.filter(part => part.type === 'image').length, 1);
});
