import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { acquirePythonBuildLease, completePythonRuntime, preparePython, pythonAsset,
  recoverPythonRuntime, replacePythonRuntime } from '../prepare-python.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(t) {
  const cache = join(root, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'python-preparation-'));
  t.after(async () => {
    assert(!relative(cache, directory).startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('matching runtime marker cannot hide a failed startup or wrong Python version', async t => {
  const directory = await fixture(t), asset = { executable: 'python.exe', version: '3.13.15', sha256: 'test' };
  await writeFile(join(directory, '.ubovm-python-runtime.json'), JSON.stringify(asset));
  assert.equal(await completePythonRuntime(directory, asset, async () => { throw new Error('missing DLL'); }), false);
  assert.equal(await completePythonRuntime(directory, asset, async () => ({ stdout: '3.12.0' })), false);
  assert.equal(await completePythonRuntime(directory, asset, async (_file, args, options) => {
    assert(args.includes('-I')); assert(args.includes('-B')); assert.equal(options.timeout, 30000);
    return { stdout: '3.13.15\n' };
  }), true);
});

test('failed promotion restores the previous runtime intact', async t => {
  const directory = await fixture(t), destination = join(directory, 'runtime'), staging = join(directory, 'staging');
  await mkdir(destination); await mkdir(staging);
  await writeFile(join(destination, 'old'), 'working'); await writeFile(join(staging, 'new'), 'replacement');
  await assert.rejects(replacePythonRuntime(staging, destination, async (from, to) => {
    if (from === staging) throw new Error('promotion denied');
    await rename(from, to);
  }), /promotion denied/);
  assert.equal(await readFile(join(destination, 'old'), 'utf8'), 'working');
  assert.equal(await readFile(join(staging, 'new'), 'utf8'), 'replacement');
  await assert.rejects(access(destination + '.previous'), { code: 'ENOENT' });
});

test('interrupted replacement recovers its backup before the next attempt', async t => {
  const directory = await fixture(t), destination = join(directory, 'runtime');
  await mkdir(destination + '.previous'); await writeFile(join(destination + '.previous', 'old'), 'working');
  await recoverPythonRuntime(destination);
  assert.equal(await readFile(join(destination, 'old'), 'utf8'), 'working');
  await recoverPythonRuntime(destination);
  assert.equal(await readFile(join(destination, 'old'), 'utf8'), 'working');
});

test('failed rollback preserves the backup for recovery on the next build', async t => {
  const directory = await fixture(t), destination = join(directory, 'runtime'), staging = join(directory, 'staging');
  await mkdir(destination); await mkdir(staging); await writeFile(join(destination, 'old'), 'working');
  await assert.rejects(replacePythonRuntime(staging, destination, async (from, to) => {
    if (from !== destination) throw new Error('temporarily locked');
    await rename(from, to);
  }), AggregateError);
  await recoverPythonRuntime(destination);
  assert.equal(await readFile(join(destination, 'old'), 'utf8'), 'working');
});

test('successful promotion removes backup and publishes the staged directory', async t => {
  const directory = await fixture(t), destination = join(directory, 'runtime'), staging = join(directory, 'staging');
  await mkdir(destination); await mkdir(staging); await writeFile(join(staging, 'new'), 'replacement');
  await replacePythonRuntime(staging, destination);
  assert.equal(await readFile(join(destination, 'new'), 'utf8'), 'replacement');
  await assert.rejects(access(destination + '.previous'), { code: 'ENOENT' });
});

test('concurrent preparations wait, allow cancellation, and can reacquire the build lease', async () => {
  const release = await acquirePythonBuildLease();
  try {
    await assert.rejects(acquirePythonBuildLease(AbortSignal.timeout(50)), { name: 'AbortError' });
  } finally { await release(); }
  const next = await acquirePythonBuildLease(AbortSignal.timeout(2000)); await next();
});

test('a runtime with a missing SQLite extension is repaired from the bundled cache', {
  skip: process.env.UBOVM_PACKAGED_PYTHON_TEST !== '1' || process.platform !== 'win32', timeout: 120000
}, async t => {
  const directory = await fixture(t), destination = join(directory, 'runtime');
  const manifest = JSON.parse(await readFile(join(root, 'resources/python-runtime.json'), 'utf8'));
  const asset = pythonAsset(manifest);
  await preparePython(destination);
  const extension = join(destination, 'DLLs/_sqlite3.pyd');
  await access(extension); await rm(extension);
  assert.equal(await completePythonRuntime(destination, asset), false);
  await preparePython(destination);
  assert.equal(await completePythonRuntime(destination, asset), true);
  await access(extension);
});
