import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

test('late frontend state never restores stale execution or switches back to an old conversation', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
      if (message.action === 'connectionProbe') queueMicrotask(() => dispatchEvent(new MessageEvent('message', {
        data: { type: 'connectionStatus', probeId: message.probeId, backend: { status: 'connected' } }
      })));
    } });
    window.sendFull = (viewRevision, id, text, busy = false) => dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', viewRevision, mode: 'assist', conversation: { id, title: id },
      messages: [{ role: 'user', text }], busy,
      provider: { configured: true, connected: true }, context: { workspace: 'test', workspaceConfigured: true },
      execution: { status: busy ? 'running' : 'completed', busy, parts: [], workers: [], streamText: '' }
    } }));
  });
  await page.route('http://ordering.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'ordering-test' }) }));
  await page.goto('http://ordering.test/');
  await page.evaluate(() => {
    sendFull(1, 'a', 'first conversation', true);
    dispatchEvent(new MessageEvent('message', { data: { type: 'executionState', viewRevision: 3, conversationId: 'a', busy: false,
      execution: { status: 'completed', busy: false, parts: [], workers: [], streamText: '' } } }));
    sendFull(2, 'a', 'updated history', true);
  });
  await page.getByText('updated history', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#submit-prompt').getAttribute('aria-label'), '发送任务');
  await page.evaluate(() => { sendFull(5, 'b', 'current conversation'); sendFull(4, 'a', 'stale conversation', true); });
  await page.getByText('current conversation', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('stale conversation', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('connection loss is visible, preserves drafts and blocks submissions until state resync', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.online = true; window.backend = 'connected'; window.sent = [];
    window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
      sent.push(message);
      if (online && message.action === 'connectionProbe') setTimeout(() => dispatchEvent(new MessageEvent('message', { data: { type: 'connectionStatus', probeId: message.probeId, backend: { status: backend } } })), 0);
    } });
  });
  const html = renderWebview({ nonce: 'connection-test' }).replace('interval = 5000, timeout = 20000', 'interval = 50, timeout = 300');
  await page.route('http://connection.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://connection.test/');
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
    type: 'state', mode: 'assist', conversation: { id: 'test', title: '检测连接' }, messages: [], busy: true,
    provider: { configured: true, connected: true }, context: { workspace: 'test' }, execution: { status: 'running', busy: true, parts: [], workers: [], streamText: '已收到的内容\n\n```txt\n待复制文本\n```' }
  } })));
  await page.locator('#prompt-input').fill('断线时仍然保留的草稿');
  const copy = page.locator('.md-code-actions button').last();
  await copy.click();
  assert.equal(await copy.isDisabled(), true);
  const readyCount = await page.evaluate(() => sent.filter(message => message.action === 'ready').length);
  await page.evaluate(() => { dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('pageshow')); });
  await page.waitForFunction(count => sent.filter(message => message.action === 'ready').length > count, readyCount);
  assert.equal(await copy.isDisabled(), true, 'page restoration must preserve pending operations until their real result or timeout');
  assert.equal(await page.locator('#connection-warning').isVisible(), false);
  await page.evaluate(() => { online = false; });
  await page.locator('#connection-warning').waitFor({ state: 'visible' });
  assert.match(await page.locator('#connection-warning-text').textContent(), /任务状态未知/);
  assert.equal(await page.locator('#operation-loading').isVisible(), false, 'lost acknowledgments must release pending request locks');
  assert.equal(await page.locator('.md-code-actions button').last().isDisabled(), false);
  await page.locator('#prompt-input').fill('断线后继续编辑');
  assert.equal(await page.locator('#submit-prompt').isDisabled(), true);
  await page.locator('#prompt-input').press('Enter');
  assert.equal(await page.locator('#prompt-input').inputValue(), '断线后继续编辑');
  assert(await page.locator('#prompt-input').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight));
  await page.evaluate(() => { online = true; backend = 'disconnected'; });
  await page.waitForFunction(() => document.getElementById('connection-warning-text').textContent.startsWith('Agent'));
  await page.evaluate(() => { backend = 'connected'; });
  await page.locator('#connection-warning').waitFor({ state: 'hidden' });
  assert(await page.evaluate(() => sent.filter(message => message.action === 'ready').length >= 2));
  assert.equal(await page.evaluate(() => sent.some(message => ['prompt', 'runGoal', 'resumeRun', 'cancelRun'].includes(message.action))), false);
  assert.deepEqual(errors, []);
});
