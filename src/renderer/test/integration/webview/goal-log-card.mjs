import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const screenshotDirectory = '.cache/goal-log-v5';
const now = Date.now();
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const thinkingPart = (id, overrides = {}) => ({
  id, type: 'thinking', source: 'reason', status: 'completed',
  startedAt: now - 9000, endedAt: now - 5000, text: '思考 ' + id, ...overrides
});
const toolPart = (id, overrides = {}) => ({
  id, type: 'tool', name: 'run_local_shell_command', args: '{"command":"npm run check"}',
  output: 'checks passed', status: 'completed', startedAt: now - 4000, endedAt: now - 3000, ...overrides
});
const textPart = (id, text, overrides = {}) => ({ id, type: 'text', status: 'completed', startedAt: now - 2000, text, ...overrides });
const worker = (id, overrides = {}) => ({
  id, name: '检查入口', description: '读取项目结构并核对入口。', status: 'completed',
  createdAt: now - 5000, startedAt: now - 4800, finishedAt: now - 3500, ...overrides
});
function goalState(execution = {}, overrides = {}) {
  return {
    type: 'state', mode: 'goal',
    conversation: { id: overrides.conversationId || execution.conversationId || 'goal-log-v5', title: overrides.title || '思考与调度日志' },
    goal: { objective: '审计目标站点响应头', criteria: [], notes: [] },
    messages: [], provider: { configured: true, connected: true, label: '测试模型' },
    context: {}, busy: execution.busy !== false,
    ...overrides,
    execution: {
      status: 'running', busy: true, phase: 'execute',
      parts: [], activities: [], workers: [],
      ...execution
    }
  };
}
async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce', ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && url !== 'http://goal-log-v5.test/') requests.push(url);
  });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  await page.route('**/*', route => {
    if (route.request().url() === 'http://goal-log-v5.test/') return route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'goal-log-v5' }) });
    return route.fulfill({ status: 204 });
  });
  await page.goto('http://goal-log-v5.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paint = async () => { await frames(); await frames(); };
  const send = async value => {
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), value);
    await paint();
  };
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the log must not throw page errors');
    assert.deepEqual(requests, [], 'the log must not fetch remote resources');
  });
  return { page, frames, paint, send };
}
const roundHeadings = page => page.locator('#goal-output-content .goal-log-round-heading');
const rowIds = page => page.locator('#goal-output-content .goal-log-entry').evaluateAll(rows => rows.map(row => row.dataset.logId));
const reasoningRow = (page, roundKey) => page.locator(`.goal-log-entry[data-kind="reasoning"]${roundKey ? `[data-round-key="${roundKey}"]` : ''}`);
// v7 round folding: header control state + how many of the round's rows are hidden.
const roundFoldState = (page, key) => page.evaluate(roundKey => {
  const header = document.querySelector(`.goal-log-round-heading[data-round-key="${roundKey}"]`);
  const rows = [...document.querySelectorAll(`.goal-log-entry[data-round-key="${roundKey}"]`)];
  const meta = header?.querySelector('.goal-log-round-meta');
  return {
    expanded: header?.getAttribute('aria-expanded'),
    collapsed: header?.dataset.collapsed,
    label: header?.getAttribute('aria-label'),
    meta: meta?.textContent ?? '',
    metaHidden: meta?.hidden ?? true,
    hidden: rows.filter(row => row.hidden).length,
    visible: rows.filter(row => !row.hidden).length
  };
}, key);
const archivedRound = (overrides = {}) => ({
  runId: 'fold-archived', startedAt: now - 20000, finishedAt: now - 15000, status: 'completed',
  parts: [
    thinkingPart('fa-think', { text: '第一轮思考内容。', startedAt: now - 20000, endedAt: now - 19000 }),
    textPart('fa-text', '第一轮结论：入口可用。', { startedAt: now - 18000 }),
    toolPart('fa-tool', { startedAt: now - 17000, endedAt: now - 16500 })
  ],
  activities: [{ label: 'spawn_worker', status: 'completed', timestamp: now - 16000, key: 'fa-spawn' }],
  workers: [worker('fa-worker', { finishedAt: now - 15500 })],
  ...overrides
});

test('masthead, compact scheduling rows and per-part rows replace the merged content block', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    parts: [
      thinkingPart('thinking-1', { text: '先确认重复 Worker 的覆盖范围。' }),
      textPart('conclusion-1', '结论：继续审计 CDN 回源配置，但先停掉重复的爬虫 Worker。', { source: 'reason' }),
      { id: 'stop-1', type: 'tool', name: 'stop_worker', status: 'completed', startedAt: now - 2000, endedAt: now - 1500, args: '{"worker":"n7","reason":"重复抓取"}', output: '{"stopped":true}' }
    ],
    activities: [{ label: 'Reason', status: 'running', timestamp: now - 6000, key: 'reason-live' }],
    workers: [worker('w-n4', { name: '枚举静态资源', description: '枚举静态资源。', status: 'running', finishedAt: undefined })]
  }));
  assert.equal(await f.page.locator('#goal-output-title').textContent(), '思考与调度日志');
  assert.equal(await f.page.locator('.goal-output-subtitle').textContent(), 'Reason 规划 · Worker 调度 · 工具活动');
  const header = await f.page.evaluate(() => {
    const heading = document.querySelector('#goal-output-panel .goal-output-heading');
    return {
      minHeight: getComputedStyle(heading).minHeight,
      padding: getComputedStyle(heading).padding,
      title: getComputedStyle(document.getElementById('goal-output-title')).fontSize,
      icon: getComputedStyle(document.querySelector('#goal-output-panel .goal-output-icon')).width,
      iconBorder: getComputedStyle(document.querySelector('#goal-output-panel .goal-output-icon')).borderTopWidth
    };
  });
  assert.deepEqual(header, { minHeight: '38px', padding: '7px 12px', title: '12.5px', icon: '20px', iconBorder: '0px' });
  const card = await f.page.locator('.goal-output-panel').evaluate(node => ({ radius: getComputedStyle(node).borderRadius, shadow: getComputedStyle(node).boxShadow }));
  assert.deepEqual(card, { radius: '12px', shadow: 'none' });

  // One reasoning line + individual rows for text/tool output (no merged block).
  assert.equal(await f.page.locator('.goal-log-content').count(), 0, 'no merged round content block');
  assert.equal(await reasoningRow(f.page).count(), 1);
  assert.match(await f.page.locator('.goal-log-entry[data-kind="reasoning"] .goal-log-reasoning-line').textContent(), /先确认重复 Worker 的覆盖范围/);
  const textRow = f.page.locator('.goal-log-entry[data-kind="text"]');
  assert.equal(await textRow.count(), 1);
  assert.match(await textRow.locator('.response-text').textContent(), /继续审计 CDN 回源配置/);
  assert.match(await textRow.locator('.goal-log-body').getAttribute('class'), /message-timeline/);
  const toolLine = f.page.locator('.goal-log-entry[data-kind="toolLine"]');
  assert.equal(await toolLine.count(), 1, 'a Reason scheduling tool folds into the scheduling line');
  assert.equal(await toolLine.locator('.tool-card').count(), 1);
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="tool"] .tool-group').count(), 0, 'task tool rows never use tool-group batching');
  assert.equal(await roundHeadings(f.page).count(), 1);
  assert.equal(await f.page.locator('.goal-log-round-title').textContent(), '第 1 轮');
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="activity"][data-activity="plan"]').count(), 1);
  const plan = await f.page.locator('.goal-log-entry[data-kind="activity"][data-activity="plan"]').evaluate(node => ({
    radius: getComputedStyle(node).borderRadius, padding: getComputedStyle(node).padding,
    border: getComputedStyle(node).borderTopWidth, shadow: getComputedStyle(node).boxShadow,
    paint: getComputedStyle(node).backgroundImage !== 'none' || getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'
  }));
  assert.deepEqual(plan, { radius: '6px', padding: '3px 10px', border: '0px', shadow: 'none', paint: false });
  assert.equal(await f.page.locator('.goal-log-task-card [data-worker-id="w-n4"]').count(), 1);
  // Narrow layout keeps the header on two compact rows and never scrolls sideways.
  await f.page.setViewportSize({ width: 430, height: 900 }); await f.paint();
  const narrow = await f.page.evaluate(() => {
    const panel = document.querySelector('.goal-output-panel');
    const contentNode = document.getElementById('goal-output-content');
    return {
      scroll: panel.scrollWidth, client: panel.clientWidth,
      contentScroll: contentNode.scrollWidth, contentClient: contentNode.clientWidth,
      subtitle: getComputedStyle(document.querySelector('.goal-output-subtitle')).display,
      buttonWidth: getComputedStyle(document.getElementById('goal-log-bottom')).width,
      buttonText: getComputedStyle(document.getElementById('goal-log-bottom')).fontSize
    };
  });
  assert(narrow.scroll <= narrow.client + 1, JSON.stringify(narrow));
  assert(narrow.contentScroll <= narrow.contentClient + 1, JSON.stringify(narrow));
  assert.equal(narrow.subtitle, 'none');
  assert.equal(narrow.buttonWidth, '24px');
  assert.equal(narrow.buttonText, '0px');
  // An empty log keeps the flat, quiet empty state.
  await f.send(goalState({ status: 'idle', busy: false }));
  assert.equal(await f.page.locator('#goal-output-content').isVisible(), false);
  const empty = await f.page.evaluate(() => {
    const node = document.getElementById('goal-output-empty');
    return {
      borderWidth: getComputedStyle(node).borderTopWidth,
      borderStyle: getComputedStyle(node).borderTopStyle,
      shadow: getComputedStyle(document.querySelector('.goal-output-panel')).boxShadow
    };
  });
  assert.deepEqual(empty, { borderWidth: '0px', borderStyle: 'none', shadow: 'none' });
});

test('a round reads narrative first, then its scheduling and execution rows', async t => {
  const f = await fixture(t);
  const base = 1000000;
  const part = (id, type, offset, extra = {}) => ({ id, type, startedAt: base + offset, status: 'completed', ...extra });
  await f.send(goalState({
    runId: 'chrono',
    parts: [
      { id: 'think', type: 'thinking', source: 'reason', status: 'running', startedAt: base, text: '先规划时间线。' },
      part('t1', 'text', 10, { text: '第一段文字。' }),
      part('tool2', 'tool', 20, { name: 'read_workspace_file', args: '{"path":"a.js"}', output: 'a', endedAt: base + 25 }),
      part('t3', 'text', 30, { text: '第二段文字。' }),
      part('tool4', 'tool', 40, { name: 'run_local_shell_command', args: '{"command":"npm test"}', output: 'ok', endedAt: base + 45 })
    ],
    activities: [{ label: 'web_search', status: 'completed', timestamp: base + 25, key: 'a1' }],
    workers: [worker('w1', { name: '检查入口', status: 'running', createdAt: base + 35, startedAt: base + 35, finishedAt: undefined })]
  }));
  assert.deepEqual(await rowIds(f.page), [
    'reason:chrono',
    'part:t1',
    'part:t3',
    'part:tool2',
    'activity:chrono:a1',
    'part:tool4'
  ], 'thinking and conclusions stay contiguous; scheduling and execution follow below the divider');
  const taskCard = f.page.locator('.goal-log-task-card').first();
  assert.equal(await taskCard.isVisible(), true);
  assert.equal(await taskCard.locator('[data-worker-id="w1"]').count(), 1, 'the Worker lives in the task card, not the timeline');
  const decision = f.page.locator('.goal-log-round-heading .goal-log-round-decision').first();
  assert.doesNotMatch(await decision.textContent(), /\[object Object\]/, 'decision chips never stringify a Worker array');
  assert.match(await decision.textContent(), /1 个任务/);
  const divider = f.page.locator('.goal-log-activity-divider').first();
  assert.equal(await divider.isVisible(), true);
  assert.match(await divider.textContent(), /调度与执行 · 3 条/);
  const toolRows = f.page.locator('.goal-log-entry[data-kind="tool"]');
  assert.equal(await toolRows.count(), 2);
  const cardsPerRow = await toolRows.evaluateAll(rows => rows.map(row => row.querySelectorAll('.tool-card').length));
  assert.deepEqual(cardsPerRow, [1, 1]);
  assert.equal(await f.page.locator('.tool-group').count(), 0);
  assert.equal(await f.page.locator('.goal-log-content').count(), 0);
  const textRows = f.page.locator('.goal-log-entry[data-kind="text"]');
  assert.equal(await textRows.count(), 2);
  const textContents = (await textRows.locator('.response-text').allTextContents()).map(value => value.trim());
  assert.deepEqual(textContents, ['第一段文字。', '第二段文字。']);
  // Streaming update: narrative rows stay contiguous and new activity still lands
  // below the divider; existing rows keep their DOM.
  const before = await rowIds(f.page);
  await f.page.evaluate(() => { window.savedToolRow = document.querySelector('[data-log-id="part:tool4"]'); });
  await f.send(goalState({
    runId: 'chrono',
    parts: [
      { id: 'think', type: 'thinking', source: 'reason', status: 'running', startedAt: base, text: '先规划时间线。' },
      part('t1', 'text', 10, { text: '第一段文字。' }),
      part('tool2', 'tool', 20, { name: 'read_workspace_file', args: '{"path":"a.js"}', output: 'a', endedAt: base + 25 }),
      part('t3', 'text', 30, { text: '第二段文字。' }),
      part('tool4', 'tool', 40, { name: 'run_local_shell_command', args: '{"command":"npm test"}', output: 'still ok', endedAt: base + 46, status: 'completed' }),
      part('t6', 'text', 60, { text: '第三段文字（流式追加）。' }),
      part('tool7', 'tool', 70, { name: 'list_workspace_files', args: '{}', output: 'files', endedAt: base + 75 })
    ],
    activities: [{ label: 'web_search', status: 'completed', timestamp: base + 25, key: 'a1' }],
    workers: [worker('w1', { name: '检查入口', status: 'running', createdAt: base + 35, startedAt: base + 35, finishedAt: undefined })]
  }));
  const after = await rowIds(f.page);
  assert.deepEqual(after, [
    'reason:chrono',
    'part:t1',
    'part:t3',
    'part:t6',
    'part:tool2',
    'activity:chrono:a1',
    'part:tool4',
    'part:tool7'
  ], 'new narrative rows still precede the activity group');
  assert.ok(before.length + 2 === after.length);
  assert.equal(await f.page.evaluate(() => document.querySelector('[data-log-id="part:tool4"]') === window.savedToolRow), true, 'tool updates keep the same card row');
  await f.page.locator('[data-log-id="part:tool4"] .tool-card > summary').click(); await f.paint();
  assert.match(await f.page.locator('[data-log-id="part:tool4"] .tool-output').textContent(), /still ok/);
  // Once thinking finishes the narrative still stays at the top of the round.
  await f.send(goalState({
    runId: 'chrono',
    parts: [
      { id: 'think', type: 'thinking', source: 'reason', status: 'completed', startedAt: base, endedAt: base + 80, text: '先规划时间线。' },
      part('t1', 'text', 10, { text: '第一段文字。' })
    ]
  }));
  assert.deepEqual(await rowIds(f.page), ['reason:chrono', 'part:t1'], 'completed thinking keeps its narrative position');
});

test('the reasoning line keeps changing while streaming and never auto-opens', async t => {
  const f = await fixture(t);
  const lines = [
    '先核对 **下载流程**。',
    '先核对 **下载流程**。\n\n```json\n{"intents":[{"id":"n1","goal":"下载"}],"decision":"retry"}\n```',
    '先核对 **下载流程**。\n\n```json\n{"intents":[{"id":"n1","goal":"下载"}],"decision":"retry"}\n```\n\n最新观察：' + '缓存命中率提升，准备继续验证重试间隔与下载流程是否稳定。'.repeat(8)
  ];
  await f.send(goalState({ parts: [thinkingPart('live', { status: 'running', startedAt: now - 300, endedAt: undefined, text: lines[0] })] }));
  const row = reasoningRow(f.page);
  const details = row.locator('.goal-log-reasoning');
  const line = row.locator('.goal-log-reasoning-line');
  assert.equal(await details.evaluate(node => node.open), false, 'the reasoning line starts collapsed');
  const firstText = await line.textContent();
  assert.match(firstText, /先核对/);
  assert.doesNotMatch(firstText, /\*\*/, 'preview strips Markdown markers');
  assert.equal(await row.locator('.goal-log-reasoning-state').textContent(), '思考中');
  assert.match(await row.locator('.goal-log-reasoning-duration').textContent(), /^\d+(\.\d+)?s$/);
  assert.equal(await row.getAttribute('data-status'), 'running');
  assert.equal(await f.page.locator('.goal-log-entry .thinking-card:not(.summary-card)').count(), 0, 'no thinking card anywhere in the goal log');
  await f.page.evaluate(() => { window.savedReasoningRow = document.querySelector('.goal-log-entry[data-kind="reasoning"]'); });
  for (const text of lines.slice(1)) {
    await f.send(goalState({ parts: [thinkingPart('live', { status: 'running', startedAt: now - 300, endedAt: undefined, text })] }));
    assert.equal(await details.evaluate(node => node.open), false, 'a streaming tick never expands the line');
    assert.equal(await f.page.evaluate(() => document.querySelector('.goal-log-entry[data-kind="reasoning"]') === window.savedReasoningRow), true, 'the line row is reused across ticks');
  }
  const latest = await line.textContent();
  assert.notEqual(latest, firstText, 'the line content changes as reasoning streams');
  assert.match(latest, /缓存命中率提升/);
  assert.doesNotMatch(latest, /intents|"decision"|```/, 'protocol/JSON/fences never leak into the line');
  assert(latest.length <= 160, `line is clamped: ${latest.length}`);
  const measureLine = () => row.evaluate(node => {
    const summary = node.querySelector('.goal-log-reasoning-summary');
    const lineNode = node.querySelector('.goal-log-reasoning-line');
    const meta = node.querySelector('.goal-log-reasoning-meta');
    const summaryRect = summary.getBoundingClientRect(), lineRect = lineNode.getBoundingClientRect(), metaRect = meta.getBoundingClientRect();
    return {
      row: Math.round(node.getBoundingClientRect().height),
      summary: Math.round(summaryRect.height),
      sameRow: Math.abs(lineRect.top - metaRect.top) <= 2,
      metaInside: metaRect.right <= summaryRect.right + 1,
      overflow: lineNode.scrollWidth > lineNode.clientWidth + 1,
      ellipsis: getComputedStyle(lineNode).textOverflow,
      whiteSpace: getComputedStyle(lineNode).whiteSpace
    };
  });
  const wide = await measureLine();
  assert(wide.row <= 30, `reasoning row stays one compact line at 1100px: ${JSON.stringify(wide)}`);
  assert(wide.sameRow && wide.metaInside, 'metadata sits inline on the same row');
  assert(wide.overflow, 'long preview text is ellipsized, not wrapped');
  assert.deepEqual([wide.ellipsis, wide.whiteSpace], ['ellipsis', 'nowrap']);
  await f.page.setViewportSize({ width: 430, height: 900 }); await f.paint();
  const narrowLine = await measureLine();
  assert(narrowLine.row <= 30, `reasoning row stays one compact line at 430px: ${JSON.stringify(narrowLine)}`);
  assert(narrowLine.sameRow && narrowLine.overflow, 'metadata stays beside an ellipsized line at 430px');
  await f.page.setViewportSize({ width: 1180, height: 900 }); await f.paint();
  assert.equal(await line.evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion disables the shimmer');
  await f.page.emulateMedia({ reducedMotion: 'no-preference' }); await f.paint();
  assert.equal(await line.evaluate(node => getComputedStyle(node).animationName), 'goal-log-reasoning-sweep', 'running line has a neutral shimmer');
  await f.page.emulateMedia({ reducedMotion: 'reduce' });
});

test('clicking the reasoning line expands full Markdown; manual state survives ticks', async t => {
  const f = await fixture(t);
  const full = '第一段：核对入口。\n\n第二段：**缓存命中**，继续验证。\n\n```json\n{"decision":"continue","steps":["a","b"]}\n```';
  await f.send(goalState({ parts: [thinkingPart('expand', { status: 'running', startedAt: now - 300, endedAt: undefined, text: full })] }));
  const row = reasoningRow(f.page);
  const details = row.locator('.goal-log-reasoning');
  await row.locator('.goal-log-reasoning-summary').click(); await f.paint();
  await f.page.screenshot({ path: screenshotDirectory + '/reasoning-open.png' });
  assert.equal(await details.evaluate(node => node.open), true, 'clicking the line expands it');
  const markdown = row.locator('.goal-log-reasoning-markdown');
  assert.equal(await markdown.evaluate(node => node.classList.contains('md-content')), true);
  assert.match(await markdown.textContent(), /缓存命中/);
  assert.match(await markdown.textContent(), /规划协议内容已折叠/, 'plan protocols are folded in the body');
  await f.send(goalState({ parts: [thinkingPart('expand', { status: 'running', startedAt: now - 300, endedAt: undefined, text: full + '\n\n第三段：追加观察。' })] }));
  assert.match(await markdown.textContent(), /第三段：追加观察/);
  assert.equal(await details.evaluate(node => node.open), true, 'manual expansion survives ticks');
  await row.locator('.goal-log-reasoning-summary').click(); await f.paint();
  await f.send(goalState({ parts: [thinkingPart('expand', { status: 'running', startedAt: now - 300, endedAt: undefined, text: full + '\n\n第三段：追加观察。\n\n第四段：继续。' })] }));
  assert.equal(await details.evaluate(node => node.open), false, 'manual collapse survives ticks');
  await f.send(goalState({ parts: [thinkingPart('expand', { status: 'completed', startedAt: now - 300, endedAt: now - 100, text: full + '\n\n第四段：继续。' })] }));
  assert.equal(await row.locator('.goal-log-reasoning-state').textContent(), '已思考');
  await row.locator('.goal-log-reasoning-summary').click(); await f.paint();
  assert.match(await markdown.textContent(), /第四段：继续/);
});

test('Reason scheduling tools merge into one expandable line instead of piling cards', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    parts: [
      thinkingPart('merge-think'),
      { id: 'merge-tool-1', type: 'tool', name: 'list_workers', source: 'reason', status: 'completed',
        args: '{}', output: '{"workers":[]}', startedAt: now - 3000, endedAt: now - 2800 },
      { id: 'merge-tool-2', type: 'tool', name: 'wait_worker_sleep', source: 'reason', status: 'completed',
        args: '{"seconds":30}', output: '{"slept_seconds":30}', startedAt: now - 2700, endedAt: now - 2200 },
      textPart('merge-text', '调度结论：继续验证缓存。', { source: 'reason', startedAt: now - 2000 })
    ]
  }));
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="tool"]').count(), 0, 'Reason tools no longer become standalone cards');
  const line = f.page.locator('.goal-log-entry[data-kind="toolLine"]');
  assert.equal(await line.count(), 1, 'they merge into one scheduling line');
  assert.match(await line.locator('.goal-log-toolline-names').textContent(), /检查协作进展/);
  assert.equal(await line.locator('.goal-log-toolline-body .tool-card').count(), 2, 'expanding the line still shows both tool cards');
  assert.equal(await line.locator('.tool-group').count(), 0, 'scheduling calls never nest a redundant tool group');
  assert.equal(await line.locator('.parallel-tools').count(), 0, 'scheduling calls stay one flat audit list');
  await line.locator('.goal-log-toolline-summary').click(); await f.paint();
  await f.page.screenshot({ path: screenshotDirectory + '/toolline-open.png' });
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="text"][data-source="reason"]').count(), 1, 'prose keeps its own row');
  // A second tick must diff the line's signature without throwing (regression:
  // a string signature was passed to the array-based `equal` helper).
  await f.send(goalState({
    parts: [
      thinkingPart('merge-think', { status: 'completed', endedAt: now - 1000 }),
      { id: 'merge-tool-1', type: 'tool', name: 'list_workers', source: 'reason', status: 'completed',
        args: '{}', output: '{"workers":[{"worker":"n2"}]}', startedAt: now - 3000, endedAt: now - 2800 },
      { id: 'merge-tool-2', type: 'tool', name: 'wait_worker_sleep', source: 'reason', status: 'completed',
        args: '{"seconds":30}', output: '{"slept_seconds":30}', startedAt: now - 2700, endedAt: now - 2200 },
      textPart('merge-text', '调度结论：继续验证缓存。', { source: 'reason', startedAt: now - 2000 })
    ]
  }));
  assert.equal(await line.count(), 1, 'streaming ticks update the same merged line');
  assert.match(await line.locator('.goal-log-toolline-names').textContent(), /检查协作进展/);
});

test('scheduling calls render as a flat compact audit list', async t => {
  const f = await fixture(t);
  const base = now - 6000;
  const tool = (index, name, extra = {}) => ({
    id: 'audit-tool-' + index, type: 'tool', name, source: 'reason', status: 'completed',
    args: '{}', output: '{}', startedAt: base + index * 500, endedAt: base + index * 500 + 300, ...extra
  });
  await f.send(goalState({
    parts: [
      thinkingPart('audit-think', { startedAt: base - 1000, endedAt: base - 500 }),
      tool(0, 'list_workers'), tool(1, 'wait_worker_sleep', { args: '{"seconds":30}' }),
      tool(2, 'exploration_graph'), tool(3, 'exploration_todo'),
      tool(4, 'start_worker', { args: '{"worker":"n4"}' }), tool(5, 'prompt_worker', { args: '{"worker":"n4","message":"继续"}' })
    ]
  }));
  const line = f.page.locator('.goal-log-entry[data-kind="toolLine"]');
  await line.locator('.goal-log-toolline-summary').click(); await f.paint();
  const body = line.locator('.goal-log-toolline-body');
  assert.equal(await body.locator('.tool-card').count(), 6);
  assert.equal(await body.locator('.tool-title').nth(1).textContent(), '等待 Worker 进展');
  assert.equal(await body.locator('.tool-title').nth(2).textContent(), '查看探索图');
  assert.equal(await body.locator('.tool-title').nth(3).textContent(), '更新探索任务');
  assert.equal(await body.locator('.tool-group').count(), 0, 'no nested tool group in a scheduling call');
  assert.equal(await body.locator('.parallel-tools').count(), 0, 'no parallel-tools wrapper in a scheduling call');
  const gaps = await body.evaluate(node => {
    const cards = [...node.querySelectorAll('.tool-card')];
    return cards.slice(1).map((card, index) => Math.round(card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom));
  });
  assert.ok(gaps.every(gap => gap >= 0 && gap <= 6), `tool rows stay a tight list: ${JSON.stringify(gaps)}`);
  await f.page.screenshot({ path: screenshotDirectory + '/toolline-many.png' });
});

test('round header summarizes decision-bearing tool arguments', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'decision-summary',
    parts: [
      thinkingPart('decision-think'),
      { id: 'decision-call', type: 'tool', name: 'submit_decision', source: 'reason', status: 'completed',
        args: JSON.stringify({ wait: true, intents: [{ description: '检查入口' }, { description: '验证越权' }] }),
        output: '{"accepted":true}', startedAt: now - 3000, endedAt: now - 2900 },
      { id: 'decision-start', type: 'tool', name: 'start_worker', source: 'reason', status: 'completed',
        args: '{"worker":"n2"}', output: '{"worker":"n2"}', startedAt: now - 2800, endedAt: now - 2700 }
    ]
  }));
  const decision = f.page.locator('.goal-log-round-heading .goal-log-round-decision').first();
  assert.equal(await decision.isVisible(), true);
  const text = await decision.textContent();
  assert.match(text, /等待/);
  assert.match(text, /2 个意图/);
  assert.match(text, /2 个工具/);
});

test('log toolbar filters, searches and copies without changing the record set', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'toolbar',
    parts: [
      thinkingPart('toolbar-think'),
      textPart('toolbar-text', '本轮结论：入口可继续验证。', { source: 'reason' }),
      { id: 'toolbar-fail', type: 'tool', name: 'run_linux_ssh_command', status: 'failed',
        args: '{"command":"curl"}', output: '', error: '连接超时', startedAt: now - 2000, endedAt: now - 1900 }
    ]
  }));
  const entries = f.page.locator('#goal-output-content .goal-log-entry');
  const total = await entries.count();
  assert.ok(total >= 3, 'fixture must render thinking, conclusion and a failed tool');
  assert.equal(await f.page.locator('#goal-output-count').textContent(), `${total} 条记录`);

  await f.page.locator('.goal-log-filter').selectOption('anomaly');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry:visible').count(), 1, 'only the failed row stays visible');
  assert.match(await f.page.locator('.goal-log-match').textContent(), /显示 1 条/);

  await f.page.locator('.goal-log-filter').selectOption('all');
  await f.page.locator('.goal-log-search').fill('ssh');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry:visible').count(), 1, 'search narrows to the matching tool row');
  await f.page.locator('.goal-log-search').fill('');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry:visible').count(), total);
  assert.equal(await f.page.locator('#goal-output-count').textContent(), `${total} 条记录`, 'filtering never changes the record count');

  await f.page.locator('.goal-log-search').fill('绝不存在的内容');
  assert.equal(await f.page.locator('.goal-log-filter-empty').isVisible(), true, 'zero matches explains itself');
  await f.page.locator('.goal-log-clear-filter').click();
  assert.equal(await f.page.locator('.goal-log-filter-empty').isVisible(), false);
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry:visible').count(), total);

  await f.page.locator('.goal-log-copy').click();
  const copied = await f.page.evaluate(() => window.hostMessages.filter(message => message?.action === 'copyText'));
  assert.equal(copied.length, 1);
  assert.match(copied[0].text, /本轮结论：入口可继续验证/);
  assert.match(copied[0].text, /curl/);
});

test('search covers matches outside the current page', async t => {
  const f = await fixture(t);
  const parts = Array.from({ length: 150 }, (_, index) => textPart('page-' + index,
    index === 0 ? 'older needle from the first page' : 'row ' + index,
    { startedAt: now - 200000 + index * 100 }));
  await f.send(goalState({ runId: 'search-pages', parts }));
  assert.equal(await f.page.locator('#goal-output-count').textContent(), '150 条记录');
  await f.page.locator('.goal-log-search').fill('older needle');
  const visible = f.page.locator('#goal-output-content .goal-log-entry:visible');
  assert.equal(await visible.count(), 1, 'filtering searches the whole bounded log, not only the visible page');
  assert.match(await visible.locator('.response-text').textContent(), /older needle/);
});

test('the task card announces creation and final completion only', async t => {
  const f = await fixture(t);
  const base = now;
  const quiet = overrides => worker('w-quiet', {
    status: 'created', createdAt: base - 8000, startedAt: base - 7900, finishedAt: undefined, ...overrides
  });
  const sendWorker = workers => f.send(goalState({
    runId: 'quiet-worker',
    parts: [thinkingPart('quiet-think', { startedAt: base - 9000, endedAt: base - 8500, text: '派发并等待入口检查。' })],
    workers
  }));
  await sendWorker([quiet({})]);
  const card = f.page.locator('.goal-log-task-card');
  assert.equal(await card.isVisible(), true);
  assert.match(await card.locator('.goal-log-task-summary').textContent(), /检查入口/);
  await card.locator('.goal-log-task-summary').click(); await f.paint();
  const row = card.locator('[data-worker-id="w-quiet"]');
  assert.equal(await row.locator('.goal-log-task-status').textContent(), '已派发');
  assert.equal((await row.locator('.goal-log-task-duration').textContent()).trim(), '', 'a dispatched Worker has no live duration in the log');

  await sendWorker([quiet({ status: 'running' })]);
  assert.equal(await row.locator('.goal-log-task-status').textContent(), '已派发', 'running never becomes a log status');
  assert.doesNotMatch(await row.textContent(), /运行中|等待中/);

  await sendWorker([quiet({ status: 'waiting' })]);
  assert.equal(await row.locator('.goal-log-task-status').textContent(), '已派发', 'waiting never becomes a log status');

  await sendWorker([quiet({ status: 'completed', finishedAt: base - 1000, result: '入口验证通过。' })]);
  assert.equal(await row.locator('.goal-log-task-status').textContent(), '已完成');
  assert.match(await row.locator('.goal-log-task-duration').textContent(), /\d/);
  assert.match(await row.locator('.goal-log-task-result').textContent(), /入口验证通过/);
});

test('a worker-only historical round keeps its task card', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'live-after-history',
    parts: [thinkingPart('after-history-live')],
    logHistory: [{
      runId: 'history-tasks', startedAt: now - 20000, finishedAt: now - 15000, status: 'completed',
      parts: [], activities: [],
      workers: [{
        id: 'history-worker', name: '历史任务', description: '历史任务描述', status: 'completed',
        createdAt: now - 19000, startedAt: now - 18500, finishedAt: now - 16000
      }]
    }]
  }));
  const card = f.page.locator('.goal-log-task-card[data-round-key="history-tasks"]');
  assert.equal(await card.count(), 1, 'a historical round with only workers must not disappear');
  assert.match(await card.locator('.goal-log-task-summary').textContent(), /历史任务/);
  assert.equal(await f.page.locator('.goal-log-entry[data-log-id^="tasks:"]').count(), 0, 'the paging marker never renders as a row');
});

test('malformed archived history is skipped without breaking the log', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'bad-history',
    parts: [thinkingPart('bad-history-live')],
    logHistory: [null, {}, { runId: 'broken', startedAt: now, parts: 'not-an-array' }, { runId: 'partial', startedAt: now - 1000, parts: [null, { id: 'ok', type: 'text', text: '可恢复的一段历史。', status: 'completed' }] }]
  }));
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="reasoning"]').count(), 1, 'live round still renders');
  assert.match(await f.page.locator('#goal-output-content').textContent(), /可恢复的一段历史/, 'valid archived parts still restore');
});

test('host-archived rounds restore previous thinking and results after a new run', async t => {
  const f = await fixture(t);
  const archived = {
    runId: 'history-1', startedAt: now - 20000, finishedAt: now - 15000, status: 'completed',
    parts: [
      thinkingPart('h-think', { text: '历史思考内容。', startedAt: now - 20000, endedAt: now - 19000 }),
      textPart('h-result', '历史结论：入口可用。', { startedAt: now - 18000 })
    ],
    activities: [], workers: [], result: { summary: '历史总结' }
  };
  await f.send(goalState({
    runId: 'live-1', parts: [thinkingPart('live-think', { text: '当前思考。' })],
    logHistory: [archived]
  }));
  assert.equal(await roundHeadings(f.page).count(), 2);
  assert.deepEqual(await f.page.locator('.goal-log-round-title').allTextContents(), ['第 1 轮', '第 2 轮']);
  const archivedReason = f.page.locator('.goal-log-entry[data-kind="reasoning"][data-round-key="history-1"]');
  assert.match(await archivedReason.textContent(), /历史思考内容/);
  const archivedResult = f.page.locator('.goal-log-entry[data-kind="text"][data-log-id="part:h-result"] .response-text');
  assert.match(await archivedResult.textContent(), /历史结论：入口可用/);
  assert.match(await f.page.locator('.goal-log-entry[data-kind="text"][data-log-id="result:history-1"] .response-text').textContent(), /历史总结/);
});

test('rounds stack, archived row DOM is untouched and reasoning stays expandable', async t => {
  const f = await fixture(t);
  const roundOne = [
    thinkingPart('r1-think', { text: '第一轮先核对入口。\n\n第一轮结论已出。' }),
    textPart('r1-text', '第一轮结论：入口可用。', { startedAt: now - 3000 }),
    toolPart('r1-tool', { startedAt: now - 2500, endedAt: now - 2400 })
  ];
  await f.send(goalState({ runId: 'run-1', parts: roundOne }));
  await f.send(goalState({ runId: 'run-1', status: 'completed', busy: false, parts: roundOne }));
  await f.send(goalState({ runId: 'run-2', status: 'running', busy: true, parts: [] }));
  await f.send(goalState({ runId: 'run-2', status: 'running', busy: true, parts: [thinkingPart('r2-think', { status: 'running', startedAt: now - 300, endedAt: undefined, text: '第二轮正在分析。' })] }));
  assert.equal(await roundHeadings(f.page).count(), 2);
  assert.deepEqual(await f.page.locator('.goal-log-round-title').allTextContents(), ['第 1 轮', '第 2 轮']);
  assert.deepEqual(await f.page.locator('.goal-log-round-status').allTextContents(), ['已完成', '执行中']);
  assert.match(await reasoningRow(f.page, 'run-1').locator('.goal-log-reasoning-line').textContent(), /第一轮结论已出/);
  assert.match(await f.page.locator('.goal-log-entry[data-kind="text"][data-round-key="run-1"] .response-text').textContent(), /第一轮结论：入口可用/);
  await f.page.evaluate(() => {
    window.archivedMutations = 0;
    const node = document.querySelector('.goal-log-entry[data-kind="reasoning"][data-round-key="run-1"]');
    new MutationObserver(records => { window.archivedMutations += records.length; }).observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await f.send(goalState({ runId: 'run-2', status: 'running', busy: true, parts: [thinkingPart('r2-think', { status: 'running', startedAt: now - 300, endedAt: undefined, text: '第二轮正在分析。\n\n第二轮继续。' })] }));
  assert.equal(await f.page.evaluate(() => window.archivedMutations), 0, 'archived reasoning line DOM is untouched by live ticks');
  await reasoningRow(f.page, 'run-1').locator('.goal-log-reasoning-summary').click(); await f.paint();
  assert.match(await reasoningRow(f.page, 'run-1').locator('.goal-log-reasoning-markdown').textContent(), /第一轮结论已出/);
  await f.send(goalState({ runId: 'run-3', status: 'running', busy: true, parts: [thinkingPart('r3-think', { status: 'running', startedAt: now - 200, endedAt: undefined, text: '第三轮尚未结束。' })] }));
  await f.send(goalState({ runId: 'run-4', status: 'running', busy: true, parts: [] }));
  assert.equal(await f.page.locator('.goal-log-round-heading[data-round-key="run-3"] .goal-log-round-status').textContent(), '已停止');
  assert.equal(await reasoningRow(f.page, 'run-3').getAttribute('data-status'), 'completed');
});

test('the header action expands and collapses reasoning bodies across visible rounds', async t => {
  const f = await fixture(t);
  await f.send(goalState({ runId: 'expand-a', status: 'completed', busy: false, parts: [thinkingPart('a', { text: '第一轮思考。' })] }));
  await f.send(goalState({ runId: 'expand-b', status: 'completed', busy: false, parts: [thinkingPart('b', { text: '第二轮思考。' })] }));
  const toggle = f.page.locator('#goal-log-reason-toggle');
  assert.equal(await toggle.isVisible(), true);
  assert.equal(await toggle.textContent(), '展开思考');
  await toggle.click(); await f.paint();
  assert.deepEqual(await f.page.locator('.goal-log-reasoning').evaluateAll(nodes => nodes.map(node => node.open)), [true, true]);
  assert.equal(await toggle.textContent(), '收起思考');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.match(await f.page.locator('.goal-log-entry[data-kind="reasoning"] .goal-log-reasoning-markdown').first().textContent(), /第一轮思考/);
  await toggle.click(); await f.paint();
  assert.deepEqual(await f.page.locator('.goal-log-reasoning').evaluateAll(nodes => nodes.map(node => node.open)), [false, false]);
  assert.equal(await toggle.textContent(), '展开思考');
  await f.send(goalState({ conversationId: 'goal-log-v5-other', runId: 'other', status: 'idle', busy: false }));
  assert.equal(await toggle.isVisible(), false);
  assert.equal(await roundHeadings(f.page).count(), 0);
});

test('assist parity for text/tool/summary rows and individual tool card actions', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    parts: [
      thinkingPart('p-think', { text: '先核对 **下载流程**。' }),
      toolPart('p-tool-1', { startedAt: now - 4000, endedAt: now - 3500 }),
      textPart('p-text', '结论：**入口可用**，继续验证。', { source: 'reason', startedAt: now - 3000 }),
      { id: 'p-tool-2', type: 'tool', name: 'read_workspace_file', args: '{"path":"b.js"}', output: 'b', status: 'completed', startedAt: now - 2500, endedAt: now - 2000 },
      { id: 'p-summary', type: 'summary', status: 'completed', startedAt: now - 1000, endedAt: now - 500, text: '上下文摘要完成。', beforeTokens: 12000, afterTokens: 3000 }
    ]
  }));
  const textRow = f.page.locator('.goal-log-entry[data-kind="text"]');
  assert.equal(await textRow.count(), 1);
  assert.match(await textRow.locator('.goal-log-body').getAttribute('class'), /message-timeline/);
  assert.equal(await textRow.locator('.response-text strong').first().textContent(), '入口可用');
  const toolRows = f.page.locator('.goal-log-entry[data-kind="tool"]');
  assert.equal(await toolRows.count(), 2, 'each tool part keeps its own row');
  assert.equal(await f.page.locator('.tool-group').count(), 0, 'no multi-tool group');
  assert.equal(await f.page.locator('.goal-log-content').count(), 0);
  assert.equal(await f.page.locator('.goal-log-entry .thinking-card:not(.summary-card)').count(), 0, 'reason thinking never renders as a card');
  assert.equal(await f.page.locator('.goal-log-entry[data-kind="summary"] .summary-card').count(), 1, 'summary parts keep the assist maintenance card');
  assert.equal(await toolRows.nth(0).locator('.tool-title').textContent(), '运行本地命令');
  await toolRows.nth(0).locator('.tool-card > summary').click(); await f.paint();
  assert.equal(await toolRows.nth(0).locator('.tool-card').evaluate(node => node.open), true);
  assert.equal(await toolRows.nth(0).locator('.tool-output').isVisible(), true);
  assert.match(await toolRows.nth(0).locator('.tool-output').textContent(), /checks passed/);
  assert.equal(await toolRows.nth(0).getByRole('button', { name: '复制输出' }).isVisible(), true);
  assert.match(await f.page.locator('.goal-log-entry[data-kind="reasoning"] .goal-log-reasoning-sr').textContent(), /先核对/);
});

test('worker lifecycle, private thinking and compact activity labels are preserved', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    parts: [
      thinkingPart('p-1', { text: '调度思考。' }),
      { id: 'private-worker', type: 'thinking', source: 'worker', status: 'running', text: '仅 Worker 详情可见' },
      textPart('p-text', '调度结论。')
    ],
    activities: [
      { label: 'Reason', status: 'completed', timestamp: now - 8000, key: 'a-plan' },
      { label: 'spawn_worker', status: 'completed', timestamp: now - 7000, key: 'a-spawn' },
      { label: 'web_search', status: 'completed', timestamp: now - 6500, key: 'a-search' }
    ],
    workers: [
      worker('w-ok', { result: '入口验证通过。' }),
      worker('w-fail', { name: '检查窄屏', status: 'failed', finishedAt: now - 2500, error: '子任务读取配置失败' })
    ]
  }));
  const text = await f.page.locator('#goal-output-content').textContent();
  assert.doesNotMatch(text, /仅 Worker 详情可见/, 'private worker thinking stays out of the log');
  assert.equal(await f.page.locator('[data-log-id="part:private-worker"]').count(), 0);
  const activities = f.page.locator('.goal-log-entry[data-kind="activity"]');
  assert.equal(await activities.count(), 3);
  assert.deepEqual(await activities.evaluateAll(nodes => nodes.map(node => node.dataset.activity)), ['plan', 'dispatch', 'search']);
  const heights = await activities.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
  for (const height of heights) assert(height <= 30, `compact activity row: ${heights}`);
  assert.deepEqual(await activities.locator('.goal-log-heading strong').allTextContents(), ['调度', '分派并行任务', '搜索网页']);
  const card = f.page.locator('.goal-log-task-card');
  assert.equal(await card.isVisible(), true, 'dispatched Workers live in a dedicated card');
  assert.match(await card.locator('.goal-log-task-summary').textContent(), /2\/2 完成/);
  await card.locator('.goal-log-task-summary').click(); await f.paint();
  const okRow = card.locator('[data-worker-id="w-ok"]');
  assert.equal(await okRow.locator('.goal-log-task-status').textContent(), '已完成');
  assert.match(await okRow.locator('.goal-log-task-result').textContent(), /入口验证通过/);
  const failedRow = card.locator('[data-worker-id="w-fail"]');
  assert.match(await failedRow.locator('.goal-log-task-status').textContent(), /失败/);
  assert.match(await failedRow.locator('.goal-log-task-error').textContent(), /读取配置失败/);
  await okRow.locator('.goal-log-task-name').click();
  await f.paint();
  assert.equal(await f.page.locator('#worker-panel').isVisible(), true, 'worker name button still opens the detail panel');
  await f.page.getByRole('button', { name: '关闭 Worker 详情' }).click();
});

test('paging and follow keep working with individual chronological rows', async t => {
  const f = await fixture(t);
  const roundParts = (round, count) => Array.from({ length: count }, (_, index) => textPart(`${round}-${index}`, `${round} 内容 ${index}`, { startedAt: now - 8000 + index }));
  await f.send(goalState({ runId: 'page-1', status: 'completed', busy: false, parts: [thinkingPart('p1-think', { text: '第一轮推理。' }), ...roundParts('p1', 60)] }));
  await f.send(goalState({ runId: 'page-2', status: 'completed', busy: false, parts: [thinkingPart('p2-think', { text: '第二轮推理。' }), ...roundParts('p2', 60)] }));
  const liveParts = roundParts('p3', 60);
  await f.send(goalState({ runId: 'page-3', status: 'running', busy: true, parts: [thinkingPart('p3-think', { text: '第三轮推理。' }), ...liveParts] }));
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').count(), 120);
  assert.match(await f.page.locator('.goal-log-pager').textContent(), /183/);
  await f.page.getByRole('button', { name: '较早日志', exact: true }).click(); await f.paint();
  const first = await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id');
  assert.equal(first, 'reason:page-1');
  liveParts.push(textPart('p3-extra', '第三轮追加内容。', { startedAt: now + 100000 }));
  await f.send(goalState({ runId: 'page-3', status: 'running', busy: true, parts: [thinkingPart('p3-think', { text: '第三轮推理。' }), ...liveParts] }));
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id'), first, 'older page stays anchored while live rows arrive');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').count(), 120);
  await f.page.locator('#goal-log-bottom').click(); await f.paint();
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').last().getAttribute('data-log-id'), 'part:p3-extra');
  liveParts.push(textPart('p3-follow', '跟随内容。', { startedAt: now + 200000 }));
  await f.send(goalState({ runId: 'page-3', status: 'running', busy: true, parts: [thinkingPart('p3-think', { text: '第三轮推理。' }), ...liveParts] }));
  await f.paint();
  assert.equal(await f.page.locator('#goal-output-content').getAttribute('data-following'), 'true');
  await f.page.locator('#goal-output-content').evaluate(node => { node.scrollTop = 0; });
  liveParts.push(textPart('p3-paused', '滚动后不再跟随。', { startedAt: now + 300000 }));
  await f.send(goalState({ runId: 'page-3', status: 'running', busy: true, parts: [thinkingPart('p3-think', { text: '第三轮推理。' }), ...liveParts] }));
  assert.ok(await f.page.locator('#goal-output-content').evaluate(node => node.scrollTop < 40), 'scrolling up stops following');
  assert.equal(await f.page.locator('#goal-output-content').getAttribute('data-following'), 'false');
  await f.page.locator('#goal-log-bottom').click(); await f.paint();
  liveParts.push(textPart('p3-resume', '回到底部后继续。', { startedAt: now + 400000 }));
  await f.send(goalState({ runId: 'page-3', status: 'running', busy: true, parts: [thinkingPart('p3-think', { text: '第三轮推理。' }), ...liveParts] }));
  await f.paint();
  assert.equal(await f.page.locator('#goal-output-content').getAttribute('data-following'), 'true');
});

test('round cap evicts old rounds, releases nodes and session switch clears everything', async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 20; index++) {
    await f.send(goalState({ runId: 'cap-' + index, status: 'completed', busy: false, parts: [thinkingPart('cap-' + index, { text: '第 ' + index + ' 轮内容。' })] }));
  }
  assert.equal(await roundHeadings(f.page).count(), 20);
  await f.page.evaluate(() => {
    const original = window.UBOVMMessage;
    window.releaseCount = 0;
    window.UBOVMMessage = { ...original, release(element) { window.releaseCount++; return original.release?.(element); } };
  });
  await f.send(goalState({ runId: 'cap-21', status: 'completed', busy: false, parts: [thinkingPart('cap-21', { text: '第 21 轮内容。' })] }));
  await f.send(goalState({ runId: 'cap-22', status: 'completed', busy: false, parts: [thinkingPart('cap-22', { text: '第 22 轮内容。' })] }));
  assert.equal(await roundHeadings(f.page).count(), 20, 'only the last 20 rounds stay mounted');
  assert.equal(await f.page.locator('.goal-log-round-title').first().textContent(), '第 3 轮');
  assert.doesNotMatch(await f.page.locator('#goal-output-content').textContent(), /第 1 轮内容/);
  assert.ok(await f.page.evaluate(() => window.releaseCount) > 0, 'evicted rounds release their nodes');
  await f.send(goalState({ conversationId: 'goal-log-v5-other', runId: 'other-run', status: 'idle', busy: false }));
  assert.equal(await roundHeadings(f.page).count(), 0, 'session switch clears the stacked rounds');
  assert.equal(await f.page.locator('#goal-output-content').isVisible(), false);
  assert.equal(await f.page.locator('#goal-log-reason-toggle').isVisible(), false);
});

test('English locale translates round headers, reasoning metadata and expand action', async t => {
  const f = await fixture(t);
  await f.send(goalState({ runId: 'en-1', status: 'completed', busy: false, parts: [thinkingPart('en-a', { text: '英文轮次一。' })] }));
  await f.send(goalState({ runId: 'en-2', status: 'running', busy: true, parts: [thinkingPart('en-b', { status: 'running', startedAt: now - 300, endedAt: undefined, text: '英文轮次二。' })] }));
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  await f.paint();
  assert.deepEqual(await f.page.locator('.goal-log-round-title').allTextContents(), ['Round 1', 'Round 2']);
  assert.deepEqual(await f.page.locator('.goal-log-round-status').allTextContents(), ['Completed', 'Running']);
  assert.deepEqual(await f.page.locator('.goal-log-reasoning-state').allTextContents(), ['Thought', 'Thinking']);
  const toggle = f.page.locator('#goal-log-reason-toggle');
  assert.equal(await toggle.textContent(), 'Expand thinking');
  await toggle.click(); await f.paint();
  assert.equal(await toggle.textContent(), 'Collapse thinking');
});

test('dark, light and 430px keep interleaved tool cards and content readable', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'shot-1', status: 'completed', busy: false,
    parts: [
      thinkingPart('shot-a', { text: '第一轮：核对入口和缓存。\n\n第一轮结论已出。' }),
      textPart('shot-text', '第一轮结论：**入口可用**。', { startedAt: now - 6000 }),
      toolPart('shot-tool-1', { startedAt: now - 5000, endedAt: now - 4500 }),
      textPart('shot-text-2', '继续核对缓存命中。', { startedAt: now - 4000 }),
      { id: 'shot-tool-2', type: 'tool', name: 'read_workspace_file', args: '{"path":"b.js"}', output: 'b', status: 'completed', startedAt: now - 3500, endedAt: now - 3000 }
    ]
  }));
  await f.send(goalState({
    runId: 'shot-2', status: 'running', busy: true,
    parts: [thinkingPart('shot-b', { status: 'running', startedAt: now - 300, endedAt: undefined, text: '第二轮：继续核对缓存命中，观察重试间隔。' }), textPart('shot-text-3', '第二轮正在输出。', { status: 'streaming', startedAt: now - 200 })]
  }));
  await f.page.screenshot({ path: screenshotDirectory + '/two-rounds-light.png' });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark')); await f.paint();
  await f.page.screenshot({ path: screenshotDirectory + '/two-rounds-dark.png' });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.page.setViewportSize({ width: 430, height: 900 }); await f.paint();
  const narrow = await f.page.evaluate(() => {
    const panel = document.querySelector('.goal-output-panel');
    const content = document.getElementById('goal-output-content');
    return {
      doc: document.documentElement.scrollWidth,
      panelScroll: panel.scrollWidth, panelClient: panel.clientWidth,
      contentScroll: content.scrollWidth, contentClient: content.clientWidth,
      rounds: document.querySelectorAll('.goal-log-round-heading').length,
      titles: [...document.querySelectorAll('.goal-log-round-title')].map(node => node.textContent),
      toolCards: document.querySelectorAll('.goal-log-entry[data-kind="tool"] .tool-card').length,
      groups: document.querySelectorAll('.tool-group').length,
      textRows: document.querySelectorAll('.goal-log-entry[data-kind="text"]').length
    };
  });
  assert(narrow.doc <= 430, `no page horizontal scroll: ${narrow.doc}`);
  assert(narrow.panelScroll <= narrow.panelClient + 1, JSON.stringify(narrow));
  assert(narrow.contentScroll <= narrow.contentClient + 1, JSON.stringify(narrow));
  assert.equal(narrow.rounds, 2);
  assert.deepEqual(narrow.titles, ['第 1 轮', '第 2 轮']);
  assert.equal(narrow.toolCards, 2);
  assert.equal(narrow.groups, 0);
  assert.equal(narrow.textRows, 3);
  await f.page.screenshot({ path: screenshotDirectory + '/two-rounds-430.png' });
});

// ---------------------------------------------------------------------------
// Round headers are sticky orientation labels, not fold controls.
// ---------------------------------------------------------------------------
test('round headers stay sticky and cannot fold their rows', async t => {
  const f = await fixture(t);
  const archived = archivedRound();
  const live = text => goalState({
    runId: 'fold-live',
    parts: [thinkingPart('fl-think', { status: 'running', startedAt: now - 300, endedAt: undefined, text })],
    logHistory: [archived]
  });
  await f.send(live('第二轮正在分析。'));
  assert.equal(await roundHeadings(f.page).count(), 2);
  const header = f.page.locator('.goal-log-round-heading[data-round-key="fold-archived"]');
  assert.deepEqual(await header.evaluate(node => ({
    position: getComputedStyle(node).position, top: getComputedStyle(node).top,
    cursor: getComputedStyle(node).cursor, tabindex: node.getAttribute('tabindex'),
    role: node.getAttribute('role'), expanded: node.getAttribute('aria-expanded')
  })), { position: 'sticky', top: '0px', cursor: 'default', tabindex: null, role: null, expanded: null },
  'the header is a non-interactive sticky label');
  const expandedState = await roundFoldState(f.page, 'fold-archived');
  assert.deepEqual([expandedState.hidden, expandedState.visible, expandedState.metaHidden], [0, 4, true]);

  await header.click(); await f.paint();
  const afterClick = await roundFoldState(f.page, 'fold-archived');
  assert.deepEqual([afterClick.hidden, afterClick.visible, afterClick.metaHidden], [0, 4, true],
    'clicking a round header must not hide any row');
  assert.equal(afterClick.collapsed, 'false');
  assert.equal(await f.page.locator('#goal-log-rounds-toggle').isVisible(), false, 'the fold-all action is gone');

  await header.focus();
  await f.page.keyboard.press('Enter'); await f.paint();
  const afterKeyboard = await roundFoldState(f.page, 'fold-archived');
  assert.deepEqual([afterKeyboard.hidden, afterKeyboard.visible], [0, 4], 'Enter must not fold the round');

  // Streaming still keeps every historical row visible.
  await f.send(live('第二轮正在分析。\n\n继续观察。'));
  const afterTick = await roundFoldState(f.page, 'fold-archived');
  assert.deepEqual([afterTick.hidden, afterTick.visible], [0, 4]);
  assert.equal(await f.page.locator('.goal-log-entry[data-round-key="fold-live"][data-kind="reasoning"]').isVisible(), true,
    'the live round stays visible too');
});

test('the round header stays pinned while the log scrolls inside a round', async t => {
  const f = await fixture(t);
  const first = Array.from({ length: 40 }, (_, index) => textPart('sticky-a-' + index, `第 ${index + 1} 条调度记录。`, { startedAt: now - 90000 + index }));
  const second = Array.from({ length: 40 }, (_, index) => textPart('sticky-b-' + index, `第二轮第 ${index + 1} 条调度记录。`, { startedAt: now - 50000 + index }));
  await f.send(goalState({ runId: 'sticky-a', status: 'completed', busy: false, parts: first }));
  await f.send(goalState({ runId: 'sticky-b', status: 'completed', busy: false, parts: second }));
  assert.equal(await f.page.locator('.goal-log-round-heading').count(), 2);
  const read = () => f.page.evaluate(() => {
    const content = document.getElementById('goal-output-content');
    const contentRect = content.getBoundingClientRect();
    return {
      scrollTop: Math.round(content.scrollTop),
      headers: [...document.querySelectorAll('.goal-log-round-heading')].map(header => ({
        top: Math.round(header.getBoundingClientRect().top - contentRect.top),
        position: getComputedStyle(header).position
      }))
    };
  });
  const staticTops = await f.page.evaluate(() => {
    const content = document.getElementById('goal-output-content');
    content.scrollTop = 0;
    const base = content.getBoundingClientRect().top;
    return {
      tops: [...content.querySelectorAll('.goal-log-round-heading')].map(header => Math.round(header.getBoundingClientRect().top - base)),
      maxScroll: content.scrollHeight - content.clientHeight
    };
  });
  assert.ok(staticTops.maxScroll > staticTops.tops[1] + 24, `the second round must be reachable: ${JSON.stringify(staticTops)}`);
  await f.page.locator('#goal-output-content').evaluate((node, value) => { node.scrollTop = value; }, staticTops.tops[1] + 20);
  await f.paint();
  const secondRound = await read();
  assert.equal(secondRound.headers[1].position, 'sticky', 'the round under the reader pins its header');
  assert.equal(secondRound.headers[0].position, 'relative', 'the previous round header releases instead of stacking');
  assert.ok(Math.abs(secondRound.headers[1].top) <= 2, `the pinned header sits at the scrollport edge: ${JSON.stringify(secondRound)}`);
  assert.ok(secondRound.headers[0].top < 0, 'the released header scrolls away above the log');
  await f.page.locator('#goal-output-content').evaluate(node => { node.scrollTop = 0; });
  await f.paint();
  const firstRound = await read();
  assert.deepEqual(firstRound.headers.map(header => header.position), ['sticky', 'relative']);
  assert.ok(Math.abs(firstRound.headers[0].top) <= 2, JSON.stringify(firstRound));
});

test('the bottom action reports records arriving while scrolled away', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 40 }, (_, index) => textPart('pending-' + index, `第 ${index + 1} 条记录。`, { startedAt: now - 50000 + index }));
  await f.send(goalState({ runId: 'pending-round', parts: rows }));
  await f.page.locator('#goal-output-content').evaluate(node => { node.scrollTop = 0; }); await f.paint();
  const bottom = f.page.locator('#goal-log-bottom');
  assert.equal(await f.page.locator('#goal-output-content').getAttribute('data-following'), 'false');
  assert.match(await bottom.textContent(), /回到底部/);
  assert.equal(await bottom.getAttribute('data-pending'), 'false');
  await f.send(goalState({
    runId: 'pending-round',
    parts: [...rows,
      textPart('pending-new-1', '新到达的一条记录。', { startedAt: now + 100000 }),
      textPart('pending-new-2', '新到达的第二条记录。', { startedAt: now + 200000 })]
  }));
  assert.match(await bottom.textContent(), /2 条新记录/);
  assert.equal(await bottom.getAttribute('data-pending'), 'true');
  await bottom.click(); await f.paint();
  assert.equal(await f.page.locator('#goal-output-content').getAttribute('data-following'), 'true');
  assert.match(await bottom.textContent(), /回到底部/);
  assert.equal(await bottom.getAttribute('data-pending'), 'false');
});

test('activity icons render as SVG and the streaming caret stays inline', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    parts: [
      thinkingPart('icon-think', { status: 'running', startedAt: now - 300, endedAt: undefined, text: '分析中。' }),
      textPart('icon-stream', '正在输出 **结果**：核对失败路径。', { status: 'streaming', startedAt: now - 200 })
    ],
    activities: [
      { label: 'todo', status: 'completed', timestamp: now - 8000, key: 'i-plan' },
      { label: 'spawn_worker', status: 'completed', timestamp: now - 7000, key: 'i-spawn' },
      { label: 'web_search', status: 'completed', timestamp: now - 6000, key: 'i-search' }
    ]
  }));
  const icons = await f.page.locator('.goal-log-entry[data-kind="activity"] .goal-log-row-icon').evaluateAll(nodes => nodes.map(node => ({
    tag: node.firstElementChild?.tagName || '', paths: node.querySelectorAll('path').length, text: node.textContent.trim()
  })));
  assert.equal(icons.length, 3);
  assert.ok(icons.every(icon => icon.tag === 'svg' && icon.text === ''), JSON.stringify(icons));
  assert.deepEqual(icons.map(icon => icon.paths), [1, 2, 2], 'plan uses one path, dispatch/search use two strokes');
  const caret = await f.page.locator('.goal-log-entry[data-kind="text"] .goal-log-row-content').evaluate(row => {
    const last = row.querySelector('.md-content .md-block:last-child > :last-child');
    const rowAfter = getComputedStyle(row, '::after');
    const lastAfter = last ? getComputedStyle(last, '::after') : null;
    return {
      streaming: row.classList.contains('response-streaming'),
      rowAfterDisplay: rowAfter.display, rowAfterContent: rowAfter.content,
      lastAfterDisplay: lastAfter?.display ?? null, lastAfterContent: lastAfter?.content ?? null
    };
  });
  assert.equal(caret.streaming, true);
  assert.deepEqual([caret.rowAfterDisplay, caret.rowAfterContent], ['none', 'none'],
    'the shared flex-row caret must not draw a stray bar under the log row');
  assert.deepEqual([caret.lastAfterDisplay, caret.lastAfterContent], ['inline-block', '""'],
    'the caret sits inline at the end of the last paragraph');
});

test('the pager is a footer below the scrolling log', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 260 }, (_, index) => textPart('pager-' + index, `第 ${index + 1} 条调度记录。`, { startedAt: now - 200000 + index }));
  await f.send(goalState({ runId: 'pager-v7', status: 'completed', busy: false, parts: rows }));
  const facts = await f.page.evaluate(() => {
    const content = document.getElementById('goal-output-content');
    const pager = document.querySelector('.goal-log-pager');
    const style = getComputedStyle(pager);
    content.scrollTop = 160;
    return {
      afterContent: content.nextElementSibling === pager,
      outsideScroller: !content.contains(pager),
      visible: pager.getBoundingClientRect().height > 0,
      borderTop: style.borderTopWidth,
      borderBottom: style.borderBottomWidth,
      contentScrolls: content.scrollHeight > content.clientHeight,
      scrolled: content.scrollTop > 0
    };
  });
  assert.deepEqual(facts, {
    afterContent: true, outsideScroller: true, visible: true,
    borderTop: '1px', borderBottom: '0px', contentScrolls: true, scrolled: true
  });
});

test('English locale translates round headers and exposes no fold affordance', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  await f.paint();
  await f.send(goalState({
    runId: 'en-fold-live',
    parts: [thinkingPart('en-fold-live-think', { text: 'English live thought.' })],
    logHistory: [archivedRound()]
  }));
  assert.deepEqual(await f.page.locator('.goal-log-round-title').allTextContents(), ['Round 1', 'Round 2']);
  assert.equal(await f.page.locator('#goal-log-rounds-toggle').isVisible(), false);
  const header = f.page.locator('.goal-log-round-heading[data-round-key="fold-archived"]');
  assert.equal(await header.getAttribute('role'), null);
  assert.equal(await header.locator('.goal-log-round-meta').isVisible(), false);
  assert.equal(await f.page.locator('.goal-log-entry[data-round-key="fold-archived"]:visible').count(), 4);
});

test('every Reason review is its own round inside one run', async t => {
  const f = await fixture(t);
  await f.send(goalState({
    runId: 'review-run',
    parts: [
      thinkingPart('rv1-think', { startedAt: now - 30000, endedAt: now - 29000, text: '第一轮思考：先清点入口。' }),
      toolPart('rv1-tool', { startedAt: now - 28500, endedAt: now - 27500 }),
      textPart('reason-conclusion:review-run:1', '派发 2 项任务。', { source: 'reason', startedAt: now - 26500 }),
      thinkingPart('rv2-think', { startedAt: now - 20000, endedAt: now - 19000, text: '第二轮思考：核对返回。' }),
      textPart('reason-conclusion:review-run:2', '派发 1 项任务。', { source: 'reason', startedAt: now - 18000 }),
      thinkingPart('rv3-think', { status: 'running', startedAt: now - 2000, endedAt: undefined, text: '第三轮思考：等待结果。' })
    ],
    workers: [
      worker('rv-w1', { createdAt: now - 27000, startedAt: now - 25400, finishedAt: now - 24000 }),
      worker('rv-w2', { createdAt: now - 19000, startedAt: now - 16900, finishedAt: undefined, status: 'running' })
    ]
  }));
  const headings = await f.page.locator('#goal-output-content .goal-log-round-heading').evaluateAll(nodes => nodes.map(node => ({
    title: node.querySelector('.goal-log-round-title')?.textContent,
    key: node.dataset.roundKey,
    status: node.querySelector('.goal-log-round-status')?.textContent
  })));
  assert.deepEqual(headings, [
    { title: '第 1 轮', key: 'review-run#r0', status: '已完成' },
    { title: '第 2 轮', key: 'review-run#r1', status: '已完成' },
    { title: '第 3 轮', key: 'review-run#r2', status: '执行中' }
  ], 'one Reason conclusion closes a round; the trailing review stays live');
  assert.equal(await reasoningRow(f.page).count(), 3, 'each round owns only its own Reason thinking');
  const thinkingTexts = await f.page.locator('.goal-log-entry[data-kind="reasoning"]').evaluateAll(rows => rows.map(row => row.textContent));
  assert.match(thinkingTexts[0], /第一轮思考/);
  assert.match(thinkingTexts[1], /第二轮思考/);
  assert.match(thinkingTexts[2], /第三轮思考/);
  assert.equal(await f.page.locator('.goal-log-task-card[data-round-key="review-run#r0"] [data-worker-id="rv-w1"]').count(), 1, 'a worker dispatched by round 1 stays in round 1');
  assert.equal(await f.page.locator('.goal-log-task-card[data-round-key="review-run#r1"] [data-worker-id="rv-w2"]').count(), 1, 'a worker dispatched by round 2 owns round 2');
  // A further review is appended live: the previous live round turns completed
  // and the same round key is updated instead of duplicated.
  await f.send(goalState({
    runId: 'review-run',
    parts: [
      thinkingPart('rv1-think', { startedAt: now - 30000, endedAt: now - 29000, text: '第一轮思考：先清点入口。' }),
      toolPart('rv1-tool', { startedAt: now - 28500, endedAt: now - 27500 }),
      textPart('reason-conclusion:review-run:1', '派发 2 项任务。', { source: 'reason', startedAt: now - 26500 }),
      thinkingPart('rv2-think', { startedAt: now - 20000, endedAt: now - 19000, text: '第二轮思考：核对返回。' }),
      textPart('reason-conclusion:review-run:2', '派发 1 项任务。', { source: 'reason', startedAt: now - 18000 }),
      thinkingPart('rv3-think', { startedAt: now - 2000, endedAt: now - 1000, text: '第三轮思考：等待结果。' }),
      textPart('reason-conclusion:review-run:3', '目标已完成。', { source: 'reason', startedAt: now - 500 })
    ],
    workers: [
      worker('rv-w1', { createdAt: now - 27000, startedAt: now - 25400, finishedAt: now - 24000 }),
      worker('rv-w2', { createdAt: now - 19000, startedAt: now - 16900, finishedAt: now - 16000, status: 'completed' })
    ]
  }));
  const updated = await f.page.locator('#goal-output-content .goal-log-round-heading').evaluateAll(nodes => nodes.map(node => ({
    title: node.querySelector('.goal-log-round-title')?.textContent,
    status: node.querySelector('.goal-log-round-status')?.textContent
  })));
  assert.deepEqual(updated, [
    { title: '第 1 轮', status: '已完成' },
    { title: '第 2 轮', status: '已完成' },
    { title: '第 3 轮', status: '已完成' }
  ]);
  assert.equal(await f.page.locator('.goal-log-round-heading[data-round-key="review-run#r2"]').count(), 1, 'the same review round is updated, not duplicated');
});

test('a light tick that drops most records never blanks an active log', async t => {
  const f = await fixture(t);
  const parts = Array.from({ length: 12 }, (_, index) => textPart('light-' + index, `第 ${index + 1} 条记录。`, { startedAt: now - 12000 + index * 100 }));
  await f.send({ ...goalState({ runId: 'light-drop', status: 'running', busy: true, parts }), viewRevision: 1 });
  assert.equal(await f.page.locator('#goal-output-count').textContent(), '12 条记录');
  const rowsBefore = await f.page.locator('#goal-output-content .goal-log-entry').count();
  // A light execution projection carrying only one thinking part (the host
  // omitted the bulk of the timeline) must not repaint the log as one row.
  await f.send({ type: 'executionState', conversationId: 'goal-log-v5', viewRevision: 2, busy: true,
    execution: { status: 'running', busy: true, runId: 'light-drop', phase: 'reason', parts: [thinkingPart('light-only', { text: '仅剩一条思考。' })] } });
  assert.equal(await f.page.locator('#goal-output-count').textContent(), '12 条记录', 'the record count must not collapse mid-run');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').count(), rowsBefore, 'already painted rows stay mounted');
  // The next complete tick still repaints normally (no stale cache).
  const next = [...parts, textPart('light-12', '第 13 条记录。', { startedAt: now - 500 })];
  await f.send({ ...goalState({ runId: 'light-drop', status: 'running', busy: true, parts: next }), viewRevision: 3 });
  assert.equal(await f.page.locator('#goal-output-count').textContent(), '13 条记录');
});

test('long runs keep every round expanded and cannot fold', async t => {
  const f = await fixture(t);
  const parts = [];
  const workers = [];
  for (let index = 0; index < 8; index += 1) {
    const start = now - 200000 + index * 20000;
    parts.push(thinkingPart('fold-think-' + index, { startedAt: start, endedAt: start + 5000, text: '第 ' + (index + 1) + ' 次复盘思考。' }));
    parts.push(textPart('reason-conclusion:fold-run:' + index, '派发 1 项任务。', { source: 'reason', startedAt: start + 6000 }));
    workers.push({ id: 'fold-worker-' + index, description: '任务 ' + (index + 1), status: 'completed', createdAt: start + 7000, startedAt: start + 7000, finishedAt: start + 9000 });
  }
  parts.push(thinkingPart('fold-think-live', { status: 'running', startedAt: now - 3000, endedAt: undefined, text: '当前复盘仍在思考。' }));
  await f.send(goalState({ runId: 'fold-run', status: 'running', busy: true, parts, workers }));
  const headers = f.page.locator('#goal-output-content .goal-log-round-heading');
  assert.equal(await headers.count(), 9, 'eight reviews plus the live review');
  assert.deepEqual(await headers.evaluateAll(nodes => nodes.map(node => node.dataset.collapsed)),
    Array(9).fill('false'), 'a long run still keeps every review open so thinking and conclusions stay visible');
  assert.ok(await f.page.locator('.goal-log-entry[data-kind="reasoning"]:visible').count() >= 8,
    'thinking rows stay visible in a long run');
  assert.ok(await f.page.locator('.goal-log-entry[data-kind="text"]:visible').count() >= 8,
    'reason conclusions stay visible in a long run');
  assert.ok(await f.page.locator('.goal-log-entry[data-conclusion="true"]:visible').count() >= 8,
    'reason conclusions are marked as narrative anchors');
  assert.equal(await f.page.locator('#goal-log-rounds-toggle').isVisible(), false, 'there is no fold-all action');
  const beforeClick = await f.page.locator('#goal-output-content .goal-log-entry:visible').count();
  await headers.nth(0).click(); await f.paint();
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry:visible').count(), beforeClick,
    'clicking a long-run round header keeps every row visible');
  await f.page.setViewportSize({ width: 430, height: 800 }); await f.paint();
  assert.equal(await f.page.evaluate(() => {
    const content = document.getElementById('goal-output-content');
    const right = content.getBoundingClientRect().right;
    return content.scrollWidth <= content.clientWidth + 1
      && [...content.querySelectorAll('.goal-log-round-heading')].every(node => node.getBoundingClientRect().right <= right + 1);
  }), true, 'round headers stay inside a 430px viewport');
  await f.send(goalState({
    runId: 'fold-run', status: 'completed', busy: false,
    parts: [...parts.filter(part => part.id !== 'fold-think-live'), thinkingPart('fold-think-live', { startedAt: now - 3000, endedAt: now - 2000, text: '当前复盘仍在思考。' }),
      textPart('reason-conclusion:fold-run:8', '目标已完成。', { source: 'reason', startedAt: now - 500 })],
    workers
  }));
  const finalCollapsed = await f.page.locator('#goal-output-content .goal-log-round-heading').evaluateAll(nodes => nodes.map(node => node.dataset.collapsed));
  assert.deepEqual(finalCollapsed, Array(9).fill('false'), 'a finished run leaves all rounds expanded so conclusions are visible');
});

test('a stale row from an earlier run cannot drag a round header back in time', async t => {
  const f = await fixture(t);
  const startedAt = now - 300000;
  await f.send(goalState({
    runId: 'stale-run',
    parts: [
      thinkingPart('stale-think', { startedAt, endedAt: startedAt + 4000, text: '本轮从第一次思考开始。' }),
      textPart('reason-conclusion:stale-run:0', '派发 1 项任务。', { source: 'reason', startedAt: startedAt + 100000 })
    ],
    workers: [worker('stale-old-worker', { createdAt: startedAt - 100000, startedAt: startedAt - 100000, finishedAt: startedAt - 90000 })]
  }));
  const header = f.page.locator('#goal-output-content .goal-log-round-heading').first();
  const expectedTime = await f.page.evaluate(value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false }), startedAt);
  assert.equal(await header.locator('.goal-log-round-time').textContent(), expectedTime);
  assert.match(await header.locator('.goal-log-round-duration').textContent(), /1m 4[0-9]s/, 'duration starts at the review, not the stale worker');
});
