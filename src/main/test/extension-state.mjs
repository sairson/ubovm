import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionStatePaths, readExtensionState, reconcileExtensionState, writeExtensionState } from '../extension-state.mjs';

test('reconciles disabled extensions between the extensions and disabled directories', async t => {
  const portable = await mkdtemp(path.join(tmpdir(), 'ubovm-ext-state-'));
  t.after(() => rm(portable, { recursive: true, force: true }));
  const paths = { portable, extensions: path.join(portable, 'extensions') };
  const state = extensionStatePaths(paths);
  const folder = path.join(paths.extensions, 'acme.scan-1.0.0');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'package.json'), '{"name":"scan"}');

  writeExtensionState(state.stateFile, { disabled: ['acme.scan-1.0.0'] });
  reconcileExtensionState(paths, { warn() {} });
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(path.join(state.disabled, 'acme.scan-1.0.0', 'package.json')), true);

  writeExtensionState(state.stateFile, { disabled: [] });
  const result = reconcileExtensionState(paths, { warn() {} });
  assert.equal(existsSync(folder), true);
  assert.deepEqual(result.enabled, ['acme.scan-1.0.0']);
  assert.deepEqual(readExtensionState(state.stateFile), { disabled: [] });
});

test('ignores unsafe or malformed disabled folder names', async t => {
  const portable = await mkdtemp(path.join(tmpdir(), 'ubovm-ext-state-'));
  t.after(() => rm(portable, { recursive: true, force: true }));
  const stateFile = extensionStatePaths({ portable }).stateFile;
  writeExtensionState(stateFile, { disabled: ['../escape', 'ok-name', 'bad name', 'ok-name'] });
  assert.deepEqual(readExtensionState(stateFile), { disabled: ['ok-name'] });
  await mkdir(path.join(portable, 'extensions'), { recursive: true });
  await mkdir(path.join(portable, 'disabled-extensions', 'ok-name'), { recursive: true });
  await writeFile(path.join(portable, 'disabled-extensions', 'ok-name', 'package.json'), '{"name":"ok"}');
  // A folder in disabled-extensions/ that is not recorded becomes enabled again.
  writeExtensionState(stateFile, { disabled: [] });
  const result = reconcileExtensionState({ portable }, { warn() {} });
  assert.equal(existsSync(path.join(portable, 'extensions', 'ok-name')), true);
  assert.ok(result.enabled.includes('ok-name'));
});
