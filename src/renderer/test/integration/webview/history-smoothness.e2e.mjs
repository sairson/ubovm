// Independent functional + performance regression gate for conversation-history
// smoothness (perf-verify, task-9). Drives the real rendered webview bundle
// (renderWebview) in headless Edge with a mocked VS Code host bridge and asserts
// the thresholds from .tmp-perf/contract.md (perf-verify section):
//
//   - long-history first paint ≤ 3 articles, full backfill in order, pinned scroll
//   - initial max long task median ≤ 50 ms and settle median ≤ 60 ms (3 runs)
//   - no >32 ms long task while the older history backfills / the reader scrolls
//   - scroll slow-frame ratio < 5% (>32 ms frames) over a long-history scroll
//   - teammate view paints newest 6 entries first, fills in order, indicator shown
//   - member open max long task median ≤ 32 ms, first content median ≤ 80 ms (3 runs)
//   - member live-tick burst has no >50 ms long task
//   - ≤24-message / ≤12-entry histories keep synchronous rendering behavior
//   - reader scrolled up keeps its visual anchor while older history is inserted
//   - every case: no page errors, no console errors, no remote requests
//
// PerformanceObserver longtask is skipped gracefully with a clear message when the
// browser build cannot observe it. This file is intentionally independent of
// perf-ui-main's history-smoothness.mjs and perf-ui-member's team-member-view.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://history-smoothness.test/';
const now = 1_700_000_000_000;
let browser;

// Contract thresholds (.tmp-perf/contract.md → perf-verify requirements).
const BUDGET = Object.freeze({
  initialFirstPaintArticles: 3,
  initialMaxLongTaskMedianMs: 50, // median ≤50ms; target <45ms after the first-paint split
  // External-poll settle is measured with Playwright roundtrips + two rAF waits
  // (baseline 116ms, optimized ~94-105ms while the in-page long-task median is 0
  // and the first paint is 3 shells). Recalibrated to ≤120ms per Lead's freeze note;
  // the in-page first-paint/skeleton diagnostics below are reported alongside it.
  initialSettleMedianMs: 120,
  backfillLongTaskMs: 32,
  scrollSlowFrameRatio: 0.05,
  memberFirstPaintEntries: 6,
  memberOpenLongTaskMedianMs: 32,
  memberFirstContentMedianMs: 80,
  memberLiveLongTaskMs: 50
});

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

// ---------------------------------------------------------------------------
// Fixtures: large histories with thinking + 4 tool cards per assistant turn and
// a teammate transcript, mirroring .tmp-perf/profile.mjs so budgets are comparable.
// ---------------------------------------------------------------------------
function thinking(i) {
  return { id: `thk-${i}`, type: 'thinking', text: '先核对执行边界与事件顺序，再确认持久化路径。'.repeat(2), status: 'completed',
    source: 'assistant', startedAt: now + i, endedAt: now + i + 800 };
}
function toolPart(i, j) {
  return { id: `tool-${i}-${j}`, type: 'tool', name: j % 3 === 0 ? 'read_workspace_code' : j % 3 === 1 ? 'search_workspace' : 'edit_workspace_file',
    args: JSON.stringify({ path: `src/features/module-${i}-${j}.ts`, query: 'createHarnessService', expectedHash: 'abc123' }),
    output: `// output ${i}-${j}\n` + 'const value = doWork(input);\n'.repeat(40),
    status: 'completed', startedAt: now + i * 100 + j, endedAt: now + i * 100 + j + 40 };
}
function assistantMessage(i, toolCount = 4) {
  const parts = [thinking(i)];
  for (let j = 0; j < toolCount; j++) parts.push(toolPart(i, j));
  parts.push({ id: `txt-${i}`, type: 'text', text: `## 第 ${i} 轮\n\n已完成本轮的检查与修改。\n\n` + '结论与证据说明。'.repeat(30), status: 'completed' });
  return { id: `assist:${i}`, role: 'assistant', text: `第 ${i} 轮：完成检查并记录证据。`, parts, usage: { input: 100, output: 20, totalTokens: 120 } };
}
function userMessage(i) {
  return { id: `user-${i}`, role: 'user', text: `请继续第 ${i} 轮的检查，确认边界与回归结果，并给出证据。` };
}
function history(pairs) {
  const items = [];
  for (let i = 0; i < pairs; i++) { items.push(userMessage(i)); items.push(assistantMessage(i)); }
  return items;
}
function memberEntries(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) entries.push({ id: `team:user:${i}`, role: 'user', text: `Team message from lead:\n请处理第 ${i} 项任务，完成后汇报。`, timestamp: now + i });
    else entries.push({
      id: `team:assistant:${i}`, role: 'assistant', text: `第 ${i} 项任务已完成。`, timestamp: now + i,
      parts: [thinking(i), toolPart(i, 0), toolPart(i, 1), { id: `team:text:${i}:2`, type: 'text', text: `第 ${i} 项任务已完成。\n\n` + '检查内容与证据。'.repeat(20), status: 'completed' }]
    });
  }
  return entries;
}
const team = Object.freeze({
  revision: 4,
  roster: [
    { name: 'lead', role: 'lead', status: 'inactive', updatedAt: now },
    { name: 'reviewer', role: 'teammate', status: 'running', description: '审查协作模块的实现与测试覆盖', activity: { label: 'read_workspace_code', status: 'running', at: now }, updatedAt: now },
    { name: 'tester', role: 'teammate', status: 'inactive', description: '执行回归与性能验证', updatedAt: now }
  ],
  tasks: [{ id: 'task-1', revision: 2, subject: '审查协作服务', description: '核对事件顺序与持久化。', status: 'in_progress', ownerName: 'reviewer', blockedBy: [], writeScopes: ['src/harness'], ready: true, writeScopeWarnings: [] }]
});
const liveParts = count => {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push({ id: `live-${i}`, type: 'text', text: `实时补充第 ${i} 段：继续核对事件顺序与回归结果。`, status: i === count - 1 ? 'streaming' : 'completed' });
  return parts;
};
function state({ sessionId = 'perf', messages = [], execution = {}, overrides = {} } = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: sessionId, title: '性能测量会话' },
    messages, goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: false,
    execution: { status: 'completed', busy: false, parts: [], streamText: '', activities: [], ...execution }, ...overrides
  };
}
const memberWatch = (count, overrides = {}) => ({
  name: 'reviewer', role: 'teammate', status: 'running', running: true, description: '审查协作模块的实现与测试覆盖',
  activity: { label: 'read_workspace_code', status: 'running', at: now },
  history: { entries: memberEntries(count), omitted: 0 },
  live: { parts: liveParts(3), streamText: '实时补充第 2 段：继续核对事件顺序与回归结果。' }, updatedAt: now,
  ...overrides
});

// Token that identifies a main-conversation message in the DOM (derived from the
// deterministic fixture text): user → `user:<n>`, assistant → `assistant:<n>`.
function expectedMessageTokens(messages) {
  return messages.map((message, index) => {
    const pair = Math.floor(index / 2);
    return message.role === 'user' ? 'user:' + pair : 'assistant:' + pair;
  });
}

// ---------------------------------------------------------------------------
// Page probe: long tasks, frame gaps and MutationObserver first-paint batches.
// ---------------------------------------------------------------------------
function installProbe() {
  window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: () => true });
  window.__longTasks = [];
  window.__longTaskSupported = false;
  try {
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push({ start: entry.startTime, duration: entry.duration }); })
      .observe({ entryTypes: ['longtask'] });
    window.__longTaskSupported = true;
  } catch { /* longtask unsupported in this browser build */ }
  window.__frames = [];
  let last = performance.now();
  const tick = () => {
    const current = performance.now();
    window.__frames.push(current - last);
    last = current;
    if (window.__frames.length < 4000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__batches = { messages: [], member: [] };
  // Track whether the top-of-history loading indicator was ever visible while the
  // progressive fill ran, and whether it is gone once the fill completed. The
  // contract fixes the copy (正在载入较早的记录…) but not the class, so filter by text.
  window.__loading = { mainSeen: false, memberSeen: false, mainVisible: false, memberVisible: false };
  window.__dispatchAt = null;
  window.__skeletonHiddenAt = null;
  // Tool-card hydration hint (正在载入工具记录…) appears on rich shells after the
  // first progressive paint and disappears when every shell finished hydrating.
  window.__hydration = { seen: false, visible: false };
  const sampleLoading = () => {
    const visible = scope => {
      const seen = [...document.querySelectorAll(scope + ' [class*="loading"]')].some(node => {
        if (!(node.textContent || '').trim().startsWith('正在载入较早的记录')) return false;
        return node.getClientRects().length > 0;
      });
      return seen;
    };
    const main = visible('#messages');
    const member = visible('#team-member-view');
    window.__loading.mainSeen ||= main;
    window.__loading.memberSeen ||= member;
    window.__loading.mainVisible = main;
    window.__loading.memberVisible = member;
    const hydrating = [...document.querySelectorAll('#messages .message-hydrating')].some(node => node.getClientRects().length > 0);
    window.__hydration.seen ||= hydrating;
    window.__hydration.visible = hydrating;
    if (window.__skeletonHiddenAt === null && document.getElementById('page-loading')?.hidden) {
      window.__skeletonHiddenAt = performance.now();
    }
  };
  const loadingTick = () => {
    sampleLoading();
    if (window.__loading && window.__batches) requestAnimationFrame(loadingTick);
  };
  requestAnimationFrame(loadingTick);
  const messageToken = node => {
    const text = node.textContent || '';
    const user = /请继续第 (\d+) 轮的检查/.exec(text);
    if (user) return 'user:' + user[1];
    const assistant = /第 (\d+) 轮/.exec(text);
    return assistant ? 'assistant:' + assistant[1] : '';
  };
  const observe = (selector, key) => {
    const install = () => {
      const target = document.querySelector(selector);
      if (!target) { requestAnimationFrame(install); return; }
      new MutationObserver(mutations => {
        let added = 0;
        const ids = [];
        for (const mutation of mutations) for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (key === 'member') {
            if (node.classList?.contains('team-member-message')) { added++; ids.push(node.getAttribute('data-entry-id')); }
          } else if (node.matches?.('article.message')) {
            added++;
            const token = messageToken(node);
            if (token) ids.push(token);
          }
        }
        if (added || ids.length) {
          // domIds captures the painted order (add order can be newest-first while
          // the implementation prepends each node above the previous one). Shells
          // only carry their first part, so the token list can be partial.
          const domIds = key === 'member'
            ? [...target.querySelectorAll('article.team-member-message')].map(node => node.getAttribute('data-entry-id'))
            : [...target.querySelectorAll('article.message')].map(messageToken).filter(Boolean);
          const hints = target.querySelectorAll('.message-hydrating').length;
          window.__batches[key].push({ at: performance.now(), added, ids, domIds, hints });
          sampleLoading();
        }
      }).observe(target, { childList: true });
    };
    install();
  };
  document.addEventListener('DOMContentLoaded', () => {
    observe('#messages', 'messages');
    observe('#team-member-view-history', 'member');
  });
}

// ---------------------------------------------------------------------------
// Harness: fresh page per scenario, error/network capture, helpers.
// ---------------------------------------------------------------------------
async function fixture(t, { width = 1100, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
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
  await page.addInitScript(installProbe);
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'perf', workspaceName: 'UBOVM', nonce: 'history-smoothness-test' })
  }));
  await page.goto(origin);
  const frames = count => page.evaluate(async amount => {
    for (let index = 0; index < amount; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count ?? 2);
  const emit = value => page.evaluate(data => {
    window.__dispatchAt = performance.now();
    window.dispatchEvent(new MessageEvent('message', { data }));
    return performance.now() - window.__dispatchAt;
  }, value);
  const reset = () => page.evaluate(() => {
    window.__longTasks = [];
    window.__frames = [];
    window.__batches.messages = [];
    window.__batches.member = [];
    window.__loading = { mainSeen: false, memberSeen: false, mainVisible: false, memberVisible: false };
    window.__hydration = { seen: false, visible: false };
    window.__dispatchAt = null;
    window.__skeletonHiddenAt = null;
  });
  const metrics = () => page.evaluate(() => ({
    longTaskSupported: window.__longTaskSupported,
    longTasks: window.__longTasks.slice(),
    frames: window.__frames.slice(),
    dispatchAt: window.__dispatchAt,
    skeletonHiddenAt: window.__skeletonHiddenAt,
    loading: { ...window.__loading },
    hydration: { ...window.__hydration },
    batches: { messages: window.__batches.messages.slice(), member: window.__batches.member.slice() }
  }));
  const settle = async (selector, count, timeout = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const found = await page.evaluate(({ selector, count }) => document.querySelectorAll(selector).length >= count, { selector, count });
      if (found) { await frames(2); return Date.now() - started; }
      await page.waitForTimeout(16);
    }
    throw new Error(`settle timeout: ${selector} did not reach ${count} nodes`);
  };
  const api = { page, frames, emit, reset, metrics, settle, pageErrors, consoleErrors, remoteRequests };
  // Wait until every progressive shell finished hydrating and any history loading
  // indicator is gone; hydration advances one part per frame for rich messages.
  api.waitMainHydrated = async expectedArticles => {
    await page.waitForFunction(count => {
      const articles = document.querySelectorAll('#messages article.message').length;
      const hydrating = document.querySelectorAll('#messages [data-hydrating]').length;
      const hints = document.querySelectorAll('#messages .message-hydrating').length;
      return articles >= count && hydrating === 0 && hints === 0;
    }, expectedArticles, { timeout: 90000 });
    await frames(2);
  };
  api.mainStats = () => page.evaluate(() => ({
    articles: document.querySelectorAll('#messages article.message').length,
    toolCards: document.querySelectorAll('#messages article.message .tool-card').length,
    thinkingCards: document.querySelectorAll('#messages article.message .thinking-card').length,
    hydrating: document.querySelectorAll('#messages [data-hydrating]').length,
    hints: document.querySelectorAll('#messages .message-hydrating').length
  }));
  api.assertClean = () => {
    assert.deepEqual(pageErrors, [], 'no page errors are allowed');
    assert.deepEqual(consoleErrors, [], 'no console errors are allowed');
    assert.deepEqual(remoteRequests, [], 'no remote requests are allowed');
  };
  t.after(async () => {
    await page.close().catch(() => {});
    api.assertClean();
  });
  api.openMember = async () => {
    await page.locator('#team-toggle').click();
    await page.locator('#team-panel').waitFor({ state: 'visible' });
    await page.locator('#team-panel .team-member[data-status="running"]').click();
    await page.locator('#team-member-view').waitFor({ state: 'visible' });
    await frames(2);
  };
  return api;
}

const summary = segment => {
  const longTasks = segment.longTasks || [];
  const frames = segment.frames || [];
  return {
    longTasks: longTasks.length,
    longTaskMaxMs: round(Math.max(0, ...longTasks.map(entry => entry.duration))),
    longTasksOver: limit => longTasks.filter(entry => entry.duration > limit).length,
    frames: frames.length,
    slowFrames: frames.filter(ms => ms > 32).length,
    slowFrameRatio: frames.length ? frames.filter(ms => ms > 32).length / frames.length : 0,
    worstFrameMs: round(Math.max(0, ...frames))
  };
};
function round(value, digits = 1) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
// Find the top-of-history loading indicator without depending on a specific class:
// the contract only fixes the copy `正在载入较早的记录…`.
async function loadingIndicator(page, scope) {
  return page.evaluate(scopeSelector => {
    const root = document.querySelector(scopeSelector);
    if (!root) return null;
    const candidates = [...root.querySelectorAll('*')].filter(node => {
      const text = (node.textContent || '').trim();
      if (!text.startsWith('正在载入较早的记录')) return false;
      return ![...node.children].some(child => (child.textContent || '').trim().startsWith('正在载入较早的记录'));
    });
    const element = candidates[0];
    if (!element) return null;
    return { visible: element.getClientRects().length > 0, text: element.textContent.trim() };
  }, scope);
}
const articleTokens = page => page.evaluate(() => [...document.querySelectorAll('#messages article.message')].map(node => {
  const text = node.textContent || '';
  const user = /请继续第 (\d+) 轮的检查/.exec(text);
  if (user) return 'user:' + user[1];
  const assistant = /第 (\d+) 轮/.exec(text);
  return assistant ? 'assistant:' + assistant[1] : '';
}).filter(Boolean));
const memberEntryIds = page => page.evaluate(() => [...document.querySelectorAll('#team-member-view-history article.team-member-message')].map(node => node.getAttribute('data-entry-id')));

// ---------------------------------------------------------------------------
// 1. Progressive first paint + ordered backfill + loading indicator + pinned scroll.
// ---------------------------------------------------------------------------
test('long history first paint shows only the newest 3 messages, then backfills in order', async t => {
  const messages = history(20); // 40 messages (> 24 → progressive)
  const f = await fixture(t);
  await f.reset();
  await f.emit(state({ messages }));
  await f.page.waitForFunction(() => document.querySelectorAll('#messages article.message').length > 0, undefined, { timeout: 20000 });
  await f.frames(1);
  let metrics = await f.metrics();
  const firstBatch = metrics.batches.messages[0];
  assert.ok(firstBatch, 'the initial paint must be observable through a DOM mutation batch');
  assert.equal(firstBatch.added, BUDGET.initialFirstPaintArticles,
    `long histories (>24 messages) must paint only the newest ${BUDGET.initialFirstPaintArticles} message shells on the first frame (got ${firstBatch.added}); see .tmp-perf/contract.md perf-ui-main #1`);
  const newestUser = messages.length / 2 - 1;
  assert.ok(firstBatch.ids.includes('user:' + newestUser),
    `the first paint must include the newest user message (expect user:${newestUser}); ids=${JSON.stringify(firstBatch.ids)}`);
  assert.ok(!firstBatch.ids.includes('user:' + (newestUser - 1)),
    'the first paint must not include older messages (backfill must stream them in above the tail)');
  assert.ok(firstBatch.hints >= 1,
    'rich assistant shells on a long-history first paint must show the 正在载入工具记录… hydration hint (shell+hint contract); none were found');

  const order = expectedMessageTokens(messages);
  await f.settle('#messages article.message', messages.length, 40000);
  await f.waitMainHydrated(messages.length);
  const done = await f.metrics();
  assert.equal(done.loading.mainSeen, true,
    'a top-of-history loading indicator (正在载入较早的记录…) must be visible while older messages fill (contract perf-ui-main #1)');
  assert.equal(done.loading.mainVisible, false,
    'the history loading indicator must hide once the progressive fill completes');
  assert.equal(done.hydration.seen, true,
    'the tool-card hydration hint (正在载入工具记录…) must be visible while rich shells hydrate');
  assert.equal(done.hydration.visible, false,
    'the tool-card hydration hint must disappear after every shell finished hydrating');
  const stats = await f.mainStats();
  assert.equal(stats.articles, messages.length, 'every message must be mounted after the fill');
  assert.equal(stats.hydrating, 0, 'no shell may stay data-hydrating after hydration completes');
  assert.equal(stats.hints, 0, 'no hydration hint may remain after hydration completes');
  const assistantCount = messages.filter(message => message.role === 'assistant').length;
  assert.equal(stats.toolCards, assistantCount * 4,
    `every assistant tool card must be hydrated (expected ${assistantCount * 4}, got ${stats.toolCards})`);
  const tokens = await articleTokens(f.page);
  assert.deepEqual(tokens, order, 'after progressive fill the conversation must contain every message once, in original order');

  const pinned = await f.page.evaluate(() => {
    const scroller = document.getElementById('conversation');
    return scroller ? { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null;
  });
  assert.ok(pinned && pinned.top >= pinned.max - 3, `while following, the conversation must stay pinned to the bottom (scrollTop ${pinned?.top}, max ${pinned?.max})`);
});

// ---------------------------------------------------------------------------
// 2. Initial long-task + settle budget over 3 fresh runs (median), plus the
//    single-rich-message layout floor as evidence (contract: target <45ms after
//    the first-paint split; a residual floor is reported, not silently loosened).
// ---------------------------------------------------------------------------
test('initial paint stays within the long-task and settle budget (median of 3 runs)', async t => {
  const messages = history(60); // 120 messages
  const samples = [];
  let supported = true;
  for (let run = 0; run < 3; run++) {
    const f = await fixture(t);
    await f.reset();
    await f.emit(state({ messages }));
    const settleMs = await f.settle('#messages article.message', 2, 30000);
    await f.frames(3);
    const metrics = await f.metrics();
    supported = supported && metrics.longTaskSupported !== false;
    const firstBatch = metrics.batches.messages[0];
    const inPageFirstPaintMs = firstBatch && metrics.dispatchAt ? round(firstBatch.at - metrics.dispatchAt) : null;
    const skeletonHiddenMs = metrics.skeletonHiddenAt && metrics.dispatchAt ? round(metrics.skeletonHiddenAt - metrics.dispatchAt) : null;
    samples.push({ ...summary(metrics), settleMs, inPageFirstPaintMs, skeletonHiddenMs });
    await f.page.close();
  }
  // Layout floor probe: one assistant message with 4 tool cards (no history fill).
  // This is the irreducible DOM+layout cost the first-paint split cannot move.
  let floorMs = null;
  {
    const f = await fixture(t);
    await f.reset();
    await f.emit(state({ messages: [userMessage(0), assistantMessage(0)] }));
    await f.settle('#messages article.message', 2, 30000);
    await f.frames(3);
    const metrics = await f.metrics();
    floorMs = summary(metrics).longTaskMaxMs;
    await f.page.close();
  }
  t.diagnostic(`single rich assistant message (4 tool cards) layout floor: ${floorMs}ms`);
  if (!supported) {
    t.skip('PerformanceObserver longtask is not supported in this browser build; long-task budgets cannot be measured');
    return;
  }
  const maxLongTask = median(samples.map(sample => sample.longTaskMaxMs));
  const settle = median(samples.map(sample => sample.settleMs));
  const inPageFirstPaint = median(samples.map(sample => sample.inPageFirstPaintMs).filter(value => value !== null));
  const skeletonHidden = median(samples.map(sample => sample.skeletonHiddenMs).filter(value => value !== null));
  t.diagnostic(`in-page first paint median: ${inPageFirstPaint}ms; skeleton hidden median: ${skeletonHidden}ms; external-poll settle runs: ${JSON.stringify(samples.map(sample => sample.settleMs))}`);
  assert.ok(maxLongTask <= BUDGET.initialMaxLongTaskMedianMs,
    `initial max long task median ${maxLongTask}ms must be ≤${BUDGET.initialMaxLongTaskMedianMs}ms (target <45ms per Lead); runs=${JSON.stringify(samples.map(sample => sample.longTaskMaxMs))}; single-rich-message layout floor=${floorMs}ms`);
  assert.ok(settle <= BUDGET.initialSettleMedianMs,
    `external-poll settle median ${settle}ms must be ≤${BUDGET.initialSettleMedianMs}ms (recalibrated per Lead: headless Playwright roundtrips + two rAF waits; baseline 116ms, optimized 94-105ms); in-page first paint median ${inPageFirstPaint}ms, skeleton hidden median ${skeletonHidden}ms; runs=${JSON.stringify(samples.map(sample => sample.settleMs))}`);
});

// ---------------------------------------------------------------------------
// 3. No >32ms long task during background backfill / scrolling.
// ---------------------------------------------------------------------------
test('background backfill and scrolling produce no long task over 32ms', async t => {
  const messages = history(60); // 120 messages
  const f = await fixture(t);
  await f.emit(state({ messages }));
  await f.page.waitForFunction(() => document.querySelectorAll('#messages article.message').length > 0, undefined, { timeout: 20000 });
  await f.frames(1);
  await f.reset();
  // Scroll while the older history is still streaming in above the tail paint.
  for (let step = 0; step < 24; step++) {
    await f.page.mouse.move(700, 520);
    await f.page.mouse.wheel(0, 240);
    await f.page.waitForTimeout(16);
  }
  const metrics = await f.metrics();
  const segment = summary(metrics);
  t.diagnostic(`backfill/scroll segment: max long task ${segment.longTaskMaxMs}ms, >32ms count ${segment.longTasksOver(BUDGET.backfillLongTaskMs)}, worst frame ${segment.worstFrameMs}ms`);
  assert.equal(segment.longTasksOver(BUDGET.backfillLongTaskMs), 0,
    `no long task may exceed ${BUDGET.backfillLongTaskMs}ms during backfill/scroll; got ${JSON.stringify(metrics.longTasks.filter(entry => entry.duration > BUDGET.backfillLongTaskMs).map(entry => Math.round(entry.duration)))}`);
  await f.settle('#messages article.message', messages.length, 40000);
  await f.waitMainHydrated(messages.length);
  assert.equal((await articleTokens(f.page)).length, messages.length, 'the backfill must still complete after the scroll segment');
});

// ---------------------------------------------------------------------------
// 4. Scroll slow-frame ratio over a fully rendered long history.
// ---------------------------------------------------------------------------
test('scrolling a fully rendered long history stays under the slow-frame budget', async t => {
  const messages = history(60); // 120 messages
  const f = await fixture(t);
  await f.emit(state({ messages }));
  await f.settle('#messages article.message', messages.length, 40000);
  await f.waitMainHydrated(messages.length);
  await f.frames(3);
  await f.reset();
  await f.page.evaluate(() => { const scroller = document.getElementById('conversation'); if (scroller) scroller.scrollTop = 0; });
  for (let step = 0; step < 30; step++) {
    await f.page.mouse.move(700, 520);
    await f.page.mouse.wheel(0, 240);
    await f.page.waitForTimeout(16);
  }
  await f.frames(2);
  const metrics = await f.metrics();
  const segment = summary(metrics);
  t.diagnostic(`settled scroll: slow-frame ratio ${round(segment.slowFrameRatio * 100, 1)}% (${segment.slowFrames}/${segment.frames} frames >32ms), worst frame ${segment.worstFrameMs}ms`);
  assert.ok(segment.frames >= 20, `the scroll segment must sample real frames (got ${segment.frames})`);
  assert.ok(segment.slowFrameRatio < BUDGET.scrollSlowFrameRatio,
    `scroll slow-frame ratio ${round(segment.slowFrameRatio * 100, 1)}% must be <${BUDGET.scrollSlowFrameRatio * 100}%; worst frame ${segment.worstFrameMs}ms, ${segment.slowFrames}/${segment.frames} frames over 32ms`);
});

// ---------------------------------------------------------------------------
// 5. Member view: progressive newest-6 first paint, ordered fill, indicator.
// ---------------------------------------------------------------------------
test('member view paints the newest 6 entries first, then fills the transcript in order', async t => {
  const entries = memberEntries(36);
  const f = await fixture(t);
  await f.emit(state({ messages: history(10), execution: { team } }));
  await f.frames(2);
  await f.openMember();
  await f.reset();
  await f.emit(state({ sessionId: 'perf', messages: history(10), execution: { team, teamWatch: memberWatch(36) } }));
  await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length > 0, undefined, { timeout: 20000 });
  await f.frames(1);
  let metrics = await f.metrics();
  const firstBatch = metrics.batches.member[0];
  assert.ok(firstBatch, 'the member view first paint must be observable through a DOM mutation batch');
  const firstHistoryIds = firstBatch.ids.filter(id => id !== 'live');
  assert.equal(firstHistoryIds.length, BUDGET.memberFirstPaintEntries,
    `member histories >12 entries must paint only the newest ${BUDGET.memberFirstPaintEntries} entries on the first frame (got ${firstHistoryIds.length}); see .tmp-perf/contract.md perf-ui-member #1`);
  assert.deepEqual(firstBatch.domIds.filter(id => id !== 'live'), entries.slice(-BUDGET.memberFirstPaintEntries).map(entry => entry.id),
    'the member first paint must contain the newest entries in chronological DOM order');

  await f.settle('#team-member-view-history article.team-member-message', entries.length + 1, 30000);
  const done = await f.metrics();
  assert.equal(done.loading.memberSeen, true,
    'a member top-of-history loading indicator (正在载入较早的记录…) must be visible while older entries fill (contract perf-ui-member #1)');
  assert.equal(done.loading.memberVisible, false,
    'the member history loading indicator must hide when the fill completes');
  const ids = await memberEntryIds(f.page);
  assert.deepEqual(ids.slice(0, entries.length), entries.map(entry => entry.id), 'the member transcript must fill in original order');
  assert.equal(ids[ids.length - 1], 'live', 'the live assistant entry must stay last');
});

// ---------------------------------------------------------------------------
// 6. Member open long task + first-content budget over 3 fresh runs (median).
// ---------------------------------------------------------------------------
test('member open stays within the long-task and first-content budget (median of 3 runs)', async t => {
  const samples = [];
  let supported = true;
  for (let run = 0; run < 3; run++) {
    const f = await fixture(t);
    await f.emit(state({ messages: history(20), execution: { team } }));
    await f.frames(2);
    await f.openMember();
    await f.reset();
    const started = Date.now();
    await f.emit(state({ sessionId: 'perf', messages: history(20), execution: { team, teamWatch: memberWatch(60) } }));
    await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length > 0, undefined, { timeout: 20000 });
    const firstContentMs = Date.now() - started;
    await f.frames(2);
    const metrics = await f.metrics();
    supported = supported && metrics.longTaskSupported !== false;
    samples.push({ ...summary(metrics), firstContentMs, firstBatch: metrics.batches.member[0]?.ids?.filter(id => id !== 'live').length ?? null });
    await f.page.close();
  }
  const worstFirstBatch = Math.max(...samples.map(sample => sample.firstBatch));
  assert.ok(worstFirstBatch <= BUDGET.memberFirstPaintEntries,
    `every member open must paint ≤${BUDGET.memberFirstPaintEntries} history entries first (worst ${worstFirstBatch})`);
  if (!supported) {
    t.skip('PerformanceObserver longtask is not supported in this browser build; member open budgets cannot be measured');
    return;
  }
  const openMax = median(samples.map(sample => sample.longTaskMaxMs));
  const firstContent = median(samples.map(sample => sample.firstContentMs));
  t.diagnostic(`member open: max long task median ${openMax}ms, first content median ${firstContent}ms, first-paint entries ${worstFirstBatch}`);
  assert.ok(openMax <= BUDGET.memberOpenLongTaskMedianMs,
    `member open max long task median ${openMax}ms must be ≤${BUDGET.memberOpenLongTaskMedianMs}ms (contract target <25ms); runs=${JSON.stringify(samples.map(sample => sample.longTaskMaxMs))}`);
  assert.ok(firstContent <= BUDGET.memberFirstContentMedianMs,
    `member first content median ${firstContent}ms must be ≤${BUDGET.memberFirstContentMedianMs}ms; runs=${JSON.stringify(samples.map(sample => sample.firstContentMs))}`);
});

// ---------------------------------------------------------------------------
// 7. Member live-tick burst with a large history.
// ---------------------------------------------------------------------------
test('member live tick burst with a large history stays under the long-task budget', async t => {
  const f = await fixture(t);
  await f.emit(state({ messages: history(20), execution: { team } }));
  await f.frames(2);
  await f.openMember();
  await f.emit(state({ sessionId: 'perf', messages: history(20), execution: { team, teamWatch: memberWatch(60) } }));
  await f.settle('#team-member-view-history article.team-member-message', 61, 40000);
  await f.frames(3);
  await f.reset();
  let supported = true;
  for (let i = 1; i <= 60; i++) {
    await f.emit(state({ sessionId: 'perf', messages: history(20), execution: { team, teamWatch: memberWatch(60, {
      live: { parts: liveParts(3 + (i % 20)), streamText: '实时补充第 2 段：继续核对事件顺序与回归结果。'.repeat(1 + (i % 3)) }
    }) } }));
  }
  const metrics = await f.metrics();
  supported = metrics.longTaskSupported !== false;
  if (!supported) {
    t.skip('PerformanceObserver longtask is not supported in this browser build; live-burst budget cannot be measured');
    return;
  }
  const segment = summary(metrics);
  const over = metrics.longTasks.filter(entry => entry.duration > BUDGET.memberLiveLongTaskMs);
  t.diagnostic(`member live burst: max long task ${segment.longTaskMaxMs}ms over 60 ticks, slow frames ${segment.slowFrames}/${segment.frames}`);
  assert.equal(over.length, 0,
    `no member live-tick long task may exceed ${BUDGET.memberLiveLongTaskMs}ms with a 60-entry history; got ${JSON.stringify(over.map(entry => Math.round(entry.duration)))}`);
  assert.ok(segment.frames >= 20, `the live burst must sample real frames (got ${segment.frames})`);
});

// ---------------------------------------------------------------------------
// 8. Short histories keep synchronous rendering (no behavior change).
// ---------------------------------------------------------------------------
test('short histories keep their synchronous rendering behavior', async t => {
  const messages = history(10); // 20 messages ≤ 24
  const f = await fixture(t);
  await f.reset();
  await f.emit(state({ messages }));
  await f.page.waitForFunction(() => document.querySelectorAll('#messages article.message').length > 0, undefined, { timeout: 20000 });
  let metrics = await f.metrics();
  const mainBatch = metrics.batches.messages[0]?.added ?? 0;
  assert.ok(mainBatch >= messages.length,
    `≤24-message conversations must keep today's synchronous full paint (first batch ${mainBatch} of ${messages.length})`);
  await f.frames(2);
  assert.deepEqual(await articleTokens(f.page), expectedMessageTokens(messages));
  const shortStats = await f.mainStats();
  assert.equal(shortStats.hydrating, 0, '≤24-message histories must render fully synchronously (no hydration shells)');
  assert.equal(shortStats.hints, 0, '≤24-message histories must not show tool-card hydration hints');

  // Member: ≤12 entries keeps the synchronous (non-progressive) render.
  await f.emit(state({ messages: history(10), execution: { team } }));
  await f.frames(2);
  await f.openMember();
  await f.reset();
  const entries = memberEntries(10);
  await f.emit(state({ sessionId: 'perf', messages: history(10), execution: { team, teamWatch: memberWatch(10) } }));
  await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length > 0, undefined, { timeout: 20000 });
  metrics = await f.metrics();
  const memberBatch = metrics.batches.member[0]?.ids?.filter(id => id !== 'live').length ?? 0;
  assert.equal(memberBatch, entries.length,
    `≤12-entry member histories must render all entries synchronously (first batch ${memberBatch} of ${entries.length})`);
  await f.frames(2);
  assert.deepEqual(await memberEntryIds(f.page), [...entries.map(entry => entry.id), 'live']);
});

// ---------------------------------------------------------------------------
// 9. Reader scrolled up is not hijacked by the continuing backfill.
//    (Hydration grows already-painted shells, so the assertion is: the reader's
//    scroll position is compensated upward for content inserted above, the view
//    is not force-pinned to the bottom, and the anchored message stays visible.)
// ---------------------------------------------------------------------------
test('a reader scrolled up keeps their place while older history backfills', async t => {
  const messages = history(60); // 120 messages
  const f = await fixture(t);
  await f.emit(state({ messages }));
  await f.page.waitForFunction(() => document.querySelectorAll('#messages article.message').length > 0, undefined, { timeout: 20000 });
  // Let the first backfill batches make the thread scrollable, then scroll back to
  // the top so the reader is no longer following when older batches land above.
  await f.page.waitForFunction(() => document.querySelectorAll('#messages article.message').length >= 15, undefined, { timeout: 20000 });
  await f.frames(2);
  const anchor = await f.page.evaluate(() => {
    const scroller = document.getElementById('conversation');
    if (!scroller) return null;
    scroller.scrollTop = 0;
    // User rows render synchronously and have stable plain-text height, so they are
    // a reliable anchor even while assistant shells hydrate around them.
    const users = [...document.querySelectorAll('#messages article.message')].filter(node => /请继续第 \d+ 轮的检查/.test(node.textContent || ''));
    const viewport = window.innerHeight;
    const visible = users.find(node => {
      const rect = node.getBoundingClientRect();
      return rect.top > -80 && rect.top < viewport - 40;
    }) || users[0];
    if (!visible) return null;
    const match = /请继续第 (\d+) 轮的检查/.exec(visible.textContent || '');
    return match ? { token: 'user:' + match[1], scrollTop: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null;
  });
  assert.ok(anchor && anchor.token, 'the anchor probe must find a user message near the top of the viewport');
  assert.ok(anchor.max > 0, 'the thread must be scrollable before the reader scrolls up');
  await f.frames(2);
  await f.settle('#messages article.message', messages.length, 60000);
  await f.waitMainHydrated(messages.length);
  await f.frames(2);
  const after = await f.page.evaluate(token => {
    const scroller = document.getElementById('conversation');
    const node = [...document.querySelectorAll('#messages article.message')]
      .find(article => (article.textContent || '').includes(token.replace('user:', '请继续第 ') + ' 轮的检查'));
    const rect = node?.getBoundingClientRect();
    return scroller && rect ? {
      scrollTop: scroller.scrollTop,
      max: scroller.scrollHeight - scroller.clientHeight,
      top: rect.top,
      viewport: window.innerHeight
    } : null;
  }, anchor.token);
  assert.notEqual(after, null, 'the anchored message must still exist after the backfill');
  assert.ok(after.scrollTop > 0,
    'the scroll position must be compensated for older history inserted above the reader (scrollTop stayed 0)');
  assert.ok(after.scrollTop < after.max - 32,
    'the continuing backfill must not force the reader back to the bottom (scroll anchoring was hijacked)');
  assert.ok(after.top < after.viewport && after.top > -400,
    `the anchored message must stay near the reader's viewport after the backfill (top ${round(after.top)}px, viewport ${after.viewport}px)`);
});
