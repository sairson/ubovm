import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotPythonWorkspace } from '../workspace.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-input-copy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'source'), control = join(root, 'control');
  await mkdir(workspace); await mkdir(control);
  return { root, control, request: { workspace, cwd: workspace, arguments: [], outputDirectory: join(root, 'output') } };
}
const signal = () => new AbortController().signal;

test('input snapshot preserves scripts/data, excludes caches and never copies secret bytes', async t => {
  const { request, control } = await fixture(t);
  await mkdir(join(request.workspace, 'scripts')); await mkdir(join(request.workspace, 'node_modules'));
  await writeFile(join(request.workspace, 'scripts/main.py'), 'print(42)');
  await writeFile(join(request.workspace, 'data.csv'), 'a,b'); await writeFile(join(request.workspace, '.env'), 'SECRET=private');
  await mkdir(join(request.workspace, '.codex')); await writeFile(join(request.workspace, '.codex/config.toml'), 'private');
  await writeFile(join(request.workspace, 'node_modules/large.bin'), Buffer.alloc(2048));
  request.script = join(request.workspace, 'scripts/main.py'); request.arguments = [join(request.workspace, 'data.csv'), 'relative.csv'];
  const result = await snapshotPythonWorkspace(request, control, signal(), { maxBytes: 100 });
  assert.equal(await readFile(result.request.script, 'utf8'), 'print(42)');
  assert.equal(await readFile(result.request.arguments[0], 'utf8'), 'a,b');
  assert.equal(result.request.arguments[1], 'relative.csv');
  await assert.rejects(readFile(join(result.request.workspace, '.env')), { code: 'ENOENT' });
  await assert.rejects(readdir(join(result.request.workspace, '.codex')), { code: 'ENOENT' });
  assert.equal(await readFile(join(request.workspace, '.codex/config.toml'), 'utf8'), 'private');
  assert(!(await readdir(result.request.workspace)).includes('node_modules'));
  assert.equal(result.request.outputDirectory, request.outputDirectory); assert.equal(result.metadata.files, 2);
});

test('oversized inputs and pre-cancelled snapshots fail before execution', async t => {
  const { request, control } = await fixture(t); await writeFile(join(request.workspace, 'large.bin'), Buffer.alloc(128));
  await assert.rejects(snapshotPythonWorkspace(request, control, signal(), { maxBytes: 64 }), { code: 'PYTHON_INPUT_SNAPSHOT_FAILED' });
  const next = join(control, 'next'); await mkdir(next);
  await assert.rejects(snapshotPythonWorkspace(request, next, AbortSignal.abort(new Error('cancel inputs'))), /cancel inputs/);
});

test('symlink inputs are skipped instead of granting access outside the workspace', async t => {
  const { root, request, control } = await fixture(t), outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'private'), 'secret'); await symlink(outside, join(request.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await snapshotPythonWorkspace(request, control, signal());
  assert.deepEqual(await readdir(result.request.workspace), []); assert.equal(result.metadata.skipped, 1);
});

test('explicit data arguments inside excluded directories select only required files', async t => {
  const { request, control } = await fixture(t); await mkdir(join(request.workspace, 'dist'));
  await writeFile(join(request.workspace, 'dist/data.csv'), 'x,y'); await writeFile(join(request.workspace, 'dist/huge.bin'), Buffer.alloc(2048));
  request.arguments = ['dist/data.csv'];
  const result = await snapshotPythonWorkspace(request, control, signal(), { maxBytes: 100 });
  assert.deepEqual(await readdir(join(result.request.workspace, 'dist')), ['data.csv']);
});

test('mixed-case secrets never enter snapshots and mixed-case caches are skipped', async t => {
  const { request, control } = await fixture(t);
  await writeFile(join(request.workspace, '.ENV.production'), 'SECRET=private');
  await mkdir(join(request.workspace, 'Node_Modules'));
  await writeFile(join(request.workspace, 'Node_Modules/large.bin'), Buffer.alloc(2048));
  const result = await snapshotPythonWorkspace(request, control, signal(), { maxBytes: 100 });
  await assert.rejects(readFile(join(result.request.workspace, '.ENV.production')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(result.request.workspace), []);
  assert.equal(result.metadata.bytes, 0);
});

test('absolute output arguments remain writable original paths without copying previous outputs', async t => {
  const { request, control } = await fixture(t);
  request.outputDirectory = join(request.workspace, '.ubovm-python-output/run-current');
  await mkdir(request.outputDirectory, { recursive: true });
  await writeFile(join(request.outputDirectory, 'previous.bin'), Buffer.alloc(2048));
  const output = join(request.outputDirectory, 'result.csv');
  request.arguments = [output, '.ubovm-python-output/run-current/relative.csv'];
  const result = await snapshotPythonWorkspace(request, control, signal(), { maxBytes: 100 });
  assert.equal(result.request.arguments[0], output);
  assert.equal(result.request.arguments[1], join(request.outputDirectory, 'relative.csv'));
  assert.deepEqual(await readdir(result.request.workspace), []);
});

test('large-file copying checks cancellation between chunks and closes file handles', async t => {
  const { request, control } = await fixture(t);
  await writeFile(join(request.workspace, 'large.bin'), Buffer.alloc(2 << 20));
  const controller = new AbortController();
  let checks = 0;
  const cancellingSignal = { throwIfAborted() {
    if (++checks === 8) controller.abort(new Error('cancel during copy'));
    controller.signal.throwIfAborted();
  } };
  await assert.rejects(snapshotPythonWorkspace(request, control, cancellingSignal), /cancel during copy/);
  const copied = join(control, 'workspace/large.bin');
  assert((await stat(copied)).size < 2 << 20);
  await rm(copied);
});

test('chunked copies preserve binary contents including empty files', async t => {
  const { request, control } = await fixture(t);
  const data = Buffer.alloc(150001);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  await writeFile(join(request.workspace, 'data.bin'), data);
  await writeFile(join(request.workspace, 'empty'), '');
  const result = await snapshotPythonWorkspace(request, control, signal());
  assert.deepEqual(await readFile(join(result.request.workspace, 'data.bin')), data);
  assert.equal((await stat(join(result.request.workspace, 'empty'))).size, 0);
  assert.equal(result.metadata.bytes, data.length);
});
