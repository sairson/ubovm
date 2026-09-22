import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const css = await readFile(new URL('../workbench/workbench.css', import.meta.url), 'utf8');
  const patch = await readFile(new URL('../../../resources/sidebar-mode.patch', import.meta.url), 'utf8');
  const script = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)).filter(line => !line.includes('height = Math.max')).join('\n').replace(': KeyboardEvent', '');
  await page.setContent(`<style>${css}.part.editor{position:absolute;left:300px;right:0;top:0;bottom:0}</style><div class="monaco-workbench"><div class="pane"><div id="sessions" class="pane-body"><div class="tree-explorer-viewlet-tree-view"><div class="message">There is no data provider registered that can provide view data.</div></div></div></div><div class="part editor"></div></div>`);
  await page.evaluate(script => {
    const callbacks = [];
    window.values = {};
    window.updateContext = values => { Object.assign(window.values, values); callbacks.forEach(callback => callback({ affectsSome: () => true })); };
    const pane = { id: 'ubovm.sessions', _register() {}, openerService: { open() {} }, contextKeyService: {
      getContextKeyValue: key => window.values[key],
      onDidChangeContext: callback => callbacks.push(callback)
    } };
    new Function('container', script).call(pane, document.getElementById('sessions'));
  }, script);
  assert.equal(await page.locator('.message').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.equal(await page.locator('.ubovm-session-loading').isVisible(), true);
  assert.equal(await page.locator('.part.editor').evaluate(el => getComputedStyle(el, '::before').opacity), '1');
  await page.evaluate(() => window.updateContext({ 'ubovm.mode': 'assist', 'ubovm.contentReady': true }));
  await page.waitForTimeout(220);
  assert.equal(await page.locator('.ubovm-session-loading').isVisible(), false);
  assert.equal(await page.locator('.part.editor').evaluate(el => getComputedStyle(el, '::before').opacity), '0');
  console.log('PASS: native startup frame, provider placeholder, first-content handoff');
} finally { await browser.close(); }
