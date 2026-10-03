import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';
import { renderWorkerPanel } from '../../../host/ui/worker-panel.cjs';

test('async navigation releases obsolete previews and preserves the active focus owner', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('http://overlays.test/main', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.route('http://overlays.test/workers', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
    await page.goto('http://overlays.test/main');
    const send = data => page.evaluate(data => dispatchEvent(new MessageEvent('message', { data })), data);
    const state = id => ({ type: 'state', mode: 'assist', conversation: { id }, messages: [], execution: {}, provider: { configured: true }, context: {} });
    await send(state('one'));
    await page.locator('#prompt-input').fill('保留会话草稿');
    const preview = () => page.evaluate(() => window.UBOVMHtmlPreview.open('<h1>旧内容</h1>'));
    await preview();
    assert.equal(await page.locator('.shell').evaluate(el => el.inert), true);
    await send({ type: 'focusInput', sessionId: 'one' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => document.activeElement.closest('.html-preview') !== null), true);
    await send({ type: 'settingsLoading', page: 'settings', requestId: 'open-one' });
    assert.equal(await page.locator('.html-preview').count(), 0);
    assert.equal(await page.locator('.shell').evaluate(el => el.inert), false);
    assert.equal(await page.locator('#settings-dialog').evaluate(el => el.open && !el.inert), true);
    await page.locator('#settings-close').click();
    assert.equal(await page.locator('#prompt-input').inputValue(), '保留会话草稿');
    await preview();
    await send(state('one'));
    assert.equal(await page.locator('.html-preview').count(), 1, 'streaming updates preserve the current preview');
    await send(state('two'));
    assert.equal(await page.locator('.html-preview').count(), 0);
    await page.locator('#prompt-input').fill('新会话可编辑');

    // Hold only the deferred focus callback, then switch session before it runs.
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { window.delayedFocus = callback; return 1; };
      dispatchEvent(new MessageEvent('message', { data: { type: 'focusInput', sessionId: 'two' } }));
      window.requestAnimationFrame = raf;
    });
    await send(state('three'));
    assert.equal(await page.evaluate(() => {
      const input = document.getElementById('prompt-input'), focus = input.focus;
      let calls = 0; input.focus = () => calls++;
      window.delayedFocus(); input.focus = focus; return calls;
    }), 0);

    await page.goto('http://overlays.test/workers');
    const workers = [{ id: 'a', name: 'Worker A', result: '完成' }];
    await send({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
    await preview();
    await send({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
    assert.equal(await page.locator('.html-preview').count(), 1);
    await send({ type: 'workers', sessionId: 'two', workers: [] });
    assert.equal(await page.locator('.html-preview').count(), 0);
    assert.equal(await page.locator('.shell').evaluate(el => el.inert), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
