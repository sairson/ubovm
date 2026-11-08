'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPluginRegistry, PLUGIN_SLOTS } = require('../../../host/plugins/plugin-registry.cjs');

function fakeVscode() {
  const installed = new Set(['acme.scan', 'ubovm.ubovm-core']);
  return {
    extensions: {
      getExtension: id => installed.has(id) ? { id, packageJSON: { name: id } } : undefined
    },
    env: { openExternal: async () => true },
    Uri: { parse: value => value }
  };
}

test('registers namespaced agent tools and serializes their results', async () => {
  const changes = [];
  const registry = createPluginRegistry({ vscode: fakeVscode(), onChange: () => changes.push('change') });
  const disposable = registry.api.registerAgentTool('acme.scan', {
    name: 'scan',
    label: 'Scan URL',
    description: 'Run a scan',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: input => ({ url: input.url, ok: true })
  });
  const tools = registry.agentTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'plugin_acme_scan_scan');
  assert.deepEqual(await tools[0].execute('call-1', { url: 'https://example.com' }, undefined), { url: 'https://example.com', ok: true });
  assert.equal(registry.uiState().tools[0].pluginId, 'acme.scan');
  assert.ok(changes.length >= 1);
  disposable.dispose();
  assert.equal(registry.agentTools().length, 0);
});

test('registers slots, publishes descriptors and invokes only registered actions', async () => {
  const registry = createPluginRegistry({ vscode: fakeVscode() });
  const calls = [];
  registry.api.registerSlot('acme.scan', 'composer.toolbar', {
    id: 'run', label: '扫描当前页', title: 'ACME scan', onSelect: () => calls.push('run')
  });
  const state = registry.uiState();
  assert.deepEqual(Object.keys(state.slots), Object.keys(PLUGIN_SLOTS));
  assert.equal(state.slots['composer.toolbar'][0].label, '扫描当前页');
  assert.equal(state.slots['composer.toolbar'][0].pluginId, 'acme.scan');
  await registry.invokeSlot('acme.scan', 'composer.toolbar', 'run');
  assert.deepEqual(calls, ['run']);
  await assert.rejects(() => registry.invokeSlot('acme.scan', 'composer.toolbar', 'missing'), /失效/);
});

test('registers plugin skill directories and agent event listeners', () => {
  const registry = createPluginRegistry({ vscode: fakeVscode() });
  const directory = path.resolve(__dirname, 'fixture-skills');
  const skill = registry.api.registerSkillDirectory('acme.scan', directory);
  assert.deepEqual(registry.skillDirectories(), [directory]);
  assert.deepEqual(registry.uiState().skills, [directory]);
  assert.throws(() => registry.api.registerSkillDirectory('acme.scan', 'relative/path'), /绝对路径/);

  const seen = [];
  const events = registry.api.onAgentEvent('acme.scan', event => seen.push(event.type));
  registry.emitAgentEvent({ type: 'agent.run.started', conversationId: 'c1' });
  assert.deepEqual(seen, ['agent.run.started']);

  skill.dispose();
  assert.equal(registry.skillDirectories().length, 0);
  events.dispose();
  registry.emitAgentEvent({ type: 'agent.run.completed', conversationId: 'c1' });
  assert.deepEqual(seen, ['agent.run.started']);
});

test('registers declarative settings and persists updates', async () => {
  const store = {};
  const registry = createPluginRegistry({
    vscode: fakeVscode(),
    settings: {
      read: pluginId => store[pluginId] || {},
      write: async (pluginId, value) => { store[pluginId] = value; }
    }
  });
  const changes = [];
  registry.api.registerSettingsSection('acme.scan', {
    id: 'general',
    title: 'General',
    description: 'ACME settings',
    fields: [
      { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
      { key: 'mode', type: 'select', label: 'Mode', options: ['fast', 'deep'] }
    ]
  });
  assert.deepEqual(registry.api.getSettings('acme.scan', 'general'), { enabled: true, mode: 'fast' });
  registry.api.onSettingsChanged('acme.scan', event => changes.push([event.key, event.value]));
  await registry.updateSetting('acme.scan', 'general', 'enabled', false);
  assert.equal(registry.api.getSettings('acme.scan', 'general').enabled, false);
  assert.deepEqual(changes, [['enabled', false]]);
  await assert.rejects(() => registry.updateSetting('acme.scan', 'general', 'mode', 'other'), /不在 options/);
  assert.equal(registry.settingsState().length, 1);
  assert.throws(() => registry.api.registerSettingsSection('acme.scan', {
    id: 'bad', fields: [{ key: 'value', type: 'color' }]
  }), /不支持的插件设置类型/);
});

test('registers plugin MCP servers with validation', () => {
  const registry = createPluginRegistry({ vscode: fakeVscode() });
  const disposable = registry.api.registerMcpServer('acme.scan', {
    name: 'acme', transport: 'stdio', command: 'node', args: ['server.js']
  });
  assert.equal(registry.mcpServers().length, 1);
  assert.equal(registry.mcpServers()[0].command, 'node');
  assert.throws(() => registry.api.registerMcpServer('acme.scan', { name: 'stdio-no-command' }), /command/);
  assert.throws(() => registry.api.registerMcpServer('acme.scan', {
    name: 'http', transport: 'streamable_http', url: 'ftp://example.com/mcp'
  }), /url/);
  assert.throws(() => registry.api.registerMcpServer('acme.scan', {
    name: 'bad-env', transport: 'stdio', command: 'node', env: { 'BAD KEY': 'x' }
  }), /环境变量名/);
  assert.throws(() => registry.api.registerMcpServer('acme.scan', {
    name: 'bad-header', transport: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer\nInjected' }
  }), /非法字符/);
  disposable.dispose();
  assert.equal(registry.mcpServers().length, 0);
});

test('exposes v2 storage, logger, workspace and setting helpers', async () => {
  const state = {};
  const logs = [];
  const registry = createPluginRegistry({
    vscode: { ...fakeVscode(), workspace: { workspaceFolders: [{ uri: { fsPath: 'C:/work' } }] } },
    state: {
      read: pluginId => state[pluginId] || {},
      write: (pluginId, value) => { state[pluginId] = value; }
    },
    log: text => logs.push(text)
  });
  assert.equal(registry.api.apiVersion, 2);
  assert.equal(registry.api.version, 2);
  const storage = registry.api.storage('acme.scan');
  storage.set('last', { at: 1 });
  assert.deepEqual(storage.get('last'), { at: 1 });
  assert.deepEqual(storage.keys(), ['last']);
  storage.delete('last');
  assert.equal(storage.get('last', 'fallback'), 'fallback');
  assert.deepEqual(registry.api.workspaceFolders(), ['C:/work']);
  assert.equal(registry.api.getInfo().apiVersion, 2);
  assert.deepEqual(registry.api.getInfo().workspaceFolders, ['C:/work']);
  registry.api.logger('acme.scan').warn('hello');
  assert.match(logs.at(-1), /acme\.scan.*WARN.*hello/);
});

test('rejects uninstalled plugins, invalid slots and unsupported components', () => {
  const registry = createPluginRegistry({ vscode: fakeVscode() });
  assert.throws(() => registry.api.registerAgentTool('missing.plugin', { name: 'x', execute() {} }), /未安装/);
  assert.throws(() => registry.api.registerSlot('acme.scan', 'nope.slot', { id: 'x', label: 'X' }), /不支持的插件插槽/);
  assert.throws(() => registry.api.registerSlot('acme.scan', 'topbar.actions', { id: 'x', label: 'X', type: 'iframe' }), /不支持的组件类型/);
  registry.api.registerSlot('acme.scan', 'topbar.actions', { id: 'ok', label: 'OK' });
  assert.equal(registry.uiState().slots['topbar.actions'].length, 1);
  registry.dispose();
  assert.throws(() => registry.api.registerSlot('acme.scan', 'topbar.actions', { id: 'late', label: 'Late' }), /已关闭/);
});
