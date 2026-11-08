// Independent end-to-end verification for the exploration goal-log v5:
// chronological individual content/tool rows (no merged round content block, no
// multi-tool .tool-group) while keeping the v4 DSH one-line reasoning row.
// Contract: .tmp-log4/contract.md (Verification section) + team-ui2 locked delta.
//
// Fixtures interleave timestamps (activity/worker between text/tool parts) and
// deliberately shuffle the host part order to prove chronological sorting.
// Asserts: one row per part in timestamp order together with activity/worker rows;
// individual tool cards (no `.tool-group`, no merged `.goal-log-content`); summary
// and synthetic stream/result rows; text rows keep assist Markdown; tool copy/expand;
// streaming appends later rows and updates tools in place without reordering;
// reasoning line stays collapsed; archived round DOM untouched; pager/follow/stacking/
// session/cap/worker/private/activity/dark/light/430 and no page/console errors/remote.
//
// Independent of goal-log-card.mjs (implementation-owned).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://goal-log-v5-e2e.test/';
const now = Date.now();
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

// ---------------------------------------------------------------------------
// Fixtures: interleaved timestamps (T0 = oldest).
//   reasoning start T0           activity Reason T0+100
//   text TEXT-ONE  T0+1000       tool search_web T0+2000
//   tool read_file T0+2200       activity todo   T0+2500
//   text TEXT-TWO  T0+3000       worker reviewer T0+3500
//   tool list_dir  T0+4000
// ---------------------------------------------------------------------------
const T0 = now - 200000;
const WORKER_PRIVATE = 'WORKER-PRIVATE-THINKING-ONLY';
const R1_REASON = [
  '先核对 **第一轮** 的执行边界与事件顺序，再确认持久化路径。',
  '',
  '- 读取 `goal/execution-log.js` 的逐条行实现；',
  '- 确认工具卡片与正文按时间排序；',
  '',
  '```json',
  '{"intents":[{"id":"round-1","action":"inspect"}],"decision":"dispatch"}',
  '```',
  '',
  '第一轮结论标记 ROUND1-REASON-TAIL。'
].join('\n');
const R1_TEXT_ONE = 'TEXT-ONE 第一段正文：**加粗** 与 `代码` 保持协助模式 Markdown。';
const R1_TEXT_TWO = 'TEXT-TWO 第二段正文：工具之间应保持时间顺序。';
const R2_TEXT = '第二轮内容 ROUND2-TEXT：新行追加在底部。';
const R3_RESULT = 'RESULT-ROW-MARKER 第三轮结果摘要';

const PART_TIMES = {
  'r1-reason': T0,
  'r1-text-one': T0 + 1000,
  'r1-tool-a': T0 + 2000,
  'r1-tool-b': T0 + 2200,
  'r1-text-two': T0 + 3000,
  'r1-tool-c': T0 + 4000
};
const ACTIVITY_TIMES = { 'act-reason': T0 + 100, 'act-todo': T0 + 2500 };
const WORKER_TIME = T0 + 3500;
const EXPECTED_SEQUENCE = [
  ['reason', T0],
  ['activity:act-reason', T0 + 100],
  ['part:r1-text-one', T0 + 1000],
  ['part:r1-tool-a', T0 + 2000],
  ['part:r1-tool-b', T0 + 2200],
  ['activity:act-todo', T0 + 2500],
  ['part:r1-text-two', T0 + 3000],
  ['worker:w-r1', T0 + 3500],
  ['part:r1-tool-c', T0 + 4000]
];
const EXPECTED_MARKER_ORDER = ['TEXT-ONE', 'search_web', 'read_file', 'TEXT-TWO', 'reviewer', 'list_dir'];

const r1Parts = () => [
  { id: 'r1-reason', type: 'thinking', source: 'reason', status: 'completed', startedAt: T0, endedAt: T0 + 500, text: R1_REASON },
  { id: 'r1-text-one', type: 'text', status: 'completed', startedAt: T0 + 1000, text: R1_TEXT_ONE },
  { id: 'r1-tool-a', type: 'tool', name: 'search_web', status: 'completed', startedAt: T0 + 2000, endedAt: T0 + 2400, args: '{"query":"chronological rows"}', output: '3 results' },
  { id: 'r1-tool-b', type: 'tool', name: 'read_file', status: 'completed', startedAt: T0 + 2200, endedAt: T0 + 2600, args: '{"path":"src/renderer/webview/goal/execution-log.js"}', output: 'content' },
  { id: 'r1-text-two', type: 'text', status: 'completed', startedAt: T0 + 3000, text: R1_TEXT_TWO },
  { id: 'r1-tool-c', type: 'tool', name: 'list_dir', status: 'completed', startedAt: T0 + 4000, endedAt: T0 + 4200, args: '{"path":"src/renderer/webview"}', output: 'files' }
];
const r1Activities = () => [
  { label: 'Reason', status: 'completed', timestamp: T0 + 100, key: 'act-reason' },
  { label: 'todo', status: 'completed', timestamp: T0 + 2500, key: 'act-todo' }
];
const r1Workers = () => [{
  id: 'w-r1', name: 'reviewer', description: '第一轮审查时间线', status: 'completed',
  createdAt: T0 + 3500, startedAt: T0 + 3600, finishedAt: T0 + 3900,
  parts: [{ id: 'w-r1-private', type: 'thinking', source: 'worker', status: 'completed', startedAt: T0 + 3550, endedAt: T0 + 3590, text: WORKER_PRIVATE }]
}];

const goalState = ({ sessionId = 'goal-rounds-v5', runId, parts = [], activities = [], workers = [], status = 'running', busy = true, result, streamText = '' } = {}) => ({
  type: 'state', mode: 'goal',
  conversation: { id: sessionId, title: '按时间排序的探索日志' },
  goal: { objective: '验证工具卡片与内容按时间排序', criteria: ['逐条按时间排序', '不合并工具组'], notes: [] },
  messages: [],
  provider: { configured: true, connected: true, label: '测试模型' },
  context: { workspace: 'UBOVM', file: '' },
  busy,
  execution: { runId, status, busy, phase: 'execute', parts, activities, workers, streamText, ...(result ? { result } : {}) }
});
const run1State = (overrides = {}) => goalState({
  runId: 'run-1', parts: r1Parts(), activities: r1Activities(), workers: r1Workers(), ...overrides
});
const run2State = (tick = 1, overrides = {}) => goalState({
  runId: 'run-2',
  parts: [
    { id: 'r2-reason', type: 'thinking', source: 'reason', status: 'running', startedAt: T0 + 10000, text: 'ROUND2-REASON：流式思考第 ' + tick + ' 段。' },
    { id: 'r2-text', type: 'text', status: 'streaming', startedAt: T0 + 11000, text: R2_TEXT }
  ],
  activities: [{ label: 'Reason', status: 'running', timestamp: T0 + 10100, key: 'r2-reason' }],
  ...overrides
});
const run3State = (overrides = {}) => goalState({
  runId: 'run-3', busy: false, status: 'completed',
  parts: [{ id: 'r3-text', type: 'text', status: 'completed', startedAt: T0 + 20000, text: 'ROUND3-TEXT' }],
  activities: [{ label: 'Reason', status: 'completed', timestamp: T0 + 19900, key: 'r3-reason' }],
  result: { summary: R3_RESULT },
  ...overrides
});
const assistState = messages => ({
  type: 'state', mode: 'assist',
  conversation: { id: 'assist-v5-parity', title: '协助' },
  messages, goal: null,
  provider: { configured: true, connected: true, label: '测试模型' },
  context: { workspace: 'UBOVM', file: '' },
  busy: false,
  execution: { status: 'completed', busy: false, parts: [], streamText: '', activities: [] }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
async function fixture(t, { mode = 'goal', width = 1100, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  const consoleErrors = [];
  const remoteRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url + ' (failed)');
  });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState() {},
      postMessage: message => { window.hostMessages.push(message); }
    });
  });
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'goal-log-v5-e2e' })
  }));
  await page.goto(origin);
  const frames = (count = 2) => page.evaluate(async amount => {
    for (let index = 0; index < amount; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
  const emit = async state => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state);
    await frames(2);
    await page.waitForTimeout(120);
  };
  const api = {
    page, frames, emit,
    log: page.locator('#goal-output-content'),
    hostMessages: () => page.evaluate(() => window.hostMessages.slice())
  };
  await emit(mode === 'assist' ? assistState([]) : goalState({ runId: undefined, status: 'idle', busy: false }));
  await page.waitForFunction(() => document.body.dataset.loading === 'false', undefined, { timeout: 8000 }).catch(() => {});
  t.after(async () => {
    await page.close().catch(() => {});
    assert.deepEqual(pageErrors, [], 'the goal log must not throw page errors');
    assert.deepEqual(consoleErrors, [], 'the goal log must not log console errors');
    assert.deepEqual(remoteRequests, [], 'the goal log must not request remote resources');
  });
  return api;
}

const bodyText = page => page.evaluate(() => (document.getElementById('goal-output-content')?.textContent || '').replace(/\s+/g, ' ').trim());
const rows = page => page.evaluate(() => [...document.querySelectorAll('#goal-output-content .goal-log-entry')].map(entry => ({
  id: entry.dataset.logId || '',
  kind: entry.dataset.kind || '',
  status: entry.getAttribute('data-status') || '',
  text: (entry.textContent || '').replace(/\s+/g, ' ').trim()
})));
// Expected chronological time for a rendered row id (null = unknown/synthetic row).
const timeOfRow = id => {
  if (id.startsWith('reason')) return T0;
  if (id.startsWith('part:')) return PART_TIMES[id.slice(5)] ?? null;
  if (id.startsWith('activity:')) return ACTIVITY_TIMES[id.split(':').pop()] ?? null;
  if (id === 'worker:w-r1') return WORKER_TIME;
  return null;
};
const reasoningRows = page => page.evaluate(() => {
  const log = document.getElementById('goal-output-content');
  if (!log) return [];
  return [...log.querySelectorAll('details')].filter(node => {
    const summary = node.querySelector('summary');
    return summary && /思考中|已思考|思考/.test(summary.textContent || '') && !node.closest('.goal-output-actions');
  }).map(node => {
    const summary = node.querySelector('summary');
    const lineNode = node.querySelector('.goal-log-reasoning-line');
    const meta = node.querySelector('.goal-log-reasoning-meta');
    const body = node.querySelector('.goal-log-reasoning-markdown, .goal-log-reasoning-body');
    const row = node.closest('article.goal-log-entry');
    return {
      open: node.open === true,
      preview: lineNode ? (lineNode.textContent || '').replace(/\s+/g, ' ').trim() : '',
      meta: (meta?.textContent || summary?.textContent || '').replace(/\s+/g, ' ').trim(),
      bodyText: (body?.textContent || '').replace(/\s+/g, ' ').trim(),
      summaryTag: summary?.tagName || '',
      rowKind: row?.dataset.kind || '',
      rowLogId: row?.dataset.logId || ''
    };
  });
});
const clickReasoning = (page, index = 0) => page.evaluate(target => {
  const log = document.getElementById('goal-output-content');
  const details = [...log.querySelectorAll('details')].filter(node => {
    const summary = node.querySelector('summary');
    return summary && /思考中|已思考|思考/.test(summary.textContent || '') && !node.closest('.goal-output-actions');
  });
  const row = details[target];
  if (!row) return { clicked: false };
  const was = row.open === true;
  row.querySelector('summary')?.click();
  return { clicked: true, was };
}, index);
const roundInfo = page => page.evaluate(() => {
  const log = document.getElementById('goal-output-content');
  const headings = [...(log?.querySelectorAll('.goal-log-round-heading, [data-round-header]') || [])];
  return { count: headings.length, labels: headings.map(node => (node.textContent || '').replace(/\s+/g, ' ').trim()) };
});
const toolFacts = page => page.evaluate(() => {
  const log = document.getElementById('goal-output-content');
  const cards = [...log.querySelectorAll('.tool-card')];
  const groups = [...log.querySelectorAll('.tool-group')];
  return {
    cards: cards.length,
    cardRows: cards.map(card => card.closest('.goal-log-entry')?.dataset.logId || 'none'),
    groups: groups.length,
    cardsPerGroup: groups.map(group => group.querySelectorAll('.tool-card').length),
    rows: [...log.querySelectorAll('.goal-log-entry[data-kind="tool"]')].map(entry => entry.dataset.logId || '')
  };
});
const textMarkerRows = page => page.evaluate(markers => {
  const log = document.getElementById('goal-output-content');
  const rowOf = marker => {
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.nodeValue || '').includes(marker)) return node.parentElement?.closest('.goal-log-entry')?.dataset.logId || null;
    }
    return null;
  };
  return Object.fromEntries(markers.map(marker => [marker, rowOf(marker)]));
}, ['TEXT-ONE', 'TEXT-TWO']);
const markerOrder = page => page.evaluate(markers => {
  const text = document.getElementById('goal-output-content')?.textContent || '';
  return markers.map(marker => ({ marker, index: text.indexOf(marker) })).filter(item => item.index >= 0).sort((a, b) => a.index - b.index).map(item => item.marker);
}, EXPECTED_MARKER_ORDER);
const classTokens = value => String(value || '').split(/\s+/).filter(Boolean);
const nodeMatchesAssist = (goal, assist) => Boolean(goal && assist)
  && goal.tag === assist.tag
  && classTokens(assist.className).every(token => classTokens(goal.className).includes(token))
  && goal.children.length === assist.children.length
  && goal.children.every((child, index) => child.tag === assist.children[index].tag
    && classTokens(assist.children[index].className).every(token => classTokens(child.className).includes(token)));
const structure = (page, rootSelector) => page.evaluate(selector => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const pick = inner => [...root.querySelectorAll(inner)].map(node => ({
    tag: node.tagName,
    className: typeof node.className === 'string' ? node.className : '',
    children: [...node.children].map(child => ({ tag: child.tagName, className: typeof child.className === 'string' ? child.className : '' }))
  }));
  return { tool: pick('.tool-card'), responseText: pick('.response-text'), timeline: pick('.message-timeline'), thinking: pick('.thinking-card') };
}, rootSelector);

// ---------------------------------------------------------------------------
// 1. Reasoning line per round (collapsed DSH row) and no reason thinking cards.
// ---------------------------------------------------------------------------
test('each round keeps one collapsed DSH reasoning line and no thinking cards', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  const lines = await reasoningRows(f.page);
  assert.ok(lines.length >= 2, `expected one reasoning line per round (found ${lines.length})`);
  for (const line of lines) {
    assert.ok(line.preview.length > 0, 'each reasoning line must have a non-empty preview');
    assert.match(line.meta, /思考中|已思考/, 'the reasoning line must show thinking metadata');
    assert.equal(line.open, false, 'reasoning lines must stay collapsed by default');
    assert.equal(line.summaryTag, 'SUMMARY', 'reasoning must be a native details > summary row');
  }
  const facts = await f.page.evaluate(() => ({
    thinkingCards: document.querySelectorAll('#goal-output-content .thinking-card:not(.summary-card)').length,
    reasoningEntries: document.querySelectorAll('#goal-output-content .goal-log-entry[data-kind="reasoning"]').length
  }));
  assert.equal(facts.thinkingCards, 0, 'reason thinking must not render as a .thinking-card in the goal log');
  assert.equal(facts.reasoningEntries, lines.length, 'each round must expose one reasoning entry row');
});

// ---------------------------------------------------------------------------
// 2. Chronological order: individual rows interleaved with activity/worker rows.
// ---------------------------------------------------------------------------
test('content/tool rows render in timestamp order interleaved with activities and workers', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const rendered = await rows(f.page);
  const known = rendered.map(row => ({ ...row, time: timeOfRow(row.id) })).filter(row => row.time !== null);
  assert.ok(known.length >= 9, `expected all interleaved rows to render (found ${known.length}: ${JSON.stringify(known.map(row => row.id))})`);
  for (let index = 1; index < known.length; index++) {
    assert.ok(known[index].time >= known[index - 1].time,
      `row ${known[index].id} (t=${known[index].time}) must render after ${known[index - 1].id} (t=${known[index - 1].time}); rendered sequence ${JSON.stringify(known.map(row => row.id))}`);
  }
  const ids = known.map(row => row.id);
  const activityIndex = ids.findIndex(id => /activity:.*act-todo/.test(id));
  const textTwoIndex = ids.findIndex(id => id === 'part:r1-text-two');
  const workerIndex = ids.findIndex(id => id === 'worker:w-r1');
  const toolCIndex = ids.findIndex(id => id === 'part:r1-tool-c');
  assert.ok(activityIndex >= 0 && activityIndex < textTwoIndex, 'the todo activity (t2.5) must render before TEXT-TWO (t3) — no merged content block');
  assert.ok(workerIndex > 0 && toolCIndex > workerIndex, 'the worker (t3.5) must render before list_dir (t4) — tool rows interleave with worker rows');
  const markers = await markerOrder(f.page);
  assert.deepEqual(markers, EXPECTED_MARKER_ORDER, `rendered marker order must be chronological (got ${JSON.stringify(markers)})`);
});

// ---------------------------------------------------------------------------
// 3. One row per part: no merged content block, each tool its own card.
// ---------------------------------------------------------------------------
test('every content part gets its own row and every tool its own card (no tool group)', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const textRows = await textMarkerRows(f.page);
  assert.ok(textRows['TEXT-ONE'], 'TEXT-ONE must render in a row of its own');
  assert.ok(textRows['TEXT-TWO'], 'TEXT-TWO must render in a row of its own');
  assert.notEqual(textRows['TEXT-ONE'], textRows['TEXT-TWO'], `TEXT-ONE and TEXT-TWO must not share a merged row (got ${JSON.stringify(textRows)})`);
  const tools = await toolFacts(f.page);
  assert.equal(tools.cards, 3, `each tool part must render its own .tool-card (expected 3, got ${tools.cards})`);
  assert.equal(tools.groups, 0, `the goal log must not use multi-tool .tool-group batching (found ${tools.groups})`);
  assert.deepEqual(tools.cardsPerGroup, [], 'no .tool-group may contain tool cards in the goal log');
  const distinctCardRows = new Set(tools.cardRows.filter(id => id !== 'none'));
  assert.equal(distinctCardRows.size, 3, `each tool card must live in its own row (rows: ${JSON.stringify([...distinctCardRows])})`);
  for (const row of await rows(f.page)) {
    const partMarkers = ['TEXT-ONE', 'search_web', 'read_file', 'TEXT-TWO', 'list_dir'].filter(marker => row.text.includes(marker));
    assert.ok(partMarkers.length <= 1, `row ${row.id} mixes multiple parts (${JSON.stringify(partMarkers)}) — rows must be one part each`);
  }
  const merged = await f.page.evaluate(() => ({
    contentBlocks: document.querySelectorAll('#goal-output-content .goal-log-content').length,
    toolRows: [...document.querySelectorAll('#goal-output-content .goal-log-entry[data-kind="tool"]')].map(entry => ({
      id: entry.dataset.logId,
      cards: entry.querySelectorAll('.tool-card').length,
      captions: [...entry.querySelectorAll('.goal-log-tool-caption')].map(node => ({ hidden: node.hidden, ariaHidden: node.getAttribute('aria-hidden'), visible: node.getClientRects().length > 0 }))
    }))
  }));
  assert.equal(merged.contentBlocks, 0, 'v5 must not render a merged .goal-log-content block in the goal log');
  for (const row of merged.toolRows) {
    assert.equal(row.cards, 1, `tool row ${row.id} must contain exactly one .tool-card (got ${row.cards})`);
    for (const caption of row.captions) {
      assert.equal(caption.hidden || caption.ariaHidden === 'true', true, `tool row ${row.id} caption must be hidden from layout`);
      assert.equal(caption.visible, false, `tool row ${row.id} caption must not be visually rendered`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3b. A summary part gets its own chronologically sorted row with the assist card.
// ---------------------------------------------------------------------------
test('a summary part renders as its own chronological row with the assist summary-card', async t => {
  const f = await fixture(t);
  const withSummary = r1Parts().concat([{
    id: 'r1-summary', type: 'summary', status: 'completed', startedAt: T0 + 2100, endedAt: T0 + 2150,
    text: 'Context summary body with **bold**.', kinds: { transcript: 1 }
  }]);
  await f.emit(goalState({ runId: 'run-1', parts: withSummary, activities: [], workers: [] }));
  const rendered = await rows(f.page);
  const summaryRow = rendered.find(row => row.id === 'part:r1-summary');
  assert.ok(summaryRow, `a summary part must render its own row (rows: ${JSON.stringify(rendered.map(row => row.id))})`);
  assert.equal(summaryRow.kind, 'summary', 'the summary row must carry data-kind="summary"');
  const facts = await f.page.evaluate(() => {
    const entry = document.querySelector('#goal-output-content .goal-log-entry[data-log-id="part:r1-summary"]');
    return {
      summaryCards: entry ? entry.querySelectorAll('.summary-card').length : 0,
      thinkingCards: entry ? entry.querySelectorAll('.thinking-card:not(.summary-card)').length : 0
    };
  });
  assert.ok(facts.summaryCards >= 1, 'the summary row must contain the assist .summary-card');
  assert.equal(facts.thinkingCards, 0, 'a summary row must not be counted as reason-thinking');
  // Chronological placement: summary t2.1 must sit between tool-a t2.0 and tool-b t2.2.
  const ids = rendered.map(row => row.id);
  const summaryIndex = ids.indexOf('part:r1-summary');
  assert.ok(ids.indexOf('part:r1-tool-a') < summaryIndex, 'summary must render after the earlier tool row');
  assert.ok(summaryIndex < ids.indexOf('part:r1-tool-b'), 'summary must render before the later tool row');
});

// ---------------------------------------------------------------------------
// 4. Text rows keep assist Markdown; tool cards keep copy/expand behavior.
// ---------------------------------------------------------------------------
test('text rows keep assist Markdown and tool rows keep copy/expand behavior', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const textRow = await f.page.evaluate(() => {
    const entry = [...document.querySelectorAll('#goal-output-content .goal-log-entry')]
      .find(node => (node.textContent || '').includes('TEXT-ONE'));
    if (!entry) return null;
    return {
      id: entry.dataset.logId,
      timeline: entry.querySelectorAll('.message-timeline').length,
      responseText: entry.querySelectorAll('.response-text').length,
      strong: entry.querySelectorAll('strong').length,
      code: entry.querySelectorAll('code').length,
      toolCards: entry.querySelectorAll('.tool-card').length
    };
  });
  assert.ok(textRow, 'the TEXT-ONE row must exist');
  assert.ok(textRow.timeline >= 1, 'a text row must keep the assist .message-timeline container');
  assert.ok(textRow.responseText >= 1, 'a text row must keep the assist .response-text container');
  assert.ok(textRow.strong >= 1 && textRow.code >= 1, 'a text row must render assist Markdown (strong/code)');
  assert.equal(textRow.toolCards, 0, 'a text row must not contain tool cards');
  const toolRow = await f.page.evaluate(() => {
    const entry = document.querySelector('#goal-output-content .goal-log-entry[data-kind="tool"]');
    if (!entry) return null;
    const card = entry.querySelector('.tool-card');
    const button = card ? [...card.querySelectorAll('button')].find(node => /复制/.test(node.textContent || '')) : null;
    button?.click();
    const summary = card?.querySelector('.tool-card-summary, summary');
    summary?.click();
    return { id: entry.dataset.logId, card: Boolean(card), copied: Boolean(button), opened: Boolean(summary) };
  });
  assert.ok(toolRow?.card, 'the first tool row must contain a .tool-card');
  await f.frames(2);
  if (toolRow.copied) assert.ok((await f.hostMessages()).some(message => message?.action === 'copyText'), 'tool copy must post copyText from its own row');
  const parity = await f.page.evaluate(() => {
    const entry = [...document.querySelectorAll('#goal-output-content .goal-log-entry')].find(node => (node.textContent || '').includes('TEXT-ONE'));
    return [...entry.querySelectorAll('.response-text')].map(node => ({ tag: node.tagName, className: typeof node.className === 'string' ? node.className : '' }))[0] || null;
  });
  assert.ok(parity, 'text row response-text node must exist for assist parity');
});

// ---------------------------------------------------------------------------
// 5. Shuffled host part order still renders chronologically; equal timestamps keep host order.
// ---------------------------------------------------------------------------
test('shuffled host part order renders chronologically and equal timestamps keep host order', async t => {
  const f = await fixture(t);
  const shuffled = [
    r1Parts()[5], // tool-c t4
    r1Parts()[1], // text-one t1
    { id: 'r1-eq-a', type: 'text', status: 'completed', startedAt: T0 + 5000, text: 'EQUAL-A first' },
    { id: 'r1-eq-b', type: 'text', status: 'completed', startedAt: T0 + 5000, text: 'EQUAL-B second' },
    r1Parts()[2], // tool-a t2
    r1Parts()[0], // reason t0
    r1Parts()[4], // text-two t3
    r1Parts()[3] // tool-b t2.2
  ];
  await f.emit(goalState({ runId: 'run-1', parts: shuffled, activities: [], workers: [] }));
  const rendered = await rows(f.page);
  const ids = rendered.map(row => row.id);
  const order = ['part:r1-text-one', 'part:r1-tool-a', 'part:r1-tool-b', 'part:r1-text-two', 'part:r1-tool-c', 'part:r1-eq-a', 'part:r1-eq-b'];
  for (let index = 1; index < order.length; index++) {
    assert.ok(ids.indexOf(order[index]) > ids.indexOf(order[index - 1]),
      `row ${order[index]} must render after ${order[index - 1]} (rendered ${JSON.stringify(ids)})`);
  }
  const eqA = rendered.find(row => row.id === 'part:r1-eq-a');
  const eqB = rendered.find(row => row.id === 'part:r1-eq-b');
  assert.ok(eqA && eqB, 'equal-timestamp rows must both render');
  assert.ok(rendered.indexOf(eqA) < rendered.indexOf(eqB), 'equal timestamps must keep host part order (stable sort)');
});

// ---------------------------------------------------------------------------
// 6. Streaming appends a later row and updates a tool in place without reordering.
// ---------------------------------------------------------------------------
test('streaming appends later rows and updates tools in place without reordering', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const baseSequence = (await rows(f.page)).map(row => row.id);
  await f.emit(goalState({
    runId: 'run-2',
    parts: [
      { id: 'r2-reason', type: 'thinking', source: 'reason', status: 'running', startedAt: T0 + 10000, text: 'ROUND2-REASON：进行中。' },
      { id: 'r2-tool', type: 'tool', name: 'search_web', status: 'running', startedAt: T0 + 10500, args: '{"query":"live"}' },
      { id: 'r2-text', type: 'text', status: 'streaming', startedAt: T0 + 11000, text: R2_TEXT }
    ],
    activities: [], workers: []
  }));
  await f.page.evaluate(() => {
    const entry = [...document.querySelectorAll('#goal-output-content .goal-log-entry')].find(node => node.dataset.logId === 'part:r2-tool');
    window.__liveToolCard = entry?.querySelector('.tool-card') || null;
    window.__liveToolRow = entry || null;
  });
  const beforeUpdate = (await rows(f.page)).map(row => row.id);
  await f.emit(goalState({
    runId: 'run-2',
    parts: [
      { id: 'r2-reason', type: 'thinking', source: 'reason', status: 'running', startedAt: T0 + 10000, text: 'ROUND2-REASON：进行中。' },
      { id: 'r2-tool', type: 'tool', name: 'search_web', status: 'completed', startedAt: T0 + 10500, endedAt: T0 + 10900, args: '{"query":"live"}', output: 'live results' },
      { id: 'r2-text', type: 'text', status: 'streaming', startedAt: T0 + 11000, text: R2_TEXT },
      { id: 'r2-text-late', type: 'text', status: 'streaming', startedAt: T0 + 12000, text: 'LATE-APPEND 新行追加在底部。' }
    ],
    activities: [], workers: []
  }));
  const facts = await f.page.evaluate(() => ({
    sameCard: window.__liveToolCard?.isConnected === true && window.__liveToolCard === window.__liveToolRow?.querySelector('.tool-card'),
    lateRow: Boolean([...document.querySelectorAll('#goal-output-content .goal-log-entry')].find(node => node.dataset.logId === 'part:r2-text-late'))
  }));
  assert.equal(facts.sameCard, true, 'a tool status update must update the SAME tool card in place (no rebuild)');
  assert.equal(facts.lateRow, true, 'a later content part must be appended as a new row');
  const afterUpdate = (await rows(f.page)).map(row => row.id);
  for (const id of baseSequence) {
    assert.ok(afterUpdate.includes(id), `pre-existing row ${id} must stay rendered after streaming updates`);
  }
  for (const id of beforeUpdate.filter(id => id !== 'part:r2-text-late')) {
    assert.ok(afterUpdate.includes(id), `row ${id} must not disappear while appending`);
  }
  assert.equal(afterUpdate[afterUpdate.length - 1], 'reason:run-2', 'the live reasoning line stays pinned at the bottom while streaming');
  const toolIndex = afterUpdate.indexOf('part:r2-tool');
  const lateIndex = afterUpdate.indexOf('part:r2-text-late');
  assert.ok(toolIndex >= 0 && toolIndex < lateIndex, 'the updated tool row keeps its chronological position before the new later row');
  assert.ok(lateIndex < afterUpdate.length - 1, 'the newest content row is appended above the pinned reasoning line');
});

// ---------------------------------------------------------------------------
// 7. Result summary renders as its own final row when no matching text part exists.
// ---------------------------------------------------------------------------
test('a result summary renders as its own final row', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(goalState({
    runId: 'run-3', busy: false, status: 'completed',
    parts: [{ id: 'r3-tool', type: 'tool', name: 'search_web', status: 'completed', startedAt: T0 + 20000, endedAt: T0 + 20300, args: '{}', output: 'done' }],
    activities: [{ label: 'Reason', status: 'completed', timestamp: T0 + 19900, key: 'r3-reason' }],
    result: { summary: R3_RESULT }
  }));
  const rendered = await rows(f.page);
  const last = rendered[rendered.length - 1];
  assert.ok(last, 'rows must render');
  assert.match(last.text, /RESULT-ROW-MARKER/, `the result summary must fold into the final row (last row: ${JSON.stringify(last)})`);
  const resultRow = rendered.find(row => row.id.startsWith('result:'));
  assert.ok(resultRow, 'a synthetic result row must be created when no text part matches the result');
});

// ---------------------------------------------------------------------------
// 8. Reasoning line interacts: expand/collapse, persistence, expand-all, archived.
// ---------------------------------------------------------------------------
test('clicking the reasoning line expands the full Markdown and manual state survives ticks', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  let lines = await reasoningRows(f.page);
  assert.equal(lines[0].open, false, 'reasoning starts collapsed');
  const opened = await clickReasoning(f.page, 0);
  assert.equal(opened.clicked, true, 'the reasoning line must be clickable');
  await f.frames(2);
  lines = await reasoningRows(f.page);
  assert.equal(lines[0].open, true, 'clicking must expand the full reasoning body');
  const body = await f.page.evaluate(() => {
    const log = document.getElementById('goal-output-content');
    const details = [...log.querySelectorAll('details')].find(node => /思考中|已思考|思考/.test(node.querySelector('summary')?.textContent || ''));
    const node = details?.querySelector('.goal-log-reasoning-markdown, .goal-log-reasoning-body');
    return { text: (node?.textContent || '').replace(/\s+/g, ' ').trim(), visible: Boolean(node?.getClientRects().length) };
  });
  assert.equal(body.visible, true, 'the expanded reasoning body must be visible');
  assert.match(body.text, /ROUND1-REASON-TAIL/, 'the expanded body must contain the full reasoning text');
  await clickReasoning(f.page, 0);
  await f.frames(2);
  assert.equal((await reasoningRows(f.page))[0].open, false, 'clicking again must collapse the row');
  // Manual collapse must survive streaming ticks in a newer round.
  await f.emit(run2State(1));
  for (let tick = 2; tick <= 4; tick++) await f.emit(run2State(tick));
  const after = await reasoningRows(f.page);
  assert.ok(after.every(line => line.open === false), 'manual collapse must survive streaming ticks (no auto-open)');
  const active = after.find(line => /思考中/.test(line.meta));
  assert.ok(active && /第 4 段/.test(active.preview), 'the streaming preview must keep updating while collapsed');
});

test('header expand-all toggles every round reasoning row', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  const toggle = f.page.locator('.goal-output-actions button, #goal-output-actions button').filter({ hasText: /展开思考|收起思考/ }).first();
  if (await toggle.count() === 0) assert.fail('the log header must keep an 展开思考/收起思考 expand-all action');
  assert.match(await toggle.innerText(), /展开思考/);
  await toggle.click();
  await f.frames(2);
  let lines = await reasoningRows(f.page);
  assert.ok(lines.length >= 2, 'expand-all must cover reasoning rows from more than one round');
  assert.ok(lines.every(line => line.open === true), '展开思考 must open every reasoning row');
  assert.match(await toggle.innerText(), /收起思考/);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'expand-all must expose aria-pressed="true"');
  await toggle.click();
  await f.frames(2);
  lines = await reasoningRows(f.page);
  assert.ok(lines.every(line => line.open === false), '收起思考 must collapse every reasoning row');
});

test('archived round keeps its chronological rows and reasoning line expandable', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  const archived = await f.page.evaluate(() => {
    const log = document.getElementById('goal-output-content');
    const groups = [];
    let current = null;
    for (const child of log.children) {
      if (child.classList?.contains('goal-log-round-heading') || child.matches?.('[data-round-header]')) {
        current = { heading: child, elements: [] };
        groups.push(current);
      } else if (current) current.elements.push(child);
    }
    const first = groups[0];
    if (!first) return { found: false };
    const entries = first.elements.filter(element => element.classList?.contains('goal-log-entry') || element.querySelector?.('.goal-log-entry'));
    const ids = first.elements.flatMap(element => element.matches?.('.goal-log-entry') ? [element] : [...(element.querySelectorAll?.('.goal-log-entry') || [])]).map(node => node.dataset.logId);
    const reasoning = first.elements.flatMap(element => element.matches?.('details') ? [element] : [...(element.querySelectorAll?.('details') || [])])
      .find(node => /思考中|已思考|思考/.test(node.querySelector('summary')?.textContent || '')) || null;
    window.__archivedDetails = reasoning;
    return {
      found: true, ids, entries: entries.length,
      reasoning: Boolean(reasoning), reasoningOpen: reasoning ? reasoning.open === true : null,
      reasoningStatus: reasoning?.closest('article.goal-log-entry')?.getAttribute('data-status') || ''
    };
  });
  assert.equal(archived.found, true, 'the archived round must remain mounted');
  for (const id of ['part:r1-text-one', 'part:r1-tool-a', 'part:r1-tool-b', 'part:r1-text-two', 'part:r1-tool-c']) {
    assert.ok(archived.ids.includes(id), `archived round must keep its individual row ${id} (found ${JSON.stringify(archived.ids)})`);
  }
  assert.equal(archived.reasoning, true, 'archived round keeps its reasoning line');
  assert.equal(archived.reasoningStatus, 'completed', 'archiving must freeze the reasoning row to completed');
  const opened = await f.page.evaluate(() => {
    const details = window.__archivedDetails;
    if (!details) return { clicked: false };
    details.querySelector('summary')?.click();
    return { clicked: true, open: details.open === true };
  });
  assert.equal(opened.clicked, true, 'the archived reasoning row must stay clickable');
  await f.frames(2);
  const body = await f.page.evaluate(() => (window.__archivedDetails?.querySelector('.goal-log-reasoning-markdown, .goal-log-reasoning-body')?.textContent || '').replace(/\s+/g, ' '));
  assert.match(body, /ROUND1-REASON-TAIL/, 'the archived expanded body must contain the round-1 reasoning text');
});

// ---------------------------------------------------------------------------
// 9. Worker lifecycle / private thinking / activity rows stay compact.
// ---------------------------------------------------------------------------
test('worker lifecycle stays one compact row, opens the panel, and private thinking stays hidden', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const facts = await f.page.evaluate(() => {
    const log = document.getElementById('goal-output-content');
    return {
      workerRows: log.querySelectorAll('.goal-log-entry[data-kind="worker"]').length,
      workerEndRows: log.querySelectorAll('[data-log-id^="worker-end:"]').length,
      workerButtons: log.querySelectorAll('.goal-log-worker').length,
      activityRows: [...log.querySelectorAll('.goal-log-entry[data-kind="activity"]')].map(node => ({
        height: Math.round(node.getBoundingClientRect().height),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim()
      }))
    };
  });
  assert.equal(facts.workerRows, 1, 'a worker must render one lifecycle row');
  assert.equal(facts.workerEndRows, 0, 'no duplicate worker-end rows are allowed');
  assert.equal(facts.workerButtons, 1, 'one worker-panel button per lifecycle row');
  assert.ok(facts.activityRows.length >= 1, 'activity rows must render');
  for (const row of facts.activityRows) assert.ok(row.height <= 34, `activity rows must stay compact (got ${row.height}px)`);
  const text = await bodyText(f.page);
  assert.ok(!text.includes(WORKER_PRIVATE), 'worker-private thinking must stay excluded from the goal log');
  const button = f.page.locator('#goal-output-content .goal-log-worker').first();
  await button.click();
  await f.frames(3);
  const panelVisible = await f.page.locator('#worker-panel').isVisible().catch(() => false);
  const requests = (await f.hostMessages()).filter(message => message?.action === 'openWorker');
  assert.ok(panelVisible || requests.length === 1, `worker click must open the worker panel (visible=${panelVisible}, RPC=${requests.length})`);
});

// ---------------------------------------------------------------------------
// 10. Round stacking across execution.runId changes.
// ---------------------------------------------------------------------------
test('a new runId stacks rounds instead of resetting the log', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  await f.emit(run3State());
  const text = await bodyText(f.page);
  for (const marker of ['TEXT-ONE', 'TEXT-TWO', 'ROUND2-TEXT', 'ROUND3-TEXT']) {
    assert.match(text, new RegExp(marker), `${marker} content must remain visible`);
  }
  const order = ['TEXT-ONE', 'TEXT-TWO', 'ROUND2-TEXT', 'ROUND3-TEXT'].map(marker => text.indexOf(marker));
  assert.ok(order.every((value, index) => index === 0 || value > order[index - 1]), `rounds must stack oldest -> newest (order ${JSON.stringify(order)})`);
  const rounds = await roundInfo(f.page);
  assert.ok(rounds.count >= 3, `three runs must produce three rounds (found ${rounds.count})`);
  assert.match(rounds.labels.join(' | '), /第\s*1\s*轮/);
  assert.match(rounds.labels.join(' | '), /第\s*3\s*轮/);
  const ids = (await rows(f.page)).map(row => row.id);
  assert.equal(new Set(ids).size, ids.length, 'entry ids must be unique across stacked rounds');
});

// ---------------------------------------------------------------------------
// 11. Pager works across individual rows.
// ---------------------------------------------------------------------------
test('paging counts individual rows and works across stacked rounds', async t => {
  const f = await fixture(t);
  const bulk = (runId, count, prefix) => goalState({
    runId, activities: [], parts: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, type: 'text', status: 'completed', startedAt: T0 + 30000 + index, text: `${prefix} entry ${index}`
    }))
  });
  await f.emit(bulk('run-a', 90, 'A'));
  await f.emit(bulk('run-b', 60, 'B'));
  const rendered = await f.page.locator('#goal-output-content .goal-log-entry').count();
  assert.ok(rendered <= 121, `paging must cap rendered rows at one 120-entry page (got ${rendered})`);
  const pager = f.page.locator('.goal-log-pager');
  assert.equal(await pager.isVisible(), true, 'the pager must be visible for multi-page logs');
  assert.match(await pager.innerText(), /150/, 'the pager must count individual rows across stacked rounds');
  const firstId = await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id');
  await pager.getByRole('button', { name: '较早日志' }).click();
  await f.frames(2);
  assert.notEqual(await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id'), firstId, '较早日志 must page into older rows');
  await pager.getByRole('button', { name: '最新日志' }).click();
  await f.frames(2);
  assert.match(await bodyText(f.page), /B entry 59/, '最新日志 must return to the newest rows');
});

// ---------------------------------------------------------------------------
// 12. Follow-to-bottom, scroll-up stop and 回到底部 with individual rows.
// ---------------------------------------------------------------------------
test('follow-to-bottom works with chronological rows and scroll-up stops it', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  const longRun = tick => goalState({
    runId: 'run-2',
    parts: [
      { id: 'r2-reason', type: 'thinking', source: 'reason', status: 'running', startedAt: T0 + 10000, text: 'ROUND2-REASON：进行中 ' + tick },
      { id: 'r2-text', type: 'text', status: 'streaming', startedAt: T0 + 11000, text: R2_TEXT + ' 长文本。'.repeat(300) }
    ],
    activities: []
  });
  await f.emit(longRun(1));
  await f.emit(longRun(2));
  const read = () => f.page.evaluate(() => {
    const log = document.getElementById('goal-output-content');
    return { following: log?.dataset.following ?? null, top: log?.scrollTop ?? null, height: log?.scrollHeight ?? null, client: log?.clientHeight ?? null };
  });
  const before = await read();
  assert.ok(before.height - before.client > 80, `log must be scrollable for the follow test (got ${before.height - before.client})`);
  assert.equal(before.following, 'true', 'the log must follow new output by default');
  assert.ok(before.height - before.top - before.client < 40, 'the log must be pinned near the bottom while following');
  await f.page.locator('#goal-output-content').evaluate(node => { node.scrollTop = 0; });
  await f.frames(2);
  assert.equal((await read()).following, 'false', 'scrolling up must stop following');
  await f.page.locator('#goal-log-bottom').click();
  await f.frames(2);
  assert.equal((await read()).following, 'true', '回到底部 must re-enable following');
});

// ---------------------------------------------------------------------------
// 13. Session switch clears stacked rounds.
// ---------------------------------------------------------------------------
test('switching session clears stacked rounds and their rows', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  assert.match(await bodyText(f.page), /TEXT-ONE/);
  await f.emit(goalState({ sessionId: 'goal-rounds-v5-other', runId: 'run-other', parts: [{ id: 'other-text', type: 'text', status: 'completed', startedAt: now, text: 'OTHER SESSION CONTENT' }] }));
  const text = await bodyText(f.page);
  assert.ok(!text.includes('TEXT-ONE') && !text.includes('TEXT-TWO'), 'session switch must clear previous rows');
  assert.match(text, /OTHER SESSION CONTENT/, 'the new session renders its own rows');
  assert.ok((await roundInfo(f.page)).count <= 1, 'no round headers from the previous session');
});

// ---------------------------------------------------------------------------
// 14. Bounded round memory (eviction).
// ---------------------------------------------------------------------------
test('round count stays bounded when many runs accumulate', async t => {
  const f = await fixture(t);
  const total = 25;
  const marker = round => `CAP-ROUND-${String(round).padStart(2, '0')}`;
  for (let round = 1; round <= total; round++) {
    await f.emit(goalState({
      runId: 'run-cap-' + round, activities: [],
      parts: [{ id: 'cap-' + round, type: 'text', status: 'completed', startedAt: now - (total - round) * 1000, text: marker(round) }]
    }));
  }
  const facts = await f.page.evaluate(() => ({
    text: document.getElementById('goal-output-content')?.textContent || '',
    entries: document.querySelectorAll('#goal-output-content .goal-log-entry').length,
    rounds: document.querySelectorAll('#goal-output-content .goal-log-round-heading, #goal-output-content [data-round-header]').length
  }));
  assert.match(facts.text, /CAP-ROUND-25/, 'the newest round must stay visible');
  assert.equal(/CAP-ROUND-01(?!\d)/.test(facts.text), false, 'old rounds must be evicted once the round cap is reached');
  assert.ok(facts.rounds >= 2 && facts.rounds < total, `round memory must be bounded (rendered ${facts.rounds} of ${total})`);
  assert.ok(facts.entries <= 130, `evicted rounds must release their DOM rows (got ${facts.entries})`);
});

// ---------------------------------------------------------------------------
// 15. Dark theme parity.
// ---------------------------------------------------------------------------
test('chronological rows and reasoning lines follow the dark theme tokens', async t => {
  const f = await fixture(t);
  await f.emit(run1State());
  await f.emit(run2State(1));
  const read = () => f.page.evaluate(() => {
    const panel = getComputedStyle(document.querySelector('.goal-output-panel'));
    return { background: panel.backgroundColor, color: panel.color, entries: document.querySelectorAll('#goal-output-content .goal-log-entry').length };
  });
  const light = await read();
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames(2);
  const dark = await read();
  assert.notDeepEqual(dark, light, 'the goal log must follow the dark theme tokens');
  assert.ok(dark.entries >= light.entries, 'theme switch must keep chronological rows visible');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
});

// ---------------------------------------------------------------------------
// 16. 430px narrow layout has no horizontal overflow.
// ---------------------------------------------------------------------------
test('chronological rows fit a 430px viewport without horizontal overflow', async t => {
  const f = await fixture(t, { width: 430, height: 900 });
  await f.emit(run1State());
  await f.emit(run2State(1));
  const facts = await f.page.evaluate(() => {
    const log = document.getElementById('goal-output-content');
    const rect = log?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      contentScrollWidth: log?.scrollWidth ?? null,
      contentClientWidth: log?.clientWidth ?? null,
      rect: rect ? { left: rect.left, right: rect.right } : null,
      text: (log?.textContent || '')
    };
  });
  assert.equal(facts.documentScrollWidth, facts.innerWidth, `document scrollWidth ${facts.documentScrollWidth} must equal the 430px viewport`);
  assert.ok(facts.contentScrollWidth <= facts.contentClientWidth + 1, `log content must not scroll sideways (${facts.contentScrollWidth} > ${facts.contentClientWidth})`);
  assert.ok(facts.rect && facts.rect.left >= -1 && facts.rect.right <= facts.innerWidth + 1, 'the log panel must stay inside the 430px viewport');
  assert.match(facts.text, /TEXT-ONE|ROUND2/, 'chronological content stays present at 430px');
});
