// Independent end-to-end verification for 思考与调度日志 v2 (exploration mode goal
// log). Drives the real webview bundle (renderWebview) with a mocked VS Code host
// bridge and a rich goal `state` fixture, then asserts the visible contract from
// .tmp-log/contract.md (Verification section):
//
//   reasoning card: merged consecutive reason thinking, 2-line preview + 展开,
//     expanded markdown, streaming auto-open/append, manual collapse persists,
//     protocol JSON folded, bounded internal scroll with reader position kept;
//   scheduling log: one chronological Reason timeline (no phase bands), compact
//     activity rows, one worker lifecycle row (worker thinking/output stays in
//     the worker panel), compact tool rows.
//     status transitions/error/open-worker, compact expandable tool rows with copy;
//   header 展开思考/收起思考 expand-all toggle (visible only with reasoning);
//   follow-to-bottom + paging still work; dark/light/430px no horizontal overflow;
//   no page errors / console errors / remote requests in every case.
//
// This file is independent of goal-log-card.mjs (implementation-owned).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://goal-log-v2-e2e.test/';
const now = Date.now();
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

// ---------------------------------------------------------------------------
// Fixtures: rich goal execution (Reason thinking, worker parts, tools, live).
// ---------------------------------------------------------------------------
const REASON_LONG = [
  '先核对 **执行边界** 与事件顺序，再确认持久化路径。',
  '',
  '### 计划',
  '- 读取 `goal/execution-log.js` 的 entry 构建逻辑；',
  '- 核对 Worker 分派与结束事件是否重复；',
  '- 确认长文本日志在面板内滚动而不是撑高页面。',
  '',
  '```json',
  '{"intents":[{"id":"plan-1","action":"inspect","target":"goal/execution-log.js"}],"decision":"dispatch"}',
  '```',
  '',
  '### 风险',
  '> 协议 JSON 不应作为正文渲染，折叠为占位行。',
  '',
  '继续检查第二阶段：**阶段分隔** 与紧凑活动行。' + ' 详细核对清单与证据。'.repeat(10)
].join('\n');
const REASON_SHORT = '补充：连续 Reason 思考应合并为一个卡片，保留第一段 id。';
const REASON_THIRD = '第三段 Reason 思考应当独立成卡（中间隔着工具活动）。';
const PROTOCOL_MARKER = '[规划协议内容已折叠]';

function goalState({ execution = {}, busy = false, goal = true } = {}) {
  return {
    type: 'state', mode: 'goal',
    conversation: { id: 'goal-log-v2-e2e', title: '思考与调度日志 v2' },
    goal: goal ? { objective: '优化探索模式的思考与调度日志展示', criteria: ['思考内容可读', '调度日志紧凑'], notes: [] } : null,
    messages: [],
    provider: { configured: true, connected: true, label: '测试模型' },
    context: { workspace: 'UBOVM', file: '' },
    busy,
    execution: { status: 'idle', busy: false, phase: 'execute', parts: [], workers: [], activities: [], streamText: '', ...execution }
  };
}
const part = (id, overrides = {}) => ({ id, type: 'text', status: 'completed', text: '', ...overrides });
const activity = (label, overrides = {}) => ({ label, status: 'completed', timestamp: now + (overrides.offset ?? 0), ...overrides });

const COMPLETED_WORKER = {
  id: 'w-review', name: 'reviewer', description: '审查日志渲染与阶段分组实现',
  status: 'completed', createdAt: now - 90000, startedAt: now - 88000, finishedAt: now - 70000, parts: []
};
const RUNNING_WORKER = {
  id: 'w-build', name: 'builder', description: '实现紧凑活动行与合并 Worker 生命周期行',
  status: 'running', createdAt: now - 60000, startedAt: now - 58000,
  parts: [{ id: 'worker-private-think', type: 'thinking', source: 'worker', status: 'running', text: '仅 Worker 详情可见' }]
};
const QUEUED_WORKER = { id: 'w-test', name: 'tester', description: '运行回归矩阵并采集截图', status: 'queued', createdAt: now - 20000 };

function richExecution(overrides = {}) {
  return {
    status: 'running', busy: true, phase: 'execute',
    parts: [
      part('think-a', { type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 120000, endedAt: now - 108000, text: REASON_LONG }),
      part('think-b', { type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 107000, endedAt: now - 104000, text: REASON_SHORT }),
      part('conclusion', { type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 103000, endedAt: now - 102000, text: '结论：先合并 Reason 思考并加入阶段分隔。' }),
      part('separator-text', { type: 'text', status: 'completed', startedAt: now - 100000, text: '开始分派任务。' }),
      part('think-c', { type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 99000, endedAt: now - 96000, text: REASON_THIRD }),
      { id: 'tool-search', type: 'tool', name: 'search_web', status: 'completed', args: '{"query":"goal log phase"}', output: '3 results', startedAt: now - 90000, endedAt: now - 88500 },
      { id: 'tool-read', type: 'tool', name: 'read_workspace_file', status: 'completed', args: '{"path":"src/renderer/webview/goal/execution-log.js"}', output: 'file content', startedAt: now - 85000, endedAt: now - 84500 },
      { id: 'tool-exec', type: 'tool', name: 'run_linux_ssh_command', status: 'completed', args: '{"command":"node --test goal-log-v2.e2e.mjs"}', output: 'ok 9 - goal log v2\n# pass 9', startedAt: now - 80000, endedAt: now - 78000 },
      part('think-live', { type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000, text: '正在核对 streaming 自动展开与手动收起状态。' })
    ],
    workers: [COMPLETED_WORKER, RUNNING_WORKER, QUEUED_WORKER],
    activities: [
      activity('Reason', { timestamp: now - 119000, key: 'reason-1' }),
      activity('todo', { timestamp: now - 118000, key: 'todo-1' }),
      activity('spawn_worker', { timestamp: now - 70000, key: 'spawn-1' }),
      activity('inspect_dom', { timestamp: now - 88000, key: 'inspect-1' }),
      activity('manage_workers', { timestamp: now - 69000, key: 'manage-1' }),
      activity('wait_workers', { status: 'running', timestamp: now - 3000, key: 'wait-1' })
    ],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
async function fixture(t, { width = 1100, height = 900 } = {}) {
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
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'goal-log-v2-e2e' })
  }));
  await page.goto(origin);
  const frames = (count = 2) => page.evaluate(async amount => {
    for (let index = 0; index < amount; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
  const emit = async value => {
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), value);
    await frames(2);
  };
  const log = page.locator('#goal-output-content');
  const entries = page.locator('#goal-output-content .goal-log-entry');
  const reasoningCards = page.locator('#goal-output-content .goal-log-entry').filter({ hasText: 'Reason 思考' });
  const hostMessages = () => page.evaluate(() => window.hostMessages.slice());
  const settle = async (locator, count, timeout = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const found = await locator.count().catch(() => 0);
      if (found >= count) return found;
      await page.waitForTimeout(20);
    }
    return locator.count().catch(() => 0);
  };
  const api = { page, frames, emit, log, entries, reasoningCards, hostMessages, settle };
  // Boot: empty goal state paints the shell/panel.
  await emit(goalState());
  await page.waitForFunction(() => document.body.dataset.loading === 'false', undefined, { timeout: 8000 }).catch(() => {});
  t.after(async () => {
    await page.close().catch(() => {});
    assert.deepEqual(pageErrors, [], 'the goal log must not throw page errors');
    assert.deepEqual(consoleErrors, [], 'the goal log must not log console errors');
    assert.deepEqual(remoteRequests, [], 'the goal log must not request remote resources');
  });
  api.assertVisible = async (locator, count = 1, label = 'element') => {
    const found = await settle(locator, count);
    assert.ok(found >= count, `${label} must be visible (found ${found}, expected ${count})`);
    return locator;
  };
  return api;
}

const reasonCard = (f, id) => f.page.locator(`#goal-output-content [data-log-id="${id}"]`);
const bodyOf = card => card.locator('details > :not(summary)').first();

// ---------------------------------------------------------------------------
// 1. Reasoning card: merged consecutive Reason thinking, preview + 展开, header.
// ---------------------------------------------------------------------------
test('reason thinking merges consecutive parts into one card with a 2-line preview and 展开', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  assert.equal(await f.reasoningCards.count(), 3,
    'consecutive Reason thinking parts must merge into one card (think-a+think-b), plus think-c and the live card');
  const merged = reasonCard(f, 'part:think-a');
  assert.equal(await merged.count(), 1, 'the merged card must keep the first part data-log-id (part:think-a)');
  assert.equal(await reasonCard(f, 'part:think-b').count(), 0, 'the second consecutive reason part must not render its own row');
  const text = await merged.innerText();
  assert.match(text, /Reason 思考/, 'the reasoning card must carry the Reason 思考 label');
  assert.match(text, /已思考|思考中/, 'the reasoning card must show its status text');
  assert.match(text, /\b\d+(?:\.\d+)?s\b|\d+m\s?\d+s/, `the reasoning card must show its duration (got ${JSON.stringify(text.slice(0, 120))})`);
  assert.match(text, /展开/, 'a collapsed reasoning card must expose a quiet 展开 affordance');
  assert.ok(text.includes('先核对') && text.includes('执行边界'),
    `the collapsed reasoning card must preview the reasoning text (got ${JSON.stringify(text.slice(0, 200))})`);
  // The preview must be clamped to two visual lines (contract): the clamped box is
  // the preview container (the inline text span itself has no box), so walk up from
  // the text and require a two-line clamp/height.
  const preview = await merged.evaluate(node => {
    const candidates = [...node.querySelectorAll('*')].filter(element => (element.textContent || '').trim().startsWith('先核对'));
    for (const candidate of candidates) {
      let current = candidate;
      for (let depth = 0; depth < 5 && current && current !== node; depth++, current = current.parentElement) {
        const style = getComputedStyle(current);
        const clamp = Number(style.webkitLineClamp || style.lineClamp || 0);
        const lineHeight = parseFloat(style.lineHeight) || 0;
        const height = current.clientHeight;
        const boxed = style.display !== 'inline' && style.display !== 'contents';
        if (boxed && (clamp === 2 || (height > 0 && lineHeight > 0 && height <= lineHeight * 2 + 4))) {
          return {
            clamp, height, lineHeight,
            scrollHeight: current.scrollHeight,
            visible: current.getClientRects().length > 0
          };
        }
      }
    }
    return null;
  });
  assert.ok(preview, 'a collapsed reasoning card must render a visible two-line preview element');
  assert.equal(preview.visible, true, 'the reasoning preview must be visible while the card is collapsed');
  const clamped = preview.clamp === 2 || (preview.height > 0 && preview.height <= preview.lineHeight * 2 + 4);
  assert.ok(clamped, `the reasoning preview must be clamped to 2 lines (got ${JSON.stringify(preview)})`);
  const collapsed = await merged.evaluate(node => {
    const details = node.querySelector('details');
    return details ? details.open : null;
  });
  assert.equal(collapsed, false, 'completed reasoning cards must default collapsed (with preview)');
});

// ---------------------------------------------------------------------------
// 2. Expanded reasoning card renders the full markdown body.
// ---------------------------------------------------------------------------
test('expanding a reasoning card shows its full markdown body', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const merged = reasonCard(f, 'part:think-a');
  await f.assertVisible(merged, 1, 'merged reasoning card');
  const summary = merged.locator('details > summary').first();
  if (await summary.count()) await summary.click();
  else await merged.getByText('展开', { exact: false }).first().click();
  await f.frames(2);
  const expanded = await merged.evaluate(node => {
    const details = node.querySelector('details');
    const body = details?.querySelector(':scope > :not(summary)');
    return {
      open: details ? details.open : null,
      bodyVisible: body ? body.getClientRects().length > 0 : false,
      markdown: body ? {
        strong: body.querySelectorAll('strong').length,
        headings: body.querySelectorAll('h1,h2,h3,h4').length,
        lists: body.querySelectorAll('ul,ol').length,
        code: body.querySelectorAll('code').length
      } : null
    };
  });
  assert.equal(expanded.open, true, 'clicking the reasoning summary/展开 must open the card');
  assert.equal(expanded.bodyVisible, true, 'the expanded reasoning body must be visible');
  assert.ok(expanded.markdown.strong >= 1 && expanded.markdown.lists >= 1 && expanded.markdown.code >= 1,
    `expanded reasoning must render markdown (strong/lists/inline code): ${JSON.stringify(expanded.markdown)}`);
  const text = await merged.innerText();
  assert.ok(text.includes('详细核对清单与证据'), 'the expanded body must contain the full reasoning text');
});

// ---------------------------------------------------------------------------
// 3. Protocol JSON folded to a placeholder, never rendered as prose.
// ---------------------------------------------------------------------------
test('protocol JSON in reasoning is folded into [规划协议内容已折叠]', async t => {
  const f = await fixture(t);
  const execution = richExecution();
  execution.parts = [
    part('think-proto', {
      type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 50000, endedAt: now - 40000,
      text: ['计划如下：', '', '```json', '{"intents":[{"id":"proto-1"}],"decision":"dispatch"}', '```', '', '{"plan":[{"step":"raw-json-line"}]}', '', '继续核对普通 Markdown：**加粗** 与 `代码`。'].join('\n')
    })
  ];
  await f.emit(goalState({ busy: false, execution }));
  const card = reasonCard(f, 'part:think-proto');
  await f.assertVisible(card, 1, 'protocol reasoning card');
  const summary = card.locator('details > summary').first();
  if (await summary.count()) await summary.click();
  else await card.getByText('展开', { exact: false }).first().click();
  await f.frames(2);
  const text = await card.innerText();
  assert.ok(text.includes(PROTOCOL_MARKER), `folded protocol content must show ${PROTOCOL_MARKER} (got ${JSON.stringify(text.slice(0, 240))})`);
  assert.doesNotMatch(text, /"intents"|"decision"\s*:|"plan"\s*:/,
    'raw protocol/plan JSON must never be rendered as prose');
  assert.match(text, /加粗|继续核对/, 'normal prose around the folded protocol must stay readable');
});

// ---------------------------------------------------------------------------
// 4. Streaming reasoning auto-opens, appends, and manual collapse persists.
// ---------------------------------------------------------------------------
test('streaming reasoning auto-opens, appends live text and keeps manual collapse', async t => {
  const f = await fixture(t);
  const live = () => part('think-live', {
    type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000,
    text: '实时思考第一段。'
  });
  const execution = richExecution();
  execution.parts = [...execution.parts.filter(entry => entry.id !== 'think-live'), live()];
  execution.workers = [RUNNING_WORKER];
  await f.emit(goalState({ busy: true, execution }));
  const card = reasonCard(f, 'part:think-live');
  await f.assertVisible(card, 1, 'live reasoning card');
  let state = await card.evaluate(node => {
    const details = node.querySelector('details');
    return { open: details ? details.open : false, text: node.innerText };
  });
  assert.equal(state.open, true, 'a streaming reasoning card must auto-open');
  assert.match(state.text, /实时思考第一段/);

  const updated = richExecution();
  updated.parts = [...execution.parts.filter(entry => entry.id !== 'think-live'), part('think-live', {
    type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000,
    text: '实时思考第一段。第二段追加。'
  })];
  updated.workers = [RUNNING_WORKER];
  await f.emit(goalState({ busy: true, execution: updated }));
  state = await card.evaluate(node => ({ open: node.querySelector('details')?.open, text: node.innerText, count: document.querySelectorAll('[data-log-id="part:think-live"]').length }));
  assert.equal(state.open, true, 'the streaming card must stay open across live updates');
  assert.match(state.text, /第二段追加/, 'the live update must append text into the same card');
  assert.equal(state.count, 1, 'live reasoning must update one card, not create duplicates');

  // Manual collapse must survive further updates for that entry.
  await card.locator('details > summary').first().click();
  await f.frames(2);
  assert.equal(await card.evaluate(node => node.querySelector('details')?.open), false, 'manual collapse must close the streaming card');
  const third = richExecution();
  third.parts = [...execution.parts.filter(entry => entry.id !== 'think-live'), part('think-live', {
    type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000,
    text: '实时思考第一段。第二段追加。第三段继续。'
  })];
  await f.emit(goalState({ busy: true, execution: third }));
  const after = await card.evaluate(node => ({ open: node.querySelector('details')?.open, text: node.innerText }));
  assert.equal(after.open, false, 'manual collapse must persist across live updates');
  assert.match(after.text, /第三段继续/, 'text must keep updating while the card stays manually collapsed');
});

// ---------------------------------------------------------------------------
// 5. Long reasoning gets a bounded internal scroll that keeps the reader position.
// ---------------------------------------------------------------------------
test('very long reasoning scrolls inside a bounded card and keeps the reader position', async t => {
  const f = await fixture(t);
  const longText = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：核对执行边界、事件顺序与持久化路径。`).join('\n\n');
  const execution = richExecution();
  execution.parts = [part('think-long', { type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000, text: longText })];
  execution.workers = [];
  await f.emit(goalState({ busy: true, execution }));
  const card = reasonCard(f, 'part:think-long');
  await f.assertVisible(card, 1, 'long reasoning card');
  const body = card.locator('details > :not(summary)').first();
  const scrollInfo = await body.evaluate(node => {
    const style = getComputedStyle(node);
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflow: style.overflowY,
      viewportHeight: window.innerHeight
    };
  });
  assert.ok(scrollInfo.scrollHeight > scrollInfo.clientHeight + 40,
    `long reasoning must scroll internally (client ${scrollInfo.clientHeight}, scroll ${scrollInfo.scrollHeight})`);
  assert.ok(['auto', 'scroll'].includes(scrollInfo.overflow), 'the bounded reasoning body must own an internal scroll');
  assert.ok(scrollInfo.clientHeight <= Math.min(460, scrollInfo.viewportHeight * 0.52) + 2,
    `the reasoning body must be bounded (~min(52vh,460px)); got ${scrollInfo.clientHeight}px`);
  await body.evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2); });
  const beforeTop = await body.evaluate(node => node.scrollTop);
  assert.ok(beforeTop > 0, 'the test must scroll the reasoning body away from the top');
  await f.emit(goalState({ busy: true, execution: {
    ...execution,
    parts: [part('think-long', { type: 'thinking', source: 'reason', status: 'running', startedAt: now - 5000, text: longText + '\n\n新增一段实时内容。' })]
  } }));
  const afterTop = await body.evaluate(node => node.scrollTop);
  assert.ok(Math.abs(afterTop - beforeTop) <= 16,
    `live updates must preserve the reader's internal scroll position (${beforeTop}px → ${afterTop}px)`);
});

// ---------------------------------------------------------------------------
// 6. One chronological timeline; no phase bands that can reorder the story.
// ---------------------------------------------------------------------------
test('the log keeps plan/dispatch/execute/result in chronological order without phase bands', async t => {
  const f = await fixture(t);
  const execution = richExecution({
    status: 'completed', busy: false,
    result: { summary: '执行完成：日志已按阶段收敛。' }
  });
  await f.emit(goalState({ busy: false, execution }));
  assert.equal(await f.page.locator('#goal-output-content .goal-log-phase').count(), 0,
    'the log is one chronological timeline, not phase bands');
  const order = await f.page.evaluate(() => [...document.querySelectorAll('#goal-output-content .goal-log-entry')].map(row => row.dataset.logId));
  const indexOf = id => order.indexOf(id);
  assert.ok(indexOf('part:think-a') >= 0, 'reasoning entries must still render in the log');
  assert.ok(indexOf('worker:w-review') >= 0, 'worker lifecycle rows must still render in the log');
  assert.ok(indexOf('part:tool-exec') >= 0, 'tool entries must still render in the log');
  assert.ok(indexOf('result') >= 0, 'the result entry must render in the log');
  assert.ok(indexOf('part:think-a') < indexOf('worker:w-review'), 'plan reasoning must stay before dispatched workers');
  assert.ok(indexOf('worker:w-review') < indexOf('part:tool-exec'), 'dispatch workers must stay before executed tools');
  assert.ok(indexOf('part:tool-exec') < indexOf('result'), 'the result must stay last');
});

// ---------------------------------------------------------------------------
// 7. Compact activity rows.
// ---------------------------------------------------------------------------
test('activity rows are compact single-line rows that keep data-activity', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const activityRows = f.page.locator('#goal-output-content .goal-log-entry[data-kind="activity"]');
  const count = await f.settle(activityRows, 2);
  assert.ok(count >= 2, `activity entries must render (found ${count})`);
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry[data-kind="activity"][data-activity="plan"]').count() >= 1, true,
    'plan/dispatch/search data-activity values must be preserved on activity rows');
  const metrics = await activityRows.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    const body = node.querySelector('.goal-log-body');
    // Only rows that are truly adjacent in the DOM (nothing between them but phase
    // dividers) are expected to sit tight; other entries legitimately separate groups.
    let previousEntry = node.previousElementSibling;
    while (previousEntry && previousEntry.classList.contains('goal-log-phase')) previousEntry = previousEntry.previousElementSibling;
    return {
      height: Math.round(rect.height),
      bottom: rect.bottom,
      top: rect.top,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : 0,
      text: node.textContent.replace(/\s+/g, ' ').trim(),
      className: node.className,
      adjacentToPreviousActivity: Boolean(previousEntry && previousEntry.matches('.goal-log-entry[data-kind="activity"]'))
    };
  }));
  for (const row of metrics) {
    assert.match(row.className, /goal-log-entry/, 'activity rows must keep the .goal-log-entry class');
    assert.ok(row.height <= 34, `activity rows must be compact single-line rows (got ${row.height}px: ${JSON.stringify(row.text.slice(0, 80))})`);
    assert.ok(row.bodyHeight <= 4, `activity rows must not leave an empty body gap (body ${row.bodyHeight}px)`);
  }
  const gaps = [];
  for (let index = 1; index < metrics.length; index++) {
    if (!metrics[index].adjacentToPreviousActivity) continue;
    gaps.push(Math.round(metrics[index].top - metrics[index - 1].bottom));
  }
  for (const gap of gaps) assert.ok(gap <= 10, `consecutive activity rows must sit tight (gap ${gap}px)`);
});

// ---------------------------------------------------------------------------
// 8. Worker lifecycle is one dispatch row; worker output stays in the panel.
// ---------------------------------------------------------------------------
test('worker lifecycle renders one dispatch row without worker output or end rows', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  await f.settle(f.page.locator('#goal-output-content .goal-log-entry'), 5);
  assert.equal(await f.page.locator('#goal-output-content [data-log-id="worker:w-review"]').count(), 1,
    'a completed worker must render exactly one dispatch row');
  assert.equal(await f.page.locator('#goal-output-content [data-log-id^="worker-end:"]').count(), 0,
    'worker output must not create settlement rows');
  const text = await f.page.locator('#goal-output-content [data-log-id="worker:w-review"]').innerText();
  assert.match(text, /reviewer/, 'the dispatch row must keep its name button');
  assert.match(text, /已完成/, `the dispatch row must show its status chip (got ${JSON.stringify(text.slice(0, 160))})`);
  assert.doesNotMatch(text, /result|结果/, 'worker result output stays out of the Reason log');
  const running = await f.page.locator('#goal-output-content [data-log-id="worker:w-build"]').innerText();
  assert.match(running, /运行中/, 'a running worker row must show 运行中');
  const queued = await f.page.locator('#goal-output-content [data-log-id="worker:w-test"]').innerText();
  assert.match(queued, /排队中|已派发/, 'created/queued worker shows one lifecycle status chip');
  assert.equal(await f.page.locator('#goal-output-content .goal-log-worker').count(), 3,
    'each dispatch row keeps one worker-panel button');
});

// ---------------------------------------------------------------------------
// 9. Worker lifecycle transitions and open-worker click.
// ---------------------------------------------------------------------------
test('worker lifecycle row transitions status without growing worker output', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const row = f.page.locator('#goal-output-content [data-log-id="worker:w-build"]');
  await f.assertVisible(row, 1, 'running worker row');
  assert.match(await row.innerText(), /运行中/);
  const failedWorker = { ...RUNNING_WORKER, status: 'failed', finishedAt: now - 1000, error: 'worker 启动失败：模型连接中断（ECONNRESET）。' };
  await f.emit(goalState({ busy: false, execution: {
    ...richExecution(),
    status: 'running', busy: true,
    workers: [COMPLETED_WORKER, failedWorker, QUEUED_WORKER]
  } }));
  assert.equal(await f.page.locator('#goal-output-content [data-log-id="worker:w-build"]').count(), 1,
    'a status transition must update the same dispatch row');
  assert.equal(await f.page.locator('#goal-output-content [data-log-id^="worker-end:"]').count(), 0);
  assert.equal(await row.locator('.execution-error').count(), 0, 'worker errors stay in the worker panel, not the log');
  assert.doesNotMatch(await row.innerText(), /ECONNRESET/);
  assert.match(await row.innerText(), /失败/, 'the dispatch row still shows the failed lifecycle status');
  assert.equal(await row.locator('.goal-log-worker').count(), 1,
    'a worker status transition must keep one worker name button (no duplicated lifecycle body)');

  // Clicking the worker button must open the worker panel. In goal mode the log
  // opens the webview worker panel locally; a native worker panel would use the
  // openWorker host RPC instead — accept either path.
  const button = row.locator('.goal-log-worker').first();
  await button.click();
  await f.frames(3);
  const panel = f.page.locator('#worker-panel');
  const panelVisible = await panel.isVisible().catch(() => false);
  const requests = (await f.hostMessages()).filter(message => message?.action === 'openWorker');
  assert.ok(panelVisible || requests.length === 1,
    `clicking the worker button must open the worker panel (local panel visible=${panelVisible}, openWorker RPC=${requests.length})`);
  if (panelVisible) {
    const panelText = await panel.innerText();
    assert.match(panelText, /builder|w-build/, 'the worker panel must show the clicked worker');
    // Re-clicking must stay idempotent: one panel, no duplicate stack.
    await button.click();
    await f.frames(2);
    assert.equal(await f.page.locator('#worker-panel').count(), 1, 'clicking the worker button twice must keep a single worker panel');
  } else {
    assert.equal(requests[0].workerId, 'w-build', 'the openWorker RPC must name the clicked worker');
    const requestId = requests[0].requestId;
    if (requestId) {
      await f.emit({ type: 'uiResult', requestId, ok: true });
      await f.frames(2);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. Compact tool rows expand to args/output and keep the copy action.
// ---------------------------------------------------------------------------
test('compact tool rows expand to args/output and keep the copy action', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: false, execution: richExecution({ status: 'running', busy: false }) }));
  const row = f.page.locator('#goal-output-content .goal-log-entry[data-kind="tool"][data-log-id="part:tool-exec"]');
  await f.assertVisible(row, 1, 'tool log row');
  const collapsed = await row.evaluate(node => ({
    height: Math.round(node.getBoundingClientRect().height),
    text: node.textContent.replace(/\s+/g, ' ').trim()
  }));
  assert.ok(collapsed.height <= 60, `the collapsed tool row must be a compact log line (got ${collapsed.height}px)`);
  assert.match(collapsed.text, /node --test|运行命令/, 'the collapsed tool row must show its label/target');
  const summary = row.locator('details > summary, summary').first();
  if (await summary.count()) await summary.click();
  else await row.getByText('运行命令', { exact: false }).first().click();
  await f.frames(2);
  const expanded = await row.evaluate(node => ({
    open: node.querySelector('details')?.open,
    bodyVisible: Boolean(node.querySelector('.tool-card-body, .tool-output, .tool-arguments')?.getClientRects().length),
    text: node.textContent
  }));
  assert.equal(expanded.open ?? expanded.bodyVisible, true, 'clicking the tool row must expand its detail');
  assert.match(expanded.text, /node --test goal-log-v2/, 'the expanded tool row must show its arguments');
  assert.match(expanded.text, /pass 9/, 'the expanded tool row must show its output');
  const copy = row.getByRole('button', { name: /复制/ }).first();
  assert.ok(await copy.count() >= 1, 'the expanded tool row must keep the copy-output action');
  await copy.click();
  await f.frames(1);
  const copies = (await f.hostMessages()).filter(message => message?.action === 'copyText');
  assert.ok(copies.length >= 1, 'clicking copy must post the copyText RPC');
});

// ---------------------------------------------------------------------------
// 11. Header 展开思考 / 收起思考 expand-all toggle.
// ---------------------------------------------------------------------------
test('header expand-all reasoning toggle expands/collapses all cards and updates its label', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const toggle = f.page.locator('.goal-output-actions button').filter({ hasText: /展开思考|收起思考/ }).first();
  const toggleCount = await f.settle(toggle, 1);
  assert.equal(toggleCount, 1, 'the header must expose one quiet 展开思考/收起思考 action when reasoning exists');
  assert.match(await toggle.innerText(), /展开思考/);
  await toggle.click();
  await f.frames(2);
  const afterExpand = await f.reasoningCards.evaluateAll(nodes => nodes.map(node => node.querySelector('details')?.open ?? null));
  assert.ok(afterExpand.length >= 2 && afterExpand.every(open => open === true),
    `展开思考 must expand all reasoning cards (got ${JSON.stringify(afterExpand)})`);
  assert.match(await toggle.innerText(), /收起思考/, 'the toggle label must switch to 收起思考');
  await toggle.click();
  await f.frames(2);
  const afterCollapse = await f.reasoningCards.evaluateAll(nodes => nodes.map(node => node.querySelector('details')?.open ?? null));
  assert.ok(afterCollapse.every(open => open === false), `收起思考 must collapse all reasoning cards (got ${JSON.stringify(afterCollapse)})`);
  assert.match(await toggle.innerText(), /展开思考/, 'the toggle label must switch back to 展开思考');
  assert.equal(await f.page.locator('#goal-log-bottom').isVisible(), true, '回到底部 must stay available next to the toggle');

  // Hidden when the log has no reasoning entries (the markup keeps the button,
  // but it must not be visible/usable).
  await f.emit(goalState({ busy: false, execution: { status: 'idle', busy: false, parts: [], workers: [], activities: [] } }));
  const hiddenToggle = f.page.locator('.goal-output-actions button').filter({ hasText: /展开思考|收起思考/ }).first();
  assert.equal(await hiddenToggle.count() === 0 || await hiddenToggle.isVisible() === false, true,
    'the reasoning toggle must not be visible when there are no reasoning entries');
});

// ---------------------------------------------------------------------------
// 12. Follow-to-bottom and paging still work with the new markup.
// ---------------------------------------------------------------------------
test('follow-to-bottom and 120-entry paging still work with the new log markup', async t => {
  const f = await fixture(t);
  const growing = richExecution();
  growing.parts = [
    ...growing.parts,
    part('stream', { type: 'text', status: 'streaming', text: '流式输出第一段。' })
  ];
  await f.emit(goalState({ busy: true, execution: growing }));
  const follow = await f.page.evaluate(() => {
    const content = document.getElementById('goal-output-content');
    return { following: content.dataset.following, atBottom: content.scrollHeight - content.scrollTop - content.clientHeight < 40 };
  });
  assert.equal(follow.following, 'true', 'the log must follow new output by default');
  assert.equal(follow.atBottom, true, 'the log must stay pinned to the bottom while following');
  await f.page.locator('#goal-output-content').evaluate(node => { node.scrollTop = 0; });
  await f.frames(2);
  assert.equal(await f.page.locator('#goal-output-content').evaluate(node => node.dataset.following), 'false',
    'scrolling up must stop following');
  await f.page.locator('#goal-log-bottom').click();
  await f.frames(2);
  assert.equal(await f.page.locator('#goal-output-content').evaluate(node => node.dataset.following), 'true',
    '回到底部 must re-enable following');

  // 3000 lightweight entries exercise the 120-entry pager.
  const many = { status: 'completed', busy: false, phase: 'execute', parts: [], workers: [], activities: [] };
  for (let index = 0; index < 3000; index++) many.parts.push(part('p' + index, { type: 'text', status: 'completed', text: '日志条目 ' + index }));
  await f.emit(goalState({ busy: false, execution: many }));
  const rendered = await f.settle(f.page.locator('#goal-output-content .goal-log-entry'), 120, 15000);
  assert.equal(rendered, 120, `paging must render one page of 120 entries (got ${rendered})`);
  const pager = f.page.locator('.goal-log-pager');
  assert.equal(await pager.isVisible(), true, 'the pager must be visible for long logs');
  assert.match(await pager.innerText(), /3000/, 'the pager must report the total entry count');
  const lastId = await f.page.locator('#goal-output-content .goal-log-entry').last().getAttribute('data-log-id');
  assert.equal(lastId, 'part:p2999', 'the latest page must end with the newest entry');
  const firstId = await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id');
  await pager.getByRole('button', { name: '较早日志' }).click();
  await f.frames(2);
  assert.notEqual(await f.page.locator('#goal-output-content .goal-log-entry').first().getAttribute('data-log-id'), firstId,
    '较早日志 must page to an older window');
  assert.equal(await f.page.locator('#goal-output-content').evaluate(node => node.scrollTop), 0,
    'paging must reset the log to the top of the older page');
  await pager.getByRole('button', { name: '最新日志' }).click();
  await f.frames(2);
  assert.equal(await f.page.locator('#goal-output-content .goal-log-entry').last().getAttribute('data-log-id'), 'part:p2999',
    '最新日志 must return to the newest page');
});

// ---------------------------------------------------------------------------
// 13. Keyboard accessibility + worker-private thinking exclusion.
// ---------------------------------------------------------------------------
test('reasoning cards are keyboard accessible and private worker thinking stays hidden', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const merged = reasonCard(f, 'part:think-a');
  await f.assertVisible(merged, 1, 'merged reasoning card');
  const summary = merged.locator('details > summary').first();
  assert.ok(await summary.count() >= 1, 'the reasoning card must use a native details summary (keyboard accessible)');
  await summary.focus();
  await f.page.keyboard.press('Enter');
  await f.frames(2);
  assert.equal(await merged.evaluate(node => node.querySelector('details')?.open), true,
    'Enter on the focused reasoning summary must open the card');
  assert.equal(await f.page.locator('#goal-output-content [data-log-id="worker-part:w-build:worker-private-think"]').count(), 0,
    'worker thinking must stay out of the Reason scheduling log');
  const dispatchText = await f.page.locator('#goal-output-content [data-log-id="worker:w-build"]').innerText();
  assert.doesNotMatch(dispatchText, /仅 Worker 详情可见/);
});

// ---------------------------------------------------------------------------
// 14. Dark theme parity.
// ---------------------------------------------------------------------------
test('dark theme recolours the log without closing or breaking reasoning cards', async t => {
  const f = await fixture(t);
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const read = () => f.page.evaluate(() => {
    const panel = getComputedStyle(document.querySelector('.goal-output-panel'));
    const card = document.querySelector('#goal-output-content [data-log-id="part:think-a"]');
    return { background: panel.backgroundColor, color: panel.color, cardVisible: Boolean(card?.getClientRects().length) };
  });
  const light = await read();
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames(2);
  const dark = await read();
  assert.notDeepEqual(dark, light, 'the log panel must follow the dark theme tokens');
  assert.equal(dark.cardVisible, true, 'switching theme must not remove or hide reasoning cards');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
});

// ---------------------------------------------------------------------------
// 15. 430px narrow layout has no horizontal overflow.
// ---------------------------------------------------------------------------
test('the log fits a 430px viewport without horizontal overflow', async t => {
  const f = await fixture(t, { width: 430, height: 900 });
  await f.emit(goalState({ busy: true, execution: richExecution() }));
  const merged = reasonCard(f, 'part:think-a');
  await f.assertVisible(merged, 1, 'merged reasoning card at 430px');
  const summary = merged.locator('details > summary').first();
  if (await summary.count()) await summary.click();
  await f.frames(2);
  const facts = await f.page.evaluate(() => {
    const panel = document.querySelector('.goal-output-panel');
    const content = document.getElementById('goal-output-content');
    const card = document.querySelector('#goal-output-content [data-log-id="part:think-a"]');
    const cardRect = card?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      panelScroll: panel?.scrollWidth ?? null,
      panelClient: panel?.clientWidth ?? null,
      contentScroll: content?.scrollWidth ?? null,
      contentClient: content?.clientWidth ?? null,
      cardRight: cardRect?.right ?? null,
      cardLeft: cardRect?.left ?? null
    };
  });
  assert.equal(facts.documentScrollWidth, facts.innerWidth, `document scrollWidth ${facts.documentScrollWidth} must equal the 430px viewport`);
  assert.ok(facts.panelScroll <= facts.panelClient + 1, `panel must not scroll sideways (${facts.panelScroll} > ${facts.panelClient})`);
  assert.ok(facts.contentScroll <= facts.contentClient + 1, `log content must not scroll sideways (${facts.contentScroll} > ${facts.contentClient})`);
  assert.ok(facts.cardLeft >= -1 && facts.cardRight <= facts.innerWidth + 1,
    `the reasoning card must stay inside the 430px viewport ([${facts.cardLeft}, ${facts.cardRight}])`);
});
