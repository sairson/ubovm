import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkspaceTools } from '../workspace-tools.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubovm-read-image-'));
  const outside = await mkdtemp(join(tmpdir(), 'ubovm-read-image-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(root, 'screen.png'), PNG);
  await writeFile(join(outside, 'external.png'), PNG);
  await writeFile(join(outside, 'notes.txt'), 'not an image');
  return { root, outside };
}

test('read_image returns the image content and bounded metadata', async t => {
  const { root } = await fixture(t);
  const tools = await createWorkspaceTools([root]);
  const readImage = tools.find(tool => tool.name === 'read_image');
  assert.ok(readImage, 'read_image is registered');
  const result = await readImage.execute('call-1', { path: 'screen.png' });
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.equal(result.content[0].data, PNG.toString('base64'));
  const metadata = JSON.parse(result.content[1].text);
  assert.deepEqual(metadata, { exists: true, path: 'screen.png', root: 0, mimeType: 'image/png', format: 'png',
    bytes: PNG.length, width: 1, height: 1, external: false });
  assert.deepEqual(result.details, metadata);

  const missing = await readImage.execute('call-2', { path: 'missing.png' });
  assert.equal(missing.details.exists, false);
  assert.equal(missing.details.external, false);
  assert.match(missing.details.guidance, /does not exist/);
  await assert.rejects(readImage.execute('call-3', { path: '../outside.png' }), error => error.code === 'WORKSPACE_BOUNDARY');
});

test('read_image accepts absolute local image paths outside the workspace read-only', async t => {
  const { root, outside } = await fixture(t);
  const tools = await createWorkspaceTools([root]);
  const readImage = tools.find(tool => tool.name === 'read_image');
  // A relative traversal stays forbidden, but an explicit absolute path may be
  // inspected read-only so external screenshots/design references are usable.
  const external = await readImage.execute('call-1', { path: join(outside, 'external.png') });
  assert.equal(external.content[0].type, 'image');
  assert.equal(external.content[0].data, PNG.toString('base64'));
  assert.equal(external.details.path.endsWith('external.png'), true);
  assert.deepEqual({ ...external.details, path: undefined }, { exists: true, path: undefined, root: 0, mimeType: 'image/png',
    format: 'png', bytes: PNG.length, width: 1, height: 1, external: true });
  // A non-image path outside the roots is rejected with a typed error, and the
  // bytes are never returned.
  await assert.rejects(readImage.execute('call-2', { path: join(outside, 'notes.txt') }), error => error.code === 'IMAGE_UNSUPPORTED' && !('data' in error));
  // A missing external image is still an observation, not a tool failure.
  const missing = await readImage.execute('call-3', { path: join(outside, 'missing.png') });
  assert.equal(missing.details.exists, false);
  assert.equal(missing.details.external, true);
  // Absolute image paths keep working without any selected workspace root.
  const detached = await createWorkspaceTools([]);
  const detachedRead = detached.find(tool => tool.name === 'read_image');
  const standalone = await detachedRead.execute('call-4', { path: join(outside, 'external.png') });
  assert.equal(standalone.content[0].type, 'image');
  assert.equal(standalone.details.external, true);
});

test('read_image can forbid external paths while list_workspace_files stays bounded', async t => {
  const { root, outside } = await fixture(t);
  const tools = await createWorkspaceTools([root], { externalImages: false });
  const readImage = tools.find(tool => tool.name === 'read_image');
  await assert.rejects(readImage.execute('call-1', { path: join(outside, 'external.png') }), error => error.code === 'WORKSPACE_BOUNDARY');
  await assert.rejects(tools.find(tool => tool.name === 'list_workspace_files').execute('list', { path: outside }), error => error.code === 'WORKSPACE_BOUNDARY',
    'listing never accepts an external path');
});
