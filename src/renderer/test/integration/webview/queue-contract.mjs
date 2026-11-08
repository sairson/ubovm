// Cross-layer contract: the host publishes a deliberately small input-queue
// projection (src/renderer/extension.cjs `publishedInputQueue`) and the webview
// renders chips/pills/preview from it. These tests feed the exact projection the
// host would publish (including context.range and every optional field) into the
// real webview bundle, so a schema drift on either side of that seam fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

// Mirrors `boundedContextMeta()` in extension.cjs (120/80 chars, ellipsis) so a
// long path/range reaches the webview exactly as the host would publish it.
function boundedContextMeta(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text;
}

// Mirrors `publishedInputQueue()` in extension.cjs. `raw` is a persisted queue
// item (`contextMeta` + `images` included) and the result is the only shape the
// webview ever receives. Keep this in sync with the host projection.
function projectQueueItem(raw) {
  return {
    id: raw.id,
    text: raw.text,
    ...(raw.delivery ? { delivery: raw.delivery } : {}),
    ...(raw.modelId ? { modelId: raw.modelId } : {}),
    ...(raw.images?.length ? { imageCount: raw.images.length } : {}),
    ...(raw.approvalMode ? { approvalMode: raw.approvalMode } : {}),
    ...(raw.contextMeta?.label && raw.contextMeta?.kind
      ? { context: { label: raw.contextMeta.label, kind: raw.contextMeta.kind, ...(raw.contextMeta.range ? { range: raw.contextMeta.range } : {}) } }
      : {})
  };
}

function state(id = 'queue-contract', overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id, title: '队列契约' }, messages: [], goal: null,
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
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'queue-contract-test' });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://queue-contract.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
    await frames();
  };
  const sent = action => page.evaluate(action => window.hostMessages.filter(message => message.action === action), action);
  const ack = (message, ok = true) => emit({ type: 'uiResult', requestId: message.requestId, ok, ...(ok ? {} : { error: '测试请求失败' }) });
  const input = page.locator('#prompt-input');
  const fill = async text => { await input.fill(text); await frames(); };
  const close = async () => { assert.deepEqual(errors, [], 'the webview must not generate browser exceptions'); await page.close(); };
  return { page, input, emit, frames, sent, ack, fill, close };
}

test('the published projection maps one-to-one onto metadata chips', async () => {
  const f = await fixture();
  try {
    const raw = {
      id: 'contract-full', text: '带全部元数据的输入', approvalMode: 'auto', modelId: 'deepseek-v4-pro',
      // The host persists the captured snapshot on `context` and the bounded
      // label on `contextMeta`; only `contextMeta` is published.
      context: { workspace: 'UBOVM', source: 'selection', file: '/ws/src/app.ts', content: 'selected body' },
      contextMeta: { label: 'src/app.ts', kind: 'selection', range: 'L3–9' },
      images: [{ id: 'img-1', name: 'a.png' }, { id: 'img-2', name: 'b.png' }]
    };
    const projected = projectQueueItem(raw);
    assert.deepEqual(Object.keys(projected), ['id', 'text', 'modelId', 'imageCount', 'approvalMode', 'context']);
    assert.deepEqual(projected.context, { label: 'src/app.ts', kind: 'selection', range: 'L3–9' });
    assert.equal(projected.imageCount, 2);
    assert.equal(projected.delivery, undefined, 'an undelivered input publishes no delivery field');
    await f.emit(state('contract-full', {
      busy: true, modelSelection: { provider: 'deepseek', selected: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      execution: { status: 'running', busy: true, canSteer: true, runId: 'run-contract' }, inputQueue: [projected]
    }));
    const row = f.page.locator('[data-input-id="contract-full"]');
    assert.equal(await row.locator('.input-queue-chip').count(), 5, 'image, context, approval, model and next-turn chips');
    assert.equal(await row.locator('[data-chip="images"]').textContent(), '图片 ×2');
    assert.equal(await row.locator('[data-chip="images"]').getAttribute('title'), '入队时附带 2 张图片');
    assert.equal(await row.locator('[data-chip="context"]').textContent(), '选中 src/app.ts');
    assert.equal(await row.locator('[data-chip="context"]').getAttribute('data-kind'), 'selection');
    assert.match(await row.locator('[data-chip="context"]').getAttribute('title'), /入队时的上下文：src\/app\.ts · L3–9/);
    assert.equal(await row.locator('[data-chip="approval"]').textContent(), '自动');
    assert.equal(await row.locator('[data-chip="model"]').textContent(), 'deepseek-v4-pro');
    assert.equal(await row.locator('[data-chip="next-turn"]').textContent(), '下一轮');

    // Snapshots that match the composer explain nothing: absent chips, not empty ones.
    const matched = projectQueueItem({
      id: 'contract-matched', text: '与编辑器设置一致的输入', approvalMode: 'manual', modelId: 'deepseek-v4-flash',
      context: { workspace: 'UBOVM', file: '/ws/src/app.ts', content: 'body' }, contextMeta: { label: 'src/app.ts', kind: 'file' }
    });
    assert.deepEqual(Object.keys(matched), ['id', 'text', 'modelId', 'approvalMode', 'context']);
    await f.emit(state('contract-full', {
      busy: false, modelSelection: { provider: 'deepseek', selected: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      inputQueue: [matched]
    }));
    assert.equal(await f.page.locator('[data-input-id="contract-matched"] [data-chip="approval"]').count(), 0);
    assert.equal(await f.page.locator('[data-input-id="contract-matched"] [data-chip="model"]').count(), 0);
  } finally { await f.close(); }
});

test('absent optional projection fields render no chips and no delivery pill', async () => {
  const f = await fixture();
  try {
    // A legacy/plain row carries only id+text.
    const plain = { id: 'contract-plain', text: '只有正文' };
    assert.deepEqual(Object.keys(projectQueueItem(plain)), ['id', 'text']);
    await f.emit(state('contract-plain', { inputQueue: [plain] }));
    const row = f.page.locator('[data-input-id="contract-plain"]');
    assert.equal(await row.locator('.input-queue-chip').count(), 0);
    assert.equal(await row.locator('.input-queue-meta').isHidden(), true, 'the empty metadata strip collapses');
    assert.equal(await row.locator('.input-queue-delivery').isHidden(), true);
    assert.equal(await row.locator('.input-queue-delivery').textContent(), '');
    // Empty arrays / empty strings are omitted by the host projection too.
    const empty = projectQueueItem({ id: 'contract-empty', text: '空字段', images: [], modelId: '', approvalMode: undefined, contextMeta: {} });
    assert.deepEqual(Object.keys(empty), ['id', 'text']);
    await f.emit(state('contract-plain', { inputQueue: [empty] }));
    assert.equal(await f.page.locator('[data-input-id="contract-empty"] .input-queue-chip').count(), 0);
    // Drift tolerance: a future host field the webview does not know is ignored,
    // not rendered as raw metadata and not fatal.
    await f.emit(state('contract-plain', { inputQueue: [{ ...plain, futureField: { nested: true } }] }));
    assert.equal(await f.page.locator('[data-input-id="contract-plain"] .input-queue-chip').count(), 0);
    assert.equal(await f.page.locator('[data-input-id="contract-plain"] .input-queue-text').textContent(), '只有正文');
  } finally { await f.close(); }
});

test('context kinds degrade gracefully, and long labels/ranges clip at 320px', async () => {
  const f = await fixture({ width: 320, height: 800 });
  try {
    const longLabel = boundedContextMeta('src/renderer/very-long-directory-name/'.repeat(6) + 'ComponentName.tsx', 120);
    const longRange = boundedContextMeta('L1–9, L20–44, L80–120, L200–260, L400–480, L900–1024', 80);
    const items = [
      projectQueueItem({ id: 'kind-selection', text: '选区上下文', contextMeta: { label: '组件.tsx', kind: 'selection', range: 'L12–48' } }),
      projectQueueItem({ id: 'kind-file', text: '附件上下文', contextMeta: { label: 'notes.txt', kind: 'file' } }),
      projectQueueItem({ id: 'kind-active', text: '活动编辑器上下文', contextMeta: { label: 'src/active.ts', kind: 'active' } }),
      // Not a kind the current host emits; schema drift must stay readable.
      projectQueueItem({ id: 'kind-unknown', text: '未知来源上下文', contextMeta: { label: 'src/diff.ts', kind: 'diff' } }),
      projectQueueItem({ id: 'kind-long', text: '超长上下文', contextMeta: { label: longLabel, kind: 'selection', range: longRange } })
    ];
    await f.emit(state('contract-kinds', { inputQueue: items }));
    const chipText = id => f.page.locator(`[data-input-id="${id}"] [data-chip="context"]`).textContent();
    assert.equal(await chipText('kind-selection'), '选中 组件.tsx');
    assert.match(await f.page.locator('[data-input-id="kind-selection"] [data-chip="context"]').getAttribute('title'), /L12–48/);
    assert.equal(await chipText('kind-file'), '附件 notes.txt');
    assert.equal(await chipText('kind-active'), 'src/active.ts');
    assert.equal(await f.page.locator('[data-input-id="kind-active"] [data-chip="context"]').getAttribute('data-kind'), 'active');
    assert.equal(await chipText('kind-unknown'), 'src/diff.ts', 'an unknown kind falls back to the unprefixed label');
    assert.equal(await f.page.locator('[data-input-id="kind-unknown"] [data-chip="context"]').getAttribute('data-kind'), 'active');
    const longChip = f.page.locator('[data-input-id="kind-long"] [data-chip="context"]');
    const longTitle = await longChip.getAttribute('title');
    assert.ok(longTitle.includes(longLabel), 'the title keeps the host-bounded label');
    assert.ok(longTitle.includes(longRange), 'the title keeps the full range');
    assert.ok(longLabel.endsWith('…') && longLabel.length === 120, 'the host bounds the label before publishing');
    const clipped = await longChip.evaluate(node => ({ textOverflow: getComputedStyle(node).textOverflow, overflowX: getComputedStyle(node).overflowX, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.equal(clipped.textOverflow, 'ellipsis');
    assert.equal(clipped.overflowX, 'hidden');
    assert.equal(clipped.scrollWidth > clipped.clientWidth, true, 'a long label is visually clipped, not wrapped');
    const geometry = await f.page.evaluate(() => {
      const list = document.querySelector('.input-queue-list');
      return { page: document.documentElement.scrollWidth, innerWidth, listScroll: list.scrollWidth, listClient: list.clientWidth };
    });
    assert.ok(geometry.page <= geometry.innerWidth, 'metadata never forces horizontal page scrolling at 320px');
    assert.ok(geometry.listScroll <= geometry.listClient + 1, 'rows clip their metadata inside the queue');
  } finally { await f.close(); }
});

test('delivery pills and paused reasons match the steer control state', async () => {
  const f = await fixture();
  try {
    // A dispatched row is hidden while it is merely in flight; once the queue is
    // paused it must be reviewable with an explicit warning pill.
    await f.emit(state('contract-delivery', {
      busy: true, queuePaused: true,
      execution: { status: 'running', busy: true, canSteer: true, runId: 'run-delivery' },
      inputQueue: [projectQueueItem({ id: 'delivery-sending', text: '已派发', delivery: 'sending' })]
    }));
    assert.equal(await f.page.locator('[data-input-id="delivery-sending"] .input-queue-delivery').textContent(), '发送中');
    assert.equal(await f.page.getByRole('button', { name: '继续发送队列', exact: true }).isDisabled(), true, 'resuming waits for delivery review');
    assert.equal(await f.page.getByRole('button', { name: '取回编辑', exact: true }).isEnabled(), true, 'recall is always available for review');
    // An ambiguous delivery outranks the generic "sending" wording: the user
    // must review it, and the queue cannot resume on its own.
    await f.emit(state('contract-delivery', {
      busy: true, queuePaused: true,
      execution: { status: 'running', busy: true, canSteer: true, runId: 'run-delivery' },
      inputQueue: [projectQueueItem({ id: 'delivery-uncertain', text: '待核实', delivery: 'uncertain' })]
    }));
    assert.equal(await f.page.locator('[data-input-id="delivery-uncertain"] .input-queue-delivery').textContent(), '送达待确认');
    const unresolvedStatus = f.page.locator('.input-queue-status');
    assert.equal(await unresolvedStatus.textContent(), '请核实引导送达状态');
    assert.equal(await unresolvedStatus.getAttribute('role'), 'status');
    assert.equal(await unresolvedStatus.getAttribute('aria-live'), 'polite');

    // Interrupted/failed queues say why they stopped.
    await f.emit(state('contract-delivery', {
      inputQueue: [projectQueueItem({ id: 'paused-failed', text: '失败后的输入' })],
      execution: { status: 'interrupted', busy: false, canSteer: false }
    }));
    assert.match(await f.page.locator('.input-queue-status').textContent(), /已暂停 · 上一轮已停止或失败/);
    assert.equal(await f.page.locator('.input-queue-count').textContent(), '1');

    // Paused + no live run: steering is genuinely unavailable, so the disabled
    // title carries the paused explanation.
    await f.emit(state('contract-delivery', {
      queuePaused: true, busy: false,
      execution: { status: 'idle', busy: false, canSteer: false },
      inputQueue: [projectQueueItem({ id: 'paused-disabled', text: '暂停中不可引导' })]
    }));
    assert.equal(await f.page.locator('.input-queue-status').textContent(), '已暂停');
    const disabledSteer = f.page.locator('[data-input-id="paused-disabled"] .input-queue-steer');
    assert.equal(await disabledSteer.isDisabled(), true);
    assert.equal(await disabledSteer.getAttribute('title'), '队列已暂停，继续后可发送', 'paused wording is reserved for the disabled case');

    // Paused but a live steerable run: pausing only stops automatic drain, manual
    // steering still works, so the title must not claim the queue is paused.
    await f.emit(state('contract-delivery', {
      queuePaused: true, busy: true,
      execution: { status: 'running', busy: true, canSteer: true, runId: 'run-paused' },
      inputQueue: [projectQueueItem({ id: 'paused-steerable', text: '暂停中仍可引导' })]
    }));
    const liveSteer = f.page.locator('[data-input-id="paused-steerable"] .input-queue-steer');
    assert.equal(await f.page.locator('.input-queue-status').textContent(), '已暂停');
    assert.equal(await liveSteer.isDisabled(), false);
    const liveTitle = await liveSteer.getAttribute('title');
    assert.equal(liveTitle.includes('队列已暂停'), false, 'an enabled steer control never claims the queue is paused');
    assert.match(liveTitle, /立刻调整当前任务/);
  } finally { await f.close(); }
});

test('preview renders the published metadata and copies the full text through the host', async () => {
  const f = await fixture();
  try {
    const text = '预览正文 👋\n'.repeat(12);
    const item = projectQueueItem({
      id: 'contract-preview', text, approvalMode: 'auto', modelId: 'deepseek-v4-pro',
      context: { workspace: 'UBOVM', file: '/ws/src/app.ts', content: 'body' },
      contextMeta: { label: 'src/app.ts', kind: 'selection', range: 'L3–9' },
      images: [{ id: 'img-1' }]
    });
    await f.emit(state('contract-preview', {
      modelSelection: { provider: 'deepseek', selected: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      inputQueue: [item]
    }));
    await f.page.locator('[data-input-id="contract-preview"] .input-queue-text').click();
    const dialog = f.page.locator('#queue-preview');
    assert.equal(await dialog.isVisible(), true);
    const meta = dialog.locator('.queue-preview-meta');
    assert.match(await meta.textContent(), new RegExp(`第 1 条 · ${Array.from(text).length} 字符`));
    assert.match(await meta.textContent(), /图片 ×1/);
    assert.match(await meta.textContent(), /选中 src\/app\.ts/);
    assert.match(await meta.textContent(), /自动/);
    assert.match(await meta.textContent(), /deepseek-v4-pro/);
    assert.match(await dialog.locator('.queue-preview-chip[data-chip="context"]').getAttribute('title'), /入队时的上下文：src\/app\.ts · L3–9/);
    assert.equal(await dialog.locator('.queue-preview-content').textContent(), text);
    await dialog.locator('.queue-preview-copy').click();
    const request = (await f.sent('copyText')).at(-1);
    assert.equal(request.text, text, 'the copy request carries the exact queued text');
    await f.ack(request);
    await f.frames();
    assert.equal(await dialog.locator('.queue-preview-copy').textContent(), '已复制');
  } finally { await f.close(); }
});

test('recall sends removeInput and restores the queued approval snapshot without replaying', async () => {
  const f = await fixture();
  try {
    const item = projectQueueItem({
      id: 'contract-recall', text: '取回的内容', approvalMode: 'auto',
      context: { workspace: 'UBOVM', file: '/ws/src/app.ts', content: 'body' },
      contextMeta: { label: 'src/app.ts', kind: 'selection', range: 'L3–9' },
      images: [{ id: 'img-1' }]
    });
    await f.emit(state('contract-recall', { inputQueue: [item] }));
    assert.equal(await f.page.locator('input[name="tool-approval-mode"][value="manual"]').isChecked(), true, 'composer starts in manual mode');
    await f.fill('更新的草稿');
    await f.page.getByRole('button', { name: '取回编辑', exact: true }).click();
    const request = (await f.sent('removeInput')).at(-1);
    assert.equal(request.inputId, 'contract-recall');
    assert.equal(request.sessionId, 'contract-recall');
    assert.equal((await f.sent('prompt')).length, 0, 'recall never submits the host prompt');
    await f.ack(request);
    assert.equal(await f.input.inputValue(), '取回的内容\n\n更新的草稿', 'recalled text sits above the newer draft');
    assert.equal(await f.page.locator('input[name="tool-approval-mode"][value="auto"]').isChecked(), true, 'the queued approval snapshot is restored');
    assert.equal((await f.sent('prompt')).length, 0, 'recall never replays the input');
  } finally { await f.close(); }
});

test('a full queue keeps the draft and pending images and never sends a prompt', async () => {
  const f = await fixture();
  try {
    const inputQueue = Array.from({ length: 20 }, (_, index) => projectQueueItem({ id: `full-${index}`, text: `待发送输入 ${index}` }));
    const running = {
      busy: true, inputQueue,
      pendingImages: [{ id: 'img-1', name: 'pixel.png', uri: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }],
      execution: { status: 'running', busy: true, canSteer: true, runId: 'run-full' }
    };
    await f.emit(state('contract-full-queue', running));
    assert.equal(await f.page.locator('.input-queue-row').count(), 20);
    assert.equal(await f.page.locator('.input-queue-count').textContent(), '20 / 20');
    assert.equal(await f.page.locator('.composer-image').count(), 1, 'the pending image is attached');
    await f.fill('第 21 条消息');
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('aria-label'), '队列已满');
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, 0, 'the full queue refuses the host request');
    assert.equal((await f.sent('removeImage')).length, 0, 'the guard never touches composer attachments');
    assert.equal(await f.input.inputValue(), '第 21 条消息', 'the refused draft stays in the composer');
    assert.equal(await f.page.locator('.composer-image').count(), 1, 'the pending image stays attached');
    assert.equal(await f.page.locator('#ui-error').isVisible(), true);
    assert.match(await f.page.locator('#ui-error-message').textContent(), /输入队列最多保留 20 条消息/);
    // Removing one queued input re-opens the normal path without losing the draft.
    await f.emit(state('contract-full-queue', { ...running, inputQueue: inputQueue.slice(1) }));
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('aria-label'), '加入队列');
    await f.input.press('Enter');
    const request = (await f.sent('prompt')).at(-1);
    assert.equal(request.text, '第 21 条消息');
  } finally { await f.close(); }
});
