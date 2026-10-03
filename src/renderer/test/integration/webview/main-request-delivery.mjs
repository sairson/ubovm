import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

test('main requests release failed sends and ignore delivery rejection after acknowledgement', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.mode = 'false'; window.commands = [];
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        if (!message.requestId) return;
        commands.push(message);
        if (mode === 'false') return false;
        if (mode === 'reject') return Promise.reject(Error('bridge rejected'));
        if (mode === 'hold') return new Promise((_, reject) => { window.rejectHeld = reject; });
        dispatchEvent(new MessageEvent('message', { data: { type: 'uiResult', requestId: message.requestId, ok: true } }));
        return Promise.reject(Error('late rejection'));
      } });
      let factory;
      Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
        factory = (actions, ...args) => { window.testActions = actions; return value(actions, ...args); };
      } });
    });
    await page.route('http://request-delivery.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://request-delivery.test/');
    await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', mode: 'assist', conversation: { id: 'one' }, messages: [], execution: {}, context: {}, provider: { configured: true }
    } })));
    for (const mode of ['false', 'reject']) {
      const result = await page.evaluate(async next => {
        window.mode = next;
        try { await testActions.onCopy('same content'); return 'unexpected success'; }
        catch (error) { return error.message; }
      }, mode);
      assert.match(result, /操作未能发送/);
      assert.equal(await page.locator('#runtime-recovery').isVisible(), false);
    }
    await page.evaluate(async () => { mode = 'ack'; await testActions.onCopy('same content'); });
    assert.equal(await page.locator('#ui-error').isVisible(), false);
    assert.equal(await page.evaluate(() => commands.length), 3, 'failed request must not retain deduplication lock');
    const suspended = await page.evaluate(async () => {
      mode = 'hold';
      const waiting = testActions.onCopy('held content').catch(error => error.message);
      dispatchEvent(new Event('pagehide'));
      const settled = await waiting;
      const blocked = await testActions.onCopy('new content').catch(error => error.message);
      return { settled, blocked, count: commands.length };
    });
    assert.match(suspended.settled, /结果尚未确认/);
    assert.match(suspended.blocked, /页面已暂停/);
    assert.equal(suspended.count, 4);
    await page.evaluate(async () => {
      dispatchEvent(new Event('pageshow')); mode = 'ack';
      await testActions.onCopy('held content');
      rejectHeld(Error('old page send')); await Promise.resolve();
    });
    assert.equal(await page.evaluate(() => commands.length), 5);
    assert.equal(await page.locator('#ui-error').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
