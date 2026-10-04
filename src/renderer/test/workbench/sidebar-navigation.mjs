import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const native = await readFile(new URL('../../../../vendor/vscode/src/vs/workbench/browser/parts/views/media/views.css', import.meta.url), 'utf8');
const custom = await readFile(new URL('../../workbench/workbench.css', import.meta.url), 'utf8');
const patch = await readFile(new URL('../../../../resources/patches/sidebar-mode.patch', import.meta.url), 'utf8');
const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1)).filter(line => !line.includes('height = Math.max'));
const blockStart = added.findIndex(line => /if \(this\.id === 'ubovm\.sessions'\)/.test(line));
let depth = 0, blockEnd = blockStart;
for (let index = blockStart; index < added.length; index++) {
  depth += (added[index].match(/{/g) || []).length;
  depth -= (added[index].match(/}/g) || []).length;
  blockEnd = index;
  if (index > blockStart && depth <= 0) break;
}
const script = added.slice(Math.max(0, blockStart), blockEnd + 1).join('\n')
  .replace(/globalThis\./g, '')
  .replace(/: KeyboardEvent/g, '').replace(/<HTMLElement, boolean>/g, '').replace(/: Event/g, '')
  .replace(/ as Node/g, '').replace(/: number \| undefined/g, '')
  .replace(/: HTMLButtonElement\[\]/g, '').replace(/: boolean/g, '');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  for (const styles of [native + custom, custom + native]) {
    await page.setContent(`<style>${styles}</style><div class="monaco-workbench"><div class="part sidebar"><div class="pane"><div id="sessions" class="pane-body welcome" style="width:240px;height:500px;overflow:hidden"><div class="welcome-view">Empty conversations</div><div class="tree-explorer-viewlet-tree-view">History</div></div></div></div></div>`);
    await page.evaluate(script => {
      const callbacks = [], disposables = [];
      window.values = {};
      window.commands = [];
      window.updateContext = values => { Object.assign(window.values, values); callbacks.forEach(callback => callback({ affectsSome: () => true })); };
      const pane = { id: 'ubovm.sessions', _register(value) { disposables.push(value); }, openerService: { async open(uri) { window.commands.push(uri); } }, contextKeyService: {
        getContextKeyValue: key => window.values[key],
        onDidChangeContext: callback => { callbacks.push(callback); return { dispose() {} }; }
      } };
      new Function('container', script).call(pane, document.getElementById('sessions'));
      window.disposeNavigation = () => disposables.forEach(item => item.dispose());
    }, script);
    const assist = page.locator('[data-mode="assist"]'), goal = page.locator('[data-mode="goal"]');
    assert(await assist.isVisible(), 'assist must remain visible while native welcome loads');
    assert(await goal.isVisible(), 'goal must remain visible while native welcome loads');
    assert(await assist.isDisabled(), 'loading only disables navigation');
    assert.equal(await page.locator('.ubovm-session-loading').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'cold-start shell mask owns startup feedback');
    assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '1', 'cold-start overlay covers sidebar and editor together');
    for (let i = 0; i < 12; i++) {
      await page.evaluate(i => {
        document.getElementById('sessions').classList.toggle('welcome', i % 2 === 0);
        window.updateContext({ 'ubovm.mode': i % 3 ? 'assist' : 'goal', 'ubovm.contentReady': true });
      }, i);
      assert(await assist.isVisible());
      assert(await goal.isVisible());
      assert.equal(await page.locator('.ubovm-session-loading').isVisible(), false);
      assert(await page.locator('.ubovm-sidebar-management').isVisible());
    }
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.monaco-workbench'), '::before').opacity === '0');
    await page.evaluate(() => window.updateContext({ 'ubovm.contentReady': false }));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ubovm-shell-ready')), true);
    assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '0', 'conversation switch must leave the sessions sidebar uncovered');
    assert(await assist.isEnabled(), 'mode controls stay usable while the conversation reloads');
    assert(await page.locator('.ubovm-sidebar-management').isVisible());
    await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist', 'ubovm.contentReady': true }));
    await page.evaluate(() => {
      const container = document.getElementById('sessions');
      container.classList.remove('welcome');
      const tree = container.querySelector('.tree-explorer-viewlet-tree-view');
      const last = document.createElement('button');
      last.textContent = '末尾会话'; last.style.cssText = 'position:absolute;bottom:0;left:0';
      tree.style.position = 'absolute'; tree.append(last); last.focus();
    });
    assert.equal(await page.locator('#sessions').evaluate(el => el.scrollTop), 0, 'focusing the native tree must not scroll mode controls out of the pane');
    assert(await assist.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
    await goal.click();
    assert((await page.evaluate(() => window.commands.at(-1))).startsWith('command:ubovm.setMode?'));
    for (const settingsPage of ['settings', 'mcp', 'skills', '']) {
      await page.evaluate(settingsPage => {
        window.commands = [];
        window.updateContext({ 'ubovm.mode': 'assist', 'ubovm.settingsPage': settingsPage });
      }, settingsPage);
      assert(await assist.isVisible());
      assert(await goal.isVisible());
      assert.equal(await assist.locator('.ubovm-mode-label').textContent(), '协助');
      assert.equal(await assist.getAttribute('aria-label'), settingsPage ? '协助模式（关闭配置后切换）' : '协助模式');
      assert(await assist.locator('.codicon-comment').count());
      assert(await goal.locator('.codicon-target').count());
      await goal.click();
      const commands = await page.evaluate(() => window.commands);
      assert.equal(commands.length, 1, 'settings must confirm closing before switching modes');
      assert(commands[0].startsWith(settingsPage ? 'command:ubovm.closeSettings?' : 'command:ubovm.setMode?'));
      assert.deepEqual(JSON.parse(decodeURIComponent(commands[0].split('?')[1])), ['goal']);
    }
    await page.evaluate(() => window.updateContext({ 'ubovm.settingsPage': 'settings' }));
    await assist.click();
    assert((await page.evaluate(() => window.commands.at(-1))).startsWith('command:ubovm.closeSettings?'));
    for (const height of [500, 90, 80, 60]) {
      await page.locator('#sessions').evaluate((el, height) => { el.style.height = height + 'px'; }, height);
      assert(await assist.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), `mode switch must not be covered at height ${height}`);
      assert(await page.locator('.ubovm-sidebar-management').evaluate(el => {
        const style = getComputedStyle(el);
        const nav = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const inside = buttons.length === 3 && buttons.every(box => box.left >= nav.left - 0.5 && box.right <= nav.right + 0.5 && box.top >= nav.top - 0.5 && box.bottom <= nav.bottom + 0.5);
        const even = Math.max(...buttons.map(box => box.width)) - Math.min(...buttons.map(box => box.width)) < 2;
        return style.overflowY === 'hidden' && el.scrollHeight <= el.clientHeight + 1 && inside && even;
      }), `management dock must stay even and unscrolled at height ${height}`);
      assert(await page.locator('.ubovm-management-label').first().evaluate(el => el.getBoundingClientRect().width > 2), 'default width keeps management labels visible');
    }
    assert(await page.locator('.ubovm-sidebar-management button').evaluateAll(buttons => buttons.every(button => {
      const icon = button.querySelector('.codicon').getBoundingClientRect();
      const label = button.querySelector('.ubovm-management-label').getBoundingClientRect();
      return label.width > 2 && label.right <= button.getBoundingClientRect().right + 1
        && Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2)) < 3;
    })), 'management icons and labels stay aligned');
    await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist', 'ubovm.settingsPage': '', 'ubovm.contentReady': true }));
    assert.equal(await page.locator('#sessions').evaluate(el => el.dataset.activeMode), 'assist', 'active mode is published on the pane');
    await page.locator('#sessions').evaluate(el => { el.style.width = '180px'; });
    await page.waitForFunction(() => document.getElementById('sessions')?.classList.contains('ubovm-sessions-narrow'));
    assert.equal(await assist.locator('.ubovm-mode-label').evaluate(el => getComputedStyle(el).overflow === 'hidden' || el.getBoundingClientRect().width < 2), true, 'narrow mode hides mode labels');
    assert(await assist.locator('.codicon-comment').evaluate(el => el.getBoundingClientRect().width > 0), 'narrow mode keeps mode icons');
    assert(await page.locator('.ubovm-management-label').first().evaluate(el => el.getBoundingClientRect().width < 2), 'narrow pane hides management labels');
    assert(await page.locator('.ubovm-sidebar-management .codicon').first().evaluate(el => el.getBoundingClientRect().width > 0), 'narrow pane keeps management icons');
    await page.locator('#sessions').evaluate(el => { el.style.width = '280px'; });
    await page.waitForFunction(() => document.getElementById('sessions')?.classList.contains('ubovm-sessions-wide'));
    assert(await page.locator('.ubovm-management-label').first().evaluate(el => el.getBoundingClientRect().width > 2), 'wide pane keeps management labels');
    await page.locator('#sessions').evaluate(el => { el.style.width = '230px'; });
    await page.waitForFunction(() => {
      const el = document.getElementById('sessions');
      return el && !el.classList.contains('ubovm-sessions-narrow') && !el.classList.contains('ubovm-sessions-wide');
    });
    await page.evaluate(() => window.updateContext({ 'ubovm.settingsPage': 'mcp' }));
    assert.equal(await page.locator('#sessions').evaluate(el => el.dataset.settingsPage), 'mcp');
    assert(await page.locator('.ubovm-sidebar-management button[aria-current="page"]').evaluate(el => {
      const style = getComputedStyle(el);
      return el.dataset.settingsPage === 'mcp' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.boxShadow !== 'none';
    }), 'current management page keeps a visible selected surface');
    assert.match(await assist.getAttribute('title') || '', /关闭配置/);
    assert.equal(await page.locator('.ubovm-sidebar-management button[data-settings-page="settings"] .ubovm-management-label').textContent(), '配置');
    await page.evaluate(() => window.updateContext({ 'ubovm.interfaceLocale': 'en', 'ubovm.settingsPage': '' }));
    assert.equal(await assist.locator('.ubovm-mode-label').textContent(), 'Assist');
    assert.equal(await assist.getAttribute('aria-label'), 'Assist mode');
    assert.equal(await page.locator('.ubovm-sidebar-management button[data-settings-page="settings"] .ubovm-management-label').textContent(), 'Settings');
    assert.equal(await page.locator('.ubovm-sidebar-management button[data-settings-page="settings"]').getAttribute('aria-label'), 'Settings');
    await page.evaluate(() => window.updateContext({ 'ubovm.interfaceLocale': 'zh-CN', 'ubovm.settingsPage': 'settings' }));
    assert.equal(await assist.getAttribute('aria-label'), '协助模式（关闭配置后切换）');
    await page.locator('.sidebar').evaluate(el => { el.style.display = 'none'; });
    await page.locator('.sidebar').evaluate(el => { el.style.display = ''; });
    assert(await assist.isVisible());
    assert(await goal.isVisible());
    await page.evaluate(() => window.disposeNavigation());
  }
  console.log('PASS: native welcome, startup, repeated mode/history transitions, settings navigation, sidebar reopening, CSS order, and short sidebar navigation');
} finally { await browser.close(); }
