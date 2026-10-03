import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('old stop rejection cannot unlock a new request after leaving and returning to a session', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main></main>');
    await page.addScriptTag({ content: await readFile(new URL('../../../webview/messages/background-tasks.js', import.meta.url), 'utf8') });
    const result = await page.evaluate(async () => {
      const requests = [];
      const view = window.createBackgroundTasks({ onInterruptCommand() {
        return new Promise((resolve, reject) => requests.push({ resolve, reject }));
      } });
      document.querySelector('main').append(view.element);
      const state = id => ({ conversation: { id }, execution: { parts: [{ type: 'tool', background: true,
        commandId: 'cmd', name: 'shell', args: '{"command":"echo test"}', status: 'running', startedAt: Date.now() }] } });
      const expand = () => view.element.querySelector('.background-tasks-toggle').click();
      const stop = view.element.querySelector('.background-task-stop');
      view.update(state('one')); expand(); stop.click();
      view.update(state('two')); view.update(state('one')); expand(); stop.click();
      requests[0].reject(Error('old request'));
      await Promise.resolve(); await Promise.resolve();
      const stale = { disabled: stop.disabled, notice: view.element.querySelector('.background-task-notice').textContent };
      stop.click();
      const sends = requests.length;
      requests[1].reject(Error('current request'));
      await Promise.resolve(); await Promise.resolve();
      return { stale, sends, current: { disabled: stop.disabled, notice: view.element.querySelector('.background-task-notice').textContent } };
    });
    assert.deepEqual(result, { stale: { disabled: true, notice: '' }, sends: 2,
      current: { disabled: false, notice: '停止请求未确认，请重试' } });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
