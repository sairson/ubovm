'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsConfiguration, readSSHConfiguration } = require('../../../harness/config/settings-config.cjs');
const { createModelConfiguration, keyFor } = require('../../../harness/config/model-config.cjs');
const base = { model: { provider: 'custom', modelId: 'demo', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1' }, reason: {}, worker: {}, contextSummary: true, intools: { allowedTools: ['note', 'todo', 'web_search'] }, mcp: { servers: [] }, skills: { directories: [] }, toolsEnabled: true, summaryEnabled: true };
function fixture(seed = {}) {
  const values = structuredClone({ ...base, ...seed }), vault = new Map(), listeners = new Set(); let failure;
  const configuration = { inspect(name) { return { globalValue: structuredClone(values[name]) }; }, async update(name, value) { if (failure === name) { failure = undefined; throw new Error('write error'); } if (value === undefined) delete values[name]; else values[name] = structuredClone(value); } };
  const vscode = { workspace: { getConfiguration: () => configuration }, ConfigurationTarget: { Global: 1 } };
  const context = { subscriptions: [], secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key),
    onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } } };
  const service = createSettingsConfiguration(vscode, context), model = createModelConfiguration(vscode, context);
  const save = async (section, value) => service.save(section, value, (await service.snapshot()).revision);
  return { values, vault, service, model, save, vscode, context, configuration, notifySecret: key => { for (const listener of listeners) listener({ key }); }, fail: name => { failure = name; } };
}
const ssh = { id: 'dev', host: '192.0.2.10', username: 'developer', port: 22, known_hosts_file: '~/.ssh/known_hosts' };

test('initialization readiness follows persisted valid model and default SSH, not form defaults', async () => {
  const f = fixture({ model: {}, intools: {} });
  assert.deepEqual((await f.service.snapshot()).initialization, { model: false, ssh: false, complete: false });
  await f.save('model', base.model);
  assert.deepEqual((await f.service.snapshot()).initialization, { model: true, ssh: false, complete: false });
  await f.save('ssh', { profiles: [ssh], defaultId: ssh.id });
  assert.deepEqual((await f.service.snapshot()).initialization, { model: true, ssh: true, complete: true });
  const restored = createSettingsConfiguration(f.vscode, f.context);
  assert.equal((await restored.snapshot()).initialization.complete, true);
  f.values.intools.ssh.defaultId = 'missing';
  assert.equal((await restored.snapshot()).initialization.complete, false);
  f.values.model = {};
  assert.equal((await restored.snapshot()).initialization.model, false);
});

test('legacy SDK profiles normalize to Pi while retaining endpoint credentials', async () => {
  const f = fixture();
  for (const backend of ['claude', 'codex']) {
    await f.save('model', { backend, provider: 'deepseek', modelId: 'deepseek-test', apiKey: 'private-key' });
    const runtime = await f.model.read();
    assert.equal(runtime.model.backend, 'pi');
    assert.equal(runtime.model.apiKey, 'private-key');
    assert.equal(runtime.model.api, backend === 'claude' ? 'anthropic-messages' : 'openai-responses');
    assert(!JSON.stringify(await f.service.snapshot()).includes('private-key'));
  }
});

test('stored legacy roles and library open as Pi without changing endpoints or losing saved keys', async () => {
  const legacy = { backend: 'claude', provider: 'deepseek', modelId: 'deepseek-flash[1m]', api: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' };
  const f = fixture({ model: legacy, worker: { swarmBackendSelection: 'autonomous', model: legacy }, modelProfiles: [{ id: 'old', name: '旧配置', model: legacy }] });
  f.vault.set(keyFor(legacy), 'stored-secret');
  const snapshot = await f.service.snapshot();
  for (const model of [snapshot.values.model, snapshot.values.workerModel, snapshot.modelProfiles[0].model]) {
    assert.equal(model.backend, 'pi'); assert.equal(model.modelId, 'deepseek-flash'); assert.equal(model.baseUrl, legacy.baseUrl);
  }
  assert.equal(snapshot.modelProfiles[0].secretState.apiKey, true);
  const runtime = await f.model.read();
  assert.equal(runtime.collaboration.models['saved.old'].apiKey, 'stored-secret');
  assert.equal(runtime.worker.model.backend, 'pi');
  assert.equal(f.values.model.backend, 'claude', 'reading compatibility does not rewrite user settings');
});

test('settings vault reads are deduplicated and bounded concurrently per snapshot', async () => {
  const f = fixture({ modelProfiles: Array.from({ length: 24 }, (_, index) => ({ id: `saved-${index}`, name: `Model ${index}`,
    model: { ...base.model, baseUrl: `https://model-${index}.example/v1` } })) });
  const counts = new Map(); let active = 0, peak = 0;
  f.context.secrets.get = async key => {
    counts.set(key, (counts.get(key) ?? 0) + 1); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return undefined;
  };
  const snapshot = await f.service.snapshot({ includeSkills: false });
  assert.equal(snapshot.modelProfiles.length, 24);
  assert(peak > 1 && peak <= 8, String(peak));
  assert([...counts.values()].every(count => count === 1));
  assert.equal(active, 0);
});

test('Pi profiles hydrate across roles and autonomous collaboration without leaking keys', async () => {
  const f = fixture();
  assert.equal((await f.service.snapshot()).sections.model.fields.some(field => field.key === 'backend'), false);
  await f.save('reasonModel', { backend: 'claude', provider: 'anthropic', modelId: 'claude-test', apiKey: 'claude-secret', profile: { id: 'review', name: 'Claude reviewer' } });
  await f.save('workerModel', { backend: 'codex', provider: 'openai', modelId: 'codex-test', apiKey: 'codex-secret', profile: { id: 'default', name: 'Codex coder' } });
  assert.equal((await f.model.read()).collaboration.backendSelection, 'fixed');
  assert.deepEqual((await f.model.read()).collaboration.models, {});
  await f.save('worker', { swarmBackendSelection: 'autonomous' });
  const runtime = await f.model.read();
  assert.equal(runtime.reason.model.backend, 'pi');
  assert.equal(runtime.worker.model.backend, 'pi');
  assert.equal(runtime.collaboration.backendSelection, 'autonomous');
  assert.equal(runtime.worker.swarmBackendSelection, undefined);
  assert.equal(runtime.collaboration.models['saved.review'].apiKey, 'claude-secret');
  assert.equal(runtime.collaboration.models['saved.default'].apiKey, 'codex-secret');
  assert(!JSON.stringify(await f.service.snapshot()).includes('claude-secret'));
  assert(!JSON.stringify(f.values).includes('codex-secret'));
  await f.save('worker', { swarmBackendSelection: 'fixed' });
  assert.deepEqual((await f.model.read()).collaboration.models, {});
  await assert.rejects(f.save('worker', { swarmBackendSelection: 'invalid' }));
  await assert.rejects(f.save('model', { backend: 'invalid', modelId: 'x' }));
});

test('Python settings enable the AI tool, persist host permissions and validate before saving', async () => {
  const f = fixture();
  assert.equal((await f.service.snapshot()).values.python.allowWorkspaceWrite, false);
  assert.deepEqual((await f.service.snapshot()).values.python.allowedDomains, ['*']);
  assert((await f.model.read()).intools.allowedTools.includes('run_python'));
  assert((await f.model.read()).intools.allowedTools.includes('manage_python_environment'));
  const config = { executable: process.execPath, allowedDomains: ['pypi.org', '*.example.com:443'],
    allowWorkspaceWrite: true, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, maxOutputBytes: 4096 };
  await f.save('python', config);
  assert.deepEqual((await f.model.read()).intools.python, config);
  assert.deepEqual((await f.service.snapshot()).values.python, config);
  for (const invalid of [{ executable: 'python' }, { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 30 },
    ...['https://example.com/path', 'a..b', '-example.com', 'example.com:0', 'example.com:65536'].map(domain => ({ allowedDomains: [domain] })),
    { maxOutputBytes: 1 }, { cwd: '/outside' }, { sandbox: false }]) {
    await assert.rejects(f.save('python', invalid));
    assert.deepEqual(f.values.intools.python, config);
  }
  await f.save('python', { ...config, allowedDomains: [' EXAMPLE.com ', 'example.com'] });
  assert.deepEqual((await f.model.read()).intools.python.allowedDomains, ['example.com']);
  await f.save('python', { ...config, allowedDomains: [' * ', 'pypi.org'] });
  assert.deepEqual((await f.model.read()).intools.python.allowedDomains, ['*']);
});

test('named model configurations round trip, apply to roles, retain keys and delete independently', async () => {
  const f = fixture();
  const first = { ...base.model, profile: { id: 'daily', name: '日常' }, apiKey: 'daily-secret' };
  const second = { ...base.model, modelId: 'coder', baseUrl: 'https://coder.example/v1', profile: { id: 'code', name: '代码' }, apiKey: 'code-secret' };
  await f.save('model', first);
  await f.save('model', second);
  let snapshot = await f.service.snapshot();
  assert.equal(snapshot.modelProfiles.length, 2);
  assert(!JSON.stringify(snapshot).includes('daily-secret'));
  assert(!JSON.stringify(f.values).includes('code-secret'));
  assert(snapshot.modelProfiles.every(p => p.secretState.apiKey));
  await f.save('workerModel', { ...snapshot.modelProfiles[0].model, profile: { id: 'daily', name: '日常重命名' } });
  const runtime = await f.model.read();
  assert.equal(runtime.model.modelId, 'coder');
  assert.equal(runtime.model.apiKey, 'code-secret');
  assert.equal(runtime.worker.model.apiKey, 'daily-secret');
  assert.equal(f.values.modelProfiles.length, 2);
  await f.save('model', { deleteProfileId: 'daily' });
  assert.equal((await f.service.snapshot()).modelProfiles.length, 1);
  assert.equal((await f.model.read()).worker.model.apiKey, 'daily-secret');
  await assert.rejects(f.save('model', { ...first, profile: { id: '../bad', name: 'bad' } }), /有效标识/);
  f.fail('modelProfiles');
  await assert.rejects(f.save('model', { ...first, apiKey: 'changed' }), /已恢复/);
  assert.equal(f.values.model.modelId, 'coder');
  assert.equal((await f.model.read()).worker.model.apiKey, 'daily-secret');
});

test('multiple SSH hosts retain separate credentials when default changes and one is removed', async () => {
  const f = fixture();
  const other = { ...ssh, id: 'production', host: '192.0.2.20' };
  await f.save('ssh', { profiles: [{ ...ssh, password: 'dev-secret' }, { ...other, password: 'prod-secret' }], defaultId: ssh.id });
  await f.save('ssh', { profiles: [ssh, other], defaultId: other.id });
  let runtime = await readSSHConfiguration(f.vscode, f.context);
  assert.equal(runtime.defaultId, other.id);
  assert.deepEqual(runtime.profiles.map(p => p.password), ['dev-secret', 'prod-secret']);
  await f.save('ssh', { profiles: [other], defaultId: other.id });
  runtime = await readSSHConfiguration(f.vscode, f.context);
  assert.equal(runtime.profiles[0].password, 'prod-secret');
  assert(![...f.vault.values()].some(v => v.includes('dev-secret')));
});

test('browser window mode round trips into launch options without losing browser configuration', async () => {
  const fresh = fixture();
  assert.equal((await fresh.service.snapshot()).values.web.headless, true);
  assert.equal((await fresh.service.snapshot()).values.web.ideBrowser, true);
  await fresh.save('web', { headless: false });
  assert.equal((await fresh.model.read()).intools.browser.launchOptions.headless, false);
  const browser = { channel: 'msedge', launchOptions: { headless: false, slowMo: 50, args: ['--lang=zh-CN'] } };
  const f = fixture({ intools: { browser } });
  assert.equal((await f.service.snapshot()).values.web.headless, false);
  await f.save('web', { headless: true });
  assert.deepEqual(f.values.intools.browser, { ...browser, launchOptions: { ...browser.launchOptions, headless: true } });
  assert.equal((await f.model.read()).intools.browser.launchOptions.headless, true);
  assert.equal(f.values.intools.webSearch.headless, undefined);
  await f.save('web', { searchDepth: 'advanced' });
  assert.equal(f.values.intools.browser.launchOptions.headless, true);
  await assert.rejects(f.save('web', { headless: 'false' }), /开关值/);
  const disabled = fixture({ intools: { browser: false } });
  await disabled.save('web', { headless: false });
  assert.equal(disabled.values.intools.browser, false);
});

test('ide browser setting round trips and defaults to enabled', async () => {
  const fresh = fixture();
  assert.equal((await fresh.service.snapshot()).values.web.ideBrowser, true);
  await fresh.save('web', { ideBrowser: false });
  assert.equal((await fresh.model.read()).intools.browser.ideBrowser, false);
  assert.equal((await fresh.service.snapshot()).values.web.ideBrowser, false);
  await fresh.save('web', { ideBrowser: true, headless: false });
  const browser = (await fresh.model.read()).intools.browser;
  assert.equal(browser.ideBrowser, true);
  assert.equal(browser.launchOptions.headless, false);
});

test('optional known_hosts supports draft tests and saved connections, and restores verification when supplied', async () => {
  const { resolveSSHTestProfile } = require('../../../harness/config/settings-config.cjs');
  const { SSHCommands } = await import('../../../../harness/intools/terminals/ssh-terminal/commands.mjs');
  const f = fixture(), profile = { ...ssh, known_hosts_file: '' };
  const draft = await resolveSSHTestProfile(f.vscode, f.context, profile);
  assert.equal(draft.insecure_ignore_host_key, true);
  await new SSHCommands(draft).close();
  await f.save('ssh', { profiles: [profile] });
  const saved = (await readSSHConfiguration(f.vscode, f.context)).profiles[0];
  assert.equal(saved.insecure_ignore_host_key, true);
  await new SSHCommands(saved).close();
  await f.save('ssh', { profiles: [ssh] });
  const verified = (await readSSHConfiguration(f.vscode, f.context)).profiles[0];
  assert.equal(verified.insecure_ignore_host_key, undefined);
  assert.equal(verified.known_hosts_file, ssh.known_hosts_file);
});

test('SSH draft tests reuse only identity-matched secrets without saving and honor cleared fields', async () => {
  const { resolveSSHTestProfile } = require('../../../harness/config/settings-config.cjs');
  const f = fixture();
  await f.save('ssh', { profiles: [{ ...ssh, password: 'private', private_key_file: '/old/key' }], defaultId: ssh.id });
  const before = JSON.stringify(f.values), vault = [...f.vault];
  const resolved = await resolveSSHTestProfile(f.vscode, f.context, ssh);
  assert.equal(resolved.password, 'private'); assert.equal(resolved.private_key_file, undefined);
  assert.equal((await resolveSSHTestProfile(f.vscode, f.context, { ...ssh, host: 'other' })).password, undefined);
  assert.equal((await resolveSSHTestProfile(f.vscode, f.context, { ...ssh, password: null })).password, undefined);
  assert.equal((await resolveSSHTestProfile(f.vscode, f.context, { ...ssh, password: 'draft' })).password, 'draft');
  assert.equal(JSON.stringify(f.values), before); assert.deepEqual([...f.vault], vault);
});

test('desktop skills only use the managed directory, ignoring legacy external paths', async () => {
  const { defaultDirectory } = require('../../../harness/config/skills-catalog.cjs');
  const f = fixture({ skills: { directories: ['C:/external-skills'], skills: [{ directory: 'C:/another-skill' }], maxSkills: 20 } });
  const runtime = await f.model.read();
  assert.deepEqual(runtime.skills.directories, [defaultDirectory]);
  assert.match(defaultDirectory, /[\\/]\.ubovm[\\/]skills$/);
  assert.equal(runtime.skills.skills, undefined);
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.values.skills.directories, undefined);
  assert.equal(snapshot.values.skills.skills, undefined);
  await assert.rejects(f.save('skills', { directories: ['C:/external-skills'] }), /不支持/);
  await f.save('skills', { maxSkills: 30 });
  assert.equal(f.values.skills.directories, undefined);
  assert.equal(f.values.skills.skills, undefined);
  assert.equal((await f.model.read()).skills.maxSkills, 30);
});

test('desktop learning defaults to the user library and preserves explicit isolation or opt-out', async () => {
  const runtime = await fixture({}).model.read();
  assert.match(runtime.intools.knowledge.libraryFile, /[\\/]\.ubovm[\\/]learning[\\/]knowledge\.sqlite$/);
  assert.equal(runtime.intools.knowledge.reflection, true);
  assert.equal(runtime.intools.allowedTools.includes('learn_capability'), false);
  const isolated = await fixture({ intools: { knowledge: { libraryFile: '.learning/knowledge.sqlite' } } }).model.read();
  assert.equal(isolated.intools.knowledge.libraryFile, '.learning/knowledge.sqlite');
  const local = await fixture({ intools: { knowledge: { libraryFile: false } } }).model.read();
  assert.equal(local.intools.knowledge.libraryFile, false);
  const disabled = await fixture({ intools: { knowledge: false } }).model.read();
  assert.equal(disabled.intools.knowledge, false);
});

test('terminal SSH configuration reads local settings and vault without requiring a model', async () => {
  const f = fixture({ model: {} });
  await f.save('ssh', { profiles: [{ ...ssh, password: 'terminal-secret' }], defaultId: 'dev' });
  const configuration = await readSSHConfiguration(f.vscode, f.context);
  assert.equal(configuration.defaultId, 'dev');
  assert.equal(configuration.profiles[0].password, 'terminal-secret');
  assert(!JSON.stringify(f.values).includes('terminal-secret'));
  const vscode = { workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: { ssh: { ...ssh, password: 'legacy-secret' } }, workspaceValue: { ssh: { ...ssh, host: 'other-host' } } }) }) } };
  const legacy = await readSSHConfiguration(vscode, f.context);
  assert.equal(legacy.profiles[0].host, ssh.host);
  assert.equal(legacy.profiles[0].password, 'terminal-secret');
});

test('settings show SDK defaults without writing them or replacing explicit values', async () => {
  const f = fixture({ model: {}, reason: { maxRepairs: 0 }, worker: { maxModelCalls: 7 }, contextSummary: { triggerTokens: 20000, targetTokens: 10000 }, intools: { allowedTools: [], browser: false } });
  const before = structuredClone(f.values), snapshot = await f.service.snapshot();
  assert.equal(snapshot.values.model.provider, 'openai'); assert.equal(snapshot.values.model.modelId, 'gpt-4.1');
  assert.equal(snapshot.sections.model.fields.find(f => f.key === 'provider').type, 'select');
  assert.equal(snapshot.mcpFields.find(f => f.key === 'transport').type, 'select');
  assert.equal(snapshot.values.reason.maxRepairs, 0); assert.equal(snapshot.values.reason.maxIntents, 5);
  assert.equal(snapshot.values.reason.openIntents, 5); assert.equal(snapshot.values.reason.maxConcurrency, 3);
  assert.equal(snapshot.values.reason.maxRounds, 20);
  assert.equal(snapshot.values.worker.maxModelCalls, 7); assert.equal(snapshot.values.worker.maxResponseBytes, 24576);
  assert.equal(snapshot.values.mcp.connectTimeoutMs, 20000); assert.equal(snapshot.values.skills.maxWorkers, 10000);
  assert.equal(snapshot.values.summary.triggerTokens, 20000); assert.equal(snapshot.values.tools, undefined); assert.equal(snapshot.sections.tools, undefined);
  assert.deepEqual(f.values, before); assert.equal(f.vault.size, 0);
});

test('worker call budgets default to unlimited and accept saving zero', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.values.worker.maxModelCalls, 0);
  assert.equal(snapshot.values.worker.maxToolCalls, 0);
  await f.save('worker', snapshot.values.worker);
  const runtime = await f.model.read();
  assert.equal(runtime.worker.maxModelCalls, 0);
  assert.equal(runtime.worker.maxToolCalls, 0);
});

test('exploration depth settings promote to harness options and reject invalid relationships', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  await f.save('reason', { ...snapshot.values.reason, openIntents: 10, maxIntents: 6, maxConcurrency: 4, maxRounds: 40 });
  const runtime = await f.model.read();
  assert.equal(runtime.openIntents, 10);
  assert.equal(runtime.maxConcurrency, 4);
  assert.equal(runtime.maxRounds, 40);
  assert.equal(runtime.reason.openIntents, 10);
  assert.equal(runtime.reason.maxIntents, 6);
  assert.equal(runtime.reason.maxConcurrency, undefined);
  assert.equal(runtime.reason.maxRounds, undefined);
  await assert.rejects(f.save('reason', { ...snapshot.values.reason, openIntents: 3, maxConcurrency: 5 }), /并行任务数/);
  await assert.rejects(f.save('reason', { ...snapshot.values.reason, openIntents: 3, maxIntents: 5 }), /每轮新增任务/);
});

test('custom providers remain editable and preset model defaults save as valid configuration', async () => {
  const f = fixture({ model: { ...base.model, provider: 'company-gateway' } });
  const snapshot = await f.service.snapshot(); assert.equal(snapshot.values.model.provider, 'company-gateway');
  await f.save('model', snapshot.values.model); assert.equal((await f.model.read()).model.provider, 'company-gateway');
  const fresh = fixture({ model: {} }); const initial = await fresh.service.snapshot();
  await fresh.save('model', initial.values.model); assert.equal((await fresh.model.read()).model.modelId, 'gpt-4.1');
  assert.equal(fresh.vault.size, 0);
});

test('model keys are stored privately, omitted from snapshots, and injected into each role at runtime', async () => {
  const f = fixture(); await f.save('model', { ...base.model, apiKey: 'model-secret' });
  await f.save('workerModel', { ...base.model, modelId: 'worker', inherit: false });
  const snapshot = await f.service.snapshot();
  assert(snapshot.secretState.model.apiKey); assert(snapshot.secretState.workerModel.apiKey);
  assert(!JSON.stringify(snapshot).includes('model-secret')); assert(!JSON.stringify(f.values).includes('model-secret'));
  const runtime = await f.model.read(); assert.equal(runtime.model.apiKey, 'model-secret'); assert.equal(runtime.worker.model.apiKey, 'model-secret');
  await f.save('model', { ...base.model, apiKey: null }); assert.equal((await f.model.read()).model.apiKey, undefined);
});
test('SSH profiles preserve credentials on ordinary edits, bind them to host identity, and remove deleted secrets', async () => {
  const f = fixture(); await f.save('ssh', { enabled: true, profiles: [{ ...ssh, password: 'ssh-secret', private_key_passphrase: 'phrase' }], defaultId: 'dev' });
  assert(!JSON.stringify(f.values).includes('ssh-secret')); assert(!JSON.stringify(await f.service.snapshot()).includes('ssh-secret'));
  await f.save('ssh', { enabled: true, profiles: [{ ...ssh, name: '开发机' }], defaultId: 'dev' });
  assert.equal((await f.model.read()).intools.ssh.profiles[0].password, 'ssh-secret');
  await f.save('ssh', { enabled: true, profiles: [{ ...ssh, host: '192.0.2.20' }], defaultId: 'dev' });
  assert.equal((await f.model.read()).intools.ssh.profiles[0].password, undefined);
  assert(![...f.vault.values()].some(value => value.includes('ssh-secret')));
  await f.save('ssh', { profiles: [], defaultId: '' }); assert(f.values.intools.allowedTools.includes('run_linux_ssh_command')); assert.deepEqual(f.values.intools.ssh.profiles, []);
});
test('web search key is endpoint scoped and clear removes it from runtime without removing other tools', async () => {
  const f = fixture(); await f.save('web', { enabled: true, apiKey: 'web-secret', baseURL: 'https://api.tavily.com', searchDepth: 'advanced' });
  assert.equal((await f.model.read()).intools.webSearch.apiKey, 'web-secret');
  assert(!JSON.stringify(await f.service.snapshot()).includes('web-secret')); assert(!JSON.stringify(f.values).includes('web-secret'));
  await f.save('web', { enabled: true, baseURL: 'https://other.example' }); assert.equal((await f.model.read()).intools.webSearch.apiKey, undefined);
  await f.save('web', { enabled: false, baseURL: 'https://api.tavily.com', apiKey: null });
  assert.equal((await f.model.read()).intools.webSearch.apiKey, undefined); assert(f.values.intools.allowedTools.includes('note'));
});
test('SSH form can clear a private key path while retaining unexposed output limits', async () => {
  const f = fixture({ intools: { ssh: { profiles: [{ ...ssh, private_key_file: '~/.ssh/old', max_output_bytes: 12345 }] } } });
  await f.save('ssh', { enabled: true, profiles: [ssh], defaultId: 'dev' });
  const result = (await f.model.read()).intools.ssh.profiles[0];
  assert.equal(result.private_key_file, undefined); assert.equal(result.max_output_bytes, 12345);
});
test('summary validation is atomic, disabling keeps parameters, and re-enabling restores them', async () => {
  const f = fixture(); const before = structuredClone(f.values);
  await assert.rejects(f.save('summary', { enabled: true, triggerTokens: 1000, targetTokens: 2000 }), /必须小于/); assert.deepEqual(f.values, before);
  await f.save('summary', { enabled: false, triggerTokens: 32000, targetTokens: 12000 });
  assert.equal((await f.model.read()).contextSummary, false); assert.equal((await f.service.snapshot()).values.summary.triggerTokens, 32000);
  await f.save('summary', { enabled: true, triggerTokens: 32000, targetTokens: 12000 }); assert.equal((await f.model.read()).contextSummary.targetTokens, 12000);
});
test('legacy tool switches and allowlists cannot disable built-ins or erase connection parameters', async () => {
  for (const intools of [false, { allowedTools: [], browser: false, webSearch: false, fetchContent: false, skillResource: false, skillScript: false },
    { allowedTools: ['note'], ssh: { profiles: [ssh] }, webSearch: { timeoutMs: 12345 } }]) {
    const f = fixture({ toolsEnabled: false, intools }), before = structuredClone(f.values);
    const runtime = await f.model.read();
    assert.deepEqual(runtime.intools.allowedTools, require('../../../harness/config/settings-schema.cjs').tools);
    for (const name of ['browser', 'webSearch', 'fetchContent', 'skillResource', 'skillScript']) assert.equal(typeof runtime.intools[name], 'object');
    if (intools?.ssh) assert.deepEqual(runtime.intools.ssh.profiles[0], ssh);
    if (intools?.webSearch?.timeoutMs) assert.equal(runtime.intools.webSearch.timeoutMs, 12345);
    await assert.rejects(f.save('tools', { enabled: false }));
    assert.deepEqual(f.values, before);
  }
});
test('MCP credentials are private, survive edits and do not follow changed server endpoints', async () => {
  const f = fixture(); const server = { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse' };
  await f.save('mcp', { servers: [server], credentials: JSON.stringify({ remote: { headers: { Authorization: 'Bearer mcp-secret' } } }) });
  assert(!JSON.stringify(await f.service.snapshot()).includes('mcp-secret')); assert(!JSON.stringify(f.values).includes('mcp-secret'));
  await f.save('mcp', { servers: [server] }); assert.equal((await f.model.read()).mcp.servers[0].headers.Authorization, 'Bearer mcp-secret');
  await f.save('mcp', { servers: [{ ...server, url: 'https://other.example/sse' }] }); assert.equal((await f.model.read()).mcp.servers[0].headers, undefined);
});
test('legacy SSH and web keys migrate out of settings when their section is saved', async () => {
  const f = fixture({ intools: { ssh: { profiles: [{ ...ssh, password: 'legacy-ssh' }] }, webSearch: { tavily: { apiKey: 'legacy-web' } } } });
  assert(!JSON.stringify(await f.service.snapshot()).includes('legacy-'));
  await f.save('ssh', { enabled: true, profiles: [ssh], defaultId: 'dev' }); await f.save('web', { enabled: true });
  assert(!JSON.stringify(f.values).includes('legacy-')); const result = await f.model.read();
  assert.equal(result.intools.ssh.profiles[0].password, 'legacy-ssh'); assert.equal(result.intools.webSearch.apiKey, 'legacy-web');
});
test('stale saves cannot overwrite a concurrent update, including a credentials-only update', async () => {
  const f = fixture(); const revision = (await f.service.snapshot()).revision;
  await f.service.save('model', { ...base.model, apiKey: 'secret' }, revision);
  await assert.rejects(f.service.save('model', { ...base.model, apiKey: 'wrong' }, revision), /发生变化/);
  assert.equal((await f.model.read()).model.apiKey, 'secret');
});
test('failed settings writes roll back credential writes and partial multi-setting updates', async () => {
  const f = fixture(); await f.save('model', { ...base.model, apiKey: 'before' });
  f.fail('model'); await assert.rejects(f.save('model', { ...base.model, apiKey: 'after' }), /保存失败/); assert.equal((await f.model.read()).model.apiKey, 'before');
  f.fail('summaryEnabled'); await assert.rejects(f.save('summary', { enabled: false, triggerTokens: 30000, targetTokens: 10000 }), /保存失败/);
  assert.equal(f.values.contextSummary, true); assert.equal(f.values.summaryEnabled, true);
});
test('invalid SSH values and misplaced secrets are rejected before writing', async () => {
  const f = fixture(), before = structuredClone(f.values);
  for (const profile of [{ ...ssh, port: 70000 }, { ...ssh, host_key_sha256: 'bad' }]) await assert.rejects(f.save('ssh', { enabled: true, profiles: [profile] }));
  await assert.rejects(f.save('model', { ...base.model, compat: { apiKey: 'oops' } }), /专用加密字段/);
  await assert.rejects(f.save('mcp', { servers: [{ name: 'test', command: 'node', env: { KEY: 'oops' } }] }), /专用加密字段/);
  assert.deepEqual(f.values, before); assert.equal(f.vault.size, 0);
});

test('the model command rolls back existing, newly created and cleared credentials on a settings failure', async () => {
  const f = fixture(); await f.model.configure({ ...base.model, apiKey: 'before' });
  for (const next of [{ ...base.model, apiKey: 'after' }, { ...base.model, apiKey: '' }, { ...base.model, baseUrl: 'https://other.example/v1', apiKey: 'new-secret' }]) {
    const before = structuredClone(f.values), vault = new Map(f.vault);
    f.fail('model'); await assert.rejects(f.model.configure(next), /已恢复原配置/);
    assert.deepEqual(f.values, before); assert.deepEqual(f.vault, vault);
  }
});

test('credential-only writes from the model command and another settings service invalidate old forms', async () => {
  const f = fixture(), another = createSettingsConfiguration(f.vscode, f.context);
  const revision = (await f.service.snapshot()).revision;
  await f.model.configure({ ...base.model, apiKey: 'command-key' });
  await assert.rejects(f.service.save('model', { ...base.model, apiKey: 'stale' }, revision), /发生变化/);
  const secondRevision = (await f.service.snapshot()).revision;
  await another.save('model', { ...base.model, apiKey: 'other-view-key' }, secondRevision);
  await assert.rejects(f.service.save('model', { ...base.model, apiKey: 'stale' }, secondRevision), /发生变化/);
  assert.equal((await f.model.read()).model.apiKey, 'other-view-key');
});

test('runtime reads and later model saves wait for a failed transaction to roll back', async () => {
  const f = fixture(); await f.model.configure({ ...base.model, apiKey: 'before' });
  let started, release;
  const writing = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.configuration.update; let first = true;
  f.configuration.update = async (name, value) => {
    if (first) { first = false; started(); await gate; throw new Error('failed after vault write'); }
    return update(name, value);
  };
  const failed = assert.rejects(f.model.configure({ ...base.model, apiKey: 'temporary' }), /已恢复原配置/);
  await writing;
  let readFinished = false;
  const read = f.model.read().then(value => { readFinished = true; return value; });
  const later = f.model.configure({ ...base.model, apiKey: 'final' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(readFinished, false);
  release(); await failed;
  assert.equal((await read).model.apiKey, 'before');
  await later; assert.equal((await f.model.read()).model.apiKey, 'final');
});

test('a concurrent external settings edit during credential preparation rejects the stale save', async () => {
  const f = fixture(), revision = (await f.service.snapshot()).revision;
  const get = f.context.secrets.get; let changed = false;
  f.context.secrets.get = async key => {
    if (!changed) { changed = true; f.values.worker = { maxToolCalls: 7 }; }
    return get(key);
  };
  await assert.rejects(f.service.save('web', { enabled: true, apiKey: 'must-not-save' }, revision), /发生变化/);
  assert.equal(f.vault.size, 0); assert.deepEqual(f.values.worker, { maxToolCalls: 7 });
});

test('disabled middleware skips invalid saved models and unavailable credentials without losing configuration', async () => {
  const server = { name: 'disabled', enabled: false, command: 'node' };
  const f = fixture({ summaryEnabled: false, contextSummary: { model: { invalid: true } }, toolsEnabled: false,
    intools: false, mcp: { servers: [server] } });
  const saved = structuredClone(f.values), get = f.context.secrets.get, requested = [];
  f.context.secrets.get = async key => { requested.push(key); if (key.startsWith('ubovm.mcp.')) throw new Error('disabled credential unavailable'); return get(key); };
  const runtime = await f.model.read();
  assert.equal(runtime.contextSummary, false); assert.deepEqual(runtime.intools.allowedTools, require('../../../harness/config/settings-schema.cjs').tools);
  assert.deepEqual(runtime.mcp.servers, [server]); assert(!requested.some(key => key.startsWith('ubovm.mcp.')));
  assert.deepEqual(f.values, saved);
  f.values.summaryEnabled = true; await assert.rejects(f.model.read(), /模型配置/);
});

test('a partially completed credential write is restored without exposing the vault error', async () => {
  const f = fixture(); await f.model.configure({ ...base.model, apiKey: 'before' });
  const store = f.context.secrets.store; let first = true;
  f.context.secrets.store = async (key, value) => {
    await store(key, value);
    if (first) { first = false; throw new Error('private provider error including a secret'); }
  };
  await assert.rejects(f.model.configure({ ...base.model, apiKey: 'after' }), error => /已恢复原配置/.test(error.message) && !/private|secret/.test(error.message));
  assert.equal((await f.model.read()).model.apiKey, 'before');
});

test('external SecretStorage updates invalidate open forms and use one disposable subscription', async () => {
  const f = fixture(), revision = (await f.service.snapshot()).revision;
  assert.equal(f.context.subscriptions.length, 1);
  f.vault.set(keyFor(base.model), 'changed-elsewhere'); f.notifySecret(keyFor(base.model));
  await assert.rejects(f.service.save('model', { ...base.model, apiKey: 'stale' }, revision), /发生变化/);
  assert.equal((await f.model.read()).model.apiKey, 'changed-elsewhere');
  for (const subscription of f.context.subscriptions) subscription.dispose();
});

test('malformed pi model fields are rejected before any credential or settings mutation', async () => {
  const f = fixture(), before = structuredClone(f.values);
  const invalid = [{ ...base.model, baseUrl: undefined }, { ...base.model, input: [] }, { ...base.model, input: ['text', 'text'] },
    { ...base.model, input: ['audio'] }, { ...base.model, compat: false }, { ...base.model, streamOptions: [] }, { ...base.model, contextWindow: 1000, maxTokens: 2000 }];
  for (const value of invalid) await assert.rejects(f.model.configure({ ...value, apiKey: 'must-not-save' }));
  assert.deepEqual(f.values, before); assert.equal(f.vault.size, 0);
  await f.model.configure({ ...base.model, input: ['text', 'image'], compat: { supportsStore: false }, streamOptions: { timeoutMs: 30000 } });
  assert.deepEqual((await f.model.read()).model.input, ['text', 'image']);
});

test('assistance approval defaults on and its switch round trips independently of execution budgets', async () => {
  const f = fixture();
  assert.equal((await f.service.snapshot()).values.worker.requireToolApproval, true);
  await f.save('worker', { requireToolApproval: false, maxToolCalls: 7 });
  assert.equal((await f.model.read()).worker.requireToolApproval, false);
  assert.equal((await f.model.read()).worker.maxToolCalls, 7);
  await f.save('worker', { requireToolApproval: true, maxToolCalls: 7 });
  assert.equal((await f.model.read()).worker.requireToolApproval, true);
  await assert.rejects(f.save('worker', { requireToolApproval: 'false' }), /开关值/);
});


test('non-skill snapshots and MCP saves omit the skill catalog', async () => {
  const f = fixture();
  const data = await f.service.snapshot({ includeSkills: false });
  assert.equal(data.skillsCatalog, undefined);
  const saved = await f.service.save('mcp', data.values.mcp, data.revision);
  assert.equal(saved.skillsCatalog, undefined);
  assert.ok((await f.service.snapshot({ includeSkills: true })).skillsCatalog);
});
