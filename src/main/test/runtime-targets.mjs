import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pythonAsset } from '../prepare-python.mjs';

const config = JSON.parse(await readFile(new URL('../../../resources/app.json', import.meta.url), 'utf8'));
const python = JSON.parse(await readFile(new URL('../../../resources/python-runtime.json', import.meta.url), 'utf8'));

const expected = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'];

test('pinned VSCodium runtimes cover the CI desktop targets', () => {
  assert.equal(config.core.runtime.platform, 'win32');
  assert.equal(config.core.runtime.arch, 'x64');
  for (const key of expected) {
    const runtime = config.core.runtimes[key];
    assert.ok(runtime, `missing runtime ${key}`);
    const [platform, arch] = key.split('-');
    assert.equal(runtime.platform, platform);
    assert.equal(runtime.arch, arch);
    assert.equal(runtime.provider, 'VSCodium');
    assert.equal(runtime.version, config.core.runtime.version);
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    assert.match(runtime.url, /^https:\/\/github\.com\/VSCodium\/vscodium\/releases\/download\//);
    assert.equal(runtime.url.endsWith('/' + runtime.archive), true);
    assert.match(runtime.directory, /^\.runtime\//);
    assert.ok(runtime.executable);
    pythonAsset(python, platform, arch);
  }
  const windows = config.core.runtimes['win32-x64'];
  assert.equal(windows.sha256, config.core.runtime.sha256);
  assert.equal(windows.directory, config.core.runtime.directory);
});
