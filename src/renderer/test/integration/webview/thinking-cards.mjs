import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../../../.cache', import.meta.url));
const start = Date.now();
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const text = (id, value, status = 'completed') => ({ id, type: 'text', text: value, status });
const thinking = (id, overrides = {}) => ({
  id, type: 'thinking', text: '先核对 **Worker 配置**，再检查流式事件的更新顺序。\n\n接着确认中断后的记录是否完整。',
  status: 'completed', startedAt: start, endedAt: start + 1234, source: 'assistant', ...overrides
});
const tool = (id, overrides = {}) => ({
  id, type: 'tool', name: 'read_workspace_file', args: '{"path":"src/harness/worker/index.mjs"}',
  output: 'export function createWorker(options) {\n  return new Worker(options);\n}',
  status: 'completed', startedAt: start + 1500, endedAt: start + 2100, ...overrides
});
const user = { role: 'user', text: '检查 Worker 的思考、正文和工具调用是否分别显示。' };
function state(parts, overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: 'thinking-cards', title: '独立思考内容' },
    messages: [user], goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    execution: { status: 'running', busy: true, parts, streamText: '', activities: [] }, ...overrides
  };
}
async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://thinking-cards.test/') requests.push(request.url()); });
  await page.addInitScript(({ start }) => {
    window.fixtureNow = start + 2000;
    Date.now = () => window.fixtureNow;
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => hostMessages.push(message) });
  }, { start });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'thinking-cards-test' });
  await page.route('http://thinking-cards.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://blocked-thinking.invalid/**', route => route.abort());
  await page.goto('http://thinking-cards.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value); await frames(); };
  const card = index => page.locator('#messages .thinking-card').nth(index);
  const toggle = async index => { await card(index).locator(':scope > summary').click(); await frames(); };
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the webview must not throw browser errors');
    assert.deepEqual(requests, [], 'thinking markup must not fetch remote resources');
  });
  return { page, emit, frames, card, toggle };
}

test('context summaries use a lazy inline foldout with real status, estimates and retained history', async t => {
  const f = await fixture(t);
  const progress = { id: 'context-summary', type: 'summary', source: 'assistant', text: '', status: 'running', startedAt: start };
  await f.emit(state([progress]));
  const card = f.page.locator('#messages .summary-card');
  assert.equal(await card.count(), 1); assert.equal(await card.evaluate(node => node.open), false);
  assert.match(await card.locator('summary').textContent(), /正在整理上下文/);
  assert.equal(await f.page.locator('#messages .response-streaming').count(), 0);
  await card.locator('summary').click(); await f.frames();
  assert.match(await card.locator('.thinking-content').textContent(), /正在整理/);
  await card.evaluate(node => { window.summaryCard = node; });
  const done = { ...progress, status: 'completed', endedAt: start + 1300, text: '**已确认** 工具事件顺序。\n\n- 保留验证结果\n- 继续当前请求', beforeTokens: 14000, afterTokens: 3500 };
  await f.emit(state([done]));
  assert(await card.evaluate(node => node === summaryCard && node.open));
  assert.equal(await card.locator('.thinking-time').textContent(), '1.3s');
  assert.equal(await card.locator('strong').textContent(), '已确认');
  assert.match(await card.locator('.summary-metrics').textContent(), /14,000 → 3,500/);
  await f.emit(state([{ ...done, afterTokens: 3000 }]));
  assert.match(await card.locator('.summary-metrics').textContent(), /3,000/);
  await f.emit(state([{ ...done, kinds: { 'tool-result': { summaries: 2, fallback: false, truncated: false } } }]));
  assert.match(await card.locator('summary').textContent(), /工具摘要/);
  await f.emit(state([{ ...done, kinds: { transcript: { summaries: 1, fallback: false, truncated: false } } }]));
  assert.match(await card.locator('summary').textContent(), /正文摘要/);
  await f.emit(state([{ ...done, kinds: { transcript: { summaries: 1, fallback: false, truncated: false }, 'tool-result': { summaries: 1, fallback: false, truncated: false } } }]));
  assert.match(await card.locator('summary').textContent(), /混合摘要/);
  const parts = [done, text('answer', '已根据整理后的上下文继续处理。')];
  await f.emit(state(parts, { busy: false, messages: [user, { role: 'assistant', text: '已根据整理后的上下文继续处理。', parts }], execution: { busy: false, status: 'completed', parts } }));
  assert(await card.evaluate(node => node === summaryCard && node.open));
  assert.equal(await f.page.locator('#messages article.assistant').count(), 1);
  await f.page.screenshot({ path: screenshotDirectory + '/context-summary-card.png' });
  await f.page.setViewportSize({ width: 320, height: 800 });
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320));
  await f.page.screenshot({ path: screenshotDirectory + '/context-summary-card-narrow.png' });
});

test('repeated collaboration waits stay in one expandable status without a false writing cursor', async t => {
  const f = await fixture(t);
  const summary = id => ({ id, type: 'summary', source: 'assistant', text: '已保留执行记录', status: 'completed', startedAt: start, endedAt: start + 1000 });
  const parts = [tool('read'), summary('summary-1'), tool('wait-1', { name: 'wait_workers' }), summary('summary-2'), tool('wait-2', { name: 'wait_workers', status: 'running', endedAt: undefined })];
  await f.emit(state(parts));
  const group = f.page.locator('#messages .maintenance-group');
  assert.equal(await group.count(), 1);
  assert.equal(await group.evaluate(el => el.open), false);
  assert.match(await group.locator(':scope > summary').textContent(), /正在等待并行任务.*2 次上下文整理/);
  assert.equal(await f.page.locator('#messages .response-streaming').count(), 0);
  assert.equal(await f.page.locator('#busy-status').isVisible(), false);
  await group.locator(':scope > summary').click();
  await f.frames();
  assert.equal(await group.locator('.tool-card').count(), 2);
  assert.equal(await group.locator('.summary-card').count(), 2);
  const finished = parts.map(part => part.id === 'wait-2' ? { ...part, status: 'completed', endedAt: start + 9000 } : part);
  await f.emit(state([...finished, text('answer', '正在汇总结果', 'streaming')]));
  assert.equal(await group.evaluate(el => el.open), true);
  assert.match(await group.locator(':scope > summary').textContent(), /后台步骤已完成/);
  assert.equal(await f.page.locator('#messages .response-streaming').count(), 1);
  const failed = parts.map(part => part.id === 'wait-2' ? { ...part, status: 'failed', output: '协作等待失败' } : part);
  await group.locator(':scope > summary').click();
  await f.emit(state(failed));
  assert.equal(await group.evaluate(el => el.open), false, 'failed waits must not automatically expand their group');
  assert.match(await group.locator(':scope > summary').textContent(), /失败/);
  await group.locator(':scope > summary').click();
  assert.equal(await group.locator('.tool-card').last().evaluate(el => el.open), false);
});

test('summary fallback, failure and interruption remain honest and keep unsafe markup inert', async t => {
  const f = await fixture(t);
  const summary = { id: 'summary', type: 'summary', source: 'reason', startedAt: start, endedAt: start + 100, status: 'completed', fallback: true, truncated: true, text: '<img src="https://blocked-thinking.invalid/x" onerror="window.injected=true">\n\nOriginal excerpts' };
  await f.emit(state([summary])); await f.toggle(0);
  assert.match(await f.card(0).locator('.thinking-content').textContent(), /本次未生成摘要/);
  assert.match(await f.card(0).locator('summary').textContent(), /未生成/);
  assert(await f.card(0).locator('.thinking-truncation').isVisible());
  assert.equal(await f.page.evaluate(() => window.injected), undefined);
  for (const status of ['failed', 'interrupted']) {
    await f.emit(state([{ ...summary, status, fallback: false, text: '', truncated: false }]));
    assert.match(await f.card(0).locator('summary').textContent(), status === 'failed' ? /摘要未完成/ : /摘要已停止/);
    assert.equal(await f.card(0).evaluate(node => node.open), true);
  }
});

test('streaming thinking is a collapsed one-line DSH preview that changes per token without opening', async t => {
  const f = await fixture(t);
  let thought = thinking('live', {
    status: 'running', endedAt: undefined,
    text: '先核对 **Worker 配置**。\n\n```json\n{"decision":"continue","steps":["a","b"]}\n```\n\n最新观察：' + '缓存命中率提升，继续验证重试间隔与下载流程是否稳定。'.repeat(6)
  });
  await f.emit(state([thought]));
  const card = f.card(0);
  const preview = card.locator('.thinking-preview');
  assert.equal(await card.evaluate(node => node.open), false, 'streaming thinking starts collapsed');
  assert.equal(await card.locator('.thinking-title').textContent(), '思考中');
  assert.equal(await card.locator('.thinking-time').textContent(), '2.0s');
  assert.equal(await preview.isVisible(), true);
  const body = card.locator('.thinking-body');
  assert.equal(await body.isVisible(), false, 'the closed card shows no full body');
  assert.equal(await card.locator('.thinking-content').evaluate(node => node.childElementCount), 0, 'the body is not parsed while collapsed');
  const firstText = await preview.textContent();
  assert.match(firstText, /最新观察/);
  assert.doesNotMatch(firstText, /\*\*|```|"decision"|"steps"|intents/, 'preview strips Markdown/protocol payloads');
  assert(firstText.length <= 160, `preview is clamped: ${firstText.length}`);
  // Every token tick refreshes the preview only; the card never auto-opens.
  await f.page.evaluate(() => { window.savedThinkingCard = document.querySelector('#messages .thinking-card'); });
  thought = { ...thought, text: thought.text.replace('最新观察：', '最新观察：准备重试下载。') };
  await f.emit(state([thought]));
  const secondText = await preview.textContent();
  assert.notEqual(secondText, firstText, 'the preview line changes as reasoning streams');
  assert.match(secondText, /准备重试下载/);
  assert.equal(await card.evaluate(node => node.open), false, 'a token tick never expands the card');
  assert.equal(await card.locator('.thinking-content').evaluate(node => node.childElementCount), 0, 'the body stays unparsed while collapsed');
  assert.equal(await f.page.evaluate(() => window.savedThinkingCard === document.querySelector('#messages .thinking-card')), true, 'the row element is reused across ticks');
  // Long single lines clamp with an ellipsis at 1100px.
  thought = { ...thought, text: '最新观察：' + '非常长的推理内容需要被折叠成单行预览。'.repeat(40) };
  await f.emit(state([thought]));
  const clamped = await preview.textContent();
  assert(clamped.length <= 160, `clamped preview length: ${clamped.length}`);
  assert.match(clamped, /…$/);
  assert.equal(await preview.evaluate(node => node.scrollWidth > node.clientWidth), true, 'long previews are ellipsized, not wrapped');
  assert.deepEqual(await preview.evaluate(node => [getComputedStyle(node).whiteSpace, getComputedStyle(node).textOverflow]), ['nowrap', 'ellipsis']);
  assert.equal(await card.evaluate(node => node.open), false);
  // Completion never opens a card the reader did not open.
  thought = { ...thought, status: 'completed', endedAt: start + 3200 };
  await f.emit(state([thought]));
  assert.equal(await card.locator('.thinking-title').textContent(), '已思考');
  assert.equal(await card.locator('.thinking-time').textContent(), '3.2s');
  assert.equal(await card.evaluate(node => node.open), false, 'completed thinking stays collapsed unless opened');
  assert.equal(await preview.isVisible(), true, 'the preview remains visible on a collapsed completed card');
  await f.page.screenshot({ path: screenshotDirectory + '/assist-thinking-line-light.png' });
});

test('clicking the thinking row expands full Markdown lazily and manual state survives streaming/completion', async t => {
  const f = await fixture(t);
  const full = '第一段：核对 **Worker 配置**。\n\n第二段：确认流式事件的更新顺序。\n\n```json\n{"decision":"continue"}\n```';
  let thought = thinking('expand', { status: 'running', endedAt: undefined, text: full });
  await f.emit(state([thought]));
  const card = f.card(0);
  const preview = card.locator('.thinking-preview');
  await card.locator(':scope > summary').click(); await f.frames();
  assert.equal(await card.evaluate(node => node.open), true, 'clicking the row expands it');
  assert.equal(await preview.isVisible(), false, 'the preview is hidden while the body is open');
  const content = card.locator('.thinking-content');
  assert.equal(await content.isVisible(), true);
  assert.equal(await content.locator('strong').textContent(), 'Worker 配置');
  assert.match(await content.textContent(), /\{"decision":"continue"\}/, 'the full Markdown body keeps the fenced protocol available on demand');
  // Streaming ticks update the open body without closing it.
  thought = { ...thought, text: full + '\n\n第三段：追加观察。' };
  await f.emit(state([thought]));
  assert.match(await content.textContent(), /第三段：追加观察/);
  assert.equal(await card.evaluate(node => node.open), true, 'manual expansion survives ticks');
  await f.page.screenshot({ path: screenshotDirectory + '/assist-thinking-expanded.png' });
  // Manual collapse survives streaming and completion.
  await card.locator(':scope > summary').click(); await f.frames();
  thought = { ...thought, text: thought.text + '\n\n第四段：继续。' };
  await f.emit(state([thought]));
  assert.equal(await card.evaluate(node => node.open), false, 'manual collapse survives ticks');
  assert.match(await preview.textContent(), /第四段|第三段/);
  const renderedClosed = await content.textContent();
  thought = { ...thought, text: thought.text + '\n\n第五段：完成后内容。', status: 'completed', endedAt: start + 5000 };
  await f.emit(state([thought]));
  assert.equal(await card.evaluate(node => node.open), false, 'completion does not open a manually closed card');
  assert.equal(await content.textContent(), renderedClosed, 'the closed body is not re-rendered');
  await card.locator(':scope > summary').click(); await f.frames();
  assert.match(await content.textContent(), /第五段：完成后内容/);
  // A card opened manually before completion stays open afterwards.
  await card.locator(':scope > summary').click(); await f.frames();
  await card.locator(':scope > summary').click(); await f.frames();
  assert.equal(await card.evaluate(node => node.open), true);
  thought = { ...thought, endedAt: start + 6000 };
  await f.emit(state([thought]));
  assert.equal(await card.evaluate(node => node.open), true, 'completion does not close a user-opened card');
});

test('streaming and history promotion preserve the one-line card, manual expansion and selected markdown text', async t => {
  const f = await fixture(t);
  let thought = thinking('persistent', { status: 'running', endedAt: undefined, text: '先核对 **Worker 配置**。\n\n正在检查流式事件。' });
  await f.emit(state([thought]));
  await f.toggle(0);
  await f.page.evaluate(() => {
    window.savedThinking = document.querySelector('#messages .thinking-card');
    window.savedThinkingArticle = savedThinking.closest('article');
    window.savedThinkingBody = savedThinking.querySelector('.thinking-content');
    window.savedThinkingText = savedThinkingBody.querySelector('p').firstChild;
    const range = document.createRange(); range.setStart(savedThinkingText, 0); range.setEnd(savedThinkingText, 3);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  thought = { ...thought, text: thought.text + ' 已收到第一段输出。' };
  await f.emit(state([thought]));
  assert.deepEqual(await f.page.evaluate(() => ({
    card: savedThinking === document.querySelector('#messages .thinking-card'),
    body: savedThinkingBody === savedThinking.querySelector('.thinking-content'),
    text: savedThinkingText === savedThinkingBody.querySelector('p').firstChild,
    open: savedThinking.open, selected: getSelection().toString()
  })), { card: true, body: true, text: true, open: true, selected: '先核对' });
  const finalParts = [{ ...thought, status: 'completed', endedAt: start + 3500 }, text('final', '配置正确，流式输出正常。')];
  await f.emit(state(finalParts, {
    busy: false, messages: [user, { role: 'assistant', text: '配置正确，流式输出正常。', parts: finalParts }],
    execution: { status: 'completed', busy: false, parts: finalParts }
  }));
  assert.equal(await f.page.locator('#messages article.assistant').count(), 1);
  assert.equal(await f.page.locator('#messages article[data-streaming]').count(), 0);
  assert.deepEqual(await f.page.evaluate(() => ({
    article: savedThinkingArticle === document.querySelector('#messages article.assistant'),
    card: savedThinking === document.querySelector('#messages .thinking-card'),
    open: savedThinking.open, selected: getSelection().toString()
  })), { article: true, card: true, open: true, selected: '先核对' });
  assert.equal(await f.card(0).locator('.thinking-time').textContent(), '3.5s');
  await f.toggle(0);
  await f.emit(state(finalParts, { busy: false, messages: [user, { role: 'assistant', text: '配置正确，流式输出正常。', parts: [{ ...finalParts[0], source: 'reason' }, finalParts[1]] }], execution: { status: 'completed', busy: false, parts: finalParts } }));
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'metadata updates respect manually collapsed thinking');
  assert.match(await f.card(0).locator('.thinking-source').textContent(), /规划/, 'source-only changes must propagate through the app equality check');
});

test('thinking time advances only while running, freezes at completion and does not invent missing timing', async t => {
  const f = await fixture(t);
  let thought = thinking('clock', { status: 'running', endedAt: undefined });
  await f.emit(state([thought]));
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  assert.equal(await f.card(0).locator('.thinking-time').textContent(), '2.0s');
  await f.page.evaluate(({ start }) => { window.fixtureNow = start + 7000; }, { start });
  await f.page.waitForTimeout(1100);
  assert.equal(await f.card(0).locator('.thinking-time').textContent(), '7.0s', 'the running timer advances without receiving new text');
  thought = { ...thought, status: 'completed', endedAt: start + 7500 };
  await f.emit(state([thought]));
  assert.equal(await f.card(0).locator('.thinking-time').textContent(), '7.5s');
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'finished thinking stays collapsed');
  await f.page.evaluate(({ start }) => { window.fixtureNow = start + 20000; }, { start });
  await f.page.waitForTimeout(1100);
  assert.equal(await f.card(0).locator('.thinking-time').textContent(), '7.5s');
  const interrupted = thinking('stopped', { status: 'interrupted', endedAt: start + 800, text: '已完成第一步检查。', truncated: true });
  await f.emit(state([thought, interrupted, thinking('unknown-time', { startedAt: undefined, endedAt: undefined })], { busy: false, execution: { status: 'interrupted', busy: false, parts: [thought, interrupted, thinking('unknown-time', { startedAt: undefined, endedAt: undefined })] } }));
  assert.equal(await f.card(1).getAttribute('data-status'), 'interrupted');
  assert.match(await f.card(1).locator('.thinking-summary').textContent(), /停止|中断/);
  assert.equal(await f.card(1).locator('.thinking-time').textContent(), '0.8s');
  assert.equal(await f.card(1).evaluate(node => node.open), false, 'interrupted thinking stays collapsed');
  await f.toggle(1);
  assert.equal(await f.card(1).locator('.thinking-truncation').isVisible(), true);
  assert.match(await f.card(1).locator('.thinking-truncation').textContent(), /截断|保留的部分/);
  assert.equal(await f.card(2).locator('.thinking-time').textContent(), '', 'history without timestamps has no fabricated duration');
  assert.equal(await f.card(2).evaluate(node => node.open), false);
});

test('long thinking preserves its reading position and follows appended content only from the bottom', async t => {
  const f = await fixture(t);
  let thought = thinking('scroll', { status: 'running', endedAt: undefined, text: Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 步：检查 Worker 的事件与输出。`).join('\n\n') });
  await f.emit(state([thought]));
  await f.toggle(0);
  const body = f.card(0).locator('.thinking-body');
  assert(await body.evaluate(node => node.scrollHeight > node.clientHeight), 'long thinking has a bounded reading area');
  assert.equal(await body.evaluate(node => node.scrollTop), 0, 'opening a long thought starts at its beginning');
  await body.evaluate(node => {
    window.savedThinkingScrollBody = node;
    window.savedThinkingScrollText = node.querySelector('p').firstChild;
    const range = document.createRange(); range.setStart(savedThinkingScrollText, 0); range.setEnd(savedThinkingScrollText, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    node.scrollTop = 40;
  });
  thought = { ...thought, text: thought.text + '\n\n' + '继续检查流式状态。\n\n'.repeat(10) };
  await f.emit(state([thought]));
  assert.deepEqual(await body.evaluate(node => ({ sameBody: node === savedThinkingScrollBody, sameText: node.querySelector('p').firstChild === savedThinkingScrollText, scroll: node.scrollTop, selected: getSelection().toString() })), { sameBody: true, sameText: true, scroll: 40, selected: '第 1 步' });
  await body.evaluate(node => { getSelection().removeAllRanges(); node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  thought = { ...thought, text: thought.text + '\n\n' + '已完成事件检查。\n\n'.repeat(10) };
  await f.emit(state([thought]));
  assert(await body.evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2), 'a reader at the bottom follows streamed thinking');
  await f.toggle(0);
  const rendered = await f.card(0).locator('.thinking-content').textContent();
  thought = { ...thought, text: thought.text + '\n\n最后检查完成。' };
  await f.emit(state([thought]));
  assert.equal(await f.card(0).locator('.thinking-content').textContent(), rendered, 'closed cards defer further markdown rendering');
  await f.toggle(0);
  assert.match(await f.card(0).locator('.thinking-content').textContent(), /最后检查完成/);
});

test('thinking markdown uses the safe renderer and never creates active HTML or navigates the page', async t => {
  const f = await fixture(t);
  const hostile = '检查 **工具参数** 与 `worker.run()`。\n\n<script>window.thinkingExecuted=true</script>\n<img src="https://blocked-thinking.invalid/image.png" onerror="window.thinkingExecuted=true">\n\n[危险链接](javascript:window.thinkingExecuted=true)\n\n<iframe src="https://blocked-thinking.invalid/frame"></iframe>\n\n```html\n<div onclick="alert(1)">示例代码</div>\n```';
  await f.emit(state([thinking('safe', { text: hostile })]));
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  await f.toggle(0);
  assert.equal(await f.card(0).locator('.thinking-content strong').textContent(), '工具参数');
  assert(await f.card(0).locator('.thinking-content code').allTextContents().then(values => values.some(value => value.includes('worker.run()'))));
  assert.equal(await f.card(0).locator('.thinking-content script, .thinking-content iframe, .thinking-content img[src], .thinking-content [onclick], .thinking-content [onerror]').count(), 0);
  assert.equal(await f.card(0).locator('.thinking-content a[href^="javascript:"]').count(), 0);
  assert.equal(await f.page.evaluate(() => window.thinkingExecuted), undefined);
  assert.equal(f.page.url(), 'http://thinking-cards.test/');
  assert.equal(await f.page.locator('#messages .response-text').count(), 0);
});

test('thinking cards interleave with prose and grouped tools without becoming the main answer', async t => {
  const f = await fixture(t);
  let first = thinking('first', { status: 'running', endedAt: undefined });
  await f.emit(state([first]));
  assert.equal(await f.page.locator('#messages article.assistant[data-streaming]').count(), 1);
  assert.equal(await f.card(0).count(), 1);
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'thinking starts collapsed');
  assert.equal(await f.page.locator('#messages .response-text').count(), 0, 'thinking must never become the main answer');
  assert.equal(await f.page.locator('#messages .response-streaming').count(), 0, 'thinking alone has no main-answer streaming cursor');
  first = { ...first, text: first.text + '\n\n已找到配置入口。' };
  await f.emit(state([first]));
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'streaming keeps the card collapsed');
  await f.card(0).locator(':scope > summary').focus();
  await f.page.keyboard.press('Enter');
  await f.frames();
  assert.equal(await f.card(0).evaluate(node => node.open), true, 'keyboard expands natively');
  assert.equal(await f.card(0).locator('.thinking-content strong').textContent(), 'Worker 配置');
  assert.match(await f.card(0).locator('.thinking-content').textContent(), /已找到配置入口/);
  await f.page.keyboard.press('Space');
  await f.frames();
  assert.equal(await f.card(0).evaluate(node => node.open), false);

  const parts = [
    { ...first, status: 'completed', endedAt: start + 1234 },
    text('intro', '我会先检查工具注册。'), tool('read-one'), tool('read-two'),
    thinking('second', { source: 'worker', workerId: 'worker-01', status: 'running', endedAt: undefined }),
    text('answer', '工具已经注册，正在检查输出。', 'streaming')
  ];
  await f.emit(state(parts));
  assert.deepEqual(await f.page.locator('#messages .message-timeline > *').evaluateAll(nodes => nodes.map(node => node.classList.contains('thinking-card') ? 'thinking' : node.classList.contains('tool-group') ? 'tools' : 'text')), ['thinking', 'text', 'tools', 'thinking', 'text']);
  assert.equal(await f.page.locator('#messages .tool-group > .tool-card').count(), 2, 'assist tool grouping is unchanged');
  assert.deepEqual(await f.page.locator('#messages .response-text').allTextContents().then(values => values.map(value => value.trim())), ['我会先检查工具注册。', '工具已经注册，正在检查输出。']);
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  assert.equal(await f.card(1).getAttribute('data-status'), 'running');
  assert.equal(await f.card(1).evaluate(node => node.open), false, 'worker thinking is also a collapsed DSH row');
  assert.match(await f.card(1).locator('.thinking-source').textContent(), /子任务/);
  assert.equal(await f.page.locator('#messages .response-text').last().locator('p').textContent(), '工具已经注册，正在检查输出。');
  assert.equal(await f.page.locator('#messages .response-streaming').count(), 1, 'normal answer text retains its streaming cursor');
});

test('thinking rows stay exactly one line at 1100/430 with shimmer off under reduced motion', async t => {
  const f = await fixture(t);
  const longLine = '最新观察：' + '缓存命中率提升，继续验证重试间隔与下载流程是否稳定。'.repeat(12);
  const parts = [
    thinking('planning', { source: 'reason', text: '先核对 **Worker 配置**。\n\n计划已完成。' }),
    text('intro', '我会检查 Worker 的事件处理和工具输出。'),
    tool('read'),
    thinking('working', { source: 'worker', workerId: 'worker-01', status: 'running', endedAt: undefined, text: longLine }),
    text('progress', '已找到对应实现，正在验证流式显示。', 'streaming')
  ];
  await f.emit(state(parts));
  await f.page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  assert.equal(await f.card(1).evaluate(node => node.open), false);
  const measure = index => f.card(index).evaluate(node => {
    const summary = node.querySelector('.thinking-summary');
    const preview = node.querySelector('.thinking-preview');
    const time = node.querySelector('.thinking-time');
    const summaryRect = summary.getBoundingClientRect(), previewRect = preview.getBoundingClientRect(), timeRect = time.getBoundingClientRect();
    return {
      row: Math.round(node.getBoundingClientRect().height),
      summary: Math.round(summaryRect.height),
      sameRow: Math.abs(previewRect.top - timeRect.top) <= 2,
      previewOverflow: preview.scrollWidth > preview.clientWidth + 1,
      whiteSpace: getComputedStyle(preview).whiteSpace,
      ellipsis: getComputedStyle(preview).textOverflow,
      animation: getComputedStyle(preview).animationName
    };
  });
  const wide = await measure(1);
  assert(wide.row >= 28 && wide.row <= 34, `one-line reasoning row height at 1100px: ${JSON.stringify(wide)}`);
  assert(wide.summary >= 28 && wide.summary <= 34, 'summary stays a single compact line');
  assert(wide.sameRow && wide.previewOverflow, 'preview is ellipsized and meta stays inline');
  assert.deepEqual([wide.whiteSpace, wide.ellipsis], ['nowrap', 'ellipsis']);
  assert.equal(wide.animation, 'thinking-preview-sweep', 'running rows shimmer with the neutral sweep');
  assert.equal(await measure(0).then(value => value.animation), 'none', 'completed rows do not animate');
  assert.equal(await f.page.locator('#messages .thinking-preview').first().evaluate(node => getComputedStyle(node).backgroundImage !== 'none'), true);
  await f.page.emulateMedia({ reducedMotion: 'reduce' }); await f.frames();
  assert.equal(await measure(1).then(value => value.animation), 'none', 'reduced motion disables the shimmer');
  assert.equal(await f.card(1).locator('.thinking-preview').evaluate(node => getComputedStyle(node).backgroundImage), 'none');
  await f.page.emulateMedia({ reducedMotion: 'no-preference' });
  // Expanded rows hide the preview and show the full Markdown body.
  await f.toggle(0);
  assert.equal(await f.card(0).locator('.thinking-preview').isVisible(), false, 'preview hides while expanded');
  assert.equal(await f.card(0).locator('.thinking-content').isVisible(), true);
  await f.toggle(0);
  // Dark theme screenshot at full width (collapsed streaming preview + completed row).
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames();
  await f.page.screenshot({ path: screenshotDirectory + '/assist-thinking-line-dark.png' });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  // Exactly one line at 430px, with the source label hidden first.
  await f.page.setViewportSize({ width: 430, height: 900 }); await f.frames();
  const narrow = await measure(1);
  assert(narrow.row >= 28 && narrow.row <= 34, `one-line reasoning row height at 430px: ${JSON.stringify(narrow)}`);
  assert(narrow.sameRow, 'duration stays inline at 430px');
  assert.equal(await f.card(1).locator('.thinking-source').evaluate(node => getComputedStyle(node).display), 'none');
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= 430), true);
  await f.page.screenshot({ path: screenshotDirectory + '/assist-thinking-line-430.png' });
});
