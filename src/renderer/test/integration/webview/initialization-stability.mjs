import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { createSettingsConfiguration } = require('../../../harness/config/settings-config.cjs');
const { renderWebview } = require('../../../host/ui/webview.cjs');

test('initialization rendering and request recovery remain isolated and repeatable', async t => {
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
  const snapshot = await service.snapshot({ includeSkills: false });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  async function setup(t) {
    const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
    t.after(() => page.close());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => {
        if (window.failAction === message.action) throw Error('配置通信暂时不可用');
        if (message.action === 'settingsNavigation' && window.failNavigationCount > 0) { window.failNavigationCount--; throw Error('navigation bridge unavailable'); }
        window.sent.push(message);
      } });
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://initialization-stability.test/');
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const open = async (data = snapshot) => {
      await send({ type: 'openSettings', page: 'initialize', data });
      await page.locator('#settings-dialog').waitFor();
    };
    const last = action => page.evaluate(action => window.sent.findLast(message => message.action === action), action);
    const result = async (request, data = snapshot, extra = {}) => send({ type: 'settingsResult', requestId: request.requestId, ok: true, data, ...extra });
    return { page, errors, send, open, last, result };
  }
  try {
    await t.test('initial setup acknowledges painted content only after successful visible rendering', async t => {
      const { page, open, last, send } = await setup(t);
      const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      await send({ type: 'settingsLoading', page: 'initialize', requestId: 'initial-paint' });
      await frames(); assert.equal(await last('contentReady'), undefined, 'a skeleton is not ready');
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await open(); await frames();
      assert.equal(await last('contentReady'), undefined, 'suspended pages cannot unlock navigation');
      await page.evaluate(() => { window.failAction = 'contentReady'; window.dispatchEvent(new Event('pageshow')); });
      await frames(); assert.equal(await last('contentReady'), undefined);
      await page.evaluate(() => { window.failAction = ''; window.dispatchEvent(new Event('pageshow')); });
      await frames(); assert(await last('contentReady'));
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow'))); await frames();
      assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'contentReady').length), 1);
    });

    await t.test('malformed initial data does not crash the app and reload recovers', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open({ revision: 'bad', initialization: { complete: true } });
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      assert.equal(await page.locator('#settings-finish').isDisabled(), true);
      assert.equal(await page.locator('#settings-load-error').isVisible(), true);
      assert(await last('ready'), 'the main page handshake remains operational');
      await page.locator('#settings-reload').click();
      await result(await last('settingsRead'));
      await page.locator('[data-setting="modelId"]').waitFor();
      assert.equal(await page.locator('#settings-load-error').isVisible(), false);
      assert.deepEqual(errors, []);
    });

    await t.test('repeated component failures retry locally without partial forms or host reads', async t => {
      const { page, errors, open, last } = await setup(t);
      await page.evaluate(() => {
        const create = document.createElement.bind(document); window.failInputs = 2;
        document.createElement = (...args) => {
          if (args[0] === 'input' && window.failInputs-- > 0) throw Error('injected rendering failure');
          return create(...args);
        };
      });
      await open();
      assert.equal(await page.locator('#settings-render-retry').isVisible(), true);
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      assert.equal(await page.locator('#settings-fields').evaluate(node => node.inert), true);
      await page.locator('#settings-render-retry').click();
      assert.equal(await page.locator('#settings-render-retry').isVisible(), true);
      await page.locator('#settings-render-retry').click();
      assert.equal(await page.locator('[data-setting="modelId"]').count(), 1);
      assert.equal(await page.locator('#settings-save').isEnabled(), true);
      assert.equal(await page.locator('#settings-fields').evaluate(node => node.inert), false);
      assert.equal(await page.locator('#settings-render-retry').isVisible(), false);
      assert.equal(await last('settingsRead'), undefined);
      assert.deepEqual(errors, []);
    });

    await t.test('same-step rebuild failure retains previous controls until a successful local retry', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open();
      await page.evaluate(() => {
        window.originalModelControl = document.querySelector('[data-setting="modelId"]');
        const create = document.createElement.bind(document); let once = true;
        document.createElement = (...args) => {
          if (once && args[0] === 'input') { once = false; throw Error('rebuild failed'); }
          return create(...args);
        };
      });
      await page.locator('#settings-reload').click();
      const updated = structuredClone(snapshot); updated.values.model.modelId = 'updated-model';
      await result(await last('settingsRead'), updated);
      assert.equal(await page.evaluate(() => window.originalModelControl === document.querySelector('[data-setting="modelId"]')), true);
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      await page.locator('#settings-render-retry').click();
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'updated-model');
      assert.equal(await page.locator('[data-setting="modelId"]').count(), 1);
      assert.equal(await page.locator('#settings-save').isEnabled(), true);
      assert.deepEqual(errors, []);
    });

    await t.test('discarded drafts stay discarded after reload failure and invalid save responses retain edits', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open();
      const original = await page.locator('[data-setting="modelId"]').inputValue();
      await page.locator('[data-setting="modelId"]').fill('discard-me');
      await page.locator('[data-setting="apiKey"]').fill('discarded-secret');
      await page.locator('#settings-reload').click();
      await page.locator('#settings-discard-confirm').click();
      await result(await last('settingsRead'), undefined, { ok: false, error: 'read unavailable' });
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), original);
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), '');
      await page.locator('[data-setting="modelId"]').fill('retain-me');
      await page.locator('[data-setting="apiKey"]').fill('retained-secret');
      await page.locator('#settings-save').click();
      await result(await last('settingsSave'), { revision: 'invalid' });
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'retain-me');
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), 'retained-secret');
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      assert.deepEqual(errors, []);
    });

    await t.test('a timed-out read ignores late success and a fresh read can recover', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open();
      await page.evaluate(() => {
        const schedule = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 30000) window.expireSettings = () => callback(...args);
          return schedule(callback, delay, ...args);
        };
      });
      await page.locator('#settings-reload').click();
      const expired = await last('settingsRead');
      await page.evaluate(() => window.expireSettings());
      assert.equal(await page.locator('#settings-reload').isEnabled(), true);
      await result(expired, { revision: 'late-invalid' });
      assert.match(await page.locator('#settings-status').textContent(), /超时/);
      await page.locator('#settings-reload').click();
      const current = await last('settingsRead');
      assert.notEqual(expired.requestId, current.requestId);
      await result(current);
      assert.equal(await page.locator('#settings-save').isEnabled(), true);
      assert.equal(await page.locator('#settings-load-error').isVisible(), false);
      assert.deepEqual(errors, []);
    });

    await t.test('identical immutable snapshots preserve input identity and avoid heading repaint churn', async t => {
      const { page, errors, open } = await setup(t);
      await open();
      const measurements = await page.evaluate(snapshot => {
        snapshot.browserInstallation = { state: 'missing' }; Object.freeze(snapshot);
        const model = document.querySelector('[data-setting="modelId"]'); model.focus(); model.setSelectionRange(1, 3);
        const fields = document.querySelector('#settings-fields'), nodes = fields.querySelectorAll('*').length;
        const observer = new MutationObserver(() => {});
        for (const id of ['settings-title', 'settings-section-title', 'settings-section-kicker', 'settings-description']) observer.observe(document.getElementById(id), { childList: true, subtree: true });
        for (let index = 0; index < 100; index++) {
          document.querySelector('#settings-reload').click();
          const request = window.sent.findLast(message => message.action === 'settingsRead');
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingsResult', requestId: request.requestId, ok: true, data: snapshot } }));
        }
        const mutations = observer.takeRecords().length; observer.disconnect();
        return { mutations, identity: model === document.querySelector('[data-setting="modelId"]'), focus: document.activeElement === model,
          selection: [model.selectionStart, model.selectionEnd], growth: fields.querySelectorAll('*').length - nodes,
          error: !document.querySelector('#settings-load-error').hidden, immutable: Boolean(snapshot.browserInstallation) };
      }, snapshot);
      assert.deepEqual(measurements, { mutations: 0, identity: true, focus: true, selection: [1, 3], growth: 0, error: false, immutable: true });
      assert.deepEqual(errors, []);
    });

    await t.test('inconsistent completion metadata cannot close initialization', async t => {
      const { page, errors, open, last, result } = await setup(t);
      const complete = structuredClone(snapshot);
      complete.initialization = { model: true, ssh: true, complete: true };
      complete.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf' }] };
      await open(complete);
      await page.locator('#settings-finish').click();
      const inconsistent = structuredClone(complete); inconsistent.initialization.model = false;
      await result(await last('settingsRead'), inconsistent);
      assert.equal(await page.locator('#settings-dialog').isVisible(), true);
      assert.match(await page.locator('#settings-status').textContent(), /初始化状态无效/);
      assert.equal(await page.locator('#settings-finish').isEnabled(), true);
      await page.locator('#settings-finish').click();
      inconsistent.initialization.complete = false;
      await result(await last('settingsRead'), inconsistent);
      assert.equal(await page.locator('#settings-finish').isDisabled(), true);
      assert.equal(await page.locator('[data-setup-step="model"]').getAttribute('aria-current'), 'step');
      assert.deepEqual(errors, []);
    });

    await t.test('the compact initialization form retains existing model profile identity when saving edits', async t => {
      const { page, errors, open, last } = await setup(t);
      const existing = structuredClone(snapshot);
      existing.modelProfiles = [{ id: 'existing-model', name: '现有模型', model: structuredClone(existing.values.model), secretState: { apiKey: true } }];
      await open(existing);
      assert.equal(await page.locator('.settings-model-library').count(), 0);
      assert.equal(await page.locator('[data-cooperation-guide]').count(), 0);
      await page.locator('[data-setting="modelId"]').fill('edited-model');
      await page.locator('#settings-save').click();
      const request = await last('settingsSave');
      assert.equal(request.value.profile.id, 'existing-model');
      assert.equal(request.value.profile.name, '现有模型');
      assert.equal(request.value.modelId, 'edited-model');
      assert.deepEqual(errors, []);
    });

    await t.test('invalid navigation cannot bind existing model inputs to another settings group', async t => {
      const { page, errors, open, send, last } = await setup(t);
      await open();
      await send({ type: 'openSettings', page: 'mcp', data: { revision: 'bad', sections: {}, values: {}, secretState: {} } });
      assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), 'initialize');
      assert.equal(await page.locator('#settings-title').textContent(), '首次初始化');
      await page.locator('[data-setting="modelId"]').fill('still-model');
      await page.locator('#settings-save').click();
      assert.equal((await last('settingsSave')).section, 'model');
      assert.deepEqual(errors, []);
    });

    await t.test('failed navigation publication is retried when the local view recovers', async t => {
      const { page, errors, open } = await setup(t);
      await page.evaluate(() => { window.failNavigationCount = 1; });
      await open();
      assert.equal(await page.locator('#settings-render-retry').isVisible(), true);
      await page.locator('#settings-render-retry').click();
      const navigation = await page.evaluate(() => window.sent.filter(message => message.action === 'settingsNavigation'));
      assert.equal(navigation.length, 1);
      assert.equal(navigation[0].page, 'initialize');
      assert.equal(navigation[0].section, 'model');
      assert.equal(await page.locator('#settings-save').isEnabled(), true);
      assert.deepEqual(errors, []);
    });
    await t.test('cached SSH cards receive results and edits invalidate verification', async t => {
      const { page, errors, open, send, last } = await setup(t);
      const complete = structuredClone(snapshot);
      complete.initialization = { model: true, ssh: true, complete: true };
      complete.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf', port: 22 }] };
      await open(complete);
      await page.locator('[data-setup-step="ssh"]').click();
      await page.locator('.settings-ssh-test').click();
      const request = await last('settingsTestSSH');
      await page.locator('[data-setup-step="model"]').click();
      await send({ type: 'settingsSSHTestResult', requestId: request.requestId, ok: true, message: '连接成功', durationMs: 10 });
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('.settings-ssh-test').isEnabled(), true);
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /连接成功/);
      await page.locator('[data-setting="host"]').fill('192.0.2.21');
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /配置已更改，请重新测试/);
      assert.equal(await page.evaluate(() => {
        const observer = new MutationObserver(() => {});
        observer.observe(document.querySelector('.settings-ssh-identity'), { subtree: true, childList: true, characterData: true });
        const input = document.querySelector('[data-setting="host"]');
        for (let index = 0; index < 100; index++) input.dispatchEvent(new Event('input', { bubbles: true }));
        const count = observer.takeRecords().length; observer.disconnect(); return count;
      }), 0);
      assert.deepEqual(errors, []);
    });

    await t.test('uncertain saves block repeated writes until a fresh snapshot arrives', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open();
      await page.locator('[data-setting="modelId"]').fill('pending-model');
      await page.evaluate(() => {
        const original = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 30000) window.expireSettings = () => callback(...args);
          return original(callback, delay, ...args);
        };
      });
      await page.locator('#settings-save').click();
      const expired = await last('settingsSave');
      await page.evaluate(() => window.expireSettings());
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      assert.match(await page.locator('#settings-save').textContent(), /确认保存状态/);
      await page.evaluate(() => document.querySelector('#settings-save').form.dispatchEvent(new Event('submit', { cancelable: true })));
      assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'settingsSave').length), 1);
      await result(expired);
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      await page.locator('#settings-reload').click();
      await page.locator('#settings-discard-confirm').click();
      await result(await last('settingsRead'), undefined, { ok: false, error: '暂时无法读取' });
      assert.equal(await page.locator('#settings-save').isDisabled(), true);
      await page.locator('#settings-reload').click();
      await result(await last('settingsRead'));
      assert.equal(await page.locator('#settings-save').isEnabled(), true);
      assert.deepEqual(errors, []);
    });

    await t.test('resuming the optional step refreshes installer status without replacing drafts', async t => {
      const { page, errors, open } = await setup(t);
      const complete = structuredClone(snapshot);
      complete.initialization = { model: true, ssh: true, complete: true };
      complete.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf' }] };
      await open(complete);
      const observed = await page.evaluate(() => {
        const field = document.querySelector('#settings-fields input');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const before = window.sent.length;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
        window.testHidden = true; document.dispatchEvent(new Event('visibilitychange'));
        window.testHidden = false; document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
        return { actions: window.sent.slice(before).map(message => message.action).filter(action => action.startsWith('settings')), same: field === document.querySelector('#settings-fields input') };
      });
      assert.deepEqual(observed, { actions: ['settingsBrowserStatus'], same: true });
      await page.locator('[data-setup-step="model"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      assert.deepEqual(errors, []);
    });
    await t.test('saving supersedes discard navigation without allowing stale confirmation to clear drafts', async t => {
      const { page, errors, open, last, result } = await setup(t);
      await open();
      await page.locator('[data-setting="modelId"]').fill('retained-draft');
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await page.evaluate(() => document.querySelector('#settings-save').click());
      const request = await last('settingsSave');
      assert.equal(await page.locator('#settings-discard').isVisible(), false);
      await page.evaluate(() => document.querySelector('#settings-discard-confirm').click());
      await result(request, undefined, { ok: false, error: '暂时无法保存' });
      await page.evaluate(() => document.querySelector('#settings-discard-confirm').click());
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'retained-draft');
      assert.equal(await page.locator('[data-setup-step="model"]').getAttribute('aria-current'), 'step');
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await page.locator('#settings-discard-confirm').click();
      assert.equal(await page.locator('[data-setup-step="ssh"]').getAttribute('aria-current'), 'step');
      assert.deepEqual(errors, []);
    });

    await t.test('search credential typing avoids redundant mutations while transitions still update', async t => {
      const { page, errors, open } = await setup(t);
      await open();
      await page.locator('[data-setup-step="web"]').click();
      await page.locator('[data-setting="apiKey"]').fill('draft');
      const mutations = await page.evaluate(() => {
        const input = document.querySelector('[data-setting="apiKey"]'); input.focus();
        const observer = new MutationObserver(() => {});
        observer.observe(document.querySelector('#settings-fields'), { subtree: true, childList: true, attributes: true, characterData: true });
        for (let index = 0; index < 1000; index++) {
          input.value = 'draft-' + index; input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const count = observer.takeRecords().length; observer.disconnect(); return count;
      });
      assert.equal(mutations, 0);
      assert.match(await page.locator('#settings-fields').textContent(), /新凭据待保存/);
      await page.locator('[data-setting="apiKey"]').fill('');
      assert.doesNotMatch(await page.locator('#settings-fields').textContent(), /新凭据待保存/);
      await page.locator('[data-setting="apiKey"]').fill('new-draft');
      assert.match(await page.locator('#settings-fields').textContent(), /新凭据待保存/);
      assert.deepEqual(errors, []);
    });
    await t.test('installer watchdog follows snapshots and cannot overwrite a confirmed ready state', async t => {
      const { page, errors, open, send, last, result } = await setup(t);
      await page.evaluate(() => {
        const schedule = window.setTimeout, cancel = window.clearTimeout;
        window.installTimers = new Map();
        window.setTimeout = (callback, delay, ...args) => {
          const id = schedule(callback, delay, ...args);
          if (delay === 600000) window.installTimers.set(id, callback);
          return id;
        };
        window.clearTimeout = id => { window.installTimers.delete(id); cancel(id); };
        window.expireInstall = () => {
          const pending = [...window.installTimers];
          for (const [id, callback] of pending) { window.clearTimeout(id); callback(); }
        };
      });
      const installing = structuredClone(snapshot); installing.browserInstallation = { state: 'installing' };
      await open(installing);
      await page.locator('[data-setup-step="web"]').click();
      assert.equal(await page.evaluate(() => window.installTimers.size), 1);
      for (let index = 0; index < 3; index++) await send({ type: 'settingsBrowserStatus', installation: { state: 'installing' } });
      assert.equal(await page.evaluate(() => window.installTimers.size), 1);
      await page.evaluate(() => window.expireInstall());
      assert.equal(await page.locator('[data-install-browser]').isEnabled(), true);
      assert.match(await page.locator('[data-browser-install-status]').textContent(), /安装结果尚未返回/);
      await page.locator('[data-install-browser]').click();
      assert.equal(await page.evaluate(() => window.installTimers.size), 1);
      await page.locator('#settings-reload').click();
      const ready = structuredClone(snapshot); ready.browserInstallation = { state: 'ready' };
      await result(await last('settingsRead'), ready);
      assert.equal(await page.evaluate(() => window.installTimers.size), 0);
      await page.evaluate(() => window.expireInstall());
      assert.equal(await page.locator('[data-browser-badge]').textContent(), '已就绪');
      assert.equal(await page.locator('[data-install-browser]').isDisabled(), true);
      assert.deepEqual(errors, []);
    });

    await t.test('installer utility bridge failures remain recoverable without losing drafts', async t => {
      const { page, errors, open, last } = await setup(t);
      await open();
      await page.locator('[data-setup-step="web"]').click();
      await page.locator('[data-setting="apiKey"]').fill('retained-search-draft');
      for (const [action, label] of [['settingsBrowserStatus', '检查状态'], ['settingsBrowserLogs', '查看安装日志']]) {
        await page.evaluate(action => { window.failAction = action; }, action);
        await page.getByRole('button', { name: label, exact: true }).click();
        assert.match(await page.locator('#settings-status').textContent(), /通信暂时不可用/);
        await page.evaluate(() => { window.failAction = undefined; });
        await page.getByRole('button', { name: label, exact: true }).click();
        assert(await last(action));
      }
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), 'retained-search-draft');
      await page.locator('[data-setup-step="model"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      assert.deepEqual(errors, []);
    });
    await t.test('invalid deferred navigation never clears dirty inputs or leaves a stale discard action', async t => {
      const { page, errors, open, send } = await setup(t);
      await open();
      await page.locator('[data-setting="modelId"]').fill('protected-model');
      await page.locator('[data-setting="apiKey"]').fill('protected-secret');
      await send({ type: 'settingsLoading', requestId: 'deferred-open', page: 'mcp' });
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await send({ type: 'openSettings', requestId: 'deferred-open', page: 'mcp', data: { revision: 'invalid' } });
      assert.equal(await page.locator('#settings-discard').isVisible(), false);
      await page.evaluate(() => document.querySelector('#settings-discard-confirm').click());
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), 'protected-secret');
      assert.equal(await page.locator('#settings-dialog').getAttribute('data-page'), 'initialize');
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await page.locator('#settings-keep').click();
      await send({ type: 'openSettings', page: 'mcp', data: { revision: 'invalid-direct' } });
      assert.equal(await page.locator('#settings-discard').isVisible(), false);
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'protected-model');
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await page.locator('#settings-discard-confirm').click();
      assert.equal(await page.locator('[data-setup-step="ssh"]').getAttribute('aria-current'), 'step');
      assert.deepEqual(errors, []);
    });
    await t.test('unsolicited invalid navigation cannot interrupt an active save', async t => {
      const { page, errors, open, send, last, result } = await setup(t);
      await open();
      await page.locator('[data-setting="modelId"]').fill('saving-model');
      await page.locator('#settings-save').click();
      const request = await last('settingsSave');
      await send({ type: 'openSettings', page: 'mcp', data: { revision: 'invalid' } });
      assert.equal(await page.locator('#settings-dialog').getAttribute('data-operation'), 'save');
      assert.equal(await page.locator('#settings-fields').evaluate(node => node.inert), true);
      const saved = structuredClone(snapshot); saved.values.model.modelId = 'saving-model'; saved.initialization.model = true;
      await result(request, saved, { saved: true });
      assert.equal(await page.locator('[data-setup-step="ssh"]').getAttribute('aria-current'), 'step');
      assert.equal(await page.locator('#settings-fields').evaluate(node => node.inert), false);
      assert.deepEqual(errors, []);
    });
    await t.test('SSH verification follows configuration revisions across cached steps and late results', async t => {
      const { page, errors, open, send, last, result } = await setup(t);
      const configured = structuredClone(snapshot);
      configured.initialization = { model: true, ssh: true, complete: true };
      configured.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf', port: 22, secretState: { password: true } }] };
      await open(configured);
      await page.locator('[data-setup-step="ssh"]').click();
      await page.evaluate(() => { window.sshCard = document.querySelector('.settings-ssh-profile'); });
      await page.locator('.settings-ssh-test').click();
      await send({ type: 'settingsSSHTestResult', requestId: (await last('settingsTestSSH')).requestId, ok: true, message: '连接成功' });
      await page.locator('#settings-reload').click();
      await result(await last('settingsRead'), configured);
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /连接成功/);
      await page.locator('[data-setup-step="model"]').click();
      await page.locator('#settings-reload').click();
      const updated = structuredClone(configured); updated.revision += '-credentials-updated';
      await result(await last('settingsRead'), updated);
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.evaluate(() => window.sshCard === document.querySelector('.settings-ssh-profile')), true);
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /已保存配置发生变化/);
      await page.locator('.settings-ssh-test').click();
      const pending = await last('settingsTestSSH');
      await page.locator('[data-setup-step="model"]').click();
      await page.locator('#settings-reload').click();
      updated.revision += '-again';
      await result(await last('settingsRead'), updated);
      await send({ type: 'settingsSSHTestResult', requestId: pending.requestId, ok: true, message: '过期的成功结果' });
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('.settings-ssh-test').isEnabled(), true);
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /已保存配置发生变化/);
      assert.doesNotMatch(await page.locator('.settings-ssh-test-status').textContent(), /过期的成功/);
      await page.locator('.settings-ssh-test').click();
      await send({ type: 'settingsSSHTestResult', requestId: (await last('settingsTestSSH')).requestId, ok: true, message: '最新连接成功' });
      assert.match(await page.locator('.settings-ssh-test-status').textContent(), /最新连接成功/);
      assert.deepEqual(errors, []);
    });
    await t.test('first-load retry resumes incomplete setup while preserving an explicitly chosen step', async t => {
      const { page, errors, send, last, result } = await setup(t);
      const modelReady = structuredClone(snapshot); modelReady.initialization.model = true;
      for (const chosen of [undefined, 'web']) {
        const id = 'failed-initial-load-' + (chosen || 'automatic');
        await send({ type: 'settingsLoading', requestId: id, page: 'initialize', section: chosen });
        await send({ type: 'settingsLoadError', requestId: id, error: 'initial read unavailable' });
        assert.equal(await page.locator('#settings-reload').isEnabled(), true);
        await send({ type: 'openSettings', requestId: id, data: modelReady });
        assert.equal(await page.locator('#settings-load-error').isVisible(), true);
        await page.locator('#settings-reload').click();
        await result(await last('settingsRead'), modelReady);
        assert.equal(await page.locator('[data-setup-step="' + (chosen || 'ssh') + '"]').getAttribute('aria-current'), 'step');
        assert.equal(await page.locator('#settings-load-error').isVisible(), false);
        await page.locator('#settings-close').click();
      }
      await send({ type: 'settingsLoading', requestId: 'explicit-during-load', page: 'initialize' });
      await send({ type: 'settingsSection', section: 'web' });
      await send({ type: 'settingsLoadError', requestId: 'explicit-during-load', error: 'read failed' });
      await page.locator('#settings-reload').click();
      await result(await last('settingsRead'), modelReady);
      assert.equal(await page.locator('[data-setup-step="web"]').getAttribute('aria-current'), 'step');
      assert.deepEqual(errors, []);
    });
    await t.test('timed-out initial opens ignore late data and retry directly to optional tools when ready', async t => {
      const { page, errors, send, last, result } = await setup(t);
      await page.evaluate(() => {
        const schedule = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 30000) window.expireInitialOpen = () => callback(...args);
          return schedule(callback, delay, ...args);
        };
      });
      await send({ type: 'settingsLoading', requestId: 'initial-timeout', page: 'initialize' });
      await page.evaluate(() => window.expireInitialOpen());
      assert.match(await page.locator('#settings-load-error').textContent(), /超时/);
      await send({ type: 'openSettings', requestId: 'initial-timeout', data: { revision: 'late-invalid' } });
      assert.match(await page.locator('#settings-load-error').textContent(), /超时/);
      await page.locator('#settings-reload').click();
      const complete = structuredClone(snapshot);
      complete.initialization = { model: true, ssh: true, complete: true };
      complete.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf' }] };
      await result(await last('settingsRead'), complete);
      assert.equal(await page.locator('[data-setup-step="web"]').getAttribute('aria-current'), 'step');
      assert.equal(await page.locator('#settings-finish').isEnabled(), true);
      assert.deepEqual(errors, []);
    });
    await t.test('discarding an SSH draft releases its pending timer and ignores the late result', async t => {
      const { page, errors, open, send, last } = await setup(t);
      await open();
      await page.locator('[data-setup-step="ssh"]').click();
      await page.locator('[data-setting="host"]').fill('192.0.2.20');
      await page.locator('[data-setting="username"]').fill('ctf');
      await page.evaluate(() => {
        const schedule = window.setTimeout, cancel = window.clearTimeout;
        window.sshTimers = new Set();
        window.setTimeout = (callback, delay, ...args) => { const id = schedule(callback, delay, ...args); if (delay === 35000) window.sshTimers.add(id); return id; };
        window.clearTimeout = id => { window.sshTimers.delete(id); cancel(id); };
      });
      await page.locator('.settings-ssh-test').click();
      const pending = await last('settingsTestSSH');
      assert.equal(await page.evaluate(() => window.sshTimers.size), 1);
      await page.locator('[data-setup-step="model"]').click();
      await page.locator('#settings-discard-confirm').click();
      assert.equal(await page.evaluate(() => window.sshTimers.size), 0);
      await send({ type: 'settingsSSHTestResult', requestId: pending.requestId, ok: true, message: 'discarded result' });
      await page.locator('[data-setup-step="ssh"]').click();
      assert.equal(await page.locator('[data-setting="host"]').inputValue(), '');
      assert.equal(await page.locator('.settings-ssh-test-status').textContent(), '');
      assert.deepEqual(errors, []);
    });

    await t.test('continuing an edit restores its caret and Escape dismisses the discard prompt first', async t => {
      const { page, errors, open, send } = await setup(t);
      await open();
      await page.locator('[data-setting="modelId"]').fill('keep-this-selection');
      await page.evaluate(() => {
        const input = document.querySelector('[data-setting="modelId"]'); input.focus(); input.setSelectionRange(2, 7);
        window.editScroll = document.querySelector('#settings-form').scrollTop;
      });
      await send({ type: 'settingsSection', section: 'ssh' });
      await page.locator('#settings-keep').click();
      const state = () => page.evaluate(() => {
        const input = document.querySelector('[data-setting="modelId"]');
        return { focused: document.activeElement === input, selection: [input.selectionStart, input.selectionEnd], scroll: document.querySelector('#settings-form').scrollTop === window.editScroll };
      });
      assert.deepEqual(await state(), { focused: true, selection: [2, 7], scroll: true });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-discard').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-discard').isVisible(), false);
      assert.equal(await page.locator('#settings-dialog').isVisible(), true);
      assert.deepEqual(await state(), { focused: true, selection: [2, 7], scroll: true });
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), 'keep-this-selection');
      assert.deepEqual(errors, []);
    });
    await t.test('failed close navigation keeps the panel usable and discarded drafts stay discarded', async t => {
      const { page, errors, open } = await setup(t);
      await open();
      const original = await page.locator('[data-setting="modelId"]').inputValue();
      await page.evaluate(() => {
        window.originalInput = document.querySelector('[data-setting="modelId"]');
        window.failAction = 'settingsNavigation';
        window.closedEvents = 0;
        window.addEventListener('ubovm-settings-visibility', event => { if (!event.detail.open) window.closedEvents++; });
      });
      await page.locator('#settings-close').click();
      assert.equal(await page.locator('#settings-dialog').isVisible(), true);
      assert.equal(await page.evaluate(() => window.originalInput === document.querySelector('[data-setting="modelId"]')), true);
      assert.match(await page.locator('#settings-status').textContent(), /通信暂时不可用/);
      await page.locator('[data-setting="modelId"]').fill('discard-on-close');
      await page.locator('[data-setting="apiKey"]').fill('discard-secret');
      await page.locator('#settings-close').click();
      await page.locator('#settings-discard-confirm').click();
      assert.equal(await page.locator('#settings-dialog').isVisible(), true);
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), original);
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), '');
      assert.equal(await page.evaluate(() => window.closedEvents), 0);
      await page.evaluate(() => { window.failAction = undefined; });
      await page.locator('#settings-close').click();
      assert.equal(await page.locator('#settings-dialog').isVisible(), false);
      assert.equal(await page.evaluate(() => window.closedEvents), 1);
      await open();
      assert.equal(await page.locator('[data-setting="modelId"]').inputValue(), original);
      assert.deepEqual(errors, []);
    });

    await t.test('completion can be retried after its close notification fails', async t => {
      const { page, errors, open, last, result } = await setup(t);
      const complete = structuredClone(snapshot);
      complete.initialization = { model: true, ssh: true, complete: true };
      complete.values.ssh = { defaultId: 'linux', profiles: [{ id: 'linux', host: '192.0.2.20', username: 'ctf' }] };
      await open(complete);
      await page.evaluate(() => { window.failAction = 'settingsNavigation'; });
      await page.locator('#settings-finish').click();
      await result(await last('settingsRead'), complete);
      assert.equal(await page.locator('#settings-dialog').isVisible(), true);
      assert.equal(await page.locator('#settings-finish').isEnabled(), true);
      assert.match(await page.locator('#settings-status').textContent(), /通信暂时不可用/);
      await page.evaluate(() => { window.failAction = undefined; });
      await page.locator('#settings-finish').click();
      await result(await last('settingsRead'), complete);
      assert.equal(await page.locator('#settings-dialog').isVisible(), false);
      assert.deepEqual(errors, []);
    });
    await t.test('repeated installer status preserves input and path selections without DOM churn', async t => {
      const { page, errors, open, send } = await setup(t);
      await open();
      await page.locator('[data-setup-step="web"]').click();
      await page.locator('[data-setting="apiKey"]').fill('retained-search-key');
      const installation = { state: 'ready', executablePath: 'C:/cache/chromium/chrome.exe' };
      await send({ type: 'settingsBrowserStatus', installation });
      await page.getByText('浏览器文件位置', { exact: true }).click();
      const observed = await page.evaluate(installation => {
        const input = document.querySelector('[data-setting="apiKey"]'); input.focus(); input.setSelectionRange(2, 8);
        const observer = new MutationObserver(() => {});
        observer.observe(document.querySelector('#settings-fields'), { subtree: true, childList: true, attributes: true, characterData: true });
        const repeat = () => { for (let index = 0; index < 200; index++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingsBrowserStatus', installation } })); };
        repeat();
        const inputState = { focus: document.activeElement === input, selection: [input.selectionStart, input.selectionEnd], value: input.value };
        const text = document.querySelector('[data-browser-location]').firstChild;
        const range = document.createRange(); range.setStart(text, 3); range.setEnd(text, 8);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const before = selection.toString(); repeat();
        const count = observer.takeRecords().length; observer.disconnect();
        return { count, inputState, sameNode: text === document.querySelector('[data-browser-location]').firstChild, selected: selection.toString() === before };
      }, installation);
      assert.deepEqual(observed, { count: 0, inputState: { focus: true, selection: [2, 8], value: 'retained-search-key' }, sameNode: true, selected: true });
      await send({ type: 'settingsBrowserStatus', installation: { state: 'missing' } });
      assert.equal(await page.locator('[data-install-browser]').isEnabled(), true);
      assert.equal(await page.locator('[data-browser-location]').isVisible(), false);
      await send({ type: 'settingsBrowserStatus', installation });
      assert.equal(await page.locator('[data-install-browser]').isDisabled(), true);
      assert.equal(await page.locator('[data-browser-location]').textContent(), installation.executablePath);
      assert.equal(await page.locator('[data-setting="apiKey"]').inputValue(), 'retained-search-key');
      assert.deepEqual(errors, []);
    });
  } finally { await browser.close(); }
});
