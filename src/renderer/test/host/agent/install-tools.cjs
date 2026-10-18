'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSettingsConfiguration } = require('../../../harness/config/settings-config.cjs');
const { createModelConfiguration } = require('../../../harness/config/model-config.cjs');
const { createInstallTools } = require('../../../host/agent/install-tools.cjs');

const base = { model: { provider: 'custom', modelId: 'demo', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1' },
  reason: {}, worker: {}, contextSummary: true, intools: { allowedTools: ['note', 'todo'] }, mcp: { servers: [] }, skills: { directories: [] } };

function fixture(seed = {}) {
  const values = structuredClone({ ...base, ...seed }), vault = new Map();
  const configuration = { inspect: name => ({ globalValue: structuredClone(values[name]) }),
    update: async (name, value) => { if (value === undefined) delete values[name]; else values[name] = structuredClone(value); } };
  const vscode = { workspace: { getConfiguration: () => configuration }, ConfigurationTarget: { Global: 1 } };
  const context = { subscriptions: [], secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } };
  return { values, vault, vscode, context, settings: createSettingsConfiguration(vscode, context), model: createModelConfiguration(vscode, context) };
}

test('addMcpServer writes a stdio server and keeps credentials in the vault', async () => {
  const f = fixture();
  const result = await f.settings.addMcpServer({ server: { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'server'] }, credentials: { env: { TOKEN: 'secret-value' } } });
  assert.deepEqual(result, { name: 'local', transport: 'stdio', enabled: true, replaced: false, credentials: true });
  assert.deepEqual(f.values.mcp.servers, [{ name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'server'] }]);
  assert(!JSON.stringify(f.values).includes('secret-value'));
  const runtime = await f.model.read();
  assert.deepEqual(runtime.mcp.servers[0].env, { TOKEN: 'secret-value' });
});

test('addMcpServer guards overwrite, validates endpoints and drops stale credentials', async () => {
  const f = fixture();
  await f.settings.addMcpServer({ server: { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' }, credentials: { headers: { Authorization: 'Bearer one' } } });
  await assert.rejects(f.settings.addMcpServer({ server: { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' } }), /已存在/);
  await assert.rejects(f.settings.addMcpServer({ server: { name: 'bad', transport: 'streamable_http', url: 'ftp://x' } }), /MCP 地址/);
  await assert.rejects(f.settings.addMcpServer({ server: { name: 'no', transport: 'stdio' } }), /启动命令/);
  await assert.rejects(f.settings.addMcpServer({ server: { name: 'leak', command: 'node', env: { A: 'x' } } }), /专用加密字段/);
  await f.settings.addMcpServer({ server: { name: 'remote', transport: 'sse', url: 'https://other.example/sse' }, overwrite: true });
  const runtime = await f.model.read();
  assert.equal(runtime.mcp.servers.find(server => server.name === 'remote').headers, undefined);
});

test('addMcpServer rejects a concurrent external settings edit before writing', async () => {
  const f = fixture({ mcp: { servers: [{ name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' }] } });
  await f.settings.addMcpServer({ server: { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' }, credentials: { headers: { Authorization: 'Bearer one' } }, overwrite: true });
  const get = f.context.secrets.get; let changed = false;
  f.context.secrets.get = async key => { if (!changed) { changed = true; f.values.mcp = { servers: [] }; } return get(key); };
  await assert.rejects(f.settings.addMcpServer({ server: { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' }, credentials: { headers: { Authorization: 'Bearer two' } }, overwrite: true }), /发生变化/);
});

test('install tools require a settings host and route skill installs to the destination', async t => {
  assert.throws(() => createInstallTools({}), /settings host is required/);
  assert.deepEqual(createInstallTools({ settings: {} }).tools().map(tool => tool.name), ['install_skill']);
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-tools-'));
  t.after(() => fs.rm(files, { recursive: true, force: true }));
  const f = fixture(), events = [];
  const install = createInstallTools({ settings: f.settings, destination: path.join(files, 'skills'), onInstalled: event => events.push(event) });
  const [skill, mcp] = install.tools('session');
  assert.equal(skill.name, 'install_skill');
  assert.equal(mcp.name, 'install_mcp_server');
  const content = '---\nname: demo\ndescription: demo skill\n---\nbody\n';
  const result = await skill.execute('call', { name: 'demo', content }, undefined);
  assert.equal(result.details.name, 'demo');
  assert.equal(result.details.effective, 'next_turn');
  assert.equal(events[0].type, 'skill');
  assert.equal(await fs.readFile(path.join(result.details.directory, 'SKILL.md'), 'utf8'), content);

  const added = await mcp.execute('call', { name: 'local', command: 'node', env: { A: '1' }, overwrite: true }, undefined);
  assert.equal(added.details.name, 'local');
  assert.equal(events[1].type, 'mcp');
  assert.deepEqual(f.values.mcp.servers, [{ name: 'local', command: 'node', required: false }]);
  assert.deepEqual(JSON.parse(f.vault.get([...f.vault.keys()][0])).env, { A: '1' });
});
