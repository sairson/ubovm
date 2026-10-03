import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPythonTool } from '../index.mjs';
import { createInternalTools } from '../../../index.mjs';
import { contained } from '../../../shared/common.mjs';
import { pythonPolicy, pythonEnvironment, pythonCommand, resolvePython, privatePythonPaths } from '../policy.mjs';
import { acquirePythonLease } from '../lease.mjs';
import { runPythonSandbox } from '../execution.mjs';
import { runLocalProcess } from '../../../shared/process/local-process.mjs';

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'ubovm-python-test-'));
  t.after(async () => { assert(contained(parent, directory) && parent !== directory); await rm(directory, { recursive: true, force: true }); });
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  return { directory, workspace };
}
const input = { code: 'print(42)', reason: 'Verify Python execution' };

test('Python tool is registered for Workers, exposes no permission override, and supports SDK opt-out', async () => {
  const runtime = await createInternalTools({ sessionId: 'python', allowedTools: ['run_python'] });
  try {
    const [tool] = await runtime.forWorker('worker'); assert.equal(tool.name, 'run_python');
    for (const key of ['executable', 'allowedDomains', 'allowWorkspaceWrite', 'sandbox']) assert.equal(tool.parameters.properties[key], undefined);
  } finally { await runtime.close(); }
  const disabled = await createInternalTools({ sessionId: 'python-off', allowedTools: ['run_python'], python: false });
  try { assert.deepEqual(await disabled.forWorker('worker'), []); } finally { await disabled.close(); }
});

test('validates source, arguments, permissions, cancellation, and workspace boundaries before spawning', async t => {
  const { directory, workspace } = await fixture(t);
  const tool = createPythonTool({ cwd: workspace, executable: join(directory, 'missing-python') });
  for (const bad of [{}, { ...input, script: 'a.py' }, { ...input, code: ' ' }, { ...input, code: 'x'.repeat(262145) },
    { ...input, reason: '' }, { ...input, arguments: ['x\0'] }, { ...input, executable: process.execPath }, { ...input, timeout_seconds: 0 }]) {
    await assert.rejects(tool.execute('invalid', bad));
  }
  await writeFile(join(directory, 'outside.py'), 'print(1)');
  await assert.rejects(tool.execute('outside', { reason: 'test', script: '../outside.py' }), /inside this workspace/);
  await assert.rejects(tool.execute('cwd', { ...input, cwd: '..' }), /inside this workspace/);
  await symlink(directory, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tool.execute('link', { reason: 'test', script: 'escape/outside.py' }), /inside this workspace/);
  await assert.rejects(tool.execute('abort', input, AbortSignal.abort(new Error('cancel-before-run'))), /cancel-before-run/);
  await assert.rejects(tool.execute('missing', input), /interpreter unavailable/);
});

test('policy defaults to output-only writes and excludes credentials from the runner environment', () => {
  const policy = pythonPolicy({ workspace: '/work', outputDirectory: '/out', controlDirectory: '/control', readRoots: ['/python'] }, 'linux', '/home/user');
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.deepEqual(policy.filesystem.allowWrite, ['/out']);
  assert(policy.filesystem.denyRead.includes(join('/home/user', '.ssh')));
  const env = pythonEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', PYTHONPATH: 'malicious', NODE_OPTIONS: '--require=malicious', HTTP_PROXY: 'http://secret' });
  assert.deepEqual(env, { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
});

test('default IDE workspace and portable temp do not inherit a deny on their private ancestors', async t => {
  const { directory } = await fixture(t);
  const root = join(directory, '.ubovm');
  const workspace = join(root, 'workspace', 'session-a'), other = join(root, 'workspace', 'session-b');
  const control = join(root, 'desktop', 'tmp', 'control'), secret = join(root, 'desktop', 'user-data');
  for (const path of [workspace, other, control, secret]) await mkdir(path, { recursive: true });
  const denied = await privatePythonPaths([workspace, control], root);
  assert(denied.includes(other)); assert(denied.includes(secret));
  assert(!denied.some(path => contained(path, workspace) || contained(path, control)));
});

test('Windows execution lease queues concurrent hosts and supports cancellation', { skip: process.platform !== 'win32' }, async () => {
  const release = await acquirePythonLease();
  try {
    await assert.rejects(acquirePythonLease(AbortSignal.timeout(150)), /aborted|timeout/i);
  } finally { await release(); }
  const next = await acquirePythonLease(AbortSignal.timeout(1000)); await next();
});

test('closing the tool runtime cancels a Python call waiting for the Windows lease', { skip: process.platform !== 'win32' }, async t => {
  const { workspace } = await fixture(t);
  const release = await acquirePythonLease();
  const runtime = await createInternalTools({ sessionId: 'python-close', allowedTools: ['run_python'], python: { cwd: workspace } });
  try {
    const [tool] = await runtime.forWorker('worker');
    const pending = assert.rejects(tool.execute('waiting', input), /closed/);
    await new Promise(resolve => setTimeout(resolve, 150));
    await runtime.close(); await pending;
  } finally { await runtime.close(); await release(); }
});

test('JSON bootstrap runs real CPython with unicode, literal arguments, files, and sibling imports', async t => {
  let python; try { python = await resolvePython(); } catch { t.skip('CPython not installed'); return; }
  const { directory, workspace } = await fixture(t);
  const outputDirectory = join(directory, 'out'); await mkdir(outputDirectory);
  const args = ['spaces and 中文', "'; $() ` & %PATH% \"", 'line\nbreak'];
  const code = "import json,sys,os\nprint(json.dumps(sys.argv[1:],ensure_ascii=False))\nprint('中文')\nopen(os.path.join(os.environ['UBOVM_PYTHON_OUTPUT'],'ok.txt'),'w').write('ok')";
  const payload = join(directory, "request ' 中文.json");
  const codeFile = join(directory, 'ai-code.py'); await writeFile(codeFile, code);
  for (const scriptMode of [false, true]) {
    await writeFile(join(workspace, 'sibling.py'), 'VALUE = 73');
    const script = join(workspace, "script ' 中文.py");
    await writeFile(script, code + '\nfrom sibling import VALUE\nprint(VALUE)');
    await writeFile(payload, JSON.stringify({ codeFile, script: scriptMode ? script : undefined, arguments: args, cwd: workspace, outputDirectory }));
    const command = pythonCommand(python.executable, payload);
    const win = process.platform === 'win32';
    const result = await runLocalProcess({ executable: win ? 'powershell.exe' : '/bin/sh', args: win
      ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] : ['-c', command],
    cwd: workspace, env: pythonEnvironment(), timeout: 10, maxOutputBytes: 8192, label: 'Bootstrap fixture' });
    assert.deepEqual(JSON.parse(result.content[0].text.split(/\r?\n/)[0]), args);
    assert.match(result.content[0].text, /中文/);
    if (scriptMode) assert.match(result.content[0].text, /73/);
    assert.equal(await readFile(join(outputDirectory, 'ok.txt'), 'utf8'), 'ok');
  }
});

test('Python runner delivers output before completion and allows cancellation from progress', async t => {
  const { directory, workspace } = await fixture(t);
  const runner = join(directory, 'live-runner.mjs');
  await writeFile(runner, `let timer; process.on('message', message => {
    if (message.type === 'cancel') { clearInterval(timer); process.send({type:'result',exitCode:null,error:'cancelled',cleanupConfirmed:true},()=>process.disconnect()); return; }
    process.stdout.write('live-python'); timer = setInterval(()=>{},100);
  });`);
  const controller = new AbortController(), updates = [];
  await assert.rejects(runPythonSandbox({ cwd: workspace, outputDirectory: directory, timeout: 3, maxOutputBytes: 1024 }, controller.signal,
    update => { updates.push(update.content[0].text); controller.abort(new Error('cancel after Python output')); }, pathToFileURL(runner)), /cancel after Python output/);
  assert.equal(updates.join(''), 'live-python');
});

test('host runner streams output, bounds output, retains failures, cancels, and rejects missing completion', async t => {
  const { directory, workspace } = await fixture(t);
  const runner = join(directory, 'fixture.mjs');
  await writeFile(runner, `let timer;process.on('message',m=>{if(m.type==='cancel'){clearInterval(timer);process.send({type:'result',exitCode:null,error:'cancelled',cleanupConfirmed:true},()=>process.disconnect());return;}
    const mode=m.request.mode;
    if(mode==='wait'){timer=setInterval(()=>{},100);return;}
    if(mode==='missing'){process.disconnect();return;}
    process.stdout.write(mode==='large'?'x'.repeat(10000):'中文-output');
    if(mode==='large'){timer=setInterval(()=>{},100);return;}
    process.send({type:'result',exitCode:mode==='fail'?7:0,cleanupConfirmed:true,outputDirectory:m.request.outputDirectory,...(mode==='fail'?{error:'script failed'}:{})},()=>process.disconnect());});`);
  const request = { cwd: workspace, outputDirectory: directory, timeout: 3, maxOutputBytes: 1024 };
  const updates = [];
  const result = await runPythonSandbox(request, undefined, item => updates.push(item), pathToFileURL(runner));
  assert.match(result.content[0].text, /中文-output/); assert.match(result.content[0].text, /output_directory:/); assert(updates.length);
  await assert.rejects(runPythonSandbox({ ...request, mode: 'fail' }, undefined, undefined, pathToFileURL(runner)), error => error.details.exit_code === 7 && /script failed/.test(error.message));
  await assert.rejects(runPythonSandbox({ ...request, mode: 'large' }, undefined, undefined, pathToFileURL(runner)), /output exceeds/);
  await assert.rejects(runPythonSandbox({ ...request, mode: 'missing' }, undefined, undefined, pathToFileURL(runner)), /without a successful result|before reporting completion/);
  await assert.rejects(runPythonSandbox({ ...request, mode: 'wait', timeout: 0.1 }, undefined, undefined, pathToFileURL(runner)), /timed out/);
  const abort = new AbortController();
  const pending = runPythonSandbox({ ...request, mode: 'wait' }, abort.signal, undefined, pathToFileURL(runner));
  setTimeout(() => abort.abort(new Error('caller cancelled')), 100);
  await assert.rejects(pending, /caller cancelled/);
});

test('real sandbox executes Python, denies project writes and .env reads, and can cancel code', { skip: process.env.UBOVM_PYTHON_SANDBOX_TEST !== '1' }, async t => {
  const { workspace } = await fixture(t);
  await writeFile(join(workspace, '.env'), 'TEST_SECRET=fixture-only');
  await writeFile(join(workspace, 'script.py'), "import sys\nprint('existing-script',sys.argv[1])");
  const tool = createPythonTool({ cwd: workspace });
  const result = await tool.execute('real', { reason: 'Sandbox integration test', code:
    "import os,json,sys\nif sys.platform=='win32':\n assert not any(os.path.lexists(p) for p in ['.env','.codex','.agents','.git','.ubovm-python'])\nprint('sandbox-python-中文')\nfor p in ['.env']:\n try:\n  open(p).read()\n except (PermissionError,FileNotFoundError):\n  print('read-blocked')\n else:\n  raise AssertionError('secret readable')\ntry:\n open('forbidden.txt','w').write('bad')\nexcept PermissionError:\n print('write-blocked')\nelse:\n raise AssertionError('project writable')\nopen(os.path.join(os.environ['UBOVM_PYTHON_OUTPUT'],'result.txt'),'w').write('ok')" });
  assert.match(result.content[0].text, /read-blocked/); assert.match(result.content[0].text, /write-blocked/);
  assert.equal(await readFile(join(result.details.output_directory, 'result.txt'), 'utf8'), 'ok');
  const script = await tool.execute('script', { script: 'script.py', arguments: ['中文'], reason: 'Existing script test' });
  assert.match(script.content[0].text, /existing-script 中文/);
  const controller = new AbortController();
  const pending = tool.execute('cancel', { code: "print('ready',flush=True)\nwhile True: pass", reason: 'Cancellation test' }, controller.signal,
    update => { if (update.content[0].text.includes('ready')) controller.abort(new Error('cancel real Python')); });
  await assert.rejects(pending, /cancel real Python/);
  const recovered = await tool.execute('after-cancel', { code: "print('recovered')", reason: 'Verify execution after cancellation' });
  assert.match(recovered.content[0].text, /recovered/); assert.equal(recovered.details.cleanup_confirmed, true);
});

test('sandbox code supports real main-module identity, function pickling, and spawn workers', {
  skip: process.env.UBOVM_PYTHON_SANDBOX_TEST !== '1', timeout: 60000
}, async t => {
  const { workspace } = await fixture(t);
  const tool = createPythonTool({ cwd: workspace, defaultTimeoutSeconds: 30 });
  const result = await tool.execute('spawn-code', { reason: 'Verify generated code multiprocessing compatibility', code: `
import sys, os, pickle, multiprocessing
from concurrent.futures import ProcessPoolExecutor
def square(value):
    return value * value
if __name__ == '__main__':
    assert sys.modules['__main__'].square is square
    assert pickle.loads(pickle.dumps(square))(7) == 49
    assert os.path.isfile(__file__)
    with ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context('spawn')) as pool:
        assert list(pool.map(square, [2, 3, 4])) == [4, 9, 16]
    print('spawn-workers-ok', flush=True)
` });
  assert.match(result.content[0].text, /spawn-workers-ok/);
  assert.equal(result.details.cleanup_confirmed, true);
  const controller = new AbortController();
  const cancelled = tool.execute('cancel-spawn', { reason: 'Verify cancellation with a running Python child', code: `
import multiprocessing, time
def wait_forever():
    print('spawn-child-ready', flush=True)
    while True:
        time.sleep(1)
if __name__ == '__main__':
    child = multiprocessing.get_context('spawn').Process(target=wait_forever)
    child.start()
    child.join()
` }, controller.signal, update => {
    if (update.content[0].text.includes('spawn-child-ready')) controller.abort(new Error('cancel spawned worker'));
  });
  await assert.rejects(cancelled, error => {
    assert.match(error.message, /cancel spawned worker/);
    assert.equal(error.details.cleanup_confirmed, true);
    assert.equal(error.details.forced_termination, false);
    return true;
  });
  const next = await tool.execute('after-spawn', { reason: 'Verify execution after multiprocessing cancellation', code: "print('after-spawn-ok')" });
  assert.match(next.content[0].text, /after-spawn-ok/);
  assert.equal(next.details.cleanup_confirmed, true);
});

test('writable sandbox protects existing env variants without creating absent sensitive paths', {
  skip: process.env.UBOVM_PYTHON_SANDBOX_TEST !== '1' || process.platform !== 'win32', timeout: 60000
}, async t => {
  const { workspace } = await fixture(t);
  await writeFile(join(workspace, '.env.production'), 'FIXTURE_SECRET=keep');
  await mkdir(join(workspace, '.ssh'));
  await writeFile(join(workspace, '.ssh/config'), 'fixture private configuration');
  const tool = createPythonTool({ cwd: workspace, allowWorkspaceWrite: true });
  const result = await tool.execute('permission-test', { reason: 'Verify writable sandbox sensitive paths', code: `
import os
for path in ['.env.production','.ssh/config']:
    for mode in ['r','w']:
        try:
            with open(path,mode) as f:
                if mode=='r': f.read()
        except PermissionError:
            pass
        else:
            raise AssertionError('sensitive path accessible: '+path+' '+mode)
    for operation in [lambda: os.remove(path), lambda: os.rename(path,path+'.moved')]:
        try:
            operation()
        except PermissionError:
            pass
        else:
            raise AssertionError('sensitive path removable: '+path)
assert not any(os.path.lexists(path) for path in ['.env','.codex','.agents','.git'])
with open('ordinary.txt','w') as f: f.write('allowed')
print('permissions-ok')
` });
  assert.match(result.content[0].text, /permissions-ok/);
  assert.equal(result.details.cleanup_confirmed, true);
  assert.equal(await readFile(join(workspace, '.env.production'), 'utf8'), 'FIXTURE_SECRET=keep');
  assert.equal(await readFile(join(workspace, '.ssh/config'), 'utf8'), 'fixture private configuration');
  assert.equal(await readFile(join(workspace, 'ordinary.txt'), 'utf8'), 'allowed');
});
