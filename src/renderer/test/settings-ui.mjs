import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { createSettingsConfiguration } = require('../harness/config/settings-config.cjs');
const { renderWebview } = require('../host/webview.cjs');
const manifest = require('../package.json');

test('model library loads roles, saves copies and SSH duplication omits credentials', async () => {
  const values = { model: { provider: 'custom', modelId: 'daily', api: 'openai-completions', baseUrl: 'https://daily.example/v1' }, modelProfiles: [
    { id: 'code', name: '代码', model: { provider: 'custom', modelId: 'coder', api: 'openai-completions', baseUrl: 'https://code.example/v1' } }
  ], intools: { ssh: { defaultId: 'dev', profiles: [{ id: 'dev', host: 'dev.example', username: 'dev' }] } } };
  const vault = new Map();
  const service = createSettingsConfiguration({ ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({
    inspect: key => ({ globalValue: values[key] }), update: async (key, value) => { values[key] = value; }
  }) } }, { secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://multi-settings.test/');
    const send = message => page.evaluate(message => window.postMessage(message, '*'), message);
    await send({ type: 'openSettings', data: await service.snapshot() });
    await page.locator('#settings-model-profile').selectOption('code');
    assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'coder');
    const save = async () => {
      await page.locator('#settings-save').click();
      const request = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsSave'));
      const data = await service.save(request.section, request.value, request.revision);
      await send({ type: 'settingsResult', requestId: request.requestId, ok: true, saved: true, data });
      await page.waitForFunction(() => !document.querySelector('#settings-save').disabled);
      return request;
    };
    await save(); assert.equal(values.model.modelId, 'coder');
    await page.getByRole('button', { name: '另存为新配置', exact: true }).click();
    await page.locator('#settings-model-profile-name').fill('代码副本');
    await save(); assert.equal(values.modelProfiles.length, 2);
    await save(); assert.equal(values.modelProfiles.length, 2);
    await page.locator('#settings-tab-workerModel').click();
    await page.locator('[data-setting="inherit"]').uncheck();
    // Discard the inheritance toggle when choosing a saved model.
    await page.locator('#settings-model-profile').selectOption('code');
    await page.locator('#settings-discard-confirm').click();
    await save(); assert.equal(values.worker.model.modelId, 'coder');
    await page.getByRole('button', { name: '删除已保存配置', exact: true }).click();
    const deletion = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsSave'));
    assert.equal(deletion.value.deleteProfileId, 'code');
    await send({ type: 'settingsResult', requestId: deletion.requestId, ok: true, saved: true,
      data: await service.save(deletion.section, deletion.value, deletion.revision) });
    await page.waitForFunction(() => !document.querySelector('#settings-save').disabled);
    assert.equal(values.modelProfiles.length, 1);
    assert.equal(values.worker.model.modelId, 'coder');
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.locator('.settings-model-library').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await send({ type: 'settingsSection', section: 'ssh' });
    await page.locator('[data-setting="password"]').fill('draft-secret');
    await page.getByRole('button', { name: '复制连接', exact: true }).click();
    assert.equal(await page.locator('.settings-profile').count(), 2);
    assert.equal(await page.locator('.settings-profile').nth(1).locator('[data-setting="password"]').inputValue(), '');
    const request = await save(); assert.equal(request.value.profiles.length, 2);
    assert.equal(values.intools.ssh.profiles.length, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('browser installation button retains progress across navigation and allows retry', async () => {
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 850 } });
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://browser-settings.test/');
    const send = message => page.evaluate(message => window.postMessage(message, '*'), message);
    await send({ type: 'openSettings', data: await service.snapshot() });
    await send({ type: 'settingsSection', section: 'web' });
    const button = page.locator('[data-install-browser]');
    await button.click(); assert.equal(await button.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.sent.filter(m => m.action === 'settingsInstallBrowser').length), 1);
    await send({ type: 'settingsSection', section: 'model' });
    await send({ type: 'settingsBrowserInstallResult', ok: false, message: '下载失败，请重试' });
    await send({ type: 'settingsSection', section: 'web' });
    await page.waitForFunction(() => document.querySelector('[data-browser-install-status]')?.textContent.includes('下载失败'));
    assert.equal(await button.isEnabled(), true); await button.click();
    await send({ type: 'settingsBrowserInstallResult', ok: true, message: '安装完成' });
    await page.waitForFunction(() => document.querySelector('[data-browser-install-status]').textContent === '安装完成');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('[data-browser-badge]').textContent(), '已就绪');
    await page.getByRole('button', { name: '检查状态', exact: true }).click();
    assert.equal(await page.evaluate(() => window.sent.some(m => m.action === 'settingsBrowserStatus')), true);
    await send({ type: 'settingsBrowserStatus', installation: { state: 'missing', executablePath: 'C:/cache/chrome.exe' } });
    await page.waitForFunction(() => document.querySelector('[data-browser-badge]').textContent === '未安装');
    assert.equal(await button.isEnabled(), true);
    await page.getByText('浏览器文件位置', { exact: true }).click();
    assert.equal(await page.locator('[data-browser-location]').textContent(), 'C:/cache/chrome.exe');
    await page.getByRole('button', { name: '查看安装日志', exact: true }).click();
    assert.equal(await page.evaluate(() => window.sent.some(m => m.action === 'settingsBrowserLogs')), true);
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.locator('.settings-browser-card').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await page.screenshot({ path: '.cache/browser-settings-narrow.png' });
    assert.equal(await page.evaluate(() => window.sent.some(m => m.action === 'settingsSave')), false);
  } finally { await browser.close(); }
});

test('search configuration explains draft credentials and saves collapsed advanced fields', async () => {
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://search-settings.test/');
    const snapshot = await service.snapshot(); snapshot.secretState.web.apiKey = true;
    await page.evaluate(data => window.postMessage({ type: 'openSettings', data }, '*'), snapshot);
    await page.evaluate(() => window.postMessage({ type: 'settingsSection', section: 'web' }, '*'));
    const advanced = page.locator('.settings-search-advanced');
    const headless = page.locator('.settings-browser-card [data-setting="headless"]');
    assert.equal(await headless.isChecked(), true);
    await headless.uncheck();
    assert.equal(await advanced.getAttribute('open'), null);
    assert.equal(await page.locator('[data-search-badge]').textContent(), '已保存凭据');
    await page.locator('[data-setting="searchDepth"]').selectOption('advanced');
    assert.equal(await page.locator('[data-setting="searchDepth"] option:checked').textContent(), '深入');
    await advanced.locator('summary').click();
    await page.locator('[data-setting="baseURL"]').fill('https://custom.example');
    assert.equal(await page.locator('[data-search-badge]').textContent(), '公共搜索回退');
    assert.match(await page.locator('[data-search-summary]').textContent(), /原地址的凭据不会自动带入/);
    await page.locator('[data-setting="fallbackToPublicProviders"]').uncheck();
    assert.equal(await page.locator('[data-search-badge]').textContent(), '待配置凭据');
    await page.locator('[data-setting="apiKey"]').fill('new-secret');
    assert.equal(await page.locator('[data-search-badge]').textContent(), '新凭据待保存');
    assert.equal(await page.locator('[data-setting="apiKey"]').getAttribute('type'), 'password');
    await page.locator('[data-setting="projectID"]').fill('project-test');
    await page.locator('[data-setting="providerRetryAttempts"]').fill('9');
    await advanced.locator('summary').click();
    await page.locator('#settings-save').click();
    assert.notEqual(await advanced.getAttribute('open'), null, 'invalid hidden field is revealed');
    assert.equal(await page.evaluate(() => window.sent.filter(m => m.action === 'settingsSave').length), 0);
    await page.locator('[data-setting="providerRetryAttempts"]').fill('2');
    await advanced.locator('summary').click();
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.locator('.settings-search-card').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await page.locator('.settings-search-card').screenshot({ path: '.cache/search-settings-card.png' });
    await page.locator('#settings-save').click();
    const saved = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsSave'));
    assert.equal(saved.section, 'web');
    assert.equal(saved.value.baseURL, 'https://custom.example');
    assert.equal(saved.value.projectID, 'project-test');
    assert.equal(saved.value.providerRetryAttempts, 2);
    assert.equal(saved.value.searchDepth, 'advanced');
    assert.equal(saved.value.headless, false);
    assert.equal(saved.value.fallbackToPublicProviders, false);
    assert.equal(saved.value.apiKey, 'new-secret');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('SSH connection tests use drafts, display outcomes and reject stale results without saving', async () => {
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 850 } });
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => window.sent.push(message) }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://ssh-settings.test/');
    await page.evaluate(data => window.postMessage({ type: 'openSettings', data }, '*'), await service.snapshot());
    await page.evaluate(() => window.postMessage({ type: 'settingsSection', section: 'ssh' }, '*'));
    await page.locator('#settings-add-ssh').click();
    const group = page.locator('.settings-profile');
    await group.locator('[data-setting="host"]').fill('draft.example');
    await group.locator('[data-setting="username"]').fill('developer');
    const button = group.locator('.settings-ssh-test');
    await button.click();
    assert.equal(await button.isDisabled(), true);
    let request = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsTestSSH'));
    assert.equal(request.profile.host, 'draft.example');
    await page.evaluate(requestId => window.postMessage({ type: 'settingsSSHTestResult', requestId, ok: true, message: '连接成功', durationMs: 20 }, '*'), request.requestId);
    await page.waitForFunction(() => document.querySelector('.settings-ssh-test-status').textContent.includes('20 ms'));
    await button.click();
    request = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsTestSSH'));
    await group.locator('[data-setting="host"]').fill('changed.example');
    await page.evaluate(requestId => window.postMessage({ type: 'settingsSSHTestResult', requestId, ok: true, message: '连接成功' }, '*'), request.requestId);
    await page.waitForFunction(() => document.querySelector('.settings-ssh-test-status').textContent.includes('重新测试'));
    assert.equal(await page.evaluate(() => window.sent.some(m => m.action === 'settingsSave')), false);
    await button.click();
    request = await page.evaluate(() => window.sent.findLast(m => m.action === 'settingsTestSSH'));
    await page.evaluate(requestId => window.postMessage({ type: 'settingsSSHTestResult', requestId, ok: false, message: '认证失败' }, '*'), request.requestId);
    await page.waitForFunction(() => document.querySelector('.settings-ssh-test-status').dataset.error === 'true');
    assert.equal(await button.isEnabled(), true);
  } finally { await browser.close(); }
});

test('model roles retain focus, guard edits, save independently, and show provider icons', async () => {
  const values = {}, vault = new Map();
  const configuration = { inspect: key => ({ globalValue: values[key], defaultValue: manifest.contributes.configuration.properties['ubovm.' + key]?.default }), update: async (key, value) => { values[key] = structuredClone(value); } };
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => configuration }, ConfigurationTarget: { Global: 1 } }, { secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } });
  const html = renderWebview({ version: '1.135.0', workspaceName: 'UI test', nonce: 'settings-ui-test' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [320, 600, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.exposeFunction('settingsHost', async message => {
        if (message.action !== 'settingsSave') return;
        const data = await service.save(message.section, message.value, message.revision);
        await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsResult', requestId: message.requestId, data, saved: true });
      });
      await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: message => window.settingsHost(message) }); });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://settings.test/');
      await page.evaluate(data => window.postMessage({ type: 'openSettings', data }, '*'), await service.snapshot());
      const tab = key => page.locator('#settings-tab-' + key);
      await tab('model').waitFor();
      assert.equal(await page.locator('.settings-provider-select option svg').count(), 11);
      assert.equal(await page.locator('selectedcontent svg').count(), 1);
      await page.locator('#setting-provider').click();
      await page.locator('#setting-provider option[value="anthropic"]').click();
      assert.equal(await page.locator('#setting-provider').inputValue(), 'anthropic');
      assert.equal(await page.locator('#setting-api').inputValue(), 'anthropic-messages');
      await tab('model').click(); assert.equal(await page.locator('#settings-discard').isVisible(), false);
      await tab('reasonModel').click(); await page.locator('#settings-keep').click();
      assert.equal(await tab('model').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#setting-provider').inputValue(), 'anthropic');
      await tab('reasonModel').click(); await page.locator('#settings-discard-confirm').click();
      assert.equal(await tab('reasonModel').evaluate(e => e === document.activeElement), true);
      assert.equal(await page.locator('.settings-inherit-note').isVisible(), true);
      assert.equal(await page.locator('#setting-provider').isVisible(), false);
      await tab('reasonModel').press('ArrowRight');
      assert.equal(await tab('workerModel').getAttribute('aria-selected'), 'true');
      assert.equal(await tab('workerModel').evaluate(e => e === document.activeElement), true);
      await page.locator('#setting-inherit').uncheck();
      await page.locator('#setting-provider').selectOption('deepseek');
      await page.locator('#setting-modelId').fill('worker-ui-' + width);
      await page.locator('#settings-save').click();
      await page.waitForFunction(() => document.querySelector('#settings-status').textContent.startsWith('已保存'));
      assert.equal(values.worker.model.modelId, 'worker-ui-' + width);
      assert.equal(values.model, undefined);
      await tab('summaryModel').click(); await tab('summaryModel').press('Home');
      assert.equal(await page.locator('#setting-provider').inputValue(), 'openai');
      assert.equal(await tab('model').evaluate(e => e === document.activeElement), true);
      for (const key of ['model', 'reasonModel', 'workerModel', 'summaryModel']) await tab(key).click({ trial: true });
      assert(await page.evaluate(() => document.querySelector('#settings-form').scrollWidth <= document.querySelector('#settings-form').clientWidth + 1));
      if (width === 600) await page.screenshot({ path: fileURLToPath(new URL('../../../.cache/settings-tabs-icons.png', import.meta.url)) });
      assert.deepEqual(errors, []);
      // Reset the role so each viewport exercises inheritance from fresh state.
      delete values.worker;
      await page.close();
    }
  } finally { await browser.close(); }
});

test('management page changes wait for discarded edits and preserve the conversation draft', async () => {
  const values = {}, vault = new Map(), errors = [];
  const configuration = { inspect: key => ({ globalValue: values[key], defaultValue: manifest.contributes.configuration.properties['ubovm.' + key]?.default }), update: async (key, value) => { values[key] = structuredClone(value); } };
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => configuration }, ConfigurationTarget: { Global: 1 } }, { secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } });
  const state = {
    type: 'state', mode: 'assist', conversation: { id: 'management-draft', title: '配置导航回归' }, messages: [],
    context: { workspace: 'UI test', file: '' }, provider: { label: '本地测试模型', connected: true },
    execution: { status: 'idle', busy: false, workers: [], streamText: '', canResume: false }, busy: false
  };
  const html = renderWebview({ version: '1.135.0', workspaceName: 'UI test', nonce: 'management-ui-test' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('settingsHost', async message => {
      // The real host republishes conversation state when settings navigation changes.
      if (message.action === 'ready' || message.action === 'settingsNavigation') {
        await page.evaluate(state => window.postMessage(state, '*'), state);
      }
    });
    await page.addInitScript(() => {
      window.settingsMessages = [];
      window.acquireVsCodeApi = () => ({
        getState: () => window.persistedDrafts,
        setState: value => { window.persistedDrafts = value; },
        postMessage: message => { window.settingsMessages.push(message); return window.settingsHost(message); }
      });
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://settings.test/');
    await page.waitForFunction(() => document.querySelector('#connection-note').textContent === '准备好，开始你的下一步');
    assert.equal(await page.locator('#conversation-title').textContent(), state.conversation.title);
    assert.equal(await page.locator('#provider-label').textContent(), state.provider.label);
    assert.equal(await page.locator('#model-settings, #management-menu').count(), 0);
    assert.deepEqual(errors, [], 'Initial host state must render without the removed settings button.');

    const draft = '先保留这条对话草稿，再检查管理配置。';
    await page.locator('#prompt-input').fill(draft);
    let openSequence = 0;
    const navigate = async target => {
      const requestId = 'management-open-' + (++openSequence);
      await page.evaluate(message => window.postMessage(message, '*'), { type: 'settingsLoading', page: target, requestId });
      await page.evaluate(message => window.postMessage(message, '*'), { type: 'openSettings', page: target, requestId, data: await service.snapshot() });
    };
    const navigation = () => page.evaluate(() => window.settingsMessages.filter(message => message.action === 'settingsNavigation').map(({ page, section }) => ({ page, section })));
    const waitPage = target => page.waitForFunction(target => {
      const dialog = document.querySelector('#settings-dialog');
      return dialog.open && dialog.dataset.page === target && !dialog.dataset.operation && !document.querySelector('#settings-fields').hidden;
    }, target);
    const titles = { settings: '系统配置', mcp: 'MCP 服务', skills: 'Skills' };
    await navigate('settings'); await waitPage('settings');
    const originalModel = await page.locator('#setting-modelId').inputValue();

    for (const [source, target, edit] of [
      ['settings', 'mcp', () => page.locator('#setting-modelId').fill('unsaved-model')],
      ['mcp', 'skills', () => page.locator('#settings-add-mcp').click()],
      ['skills', 'settings', async () => { await page.getByText('加载限制', { exact: true }).click(); await page.locator('#setting-maxSkills').fill('50'); }]
    ]) {
      await edit();
      const previous = await navigation();
      await navigate(target);
      await page.locator('#settings-discard').waitFor();
      assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), source);
      assert.equal(await page.locator('#settings-title').textContent(), titles[source]);
      assert.deepEqual(await navigation(), previous, 'A pending discard must not report the requested page to native navigation.');
      await page.locator('#settings-keep').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), false);
      assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), source);
      assert.deepEqual(await navigation(), previous, 'Canceling a page change must keep the native selection.');
      if (source === 'settings') assert.equal(await page.locator('#setting-modelId').inputValue(), 'unsaved-model');
      if (source === 'mcp') assert.equal(await page.locator('[data-server-card]').count(), 1);
      if (source === 'skills') assert.equal(await page.locator('#setting-maxSkills').inputValue(), '50');
      await navigate(target);
      await page.locator('#settings-discard-confirm').click();
      await waitPage(target);
      assert.equal(await page.locator('#settings-title').textContent(), titles[target]);
      assert.deepEqual(await navigation(), [...previous, { page: target, section: target === 'settings' ? 'model' : target }]);
    }
    assert.equal(await page.locator('#setting-modelId').inputValue(), originalModel, 'Discarded edits must not be saved.');
    await page.locator('#setting-modelId').fill('discard-on-close');
    const beforeClose = await navigation();
    await page.locator('#settings-close').click();
    await page.locator('#settings-discard').waitFor();
    assert.deepEqual(await navigation(), beforeClose, 'A pending close must retain native settings navigation.');
    await page.locator('#settings-keep').click();
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    await page.evaluate(() => window.postMessage({ type: 'closeSettings' }, '*'));
    await page.locator('#settings-discard-confirm').click();
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await navigation(), [...beforeClose, { page: '', section: undefined }]);
    assert.equal(await page.locator('#prompt-input').inputValue(), draft);
    assert.equal(await page.evaluate(() => window.persistedDrafts.drafts['management-draft'].assist), draft);
    assert.equal(await page.locator('#assist-mode').isVisible(), true);
    assert.deepEqual(values, {});
    assert.equal(vault.size, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('settings loading follows requests, reuses unchanged forms, and preserves editing on failure', async () => {
  const values = {}, vault = new Map(), errors = [];
  const configuration = { inspect: key => ({ globalValue: values[key], defaultValue: manifest.contributes.configuration.properties['ubovm.' + key]?.default }), update: async (key, value) => { values[key] = structuredClone(value); } };
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => configuration }, ConfigurationTarget: { Global: 1 } }, { secrets: { get: async key => vault.get(key), store: async (key, value) => vault.set(key, value), delete: async key => vault.delete(key) } });
  const snapshot = await service.snapshot();
  const html = renderWebview({ version: '1.135.0', workspaceName: 'Loading test', nonce: 'settings-loading-test' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 780, height: 600 } });
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.settingsMessages = []; window.settingsVisibility = [];
      window.addEventListener('ubovm-settings-visibility', event => window.settingsVisibility.push(event.detail.open));
      window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: message => window.settingsMessages.push(message) });
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://settings.test/');
    const send = message => page.evaluate(message => window.postMessage(message, '*'), message);
    const lastRequest = () => page.evaluate(() => window.settingsMessages.filter(message => ['settingsRead', 'settingsSave'].includes(message.action)).at(-1));
    await send({ type: 'settingsLoading', page: 'settings', requestId: 'open-1' });
    await page.locator('#settings-skeleton').waitFor();
    assert.equal(await page.locator('#settings-form').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#settings-save').isDisabled(), true);
    await page.locator('#settings-close').click();
    await send({ type: 'openSettings', requestId: 'open-1', page: 'settings', data: snapshot });
    assert.equal(await page.locator('#settings-dialog').isVisible(), false, 'A late response must not reopen a closed panel.');

    await send({ type: 'settingsLoading', page: 'settings', requestId: 'open-2' });
    await send({ type: 'settingsLoadError', requestId: 'open-2', error: '读取失败' });
    await page.locator('#settings-load-error').waitFor();
    assert.equal(await page.locator('#settings-form').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#settings-save').isDisabled(), true);
    await page.locator('#settings-reload').click();
    const retry = await lastRequest();
    assert.equal(retry.action, 'settingsRead');
    await send({ type: 'settingsResult', requestId: retry.requestId, data: snapshot });
    await page.locator('#setting-modelId').waitFor();
    assert.equal(await page.locator('#settings-skeleton').isVisible(), false);
    assert.equal(await page.locator('#settings-save').isDisabled(), false);

    await page.locator('.settings-advanced summary').click();
    await page.evaluate(() => { window.modelControl = document.querySelector('#setting-modelId'); document.querySelector('#settings-form').scrollTop = 170; });
    const scroll = await page.locator('#settings-form').evaluate(form => form.scrollTop);
    await page.evaluate(() => document.querySelector('#settings-tab-reasonModel').click());
    await page.evaluate(() => document.querySelector('#settings-tab-model').click());
    assert.equal(await page.evaluate(() => document.querySelector('#setting-modelId') === window.modelControl), true, 'Returning to an unchanged tab should reuse its controls.');
    assert.equal(await page.locator('.settings-advanced').evaluate(details => details.open), true);
    assert.equal(await page.locator('#settings-form').evaluate(form => form.scrollTop), scroll);
    await page.locator('#settings-reload').click();
    const reload = await lastRequest();
    assert.equal(await page.locator('#settings-progress').isVisible(), true);
    assert.equal(await page.locator('#settings-fields').isVisible(), true, 'A refresh keeps existing fields visible.');
    await send({ type: 'settingsResult', requestId: reload.requestId, data: snapshot });
    await page.waitForFunction(() => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => document.querySelector('#setting-modelId') === window.modelControl), true, 'An unchanged snapshot should not recreate the form.');

    await page.locator('#setting-modelId').fill('updated-model');
    await page.locator('#setting-apiKey').fill('temporary-key');
    await page.locator('#setting-modelId').focus();
    await page.evaluate(() => { document.querySelector('#setting-modelId').setSelectionRange(2, 5); document.querySelector('#settings-form').requestSubmit(); });
    const failedSave = await lastRequest();
    assert.equal(await page.locator('#settings-form').getAttribute('aria-busy'), 'true');
    await send({ type: 'settingsResult', requestId: failedSave.requestId, error: '保存失败，请重试。' });
    await page.waitForFunction(() => document.querySelector('#settings-status').dataset.error === 'true');
    assert.equal(await page.locator('#setting-modelId').inputValue(), 'updated-model');
    assert.equal(await page.locator('#setting-apiKey').inputValue(), 'temporary-key');
    assert.equal(await page.locator('#setting-modelId').evaluate(control => control === document.activeElement && control.selectionStart === 2 && control.selectionEnd === 5), true);
    await page.evaluate(() => document.querySelector('#settings-form').requestSubmit());
    const save = await lastRequest();
    const saved = await service.save(save.section, save.value, save.revision);
    await send({ type: 'settingsResult', requestId: save.requestId, data: saved, saved: true });
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent.startsWith('已保存'));
    assert.equal(await page.locator('#setting-apiKey').inputValue(), '', 'Successful save clears plaintext credentials from the form.');
    assert.equal(await page.locator('#setting-modelId').evaluate(control => control === document.activeElement && control.selectionStart === 2), true);
    await page.locator('#setting-modelId').fill('new-unsaved-edit');
    await send({ type: 'settingsResult', requestId: save.requestId, data: snapshot, saved: true });
    assert.equal(await page.locator('#setting-modelId').inputValue(), 'new-unsaved-edit', 'Duplicate results must not overwrite a later edit.');

    await send({ type: 'settingsLoading', page: 'mcp', requestId: 'open-3' });
    await send({ type: 'openSettings', page: 'mcp', requestId: 'open-3', data: saved });
    await page.locator('#settings-discard').waitFor();
    assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), 'settings');
    await page.locator('#settings-discard-confirm').click();
    await page.locator('#settings-add-mcp').waitFor();
    assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), 'mcp');
    await page.locator('#settings-close').click();
    assert.deepEqual(await page.evaluate(() => window.settingsVisibility), [true, false, true, false]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await send({ type: 'settingsLoading', page: 'skills', requestId: 'open-4' });
    assert.equal(await page.locator('#settings-progress > span').evaluate(node => getComputedStyle(node).animationName), 'none');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
