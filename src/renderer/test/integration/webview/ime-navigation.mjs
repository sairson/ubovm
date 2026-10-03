import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';
import { renderWorkerPanel } from '../../../host/ui/worker-panel.cjs';

let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
test.after(async () => browser?.close());

async function pageFor(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: message => sent.push(message) });
  });
  await page.route('http://ime.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://ime.test/');
  return page;
}

// Cover engines that omit isComposing/keyCode during an active composition,
// as well as either flag independently, before exercising normal key input.
async function compositionKeys(input, key, extra = {}) {
  return input.evaluate((element, { key, extra }) => {
    element.focus();
    const dispatch = flags => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra, ...flags });
      element.dispatchEvent(event); return event.defaultPrevented;
    };
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const results = [dispatch({})];
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    results.push(dispatch({ isComposing: true }), dispatch({ keyCode: 229 }));
    return results;
  }, { key, extra });
}

test('Worker search keeps composition Enter and Escape from selecting or clearing records', async t => {
  const page = await pageFor(t, renderWorkerPanel());
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
    type: 'workers', sessionId: 'ime-worker', selected: 'a', revealRevision: 1,
    workers: [{ id: 'a', name: '原始任务', status: 'completed', result: '记录 A' },
      { id: 'b', name: '中文搜索', status: 'completed', result: '记录 B' }]
  } })));
  const search = page.getByRole('searchbox');
  await search.fill('中文');
  const before = await page.evaluate(() => sent.filter(message => message.action === 'selectWorker').length);
  assert.deepEqual(await compositionKeys(search, 'Enter'), [false, false, false]);
  assert.deepEqual(await compositionKeys(search, 'Escape'), [false, false, false]);
  assert.equal(await search.inputValue(), '中文');
  assert.equal(await page.locator('#worker-picker').inputValue(), 'a');
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'selectWorker').length), before);
  await search.press('Enter');
  assert.equal(await page.locator('#worker-picker').inputValue(), 'b');
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
});

test('exploration search waits for a separate Enter after composition before navigating', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent('<div id="board"></div>');
  await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
  for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
  await page.evaluate(() => {
    window.details = 0;
    window.graph = createBlackboardGraph(document.querySelector('#board'), { factText: v => v || '', statusText: v => v, onDetail: () => details++ });
    graph.update({ sessionId: 'ime-graph', rootId: 'root', nodes: [
      { id: 'root', kind: 'root', parentIds: [] },
      { id: 'fact', kind: 'fact', parentIds: ['root'], fact: { content: '中文证据' } }
    ] });
  });
  const search = page.getByRole('searchbox'); await search.fill('中文');
  const before = await page.evaluate(() => details);
  assert.deepEqual(await compositionKeys(search, 'Enter'), [false, false, false]);
  assert.equal(await page.evaluate(() => details), before);
  assert.equal(await search.evaluate(el => document.activeElement === el), true);
  await search.press('Enter');
  assert.equal(await page.locator('[data-node-id="fact"]').getAttribute('aria-pressed'), 'true');
});

test('note shortcut preserves composition and sends once on the next Ctrl Enter', async t => {
  const page = await pageFor(t, renderWebview());
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
    type: 'state', mode: 'goal', conversation: { id: 'ime-note' }, messages: [],
    goal: { objective: '记录验证结果', criteria: [], notes: [] }, execution: { status: 'idle' },
    provider: { configured: true }, context: {}
  } })));
  await page.locator('#note-new').evaluate(el => el.click());
  const input = page.locator('#goal-note-input');
  await input.fill('中文笔记');
  assert.deepEqual(await compositionKeys(input, 'Enter', { ctrlKey: true }), [false, false, false]);
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'addGoalNote').length), 0);
  await input.press('Control+Enter');
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'addGoalNote').length), 1);
});
