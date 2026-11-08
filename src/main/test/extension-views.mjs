import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { relocateExtensionViewContainers } from '../extension-views.mjs';

test('moves activity-bar view containers into the secondary sidebar', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-views-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = path.join(root, 'acme.chat-1.0.0');
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'package.json'), JSON.stringify({
    publisher: 'acme', name: 'chat', version: '1.0.0',
    contributes: { viewsContainers: { activitybar: [{ id: 'acme-chat', title: 'Acme' }], views: {} } }
  }, null, 2));
  const result = relocateExtensionViewContainers(root, { log() {}, warn() {} });
  assert.deepEqual(result.relocated, ['acme.chat']);
  const manifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.viewsContainers.activitybar, undefined);
  assert.deepEqual(manifest.contributes.viewsContainers.secondarySidebar, [{ id: 'acme-chat', title: 'Acme' }]);
});

test('leaves manifests with duplicate ids or no activity views untouched', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-views-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = path.join(root, 'acme.chat-1.0.0');
  await mkdir(extension, { recursive: true });
  const source = JSON.stringify({
    publisher: 'acme', name: 'chat', version: '1.0.0',
    contributes: { viewsContainers: {
      activitybar: [{ id: 'acme-chat', title: 'Acme' }],
      secondarySidebar: [{ id: 'acme-chat', title: 'Existing' }]
    } }
  }, null, 2);
  await writeFile(path.join(extension, 'package.json'), source);
  assert.deepEqual(relocateExtensionViewContainers(root, { log() {}, warn() {} }).relocated, []);
  assert.equal(await readFile(path.join(extension, 'package.json'), 'utf8'), source);
});
