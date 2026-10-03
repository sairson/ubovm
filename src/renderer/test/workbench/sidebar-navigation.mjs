import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const native = await readFile(new URL('../../../../vendor/vscode/src/vs/workbench/browser/parts/views/media/views.css', import.meta.url), 'utf8');
const custom = await readFile(new URL('../../workbench/workbench.css', import.meta.url), 'utf8');
const patch = await readFile(new URL('../../../../resources/patches/sidebar-mode.patch', import.meta.url), 'utf8');
const script = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1)).filter(line => !line.includes('height = Math.max')).join('\n').replace(': KeyboardEvent', '').replace('<HTMLElement, boolean>', '').replace(': Event', '').replace(' as Node', '').replace(': number | undefined', '');
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
    assert.equal(await page.locator('.ubovm-session-loading').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'shared shell mask owns startup feedback');
    assert.equal(await page.locator('.monaco-workbench').evaluate(el => getComputedStyle(el, '::before').opacity), '1', 'one shared overlay covers sidebar and editor');
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
    await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist' }));
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
      assert.equal(await assist.textContent(), '协助模式');
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
        return style.overflowY === 'hidden' && el.scrollHeight <= el.clientHeight + 1;
      }), `management must not scroll at height ${height}`);
      assert.equal(await page.locator('.ubovm-management-label').first().evaluate(el => getComputedStyle(el).overflow === 'hidden' || el.getBoundingClientRect().width < 2), true, 'management labels stay visually hidden');
    }
    await page.locator('.sidebar').evaluate(el => { el.style.display = 'none'; });
    await page.locator('.sidebar').evaluate(el => { el.style.display = ''; });
    assert(await assist.isVisible());
    assert(await goal.isVisible());
    await page.evaluate(() => window.disposeNavigation());
  }
  console.log('PASS: native welcome, startup, repeated mode/history transitions, settings navigation, sidebar reopening, CSS order, and short sidebar navigation');
} finally { await browser.close(); }
