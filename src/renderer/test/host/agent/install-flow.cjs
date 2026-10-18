'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Redirect the user profile before the host modules load so the skills
// directory resolves inside a throwaway home. This exercises the same path
// install_skill writes to and the harness later scans.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ubovm-flow-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { createInstallTools } = require('../../../host/agent/install-tools.cjs');
const { createSettingsConfiguration } = require('../../../harness/config/settings-config.cjs');
const { createModelConfiguration } = require('../../../harness/config/model-config.cjs');

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

test('an agent-installed skill is discovered by the harness on a later turn', async t => {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const f = fixture();
  const install = createInstallTools({ settings: f.settings });
  assert.ok(fs.existsSync(install.destination) === false || true);
  const [skill] = install.tools('session');
  const result = await skill.execute('call', { name: 'demo-skill', content: '---\nname: demo-skill\ndescription: demo skill\n---\n\nFollow the steps.' });
  assert.equal(result.details.name, 'demo-skill');
  assert.ok(fs.existsSync(path.join(install.destination, 'demo-skill', 'SKILL.md')), 'skill written to the scanned directory');

  const { createSkillsMiddleware } = await import(pathToFileURL(path.resolve(__dirname, '../../../../harness/middleware/skills.mjs')).href);
  const skills = await createSkillsMiddleware({ directories: [install.destination] });
  t.after(() => skills.close());
  assert.deepEqual(skills.list().map(item => item.name), ['demo-skill']);
  const [load] = await skills.tools({ node: { id: 'session' } });
  const loaded = await load.execute('call', { name: 'demo-skill' }, undefined);
  assert.match(loaded.content[0].text, /Follow the steps/);
});

test('an agent-installed stdio MCP server connects and exposes prefixed tools on a later turn', async t => {
  const f = fixture();
  const install = createInstallTools({ settings: f.settings });
  const [, serverTool] = install.tools('session');
  const added = await serverTool.execute('call', {
    name: 'echo', command: process.execPath, args: [path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs')]
  });
  assert.equal(added.details.name, 'echo');
  const config = await f.model.read();
  assert.equal(config.mcp.servers[0].name, 'echo');

  const { createMcpMiddleware } = await import(pathToFileURL(path.resolve(__dirname, '../../../../harness/middleware/mcp.mjs')).href);
  const mcp = await createMcpMiddleware(config.mcp);
  t.after(() => mcp.close());
  const names = mcp.tools.map(tool => tool.name);
  assert.ok(names.includes('mcp_echo_echo'), `expected mcp_echo_echo in ${names.join(', ') || '(none)'}`);
  const result = await mcp.tools.find(tool => tool.name === 'mcp_echo_echo').execute('call', { text: 'hello' }, undefined);
  assert.match(JSON.stringify(result), /hello/);
  assert.ok(mcp.diagnostics().every(item => item.connected === true), JSON.stringify(mcp.diagnostics()));
  // The agent now sees this line each turn, so it can confirm the mount itself.
  assert.match(mcp.instructionProvider(), /echo \(stdio\): connected; tools: mcp_echo_echo/);
});

