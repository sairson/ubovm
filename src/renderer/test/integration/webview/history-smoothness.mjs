import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

// Progressive conversation-history rendering (contracts: perf-ui-main task-7 and
// perf v2 task-10). All functional assertions are DOM/structural, never wall-clock
// based, so they stay deterministic on slow CI machines: the synchronous first paint
// is observed via a MutationObserver microtask that runs after the whole render task
// (small shell paint + indicator + skeleton hide) and before the next animation frame,
// where the time-budgeted backfill/hydration loop starts.

const EDGE = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const now = 1_700_000_000_000;
const ORIGIN = 'http://history-smoothness.test/';
let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE });
});
test.after(async () => { await browser?.close(); });

function thinkingPart(i) {
  return {
    id: `thk-${i}`, type: 'thinking', text: '先核对执行边界与事件顺序，再确认持久化路径。'.repeat(3),
    status: 'completed', source: 'assistant', startedAt: now + i, endedAt: now + i + 800
  };
}
function toolPart(i) {
  return {
    id: `tool-${i}`, type: 'tool', name: 'read_workspace_file',
    args: JSON.stringify({ path: `src/features/module-${i}.ts` }),
    output: `// output ${i}\nconst value = doWork(input);`,
    status: 'completed', startedAt: now + i, endedAt: now + i + 40
  };
}
// Alternating user/assistant history. Every message carries a unique token
// T#<index># so order and identity can be asserted without relying on ids.
// Assistant messages have three parts (thinking + tool + text), so the first
// progressive paint makes them shells and hydrates the tool/text parts later.
function richHistory(count, prefix) {
  return Array.from({ length: count }, (_, i) => i % 2 === 0
    ? { id: `${prefix}-user-${i}`, role: 'user', text: `${prefix} T#${i}# 用户消息` }
    : {
      id: `${prefix}-assist:${i}`, role: 'assistant', text: `${prefix} T#${i}# 助手回复`,
      parts: [thinkingPart(i), toolPart(i), { id: `${prefix}-txt-${i}`, type: 'text', text: `正文 ${prefix} T#${i}#`, status: 'completed' }]
    });
}
// Tall plain-text history: enough height that the conversation overflows the
// viewport, which makes scroll anchoring measurable. No parts => no hydration, so
// the scrollTop-absorbed height math is exact. The long body also keeps the
// time-budgeted backfill running for several frames.
function tallHistory(count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user',
    text: `${prefix} T#${i}# ` + '历史内容与证据说明，继续核对边界与回归结果。'.repeat(240)
  }));
}
function state(sessionId, messages) {
  return {
    type: 'state', mode: 'assist', conversation: { id: sessionId, title: '历史平滑度' }, messages,
    goal: null, context: { workspace: '测试工作区', file: '' }, provider: { configured: true, connected: true, label: '测试模型' },
    busy: false, execution: { status: 'idle', parts: [], workers: [], activities: [] }
  };
}

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  page.setDefaultTimeout(15000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  // Every URL except the webview document itself is a remote request.
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== ORIGIN) requests.push(request.url()); });
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      getState: () => ({}),
      setState() {},
      postMessage: message => { window.sent.push(message); return true; }
    });
    window.__longTasks = [];
    window.__longTaskSupported = false;
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push(entry.duration); })
        .observe({ entryTypes: ['longtask'] });
      window.__longTaskSupported = true;
    } catch { /* longtask unsupported in this browser */ }
  });
  const html = renderWebview({ version: 'test', workspaceName: '测试工作区', nonce: 'history-smoothness-test' });
  await page.route(ORIGIN, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(ORIGIN);
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the webview must not throw browser errors');
    assert.deepEqual(requests, [], 'history rendering must not fetch remote resources');
  });
  return page;
}

// One animation frame, counted from the end of the current task. Used only to let
// an intentionally bounded backfill advance; never to assert timing.
async function frames(page, count = 1) {
  await page.evaluate(count => new Promise(resolve => {
    let left = count;
    const step = () => { left--; if (left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), count);
}

// Capture the state of #messages at the first render task that mounts any message:
// MutationObserver callbacks are microtasks, so they run after the whole synchronous
// render task (shell paint + indicator + skeleton hide) and before the next animation
// frame, where the backfill/hydration loop starts.
async function armFirstPaint(page) {
  await page.evaluate(() => {
    window.firstPaint = null;
    const root = document.getElementById('messages');
    const shell = article => ({
      thinking: article.querySelectorAll('.thinking-card').length,
      tools: article.querySelectorAll('.tool-card').length,
      hydrating: Boolean(article.querySelector('.message-hydrating')),
      hintText: article.querySelector('.message-hydrating')?.textContent || ''
    });
    const capture = () => {
      const articles = [...root.querySelectorAll(':scope > .message')];
      if (!articles.length) return false;
      const loader = root.querySelector('.history-loading');
      window.firstPaint = {
        count: articles.length,
        tokens: articles.map(article => article.textContent.match(/T#(\d+)#/)?.[1] ?? ''),
        roles: articles.map(article => article.classList.contains('user') ? 'user' : 'assistant'),
        shells: articles.map(shell),
        indicator: Boolean(loader && !loader.hidden),
        indicatorLive: loader?.getAttribute('aria-live') || '',
        indicatorText: loader?.textContent || '',
        skeletonHidden: document.getElementById('page-loading').hidden,
        loadingAttr: document.body.dataset.loading
      };
      return true;
    };
    const observer = new MutationObserver(() => { if (capture()) observer.disconnect(); });
    observer.observe(root, { childList: true });
    window.firstPaintObserver = observer;
  });
}
async function dispatchState(page, snapshot) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), snapshot);
}
async function firstPaint(page) {
  await page.waitForFunction(() => window.firstPaint !== null);
  return page.evaluate(() => window.firstPaint);
}
async function messageSnapshot(page) {
  return page.evaluate(() => {
    const root = document.getElementById('messages');
    return [...root.querySelectorAll(':scope > .message')].map(article => ({
      token: article.textContent.match(/T#(\d+)#/)?.[1] ?? '',
      role: article.classList.contains('user') ? 'user' : 'assistant',
      thinking: article.querySelectorAll('.thinking-card').length,
      tools: article.querySelectorAll('.tool-card').length,
      hydrating: Boolean(article.querySelector('.message-hydrating')),
      hydratingAttr: article.dataset.hydrating === 'true'
    }));
  });
}
// Complete = every history article is mounted and every hydrated shell finished.
async function waitHistoryComplete(page, count) {
  await page.waitForFunction(expected =>
    document.querySelectorAll('#messages > .message').length === expected
    && document.querySelectorAll('#messages .message-hydrating').length === 0,
  count);
}

test('long history paints newest message shells, fills older history, then hydrates parts in order', async t => {
  const page = await fixture(t);
  const messages = richHistory(40, 'main');
  await armFirstPaint(page);
  await dispatchState(page, state('smooth-40', messages));
  const first = await firstPaint(page);

  // 40 > 24: only the newest 3 (indices 37, 38, 39) are mounted on the first frame.
  assert.equal(first.count, 3, 'only the newest three messages are painted synchronously');
  assert.deepEqual(first.tokens, ['37', '38', '39'], 'the newest messages are painted in order');
  assert.deepEqual(first.roles, ['assistant', 'user', 'assistant']);
  // Assistant turns are cheap shells: first visible part only, with the part hint.
  assert.equal(first.shells[0].thinking, 1, 'the shell renders the first visible part only');
  assert.equal(first.shells[0].tools, 0, 'tool cards are not laid out on the first frame');
  assert.equal(first.shells[0].hydrating, true, 'the shell shows its hydration hint');
  assert.match(first.shells[0].hintText, /正在载入工具记录/);
  assert.equal(first.shells[1].hydrating, false, 'user messages need no hydration');
  assert.equal(first.shells[2].hydrating, true);
  assert.equal(first.skeletonHidden, true, 'the page skeleton must clear after the small first paint');
  assert.equal(first.loadingAttr, 'false');
  // The top gap is explained by a polite, visible indicator while older history streams in.
  assert.equal(first.indicator, true, 'the history loading indicator is visible during the fill');
  assert.equal(first.indicatorLive, 'polite');
  assert.match(first.indicatorText, /正在载入较早的记录/);

  // Backfill + hydration complete and keep chronological order and message parts.
  await waitHistoryComplete(page, 40);
  const filled = await messageSnapshot(page);
  assert.deepEqual(filled.map(entry => entry.token), Array.from({ length: 40 }, (_, i) => String(i)), 'all messages exist in chronological order');
  assert.deepEqual(filled.map(entry => entry.role), messages.map(message => message.role));
  assert.deepEqual(
    filled.map(entry => [entry.thinking, entry.tools]),
    messages.map(message => message.role === 'assistant' ? [1, 1] : [0, 0]),
    'assistant parts (thinking + tool cards) survive the backfill and hydration'
  );
  assert.deepEqual(filled.map(entry => [entry.hydrating, entry.hydratingAttr]), Array(40).fill([false, false]), 'no hydration hint or marker remains');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages > .history-loading').length), 0, 'the indicator is removed when the fill completes');

  // Hydration must produce exactly the DOM of today's one-shot render for every part.
  const mismatched = await page.evaluate(fixtureMessages => {
    const articles = [...document.querySelectorAll('#messages > .message')];
    const bad = [];
    fixtureMessages.forEach((item, index) => {
      if (item.role !== 'assistant' || !Array.isArray(item.parts)) return;
      const reference = document.createElement('div');
      try {
        window.UBOVMMessage.update(reference, item.text, { role: 'assistant', parts: item.parts, streaming: false, preserveBody: true });
        const live = articles[index]?.querySelector('.message-text');
        if (!live || live.innerHTML !== reference.innerHTML) bad.push(index);
      } finally { window.UBOVMMessage.release(reference); }
    });
    return bad;
  }, messages);
  assert.deepEqual(mismatched, [], 'hydrated message DOM is identical to a one-shot render');

  // The indicator must not leave the newest messages unreachable or the reader unpinned.
  assert.ok(await page.evaluate(() => {
    const scroller = document.getElementById('conversation');
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4;
  }), 'following readers stay pinned to the bottom through the fill and hydration');

  // No runaway rAF loop or detached churn after everything settles.
  await page.evaluate(() => {
    window.lateMutations = 0;
    window.lateObserver = new MutationObserver(records => { window.lateMutations += records.length; });
    window.lateObserver.observe(document.getElementById('messages'), { childList: true, subtree: true });
  });
  await frames(page, 8);
  assert.equal(await page.evaluate(() => { window.lateObserver.disconnect(); return window.lateMutations; }), 0, 'the fill/hydration loop stops once complete');
});

test('progressive first paint of rich newest turns has no long task over 50 ms (median of 3)', async t => {
  const maxima = [];
  for (let run = 0; run < 3; run++) {
    const page = await fixture(t);
    const supported = await page.evaluate(() => window.__longTaskSupported);
    if (!supported) { t.skip('PerformanceObserver longtask is unavailable'); return; }
    await armFirstPaint(page);
    await page.evaluate(() => { window.__longTasks = []; });
    await dispatchState(page, state(`smooth-perf-${run}`, richHistory(40, `P${run}`)));
    await firstPaint(page);
    await waitHistoryComplete(page, 40);
    await frames(page, 3);
    maxima.push(await page.evaluate(() => Math.max(0, ...window.__longTasks)));
  }
  maxima.sort((left, right) => left - right);
  const median = maxima[1];
  assert.ok(median <= 50, `initial progressive render + hydration must stay under the 50 ms long-task threshold (runs: ${maxima.map(value => Math.round(value)).join(', ')} ms)`);
});

test('progressive fill keeps a following reader pinned to the bottom', async t => {
  const page = await fixture(t);
  await armFirstPaint(page);
  await dispatchState(page, state('smooth-follow', tallHistory(30, 'follow')));
  await firstPaint(page);
  // Let the initial scroll-to-bottom frame and the first backfill frame run.
  await frames(page, 2);
  const early = await page.evaluate(() => {
    const scroller = document.getElementById('conversation');
    return {
      count: scroller.querySelectorAll('#messages > .message').length,
      pinned: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4
    };
  });
  assert.ok(early.count > 3, 'backfill has started');
  assert.equal(early.pinned, true, 'a following reader stays pinned while older history is inserted above');
  await waitHistoryComplete(page, 30);
  assert.equal(await page.evaluate(() => {
    const scroller = document.getElementById('conversation');
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4;
  }), true, 'the reader is still pinned at the bottom when the fill completes');
});

test('progressive fill preserves the visual anchor of a reader scrolled up', async t => {
  const page = await fixture(t);
  // The whole scenario runs inside one page.evaluate so protocol round-trips cannot
  // let the (time-budgeted) fill finish before the reader scrolls up. Plain tall
  // messages keep the anchored-height math exact (no part hydration).
  const result = await page.evaluate(async snapshot => {
    const root = document.getElementById('messages');
    const scroller = document.getElementById('conversation');
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const mounted = () => [...root.querySelectorAll(':scope > .message')];
    const firstPaint = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (!mounted().length) return;
        observer.disconnect();
        resolve(mounted().length);
      });
      observer.observe(root, { childList: true });
    });
    window.dispatchEvent(new MessageEvent('message', { data: snapshot }));
    const firstCount = await firstPaint;
    // Frame after the first paint: the initial follow-to-bottom frame and the first
    // backfill frame have run, so the reader scroll now owns the scroll position.
    await nextFrame();
    scroller.scrollTop = 140;
    await nextFrame();
    const articles = mounted();
    const anchor = articles.find(article => article.getBoundingClientRect().bottom > 8);
    const before = {
      count: articles.length,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      anchorToken: anchor?.textContent.match(/T#(\d+)#/)?.[1] ?? '',
      anchorTop: anchor?.getBoundingClientRect().top ?? 0
    };
    // Bounded by construction: the fill always advances and renders >= 1 message.
    await new Promise(resolve => {
      const check = () => { if (mounted().length >= 300) resolve(); else requestAnimationFrame(check); };
      requestAnimationFrame(check);
    });
    const anchorAfter = mounted().find(article => (article.textContent.match(/T#(\d+)#/)?.[1] ?? '') === before.anchorToken);
    return {
      firstCount,
      before,
      after: {
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        anchorTop: anchorAfter?.getBoundingClientRect().top ?? NaN,
        anchorConnected: Boolean(anchorAfter?.isConnected)
      }
    };
  }, state('smooth-anchor', tallHistory(300, 'anchor')));
  assert.equal(result.firstCount, 3);
  assert.ok(result.before.count < 300, `the fill is still running when the reader scrolls up (painted ${result.before.count})`);
  assert.ok(result.before.anchorToken, 'a visible anchor message is available');
  assert.equal(result.after.anchorConnected, true);
  // scrollHeight-based compensation rounds to integer pixels per frame, so a
  // few px of subpixel drift (or offscreen intrinsic-size estimates) is expected;
  // a lost anchor would jump by an entire message height (hundreds of px).
  assert.ok(Math.abs(result.after.anchorTop - result.before.anchorTop) <= 10, `the anchor message must not move (was ${result.before.anchorTop}, now ${result.after.anchorTop})`);
  // Inserted height above the reader is compensated exactly by scrollTop.
  const deltaTop = result.after.top - result.before.top;
  const deltaHeight = result.after.height - result.before.height;
  assert.ok(Math.abs(deltaTop - deltaHeight) <= 2, `scrollTop must absorb the inserted history height (Δtop ${deltaTop}, Δheight ${deltaHeight})`);
  assert.ok(deltaTop > 100, `the reader scroll must be compensated, not left at the top (Δtop ${deltaTop})`);
  assert.ok(result.after.height - result.after.top - result.after.clientHeight > 100, 'the reader is not dragged back to the bottom');
});

test('histories up to 24 messages still paint synchronously without indicator or hydration', async t => {
  const page = await fixture(t);
  const messages = richHistory(24, 'short');
  await armFirstPaint(page);
  await dispatchState(page, state('smooth-24', messages));
  const first = await firstPaint(page);
  assert.equal(first.count, 24, 'a 24-message history paints fully on the first frame');
  assert.deepEqual(first.tokens, Array.from({ length: 24 }, (_, i) => String(i)));
  assert.equal(first.indicator, false, 'short histories do not show the loading indicator');
  assert.equal(first.skeletonHidden, true);
  // Short histories stay fully synchronous: tool cards are present immediately and
  // no shell/hydration hint is used.
  assert.deepEqual(
    first.shells.map(shell => [shell.thinking, shell.tools, shell.hydrating]),
    messages.map(message => message.role === 'assistant' ? [1, 1, false] : [0, 0, false])
  );
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages > .history-loading, #messages .message-hydrating').length), 0);
});

test('session switch restarts progressive fill and abandons the previous fill', async t => {
  const page = await fixture(t);
  await armFirstPaint(page);
  await dispatchState(page, state('smooth-switch-a', richHistory(40, 'A')));
  await waitHistoryComplete(page, 40);

  await armFirstPaint(page);
  await dispatchState(page, state('smooth-switch-b', richHistory(40, 'B')));
  const first = await firstPaint(page);
  assert.equal(first.count, 3, 'the switched conversation also paints only its newest three messages first');
  assert.deepEqual(first.tokens, ['37', '38', '39']);
  assert.equal(first.indicator, true, 'the new conversation shows its own loading indicator');
  assert.equal(first.shells[0].hydrating, true, 'the new conversation shells hydrate too');
  const texts = await page.evaluate(() => [...document.querySelectorAll('#messages > .message')].map(article => article.textContent));
  assert.ok(texts.every(text => text.includes('B') && !text.includes('A T#')), 'no message from the previous session survives the switch');

  await waitHistoryComplete(page, 40);
  const tokens = (await messageSnapshot(page)).map(entry => entry.token);
  assert.deepEqual(tokens, Array.from({ length: 40 }, (_, i) => String(i)), 'the new conversation fills in order');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages > .history-loading, #messages .message-hydrating').length), 0);
  // The switch still delivers its contentReady acknowledgement for the new session.
  await page.waitForFunction(() => window.sent.some(message => message.action === 'contentReady' && message.sessionId === 'smooth-switch-b'));
});
