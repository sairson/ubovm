import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceTools } from '../workspace-tools.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');

test('read_image returns the image content and bounded metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ubovm-read-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'screen.png'), PNG);
  const tools = await createWorkspaceTools([root]);
  const readImage = tools.find(tool => tool.name === 'read_image');
  assert.ok(readImage, 'read_image is registered');
  const result = await readImage.execute('call-1', { path: 'screen.png' });
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.equal(result.content[0].data, PNG.toString('base64'));
  assert.deepEqual(JSON.parse(result.content[1].text), { exists: true, path: 'screen.png', root: 0, mimeType: 'image/png', bytes: PNG.length });
  assert.equal(result.details.bytes, PNG.length);

  const missing = await readImage.execute('call-2', { path: 'missing.png' });
  assert.equal(missing.details.exists, false);
  await assert.rejects(readImage.execute('call-3', { path: '../outside.png' }), error => error.code === 'WORKSPACE_BOUNDARY');
});
