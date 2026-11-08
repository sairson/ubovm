import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWorkbenchExtensionViews } from '../workbench-compat.mjs';

test('allows extension view containers in the workbench checks', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'ubovm-workbench-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const file = path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'if(a!=="terminal"&&a!=="workbench.view.extension.ubovm-workers")return;if(b==="terminal"||b==="workbench.view.extension.ubovm-workers")return;if(items.filter(c=>c.id==="terminal"||c.id==="workbench.view.extension.ubovm-workers")){}');
  assert.equal(ensureWorkbenchExtensionViews(app, { log() {} }), true);
  const text = await readFile(file, 'utf8');
  assert.match(text, /a\.startsWith\("workbench\.view\.extension\."\)/);
  assert.match(text, /b\.startsWith\("workbench\.view\.extension\."\)/);
  assert.match(text, /c\.id\.startsWith\("workbench\.view\.extension\."\)/);
  // Running again must be a no-op.
  assert.equal(ensureWorkbenchExtensionViews(app, { log() {} }), false);
});

test('leaves unrelated workbench content untouched', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'ubovm-workbench-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const file = path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'console.log("hello");');
  assert.equal(ensureWorkbenchExtensionViews(app, { log() {} }), false);
  assert.equal(await readFile(file, 'utf8'), 'console.log("hello");');
});
