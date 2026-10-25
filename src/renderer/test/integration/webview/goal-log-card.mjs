import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const now = Date.now();
const parts = [
  { id: 'thinking-1', type: 'thinking', status: 'completed', startedAt: now - 5000, endedAt: now - 4000, text: '先确认重复 Worker 的覆盖范围。' },
  { id: 'conclusion-1', type: 'text', source: 'reason', status: 'completed', startedAt: now - 3000, text: '结论：继续审计 CDN 回源配置，但先停掉重复的爬虫 Worker。' },
  { id: 'stop-1', type: 'tool', name: 'stop_worker', status: 'completed', startedAt: now - 2000, endedAt: now - 1500, args: '{"worker":"n7","reason":"重复抓取"}', output: '{"stopped":true}' }
];

test('thinking and scheduling log uses a compact IDE-native panel with inline reasoning bands', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'goal-log-card-test' }) }));
    await page.goto('http://goal-log-card.test/');
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
      type: 'state', mode: 'goal', conversation: { id: 'goal-log-card', title: '思考与调度日志' },
      goal: { objective: '审计目标站点响应头', criteria: ['确认回源配置暴露面'], notes: [] },
      messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: true,
      execution: {
        status: 'running', busy: true, phase: 'execute', parts,
        activities: [{ label: 'Reason', status: 'running', timestamp: now - 6000, key: 'reason-live' }],
        workers: [{ id: 'w-n4', intentId: 'n4', title: '枚举静态资源', status: 'running', createdAt: now - 7000, startedAt: now - 6500 }]
      }
    });
    await frames(); await frames();
    assert.equal(await page.locator('#goal-output-title').textContent(), '思考与调度日志');
    assert.equal(await page.locator('.goal-output-subtitle').textContent(), 'Reason 规划 · Worker 调度 · 工具活动');
    assert.equal(await page.locator('.goal-output-icon svg').isVisible(), true);
    const header = await page.evaluate(() => {
      const heading = document.querySelector('#goal-output-panel .goal-output-heading');
      const title = document.getElementById('goal-output-title');
      const icon = document.querySelector('#goal-output-panel .goal-output-icon');
      return {
        minHeight: getComputedStyle(heading).minHeight,
        padding: getComputedStyle(heading).padding,
        title: getComputedStyle(title).fontSize,
        icon: getComputedStyle(icon).width,
        iconBorder: getComputedStyle(icon).borderTopWidth
      };
    });
    assert.equal(header.minHeight, '38px');
    assert.equal(header.padding, '7px 12px');
    assert.equal(header.title, '12.5px');
    assert.equal(header.icon, '20px');
    assert.equal(header.iconBorder, '0px');
    const card = await page.locator('.goal-output-panel').evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderRadius, shadow: style.boxShadow };
    });
    assert.equal(card.radius, '12px');
    assert.equal(card.shadow, 'none');
    const status = await page.locator('#goal-output-status').evaluate(node => {
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, background: style.backgroundColor, size: style.fontSize };
    });
    assert.equal(status.border, '0px');
    assert.equal(status.background, 'rgba(0, 0, 0, 0)');
    assert.equal(status.size, '10px');
    assert.equal(await page.locator('.goal-log-entry[data-kind="activity"][data-activity="plan"]').count(), 1);
    const plan = await page.locator('.goal-log-entry[data-kind="activity"][data-activity="plan"]').evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderRadius, padding: style.padding, paint: style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)', border: style.borderTopWidth, shadow: style.boxShadow };
    });
    assert.equal(plan.radius, '0px');
    assert.equal(plan.border, '0px');
    assert.equal(plan.shadow, 'none');
    assert.equal(plan.padding, '6px 8px 6px 26px');
    assert.equal(plan.paint, true);
    const conclusion = page.locator('.goal-log-entry[data-kind="text"][data-source="reason"]');
    assert.equal(await conclusion.count(), 1);
    assert.match(await conclusion.textContent(), /继续审计 CDN 回源配置/);
    assert.equal(await page.locator('#goal-log-bottom').isVisible(), true);
    assert.equal(await page.locator('.goal-log-entry[data-kind="tool"]').count(), 1);
    // Narrow layout keeps the header on two compact rows and never scrolls sideways.
    await page.setViewportSize({ width: 430, height: 900 });
    await frames(); await frames();
    assert.equal(await page.locator('#goal-output-title').isVisible(), true);
    assert.match(await page.locator('#goal-output-title').textContent(), /思考与调度日志/);
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector('.goal-output-panel');
      const content = document.getElementById('goal-output-content');
      const subtitle = getComputedStyle(document.querySelector('.goal-output-subtitle'));
      const button = document.getElementById('goal-log-bottom');
      return { scroll: panel.scrollWidth, client: panel.clientWidth, contentScroll: content.scrollWidth, contentClient: content.clientWidth, subtitle: subtitle.display, buttonWidth: getComputedStyle(button).width, buttonText: getComputedStyle(button).fontSize };
    });
    assert.ok(narrow.scroll <= narrow.client + 1, JSON.stringify(narrow));
    assert.ok(narrow.contentScroll <= narrow.contentClient + 1, JSON.stringify(narrow));
    assert.equal(narrow.subtitle, 'none');
    assert.equal(narrow.buttonWidth, '24px');
    assert.equal(narrow.buttonText, '0px');
    // An empty log shows one flat message: no dashed inner card and no shadow.
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
      type: 'state', mode: 'goal', conversation: { id: 'goal-log-card', title: '思考与调度日志' },
      goal: { objective: '审计目标站点响应头', criteria: [], notes: [] },
      messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: false,
      execution: { status: 'idle', busy: false, parts: [], activities: [], workers: [] }
    });
    await frames(); await frames();
    assert.equal(await page.locator('#goal-output-empty').isVisible(), true);
    const empty = await page.evaluate(() => {
      const node = document.getElementById('goal-output-empty');
      const panel = document.querySelector('.goal-output-panel');
      const style = getComputedStyle(node);
      return { borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle, shadow: getComputedStyle(panel).boxShadow };
    });
    assert.equal(empty.borderWidth, '0px');
    assert.equal(empty.borderStyle, 'none');
    assert.equal(empty.shadow, 'none');
    await page.screenshot({ path: '.cache/goal-log-card/narrow-ui-test.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// ===========================================================================
// v2: readable reasoning cards + scannable scheduling log.
// ===========================================================================
const v2Directory = '.cache/goal-log-v2';
const v2Now = Date.now();
let v2Browser;
test.before(async () => {
  await mkdir(v2Directory, { recursive: true });
  v2Browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => v2Browser?.close());
const v2Reason = (id, overrides = {}) => ({
  id, type: 'thinking', source: 'reason', status: 'completed',
  startedAt: v2Now - 12000, endedAt: v2Now - 1000,
  text: '先核对下载流程。', ...overrides
});
const v2Tool = (id, overrides = {}) => ({
  id, type: 'tool', name: 'read_workspace_file', args: '{"path":"src/app.js"}',
  output: 'export const ready = true;', status: 'completed',
  startedAt: v2Now - 9000, endedAt: v2Now - 8000, ...overrides
});
const v2Worker = (id, overrides = {}) => ({
  id, name: '检查下载流程', description: '验证下载、重试和失败提示。',
  status: 'running', createdAt: v2Now - 9000, startedAt: v2Now - 8500, ...overrides
});
function v2State(execution = {}, overrides = {}) {
  return {
    type: 'state', mode: 'goal', conversation: { id: overrides.sessionId || 'goal-log-v2', title: '思考与调度日志' },
    goal: { objective: '优化思考与调度日志', criteria: [], notes: [] }, messages: [],
    provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: true, ...overrides,
    execution: { status: 'running', busy: true, phase: 'execute', parts: [], activities: [], workers: [], ...execution }
  };
}
async function v2Fixture(t, options = {}) {
  await mkdir(v2Directory, { recursive: true });
  const page = await v2Browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce', ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith('http://goal-log-v2.test/')) requests.push(url);
  });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://goal-log-v2.test/') return route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'goal-log-v2' }) });
    return route.fulfill({ status: 204 });
  });
  await page.goto('http://goal-log-v2.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const send = async value => {
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), value);
    await frames(); await frames();
  };
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the log must not throw page errors');
    assert.deepEqual(requests, [], 'the log must not fetch remote resources');
  });
  return { page, frames, send };
}
const v2Rows = page => page.locator('#goal-output-content .goal-log-entry');
const v2RowIds = page => v2Rows(page).evaluateAll(rows => rows.map(row => row.dataset.logId));

test('reasoning cards show a two-line preview, fold protocol JSON and open into markdown', async t => {
  const f = await v2Fixture(t);
  const reasoning = v2Reason('reason-1', {
    text: '先核对 **下载流程** 和重试策略。\n\n- 检查缓存\n- 验证窄屏\n\n```json\n{"intents":[{"id":"n1","goal":"下载"}],"decision":"retry"}\n```\n\n结论：保持安静。\n\n{"decision":"continue","steps":["a","b"]}'
  });
  await f.send(v2State({ parts: [reasoning] }));
  const row = f.page.locator('.goal-log-entry[data-log-id="part:reason-1"]');
  assert.equal(await row.count(), 1);
  assert.equal(await row.getAttribute('data-kind'), 'reasoning');
  const card = row.locator('.goal-log-reasoning');
  assert.equal(await card.count(), 1);
  assert.equal(await card.evaluate(node => node.open), false, 'completed reasoning starts collapsed');
  assert.match(await row.locator('.goal-log-reasoning-status').textContent(), /已思考/);
  assert.match(await row.locator('.thinking-title').textContent(), /Reason 思考/);
  assert.equal(await row.locator('.goal-log-reasoning-duration').textContent(), '11s');
  assert.match(await row.locator('.goal-log-reasoning-time').textContent(), /^\d{2}:\d{2}:\d{2}$/);
  const preview = row.locator('.goal-log-reasoning-preview');
  assert.equal(await preview.isVisible(), true);
  assert.match(await preview.textContent(), /先核对 下载流程 和重试策略/);
  assert.match(await preview.textContent(), /规划协议内容已折叠/);
  assert.doesNotMatch(await preview.textContent(), /intents|\*\*/);
  assert.equal(await row.locator('.goal-log-reasoning-more').textContent(), '展开阅读');
  const previewMetrics = await preview.evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) || 17 }));
  assert(previewMetrics.height <= previewMetrics.line * 2 + 2, `preview stays within two lines: ${JSON.stringify(previewMetrics)}`);

  await card.locator(':scope > .goal-log-reasoning-summary').click(); await f.frames();
  assert.equal(await card.evaluate(node => node.open), true);
  assert.equal(await preview.isVisible(), false, 'the preview yields to the full body');
  const body = row.locator('.goal-log-reasoning-body');
  assert.equal(await body.isVisible(), true);
  assert.equal(await row.locator('.goal-log-reasoning-body .md-content strong').first().textContent(), '下载流程');
  assert.equal(await row.locator('.goal-log-reasoning-body .md-content li').count(), 2);
  assert.equal(((await body.textContent()).match(/规划协议内容已折叠/g) || []).length, 2, 'both fenced and raw plan JSON fold');
  assert.doesNotMatch(await body.textContent(), /intents|"decision"/);

  // Manual collapse survives later updates for that entry.
  await card.locator(':scope > .goal-log-reasoning-summary').click(); await f.frames();
  assert.equal(await row.locator('.goal-log-reasoning').evaluate(node => node.open), false);
  await f.send(v2State({ parts: [{ ...reasoning, text: reasoning.text + '\n\n补充：缓存命中。' }] }));
  assert.equal(await row.locator('.goal-log-reasoning').evaluate(node => node.open), false, 'manual collapse persists across state updates');
  assert.match(await row.locator('.goal-log-reasoning-preview').textContent(), /补充：缓存命中/);
});

test('live reasoning auto-opens, appends while streaming and collapses when it settles', async t => {
  const f = await v2Fixture(t);
  const done = v2Reason('reason-done', { startedAt: v2Now - 20000, endedAt: v2Now - 15000, text: '规划完成。' });
  const tool = v2Tool('tool-1');
  const live = { id: 'reason-live', type: 'thinking', source: 'reason', status: 'running', startedAt: v2Now - 1000, text: '正在分析下载失败的原因。' };
  await f.send(v2State({ parts: [done, tool, live] }));
  const row = f.page.locator('.goal-log-entry[data-log-id="part:reason-live"]');
  const card = row.locator('.goal-log-reasoning');
  assert.equal(await card.evaluate(node => node.open), true, 'streaming reasoning opens itself');
  assert.equal(await row.getAttribute('data-status'), 'running');
  assert.match(await row.locator('.goal-log-reasoning-status').textContent(), /思考中/);
  assert.match(await row.locator('.goal-log-reasoning-body').textContent(), /正在分析下载失败的原因/);
  await f.send(v2State({ parts: [done, tool, { ...live, text: '正在分析下载失败的原因。\n\n已确认是重试超时。' }] }));
  assert.match(await row.locator('.goal-log-reasoning-body').textContent(), /已确认是重试超时/);
  await f.send(v2State({ parts: [done, tool, { ...live, text: '正在分析下载失败的原因。\n\n已确认是重试超时。', status: 'completed', endedAt: v2Now }] }));
  assert.equal(await card.evaluate(node => node.open), false, 'auto-opened live reasoning collapses when it settles');
  assert.match(await row.locator('.goal-log-reasoning-preview').textContent(), /已确认是重试超时/);
});

test('long reasoning bodies scroll inside the card and preserve the reader position', async t => {
  const f = await v2Fixture(t);
  const longText = Array.from({ length: 120 }, (_, index) => `步骤 ${index + 1}：检查下载、重试与窄屏布局是否一致。`).join('\n');
  const live = { id: 'reason-long', type: 'thinking', source: 'reason', status: 'running', startedAt: v2Now - 5000, text: longText };
  await f.send(v2State({ parts: [live] }));
  const body = f.page.locator('.goal-log-entry[data-log-id="part:reason-long"] .goal-log-reasoning-body');
  const metrics = await body.evaluate(node => ({ maxHeight: parseFloat(getComputedStyle(node).maxHeight), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
  assert(metrics.maxHeight <= 461, `bounded body height: ${JSON.stringify(metrics)}`);
  assert(metrics.scrollHeight > metrics.clientHeight + 40, 'long reasoning scrolls inside the card');
  assert.equal(await body.locator('.md-content').evaluate(node => node.textContent.includes('步骤 120')), true, 'content is never silently truncated');
  await body.evaluate(node => { node.scrollTop = 120; });
  const before = await body.evaluate(node => node.scrollTop);
  await f.send(v2State({ parts: [{ ...live, text: longText + '\n追加观察：缓存命中率提升。' }] }));
  assert.equal(Math.abs(await body.evaluate(node => node.scrollTop) - before) <= 2, true, 'live updates keep the inner reading position');
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await f.send(v2State({ parts: [{ ...live, text: longText + '\n追加观察：缓存命中率提升。\n继续观察重试间隔。' }] }));
  const atEnd = await body.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert(atEnd <= 4, 'a reader at the inner end keeps following');
});

test('consecutive Reason thinking merges into one row while a tool call breaks the sequence', async t => {
  const f = await v2Fixture(t);
  const parts = [
    v2Reason('r1', { startedAt: v2Now - 6000, endedAt: v2Now - 5800, text: '思考一：确认入口。' }),
    v2Reason('r2', { startedAt: v2Now - 5700, endedAt: v2Now - 5500, text: '思考二：检查依赖。' }),
    v2Reason('r3', { startedAt: v2Now - 5400, endedAt: v2Now - 5200, text: '思考三：核对窄屏。' }),
    v2Tool('t1', { startedAt: v2Now - 5000, endedAt: v2Now - 4800 }),
    v2Reason('r4', { startedAt: v2Now - 3000, endedAt: v2Now - 2800, text: '思考四：准备结论。' }),
    v2Reason('r5', { startedAt: v2Now - 2700, endedAt: v2Now - 2500, text: '思考五：汇总结果。' })
  ];
  await f.send(v2State({ parts }));
  assert.deepEqual(await v2RowIds(f.page), ['part:r1', 'part:t1', 'part:r4']);
  const preview = f.page.locator('.goal-log-entry[data-log-id="part:r1"] .goal-log-reasoning-preview');
  const text = await preview.textContent();
  for (const marker of ['思考一', '思考二', '思考三']) assert.match(text, new RegExp(marker));
  assert.doesNotMatch(text, /思考四/, 'a tool call ends the merged run');
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="part:r1"]').getAttribute('data-status'), 'completed');
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="part:r1"] .goal-log-reasoning-duration').textContent(), '0.8s');
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="part:r1"] .goal-log-reasoning-body').textContent(), '', 'collapsed cards do not build markdown');
});

test('timeline keeps plan, dispatch, execute and result in strict chronological order without phase bands', async t => {
  const f = await v2Fixture(t);
  const plan = v2Reason('plan', { startedAt: v2Now - 9000, endedAt: v2Now - 8000, text: '先规划下载流程。' });
  const worker = v2Worker('w-plan', { createdAt: v2Now - 7000 });
  const tool = v2Tool('t-phase', { startedAt: v2Now - 5000, endedAt: v2Now - 4000 });
  await f.send(v2State({ status: 'completed', busy: false, parts: [plan, tool], workers: [worker], result: { summary: '下载流程验证完成。' } }));
  assert.deepEqual(await v2RowIds(f.page), ['part:plan', 'worker:w-plan', 'part:t-phase', 'result']);
  assert.equal(await f.page.locator('#goal-output-content .goal-log-phase').count(), 0, 'the log is one chronological timeline, not phase bands');
  assert.equal(await v2Rows(f.page).count(), 4);
  // A single-phase log needs no dividers either.
  await f.send(v2State({ parts: [v2Tool('t-only')] }));
  assert.equal(await f.page.locator('#goal-output-content .goal-log-phase').count(), 0);
});

test('worker lifecycle renders as one dispatch row and keeps output in the worker panel', async t => {
  const f = await v2Fixture(t);
  const done = v2Worker('w-done', { status: 'completed', createdAt: v2Now - 9000, startedAt: v2Now - 8500, finishedAt: v2Now - 3000, result: '下载与重试流程验证通过。' });
  const running = v2Worker('w-running', { name: '检查界面交互', status: 'running', createdAt: v2Now - 2000 });
  const failed = v2Worker('w-failed', { name: '检查窄屏', status: 'failed', createdAt: v2Now - 1500, finishedAt: v2Now - 500, error: '子任务读取配置失败' });
  await f.send(v2State({ workers: [done, running, failed] }));
  assert.deepEqual(await v2RowIds(f.page), ['worker:w-done', 'worker:w-running', 'worker:w-failed']);
  const doneRow = f.page.locator('.goal-log-entry[data-log-id="worker:w-done"]');
  assert.equal(await doneRow.locator('.goal-log-state').textContent(), '已派发', 'legacy dispatch state stays available');
  assert.equal(await doneRow.locator('.goal-log-worker-status').getAttribute('data-status'), 'completed');
  assert.equal(await doneRow.locator('.goal-log-worker-status').textContent(), '已完成');
  assert.equal(await doneRow.locator('.goal-log-worker-duration').textContent(), '6.0s');
  assert.equal(await f.page.locator('.goal-log-worker-result').count(), 0, 'worker result output stays out of the Reason log');
  assert.equal(await f.page.locator('.goal-log-worker-error').count(), 0, 'worker error output stays out of the Reason log');
  await f.page.evaluate(() => { window.savedWorkerRow = document.querySelector('[data-log-id="worker:w-running"]'); });
  await f.page.locator('[data-log-id="worker:w-running"] .goal-log-worker').click(); await f.frames();
  assert.equal(await f.page.locator('#worker-panel').isVisible(), true, 'the worker name still opens the worker panel');
  await f.page.getByRole('button', { name: '关闭 Worker 详情' }).click(); await f.frames();
  await f.send(v2State({ workers: [done, { ...running, status: 'completed', finishedAt: v2Now, result: '交互检查完成。' }, failed] }));
  assert.equal(await f.page.evaluate(() => document.querySelector('[data-log-id="worker:w-running"]') === window.savedWorkerRow), true, 'the dispatch row is reused across status transitions');
  assert.equal(await f.page.locator('[data-log-id="worker:w-running"] .goal-log-worker-status').textContent(), '已完成');
  assert.equal(await f.page.locator('[data-log-id="worker:w-running"] .goal-log-worker-result').count(), 0);
  assert.equal(await f.page.locator('[data-log-id^="worker-end:"]').count(), 0, 'worker output does not create timeline rows');
});

test('worker thinking and tool output stay out of the Reason-only scheduling log', async t => {
  const f = await v2Fixture(t);
  const worker = v2Worker('w-private', { createdAt: v2Now - 6000, startedAt: v2Now - 5800, status: 'running', parts: [
    { id: 'think-1', type: 'thinking', source: 'worker', status: 'running', startedAt: v2Now - 5000, text: '仅 Worker 详情可见的思考。' },
    { id: 'tool-1', type: 'tool', name: 'read_workspace_file', status: 'completed', startedAt: v2Now - 4500, endedAt: v2Now - 4000, args: '{"path":"src/app.js"}', output: 'ok' }
  ] });
  await f.send(v2State({ workers: [worker] }));
  assert.deepEqual(await v2RowIds(f.page), ['worker:w-private']);
  assert.equal(await f.page.locator('[data-log-id^="worker-part:"]').count(), 0);
  const text = await f.page.locator('#goal-output-content').innerText();
  assert.doesNotMatch(text, /仅 Worker 详情可见的思考/);
  assert.doesNotMatch(text, /src\/app\.js/);
  assert.equal(await f.page.locator('[data-log-id="worker:w-private"]').getAttribute('data-worker'), 'w-private');
});

test('activity rows stay compact single-line records with visible status text', async t => {
  const f = await v2Fixture(t);
  const activities = [
    { label: 'Reason', status: 'running', timestamp: v2Now - 6000, key: 'plan-live' },
    { label: 'spawn_worker', status: 'completed', timestamp: v2Now - 5000, key: 'spawn' },
    { label: 'web_search', status: 'completed', timestamp: v2Now - 4000, key: 'search' },
    { label: 'todo', status: 'failed', timestamp: v2Now - 3000, key: 'todo' }
  ];
  await f.send(v2State({ activities }));
  const rows = f.page.locator('.goal-log-entry[data-kind="activity"]');
  assert.equal(await rows.count(), 4);
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.activity)), ['plan', 'dispatch', 'search', 'plan']);
  assert.deepEqual(await rows.locator('.goal-log-heading strong').allTextContents(), ['调度', '分派并行任务', '搜索网页', '更新任务']);
  const heights = await rows.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
  for (const height of heights) assert(height <= 30, `activity row stays compact: ${heights}`);
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.querySelector('.goal-log-body').children.length)), [0, 0, 0, 0]);
  assert.deepEqual(await rows.locator('.goal-log-state').allTextContents(), ['执行中', '已完成', '已完成', '执行失败']);
  const margins = await rows.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).marginTop));
  assert.deepEqual(margins, ['2px', '0px', '0px', '2px'], 'consecutive activity rows sit tight (plan bands keep their 2px rhythm)');
});

test('tool rows stay compact and expand into the full tool card', async t => {
  const f = await v2Fixture(t);
  const tool = v2Tool('tool-expand', { name: 'run_local_shell_command', args: '{"command":"npm run check"}', output: 'checks passed' });
  await f.send(v2State({ parts: [tool] }));
  const row = f.page.locator('.goal-log-entry[data-log-id="part:tool-expand"]');
  assert.equal(await row.getAttribute('data-kind'), 'tool');
  const summary = row.locator('.tool-card-summary');
  assert.equal(await summary.isVisible(), true);
  assert.equal(await row.locator('.tool-title').textContent(), '运行本地命令');
  const height = await summary.evaluate(node => Math.round(node.getBoundingClientRect().height));
  assert(height <= 30, `compact tool row height: ${height}`);
  await summary.click(); await f.frames();
  assert.equal(await row.locator('.tool-card').evaluate(node => node.open), true);
  assert.equal(await row.locator('.tool-output').isVisible(), true);
  assert.match(await row.locator('.tool-output').textContent(), /checks passed/);
  assert.equal(await row.getByRole('button', { name: '复制输出' }).isVisible(), true, 'copy actions keep working inside the log');
});

test('the header expand-all action toggles every reasoning card and hides without reasoning', async t => {
  const f = await v2Fixture(t);
  const toggle = f.page.locator('#goal-log-reason-toggle');
  await f.send(v2State({ parts: [v2Tool('t-only')] }));
  assert.equal(await toggle.isVisible(), false, 'no reasoning means no expand action');
  await f.send(v2State({ parts: [v2Reason('a', { text: '第一段推理。' }), v2Tool('t-mid'), v2Reason('b', { text: '第二段推理。' })] }));
  assert.equal(await toggle.isVisible(), true);
  assert.equal(await toggle.textContent(), '展开思考');
  await toggle.click(); await f.frames();
  assert.deepEqual(await f.page.locator('.goal-log-reasoning').evaluateAll(nodes => nodes.map(node => node.open)), [true, true]);
  assert.equal(await toggle.textContent(), '收起思考');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await toggle.click(); await f.frames();
  assert.deepEqual(await f.page.locator('.goal-log-reasoning').evaluateAll(nodes => nodes.map(node => node.open)), [false, false]);
  assert.equal(await toggle.textContent(), '展开思考');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
});

test('paging and follow keep working with the v2 rows', async t => {
  const f = await v2Fixture(t);
  const parts = Array.from({ length: 250 }, (_, index) => v2Reason('p' + index, {
    startedAt: v2Now - 5000 + index, endedAt: v2Now - 5000 + index + 1, text: '记录 ' + index + '：检查下载流程。'
  }));
  await f.send(v2State({ parts }));
  assert.equal(await v2Rows(f.page).count(), 120);
  assert.match(await f.page.locator('.goal-log-pager').textContent(), /250/);
  await f.page.getByRole('button', { name: '较早日志', exact: true }).click(); await f.frames();
  const first = await v2Rows(f.page).first().getAttribute('data-log-id');
  await f.send(v2State({ parts: [...parts, { id: 'extra', type: 'text', text: '最新追加输出。', status: 'streaming', startedAt: v2Now + 10000 }] }));
  assert.equal(await v2Rows(f.page).first().getAttribute('data-log-id'), first, 'the older page stays stable while live records arrive');
  assert.equal(await v2Rows(f.page).count(), 120);
  await f.page.locator('#goal-log-bottom').click(); await f.frames();
  assert.equal(await v2Rows(f.page).last().getAttribute('data-log-id'), 'part:extra');
  assert.match(await f.page.locator('#goal-output-content').textContent(), /最新追加输出/);
});

test('English locale translates reasoning, worker lifecycle and expand-all copy', async t => {
  const f = await v2Fixture(t);
  await f.send(v2State({
    parts: [v2Reason('en-plan', { text: '先检查配置。' }), v2Tool('en-tool')],
    workers: [v2Worker('en-worker', { status: 'created', createdAt: v2Now })]
  }));
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  await f.frames(); await f.frames();
  assert.equal(await f.page.locator('#goal-log-reason-toggle').textContent(), 'Expand thinking');
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="part:en-plan"] .goal-log-reasoning-status').textContent(), 'Thought');
  assert.match(await f.page.locator('.goal-log-entry[data-log-id="part:en-plan"] .goal-log-reasoning-more').textContent(), /Read more/);
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="worker:en-worker"] .goal-log-worker-status').textContent(), 'Dispatched');
});

test('v2 log renders in light, dark and 430px without sideways scroll', async t => {
  const f = await v2Fixture(t);
  const parts = [
    v2Reason('shot-plan', { status: 'running', startedAt: v2Now - 9000, text: '先确认 **下载流程** 与重试策略。\n\n- 检查缓存\n- 验证窄屏' }),
    v2Tool('shot-tool'),
    { id: 'shot-stream', type: 'text', text: '正在汇总检查结果。', status: 'streaming', startedAt: v2Now - 1000 }
  ];
  const workers = [v2Worker('shot-worker', { status: 'completed', finishedAt: v2Now - 2000, result: '下载验证通过。' })];
  const activities = [{ label: 'web_search', status: 'completed', timestamp: v2Now - 8000, key: 's' }];
  await f.send(v2State({ parts, workers, activities }));
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id="part:shot-stream"] .goal-log-state').textContent(), '输出中', 'streaming part rows describe their state');
  await f.page.screenshot({ path: v2Directory + '/light-expanded.png' });
  await f.page.locator('#goal-log-reason-toggle').click(); await f.frames();
  await f.page.screenshot({ path: v2Directory + '/light-collapsed.png' });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark')); await f.frames(); await f.frames();
  const darkBackground = await f.page.evaluate(() => getComputedStyle(document.getElementById('goal-output-content')).backgroundColor);
  assert.notEqual(darkBackground, 'rgba(0, 0, 0, 0)');
  await f.page.locator('#goal-log-reason-toggle').click(); await f.frames();
  await f.page.screenshot({ path: v2Directory + '/dark-expanded.png' });
  await f.page.locator('#goal-log-reason-toggle').click(); await f.frames();
  await f.page.screenshot({ path: v2Directory + '/dark-collapsed.png' });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.page.setViewportSize({ width: 430, height: 900 }); await f.frames(); await f.frames();
  const narrow = await f.page.evaluate(() => {
    const panel = document.querySelector('.goal-output-panel');
    const content = document.getElementById('goal-output-content');
    return {
      doc: document.documentElement.scrollWidth,
      panelScroll: panel.scrollWidth, panelClient: panel.clientWidth,
      contentScroll: content.scrollWidth, contentClient: content.clientWidth,
      title: document.getElementById('goal-output-title').textContent,
      summaryHeight: Math.round(document.querySelector('.goal-log-reasoning-summary').getBoundingClientRect().height)
    };
  });
  assert(narrow.doc <= 430, `no horizontal page scroll: ${narrow.doc}`);
  assert(narrow.panelScroll <= narrow.panelClient + 1, JSON.stringify(narrow));
  assert(narrow.contentScroll <= narrow.contentClient + 1, JSON.stringify(narrow));
  assert.match(narrow.title, /思考与调度日志/);
  assert(narrow.summaryHeight <= 64, 'reasoning rows stay compact at 430px');
  await f.page.screenshot({ path: v2Directory + '/narrow.png' });
});

