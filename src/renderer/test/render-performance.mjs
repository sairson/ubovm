import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { renderWebview } = require('../host/webview.cjs');
let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => { await browser?.close(); });

const state = (id = 'assist-1', mode = 'assist') => ({
  type: 'state', mode, conversation: { id, title: '渲染测试' }, messages: [],
  provider: { label: '测试模型', connected: true }, context: { workspace: '测试工作区' },
  execution: { status: 'idle', parts: [], workers: [], activities: [] }, busy: false,
  ...(mode === 'goal' ? { goal: { objective: '验证各栏目的加载', criteria: [{ id: 'criterion-1', text: '保留输入与阅读位置', done: false }], notes: [{ text: '保留已有笔记', createdAt: new Date().toISOString() }] } } : {})
});

test('long streaming fences reuse prior blocks and match full rendering after close and rewrite', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'), reference = document.createElement('div');
    document.body.append(target, reference);
    const prefix = Array.from({ length: 120 }, (_, i) => `段落 ${i} **已完成** [引用][ref]\n\n`).join('');
    let source = prefix + '```js\n' + 'const stable = 1;\n'.repeat(200);
    UBOVMMarkdown.update(target, source, { streaming: true });
    const first = target.firstChild, line = target.querySelector('.md-code-line');
    const original = globalThis.marked, sizes = [];
    globalThis.marked = { ...original, lexer(value, options) { sizes.push(value.length); return original.lexer(value, options); } };
    try {
      for (let i = 0; i < 30; i++) {
        source += `const next${i} = ${i};\n`;
        UBOVMMarkdown.update(target, source, { streaming: true });
      }
    } finally { globalThis.marked = original; }
    const reused = first === target.firstChild && line === target.querySelector('.md-code-line');
    const tailOnly = sizes.length === 30 && sizes.every(size => size < source.length - prefix.length + 1);
    source += '```\n\n[ref]: https://example.com\n\n完成。';
    UBOVMMarkdown.update(target, source, { streaming: false });
    UBOVMMarkdown.update(reference, source, { streaming: false });
    const completeMatches = target.innerHTML === reference.innerHTML;
    source = '```python\nprint("改写")\n```';
    UBOVMMarkdown.update(target, source, { streaming: false });
    UBOVMMarkdown.update(reference, source, { streaming: false });
    return { reused, tailOnly, completeMatches, rewriteMatches: target.innerHTML === reference.innerHTML };
  });
  assert.deepEqual(result, { reused: true, tailOnly: true, completeMatches: true, rewriteMatches: true });
});

test('execution updates leave static page attributes untouched and publish final content', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.evaluate(() => {
    window.staticMutations = 0;
    new MutationObserver(records => { window.staticMutations += records.length; }).observe(document.getElementById('conversation-title'), { attributes: true, childList: true });
  });
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', busy: true, streamText: '实时输出', parts: [] } });
  assert.match(await page.locator('#messages').textContent(), /实时输出/);
  assert.equal(await page.evaluate(() => window.staticMutations), 0);
  await send(page, { ...state(), messages: [{ role: 'assistant', text: '最终输出' }] });
  assert.match(await page.locator('#messages').textContent(), /最终输出/);
});

test('streaming updates do not rescan unchanged published history', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.evaluate(() => {
    window.historyReads = 0;
    const items = Array.from({ length: 100 }, (_, i) => ({ get role() { window.historyReads++; return 'assistant'; }, text: 'History ' + i }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', mode: 'assist', conversation: { id: 'assist-1' }, messages: items, execution: {} } }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { window.historyReads = 0; });
  for (let i = 0; i < 5; i++) await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', streamText: 'Live ' + i } });
  assert.equal(await page.evaluate(() => window.historyReads), 0);
  assert.match(await page.locator('#messages').textContent(), /Live 4/);
});

test('hidden panels defer rendering and reopening displays the latest state', async t => {
  const page = await pageFor(t);
  const current = state('deferred-panels', 'goal');
  current.execution.workers = [{ id: 'w1', name: 'First worker', status: 'running' }];
  current.execution.parts = [{ id: 'p1', type: 'text', text: 'First output' }];
  await send(page, current);
  assert.equal(await page.locator('#goal-workers-list .worker-card').count(), 0, 'unopened directory has no cards');
  await page.getByRole('button', { name: '关闭思考日志面板', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务执行面板', exact: true }).click();
  await page.evaluate(() => {
    window.hiddenChanges = 0;
    const observer = new MutationObserver(records => { window.hiddenChanges += records.length; });
    for (const id of ['goal-output-content', 'worker-list', 'goal-workers-list']) observer.observe(document.getElementById(id), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  current.execution.workers[0].name = 'Updated worker';
  current.execution.parts[0].text = 'Latest output';
  await send(page, current);
  assert.equal(await page.evaluate(() => window.hiddenChanges), 0);
  await page.locator('[data-overview-toggle="log"]').click();
  await page.waitForFunction(() => document.getElementById('goal-output-content').textContent.includes('Latest output'));
  await page.locator('[data-overview-toggle="workers"]').click();
  await page.waitForFunction(() => document.getElementById('worker-list').textContent.includes('Updated worker'));
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-workers').click();
  assert.match(await page.locator('#goal-workers-list').textContent(), /Updated worker/);
});

test('unchanged execution logs keep headers and worker links intact during streaming', async t => {
  const page = await pageFor(t);
  const current = state('stable-logs', 'goal');
  current.execution.workers = [{ id: 'w1', name: 'Worker', status: 'running', createdAt: 1000 }];
  current.execution.parts = [{ id: 'p1', type: 'text', text: 'Live', startedAt: 2000 }];
  await send(page, current);
  await page.evaluate(() => {
    window.stableChanges = 0;
    new MutationObserver(records => { window.stableChanges += records.length; }).observe(document.querySelector('[data-log-id="worker:w1"]'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  current.execution.parts[0].text += ' updated'; current.execution.busy = true;
  await send(page, current);
  assert.equal(await page.evaluate(() => window.stableChanges), 0);
});

test('latest message control preserves reading position and resumes following after activation', async t => {
  const page = await pageFor(t);
  const current = state(); current.busy = true;
  current.messages = Array.from({ length: 25 }, (_, i) => ({ role: 'assistant', text: `消息 ${i}\n\n` + '历史内容。'.repeat(60) }));
  current.execution = { status: 'running', busy: true, streamText: '开始输出', parts: [] };
  await send(page, current);
  await page.waitForFunction(() => { const n = document.getElementById('conversation'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  assert.equal(await page.locator('#conversation-latest').isVisible(), false);
  await page.locator('#conversation').evaluate(n => { n.scrollTop = 80; });
  await page.waitForFunction(() => !document.getElementById('conversation-latest').hidden);
  const top = await page.locator('#conversation').evaluate(n => n.scrollTop);
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { ...current.execution, streamText: '持续输出\n\n'.repeat(25) } });
  assert.equal(await page.locator('#conversation').evaluate(n => n.scrollTop), top);
  await page.locator('#conversation-latest').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('conversation-latest').hidden);
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { ...current.execution, streamText: '持续输出\n\n'.repeat(30) } });
  await page.waitForFunction(() => { const n = document.getElementById('conversation'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  await send(page, state('empty-conversation'));
  assert.equal(await page.locator('#conversation-latest').isVisible(), false);
});

test('overview focus restores layout and reset recovers closed panels and width', async t => {
  const page = await pageFor(t);
  await send(page, state('focus-layout', 'goal'));
  await page.locator('#goal-panels-swap').click();
  await page.locator('#goal-overview-split').focus(); await page.keyboard.press('ArrowRight');
  const width = await page.locator('#goal-overview-split').getAttribute('aria-valuenow');
  await page.getByRole('button', { name: '专注查看思考日志', exact: true }).click();
  assert.equal(await page.locator('[data-overview-panel="workers"]').isVisible(), false);
  assert.equal(await page.locator('[data-overview-panel="log"]').isVisible(), true);
  await page.getByRole('button', { name: '退出面板专注查看', exact: true }).click();
  assert.equal(await page.locator('[data-overview-panel="workers"]').isVisible(), true);
  assert.equal(await page.locator('.goal-overview-columns').getAttribute('data-swapped'), 'true');
  assert.equal(await page.locator('#goal-overview-split').getAttribute('aria-valuenow'), width);
  await page.getByRole('button', { name: '关闭思考日志面板', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务执行面板', exact: true }).click();
  await page.locator('#goal-panels-reset').click();
  assert.equal(await page.locator('[data-overview-panel="workers"]').isVisible(), true);
  assert.equal(await page.locator('[data-overview-panel="log"]').isVisible(), true);
  assert.equal(await page.locator('.goal-overview-columns').getAttribute('data-swapped'), 'false');
  assert.equal(await page.locator('#goal-overview-split').getAttribute('aria-valuenow'), '300');
  assert.deepEqual(await page.evaluate(() => window.persisted.goalPanelLayout), { log: true, workers: true, swapped: false });
  await page.setViewportSize({ width: 390, height: 850 });
  assert.equal(await page.locator('.goal-panel-controls').evaluate(n => n.scrollWidth <= n.clientWidth), true);
});

test('saved content paints while execution history recovers, with drafts available and execution gated', async t => {
  const page = await pageFor(t);
  const initial = { ...state(), recovering: true, messages: [{ role: 'user', text: '上次会话的内容' }] };
  await send(page, initial);
  await page.waitForFunction(() => window.sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.match(await page.locator('#messages').textContent(), /上次会话的内容/);
  await page.locator('#prompt-input').fill('恢复期间保留草稿');
  assert.equal(await page.locator('#prompt-input').isEnabled(), true);
  assert.equal(await page.locator('#submit-prompt').isDisabled(), true);
  await send(page, { ...initial, recovering: false });
  await page.waitForFunction(() => !document.getElementById('submit-prompt').disabled);
  assert.equal(await page.locator('#prompt-input').inputValue(), '恢复期间保留草稿');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'contentReady').length), 1);
});
async function pageFor(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, ...options });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  const html = renderWebview({ nonce: 'performance-test', workspaceName: '测试工作区' });
  await page.addInitScript(() => {
    window.persistCount = 0;
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      getState: () => window.persisted,
      setState(value) { window.persisted = value; window.persistCount++; },
      postMessage(value) { window.sent.push(value); }
    });
  });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://render.test/');
  return page;
}
async function send(page, message) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('loading and page switches remain opaque from their first animation frame', async t => {
  const page = await pageFor(t);
  async function assertPainted(selector) {
    const result = await page.locator(selector).evaluate(element => {
      // Inspect the exact first frame, independent of browser scheduling speed.
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return { opacity, height: element.getBoundingClientRect().height, display: getComputedStyle(element).display };
    });
    assert.equal(result.opacity, 1, selector + ' must not fade through a blank page');
    assert.ok(result.height > 0);
    assert.notEqual(result.display, 'none');
  }
  await assertPainted('#page-loading');
  await send(page, state());
  await assertPainted('#assist-mode');
  await send(page, state('goal-loading', 'goal'));
  await assertPainted('#goal-overview');
  for (const view of ['notes', 'board', 'overview']) {
    await page.locator('#goal-view-switcher > summary').click();
    await page.locator('#goal-tab-' + view).click();
    await assertPainted('#goal-' + view);
  }
  await send(page, { type: 'settingsLoading', requestId: 'slow-settings', page: 'skills' });
  await assertPainted('#settings-skeleton');
  assert.equal(await page.locator('#settings-dialog').evaluate(n => getComputedStyle(n).transform), 'none', 'fullscreen settings must cover the viewport without moving its background');
  for (const [theme, expected] of [['vscode-dark', 'rgb(27, 30, 34)'], ['vscode-light', 'rgb(255, 255, 255)']]) {
    await page.evaluate(theme => { document.body.classList.remove('vscode-dark', 'vscode-light'); document.body.classList.add(theme); }, theme);
    assert.equal(await page.locator('html').evaluate(n => getComputedStyle(n).backgroundColor), expected, 'root surface follows theme instead of exposing the browser default');
    await assertPainted('#settings-skeleton');
  }
  await send(page, { type: 'settingsLoadError', requestId: 'slow-settings', error: '加载失败，请重试' });
  assert.equal(await page.locator('#settings-load-error').isVisible(), true);
});

test('goal overview logs Reason thinking, worker dispatch and tools without replacing history with the result', async t => {
  const page = await pageFor(t);
  const message = state('overview-output', 'goal');
  message.execution = { status: 'running', busy: true, parts: [
    { id: 'thought', type: 'thinking', source: 'reason', text: '先检查项目入口。', status: 'running', startedAt: 1000 },
    { id: 'tool', type: 'tool', name: 'read_workspace_file', status: 'completed', args: '{}', output: '检查结果', startedAt: 3000 }
  ], workers: [{ id: 'worker-1', name: '检查项目', description: '读取项目结构', status: 'running', startedAt: 2000, parts: [] }] }; message.busy = true;
  await send(page, message);
  assert.deepEqual(await page.locator('.goal-log-entry').evaluateAll(rows => rows.map(row => row.dataset.logId)), ['part:thought', 'worker:worker-1', 'part:tool']);
  assert.equal(await page.locator('.goal-log-body .thinking-body').isVisible(), true);
  assert.match(await page.locator('#goal-output-content').textContent(), /先检查项目入口/);
  await page.locator('.goal-log-worker').click();
  assert.equal(await page.locator('#worker-panel').isVisible(), true);
  await page.getByRole('button', { name: '关闭 Worker 详情' }).click();
  await page.locator('.thinking-summary').click();
  message.execution.parts[0].text += '继续检查依赖。'; await send(page, message);
  assert.equal(await page.locator('.thinking-card').getAttribute('open'), null);
  message.busy = false; message.execution.busy = false; message.execution.status = 'completed';
  message.execution.result = { summary: '检查已完成。' }; await send(page, message);
  assert.equal(await page.locator('#goal-output-title').textContent(), '思考与调度日志');
  assert.match(await page.locator('#goal-output-content').textContent(), /检查已完成/);
  assert.match(await page.locator('#goal-output-content').textContent(), /先检查项目入口/);
  await page.locator('.thinking-summary').click();
  await page.screenshot({ path: '.cache/goal-execution-log.png' });
  await send(page, state('empty-output', 'goal'));
  assert.equal(await page.locator('#goal-output-content').isVisible(), false);
});

test('overview prioritizes Reason logs and live Worker states across viewport sizes', async t => {
  const now = Date.now();
  for (const width of [1440, 390]) {
    const page = await pageFor(t, { viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const current = state('live-overview-' + width, 'goal'); current.busy = true;
    current.goal.objective = '完善项目的浏览器安装与工具执行体验';
    current.execution = { status: 'running', busy: true, parts: [
      { id: 'plan', type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 60000, endedAt: now - 45000, text: '先确认 **浏览器安装流程** 和工具卡片的状态更新路径。\n\n把检查拆成两个独立任务：一个验证下载与重试，另一个检查界面交互。等待结果后，再整合发现并验证。' },
      { id: 'review', type: 'thinking', source: 'reason', status: 'running', startedAt: now - 8000, text: '安装流程已经检查完成，正在核对界面的状态变化。\n\n- 失败的工具保持收起\n- 思考日志默认展开\n- 用户手动选择在流式更新中保留' },
      { id: 'private-worker', type: 'thinking', source: 'worker', text: '仅在 Worker 详情显示', status: 'running' }
    ], workers: [
      { id: 'done', name: '验证安装流程', description: '检查下载、重复点击和失败重试。', status: 'completed', createdAt: now - 50000, startedAt: now - 48000, finishedAt: now - 12000 },
      { id: 'active', name: '检查界面交互', description: '验证工具卡片和思考日志的展开状态。', status: 'running', createdAt: now - 40000, startedAt: now - 35000, parts: [{ id: 'test', type: 'tool', name: 'run_linux_ssh_command', status: 'running' }] },
      { id: 'queued', name: '检查窄屏布局', description: '验证小窗口内的阅读与操作。', status: 'queued', createdAt: now - 2000 }
    ] };
    await send(page, current);
    assert.deepEqual(await page.locator('#worker-list .worker-card').evaluateAll(nodes => nodes.map(n => n.dataset.workerId)), ['active', 'queued', 'done']);
    assert.match(await page.locator('#goal-overview-worker-summary').textContent(), /1 执行.*1 排队.*1 完成/);
    assert.equal(await page.locator('[data-log-id="worker:done"] .goal-log-state').textContent(), '已派发');
    assert.match(await page.locator('#worker-list .worker-card-created').first().textContent(), /创建于/);
    assert.equal(await page.locator('[data-log-id="part:private-worker"]').count(), 0);
    assert.equal(await page.locator('#goal-panels').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    if (width >= 900) {
      const journal = await page.locator('.goal-output-panel').boundingBox();
      const workers = await page.locator('.goal-overview-columns > .execution-panel').boundingBox();
      assert.ok(Math.abs(journal.height - workers.height) < 1, 'parallel overview panels have equal heights');
      assert.ok(await page.locator('#goal-output-content').evaluate(n => n.scrollHeight > n.clientHeight), 'long logs scroll inside their panel');
    }
    await page.screenshot({ path: '.cache/goal-overview-' + width + '.png' });
    await page.locator('#worker-list [data-worker-id="active"]').click();
    assert.equal(await page.locator('#worker-panel').isVisible(), true);
  }
});

test('overview divider resizes, remembers width, cancels drags and adapts to narrow layouts', async t => {
  const page = await pageFor(t, { viewport: { width: 1440, height: 900 } });
  await send(page, state('split', 'goal'));
  const handle = page.locator('#goal-overview-split');
  const width = () => page.locator('.goal-overview-columns > .execution-panel').evaluate(n => Math.round(n.getBoundingClientRect().width));
  await page.waitForFunction(() => document.getElementById('goal-overview-split').getAttribute('aria-valuenow') === '300');
  const box = await handle.boundingBox(), x = box.x + box.width / 2, y = box.y + 100;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 120, y); await page.mouse.up();
  assert.equal(await width(), 420);
  assert.equal(await page.evaluate(() => window.persisted.goalWorkerWidth), 420);
  await handle.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await width(), 430);
  const moved = await handle.boundingBox();
  await page.mouse.move(moved.x + 10, y); await page.mouse.down(); await page.mouse.move(moved.x - 80, y);
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(await width(), 430);
  const saved = await page.evaluate(() => window.persisted);
  await page.addInitScript(value => { window.persisted = value; }, saved);
  await page.reload(); await send(page, state('split', 'goal'));
  await page.waitForFunction(() => document.getElementById('goal-overview-split').getAttribute('aria-valuenow') === '430');
  assert.equal(await width(), 430);
  await handle.focus(); await page.keyboard.press('End');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForFunction(() => Number(document.getElementById('goal-overview-split').getAttribute('aria-valuemax')) < 800);
  assert.equal(await page.locator('#goal-panels').evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.setViewportSize({ width: 390, height: 900 }); assert.equal(await handle.isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await handle.dblclick(); assert.equal(await width(), 300);
  assert.equal(await page.evaluate(() => window.persisted.goalWorkerWidth), 300);
});

test('overview panels swap by dragging, close independently and reopen with live data', async t => {
  const page = await pageFor(t, { viewport: { width: 1440, height: 900 } });
  const current = state('panel-layout', 'goal');
  current.execution.parts = [{ id: 'thinking', type: 'thinking', source: 'reason', text: '保留思考记录', status: 'running', startedAt: Date.now() }];
  await send(page, current);
  const log = page.locator('[data-overview-panel="log"]'), workers = page.locator('[data-overview-panel="workers"]');
  await page.evaluate(() => { window.originalThought = document.querySelector('.thinking-card'); });
  await log.locator('.goal-panel-grip').dragTo(workers.locator('.goal-panel-grip'));
  assert.equal(await page.locator('.goal-overview-columns').getAttribute('data-swapped'), 'true');
  assert.ok((await workers.boundingBox()).x < (await log.boundingBox()).x);
  assert.equal(await page.evaluate(() => originalThought === document.querySelector('.thinking-card') && originalThought.open), true);
  await page.locator('#goal-overview-split').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#goal-overview-split').getAttribute('aria-valuenow'), '310');
  await page.getByRole('button', { name: '关闭思考日志面板', exact: true }).click();
  assert.equal(await log.isVisible(), false); assert.equal(await workers.isVisible(), true);
  assert.equal(await page.locator('#goal-overview-split').isVisible(), false);
  current.execution.parts[0].text += '，更新仍然保留'; await send(page, current);
  assert.equal(await log.isVisible(), false);
  await page.getByRole('button', { name: '关闭任务执行面板', exact: true }).click();
  assert.equal(await page.locator('#goal-panels-empty').isVisible(), true);
  const saved = await page.evaluate(() => window.persisted);
  await page.addInitScript(value => { window.persisted = value; }, saved); await page.reload(); await send(page, current);
  assert.equal(await page.locator('#goal-panels-empty').isVisible(), true);
  await page.locator('[data-overview-toggle="log"]').click();
  assert.match(await log.textContent(), /更新仍然保留/);
  await page.locator('[data-overview-toggle="workers"]').click();
  assert.equal(await page.locator('#goal-overview-split').isVisible(), true);
  await log.locator('.goal-panel-grip').focus(); await page.keyboard.press('Alt+ArrowLeft');
  assert.equal(await page.locator('.goal-overview-columns').getAttribute('data-swapped'), 'false');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.locator('#goal-overview-split').isVisible(), false);
  assert.equal(await page.locator('#goal-panels').evaluate(n => n.scrollWidth <= n.clientWidth), true);
});

test('goal creation keeps initial facts in drafts and submits them separately', async t => {
  const page = await pageFor(t);
  const initial = { ...state('goal-create', 'goal'), goal: null };
  await send(page, initial);
  await page.locator('#goal-facts-input').fill('已有桌面框架\n数据保存在本地');
  await page.locator('#goal-objective-input').fill('完成项目管理功能');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => window.persisted.drafts['goal-create'].goalDraft.initialFacts), '已有桌面框架\n数据保存在本地');
  await send(page, state('other', 'goal'));
  await send(page, initial);
  assert.equal(await page.locator('#goal-facts-input').inputValue(), '已有桌面框架\n数据保存在本地');
  await page.locator('#goal-save').click();
  const message = await page.evaluate(() => window.sent.find(item => item.action === 'saveGoal'));
  assert.equal(message.goal.initialFacts, '已有桌面框架\n数据保存在本地');
  assert.equal(message.goal.objective, '完成项目管理功能');
  await send(page, { ...initial, goal: { ...message.goal, notes: [] } });
  await send(page, { type: 'uiResult', requestId: message.requestId, ok: true });
  await page.locator('#goal-initial-facts summary').click();
  assert.equal(await page.locator('#goal-facts-detail').textContent(), message.goal.initialFacts);
});

test('goal page switcher supports keyboard navigation and restores reading position', async t => {
  const page = await pageFor(t, { viewport: { width: 1100, height: 760 } });
  const initial = state('goal-navigation', 'goal');
  initial.goal.criteria = Array.from({ length: 20 }, (_, index) => ({ id: 'c' + index, text: '验收条件 ' + index + '：保留页面中的阅读位置与输入内容。'.repeat(8), done: false }));
  await send(page, initial);
  assert.equal(await page.locator('#goal-tabs').getAttribute('aria-orientation'), 'vertical');
  assert.equal(await page.locator('#goal-tabs button').count(), 4);
  assert.equal(await page.locator('#goal-prompt-form').isVisible(), false);
  await page.locator('.goal-acceptance-panel > summary').click();
  await page.locator('#goal-panels').evaluate(node => { node.scrollTop = 240; });
  await page.locator('#goal-view-switcher > summary').click();
  await page.locator('#goal-tab-overview').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#goal-tab-board').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-prompt-form').isVisible(), false);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollTop), 240);
  await page.keyboard.press('End');
  assert.equal(await page.locator('#goal-tab-notes').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-prompt-form').count(), 0);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.locator('#goal-tabs').getAttribute('aria-orientation'), 'vertical');
  await page.locator('#goal-tab-notes').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#goal-tab-overview').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-tabs').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#goal-tabs').isVisible(), false);
  assert.equal(await page.locator('#goal-view-switcher > summary').evaluate(node => node === document.activeElement), true);
  await page.locator('#goal-view-switcher > summary').click();
  await page.locator('#goal-panels').click({ position: { x: 4, y: 100 } });
  assert.equal(await page.locator('#goal-tabs').isVisible(), false);
});

test('legacy goal chat selection falls back to overview without a dialogue panel', async t => {
  const page = await pageFor(t);
  await page.addInitScript(() => { window.persisted = { drafts: { 'goal-legacy': { view: 'chat', goalPrompt: '已有草稿', note: '已有笔记草稿' } } }; });
  await page.reload();
  await send(page, state('goal-legacy', 'goal'));
  assert.equal(await page.locator('#goal-overview').isVisible(), true);
  assert.equal(await page.locator('#goal-chat, #goal-prompt-form, #goal-tab-chat').count(), 0);
  assert.equal(await page.locator('#goal-current-icon svg').count(), 1);
  await send(page, { type: 'focusInput' });
  assert.equal(await page.locator('#goal-view-switcher > summary').evaluate(node => node === document.activeElement), true);
});

test('goal surfaces fill available space without nested page overflow', async t => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 600 }, { width: 390, height: 460 }]) {
    const page = await pageFor(t, { viewport, reducedMotion: 'reduce' });
    const initial = state('goal-layout', 'goal');
    initial.goal.objective = '优化目标工作区，让进展、探索与记录各有合适的空间';
    initial.goal.criteria = Array.from({ length: 4 }, (_, index) => ({ id: 'criterion-' + index, text: ['概览的信息层级清晰', '黑板画布充分利用窗口', '笔记列表与正文独立滚动', '窄屏下操作按钮保持可见'][index], done: index === 0 }));
    initial.execution.blackboard = { sessionId: 'goal-layout', rootId: 'root', goal: initial.goal.objective, revision: 1, nodes: [
      { id: 'root', kind: 'root', parentIds: [] },
      { id: 'i', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '检查空间分配', status: 'completed' }, attempts: [] },
      { id: 'f', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '根据面板用途分配空间' } }
    ] };
    await send(page, initial);
    if (viewport.width > 1000) {
      const journal = await page.locator('.goal-output-panel').boundingBox();
      const execution = await page.locator('.execution-panel').boundingBox();
      assert.ok(Math.abs(journal.y - execution.y) < 2);
      assert.ok(execution.x > journal.x + journal.width);
      assert.equal(await page.locator('.goal-acceptance-panel').evaluate(node => node.open), false);
    }
    for (const view of ['overview', 'board', 'notes']) {
      if (view !== 'overview') { await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-' + view).click(); }
      const bounds = await page.locator('#goal-panels').boundingBox();
      assert.ok(bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (view !== 'overview') {
        assert.ok(await page.locator('#goal-panels').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
        const surface = await page.locator(view === 'board' ? '.graph-viewport' : '.notebook-layout').boundingBox();
        assert.ok(surface.height > 60);
        assert.ok(surface.y + surface.height <= bounds.y + bounds.height + 1);
      }
      if (process.env.UBOVM_UI_PREVIEW) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/layout-' + view + '-' + viewport.width + '.png' });
      if (view === 'board') {
        await page.locator('.graph-acceptance > summary').click();
        const graph = await page.locator('.graph-viewport').boundingBox();
        assert.ok(graph.height > 40, 'Expanded acceptance keeps a usable graph viewport.');
        assert.ok(await page.locator('#goal-panels').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
      }
    }
  }
});

test('startup skeleton resolves on data; streaming bursts render once and preserve published nodes', async t => {
  const page = await pageFor(t);
  assert.equal(await page.locator('#page-loading').isVisible(), true);
  assert.equal(await page.locator('#assist-mode').isVisible(), false);
  const initial = state();
  initial.messages = [{ role: 'user', text: '这是一条已经发布的消息' }];
  await send(page, initial);
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  await page.evaluate(() => {
    window.savedArticle = document.querySelector('#messages article');
    const selection = getSelection(), range = document.createRange();
    range.selectNodeContents(document.querySelector('#messages .message-text'));
    selection.removeAllRanges(); selection.addRange(range);
    const original = window.UBOVMMessage;
    window.messageRenders = 0;
    window.UBOVMMessage = { update(...args) { window.messageRenders++; return original.update(...args); } };
    for (let index = 0; index < 80; index++) window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'executionState', conversationId: 'assist-1', busy: true,
      execution: { status: 'running', streamText: '流式回复 ' + index, parts: [] }
    } }));
  });
  await page.waitForFunction(() => document.querySelector('.streaming-message')?.textContent.includes('流式回复 79'));
  assert.equal(await page.evaluate(() => window.messageRenders), 1);
  assert.equal(await page.evaluate(() => window.savedArticle === document.querySelector('#messages article')), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), initial.messages[0].text);
  await send(page, { type: 'executionState', conversationId: 'older-session', execution: { status: 'running', streamText: '不该出现' }, busy: true });
  assert.equal(await page.locator('#messages').textContent().then(text => text.includes('不该出现')), false);
  await send(page, { ...initial, messages: [...initial.messages, { role: 'assistant', text: '流式回复 79' }] });
  assert.equal(await page.locator('.streaming-message').count(), 0);
  assert.equal(await page.locator('#messages article').count(), 2);
  assert.equal(await page.locator('#busy-status').isVisible(), false);
});

test('hidden goal tabs defer expensive content and render the latest data when selected', async t => {
  const page = await pageFor(t);
  const initial = state('goal-1', 'goal');
  initial.messages = [{ role: 'user', text: '执行目标' }, { role: 'assistant', text: '# 历史回复\n\n内容' }];
  initial.execution = { status: 'running', blackboard: { revision: 1, nodes: Array.from({ length: 200 }, (_, index) => ({ id: 'node-' + index, kind: 'fact', fact: { content: '证据 ' + index } })) }, memory: { notes: [{ text: 'Agent 记录' }] }, parts: [] };
  await send(page, initial);
  assert.equal(await page.locator('#blackboard-nodes > *').count(), 0);
  assert.equal(await page.locator('#goal-notes-list > *').count(), 0);
  assert.equal(await page.locator('#goal-messages > *').count(), 0);
  assert.equal(await page.locator('#goal-output-status').isVisible(), true);
  assert.match(await page.locator('#goal-output-status').textContent(), /执行中/);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  assert.equal(await page.locator('#blackboard-nodes .graph-node').count(), 200);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click();
  assert.equal(await page.locator('#goal-notes-list').textContent().then(text => text.includes('保留已有笔记')), true);
  assert.equal(await page.locator('#agent-notes-list').textContent(), 'Agent 记录');
  assert.equal(await page.locator('#goal-chat, #goal-tab-chat').count(), 0);
  await send(page, { type: 'executionState', conversationId: 'goal-1', execution: { status: 'completed' }, busy: false });
  assert.equal(await page.locator('#header-execution-status').isVisible(), false);
});

test('typing coalesces persistence and a fast session switch flushes the previous draft', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.evaluate(() => {
    const input = document.querySelector('#prompt-input');
    for (let index = 0; index < 80; index++) {
      input.value = '尚未提交的草稿 ' + index;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.writesBeforeFlush = window.persistCount;
  });
  assert.equal(await page.evaluate(() => window.writesBeforeFlush), 0);
  await send(page, state('assist-2'));
  assert.equal(await page.evaluate(() => window.persisted.drafts['assist-1'].assist), '尚未提交的草稿 79');
  await page.locator('#prompt-input').fill('第二个会话的草稿');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => window.persisted.drafts['assist-2'].assist), '第二个会话的草稿');
  await send(page, state());
  assert.equal(await page.locator('#prompt-input').inputValue(), '尚未提交的草稿 79');
});

test('reduced motion disables loading animation including pseudo elements at narrow widths', async t => {
  const page = await pageFor(t, { viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  assert.equal(await page.locator('.loading-skeleton').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await page.locator('#page-loading-label').evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await send(page, { ...state(), execution: { status: 'running', streamText: '正在生成回复' } });
  assert.equal(await page.locator('#busy-status').evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('native blackboard details replace the canvas overlay and follow related-node navigation', async t => {
  const page = await pageFor(t);
  const message = { ...state('native-graph', 'goal'), nativeBlackboardSidebar: true };
  message.execution.blackboard = { sessionId: 'native-graph', rootId: 'root', revision: 1, goal: '侧边栏验证', nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'fact', kind: 'fact', parentIds: ['root'], fact: { content: '证据 <script>unsafe</script>' } }
  ] };
  await send(page, message);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  await page.locator('.graph-node[data-kind="fact"]').click();
  const detail = await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail'));
  assert.equal(detail.sessionId, 'native-graph');
  assert.equal(detail.reveal, true);
  assert.match(detail.detail.title, /证据/);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  await send(page, { type: 'selectBlackboardNode', sessionId: 'native-graph', id: 'root' });
  assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail').detail.id), 'root');
  await send(page, { type: 'closeBlackboardDetails' });
  assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail').detail), null);
});

 test('goal graph represents intentions as selectable edges and results as draggable facts', async t => {
  const page = await pageFor(t);
  const message = state('graph-test', 'goal');
  message.execution.blackboard = { sessionId: 'graph-test', rootId: 'root', goal: '探索目标', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'a', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '检查数据模型', status: 'completed' }, attempts: [] },
    { id: 'f', kind: 'fact', producerId: 'a', parentIds: ['a'], fact: { content: '独立证据 <script>unsafe</script>' } },
    { id: 'b', kind: 'intent', parentIds: ['f'], intent: { description: '检查前端布局', status: 'running' }, attempts: [] }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  assert.equal(await page.locator('.graph-node').count(), 2);
  assert.equal(await page.locator('.graph-node[data-kind="intent"]').count(), 0);
  assert(await page.locator('.graph-edge-label textPath').count() > 0);
  assert(await page.evaluate(() => [...document.querySelectorAll('.graph-edge-label textPath')].every(text => {
    const track = document.querySelector(text.getAttribute('href'));
    return track && text.parentElement.previousElementSibling.getAttribute('d').startsWith(track.getAttribute('d'));
  })));
  assert.equal(await page.locator('.graph-frontier').count(), 1);
  assert.equal(await page.locator('.graph-edges path[data-intent-id="a"][data-source="root"][data-target="f"]').count(), 1);
  await page.locator('.graph-edges > path[data-intent-id="a"]').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /检查数据模型/);
  await page.locator('.graph-result-link').click();
  assert.match(await page.locator('.graph-detail').textContent(), /独立证据/);
  assert.equal(await page.locator('.graph-detail script').count(), 0);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.locator('.graph-edges > path[data-intent-id="b"]').focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /检查前端布局/);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.evaluate(() => { window.savedFact = document.querySelector('.graph-node[data-node-id="f"]'); });
  message.execution.blackboard.nodes[3].intent.status = 'completed';
  message.execution.blackboard.nodes[3].resultId = 'f2';
  message.execution.blackboard.nodes.push({ id: 'f2', kind: 'fact', producerId: 'b', parentIds: ['b'], fact: { content: '布局验证完成' } });
  message.execution.blackboard.revision++;
  await send(page, message);
  assert.equal(await page.locator('.graph-frontier').count(), 0);
  assert.equal(await page.locator('.graph-node[data-kind="fact"]').count(), 2);
  assert.equal(await page.locator('.graph-edges path[data-intent-id="b"][data-target="f2"]').count(), 1);
  assert.equal(await page.evaluate(() => savedFact === document.querySelector('.graph-node[data-node-id="f"]')), true);
  assert.equal(await page.locator('.graph-zoom').textContent(), '85%');
  assert.equal(await page.locator('.graph-direction').count(), 0);
  await page.screenshot({ path: '.cache/goal-blackboard-graph.png' });
  await page.setViewportSize({ width: 320, height: 760 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 });

 test('graph dragging respects zoom, preserves manual positions and keeps details optional', async t => {
  const page = await pageFor(t);
  const message = state('drag-test', 'goal');
  message.execution.blackboard = { sessionId: 'drag-test', rootId: 'root', revision: 1, goal: '拖动探索图', nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'a', kind: 'fact', parentIds: ['root'], fact: { content: '检查数据得到的事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  const viewportBefore = await page.locator('.graph-viewport').boundingBox();
  const node = page.locator('.graph-node[data-node-id="a"]');
  await node.click();
  assert.equal(await page.locator('.graph-detail').isVisible(), true);
  assert.equal((await page.locator('.graph-viewport').boundingBox()).width, viewportBefore.width);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '缩小探索图' }).click();
  const original = await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  const edge = page.locator('.graph-edges > path:not(.graph-edge-hit)'); const pathBefore = await edge.getAttribute('d');
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 68, box.y + box.height / 2 + 34, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const moved = await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  assert(Math.abs(moved.x - original.x - 80) < 2);
  assert(Math.abs(moved.y - original.y - 40) < 2);
  assert.notEqual(await edge.getAttribute('d'), pathBefore);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  message.execution.blackboard.revision++;
  await send(page, message);
  assert.deepEqual(await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) })), moved);
  await node.click(); assert.equal(await page.locator('.graph-detail').isVisible(), true);
  await page.getByRole('button', { name: '关闭节点详情' }).press('Escape');
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  assert.deepEqual(await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) })), original);
  await page.screenshot({ path: '.cache/goal-graph-drag.png' });
 });

test('unlabelled edges have a generous mouse target and keyboard selection at low zoom', async t => {
  const page = await pageFor(t), message = { ...state('edge-hit', 'goal'), nativeBlackboardSidebar: true };
  message.execution.blackboard = { sessionId: 'edge-hit', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '直接关系事实' } },
    { id: 'i', kind: 'intent', parentIds: ['f'], resultId: 'f2', intent: { description: '', status: 'completed' } },
    { id: 'f2', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '产出事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const id of ['f', 'i']) {
    const line = page.locator(`.graph-edges > path[data-selection-id="${id}"]:not(.graph-edge-hit)`);
    const label = page.locator(`.graph-edge-label[data-selection-id="${id}"]`);
    assert.equal(await label.getAttribute('aria-hidden'), 'true');
    assert.equal(await line.getAttribute('tabindex'), '0');
    const point = await line.evaluate(path => {
      const p = path.getPointAtLength(path.getTotalLength() * .4);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
      return { x: screen.x + 4, y: screen.y };
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'clicking the invisible edge target must not draw a rectangular focus ring');
    assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail')?.detail?.id), id);
    assert.equal(await page.locator('.graph-viewport').evaluate(n => n.classList.contains('is-panning')), false);
    await send(page, { type: 'closeBlackboardDetails' });
    await line.focus(); await page.keyboard.press('Enter');
    assert.equal(await line.evaluate(n => getComputedStyle(n).outlineStyle), 'none');
    assert.equal(await line.evaluate(n => getComputedStyle(n).strokeWidth), '2.5px', 'keyboard focus remains visible on the line');
    assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail')?.detail?.id), id);
    await send(page, { type: 'closeBlackboardDetails' });
  }
});

test('blank canvas pans at zoom without moving facts and survives streamed updates', async t => {
  const page = await pageFor(t), message = state('pan-test', 'goal');
  message.execution.blackboard = { sessionId: 'pan-test', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '证据' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  await page.getByRole('button', { name: '缩小探索图' }).click();
  const node = page.locator('.graph-node[data-node-id="f"]');
  const before = await node.boundingBox(), original = await node.getAttribute('style');
  const viewport = await page.locator('.graph-viewport').boundingBox();
  await page.mouse.move(viewport.x + 80, viewport.y + 300);
  await page.mouse.down(); await page.mouse.move(viewport.x + 148, viewport.y + 334, { steps: 6 }); await page.mouse.up();
  const after = await node.boundingBox();
  assert(Math.abs(after.x - before.x - 68) < 2); assert(Math.abs(after.y - before.y - 34) < 2);
  assert.equal(await node.getAttribute('style'), original);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  const transform = await page.locator('.graph-canvas').evaluate(n => n.style.transform);
  message.execution.blackboard.revision++; await send(page, message);
  assert.equal(await page.locator('.graph-canvas').evaluate(n => n.style.transform), transform);
  await node.click(); assert.equal(await page.locator('.graph-detail').isVisible(), true);
  assert.equal(await page.locator('.graph-canvas').evaluate(n => n.style.transform), transform);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  assert.equal(await page.locator('.graph-canvas').evaluate(n => n.style.transform), 'translate(0px, 0px)');
  assert.equal(await page.locator('.graph-viewport').evaluate(n => n.classList.contains('is-panning')), false);
});

test('edge labels hide when nodes overlap them and remain accessible at low zoom', async t => {
  const page = await pageFor(t), message = state('labels-test', 'goal');
  message.execution.blackboard = { sessionId: 'labels-test', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'i', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '验证', status: 'completed' } },
    { id: 'f', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '已验证事实' } },
    { id: 'other', kind: 'fact', parentIds: ['f'], fact: { content: '另一项事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click();
  const label = page.locator('.graph-edge-label[data-intent-id="i"]'), line = page.locator('path[data-intent-id="i"]');
  assert.equal(await label.isVisible(), true);
  const textBox = await label.boundingBox(), other = await page.locator('.graph-node[data-node-id="other"]').boundingBox();
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
  await page.mouse.down(); await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'hidden');
  assert.equal(await line.getAttribute('tabindex'), '0');
  assert.match(await line.locator('title').textContent(), /验证/);
  await line.focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /验证/);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'visible');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'hidden');
  assert.equal(await label.isVisible(), false);
  assert.equal(await line.getAttribute('tabindex'), '0');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '放大探索图' }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'visible');
});


test('goal header substitutes module actions and restores overview controls', async t => {
  const page = await pageFor(t), message = state('module-actions', 'goal');
  await send(page, state('assist-actions'));
  assert.equal(await page.locator('#review-code-changes').isVisible(), true);
  message.execution.blackboard = { sessionId: 'module-actions', rootId: 'root', nodes: [{ id: 'root', kind: 'root', parentIds: [] }] };
  await send(page, message);
  assert.equal(await page.locator('#review-code-changes').isVisible(), false);
  assert.equal(await page.locator('#goal-mode').getAttribute('aria-label'), '探索模式');
  assert.match(await page.title(), /探索工作台/);
  const choose = async view => { await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-' + view).click(); };
  assert(await page.locator('#goal-edit').isVisible()); assert(await page.locator('#new-goal').isVisible());
  await choose('board');
  assert.equal(await page.locator('#goal-edit').isVisible(), false); assert.equal(await page.locator('#new-goal').isVisible(), false);
  assert.equal(await page.locator('.topbar #goal-board-actions button').count(), 0);
  assert(await page.locator('.graph-workspace .graph-controls').isVisible());
  assert.equal(await page.locator('.graph-direction, .graph-toolbar').count(), 0);
  const viewport = await page.locator('.graph-viewport').boundingBox();
  const controls = await page.locator('.graph-controls').boundingBox();
  assert(controls.x >= viewport.x && controls.y >= viewport.y && controls.y + controls.height <= viewport.y + viewport.height);
  assert(viewport.height > 500);
  assert.equal(await page.locator('#goal-board').getByRole('button', { name: '自动布局', exact: true }).count(), 0);
  await choose('notes');
  assert.equal(await page.locator('#goal-board-actions').isVisible(), false);
  assert(await page.locator('.topbar #note-new').isVisible());
  assert.equal(await page.locator('#goal-notes #note-new').count(), 0);
  await page.locator('#note-new').click(); assert(await page.locator('#goal-note-input').isVisible());
  await page.locator('#note-close').click();
  await send(page, { type: 'executionState', conversationId: 'module-actions', execution: message.execution, busy: false });
  assert(await page.locator('.topbar #note-new').isVisible()); assert.equal(await page.locator('#new-goal').isVisible(), false);
  await choose('overview');
  assert(await page.locator('#goal-edit').isVisible()); assert(await page.locator('#new-goal').isVisible());
  assert.equal(await page.locator('#goal-notes-actions').isVisible(), false);
  await send(page, state('assist-actions'));
  assert.equal(await page.locator('#review-code-changes').isVisible(), true);
});
