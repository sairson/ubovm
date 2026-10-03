import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPythonEnvironmentTool, validatePythonPackages } from '../environment.mjs';
import { acquireEnvironmentLease, environmentPython, environmentMatchesBase, publishPythonEnvironment, readPythonEnvironment, validatePythonEnvironmentFiles } from '../environment-state.mjs';
import { validatePythonPaths } from '../files.mjs';
import { createPythonTool } from '../index.mjs';
import { createInternalTools } from '../../../index.mjs';

async function fixture(t) {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'ubovm-python-env-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
test('package requirements accept constraints and reject command, URL and local-file injection', () => {
  assert.deepEqual(validatePythonPackages(['requests[socks]>=2.32,<3', 'idna==3.10', 'idna==3.10']), ['requests[socks]>=2.32,<3', 'idna==3.10']);
  for (const value of ['--target=x', 'pkg @ https://example.com/a.whl', '../local', '-rfile', 'x;echo a', 'x\n--index-url=evil', 'idna\n', 'git+https://example.com', ''])
    assert.throws(() => validatePythonPackages([value]));
});
test('environment tool is registered and disabled together with Python execution', async () => {
  const enabled = await createInternalTools({ sessionId: 'env-tools', allowedTools: ['manage_python_environment'] });
  try { assert.equal((await enabled.forWorker('w'))[0].name, 'manage_python_environment'); } finally { await enabled.close(); }
  const disabled = await createInternalTools({ sessionId: 'no-env-tools', allowedTools: ['manage_python_environment'], python: false });
  try { assert.deepEqual(await disabled.forWorker('w'), []); } finally { await disabled.close(); }
});
test('invalid management inputs fail before creating state or invoking Python', async t => {
  const cwd = await fixture(t), tool = createPythonEnvironmentTool({ cwd, allowedDomains: [] });
  for (const args of [{ action: 'sync' }, { action: 'reset', packages: [] }, { action: 'sync', packages: ['-rfoo'] },
    { action: 'status', manager: 'pip' }, { action: 'sync', packages: [], manager: 'bad' }, { action: 'sync', packages: [], executable: 'x' }])
    await assert.rejects(tool.execute('bad', { ...args, reason: 'test' }));
  assert.equal(await readPythonEnvironment(cwd), null);
  await assert.rejects(tool.execute('network', { action: 'sync', packages: ['idna'], reason: 'test' }), { code: 'PYTHON_PACKAGE_NETWORK_REQUIRED' });
  await assert.rejects(tool.execute('uv-network', { action: 'sync', packages: [], manager: 'uv', reason: 'test' }), { code: 'PYTHON_PACKAGE_NETWORK_REQUIRED' });
});
test('managed state rejects redirected state directories and out-of-workspace environments', async t => {
  const cwd = await fixture(t), outside = await fixture(t);
  await symlink(outside, join(cwd, '.ubovm-python'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishPythonEnvironment(cwd, null), /real workspace/);
  const clean = await fixture(t); await mkdir(join(clean, '.ubovm-python'));
  await writeFile(join(clean, '.ubovm-python/environment.json'), JSON.stringify({ version: 1, directory: outside, manager: 'pip', packages: [], baseExecutable: process.execPath, baseTarget: process.execPath }));
  await assert.rejects(readPythonEnvironment(clean), /escaped/);
});

async function managedFixture(t) {
  const cwd = await fixture(t), directory = join(cwd, '.ubovm-python-output', 'run-' + randomUUID(), 'environment');
  await mkdir(join(directory, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  await writeFile(environmentPython(directory), 'fixture only; never executed');
  await writeFile(join(directory, 'pyvenv.cfg'), `home = ${cwd}\ninclude-system-site-packages = false\n`);
  const state = { version: 1, directory, baseExecutable: process.execPath, baseTarget: await realpath(process.execPath), manager: 'pip', packages: [] };
  await publishPythonEnvironment(cwd, state);
  return { cwd, directory, state };
}

test('queued execution rejects changed venv configuration and changed interpreter contents', async t => {
  for (const component of ['config', 'interpreter']) {
    const { cwd, directory } = await managedFixture(t);
    const request = { workspace: cwd, cwd, executable: environmentPython(directory), executableTarget: await realpath(environmentPython(directory)),
      environmentIdentity: await validatePythonEnvironmentFiles(directory), outputDirectory: join(cwd, '.ubovm-python-output', 'run-' + randomUUID()) };
    await validatePythonPaths(request);
    if (component === 'config') await writeFile(join(directory, 'pyvenv.cfg'), `home = ${join(cwd, 'different-base')}\ninclude-system-site-packages = false\n`);
    else await writeFile(environmentPython(directory), 'replaced interpreter of a different size');
    await assert.rejects(validatePythonPaths(request), { code: 'PYTHON_ENVIRONMENT_CHANGED' });
  }
});

test('reset after admission does not redirect an already selected environment', async t => {
  const { cwd, directory } = await managedFixture(t);
  const request = { workspace: cwd, cwd, executable: environmentPython(directory), executableTarget: await realpath(environmentPython(directory)),
    environmentIdentity: await validatePythonEnvironmentFiles(directory), outputDirectory: join(cwd, '.ubovm-python-output', 'run-' + randomUUID()) };
  await publishPythonEnvironment(cwd, null);
  assert.equal(await readPythonEnvironment(cwd), null);
  await validatePythonPaths(request);
});

test('cancelling publication after its temporary write retains the prior selection and removes temporary metadata', async t => {
  const { cwd, state } = await managedFixture(t);
  let checks = 0;
  await assert.rejects(publishPythonEnvironment(cwd, null, { throwIfAborted() {
    if (++checks === 2) throw new Error('cancel before publish');
  } }), /cancel before publish/);
  assert.deepEqual(await readPythonEnvironment(cwd), state);
  assert.deepEqual(await readdir(join(cwd, '.ubovm-python')), ['environment.json']);
});

test('missing interpreter or venv config is reported as corruption instead of falling back to base Python', async t => {
  for (const component of ['interpreter', 'config']) {
    const { cwd, directory } = await managedFixture(t);
    await rm(component === 'interpreter' ? environmentPython(directory) : join(directory, 'pyvenv.cfg'));
    await assert.rejects(readPythonEnvironment(cwd), { code: 'PYTHON_ENVIRONMENT_INVALID' });
    const status = await createPythonEnvironmentTool({ cwd, executable: process.execPath }).execute('status', { action: 'status', reason: 'Diagnose missing files' });
    const info = JSON.parse(status.content[0].text);
    assert.equal(info.active, false); assert.equal(info.available, false);
    assert.deepEqual(info.recovery, ['sync', 'reset']);
    await assert.rejects(createPythonTool({ cwd, executable: process.execPath }).execute('run', { code: 'print(1)', reason: 'Reject broken environment' }),
      { code: 'PYTHON_ENVIRONMENT_INVALID' });
    await createPythonEnvironmentTool({ cwd }).execute('reset', { action: 'reset', reason: 'Recover broken selection' });
    assert.equal(await readPythonEnvironment(cwd), null);
  }
});

test('metadata validation rejects oversized files and altered venv isolation settings', async t => {
  const { cwd, directory } = await managedFixture(t);
  for (const config of ['x'.repeat(65537), `home = ${cwd}\ninclude-system-site-packages = true\n`, 'home = relative\ninclude-system-site-packages = false\n']) {
    await writeFile(join(directory, 'pyvenv.cfg'), config);
    await assert.rejects(readPythonEnvironment(cwd), { code: 'PYTHON_ENVIRONMENT_INVALID' });
  }
  await writeFile(join(cwd, '.ubovm-python/environment.json'), '{bad json');
  const result = await createPythonEnvironmentTool({ cwd, executable: process.execPath }).execute('status', { action: 'status', reason: 'Diagnose bad state' });
  assert.equal(JSON.parse(result.content[0].text).available, false);
});
test('changing the configured venv invalidates selection even when both point to the same base binary', () => {
  const state = { baseExecutable: '/first/bin/python', baseTarget: '/base/bin/python' };
  assert(environmentMatchesBase(state, { executable: state.baseExecutable, executableTarget: state.baseTarget }));
  assert(!environmentMatchesBase(state, { executable: '/second/bin/python', executableTarget: state.baseTarget }));
  assert(!environmentMatchesBase(state, { executable: state.baseExecutable, executableTarget: '/new/bin/python' }));
});
test('environment lease serializes mutation and cancellation releases waiting resources', async t => {
  const cwd = await fixture(t), release = await acquireEnvironmentLease(cwd, new AbortController().signal);
  try { await assert.rejects(acquireEnvironmentLease(cwd, AbortSignal.timeout(50)), /aborted|timeout/i); }
  finally { await release(); }
  const next = await acquireEnvironmentLease(cwd, AbortSignal.timeout(1000)); await next();
});
test('real sandbox creates a pip environment, selects it, checks it and resets without deleting files', {
  skip: process.env.UBOVM_PYTHON_SANDBOX_TEST !== '1', timeout: 180000
}, async t => {
  const cwd = await fixture(t), tool = createPythonEnvironmentTool({ cwd });
  const result = await tool.execute('empty-env', { action: 'sync', packages: [], reason: 'Create isolated pip environment' });
  assert.equal(result.details.cleanup_confirmed, true);
  const state = await readPythonEnvironment(cwd); assert.equal(state.manager, 'pip');
  const python = createPythonTool({ cwd });
  const executed = await python.execute('use-env', { code: "import sys;assert sys.prefix!=sys.base_prefix;print('managed-env-ok')", reason: 'Verify active environment' });
  assert.match(executed.content[0].text, /managed-env-ok/);
  const listed = await tool.execute('list-env', { action: 'list', reason: 'Inspect installed packages' });
  assert.match(listed.content[0].text, /pip/);
  await tool.execute('check-env', { action: 'check', reason: 'Check dependency consistency' });
  const controller = new AbortController();
  const pending = tool.execute('cancel-env', { action: 'sync', packages: [], reason: 'Cancel dependency preparation' }, controller.signal,
    update => { if (update.content[0].text.includes('Creating isolated')) controller.abort(new Error('cancel install')); });
  await assert.rejects(pending, /cancel install/);
  assert.deepEqual(await readPythonEnvironment(cwd), state);
  await tool.execute('reset-env', { action: 'reset', reason: 'Return to bundled interpreter' });
  assert.equal(await readPythonEnvironment(cwd), null);
  assert.match(await readFile(join(state.directory, 'pyvenv.cfg'), 'utf8'), /home/);
});
test('pip and uv install PyPI wheels inside new sandbox generations', {
  skip: process.env.UBOVM_PYTHON_PACKAGES_TEST !== '1', timeout: 300000
}, async t => {
  const cwd = await fixture(t), tool = createPythonEnvironmentTool({ cwd, allowedDomains: ['pypi.org', 'files.pythonhosted.org'] });
  for (const manager of ['pip', 'uv']) {
    const result = await tool.execute('install-' + manager, { action: 'sync', manager, packages: ['idna==3.10'], reason: 'Verify ' + manager + ' wheel installation', timeout_seconds: 120 });
    assert.equal(result.details.cleanup_confirmed, true);
    const run = await createPythonTool({ cwd }).execute('import-idna', { code: "import idna;assert idna.__version__=='3.10';print('idna-ok')", reason: 'Verify installed dependency' });
    assert.match(run.content[0].text, /idna-ok/);
  }
  const state = await readPythonEnvironment(cwd);
  await assert.rejects(tool.execute('conflict', { action: 'sync', packages: ['idna==3.10', 'idna==3.9'], reason: 'Verify failed sync preserves active environment', timeout_seconds: 120 }));
  assert.deepEqual(await readPythonEnvironment(cwd), state);
});
