import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const css = await readFile(new URL('../../workbench/workbench.css', import.meta.url), 'utf8');
  const patch = await readFile(new URL('../../../../resources/patches/sidebar-mode.patch', import.meta.url), 'utf8');
  const script = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)).filter(line => !line.includes('height = Math.max')).join('\n')
    .replace(/: KeyboardEvent/g, '')
    .replace(/: HTMLButtonElement\[\]/g, '')
    .replace(/: boolean/g, '')
    .replace(/<HTMLElement, boolean>/g, '')
    .replace(/: globalThis\.Event/g, '')
    .replace(/: Event/g, '')
    .replace(/ as Node/g, '')
    .replace(/: number \| undefined/g, '');
  await page.setContent(`<style>${css}#sessions{width:300px;height:640px}.monaco-workbench{position:relative;width:900px;height:640px}.pane{width:300px;height:100%}.part.editor{position:absolute;left:300px;right:0;top:0;bottom:0}</style><div class="monaco-workbench"><div class="pane"><div id="sessions" class="pane-body"><div class="tree-explorer-viewlet-tree-view"><div class="message">There is no data provider registered that can provide view data.</div><button id="existing-session">已读取的会话</button></div></div></div><div class="part editor"></div></div>`);
  await page.evaluate(script => {
    const callbacks = [], disposables = [];
    window.values = {};
    window.commands = [];
    const timeout = window.setTimeout;
    window.slowArms = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 12000) { window.fireSlow = callback; window.slowArms++; return -1; }
      return timeout(callback, delay, ...args);
    };
    const toolbar = document.createElement('div'); toolbar.className = 'title-actions';
    toolbar.innerHTML = '<button id="native-new">新建会话</button>';
    document.querySelector('.pane').prepend(toolbar);
    window.updateContext = values => { Object.assign(window.values, values); callbacks.forEach(callback => callback({ affectsSome: () => true })); };
    const pane = { id: 'ubovm.sessions', _register(value) { disposables.push(value); }, openerService: { async open(uri) { window.commands.push(uri); if (window.failReload) throw Error('reload failed'); } }, contextKeyService: {
      getContextKeyValue: key => window.values[key],
      onDidChangeContext: callback => { callbacks.push(callback); return { dispose() {} }; }
    } };
    window.mountNavigation = () => new Function('container', script).call(pane, document.getElementById('sessions'));
    window.mountNavigation();
    window.firstSlow = window.fireSlow;
    window.disposeNavigation = () => disposables.forEach(value => value.dispose());
  }, script);
  assert.equal(await page.locator('.message').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.equal(await page.locator('.ubovm-session-loading').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'sidebar recovery stays behind the cold-start shell mask');
  assert.equal(await page.locator('#existing-session').isVisible(), false, 'session rows stay hidden until ready');
  assert.equal(await page.locator('.title-actions').isVisible(), false, 'pane title actions stay hidden until ready');
  assert.equal(await page.locator('[data-mode="goal"]').isDisabled(), true, 'mode chrome may exist but must stay locked');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '1');
  assert.match(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').content), /准备工作环境/);
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'ubovm-shell-progress');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationDuration), '0.9s');
  assert.equal(await page.locator('.part.editor').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'editor loading stays inside the webview after shell unlock');
  await page.evaluate(() => {
    document.getElementById('sessions').classList.remove('ubovm-sessions-body');
    document.documentElement.classList.add('ubovm-shell-loading');
  });
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '1', 'shell loading must show immediately after splash, before sessions-body');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'ubovm-shell-progress');
  await page.evaluate(() => document.getElementById('sessions').classList.add('ubovm-sessions-body'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationPlayState), 'paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    window.dispatchEvent(new Event('pageshow'));
  });
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationPlayState), 'paused', 'pageshow cannot resume a hidden window');
  await page.evaluate(() => {
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationPlayState), 'running');
  await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist' }));
  assert.equal(await page.locator('[data-mode="goal"]').isDisabled(), true, 'mode data alone must not unlock navigation');
  assert.equal(await page.locator('[data-settings-page="settings"]').isDisabled(), true);
  assert.equal(await page.locator('.tree-explorer-viewlet-tree-view').evaluate(el => el.inert), true);
  assert.equal(await page.locator('.title-actions').evaluate(el => el.inert), true);
  await page.evaluate(() => {
    window.treeActions = 0;
    const button = document.createElement('button'); button.id = 'late-session'; button.textContent = '会话';
    button.style.cssText = 'position:absolute;top:60px;left:18px';
    button.addEventListener('click', () => window.treeActions++);
    button.addEventListener('keydown', () => window.treeActions++);
    document.getElementById('sessions').append(button);
  });
  assert.equal(await page.locator('#late-session').evaluate(el => el.inert), true);
  assert.equal(await page.locator('#late-session').isVisible(), false, 'late-arriving rows must not flash before readiness');
  await page.evaluate(() => {
    document.querySelector('[data-mode="goal"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector('[data-settings-page="settings"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('late-session').click();
    document.getElementById('late-session').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.getElementById('late-session').focus();
  });
  assert.deepEqual(await page.evaluate(() => ({ commands: window.commands.length, actions: window.treeActions, focused: document.activeElement.id === 'late-session' })), { commands: 0, actions: 0, focused: false });
  await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist', 'ubovm.contentReady': true }));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.ubovm-session-loading').isVisible(), false);
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '0');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-shell-loading')), false, 'ready must clear the splash handoff class');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-shell-ready')), true, 'first paint sticks the sessions sidebar unlock');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'ready components must stop animating');
  assert.equal(await page.locator('[data-mode="goal"]').isEnabled(), true);
  for (const selector of ['#existing-session', '.ubovm-sidebar-modes', '.ubovm-sidebar-management', '.title-actions']) {
    assert.equal(await page.locator(selector).isVisible(), true, 'complete sidebar content must be revealed: ' + selector);
  }
  assert.equal(await page.locator('#late-session').evaluate(el => el.inert), false);
  assert.equal(await page.locator('.title-actions').evaluate(el => el.inert), false);
  await page.locator('#late-session').click();
  assert.equal(await page.evaluate(() => window.treeActions), 1);
  const armsAfterReady = await page.evaluate(() => window.slowArms);
  await page.evaluate(() => {
    window.updateContext({ 'ubovm.contentReady': false });
    window.firstSlow();
  });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-slow')), false, 'an old timeout cannot expire a new loading cycle');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-shell-ready')), true, 'conversation switch keeps shell-ready');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-ready')), false, 'conversation switch re-locks main content only');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '0', 'session switch must not re-cover the shell');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'session switch leaves shell progress off');
  assert.equal(await page.locator('#existing-session').isVisible(), true, 'sidebar rows stay painted while the conversation reloads');
  assert.equal(await page.locator('[data-mode="goal"]').isEnabled(), true, 'sidebar navigation stays usable during conversation switch');
  assert.equal(await page.locator('#late-session').evaluate(el => el.inert), false, 'session tree stays interactive during conversation switch');
  assert.equal(await page.evaluate(() => window.slowArms), armsAfterReady, 'session switch must not arm another sidebar recovery timer');
  await page.evaluate(() => window.fireSlow());
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-slow')), false, 'stale cold-start timers cannot revive after shell unlock');
  await page.evaluate(() => window.updateContext({ 'ubovm.contentReady': true }));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-ready')), true);
  await page.evaluate(() => {
    document.documentElement.classList.remove('ubovm-shell-ready', 'ubovm-content-ready');
    window.updateContext({ 'ubovm.contentReady': false });
  });
  assert.equal(await page.evaluate(() => window.slowArms), armsAfterReady + 1, 'a fresh cold start arms recovery again');
  await page.evaluate(() => window.fireSlow());
  assert.equal(await page.locator('[data-mode="goal"]').isDisabled(), true, 'slow loading must not unlock navigation');
  assert.equal(await page.locator('#existing-session').isVisible(), false, 'recovery timeout must not reveal incomplete content');
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'slow loading exposes recovery instead of an endless spinner');
  assert.equal(await page.locator('.ubovm-session-loading').evaluate(el => getComputedStyle(el).visibility), 'visible', 'slow recovery surfaces above the cold-start mask');
  await page.evaluate(() => { window.failReload = true; });
  await page.locator('.ubovm-session-loading button').click();
  assert.match(await page.locator('.ubovm-session-loading').textContent(), /重新加载未成功/);
  assert.equal(await page.locator('.ubovm-session-loading button').isEnabled(), true);
  await page.evaluate(() => { window.failReload = false; });
  await page.locator('.ubovm-session-loading button').click();
  assert.equal(await page.evaluate(() => window.commands.at(-1)), 'command:workbench.action.reloadWindow');
  await page.evaluate(() => window.updateContext({ 'ubovm.contentReady': true }));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-slow')), false);
  await page.evaluate(() => window.updateContext({ 'ubovm.contentReady': false }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').transitionDuration), '0s');
  await page.evaluate(() => window.disposeNavigation());
  await page.evaluate(() => window.fireSlow());
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-content-slow')), false, 'disposed timeouts must not revive a loading error');
  assert.equal(await page.locator('#late-session').evaluate(el => el.inert), false);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-loading-paused')), false, 'disposed listeners must not alter a replacement page');
  const arms = await page.evaluate(() => window.slowArms);
  await page.evaluate(() => {
    document.getElementById('sessions').replaceChildren();
    document.documentElement.classList.remove('ubovm-shell-ready', 'ubovm-content-ready');
    document.documentElement.classList.add('ubovm-content-slow');
    window.mountNavigation();
  });
  assert.equal(await page.locator('.ubovm-session-loading button').isVisible(), true, 'a rebuilt sidebar must retain its recovery action');
  assert.match(await page.locator('.ubovm-session-loading').textContent(), /加载时间较长/);
  assert.equal(await page.evaluate(() => window.slowArms), arms, 'known slow loading must not wait another timeout');
  await page.evaluate(() => window.disposeNavigation());
  console.log('PASS: native startup frame, separated shell/sidebar unlock, first-content handoff');
} finally { await browser.close(); }
