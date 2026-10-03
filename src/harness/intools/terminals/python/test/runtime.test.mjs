import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledPythonCandidates } from '../runtime.mjs';
import { resolvePython, pythonPolicy, omitMissingPythonDenyPaths, workspacePrivatePythonPaths } from '../policy.mjs';

test('packaged runtime resolves relative to the SDK, independent of cwd and PATH', () => {
  const root = resolve('test-packaged-root');
  const moduleURL = pathToFileURL(join(root, 'harness/intools/terminals/python/runtime.mjs'));
  assert.equal(bundledPythonCandidates({ platform: 'win32', arch: 'x64', moduleURL })[0], join(root, 'runtime/python/python.exe'));
  assert.equal(bundledPythonCandidates({ platform: 'linux', arch: 'arm64', moduleURL })[0], join(root, 'runtime/python/bin/python3'));
});

test('explicit interpreter wins; bundled interpreter wins over PATH and works without PATH', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-python-selection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'host'); await mkdir(bin);
  const host = join(bin, process.platform === 'win32' ? 'python.exe' : 'python3');
  const bundled = join(root, 'bundled-python'), explicit = join(root, 'explicit-python');
  for (const file of [host, bundled, explicit]) await writeFile(file, '', { mode: 0o755 });
  assert.equal((await resolvePython(undefined, { PATH: bin }, undefined, { bundled: [bundled] })).executable, bundled);
  assert.equal((await resolvePython(undefined, {}, undefined, { bundled: [bundled] })).executable, bundled);
  assert.equal((await resolvePython(explicit, { PATH: bin }, undefined, { bundled: [bundled] })).executable, explicit);
  assert.equal((await resolvePython(undefined, { PATH: bin }, undefined, { bundled: [join(root, 'missing')] })).executable, host);
  await assert.rejects(resolvePython(join(root, 'missing'), { PATH: bin }, undefined, { bundled: [bundled] }), /unavailable/);
});

test('Windows ACL exceptions cover grants without stamping unrelated host trees', () => {
  const workspace = resolve('workspace'), runtime = resolve('runtime'), home = resolve('host-home');
  const input = { workspace, outputDirectory: join(workspace, '.out'), controlDirectory: resolve('control'), readRoots: [runtime],
    protectedRuntimePaths: [join(workspace, 'node_modules'), resolve('external-runtime')] };
  const readonly = pythonPolicy(input, 'win32', home);
  assert(readonly.filesystem.denyRead.includes(join(workspace, '.env')));
  assert(!readonly.filesystem.denyRead.includes(join(home, '.codex')));
  assert(!readonly.filesystem.denyWrite.includes(runtime));
  assert.deepEqual(readonly.filesystem.allowWrite, [input.outputDirectory]);
  const writable = pythonPolicy({ ...input, allowWorkspaceWrite: true }, 'win32', home);
  assert(writable.filesystem.denyWrite.includes(join(workspace, 'node_modules')));
  assert(writable.filesystem.denyWrite.includes(join(workspace, '.git')));
  const userWorkspace = pythonPolicy({ ...input, workspace: home, outputDirectory: join(home, '.out') }, 'win32', home);
  assert(userWorkspace.filesystem.denyRead.includes(join(home, '.codex')));
});

test('Windows ACL policy omits missing targets while retaining existing sensitive files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-python-no-placeholder-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = join(root, '.env'), codex = join(root, '.codex');
  await writeFile(env, 'real configuration'); await mkdir(codex);
  const policy = pythonPolicy({ workspace: root, outputDirectory: join(root, 'output'), controlDirectory: root,
    readRoots: [], privatePaths: [], allowWorkspaceWrite: true }, 'win32', root);
  await omitMissingPythonDenyPaths(policy, 'win32');
  assert(policy.filesystem.denyRead.includes(env));
  assert(policy.filesystem.denyRead.includes(codex));
  assert(!policy.filesystem.denyWrite.includes(env));
  assert(!policy.filesystem.denyWrite.includes(codex));
  for (const key of ['denyRead', 'denyWrite']) {
    assert(!policy.filesystem[key].includes(join(root, '.agents')));
    assert(!policy.filesystem[key].includes(join(root, '.git')));
  }
});

test('existing env variants and credential directories remain protected when workspace writes are enabled', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-python-private-paths-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['.env.local', '.ENV.production', 'ordinary.txt']) await writeFile(join(root, name), 'data');
  await mkdir(join(root, '.ssh'));
  const paths = await workspacePrivatePythonPaths(root);
  assert.deepEqual(paths.sort(), ['.env.local', '.ENV.production', '.ssh'].map(name => join(root, name)).sort());
  const policy = pythonPolicy({ workspace: root, outputDirectory: join(root, 'output'), controlDirectory: root, readRoots: [],
    workspacePrivatePaths: paths, allowWorkspaceWrite: true }, 'win32');
  await omitMissingPythonDenyPaths(policy, 'win32');
  for (const path of paths) {
    assert(policy.filesystem.denyRead.includes(path)); assert(!policy.filesystem.denyWrite.includes(path));
  }
  await assert.rejects(workspacePrivatePythonPaths(root, { maxEntries: 1 }), { code: 'PYTHON_POLICY_LIMIT' });
  await assert.rejects(workspacePrivatePythonPaths(root, { signal: AbortSignal.abort(new Error('cancel scan')) }), /cancel scan/);
});

test('Windows ACL preparation rejects redirected targets including missing children without partially changing policy', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ubovm-python-policy-links-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside'), workspace = join(root, 'workspace');
  await mkdir(outside); await mkdir(workspace);
  await writeFile(join(outside, 'secret'), 'private');
  const link = join(workspace, '.ssh');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [link, join(link, 'secret'), join(link, 'missing', 'child')]) {
    const policy = { filesystem: { denyRead: [join(root, 'missing')], denyWrite: [path] } };
    const original = structuredClone(policy);
    await assert.rejects(omitMissingPythonDenyPaths(policy, 'win32'), { code: 'PYTHON_POLICY_PATH_REDIRECTED' });
    assert.deepEqual(policy, original);
  }
  // A dangling link must not be silently omitted as a missing sensitive path.
  await rm(outside, { recursive: true });
  await assert.rejects(omitMissingPythonDenyPaths({ filesystem: { denyRead: [link], denyWrite: [] } }, 'win32'),
    { code: 'PYTHON_POLICY_PATH_REDIRECTED' });
});

test('Windows ACL preparation honors cancellation before changing policy', async () => {
  const policy = { filesystem: { denyRead: [], denyWrite: [] } };
  await assert.rejects(omitMissingPythonDenyPaths(policy, 'win32', { signal: AbortSignal.abort(new Error('cancel permissions')) }), /cancel permissions/);
  assert.deepEqual(policy, { filesystem: { denyRead: [], denyWrite: [] } });
});
