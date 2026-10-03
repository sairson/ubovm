'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createWorkspaceAudit, parseManifest } = require('../../../harness/workspace/workspace-audit.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vscode = { env: { appRoot: root }, workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] } };
  const service = createWorkspaceAudit(vscode, { executable: process.env.UBOVM_TEST_RG || 'rg', ...options });
  const tools = Object.fromEntries(service.tools('session').map(tool => [tool.name, tool]));
  return {
    root, tools, service,
    write: async (name, text) => {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    },
    call: async (name, input = {}, signal) => (await tools[name].execute('test', input, signal)).details
  };
}

function fakeProcesses() {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter(); child.pid = 1;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); return false; };
    children.push(child); return child;
  };
  return { children, spawnProcess };
}

test('parseManifest extracts npm, cargo, go and pip dependencies', () => {
  assert.equal(parseManifest('package.json', JSON.stringify({
    name: 'demo', dependencies: { left: '1.0.0' }, devDependencies: { right: '2.0.0' }
  }), 'package.json').dependencies.length, 2);
  assert.equal(parseManifest('Cargo.toml', '[dependencies]\nserde = "1"\n', 'Cargo.toml').dependencies[0].name, 'serde');
  assert.equal(parseManifest('go.mod', 'module x\nrequire github.com/a/b v1.2.3\n', 'go.mod').dependencies[0].name, 'github.com/a/b');
  assert.equal(parseManifest('requirements.txt', 'requests==2.0\n# comment\n', 'requirements.txt').dependencies[0].name, 'requests');
});

test('inventory_workspace_dependencies lists manifests, paginates and skips node_modules', async t => {
  const f = await fixture(t);
  await f.write('package.json', JSON.stringify({ name: 'app', dependencies: { a: '1', b: '2', c: '3' } }));
  await f.write('node_modules/hidden/package.json', JSON.stringify({ name: 'hidden', dependencies: { secret: '9' } }));
  await f.write('service/requirements.txt', 'flask==3\n');
  const first = await f.call('inventory_workspace_dependencies', { limit: 2 });
  assert.equal(first.packages.length, 2);
  assert.equal(first.totalDependencies, 4);
  assert.equal(first.dependencies.length, 2);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.truncated, true);
  assert(!first.packages.some(item => item.manifest.includes('node_modules')));
  const second = await f.call('inventory_workspace_dependencies', { offset: 2, limit: 10 });
  assert.equal(second.dependencies.length, 2);
  assert.equal(second.nextOffset, null);
});

test('inventory respects abort signals', async t => {
  const f = await fixture(t);
  await f.write('package.json', JSON.stringify({ dependencies: { a: '1' } }));
  const controller = new AbortController();
  controller.abort(new Error('stop inventory'));
  await assert.rejects(f.call('inventory_workspace_dependencies', {}, controller.signal), /stop inventory/);
});

test('scan_workspace_secrets returns heuristic matches and ignores dependency trees', async t => {
  const process = fakeProcesses();
  const f = await fixture(t, process);
  await f.write('config.env', 'AWS_KEY=AKIAIOSFODNN7EXAMPLE');
  const pending = f.call('scan_workspace_secrets', { limit: 10 });
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  process.children[0].stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'match',
    data: { path: { text: 'config.env' }, line_number: 1, lines: { text: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n' } }
  }) + '\n'));
  process.children[0].stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'match',
    data: { path: { text: '../outside.env' }, line_number: 1, lines: { text: 'AKIAIOSFODNN7EXAMPLE\n' } }
  }) + '\n'));
  process.children[0].emit('close', 0);
  const details = await pending;
  assert.equal(details.matches.length, 1);
  assert.equal(details.matches[0].path, 'config.env');
  assert.equal(details.matches[0].patternId, 'aws_access_key');
  assert.match(details.note, /Heuristic/);
});

test('scan_workspace_secrets cancels and stops the process', async t => {
  const process = fakeProcesses();
  const f = await fixture(t, { ...process, stopTimeoutMs: 10 });
  const controller = new AbortController();
  const pending = f.call('scan_workspace_secrets', {}, controller.signal);
  const rejected = assert.rejects(pending, /cancel secrets/);
  while (!process.children.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel secrets'));
  await rejected;
  assert.deepEqual(process.children[0].kills, [undefined, 'SIGKILL']);
});
