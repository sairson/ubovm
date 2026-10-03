import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { renderWebview } from '../../../host/ui/webview.cjs';
import { renderWorkerPanel } from '../../../host/ui/worker-panel.cjs';

test('preview rejection is an operation error in both conversation and native Worker', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const body of [renderWebview(), renderWorkerPanel()]) {
      const page = await browser.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} });
        let factory;
        Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
          factory = (actions, ...args) => { window.previewActions = actions; return value(actions, ...args); };
        } });
      });
      await page.route('http://preview-limit.test/', route => route.fulfill({ contentType: 'text/html', body }));
      await page.goto('http://preview-limit.test/');
      await page.evaluate(() => {
        dispatchEvent(new MessageEvent('message', { data: { type: 'state', mode: 'assist', conversation: { id: 'one' }, messages: [], execution: {}, provider: { configured: true }, context: {} } }));
        dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId: 'one', selected: 'a', revealRevision: 1, workers: [{ id: 'a', result: '日志', status: 'completed' }] } }));
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.evaluate(() => window.previewActions.onPreviewHtml('x'.repeat(2 * 1024 * 1024 + 1)));
      assert.match(await page.locator('body').innerText(), /HTML 预览最多支持/);
      assert.equal(await page.locator('.html-preview').count(), 0);
      const recovery = page.locator('#runtime-recovery');
      if (await recovery.count()) assert.equal(await recovery.isVisible(), false);
      await page.evaluate(() => window.previewActions.onPreviewHtml('<p>正常内容</p>'));
      assert.equal(await page.locator('.html-preview').count(), 1);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});

test('complex previews fail before replacing the active frame or changing background focus', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main><textarea id="draft">保留草稿</textarea></main>');
    await page.addScriptTag({ content: await readFile(new URL('../../../webview/preview/html-preview.js', import.meta.url), 'utf8') });
    const results = await page.evaluate(() => {
      const api = window.UBOVMHtmlPreview;
      document.querySelector('#draft').focus(); api.open('<h1>保留预览</h1>');
      const original = document.querySelector('.html-preview');
      const focused = document.activeElement;
      const failures = [];
      for (const html of ['<i></i>'.repeat(20001), '<div>'.repeat(150) + 'text' + '</div>'.repeat(150), '<p style="color:red">x</p>'.repeat(4000)]) {
        try { api.open(html); failures.push('accepted'); }
        catch (error) { failures.push(error.message); }
        if (document.querySelector('.html-preview') !== original || document.activeElement !== focused) throw Error('active preview changed');
      }
      api.close();
      const restored = document.activeElement.id === 'draft' && !document.querySelector('main').inert;
      api.open('<article>' + '<p>正常内容</p>'.repeat(100) + '</article>');
      const reopened = api.isOpen;
      api.close();
      return { failures, restored, reopened, draft: document.querySelector('#draft').value };
    });
    assert.match(results.failures[0], /结构过于复杂/);
    assert.match(results.failures[1], /结构过于复杂/);
    assert.match(results.failures[2], /内联样式过多/);
    assert.equal(results.restored, true); assert.equal(results.reopened, true);
    assert.equal(results.draft, '保留草稿'); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
