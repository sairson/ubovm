// Independent end-to-end verification for assist-mode DSH one-line thinking
// (shared message-view card): a running thinking part renders as ONE collapsed
// row with a continuously changing single-line preview; click expands the full
// Markdown; manual state persists; duration/shimmer/one-line guarantees; summary
// cards and tool grouping keep their existing behavior. Contract: .tmp-log5/contract.md.
//
// The goal-log custom `.goal-log-reasoning` line and its tests are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const start = Date.now();
const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://thinking-dsh-e2e.test/';
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

const MARKER = 'ASSIST-REASON-TAIL';
const REASON = [
  '先核对 **协助模式** 的思考单行预览。',
  '',
  '- 读取 `messages/message-view.js` 的思考逻辑；',
  '- 确认流式思考保持折叠；',
  '',
  '```json',
  '{"intents":[{"id":"assist-1","action":"inspect"}],"decision":"dispatch"}',
  '```',
  '',
  '最后一段思考结论标记 ' + MARKER + '。'
].join('\n');
const tickText = tick => REASON + '\n\n追加的思考内容片段 ' + tick + '。' + ' 持续追加的单行预览文本。'.repeat(3);
const longTail = ' 长思考内容持续追加用于单行省略号验证。'.repeat(12);

const thinking = (id, overrides = {}) => ({
  id, type: 'thinking', source: 'assistant', status: 'running',
  startedAt: start, text: REASON, ...overrides
});
const text = (id, value, status = 'completed') => ({ id, type: 'text', text: value, status, startedAt: start + 3000 });
const tool = (id, overrides = {}) => ({
  id, type: 'tool', name: 'read_file', status: 'completed', startedAt: start + 4000, endedAt: start + 4500,
  args: '{"path":"src/renderer/webview/messages/message-view.js"}', output: 'content', ...overrides
});
const summaryPart = (id, overrides = {}) => ({
  id, type: 'summary', source: 'assistant', status: 'running', startedAt: start, text: '', ...overrides
});
const user = { role: 'user', text: '请检查协助模式思考卡片的单行行为。' };
const state = (parts, overrides = {}) => ({
  type: 'state', mode: 'assist',
  conversation: { id: 'thinking-dsh', title: '协助模式思考' },
  messages: [user, { role: 'assistant', text: '', parts }],
  goal: null, context: { workspace: 'UBOVM', file: '' },
  provider: { configured: true, connected: true, label: '测试模型' },
  busy: true,
  execution: { status: 'running', busy: true, parts, streamText: '', activities: [] },
  ...overrides
});

async function fixture(t, { width = 1100, height = 900, reducedMotion } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, ...(reducedMotion ? { reducedMotion } : {}) });
  page.setDefaultTimeout(10000);
  const errors = [];
  const consoleErrors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) requests.push(url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) requests.push(url + ' (failed)');
  });
  await page.addInitScript(({ start }) => {
    window.fixtureNow = start + 2000;
    Date.now = () => window.fixtureNow;
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  }, { start });
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'thinking-dsh-e2e' })
  }));
  await page.route('https://blocked-thinking.invalid/**', route => route.abort());
  await page.goto(origin);
  const frames = (count = 2) => page.evaluate(async amount => {
    for (let index = 0; index < amount; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
  const emit = async value => {
    await page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: next })), value);
    await frames(2);
    await page.waitForTimeout(120);
  };
  const card = index => page.locator('#messages .thinking-card:not(.summary-card)').nth(index);
  const toggle = async index => { await card(index).locator(':scope > summary').click(); await frames(3); };
  const advance = async ms => { await page.evaluate(amount => { window.fixtureNow += amount; }, ms); await page.waitForTimeout(1100); await frames(); };
  t.after(async () => {
    await page.close().catch(() => {});
    assert.deepEqual(errors, [], 'the webview must not throw browser errors');
    assert.deepEqual(consoleErrors, [], 'the webview must not log console errors');
    assert.deepEqual(requests, [], 'thinking markup must not fetch remote resources');
  });
  return { page, emit, frames, card, toggle, advance };
}

// Preview discovery is intentionally implementation-agnostic: the collapsed row must
// expose a single-line preview element inside the summary (class/attribute may vary).
const previewInfo = (f, index = 0) => f.page.evaluate(idx => {
  const card = document.querySelectorAll('#messages .thinking-card:not(.summary-card)')[idx];
  if (!card) return null;
  const summary = card.querySelector('summary');
  const explicit = card.querySelector('.thinking-preview, .thinking-line, [data-thinking-preview], [class*="thinking-preview"]');
  const title = card.querySelector('.thinking-title');
  const meta = card.querySelector('.thinking-time');
  const body = card.querySelector('.thinking-body, .thinking-content');
  const summaryText = (summary?.textContent || '').replace(/\s+/g, ' ').trim();
  const titleText = (title?.textContent || '').replace(/\s+/g, ' ').trim();
  const metaText = (meta?.textContent || '').replace(/\s+/g, ' ').trim();
  const derived = summaryText
    .replace(titleText, '').replace(metaText, '')
    .replace(/正在整理上下文|规划|子任务/g, '').replace(/^[›\s✦]+/, '').replace(/[›\s]+$/, '').trim();
  const bodyStyle = body ? getComputedStyle(body) : null;
  const bodyRect = body ? body.getBoundingClientRect() : null;
  const cardRect = card.getBoundingClientRect();
  // The card clips its body while collapsed (card stays one line), so "body visible"
  // must be judged by the card's own height/open state, not the body's raw rect.
  const bodyShown = card.open === true && cardRect.height > 60;
  const target = explicit || null;
  const style = target ? getComputedStyle(target) : null;
  const cardStyle = getComputedStyle(card);
  return {
    exists: true,
    open: card.open === true,
    summaryText, titleText, metaText,
    explicitPreview: Boolean(explicit),
    previewText: target ? (target.textContent || '').replace(/\s+/g, ' ').trim() : derived,
    bodyVisible: bodyShown,
    bodyHeight: bodyRect ? Math.round(bodyRect.height) : 0,
    bodyText: (body?.textContent || '').replace(/\s+/g, ' ').trim(),
    cardHeight: Math.round(cardRect.height),
    summaryHeight: Math.round((summary?.getBoundingClientRect().height) || 0),
    previewStyle: style ? {
      whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflow,
      animationName: style.animationName, animationDuration: style.animationDuration
    } : null,
    cardAnimationName: cardStyle.animationName,
    summaryChildren: [...(summary?.children || [])].map(child => ({ tag: child.tagName, className: typeof child.className === 'string' ? child.className : '' }))
  };
}, index);

// ---------------------------------------------------------------------------
// 1. Streaming thinking starts collapsed with one non-empty preview line.
// ---------------------------------------------------------------------------
test('streaming thinking starts collapsed as one line with a non-empty preview', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const info = await previewInfo(f);
  assert.ok(info, 'a thinking card must render');
  assert.equal(info.open, false, 'streaming thinking must NOT auto-open the card');
  assert.equal(info.bodyVisible, false, 'the full thinking body must stay hidden while collapsed');
  assert.ok(info.previewText.length > 0, 'the collapsed row must show a non-empty preview text');
  assert.match(info.titleText, /思考中/, 'a running thinking card must keep the 思考中 title');
  assert.ok(info.cardHeight <= 40, `the collapsed thinking row must stay one line (<=40px); got ${info.cardHeight}px`);
  assert.equal(info.summaryHeight <= 36, true, `the summary row must stay one line; got ${info.summaryHeight}px`);
  const contract = await f.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    return {
      status: card.getAttribute('data-status'),
      source: card.getAttribute('data-source'),
      previewElement: Boolean(card.querySelector('.thinking-preview')),
      bodyParsed: (card.querySelector('.thinking-content')?.childElementCount ?? 99) > 0,
      previewInSummary: Boolean(card.querySelector('summary .thinking-preview')),
      summaryChildren: [...(card.querySelector('summary')?.children || [])].map(child => child.className)
    };
  });
  assert.equal(contract.status, 'running', 'the running card must expose data-status="running"');
  assert.equal(contract.previewElement, true, 'the collapsed row must use the .thinking-preview element');
  assert.equal(contract.previewInSummary, true, 'the preview must live in the summary row');
  assert.equal(contract.bodyParsed, false, 'the Markdown body must not be parsed while collapsed (lazy)');
  for (const name of ['thinking-indicator', 'thinking-title', 'thinking-source', 'thinking-preview', 'thinking-time', 'thinking-chevron']) {
    assert.ok(contract.summaryChildren.includes(name), `the summary row must keep .${name}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Preview keeps changing across streaming tokens while the row stays closed.
// ---------------------------------------------------------------------------
test('the one-line preview changes on every thinking token without opening the card', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live', { text: tickText(1) })]));
  const first = await previewInfo(f);
  assert.ok(first.previewText.length > 0, 'preview must start non-empty');
  await f.page.evaluate(() => {
    window.__previewCard = document.querySelector('#messages .thinking-card:not(.summary-card)');
    window.__previewNode = window.__previewCard?.querySelector('.thinking-preview, .thinking-line, [data-thinking-preview]') || null;
  });
  for (let tick = 2; tick <= 4; tick++) {
    await f.emit(state([thinking('live', { text: tickText(tick) })]));
  }
  const after = await previewInfo(f);
  assert.notEqual(after.previewText, first.previewText, `the preview must change as tokens stream (${JSON.stringify(first.previewText)} -> ${JSON.stringify(after.previewText)})`);
  assert.match(after.previewText, /片段 4/, 'the newest streamed thinking text must be reflected in the preview');
  assert.equal(after.open, false, 'streaming tokens must never auto-open the card');
  assert.equal(after.bodyVisible, false, 'the body must stay hidden while collapsed');
  const identity = await f.page.evaluate(() => ({
    sameCard: window.__previewCard === document.querySelector('#messages .thinking-card:not(.summary-card)'),
    samePreview: window.__previewNode === (window.__previewCard?.querySelector('.thinking-preview, .thinking-line, [data-thinking-preview]') || null)
  }));
  assert.equal(identity.sameCard, true, 'streaming updates must reuse the thinking card element');
  assert.equal(identity.samePreview, true, 'streaming updates must reuse the preview element (no rebuild)');
});

// ---------------------------------------------------------------------------
// 3. Preview strips Markdown/protocol JSON and clamps with an ellipsis.
// ---------------------------------------------------------------------------
test('the preview strips Markdown and raw plan JSON and clamps with an ellipsis', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live', { text: tickText(1) + longTail })]));
  const info = await previewInfo(f);
  assert.doesNotMatch(info.previewText, /\*\*|`|```|"intents"|"decision"\s*:/, `preview must strip Markdown/fenced JSON (got ${JSON.stringify(info.previewText)})`);
  assert.ok(info.previewText.length <= 200, `preview must be clamped to one line (~120-180 chars); got ${info.previewText.length}`);
  assert.ok(info.previewText.endsWith('…'), 'a clamped preview must end with an ellipsis');
  assert.match(info.previewText, /长思考内容|持续追加/, 'the preview must show the newest meaningful reasoning line');
  // A fenced protocol payload is folded/stripped from the one-line preview.
  await f.emit(state([thinking('folded', { text: '先整理思路。\n\n```json\n{"intents":[{"id":"assist-1"}],"decision":"dispatch"}\n```' })]));
  const folded = await previewInfo(f);
  assert.match(folded.previewText, /\[规划协议内容已折叠\]|先整理思路/, `the fenced block must not leak into the preview (got ${JSON.stringify(folded.previewText)})`);
  assert.doesNotMatch(folded.previewText, /"intents"|"decision"|\{|\}/, 'raw protocol JSON must never leak into the preview');
});

// ---------------------------------------------------------------------------
// 4. Click expands the full Markdown body (lazy), click collapses again.
// ---------------------------------------------------------------------------
test('clicking the row lazily expands the full Markdown body and clicking again collapses it', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const closed = await previewInfo(f);
  assert.equal(closed.bodyVisible, false, 'body starts hidden');
  assert.ok(!closed.bodyText.includes(MARKER), 'the Markdown body must be lazily rendered only after opening');
  await f.toggle(0);
  const opened = await previewInfo(f);
  assert.equal(opened.open, true, 'clicking the row must expand the card');
  assert.equal(opened.bodyVisible, true, 'the expanded body must be visible');
  assert.match(opened.bodyText, new RegExp(MARKER), 'the expanded body must contain the full reasoning Markdown');
  assert.match(opened.bodyText, /读取/, 'the expanded body must contain earlier reasoning lines');
  if (opened.previewStyle) {
    assert.equal(opened.previewStyle.whiteSpace === 'nowrap' || opened.previewStyle.display === 'none', true, 'the preview is hidden or single-line while expanded');
  }
  await f.toggle(0);
  const closedAgain = await previewInfo(f);
  assert.equal(closedAgain.open, false, 'clicking again must collapse the card');
  assert.equal(closedAgain.bodyVisible, false, 'the body must be hidden again after collapsing');
});

// ---------------------------------------------------------------------------
// 5. Keyboard toggling and honest status attributes/titles.
// ---------------------------------------------------------------------------
test('keyboard Enter/Space toggles the row and status attributes/titles stay honest', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const summary = f.card(0).locator(':scope > summary');
  await summary.focus();
  await f.page.keyboard.press('Enter');
  await f.frames(3);
  let info = await previewInfo(f);
  assert.equal(info.open, true, 'Enter on the focused summary must expand the row');
  assert.equal(await f.page.evaluate(() => getComputedStyle(document.querySelector('#messages .thinking-preview')).display), 'none', 'the preview must be hidden while expanded');
  await f.page.keyboard.press('Enter');
  await f.frames(3);
  info = await previewInfo(f);
  assert.equal(info.open, false, 'Enter must collapse the row again');
  await f.page.keyboard.press('Space');
  await f.frames(3);
  info = await previewInfo(f);
  assert.equal(info.open, true, 'Space on the focused summary must also expand the row');
  await f.page.keyboard.press('Space');
  await f.frames(3);
  // Completed and interrupted titles/attributes.
  await f.emit(state([thinking('live', { status: 'completed', endedAt: start + 4000 })]));
  let contract = await f.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    return { status: card.getAttribute('data-status'), title: (card.querySelector('.thinking-title')?.textContent || '').trim(), open: card.open === true };
  });
  assert.deepEqual(contract, { status: 'completed', title: '已思考', open: false }, 'completion never opens the card and keeps data-status="completed"');
  await f.emit(state([{ ...thinking('stopped', { status: 'interrupted', endedAt: start + 900, text: '停止前的思考。' }) }]));
  contract = await f.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    return { status: card.getAttribute('data-status'), title: (card.querySelector('.thinking-title')?.textContent || '').trim(), open: card.open === true };
  });
  assert.equal(contract.status, 'interrupted', 'interrupted thinking keeps data-status="interrupted"');
  assert.match(contract.title, /思考已停止|停止|中断/, 'interrupted thinking shows the honest stopped title');
  assert.equal(contract.open, false, 'interrupted thinking stays collapsed');
});

// ---------------------------------------------------------------------------
// 6. Manual open state survives streaming ticks and completion.
// ---------------------------------------------------------------------------
test('a manually opened card stays open through streaming and completion', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  await f.toggle(0);
  for (let tick = 2; tick <= 3; tick++) await f.emit(state([thinking('live', { text: tickText(tick) })]));
  let info = await previewInfo(f);
  assert.equal(info.open, true, 'a manually opened card must stay open across streaming ticks');
  assert.match(info.bodyText, /片段 3/, 'the expanded body must keep showing the newest streamed text');
  await f.emit(state([thinking('live', { status: 'completed', endedAt: start + 5000, text: tickText(3) })]));
  info = await previewInfo(f);
  assert.equal(info.open, true, 'completion must not close a user-opened card');
  assert.match(info.titleText, /已思考/, 'the completed title must read 已思考');
});

// ---------------------------------------------------------------------------
// 6. Manual closed state survives streaming ticks and completion.
// ---------------------------------------------------------------------------
test('a manually collapsed card stays closed through streaming and completion', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  await f.toggle(0);
  await f.toggle(0);
  for (let tick = 2; tick <= 3; tick++) await f.emit(state([thinking('live', { text: tickText(tick) })]));
  await f.emit(state([thinking('live', { status: 'completed', endedAt: start + 5000, text: tickText(3) })]));
  const info = await previewInfo(f);
  assert.equal(info.open, false, 'a manually collapsed card must stay closed through ticks and completion');
  assert.equal(info.bodyVisible, false, 'the body must stay hidden');
  assert.match(info.titleText, /已思考/, 'the completed title must read 已思考');
});

// ---------------------------------------------------------------------------
// 7. Completion collapses an unopened streaming card and freezes the duration.
// ---------------------------------------------------------------------------
test('completion collapses an unopened card and freezes the duration', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const running = await previewInfo(f);
  assert.match(running.metaText, /\d+(\.\d+)?s/, 'the running card must show a live duration');
  await f.advance(3000);
  const advanced = await previewInfo(f);
  assert.notEqual(advanced.metaText, running.metaText, 'the running duration must advance while streaming');
  await f.emit(state([thinking('live', { status: 'completed', endedAt: start + 7000 })]));
  const completed = await previewInfo(f);
  assert.equal(completed.open, false, 'completion must not open a card the user did not open');
  assert.match(completed.metaText, /7\.0s/, 'the duration must freeze at the host-provided final duration');
  await f.advance(5000);
  const frozen = await previewInfo(f);
  assert.equal(frozen.metaText, completed.metaText, 'the duration must stay frozen after completion');
});

// ---------------------------------------------------------------------------
// 8. One-line guarantee + ellipsis at 1100px and 430px.
// ---------------------------------------------------------------------------
test('the thinking row stays one line with an ellipsized preview at 1100px and 430px', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live', { text: tickText(9) + longTail })]));
  const read = () => f.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    const preview = card?.querySelector('.thinking-preview, .thinking-line, [data-thinking-preview]');
    const style = preview ? getComputedStyle(preview) : null;
    return {
      cardHeight: Math.round(card?.getBoundingClientRect().height || 0),
      summaryHeight: Math.round((card?.querySelector('summary')?.getBoundingClientRect().height) || 0),
      preview: preview ? { text: (preview.textContent || '').trim(), scrollWidth: preview.scrollWidth, clientWidth: preview.clientWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflow } : null,
      columnWidth: Math.round((card?.closest('#messages')?.getBoundingClientRect().width) || 0),
      pageWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    };
  });
  const wide = await read();
  assert.ok(wide.cardHeight <= 40, `one-line thinking row at 1100px (got ${wide.cardHeight}px)`);
  assert.ok(wide.summaryHeight <= 36, `one-line summary at 1100px (got ${wide.summaryHeight}px)`);
  assert.ok(wide.preview, 'the preview element must exist for the one-line guarantee');
  assert.ok(wide.preview.text.length > 0, 'preview must be non-empty');
  assert.equal(wide.preview.whiteSpace, 'nowrap', 'preview must not wrap');
  assert.equal(wide.preview.textOverflow, 'ellipsis', 'preview must use ellipsis');
  assert.equal(wide.preview.overflow, 'hidden', 'preview must clip overflow');
  assert.ok(wide.preview.scrollWidth > wide.preview.clientWidth, 'long previews must ellipsize (scrollWidth > clientWidth)');
  await f.page.setViewportSize({ width: 430, height: 900 });
  await f.frames(3);
  const narrow = await read();
  assert.ok(narrow.cardHeight <= 40, `one-line thinking row at 430px (got ${narrow.cardHeight}px)`);
  assert.ok(narrow.summaryHeight <= 36, `one-line summary at 430px (got ${narrow.summaryHeight}px)`);
  assert.ok(narrow.preview && narrow.preview.whiteSpace === 'nowrap' && narrow.preview.textOverflow === 'ellipsis', 'preview stays nowrap+ellipsis at 430px');
  assert.ok(narrow.preview.scrollWidth > narrow.preview.clientWidth, 'narrow preview ellipsizes');
  assert.ok(narrow.pageWidth <= narrow.innerWidth, `page must not overflow horizontally at 430px (${narrow.pageWidth} > ${narrow.innerWidth})`);
});

// ---------------------------------------------------------------------------
// 9. Running shimmer respects reduced motion; completed cards do not animate.
// ---------------------------------------------------------------------------
test('the running preview shimmers and reduced motion disables animations', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const running = await previewInfo(f);
  assert.ok(running.previewStyle, 'the preview element must exist for the shimmer check');
  assert.notEqual(running.previewStyle.animationName, 'none', 'a running preview must animate the neutral shimmer');
  await f.emit(state([thinking('live', { status: 'completed', endedAt: start + 4000 })]));
  const completed = await previewInfo(f);
  assert.equal(completed.previewStyle?.animationName, 'none', 'a completed preview must not animate');

  const reduced = await fixture(t, { reducedMotion: 'reduce' });
  await reduced.emit(state([thinking('live')]));
  const reducedInfo = await previewInfo(reduced);
  assert.ok(reducedInfo.previewStyle, 'preview must exist under reduced motion');
  const animations = await reduced.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    return [...card.querySelectorAll('*')].map(node => getComputedStyle(node).animationName).concat(getComputedStyle(card).animationName);
  });
  assert.ok(animations.every(name => name === 'none'), `reduced motion must disable all thinking animations (got ${JSON.stringify(animations)})`);
});

// ---------------------------------------------------------------------------
// 10. Summary cards keep their existing behavior (no DSH preview/shimmer).
// ---------------------------------------------------------------------------
test('summary cards keep their existing lazy foldout behavior and are not turned into DSH rows', async t => {
  const f = await fixture(t);
  await f.emit(state([summaryPart('context-summary')]));
  const card = f.page.locator('#messages .summary-card');
  assert.equal(await card.count(), 1, 'a summary part must render a .summary-card');
  assert.equal(await card.evaluate(node => node.open), false, 'summary cards keep their collapsed default');
  assert.match(await card.locator(':scope > summary').textContent(), /正在整理上下文/, 'summary title unchanged');
  await card.locator(':scope > summary').click();
  await f.frames(2);
  assert.equal(await card.evaluate(node => node.open), true, 'clicking a summary card still opens it');
  assert.match(await card.locator('.thinking-content, .thinking-body').first().textContent(), /正在整理/, 'summary body still renders');
  const facts = await f.page.evaluate(() => {
    const card = document.querySelector('#messages .summary-card');
    return {
      preview: card.querySelectorAll('.thinking-preview, [data-thinking-preview]').length,
      animations: [...card.querySelectorAll('*')].map(node => getComputedStyle(node).animationName).filter(name => name !== 'none')
    };
  });
  assert.equal(facts.preview, 0, 'summary cards must not get the DSH thinking preview');
  const shimmerNames = facts.animations.filter(name => /sweep|shimmer|preview/i.test(name));
  assert.deepEqual(shimmerNames, [], `summary cards must not get the running thinking shimmer (allowed pre-existing indicator pulse: ${JSON.stringify(facts.animations)})`);
});

// ---------------------------------------------------------------------------
// 11. Tool grouping stays unchanged (default assist grouping still batches).
// ---------------------------------------------------------------------------
test('assist tool grouping is unchanged (consecutive tools still group)', async t => {
  const f = await fixture(t);
  const parts = [
    tool('a', { name: 'read_file', startedAt: start + 1000 }),
    tool('b', { name: 'search_web', startedAt: start + 1500 }),
    tool('c', { name: 'list_dir', startedAt: start + 2000 })
  ];
  await f.emit(state(parts));
  const facts = await f.page.evaluate(() => ({
    groups: document.querySelectorAll('#messages .tool-group').length,
    cardsInGroups: [...document.querySelectorAll('#messages .tool-group')].map(group => group.querySelectorAll('.tool-card').length),
    thinkingCards: document.querySelectorAll('#messages .thinking-card:not(.summary-card)').length
  }));
  assert.equal(facts.groups, 1, 'consecutive assist tools must still render one .tool-group');
  assert.deepEqual(facts.cardsInGroups, [3], 'the tool group must contain all consecutive tool cards (default grouping unchanged)');
  assert.equal(facts.thinkingCards, 0, 'tool-only message has no thinking card');
});

// ---------------------------------------------------------------------------
// 12. History promotion preserves card identity, open state and selected text.
// ---------------------------------------------------------------------------
test('history promotion preserves the thinking card, manual expansion and selected text', async t => {
  const f = await fixture(t);
  const live = thinking('persistent', { text: '先核对 **Worker 配置**。\n\n正在检查流式事件。' });
  await f.emit(state([live]));
  await f.toggle(0);
  await f.page.evaluate(() => {
    window.__card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    window.__body = window.__card.querySelector('.thinking-content, .thinking-body');
    window.__textNode = window.__body.querySelector('p')?.firstChild || null;
    if (window.__textNode) {
      const range = document.createRange();
      range.setStart(window.__textNode, 0);
      range.setEnd(window.__textNode, Math.min(3, window.__textNode.textContent.length));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
  await f.emit(state([{ ...live, text: live.text + ' 已收到第一段输出。' }]));
  let snapshot = await f.page.evaluate(() => ({
    card: window.__card === document.querySelector('#messages .thinking-card:not(.summary-card)'),
    open: window.__card.open === true,
    selected: getSelection().toString(),
    body: window.__body === window.__card.querySelector('.thinking-content, .thinking-body')
  }));
  assert.deepEqual(snapshot, { card: true, open: true, selected: '先核对', body: true });
  const completedParts = [{ ...live, status: 'completed', endedAt: start + 5000 }, text('final', '配置正确，流式输出正常。')];
  await f.emit(state(completedParts, {
    busy: false,
    messages: [user, { role: 'assistant', text: '配置正确，流式输出正常。', parts: completedParts }],
    execution: { status: 'completed', busy: false, parts: completedParts }
  }));
  snapshot = await f.page.evaluate(() => ({
    card: window.__card === document.querySelector('#messages .thinking-card:not(.summary-card)'),
    open: window.__card.open === true,
    selected: getSelection().toString(),
    articles: document.querySelectorAll('#messages article.assistant').length,
    streamingArticles: document.querySelectorAll('#messages article[data-streaming]').length
  }));
  assert.deepEqual(snapshot, { card: true, open: true, selected: '先核对', articles: 1, streamingArticles: 0 });
  // A later metadata update must respect a manual collapse.
  await f.toggle(0);
  await f.emit(state(completedParts, {
    busy: false,
    messages: [user, { role: 'assistant', text: '配置正确，流式输出正常。', parts: [{ ...completedParts[0], source: 'reason' }, completedParts[1]] }],
    execution: { status: 'completed', busy: false, parts: completedParts }
  }));
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'manual collapse must survive later metadata updates');
});

// ---------------------------------------------------------------------------
// 13. Safe Markdown only: unsafe HTML stays inert, no network, statuses honest.
// ---------------------------------------------------------------------------
test('thinking markdown stays inert and statuses/durations stay honest', async t => {
  const f = await fixture(t);
  const unsafe = thinking('unsafe', {
    text: '<img src="https://blocked-thinking.invalid/x" onerror="window.injected=true">\n\n**Safe** markdown.',
    status: 'interrupted', endedAt: start + 800, truncated: true
  });
  await f.emit(state([unsafe]));
  await f.toggle(0);
  const facts = await f.page.evaluate(() => ({
    injected: window.injected === true,
    images: document.querySelectorAll('#messages .thinking-card img').length,
    scripts: document.querySelectorAll('#messages .thinking-card script').length,
    bodyText: (document.querySelector('#messages .thinking-card .thinking-content, #messages .thinking-card .thinking-body')?.textContent || ''),
    summaryText: (document.querySelector('#messages .thinking-card summary')?.textContent || ''),
    metaText: (document.querySelector('#messages .thinking-card .thinking-time')?.textContent || '').trim()
  }));
  assert.equal(facts.injected, false, 'unsafe thinking markup must never execute');
  assert.equal(facts.images, 0, 'unsafe thinking markup must not create active images');
  assert.equal(facts.scripts, 0, 'unsafe thinking markup must not create scripts');
  assert.match(facts.bodyText, /Safe markdown/, 'safe Markdown still renders in the expanded body');
  assert.match(facts.summaryText, /停止|中断/, 'interrupted thinking keeps an honest status');
  assert.equal(facts.metaText, '0.8s', 'interrupted thinking duration freezes at the last host value');
});

// ---------------------------------------------------------------------------
// 14. Dark/light parity for the collapsed DSH row.
// ---------------------------------------------------------------------------
test('the collapsed thinking row follows the dark theme and stays one line', async t => {
  const f = await fixture(t);
  await f.emit(state([thinking('live')]));
  const read = () => f.page.evaluate(() => {
    const card = document.querySelector('#messages .thinking-card:not(.summary-card)');
    const preview = card?.querySelector('.thinking-preview, .thinking-line, [data-thinking-preview]');
    const body = document.querySelector('#messages');
    return {
      cardHeight: Math.round(card?.getBoundingClientRect().height || 0),
      color: preview ? getComputedStyle(preview).color : null,
      background: body ? getComputedStyle(body).backgroundColor : null
    };
  });
  const light = await read();
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames(2);
  const dark = await read();
  assert.notDeepEqual(dark, light, 'the thinking row must follow the dark theme tokens');
  assert.ok(dark.cardHeight <= 40, 'the dark row stays one line');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
});
