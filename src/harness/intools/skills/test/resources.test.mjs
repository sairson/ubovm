import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillResourceTool } from '../resources.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'skill-resource-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('small resources do not allocate the entire configured resource limit', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'small.txt'), 'small 中文');
  const original = Buffer.alloc;
  const allocations = [];
  t.mock.method(Buffer, 'alloc', function (size, ...args) { allocations.push(size); return original(size, ...args); });
  const tool = createSkillResourceTool({ cwd, maxBytes: 100 << 20 });
  const result = await tool.execute('read', { path: 'small.txt' });
  assert.equal(result.content[0].text, 'small 中文');
  assert.ok(allocations.every(size => size < 1024 * 1024));
});

test('resource byte boundaries preserve binary data and reject oversize files', async t => {
  const cwd = await fixture(t);
  const tool = createSkillResourceTool({ cwd, maxBytes: 4 });
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 255, 1, 2]));
  assert.equal((await tool.execute('binary', { path: 'binary' })).details.content, 'AP8BAg==');
  await writeFile(join(cwd, 'large'), '12345');
  await assert.rejects(tool.execute('large', { path: 'large' }), /exceeds 4 bytes/);
  await writeFile(join(cwd, 'empty'), '');
  assert.equal((await tool.execute('empty', { path: 'empty' })).content[0].text, '');
  assert.equal((await tool.execute('missing', { path: 'missing' })).details.status, 'not_found');
});
