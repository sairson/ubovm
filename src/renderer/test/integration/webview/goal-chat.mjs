import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderGoalChatPanel } = createRequire(import.meta.url)('../../../host/ui/goal-chat-panel.cjs');
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

// The exploration conversation lives in its own native right-sidebar tab
// (Copilot Chat shape). This file drives that standalone page: the host boots it
// with `{ type: 'goalChat', ... }` snapshots, the page answers `ready`, and
// send/stop requests round-trip through `uiResult`.

const EDGE = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SESSION = 'goal-chat-session';
const IDLE = { status: 'idle', messages: [], streamText: '', error: null, canStop: false, updatedAt: 0 };
const USER = { id: 'chat:user-1', role: 'user', text: '现在进展到哪一步了？', at: 1 };
const ANSWER = { id: 'chat:answer-1', role: 'assistant', text: '目标已保存，**正在核对**证据。', at: 2 };
const COMPLETED = { status: 'completed', messages: [USER, ANSWER], streamText: '', error: null, canStop: false, updatedAt: 3 };
const THREADS = [
  { id: 'goal-a', title: '目标 A', active: true, draft: '' },
  { id: 'goal-b', title: '目标 B', active: false, draft: '草稿 B' }
];

const payload = (chat = IDLE, overrides = {}) => ({
  type: 'goalChat', sessionId: SESSION, mode: 'goal', available: true, modelReady: true, offline: false, chat, ...overrides
});

async function openPanel(browser, { viewport = { width: 380, height: 780 } } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      getState() { return undefined; },
      setState() {},
      postMessage(message) { window.sent.push(message); return Promise.resolve(undefined); }
    });
  });
  await page.route('http://goal-chat-panel.test/', route => route.fulfill({ contentType: 'text/html', body: renderGoalChatPanel() }));
  await page.goto('http://goal-chat-panel.test/');
  await page.waitForFunction(() => window.sent.some(message => message.action === 'ready'));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frames();
  return { page, errors, frames, send: async data => { await dispatch(page, data); await frames(); } };
}

const dispatch = (page, data) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
const sent = page => page.evaluate(() => window.sent.slice());
const uiResult = (page, requestId) => dispatch(page, { type: 'uiResult', requestId, ok: true });

test('sidebar page handshakes, renders saved turns and clears the transcript on session change', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    // Before the first host snapshot the page shows its own loading placeholder.
    assert.equal(await page.locator('#goal-chat').isVisible(), false);
    assert.equal(await page.locator('#goal-chat-loading').isVisible(), true);
    await send(payload(IDLE));
    assert.equal(await page.locator('#goal-chat').isVisible(), true);
    assert.equal(await page.locator('#goal-chat-loading').isVisible(), false);
    assert.equal(await page.locator('#goal-chat').getAttribute('aria-label'), '探索对话');
    // Empty sidebar: a Copilot-style hero with the read-only explanation and quick questions.
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), true);
    assert.equal(await page.locator('.goal-chat-hero').isVisible(), true);
    assert.equal(await page.locator('.goal-chat-hero-title').textContent(), '问探索进展');
    assert.match(await page.locator('.goal-chat-empty-copy').textContent(), /查看 Reason 和 Worker 状态/);
    assert.match(await page.locator('.goal-chat-empty-copy').textContent(), /可读写工作区文件、创建意图、管理 Worker 与执行状态/);
    assert.equal(await page.locator('#goal-chat-empty .goal-chat-suggestion').count(), 3);
    // The composer is a floating rounded card, not a page-level footer form.
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), true);
    assert.equal(await page.locator('#goal-chat-form').isVisible(), true);
    assert.notEqual(await page.locator('#goal-chat-form').evaluate(node => getComputedStyle(node).borderRadius), '0px');
    const log = page.locator('#goal-chat-log');
    assert.equal(await log.getAttribute('role'), 'log');
    assert.equal(await log.getAttribute('aria-live'), 'polite');

    await send(payload(COMPLETED));
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), false);
    const rows = page.locator('#goal-chat-log .goal-chat-message');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(0).getAttribute('data-role'), 'user');
    assert.equal(await rows.nth(0).getAttribute('data-message-id'), USER.id);
    assert.equal(await rows.nth(1).getAttribute('data-role'), 'assistant');
    assert.match(await rows.nth(1).textContent(), /正在核对/);
    assert.equal(await rows.nth(1).locator('strong').count(), 1, 'assistant answers render safe Markdown');
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), false);

    await send(payload(IDLE, { sessionId: 'another-session' }));
    assert.equal(await page.locator('#goal-chat-log > *').count(), 0);
    assert.equal(await page.locator('#goal-chat-stream').count(), 0);
    assert.equal(await page.locator('#goal-chat-input').inputValue(), '');
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('streaming partials update in place, sending and stopping round-trip through uiResult', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE));
    await page.locator('#goal-chat-input').fill('还有哪些没有验证完？');
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let requests = (await sent(page)).filter(message => message.action === 'goalChatSend');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, '还有哪些没有验证完？');
    assert.equal(typeof requests[0].requestId, 'string');

    const running = { status: 'running', messages: [{ id: 'chat:user-2', role: 'user', text: '还有哪些没有验证完？', at: 4 }],
      streamText: '还有两处', error: null, canStop: true, updatedAt: 5 };
    await send(payload(running));
    let stream = page.locator('#goal-chat-stream');
    assert.equal(await stream.count(), 1);
    assert.equal(await stream.getAttribute('data-streaming'), 'true');
    assert.match(await stream.textContent(), /还有两处/);
    assert.match(await stream.textContent(), /正在回答/);
    assert.equal(await page.locator('#goal-chat-stop').isVisible(), true);
    await uiResult(page, requests[0].requestId);

    // A later snapshot replaces the partial text instead of appending a new row.
    await send(payload({ ...running, streamText: '还有两处证据没有验证', updatedAt: 6 }));
    stream = page.locator('#goal-chat-stream');
    assert.equal(await stream.count(), 1);
    assert.match(await stream.textContent(), /还有两处证据没有验证/);

    await page.locator('#goal-chat-stop').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const cancelled = (await sent(page)).filter(message => message.action === 'goalChatCancel');
    assert.equal(cancelled.length, 1);
    assert.equal(typeof cancelled[0].requestId, 'string');
    await uiResult(page, cancelled[0].requestId);

    const interrupted = { status: 'interrupted', canStop: false, streamText: '', error: null, updatedAt: 7,
      messages: [{ id: 'chat:user-2', role: 'user', text: '还有哪些没有验证完？', at: 4 },
        { id: 'chat:answer-2', role: 'assistant', text: '还有两处证据没有验证', at: 7 }] };
    await send(payload(interrupted));
    assert.equal(await page.locator('#goal-chat-stream').count(), 0);
    assert.equal(await page.locator('#goal-chat-stop').isVisible(), false);
    assert.equal(await page.locator('#goal-chat-log .goal-chat-message').count(), 2);
    assert.match(await page.locator('#goal-chat-log').textContent(), /还有两处证据没有验证/);
    const stopNote = page.locator('#goal-chat-stop-note');
    assert.equal(await stopNote.isVisible(), true);
    assert.match(await stopNote.textContent(), /回答已停止，已保留已生成的内容/);
    await send(payload(IDLE));
    assert.equal(await stopNote.isVisible(), false, 'a later idle snapshot clears the stop note');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('assistant turns render thinking, tool cards and streaming parts like assist chat', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE));
    const PARTS = [
      { id: 'thinking-1', type: 'thinking', text: '先核对 Worker 状态。', status: 'completed', source: 'assistant', startedAt: 10, endedAt: 20 },
      { id: 'tool-1', type: 'tool', name: 'goal_status', status: 'completed', args: '{}', output: '{"status":"idle"}', startedAt: 20, endedAt: 30 },
      { id: 'text-1', type: 'text', text: '当前没有运行中的 Worker。', status: 'completed' }
    ];
    const answer = { id: 'chat:answer-parts', role: 'assistant', text: '当前没有运行中的 Worker。', at: 9, parts: PARTS };
    await send(payload({ status: 'completed', messages: [USER, answer], streamText: '', error: null, canStop: false, updatedAt: 10 }));
    const row = page.locator('#goal-chat-log .goal-chat-message[data-role="assistant"]');
    assert.equal(await row.locator('.thinking-card').count(), 1, 'thinking output renders as a card');
    assert.equal(await row.locator('.tool-card').count(), 1, 'tool output renders as a card');
    assert.match(await row.textContent(), /当前没有运行中的 Worker/);

    // Streaming parts: the in-progress row keeps the same timeline shape.
    const running = { status: 'running', messages: [USER], streamText: '正在检查', canStop: true, error: null, updatedAt: 11,
      streamParts: [
        { id: 'tool-live', type: 'tool', name: 'goal_status', status: 'running', args: '{}', output: '', startedAt: 40 },
        { id: 'text-live', type: 'text', text: '正在检查', status: 'streaming' }
      ] };
    await send(payload(running));
    const stream = page.locator('#goal-chat-stream');
    assert.equal(await stream.count(), 1);
    assert.equal(await stream.locator('.tool-card').count(), 1, 'streaming tool card is projected');
    assert.match(await stream.textContent(), /正在检查/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('quick questions fill the draft, while a missing model or an unavailable session disables the composer', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE));
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), true);
    const suggestions = page.locator('#goal-chat-empty .goal-chat-suggestion');
    assert.equal(await suggestions.count(), 3);
    assert.deepEqual(await suggestions.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-question'))),
      ['现在进展到哪一步了？', '还有哪些没有验证完？', '下一步建议做什么？']);
    await suggestions.nth(1).click();
    assert.equal(await page.locator('#goal-chat-input').inputValue(), '还有哪些没有验证完？');
    assert.equal((await sent(page)).filter(message => message.action === 'goalChatSend').length, 0,
      'a suggestion only fills the draft');
    assert.equal(await page.locator('#goal-chat-send').isDisabled(), false);
    await page.locator('#goal-chat-input').fill('   ');
    assert.equal(await page.locator('#goal-chat-send').isDisabled(), true);

    await send(payload(IDLE, { modelReady: false }));
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), true, 'a configured sidebar still shows the composer');
    assert.equal(await page.locator('#goal-chat-input').isDisabled(), true);
    assert.equal(await page.locator('#goal-chat-send').isDisabled(), true);
    const notice = page.locator('#goal-chat-notice');
    assert.equal(await notice.isVisible(), true);
    assert.match(await notice.textContent(), /先配置模型/);

    await send(payload(IDLE, { modelReady: true, available: false, mode: 'assist' }));
    assert.equal(await page.locator('#goal-chat-input').isDisabled(), true);
    assert.equal(await page.locator('#goal-chat-send').isDisabled(), true);
    const unavailable = page.locator('#goal-chat-unavailable');
    assert.equal(await unavailable.isVisible(), true);
    assert.match(await unavailable.textContent(), /探索对话仅在探索模式可用/);
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), false, 'the unavailable view hides the composer');
    assert.equal(await page.locator('#goal-chat-notice').isVisible(), false);
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('narrow sidebar widths keep the conversation readable without horizontal overflow', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    for (const width of [320, 430]) {
      const { page, errors, send } = await openPanel(browser, { viewport: { width, height: 760 } });
      const long = { status: 'completed', messages: [...COMPLETED.messages,
        { id: 'chat:answer-2', role: 'assistant', text: '这是一段相对较长的探索回答，用来确认窄侧栏的正文会自动换行而不会把面板撑出横向滚动条。'.repeat(3), at: 4 }],
        streamText: '', error: null, canStop: false, updatedAt: 5 };
      await send(payload(long));
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: window.innerWidth }));
      assert.ok(overflow.scroll <= overflow.client + 1, width + ': ' + JSON.stringify(overflow));
      assert.equal(await page.locator('#goal-chat-log .goal-chat-message').count(), 3);
      assert.equal(await page.locator('#goal-chat-input').isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('the main page only routes its header button to the native tab and keeps no inline chat', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState() { return undefined; }, setState() {}, postMessage(message) { window.sent.push(message); return Promise.resolve(undefined); } });
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'goal-chat-main' }) }));
    await page.goto('http://goal-chat-main.test/');
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const dispatch = data => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
    const state = { type: 'state', mode: 'goal', conversation: { id: 'main-session', title: '探索' },
      goal: { objective: '验证探索对话入口', criteria: [], notes: [] }, messages: [],
      provider: { connected: true, label: '测试模型' }, context: {}, busy: false,
      execution: { status: 'idle', busy: false, parts: [], activities: [], workers: [] } };
    await dispatch(state);
    await frames();
    const toggle = page.locator('#goal-chat-toggle');
    assert.equal(await toggle.isVisible(), true);
    assert.equal(await page.locator('#goal-chat').count(), 0, 'the inline aside moved out of the main page');
    assert.equal(await page.locator('#goal-chat-scrim').count(), 0);
    await toggle.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const requested = (await page.evaluate(() => window.sent.slice())).filter(message => message.action === 'openGoalChat');
    assert.equal(requested.length, 1);
    assert.equal(requested[0].sessionId, 'main-session');
    assert.equal(typeof requested[0].requestId, 'string');
    await dispatch({ type: 'uiResult', requestId: requested[0].requestId, ok: true });
    await frames();
    assert.equal(await page.locator('#goal-chat-toggle').isEnabled(), true);

    // Assist mode has no exploration conversation: the entry point disappears.
    await dispatch({ ...state, mode: 'assist', goal: undefined, execution: { status: 'idle', busy: false, parts: [], activities: [], workers: [] } });
    await frames();
    assert.equal(await page.locator('#goal-chat-toggle').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('conversation tabs render the active thread, switch and create through uiResult round-trips', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    const bar = page.locator('#goal-chat-threads');
    // Without threads the whole strip stays hidden so the empty hero is first.
    await send(payload(IDLE));
    assert.equal(await bar.isVisible(), false);
    await send(payload(IDLE, { sessionId: 'goal-a', threads: THREADS }));
    assert.equal(await bar.isVisible(), true);
    assert.equal(await bar.getAttribute('role'), 'tablist');
    const tabs = page.locator('#goal-chat-thread-list .goal-chat-thread');
    assert.equal(await tabs.count(), 2);
    const first = tabs.nth(0), second = tabs.nth(1);
    const firstSelect = first.locator('.goal-chat-thread-select');
    const secondSelect = second.locator('.goal-chat-thread-select');
    assert.equal(await first.getAttribute('data-thread-id'), 'goal-a');
    assert.equal(await first.getAttribute('data-active'), 'true');
    assert.equal(await firstSelect.getAttribute('role'), 'tab');
    assert.equal(await firstSelect.getAttribute('aria-selected'), 'true');
    assert.match(await firstSelect.textContent(), /目标 A/);
    assert.equal(await second.getAttribute('data-thread-id'), 'goal-b');
    assert.equal(await second.getAttribute('data-active'), 'false');
    assert.equal(await secondSelect.getAttribute('aria-selected'), 'false');

    // Clicking the active tab is a no-op; the inactive tab asks the host to switch.
    await firstSelect.click();
    assert.equal((await sent(page)).filter(message => message.action === 'selectGoalChatThread').length, 0);
    await secondSelect.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let switches = (await sent(page)).filter(message => message.action === 'selectGoalChatThread');
    assert.equal(switches.length, 1);
    assert.equal(switches[0].threadId, 'goal-b');
    assert.equal(typeof switches[0].requestId, 'string');
    // A pending switch disables every tab and the new-thread button.
    assert.equal(await firstSelect.isDisabled(), true);
    assert.equal(await secondSelect.isDisabled(), true);
    assert.equal(await page.locator('#goal-chat-thread-new').isDisabled(), true);
    await uiResult(page, switches[0].requestId);
    await send(payload(IDLE, { sessionId: 'goal-b', threads: [{ ...THREADS[0], active: false }, { ...THREADS[1], active: true }] }));
    assert.equal(await tabs.nth(1).getAttribute('data-active'), 'true');
    assert.equal(await tabs.nth(0).getAttribute('data-active'), 'false');
    assert.equal(await tabs.nth(1).locator('.goal-chat-thread-select').getAttribute('aria-selected'), 'true');
    assert.equal(await tabs.nth(0).locator('.goal-chat-thread-select').getAttribute('aria-selected'), 'false');

    await page.locator('#goal-chat-thread-new').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const created = (await sent(page)).filter(message => message.action === 'newGoalChatThread');
    assert.equal(created.length, 1);
    assert.equal(typeof created[0].requestId, 'string');
    await uiResult(page, created[0].requestId);

    // A failed request surfaces inline next to the tab strip.
    await page.locator('#goal-chat-thread-new').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const failing = (await sent(page)).filter(message => message.action === 'newGoalChatThread').at(-1);
    await dispatch(page, { type: 'uiResult', requestId: failing.requestId, ok: false, error: '新建探索对话失败，请重试。' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const threadError = page.locator('#goal-chat-thread-error');
    assert.equal(await threadError.isVisible(), true);
    assert.match(await threadError.textContent(), /新建探索对话失败/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('user messages expose rewind, a running answer disables it and value.text refills the composer', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(COMPLETED, { sessionId: 'goal-a', threads: THREADS }));
    const userRow = page.locator(`.goal-chat-message[data-role="user"][data-message-id="${USER.id}"]`);
    const rewind = userRow.locator('.goal-chat-rewind');
    assert.equal(await rewind.count(), 1);
    assert.equal(await rewind.getAttribute('aria-label'), '撤回这条消息及之后的回答');
    assert.match(await rewind.getAttribute('title'), /放回输入框/);
    assert.equal(await page.locator('.goal-chat-message[data-role="assistant"] .goal-chat-rewind').count(), 0,
      'assistant rows never carry a rewind action');

    await rewind.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const requests = (await sent(page)).filter(message => message.action === 'goalChatRewind');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messageId, USER.id);
    assert.equal(typeof requests[0].requestId, 'string');
    assert.equal(await rewind.isDisabled(), true, 'a request in flight disables rewind');
    await dispatch(page, { type: 'uiResult', requestId: requests[0].requestId, ok: true, value: { text: USER.text } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.locator('#goal-chat-input').inputValue(), USER.text);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ubovm.goalChatDraft:goal-a')), USER.text,
      'the restored text is saved as the session draft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'goal-chat-input', 'rewind returns focus to the composer');

    // The host publishes the trimmed transcript; the page follows without local splicing.
    await send(payload(IDLE, { sessionId: 'goal-a', threads: THREADS }));
    assert.equal(await page.locator('#goal-chat-log .goal-chat-message').count(), 0);

    await send(payload(COMPLETED, { sessionId: 'goal-a', threads: THREADS }));
    const running = { status: 'running', messages: [USER], streamText: '补充回答', error: null, canStop: true, updatedAt: 9 };
    await send(payload(running, { sessionId: 'goal-a', threads: THREADS }));
    assert.equal(await page.locator('.goal-chat-rewind').first().isDisabled(), true, 'running answers block rewind');

    await send(payload(COMPLETED, { sessionId: 'goal-a', threads: THREADS }));
    await page.locator('.goal-chat-rewind').first().click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const failing = (await sent(page)).filter(message => message.action === 'goalChatRewind').at(-1);
    await dispatch(page, { type: 'uiResult', requestId: failing.requestId, ok: false, error: '该消息已不存在，请刷新后重试。' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const localError = page.locator('#goal-chat-error');
    assert.equal(await localError.isVisible(), true);
    assert.match(await localError.textContent(), /该消息已不存在/);
    assert.equal(await page.locator('.goal-chat-rewind').first().isDisabled(), false, 'a failed rewind unlocks the button');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a goal-missing conversation shows the save-goal state and hides the composer', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE, { sessionId: 'goal-draft', goalMissing: true }));
    assert.equal(await page.locator('#goal-chat').getAttribute('data-goal-missing'), 'true');
    const unavailable = page.locator('#goal-chat-unavailable');
    assert.equal(await unavailable.isVisible(), true);
    assert.equal(await unavailable.getAttribute('data-kind'), 'goal-missing');
    assert.match(await unavailable.textContent(), /先在探索工作台保存目标，再开始对话/);
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), false);
    assert.equal(await page.locator('#goal-chat-empty').isVisible(), false);
    assert.equal(await page.locator('#goal-chat-input').isDisabled(), true);

    // Selecting a conversation with a saved goal restores the normal empty state.
    await send(payload(IDLE, { sessionId: 'goal-a', goalMissing: false, threads: THREADS }));
    assert.equal(await page.locator('#goal-chat').getAttribute('data-goal-missing'), 'false');
    assert.equal(await unavailable.isVisible(), false);
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), true);
    assert.equal(await page.locator('.goal-chat-hero-title').isVisible(), true);

    // goalMissing wins over the generic unavailable copy even when both apply.
    await send(payload(IDLE, { sessionId: 'goal-draft', goalMissing: true, available: false }));
    assert.equal(await page.locator('#goal-chat').getAttribute('data-goal-missing'), 'true');
    assert.match(await page.locator('#goal-chat-unavailable').textContent(), /先在探索工作台保存目标/);
    assert.doesNotMatch(await page.locator('#goal-chat-unavailable').textContent(), /仅在探索模式可用/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a narrow sidebar scrolls many conversation tabs without horizontal page overflow', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser, { viewport: { width: 320, height: 760 } });
    const threads = Array.from({ length: 8 }, (_, index) => ({
      id: 'goal-' + index, title: '探索目标 ' + (index + 1) + '：一段足够长以便截断的标题', active: index === 0, draft: ''
    }));
    await send(payload(IDLE, { sessionId: 'goal-0', threads }));
    assert.equal(await page.locator('#goal-chat-thread-list .goal-chat-thread').count(), 8);
    assert.equal(await page.locator('#goal-chat-thread-list .goal-chat-thread[data-active="true"]').count(), 1);
    assert.equal(await page.locator('#goal-chat-thread-list .goal-chat-thread-close').count(), 8);
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: window.innerWidth }));
    assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
    const strip = await page.evaluate(() => {
      const list = document.getElementById('goal-chat-thread-list');
      return { scroll: list.scrollWidth, client: list.clientWidth };
    });
    assert.ok(strip.scroll > strip.client, 'many tabs scroll horizontally inside the strip: ' + JSON.stringify(strip));
    assert.equal(await page.locator('#goal-chat-composer').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('conversation tabs expose a guarded delete button and report failures inline', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE, { sessionId: 'goal-a', threads: THREADS }));
    const wraps = page.locator('#goal-chat-thread-list .goal-chat-thread');
    const closes = page.locator('#goal-chat-thread-list .goal-chat-thread-close');
    assert.equal(await wraps.count(), 2);
    assert.equal(await closes.count(), 2);
    const firstClose = wraps.nth(0).locator('.goal-chat-thread-close');
    const secondClose = wraps.nth(1).locator('.goal-chat-thread-close');
    assert.match(await firstClose.getAttribute('aria-label'), /删除对话.*目标 A/);
    assert.match(await firstClose.getAttribute('title'), /删除/);
    const opacity = locator => locator.evaluate(node => getComputedStyle(node).opacity);
    assert.equal(await opacity(firstClose), '1', 'the active tab shows its close button');
    assert.equal(await opacity(secondClose), '0', 'inactive tabs reveal the close button on hover');
    await wraps.nth(1).hover();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await opacity(secondClose), '1');

    const selectCount = (await sent(page)).filter(message => message.action === 'selectGoalChatThread').length;
    await secondClose.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const deletes = (await sent(page)).filter(message => message.action === 'deleteGoalChatThread');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].threadId, 'goal-b');
    assert.equal(typeof deletes[0].requestId, 'string');
    assert.equal((await sent(page)).filter(message => message.action === 'selectGoalChatThread').length, selectCount,
      'closing a tab must not also select it');
    // In-flight delete disables selects, closes and the new-tab button.
    assert.equal(await wraps.nth(0).locator('.goal-chat-thread-select').isDisabled(), true);
    assert.equal(await firstClose.isDisabled(), true);
    assert.equal(await page.locator('#goal-chat-thread-new').isDisabled(), true);

    await uiResult(page, deletes[0].requestId);
    await send(payload(IDLE, { sessionId: 'goal-a', threads: [{ ...THREADS[0], active: true }] }));
    assert.equal(await wraps.count(), 1);
    const lastClose = wraps.nth(0).locator('.goal-chat-thread-close');
    assert.equal(await lastClose.isDisabled(), true);
    assert.match(await lastClose.getAttribute('title'), /至少保留一个对话/);

    // A rejected delete keeps the tabs and surfaces the error next to the strip.
    await send(payload(IDLE, { sessionId: 'goal-a', threads: THREADS }));
    await wraps.nth(1).hover();
    await wraps.nth(1).locator('.goal-chat-thread-close').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const failing = (await sent(page)).filter(message => message.action === 'deleteGoalChatThread').at(-1);
    await dispatch(page, { type: 'uiResult', requestId: failing.requestId, ok: false, error: '删除探索对话失败，请重试。' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const threadError = page.locator('#goal-chat-thread-error');
    assert.equal(await threadError.isVisible(), true);
    assert.match(await threadError.textContent(), /删除探索对话失败/);
    assert.equal(await wraps.count(), 2, 'a rejected delete keeps every tab');

    // A running answer blocks deleting any tab.
    const running = { status: 'running', messages: [USER], streamText: '正在回答', error: null, canStop: true, updatedAt: 9 };
    await send(payload(running, { sessionId: 'goal-a', threads: THREADS }));
    assert.equal(await page.locator('#goal-chat-thread-list .goal-chat-thread-close').first().isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a running agent turn shows which tool is in flight', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { page, errors, send } = await openPanel(browser);
    await send(payload(IDLE));
    const running = { status: 'running', messages: [USER], streamText: '', activity: 'goal_status', error: null, canStop: true, updatedAt: 9 };
    await send(payload(running));
    const label = page.locator('#goal-chat-log .goal-chat-streaming-label');
    await label.waitFor({ state: 'visible' });
    assert.match(await label.textContent(), /正在调用 goal_status…/);
    const writing = { status: 'running', messages: [USER], streamText: '正在核对…', activity: '', error: null, canStop: true, updatedAt: 10 };
    await send(payload(writing));
    assert.match(await page.locator('#goal-chat-log .goal-chat-streaming-label').textContent(), /正在回答…/);
    await send(payload({ ...COMPLETED, activity: '' }));
    assert.equal(await page.locator('#goal-chat-log .goal-chat-streaming-label').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
