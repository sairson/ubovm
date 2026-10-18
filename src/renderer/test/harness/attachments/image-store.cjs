'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=';

test('image attachment store validates, saves and reloads a PNG', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-image-store-'));
  const previous = process.env.UBOVM_IMAGE_ROOT;
  process.env.UBOVM_IMAGE_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.UBOVM_IMAGE_ROOT; else process.env.UBOVM_IMAGE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const store = require('../../../harness/attachments/image-store.cjs');
  const image = await store.saveImage({ conversationId: 'session-1', name: 'screen.png', mimeType: 'image/png', data: PNG });
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.bytes, Buffer.from(PNG, 'base64').length);
  assert.match(image.id, /^[a-f0-9]{32}$/);
  assert.equal(store.isManagedImage(image.path), true);
  assert.equal(store.isManagedImage(path.join(root, '..', 'outside.png')), false);
  const loaded = await store.loadImage(image.path);
  assert.equal(loaded.mimeType, 'image/png');
  assert.equal(loaded.data, PNG);
  const onDisk = await readFile(image.path);
  assert.deepEqual(onDisk, Buffer.from(PNG, 'base64'));

  await assert.rejects(store.saveImage({ conversationId: 'session-1', name: 'fake.png', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') }), /仅支持/);
  await assert.rejects(store.saveImage({ conversationId: 'session-1', name: 'x.png', mimeType: 'image/jpeg', data: PNG }), /类型不一致/);
});
