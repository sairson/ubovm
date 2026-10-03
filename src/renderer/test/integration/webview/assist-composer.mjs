import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../../../.cache', import.meta.url));

test('queue sits above the composer without resizing or reflowing Worker cards', async () => {
  for (const viewport of [{ width: 320, height: 760 }, { width: 900, height: 800 }, { width: 600, height: 360 }]) {
    const f = await fixture(viewport);
    try {
      const running = state('queue-layout', { messages: [{ id: 'user', role: 'user', text: '运行任务' }], busy: true,
        execution: { status: 'running', busy: true, workers: Array.from({ length: 6 }, (_, i) => ({ id: `worker-${i}`, name: `Worker ${i}`, status: 'running' })) } });
      await f.emit(running);
      const measure = () => f.page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
        return { workers: rect('#collaboration-workers'), cards: [...document.querySelectorAll('#collaboration-worker-list .worker-card')].map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
          queue: rect('#input-queue'), composer: rect('#prompt-form'),
          dockFade: getComputedStyle(document.getElementById('compose-dock'), '::before').content };
      });
      const before = await measure();
      assert.equal(before.cards.length, 6);
      await f.emit({ ...running, inputQueue: Array.from({ length: 12 }, (_, i) => ({ id: `queued-${i}`, text: `后续任务 ${i} ` + '长内容'.repeat(60) })) });
      const after = await measure();
      assert.deepEqual(after.cards, before.cards);
      assert.equal(after.workers.width, before.workers.width);
      assert.equal(after.workers.height, before.workers.height);
      assert.equal(after.dockFade, 'none', 'composer fade must not overlay the Worker strip');
      assert(after.workers.bottom <= after.queue.y, 'queue cannot overlap the Worker list');
      assert(after.queue.bottom <= after.composer.y, 'queue must be above and outside the input box');
      assert(after.queue.height <= Math.min(140, viewport.height * .18) + 1);
      assert(after.composer.bottom <= viewport.height + 1);
      assert.equal(await f.page.locator('#prompt-form #input-queue').count(), 0);
      if (viewport.width === 900) await f.page.screenshot({ path: `${screenshotDirectory}/queue-above-composer.png` });
      await f.emit(state('empty-chat', { inputQueue: [{ id: 'saved', text: '待发送' }] }));
      assert.equal(await f.page.locator('#composer-home-slot #input-queue').count(), 1);
    } finally { await f.close(); }
  }
});
let browser;
test('outline retains focused entries, ignores stale clicks, and releases old session navigation immediately', async () => {
  const f = await fixture();
  try {
    const messages = [{ id: 'first', role: 'user', text: '第一轮' }, { id: 'answer', role: 'assistant', text: '回复\n\n'.repeat(50) }];
    await f.emit(state('stable-outline', { messages }));
    await f.page.locator('.outline-turn').first().focus();
    await f.page.evaluate(() => { window.oldOutlineButton = document.querySelector('.outline-turn'); });
    await f.emit(state('stable-outline', { messages: [...messages, { id: 'second', role: 'user', text: '第二轮' }] }));
    assert.equal(await f.page.evaluate(() => document.activeElement === window.oldOutlineButton && window.oldOutlineButton === document.querySelector('.outline-turn')), true);
    await f.page.locator('.outline-turn').last().focus();
    await f.emit(state('stable-outline', { messages }));
    assert.equal(await f.page.locator('#outline-toggle').evaluate(el => el === document.activeElement), true);
    await f.page.evaluate(() => {
      dispatchEvent(new MessageEvent('message', { data: { type: 'state', mode: 'goal', conversation: { id: 'next-goal' }, messages: [], execution: {}, context: {}, provider: {} } }));
      window.outlineCountAtSwitch = document.querySelectorAll('.outline-turn').length;
      window.oldOutlineButton.click();
    });
    assert.equal(await f.page.evaluate(() => window.outlineCountAtSwitch), 0);
    await f.frames();
    assert.equal(await f.page.locator('#conversation-outline').isVisible(), false);
    await f.emit(state('new-outline', { messages: [{ id: 'new', role: 'user', text: '新会话' }] }));
    await f.input.fill('保留草稿');
    await f.page.evaluate(() => window.oldOutlineButton.click());
    assert.equal(await f.input.evaluate(el => el === document.activeElement), true);
  } finally { await f.close(); }
});

test('outline creation and partial rendering failures recover without interrupting messages or drafts', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const create = window.createConversationOutline;
      window.createConversationOutline = (...args) => { window.createConversationOutline = create; throw Error('模拟骨架初始化失败'); };
    });
    const messages = [{ id: 'one', role: 'user', text: '第一轮' }];
    await f.emit(state('outline-retry', { messages }));
    assert.equal(await f.page.locator('#messages .message.user').count(), 1);
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), true);
    await f.input.fill('尚未发送的草稿');
    await f.page.locator('#ui-render-retry').click(); await f.frames();
    assert.equal(await f.page.locator('.outline-turn').count(), 1);
    await f.page.evaluate(() => {
      const list = document.getElementById('outline-list'), insert = list.insertBefore;
      list.insertBefore = function (...args) { this.insertBefore = insert; throw Error('模拟增量插入失败'); };
    });
    await f.emit(state('outline-retry', { messages: [...messages, { id: 'two', role: 'user', text: '第二轮' }] }));
    assert.equal(await f.page.locator('#messages .message.user').count(), 2);
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), true);
    await f.page.locator('#ui-render-retry').click(); await f.frames();
    assert.equal(await f.page.locator('.outline-turn').count(), 2);
    assert.equal(await f.input.inputValue(), '尚未发送的草稿');
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), false);
    await f.page.evaluate(() => {
      const scroller = document.getElementById('conversation'), measure = scroller.getBoundingClientRect;
      scroller.getBoundingClientRect = function () { this.getBoundingClientRect = measure; throw Error('模拟异步测量失败'); };
      scroller.dispatchEvent(new Event('scroll'));
    });
    await f.frames();
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), true);
    await f.page.locator('#ui-render-retry').click(); await f.frames();
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), false);
    assert.equal(await f.page.locator('.outline-turn[aria-current]').count(), 1);
  } finally { await f.close(); }
});

test('outline suspends observers and deferred work, resumes once and disposes permanently', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const create = window.createConversationOutline;
      window.createConversationOutline = options => {
        const NativeObserver = window.ResizeObserver;
        window.outlineObserved = new Set();
        window.ResizeObserver = class {
          constructor(callback) { this.inner = new NativeObserver(callback); }
          observe(el) { window.outlineObserved.add(el); this.inner.observe(el); }
          disconnect() { window.outlineObserved.clear(); this.inner.disconnect(); }
        };
        try { return window.testOutline = create(options); } finally { window.ResizeObserver = NativeObserver; }
      };
    });
    await f.emit(state('outline-life', { messages: [{ id: 'one', role: 'user', text: '第一轮' }] }));
    const counts = await f.page.evaluate(() => {
      const counts = [window.outlineObserved.size];
      dispatchEvent(new Event('pagehide')); counts.push(window.outlineObserved.size);
      dispatchEvent(new Event('pageshow')); dispatchEvent(new Event('pageshow')); counts.push(window.outlineObserved.size);
      dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: true } })); counts.push(window.outlineObserved.size);
      dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: false } })); counts.push(window.outlineObserved.size);
      window.testOutline.dispose(); window.testOutline.dispose(); counts.push(window.outlineObserved.size);
      dispatchEvent(new Event('pageshow'));
      window.testOutline.update([{ role: 'user', text: '不可恢复', article: document.querySelector('.message.user') }], 'late');
      counts.push(window.outlineObserved.size);
      return counts;
    });
    assert.deepEqual(counts, [2, 0, 2, 0, 2, 0, 0]);
    assert.equal(await f.page.locator('.outline-turn').count(), 0);
  } finally { await f.close(); }
});

test('conversation outline navigates published turns and resets with history and sessions', async () => {
  const f = await fixture();
  try {
    await f.emit(state());
    const outline = f.page.locator('#conversation-outline');
    assert.equal(await outline.isVisible(), false);
    const messages = Array.from({ length: 16 }, (_, index) => ({ id: `outline-${index}`, role: index % 2 ? 'assistant' : 'user', text: index % 2 ? '回复内容\n\n'.repeat(30) : `检查任务 ${index / 2 + 1} <script>示例</script>` }));
    await f.emit(state('outline-a', { messages, inputQueue: [{ id: 'queued', text: '尚未发送' }] }));
    assert.equal(await outline.locator('.outline-turn').count(), 8);
    await f.page.locator('#outline-toggle').click();
    await outline.locator('.outline-turn').first().click();
    await f.frames();
    assert.equal(await outline.locator('.outline-turn').first().getAttribute('aria-current'), 'location');
    assert(await f.page.locator('#conversation').evaluate(el => el.scrollTop) < 60);
    assert.equal(await f.page.locator('#messages script').count(), 0);
    const before = await f.page.locator('#conversation').evaluate(el => el.scrollTop);
    await f.emit(state('outline-a', { messages, busy: true, execution: { status: 'running', busy: true, streamText: '继续回复' } }));
    assert.equal(await f.page.locator('#conversation').evaluate(el => el.scrollTop), before);
    await f.emit(state('outline-a', { messages: messages.slice(0, 4) }));
    assert.equal(await outline.locator('.outline-turn').count(), 2);
    await f.page.setViewportSize({ width: 320, height: 760 });
    const bounds = await outline.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    await f.page.setViewportSize({ width: 900, height: 800 });
    await f.emit(state('outline-a', { messages }));
    await f.page.screenshot({ path: `${screenshotDirectory}/conversation-outline.png` });
    await f.emit(state('outline-b'));
    assert.equal(await outline.isVisible(), false);
    assert.equal(await outline.locator('.outline-turn').count(), 0);
    assert.equal(await f.page.locator('#outline-toggle').getAttribute('aria-expanded'), 'false');
  } finally { await f.close(); }
});

test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

function state(id = 'composer-a', overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id, title: '输入体验回归' }, messages: [], goal: null,
    context: { workspace: 'UBOVM', file: '', fileSource: null },
    provider: { configured: true, connected: true, label: '测试模型' },
    busy: false, execution: { status: 'idle', busy: false, streamText: '', activities: [], canResume: false },
    ...overrides
  };
}

async function fixture(viewport = { width: 900, height: 800 }) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.savedDrafts = {};
    window.acquireVsCodeApi = () => ({
      getState: () => window.savedDrafts,
      setState: value => { window.savedDrafts = value; },
      postMessage: value => window.hostMessages.push(value)
    });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'assist-composer-test' });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://assist-composer.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
    await frames();
  };
  const sent = action => page.evaluate(action => window.hostMessages.filter(message => message.action === action), action);
  const ack = (message, ok = true) => emit({ type: 'uiResult', requestId: message.requestId, ok, ...(ok ? {} : { error: '测试请求失败，保留草稿' }) });
  const input = page.locator('#prompt-input');
  const fill = async text => { await input.fill(text); await frames(); };
  const close = async () => { assert.deepEqual(errors, [], 'the composer must not generate browser exceptions'); await page.close(); };
  return { page, input, emit, frames, sent, ack, fill, close };
}

test('composer chrome keeps a fade into the dock and a product send control', async () => {
  const f = await fixture();
  try {
    await f.emit(state('fade-chrome', { messages: [{ id: 'hello', role: 'user', text: '你好' }] }));
    const chrome = await f.page.evaluate(() => {
      const fade = getComputedStyle(document.querySelector('.conversation-region'), '::after');
      const dockFade = getComputedStyle(document.getElementById('compose-dock'), '::before');
      const form = getComputedStyle(document.getElementById('prompt-form'));
      const send = getComputedStyle(document.getElementById('submit-prompt'));
      return { fade: fade.height, dockFade: dockFade.content, radius: form.borderRadius, sendFill: send.backgroundColor };
    });
    assert.equal(chrome.fade, '28px');
    assert.equal(chrome.dockFade, 'none');
    assert.equal(chrome.radius, '14px');
    assert.notEqual(chrome.sendFill, 'rgba(0, 0, 0, 0)');
  } finally { await f.close(); }
});

test('queued input steering targets the current session and leaves the composer draft intact', async () => {
  const f = await fixture();
  try {
    const queued = { inputQueue: [{ id: 'direction', text: '先检查取消逻辑' }] };
    await f.emit(state('steering-chat', queued));
    const button = f.page.getByRole('button', { name: '引导当前任务', exact: true });
    assert.equal(await button.isDisabled(), true);
    await f.emit(state('steering-chat', { ...queued, busy: true, execution: { status: 'running', busy: true, canSteer: true, runId: 'run-one' } }));
    await f.fill('保留的草稿');
    await button.click();
    const request = (await f.sent('steerInput')).at(-1);
    assert.equal(request.inputId, 'direction');
    assert.equal(request.runId, 'run-one');
    assert.equal(request.sessionId, 'steering-chat');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await f.input.inputValue(), '保留的草稿');
    await f.ack(request);
    await f.emit(state('steering-chat', { busy: true, execution: { status: 'running', busy: true, canSteer: true, runId: 'run-one' } }));
    assert.equal(await f.page.locator('#input-queue').isVisible(), false);
    assert.equal(await f.input.getAttribute('placeholder'), '补充说明将立刻调整当前任务…');
    assert.equal((await f.page.locator('#composer-status').textContent()).trim(), '执行中 · Enter 立刻引导');
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('data-action-mode'), 'steer');
    await f.emit(state('steering-chat', { inputQueue: [{ id: 'unknown', text: '待核实方向', delivery: 'uncertain' }], queuePaused: true }));
    assert.equal(await button.textContent(), '送达待确认');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await f.page.getByRole('button', { name: '继续发送队列', exact: true }).isDisabled(), true);
    assert.equal(await f.page.getByRole('button', { name: '取回编辑', exact: true }).isEnabled(), true);
  } finally { await f.close(); }
});

test('steering messages retain identity and update delivery badges without replacing their text', async () => {
  for (const width of [320, 900]) {
    const f = await fixture({ width, height: 800 });
    try {
      const history = [
        { id: 'task', role: 'user', text: '检查项目中的队列和消息展示。' },
        { id: 'progress', role: 'assistant', text: '已检查队列逻辑，接下来调整消息展示。' },
        { id: 'direction', role: 'user', text: '先保留已有历史，再优化引导消息的展示。\n不要改变正在执行的任务目标。', steeringStatus: 'sending' }
      ];
      await f.emit(state('steering-display', { messages: history }));
      const message = f.page.locator('.steering-message');
      assert.equal(await message.count(), 1);
      assert.equal(await message.locator('.message-heading').isVisible(), true);
      assert.match(await f.page.locator('.outline-turn').last().getAttribute('aria-label'), /引导/);
      await f.page.evaluate(() => { window.steeringBody = document.querySelector('.steering-message .message-text'); });
      for (const status of ['uncertain', 'accepted']) {
        await f.emit(state('steering-display', { messages: history.map(item => item.id === 'direction' ? { ...item, steeringStatus: status } : item) }));
        assert.equal(await message.locator('.message-steering-status').textContent(), status === 'accepted' ? '已送达' : '送达待确认');
        assert.equal(await f.page.evaluate(() => window.steeringBody === document.querySelector('.steering-message .message-text')), true);
      }
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (width === 900) await f.page.screenshot({ path: `${screenshotDirectory}/steering-messages.png` });
      await f.emit(state('steering-display', { messages: history.map(item => item.id === 'direction' ? { ...item, steeringStatus: 'uncertain' } : item) }));
      assert.match(await message.locator('.message-steering-hint').textContent(), /核实执行结果/);
      if (width === 320) {
        await f.page.evaluate(() => { document.body.classList.add('vscode-dark'); });
        await f.page.screenshot({ path: `${screenshotDirectory}/steering-uncertain-narrow.png` });
      }
      await f.emit(state('other-chat'));
      assert.equal(await f.page.locator('.steering-message').count(), 0);
    } finally { await f.close(); }
  }
});

test('queue refresh retains scroll and restores a disabled action after acknowledgement', async () => {
  const f = await fixture();
  try {
    const inputQueue = Array.from({ length: 15 }, (_, index) => ({ id: `queue-${index}`, text: `待处理输入 ${index}` }));
    const running = state('queue-focus', { inputQueue, busy: true, execution: { status: 'running', busy: true, canSteer: true, runId: 'one' } });
    await f.emit(running);
    await f.page.evaluate(() => {
      window.retainedQueueText = document.querySelector('[data-input-id="queue-12"] .input-queue-text');
      const range = document.createRange(); range.selectNodeContents(window.retainedQueueText);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await f.emit({ ...running, queuePaused: true });
    assert.equal(await f.page.evaluate(() => window.retainedQueueText === document.querySelector('[data-input-id="queue-12"] .input-queue-text')), true);
    assert.equal(await f.page.evaluate(() => getSelection().toString()), '待处理输入 12');
    const target = f.page.locator('[data-input-id="queue-12"] [data-queue-action="steer"]');
    await target.focus();
    const before = await f.page.locator('.input-queue-list').evaluate(node => node.scrollTop);
    assert(before > 0);
    await target.click();
    const request = (await f.sent('steerInput')).at(-1);
    assert.equal(await f.page.evaluate(() => document.activeElement.dataset.inputId), 'queue-12');
    await f.ack(request, false);
    assert.equal(await target.evaluate(node => node === document.activeElement), true);
    const after = await f.page.locator('.input-queue-list').evaluate(node => node.scrollTop);
    assert(Math.abs(before - after) < 2);
    await f.emit(state('different-queue', { inputQueue }));
    assert.equal(await f.page.locator('.input-queue-list').evaluate(node => node.scrollTop), 0);
  } finally { await f.close(); }
});

test('queue full-text preview is keyboard accessible, read-only and isolated across sessions', async () => {
  for (const width of [320, 900]) {
    const f = await fixture({ width, height: 600 });
    try {
      const text = '<script>window.previewExecuted = true</script>\n' + '完整内容 👋 中文\n'.repeat(300);
      const queued = [{ id: 'long-input', text }];
      await f.emit(state('preview-a', { inputQueue: queued }));
      await f.fill('草稿保持原样');
      const trigger = f.page.getByRole('button', { name: '查看第 1 条完整输入', exact: true });
      await trigger.focus(); await f.page.keyboard.press('Enter');
      const dialog = f.page.locator('#queue-preview');
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await dialog.locator('.queue-preview-content').textContent(), text);
      assert.equal(await f.page.evaluate(() => window.previewExecuted), undefined);
      await f.emit(state('preview-a', { inputQueue: queued, busy: true, execution: { status: 'running', busy: true, canSteer: true, runId: 'one' } }));
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await f.input.inputValue(), '草稿保持原样');
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 600);
      if (width === 900) await f.page.screenshot({ path: `${screenshotDirectory}/queue-full-preview.png` });
      await f.page.keyboard.press('Escape'); await f.frames();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      await trigger.click();
      await f.emit(state('preview-a', { inputQueue: [] })); await f.frames();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await f.input.evaluate(node => node === document.activeElement), true);
      await f.emit(state('preview-a', { inputQueue: queued })); await trigger.click();
      await f.emit(state('preview-b', { inputQueue: queued })); await f.frames();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await dialog.locator('.queue-preview-content').textContent(), '');
      assert.equal((await f.sent('prompt')).length, 0); assert.equal((await f.sent('steerInput')).length, 0); assert.equal((await f.sent('removeInput')).length, 0);
    } finally { await f.close(); }
  }
});

test('queue actions lock immediately during stop and reject retained callbacks and rapid double clicks', async () => {
  const f = await fixture();
  try {
    await f.emit(state('guarded-queue', { inputQueue: [{ id: 'direction', text: '调整方向' }], busy: true,
      execution: { status: 'running', busy: true, canSteer: true, runId: 'one' } }));
    await f.page.evaluate(() => { window.oldQueueActions = [...document.querySelectorAll('.input-queue-actions button')].map(button => button.onclick); });
    await f.page.getByRole('button', { name: '停止执行', exact: true }).click();
    assert.equal(await f.page.getByRole('button', { name: '引导当前任务', exact: true }).isDisabled(), true);
    assert.equal(await f.page.getByRole('button', { name: '取回编辑', exact: true }).isDisabled(), true);
    assert.match(await f.page.locator('.input-queue-status').textContent(), /正在停止/);
    await f.page.evaluate(() => window.oldQueueActions.forEach(callback => callback()));
    assert.equal((await f.sent('steerInput')).length, 0); assert.equal((await f.sent('removeInput')).length, 0);
    await f.page.getByRole('button', { name: '查看第 1 条完整输入', exact: true }).click();
    assert.equal(await f.page.locator('#queue-preview').isVisible(), true);
    await f.page.keyboard.press('Escape');
    await f.ack((await f.sent('cancelRun')).at(-1), false);
    await f.page.evaluate(() => {
      const button = document.querySelector('[data-queue-action="steer"]');
      const callback = button.onclick;
      button.click(); callback(); button.click();
    });
    assert.equal((await f.sent('steerInput')).length, 1);
    assert.match(await f.page.locator('#operation-loading').textContent(), /正在发送引导/);
    await f.ack((await f.sent('steerInput')).at(-1), false);
    assert.equal(await f.page.getByRole('button', { name: '引导当前任务', exact: true }).isEnabled(), true);
  } finally { await f.close(); }
});

test('stale queue actions cannot affect another session even when it has the same input id', async () => {
  const f = await fixture();
  try {
    const queued = { inputQueue: [{ id: 'same-id', text: '第一会话的内容' }], queuePaused: true };
    await f.emit(state('queue-owner-a', queued));
    await f.page.evaluate(() => { window.staleQueueActions = [...document.querySelectorAll('.input-queue-actions button, .input-queue-resume')].map(button => button.onclick); });
    await f.emit(state('queue-owner-b', { ...queued, inputQueue: [{ id: 'same-id', text: '另一个会话' }] }));
    await f.fill('保留草稿');
    await f.page.evaluate(() => window.staleQueueActions.forEach(callback => callback()));
    assert.equal((await f.sent('removeInput')).length, 0); assert.equal((await f.sent('resumeInputs')).length, 0);
    assert.equal(await f.input.inputValue(), '保留草稿');
  } finally { await f.close(); }
});

test('rewind serializes with queue changes and stop, then preserves drafts on failure and retry', async () => {
  const f = await fixture();
  try {
    const snapshot = state('rewind-lock', { messages: [{ id: 'original', role: 'user', text: '原始任务' }],
      inputQueue: [{ id: 'direction', text: '调整方向' }], busy: true,
      execution: { status: 'running', busy: true, canSteer: true, runId: 'one' } });
    await f.emit(snapshot);
    const rewind = f.page.locator('.message-rewind');
    for (const [label, action] of [['引导当前任务', 'steerInput'], ['取回编辑', 'removeInput'], ['停止执行', 'cancelRun']]) {
      await f.page.evaluate(() => { window.retainedRewind = document.querySelector('.message-rewind').onclick; });
      await f.page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await rewind.isDisabled(), true, action);
      await f.page.evaluate(() => window.retainedRewind());
      assert.equal((await f.sent('rewindInput')).length, 0, action);
      await f.ack((await f.sent(action)).at(-1), false);
      assert.equal(await rewind.isEnabled(), true);
    }
    await f.fill('保留草稿');
    await f.page.evaluate(() => {
      const button = document.querySelector('.message-rewind'), callback = button.onclick;
      button.click(); callback(); button.click();
    });
    assert.equal((await f.sent('rewindInput')).length, 1);
    assert.equal(await f.page.getByRole('button', { name: '取回编辑', exact: true }).isDisabled(), true);
    await f.ack((await f.sent('rewindInput')).at(-1), false);
    assert.equal(await f.input.inputValue(), '保留草稿');
    await rewind.click();
    await f.fill('等待期间写下的新草稿');
    await f.ack((await f.sent('rewindInput')).at(-1));
    assert.equal(await f.input.inputValue(), '原始任务\n\n等待期间写下的新草稿');
    await f.emit({ ...snapshot, recovering: true });
    assert.equal(await rewind.isDisabled(), true, 'recovery cannot rewind incomplete history');
  } finally { await f.close(); }
});

test('rewind ignores callbacks for replaced content, removed messages and other sessions', async () => {
  const f = await fixture();
  try {
    const snapshot = state('rewind-owner', { messages: [{ id: 'same', role: 'user', text: '旧内容' }] });
    await f.emit(snapshot);
    await f.page.evaluate(() => { window.oldRewind = document.querySelector('.message-rewind').onclick; });
    await f.emit({ ...snapshot, messages: [{ id: 'same', role: 'user', text: '更新内容' }] });
    await f.page.evaluate(() => window.oldRewind());
    assert.equal((await f.sent('rewindInput')).length, 0);
    await f.page.evaluate(() => { window.removedRewind = document.querySelector('.message-rewind').onclick; });
    await f.emit({ ...snapshot, messages: [] });
    await f.page.evaluate(() => window.removedRewind());
    assert.equal((await f.sent('rewindInput')).length, 0);
    await f.emit(snapshot);
    await f.page.evaluate(() => { window.otherRewind = document.querySelector('.message-rewind').onclick; });
    await f.emit(state('rewind-other', { messages: snapshot.messages }));
    await f.fill('另一会话的草稿');
    await f.page.evaluate(() => window.otherRewind());
    assert.equal((await f.sent('rewindInput')).length, 0);
    assert.equal(await f.input.inputValue(), '另一会话的草稿');
    await f.page.locator('.message-rewind').click();
    assert.equal((await f.sent('rewindInput')).at(-1).sessionId, 'rewind-other');
  } finally { await f.close(); }
});

test('published interrupted output stays visible exactly once after the next run clears live parts', async () => {
  const f = await fixture();
  try {
    const parts = [{ id: 'interrupted-text', type: 'text', text: '已完成的调查不会消失', status: 'completed' }];
    const history = [{ id: 'question', role: 'user', text: '检查问题' }, { id: 'assist:stopped', role: 'assistant', text: '已完成的调查不会消失', parts }];
    await f.emit(state('history-retention', { messages: history, execution: { status: 'interrupted', busy: false, parts } }));
    assert.equal(await f.page.locator('#messages').getByText('已完成的调查不会消失', { exact: true }).count(), 1);
    await f.emit(state('history-retention', { messages: [...history, { id: 'continue', role: 'user', text: '继续' }], busy: true,
      execution: { status: 'running', busy: true, parts: [], streamText: '' } }));
    assert.equal(await f.page.locator('#messages').getByText('已完成的调查不会消失', { exact: true }).count(), 1);
  } finally { await f.close(); }
});

test('queued inputs can be recalled without overwriting a newer draft, and rewind stays scoped to its session', async () => {
  const f = await fixture();
  try {
    await f.emit(state('composer-a', { messages: [{ id: 'user-one', role: 'user', text: '原始任务' }],
      inputQueue: [{ id: 'queued-one', text: '排队任务' }], queuePaused: true }));
    assert.equal(await f.page.locator('#input-queue').isVisible(), true);
    const rewindButton = f.page.getByRole('button', { name: '回退到此消息', exact: true });
    assert.equal(await rewindButton.textContent(), '');
    await rewindButton.focus();
    assert.equal(await rewindButton.evaluate(element => getComputedStyle(element).opacity), '1');
    await f.page.screenshot({ path: `${screenshotDirectory}/assist-queue-rewind.png` });
    await f.fill('新的草稿');
    await f.page.getByRole('button', { name: '取回编辑', exact: true }).click();
    const remove = (await f.sent('removeInput')).at(-1);
    assert.equal(remove.inputId, 'queued-one');
    await f.ack(remove);
    assert.equal(await f.input.inputValue(), '排队任务\n\n新的草稿');
    await f.page.locator('.message-rewind').click();
    const rewind = (await f.sent('rewindInput')).at(-1);
    assert.equal(rewind.messageId, 'user-one');
    assert.equal(await rewindButton.isDisabled(), true);
    await f.emit(state('composer-b')); await f.fill('另一个会话');
    await f.ack(rewind);
    assert.equal(await f.input.inputValue(), '另一个会话');
    await f.emit(state('composer-a'));
    assert.equal(await f.input.inputValue(), '原始任务\n\n排队任务\n\n新的草稿');
  } finally { await f.close(); }
});

test('selected code context shows its range, preserves drafts and can be removed in either mode', async () => {
  const f = await fixture();
  try {
    await f.emit(state()); await f.fill('解释这段代码');
    const context = { workspace: 'UBOVM', file: 'src/component.ts', fileSource: 'selection', selectionLabel: 'L3–7' };
    await f.emit(state('composer-a', { context }));
    assert.equal(await f.page.locator('#context-label').textContent(), 'component.ts · L3–7');
    assert.match(await f.page.locator('#composer-file').getAttribute('title'), /添加时的快照/);
    assert.equal(await f.input.inputValue(), '解释这段代码');
    assert.equal((await f.sent('prompt')).length, 0);
    await f.page.locator('#remove-context').click();
    await f.ack((await f.sent('clearFileContext')).at(-1));
    await f.emit(state('composer-a', { mode: 'goal', context }));
    assert.equal(await f.page.locator('#goal-selection-context').isVisible(), true);
    assert.equal(await f.page.locator('#goal-selection-label').textContent(), 'component.ts · L3–7');
    await f.page.locator('#goal-selection-context button').click();
    assert.equal((await f.sent('clearFileContext')).at(-1).sessionId, 'composer-a');
  } finally { await f.close(); }
});

test('deleted conversation drafts are removed from persisted webview state without erasing remaining drafts', async () => {
  const f = await fixture();
  try {
    await f.emit(state('keep', { conversationIds: ['keep', 'deleted'] })); await f.fill('保留草稿');
    await f.emit(state('deleted', { conversationIds: ['keep', 'deleted'] })); await f.fill('删除草稿');
    await f.emit(state('keep', { conversationIds: ['keep'] }));
    assert.equal(await f.input.inputValue(), '保留草稿');
    const drafts = await f.page.evaluate(() => window.savedDrafts.drafts);
    assert.equal(drafts.deleted, undefined); assert.equal(drafts.keep.assist, '保留草稿');
    await f.emit(state('blank', { conversationIds: ['blank'] }));
    assert.equal(await f.input.inputValue(), '');
    assert.deepEqual(await f.page.evaluate(() => Object.keys(window.savedDrafts.drafts)), ['blank']);
  } finally { await f.close(); }
});

test('assist input grows, shrinks, limits long text, and respects IME and keyboard submission', async () => {
  const f = await fixture();
  try {
    await f.emit(state());
    const submit = f.page.locator('#submit-prompt');
    assert.equal(await submit.isDisabled(), true);
    await f.fill('  \n  ');
    assert.equal(await submit.isDisabled(), true, 'whitespace alone cannot be submitted');
    await f.fill('检查输入体验');
    const oneLine = await f.input.evaluate(element => element.getBoundingClientRect().height);
    await f.fill('保留每一行的上下文\n'.repeat(5));
    const severalLines = await f.input.evaluate(element => element.getBoundingClientRect().height);
    assert(severalLines > oneLine, 'the textarea grows with several lines');
    await f.fill('继续逐行解释实现\n'.repeat(90));
    const longInput = await f.input.evaluate(element => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    assert(longInput.height >= severalLines && longInput.height < 800 / 2, 'long drafts have a bounded height');
    assert(longInput.scrollHeight > longInput.clientHeight, 'overflow scrolls inside the textarea');
    await f.fill('短草稿');
    assert(Math.abs(await f.input.evaluate(element => element.getBoundingClientRect().height) - oneLine) < 2, 'deleting long content restores compact height');

    const maximum = Number(await f.input.getAttribute('maxlength'));
    assert(maximum > 0);
    await f.fill('字'.repeat(maximum));
    await f.input.press('End');
    await f.input.press('x');
    assert.equal((await f.input.inputValue()).length, maximum, 'typing cannot exceed the supported draft length');
    assert.equal(await f.page.locator('#prompt-count').isVisible(), true, 'the limit is visible near the maximum');
    assert((await f.page.locator('#prompt-count').textContent()).replace(/[,\s]/g, '').includes(String(maximum)));

    await f.fill('中文输入');
    await f.input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      const confirmation = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      element.dispatchEvent(confirmation);
      window.imeConfirmationPrevented = confirmation.defaultPrevented;
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    });
    assert.equal((await f.sent('prompt')).length, 0, 'IME confirmation must not send a prompt');
    assert.equal(await f.page.evaluate(() => window.imeConfirmationPrevented), false, 'IME confirmation must remain available to the input method');
    await f.input.press('End');
    await f.input.press('Shift+Enter');
    assert((await f.input.inputValue()).includes('\n'), 'Shift+Enter creates a real newline');
    assert.equal((await f.sent('prompt')).length, 0);
    await f.fill('  单次提交  ');
    await f.input.press('Enter');
    await f.input.press('Enter');
    await f.page.locator('#prompt-form').evaluate(element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const submitted = await f.sent('prompt');
    assert.equal(submitted.length, 1, 'Enter and form submit share the pending request guard');
    assert.equal(submitted[0].text, '单次提交');
    assert.equal(submitted[0].sessionId, 'composer-a');
    assert(submitted[0].requestId);
    await f.ack(submitted[0], false);
    assert.equal(await f.input.inputValue(), '  单次提交  ', 'failed requests retain the exact original draft');
    assert.equal(await f.page.locator('#ui-error').isVisible(), true);
    assert.equal(await submit.isEnabled(), true);
    await f.input.press('Enter');
    await f.ack((await f.sent('prompt')).at(-1));
    assert.equal(await f.input.inputValue(), '', 'successful requests clear an unchanged submitted draft');
  } finally { await f.close(); }
});

test('busy assist runs queue inputs while acknowledgments and session changes preserve ownership', async () => {
  const f = await fixture();
  try {
    const a = state();
    const running = state('composer-a', {
      messages: [{ role: 'user', text: '已提交的请求' }], busy: true,
      execution: { status: 'running', busy: true, streamText: '正在分析', activities: [] }
    });
    await f.emit(a);
    await f.fill('已提交的请求');
    assert.equal(await f.input.getAttribute('placeholder'), '提问、规划，或描述你想完成的改动…');
    await f.input.press('Enter');
    const firstRequest = (await f.sent('prompt')).at(-1);
    await f.emit(running);
    assert.equal(await f.input.isEnabled(), true, 'the next assist draft stays editable during execution');
    assert.equal(await f.input.getAttribute('placeholder'), '补充说明或下一条消息，发送后排队…');
    assert.equal((await f.page.locator('#composer-status').textContent()).trim(), '执行中 · Enter 排队');
    await f.fill('下一条草稿，不应被旧请求清空');
    await f.ack(firstRequest);
    assert.equal(await f.input.inputValue(), '下一条草稿，不应被旧请求清空');
    const before = { prompts: (await f.sent('prompt')).length, stops: (await f.sent('cancelRun')).length };
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, before.prompts + 1, 'Enter during execution queues the next input');
    await f.ack((await f.sent('prompt')).at(-1), false);
    assert.equal((await f.sent('cancelRun')).length, before.stops, 'Enter while composing never stops a run');
    assert((await f.page.locator('#composer-status').textContent()).trim(), 'the busy composer explains its current state');

    await f.input.evaluate(element => { element.focus(); element.setSelectionRange(3, 8); window.composerNode = element; });
    for (let index = 0; index < 12; index++) {
      const execution = { ...running.execution, streamText: '流式输出 '.repeat(index + 1) };
      await f.emit(index % 2 ? { type: 'executionState', conversationId: 'composer-a', execution, busy: true } : { ...running, execution });
    }
    assert.deepEqual(await f.input.evaluate(element => ({ same: window.composerNode === element, focus: document.activeElement === element, selection: [element.selectionStart, element.selectionEnd], value: element.value })), {
      same: true, focus: true, selection: [3, 8], value: '下一条草稿，不应被旧请求清空'
    }, 'stream updates must retain the input node, focus, selection and value');
    assert.equal(await f.page.locator('#queue-prompt').count(), 0);
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('data-action-mode'), 'queue');
    await f.page.locator('#submit-prompt').click();
    const queued = (await f.sent('prompt')).at(-1);
    assert.equal(queued.text, '下一条草稿，不应被旧请求清空');
    assert.equal((await f.sent('cancelRun')).length, before.stops);
    await f.ack(queued, false);
    await f.fill('');
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('data-action-mode'), 'stop');
    await f.page.locator('#submit-prompt').click();
    const stop = (await f.sent('cancelRun')).at(-1);
    assert(stop?.requestId, 'the explicit stop control sends a tracked stop action');
    assert.equal(await f.page.locator('#submit-prompt').isDisabled(), true, 'a pending stop cannot be repeated');
    await f.ack(stop);
    await f.fill('下一条草稿，不应被旧请求清空');
    await f.emit({ ...running, busy: false, execution: { status: 'interrupted', busy: false, canResume: false } });
    assert.equal(await f.page.locator('#submit-prompt').isEnabled(), true);
    assert.equal(await f.input.inputValue(), '下一条草稿，不应被旧请求清空');
    await f.input.press('Enter');
    const delayedRequest = (await f.sent('prompt')).at(-1);
    const b = state('composer-b');
    await f.emit(b);
    assert.equal(await f.input.inputValue(), '', 'a new session begins with its own draft');
    await f.fill('会话 B 的草稿');
    await f.emit({ type: 'executionState', conversationId: 'composer-a', execution: running.execution, busy: true });
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('data-running'), 'false', 'old-session stream events cannot change the current composer state');
    await f.ack(delayedRequest);
    assert.equal(await f.input.inputValue(), '会话 B 的草稿', 'a previous session acknowledgment cannot clear the current draft');
    await f.emit(a);
    assert.equal(await f.input.inputValue(), '', 'the successful acknowledgment clears the owning session draft');
    await f.fill('会话 A 的后续草稿');
    await f.emit(b);
    assert.equal(await f.input.inputValue(), '会话 B 的草稿');
    await f.emit(a);
    assert.equal(await f.input.inputValue(), '会话 A 的后续草稿');

    await f.emit(state('goal-c', { mode: 'goal', goal: { objective: '保留探索模式行为', criteria: [], notes: [] }, busy: true, execution: { status: 'running', busy: true } }));
    assert.equal(await f.page.locator('#goal-objective-input').isDisabled(), true, 'goal mode retains its execution-time edit guard');
  } finally { await f.close(); }
});

test('context chips and model labels reflect host state with scoped, acknowledged file changes', async () => {
  const f = await fixture();
  try {
    await f.emit(state());
    const chip = f.page.locator('#composer-file');
    assert.equal(await chip.isVisible(), false, 'an absent file has no placeholder attachment chip');
    assert.equal(await f.page.locator('#provider-label').textContent(), '测试模型');
    await f.fill('携带所选文件的下一条请求');
    await f.page.locator('#attach-file').click();
    const attachedRequest = (await f.sent('attachFile')).at(-1);
    assert(attachedRequest?.requestId, 'file selection must have an acknowledgment id');
    assert.equal(attachedRequest.sessionId, 'composer-a');
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, 0, 'a pending file picker cannot race prompt submission');
    assert.equal(await f.input.isEnabled(), true, 'choosing context does not lock draft editing');
    await f.ack(attachedRequest);
    const attached = state('composer-a', { context: { workspace: 'UBOVM', file: 'C:\\project\\src\\组件.tsx', fileSource: 'attached' } });
    await f.emit(attached);
    assert.equal(await chip.isVisible(), true);
    assert.equal(await f.page.locator('#context-label').textContent(), '组件.tsx');
    assert.equal(await chip.getAttribute('data-source'), 'attached');
    const explicitSource = (await chip.getAttribute('title')).replace(attached.context.file, '').trim();
    await f.page.locator('#remove-context').click();
    const clearRequest = (await f.sent('clearFileContext')).at(-1);
    assert(clearRequest?.requestId);
    assert.equal(clearRequest.sessionId, 'composer-a');
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, 0, 'a pending clear cannot submit stale file context');
    await f.ack(clearRequest, false);
    assert.equal(await chip.isVisible(), true, 'a failed clear retains the known host attachment');
    await f.page.locator('#remove-context').click();
    await f.ack((await f.sent('clearFileContext')).at(-1));
    await f.emit(state());
    assert.equal(await chip.isVisible(), false);
    await f.emit(state('composer-a', { context: { workspace: 'UBOVM', file: 'C:\\project\\active.ts', fileSource: 'active' } }));
    assert.equal(await chip.isVisible(), true);
    assert.equal(await f.page.locator('#context-label').textContent(), 'active.ts');
    assert.equal(await chip.getAttribute('data-source'), 'active');
    const activeSource = (await chip.getAttribute('title')).replace('C:\\project\\active.ts', '').trim();
    assert.notEqual(activeSource, explicitSource, 'active editor context and explicit file attachment are distinguishable');
    await f.emit(state('composer-b', { provider: { connected: false, configured: false, label: '等待配置模型', error: '连接尚未配置' } }));
    assert.equal(await chip.isVisible(), false, 'file chips do not carry over to another conversation');
    assert.equal(await f.page.locator('#provider-label').textContent(), '等待配置模型');
    assert((await f.page.locator('#provider-label').getAttribute('title')).includes('连接尚未配置'));
    await f.emit(attached);
    assert.equal(await f.page.locator('#context-label').textContent(), '组件.tsx', 'returning to a session renders its own file context');
  } finally { await f.close(); }
});

test('composer and long user messages fit narrow, wide, short and dark IDE surfaces', async () => {
  for (const viewport of [{ width: 320, height: 760 }, { width: 600, height: 760 }, { width: 1000, height: 760 }, { width: 600, height: 360 }]) {
    const f = await fixture(viewport);
    try {
      const label = `${viewport.width}x${viewport.height}`;
      await f.emit(state());
      await f.input.scrollIntoViewIfNeeded();
      await f.fill('可以直接描述你的下一步');
      assert.equal(await f.page.locator('#submit-prompt').isVisible(), true);
      assert.equal(await f.page.locator('#provider-label').isVisible(), true);
      await f.emit(state('composer-a', {
        context: { workspace: 'UBOVM', file: 'C:\\project\\src\\very-long-module-name-for-context-rendering-and-overflow-regression.tsx', fileSource: 'attached' },
        provider: { connected: true, label: 'Provider / a-very-long-model-identifier-with-reasoning-enabled' },
        messages: [
          { role: 'user', text: '请完善这个模块，并保留每一条验收条件。\n' + 'unbroken_source_identifier_'.repeat(160) },
          { role: 'assistant', text: '我会检查输入、上下文与执行状态。\n\n- 草稿保留\n- 文件上下文\n- 稳定的流式输出' }
        ]
      }));
      await f.fill('需要保留的多行草稿\n'.repeat(80));
      const geometry = await f.page.evaluate(() => {
        const rect = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
        return {
          width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          shellWidth: document.querySelector('.shell').scrollWidth,
          composer: rect('#prompt-form'), input: rect('#prompt-input'), submit: rect('#submit-prompt'),
          provider: rect('#provider-label'), user: rect('#messages .message.user'),
          messageWidth: document.querySelector('#messages .message.user .message-text').scrollWidth,
          messageClient: document.querySelector('#messages .message.user .message-text').clientWidth
        };
      });
      assert(geometry.documentWidth <= viewport.width + 1 && geometry.shellWidth <= viewport.width + 1, `${label}: the page has no horizontal overflow`);
      for (const key of ['composer', 'input', 'submit', 'provider']) {
        const rectangle = geometry[key];
        assert(rectangle.width > 0 && rectangle.height > 0, `${label}: ${key} has a usable box`);
        assert(rectangle.left >= -1 && rectangle.right <= viewport.width + 1, `${label}: ${key} fits horizontally`);
        assert(rectangle.top >= -1 && rectangle.bottom <= viewport.height + 1, `${label}: ${key} remains visible vertically`);
      }
      assert(geometry.messageWidth <= geometry.messageClient + 1, `${label}: unbroken user text wraps inside its reading column`);
      assert(geometry.user.left >= geometry.composer.left - 2 && geometry.user.right <= geometry.composer.right + 2, `${label}: user messages stay inside the composer reading column: ${JSON.stringify({ user: geometry.user, composer: geometry.composer })}`);
      if (viewport.height === 760) {
        await f.fill('为这个模块增加边界检查，先给我简短的实现方案。\n保留现有接口。');
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-${viewport.width}.png` });
      }
      if (viewport.width === 1000) {
        await f.emit(state('composer-a', {
          context: { workspace: 'UBOVM', file: 'C:\\project\\src\\renderer\\webview\\app.js', fileSource: 'attached' },
          provider: { connected: true, label: 'Worker · 本地测试模型' },
          messages: [
            { role: 'user', text: '优化协助模式下的输入体验，让上下文、模型和发送状态更清晰。\n执行时也允许我准备下一条消息。' },
            { role: 'assistant', text: '我会完善输入框的层次和交互，保留你当前的草稿。\n\n- **上下文**：显示已添加的文件，并支持移除。\n- **草稿**：输入区随内容增长，执行期间仍可编辑。\n- **发送**：Enter 发送，Shift + Enter 换行，执行时显示停止按钮。\n\n新消息会继续使用当前会话的模型和上下文。' }
          ]
        }));
        await f.fill('同时检查中文输入法，避免确认候选词时误发送。');
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-conversation.png` });
      }
      if (viewport.width === 600 && viewport.height === 760) {
        await f.page.evaluate(() => {
          document.body.classList.add('vscode-dark');
          for (const [key, value] of Object.entries({ '--vscode-foreground': '#d4d4d4', '--vscode-descriptionForeground': '#a6a6a6', '--vscode-editor-background': '#1e1e1e', '--vscode-panel-border': '#383838', '--vscode-focusBorder': '#6b8eae' })) document.documentElement.style.setProperty(key, value);
        });
        await f.frames();
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-dark.png` });
      }
      if (viewport.height === 360) await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-short.png` });
    } finally { await f.close(); }
  }
});
