import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { pythonAsset } from '../prepare-python.mjs';

const manifest = JSON.parse(await readFile(new URL('../../../resources/python-runtime.json', import.meta.url), 'utf8'));
test('all desktop architectures have a pinned portable Python archive and digest', () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const asset = pythonAsset(manifest, platform, arch);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.equal(asset.version, manifest.version);
    assert(asset.url.startsWith('https://github.com/astral-sh/python-build-standalone/releases/download/'));
    assert(asset.url.includes(encodeURIComponent(asset.filename)));
  }
  assert.throws(() => pythonAsset(manifest, 'freebsd'), /No bundled Python/);
});

test('packaged Python executes without a system Python on PATH', {
  skip: process.env.UBOVM_PACKAGED_PYTHON_TEST !== '1' || process.platform !== 'win32', timeout: 60000
}, async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = JSON.parse(await readFile(join(root, 'resources/app.json'), 'utf8'));
  const app = resolve(root, config.core.runtime.directory, 'resources/app/ubovm');
  const { createPythonTool } = await import(pathToFileURL(join(app, 'harness/intools/terminals/python/index.mjs')));
  const cache = join(root, '.cache'); await mkdir(cache, { recursive: true });
  const cwd = await mkdtemp(join(cache, 'packaged-python-'));
  t.after(async () => { assert(!relative(cache, cwd).startsWith('..')); await rm(cwd, { recursive: true, force: true }); });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const result = await createPythonTool({ cwd, defaultTimeoutSeconds: 30 }).execute('package-smoke', {
      code: 'import sys,ssl,sqlite3;print(sys.version_info[:3]);print("packaged-python-ok")', reason: 'Verify packaged runtime without host Python'
    });
    assert.equal(result.details.python, join(app, 'runtime/python/python.exe'));
    assert.equal(result.details.cleanup_confirmed, true);
    assert.match(result.content[0].text, /packaged-python-ok/);
    assert(result.details.input_snapshot);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
});
