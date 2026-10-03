import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { createSettingsConfiguration } = require('../../harness/config/settings-config.cjs');
const { renderWebview } = require('../../host/ui/webview.cjs');

test('superseded settings loads cannot clear a newer navigation or publish stale configuration', async () => {
  const source = readFileSync(new URL('../../extension.cjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  async function openSettings('), source.indexOf('  function newChat('));
  const pending = [], messages = [];
  const context = vm.createContext({ settingsOpenRevision: 0, settingsOpening: 0, welcomeReady: true, shuttingDown: false,
    openWelcome: async () => {}, welcome: { webview: { postMessage: async message => messages.push(message) } },
    settingsConfiguration: { snapshot: () => new Promise(resolve => pending.push(resolve)) }, browserInstaller: { status: () => ({}) },
    modelConfiguration: { status: () => ({ configured: false }) }, readSSHStatus: () => ({ configured: false }), vscode: {},
    output: { appendLine() {} }, errorText: String, normalizeError: String });
  vm.runInContext(block, context);
  const first = context.openSettings('mcp');
  await new Promise(resolve => setImmediate(resolve));
  const second = context.openSettings('skills');
  await new Promise(resolve => setImmediate(resolve));
  pending[0]({ revision: 'old' }); await first;
  assert.equal(context.settingsOpening, 2);
  assert.equal(messages.some(message => message.type === 'openSettings'), false);
  pending[1]({ revision: 'new' }); await second;
  assert.equal(context.settingsOpening, 0);
  assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
  assert.equal(messages.at(-1).page, 'skills');
  context.openWelcome = async () => { throw Error('panel unavailable'); };
  await assert.rejects(context.openSettings('mcp'), /panel unavailable/);
  assert.equal(context.settingsOpening, 0, 'failure releases the automatic initialization guard');
});

test('startup opens initialization only for missing configuration and preserves pending navigation', async () => {
  const source = readFileSync(new URL('../../extension.cjs', import.meta.url), 'utf8');
  const start = source.indexOf("else if (message.action === 'ready') {");
  const block = source.slice(start + 'else '.length, source.indexOf("else if (message.action === 'toolApproval')", start));
  for (const [model, ssh, revision, pending, expected] of [[false, false, 0, 0, 1], [true, false, 0, 0, 1], [false, true, 0, 0, 1], [true, true, 0, 0, 0], [false, false, 8, 8, 0], [false, false, 9, 0, 1]]) {
    let opens = 0;
    const context = vm.createContext({ message: { action: 'ready' }, welcomeReady: false, settingsOpenRevision: revision, settingsOpening: pending,
      publishState() {}, modelConfiguration: { status: () => ({ configured: model }) }, readSSHStatus: () => ({ configured: ssh }),
      vscode: {}, openSettings: async () => { opens++; }, clearTimeout() {}, setTimeout() { return 0; },
      readyPublishTimer: undefined, chromeLockedSessionId: undefined, shuttingDown: false, pendingProjectSwitcher: null, welcome: null });
    await vm.runInContext(`(async () => { ${block} })()`, context);
    await vm.runInContext(`(async () => { ${block} })()`, context);
    assert.equal(opens, expected);
  }
});

test('initialization saves steps, retains failed drafts, resumes and finishes without optional tools', async () => {
  const values = {}, vault = new Map();
  const service = createSettingsConfiguration({ ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({
    inspect: key => ({ globalValue: values[key] }), update: async (key, value) => { values[key] = value; }
  }) } }, { secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://initialization.test/');
    const open = async () => {
      await page.evaluate(data => window.postMessage({ type: 'openSettings', page: 'initialize', data }, '*'), await service.snapshot({ includeSkills: false }));
      await page.locator('#settings-initialization').waitFor();
    };
    const save = async (fail = false) => {
      await page.locator('#settings-save').click();
      const request = await page.evaluate(() => window.sent.findLast(message => message.action === 'settingsSave'));
      const result = fail ? { ok: false, error: '模拟保存失败' } : { ok: true, saved: true, data: await service.save(request.section, request.value, request.revision) };
      await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsResult', requestId: request.requestId, ...result });
      await page.waitForFunction(() => !document.querySelector('#settings-save').disabled);
    };
    await open();
    assert.equal(await page.locator('#settings-title').textContent(), '首次初始化');
    assert.equal(await page.locator('#settings-finish').isDisabled(), true);
    assert.equal(await page.locator('#settings-model-roles').isVisible(), false);
    await page.locator('[data-setting="modelId"]').fill('ctf-model');
    await page.locator('[data-setting="apiKey"]').fill('test-private-key');
    await save(true);
    assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'ctf-model');
    assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), 'test-private-key');
    await save();
    await page.locator('#settings-add-ssh').waitFor();
    assert.equal(await page.locator('#settings-finish').isDisabled(), true);
    // An interrupted setup reopens at its missing step without losing persisted credentials.
    await page.locator('#settings-close').click();
    await open();
    await page.locator('#settings-add-ssh').waitFor();
    assert.equal(await page.locator('.settings-ssh-profile').count(), 1);
    assert.equal(await page.locator('[data-setup-step="ssh"]').getAttribute('aria-current'), 'step');
    assert.equal(await page.locator('[data-setup-step="model"]').getAttribute('aria-current'), null);
    assert.equal(await page.locator('[data-setting="host"]').getAttribute('required'), '');
    await page.locator('[data-setting="host"]').fill('192.0.2.10');
    await page.locator('[data-setting="username"]').fill('ctf');
    await save();
    await page.locator('.settings-browser-card').waitFor();
    assert.equal(await page.locator('#settings-finish').isEnabled(), true);
    assert.equal((await service.snapshot()).initialization.complete, true);
    assert.equal(JSON.stringify(await service.snapshot()).includes('test-private-key'), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.querySelector('#settings-dialog').scrollWidth <= innerWidth), true);
    await page.locator('#settings-finish').click();
    assert.equal(await page.locator('#settings-finish').isDisabled(), true);
    const completion = await page.evaluate(() => window.sent.findLast(message => message.action === 'settingsRead'));
    await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsResult', requestId: completion.requestId, ok: true, data: await service.snapshot() });
    await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
    assert.equal(await page.locator('#settings-dialog').isVisible(), false);
    await page.evaluate(data => window.postMessage({ type: 'openSettings', data }, '*'), await service.snapshot());
    await page.locator('#settings-fields').waitFor();
    assert.equal(await page.locator('#settings-initialization').isVisible(), false);
    assert.equal(await page.locator('#settings-title').textContent(), '系统配置');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('completion rechecks external edits, retains its page on failure and protects optional drafts', async () => {
  const values = { model: { provider: 'custom', modelId: 'local-model', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1' },
    intools: { ssh: { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf', port: 22 }] } } };
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: key => ({ globalValue: values[key] }) }) } }, { secrets: { get: async () => undefined } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://completion.test/');
    const post = message => page.evaluate(message => window.postMessage(message, '*'), message);
    const lastRead = () => page.evaluate(() => window.sent.findLast(message => message.action === 'settingsRead'));
    await post({ type: 'openSettings', page: 'initialize', data: await service.snapshot({ includeSkills: false }) });
    await page.locator('.settings-browser-card').waitFor();
    await page.locator('[data-setup-step="model"]').click();
    assert.equal(await page.locator('#settings-save').textContent(), '继续下一步');
    await page.locator('#settings-save').click();
    await page.locator('.settings-browser-card').waitFor();
    assert.equal(await page.evaluate(() => window.sent.some(message => message.action === 'settingsSave')), false, 'unchanged saved steps are not written again');
    await page.locator('[data-setting="headless"]').uncheck();
    await page.locator('#settings-finish').click();
    assert.equal(await page.locator('#settings-discard').isVisible(), true);
    assert.equal(await lastRead(), undefined, 'unsaved input needs a user decision before completion');
    await page.locator('#settings-keep').click();
    assert.equal(await page.locator('[data-setting="headless"]').isChecked(), false);
    await page.locator('#settings-finish').click();
    await page.locator('#settings-discard-confirm').click();
    const failed = await lastRead();
    await post({ type: 'settingsResult', requestId: failed.requestId, ok: false, error: '模拟凭据读取失败' });
    await page.waitForFunction(() => !document.querySelector('#settings-finish').disabled);
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    assert.equal(await page.locator('[data-setting="headless"]').isChecked(), true, 'discarded optional draft cannot become a clean unsaved form after read failure');
    // An external edit invalidates the default SSH while the wizard is open.
    values.intools.ssh.defaultId = 'removed';
    await page.locator('#settings-finish').click();
    const current = await lastRead();
    await post({ type: 'settingsResult', requestId: failed.requestId, ok: true, data: { initialization: { complete: true } } });
    assert.equal(await page.locator('#settings-dialog').isVisible(), true, 'a stale completion response cannot close the page');
    await post({ type: 'settingsResult', requestId: current.requestId, ok: true, data: await service.snapshot({ includeSkills: false }) });
    await page.locator('#settings-add-ssh').waitFor();
    assert.equal(await page.locator('#settings-finish').isDisabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-init-title');
    assert.match(await page.locator('#settings-status').textContent(), /基础配置已发生变化/);
    assert.equal(await page.evaluate(() => document.querySelector('#settings-dialog').scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('responses from before a webview reload cannot complete a new initialization request', async () => {
  const values = { model: { provider: 'custom', modelId: 'local-model', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1' },
    intools: { ssh: { profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf' }] } } };
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: key => ({ globalValue: values[key] }) }) } }, { secrets: { get: async () => undefined } });
  const snapshot = await service.snapshot({ includeSkills: false });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    const startCompletion = async () => {
      await page.goto('http://generation.test/');
      await page.evaluate(data => window.postMessage({ type: 'openSettings', page: 'initialize', data }, '*'), snapshot);
      await page.locator('#settings-finish').click();
      return page.evaluate(() => window.sent.findLast(message => message.action === 'settingsRead').requestId);
    };
    const oldId = await startCompletion(), newId = await startCompletion();
    assert.notEqual(oldId, newId);
    assert(newId.length <= 100, 'request IDs fit the host message contract');
    await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsResult', requestId: oldId, ok: true, data: snapshot });
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    assert.equal(await page.locator('#settings-finish').isDisabled(), true);
    await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsResult', requestId: newId, ok: true, data: snapshot });
    await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  } finally { await browser.close(); }
});
