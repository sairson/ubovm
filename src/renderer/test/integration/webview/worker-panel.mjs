import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' }); });
test.after(async () => browser?.close());
const text = (id, value) => ({ id, type: 'text', text: value, status: 'streaming' });
const tool = { id: 'read-file', type: 'tool', name: 'read_workspace_file', status: 'running', args: '{"path":"src/index.mjs"}', output: 'export const ready = true;', startedAt: Date.now() };
const initialWorkers = () => [
  { id: 'alpha', name: '检查项目结构', description: '检查项目目录和入口，梳理模块依赖。', status: 'running', depth: 1, startedAt: Date.now(), parts: [text('alpha-text', '已找到项目入口，正在检查文件。'), tool] },
  { id: 'beta', name: '验证测试入口', description: '检查现有测试和运行方式。', status: 'waiting', depth: 1, parts: [text('beta-text', '等待子任务检查测试配置。')] },
  { id: 'leaf', parentId: 'beta', name: '检查测试配置', description: '读取测试配置并报告实际命令。', status: 'queued', depth: 2, parts: [] }
];
function state(workers, extra = {}) {
  return { type: 'state', mode: 'assist', conversation: { id: 'workers', title: '项目协作' }, messages: [{ role: 'user', text: '帮我检查项目结构和测试入口。' }],
    context: { workspace: 'UBOVM', file: '' }, provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    execution: { status: 'running', busy: true, parts: [text('root', '我正在协调两个独立任务。')], workers, activities: [] }, ...extra };
}
async function fixture(t, width = 1280, persisted = {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(value => { window.savedState = value; window.hostMessages = []; window.acquireVsCodeApi = () => ({ getState: () => savedState, setState(value) { window.savedState = value; }, postMessage(message) { hostMessages.push(message); } }); }, persisted);
  await page.route('http://worker-panel.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'worker-panel-test' }) }));
  await page.goto('http://worker-panel.test/');
  const emit = async value => { await page.evaluate(value => dispatchEvent(new MessageEvent('message', { data: value })), value); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return { page, emit, cards: page.locator('#collaboration-worker-list .worker-card'), panel: page.locator('#worker-panel') };
}

test('stream-only Worker updates preserve roster DOM, options and focus', async t => {
  const f = await fixture(t);
  await f.emit(state([]));
  await f.page.locator('#route-loading').waitFor({ state: 'hidden' });
  const result = await f.page.evaluate(() => {
    const panel = createWorkerPanel({});
    let workers = Array.from({ length: 100 }, (_, index) => ({ id: String(index), name: 'Worker ' + index, status: 'running', parts: [{ id: 'tool', type: 'tool', name: 'run_local_shell_command', status: 'running', output: '' }] }));
    const update = () => panel.update({ sessionId: 'stable-roster', workers });
    update();
    const list = document.getElementById('collaboration-worker-list');
    const picker = document.querySelectorAll('#worker-picker')[1];
    const row = list.children[1], option = picker.children[1];
    const observer = new MutationObserver(() => {});
    for (const element of [list, picker]) observer.observe(element, { subtree: true, attributes: true, childList: true, characterData: true });
    for (let index = 0; index < 100; index++) {
      workers = workers.map(worker => ({ ...worker, parts: [{ ...worker.parts[0], output: 'line\n'.repeat(index + 1) }] }));
      update();
    }
    const mutations = observer.takeRecords().length;
    row.focus(); workers = workers.slice(1); update();
    const focusPreserved = document.activeElement === row && list.firstChild === row;
    workers[0] = { ...workers[0], name: '更新名称', status: 'completed', result: 'a'.repeat(149) + '😀' + 'z'.repeat(100000) };
    update();
    const result = { mutations, focusPreserved, sameOption: picker.firstChild === option, optionText: option.textContent, preview: row.querySelector('.worker-card-preview').textContent };
    observer.disconnect();
    return result;
  });
  assert.equal(result.mutations, 0, '100 snapshots across 100 workers must not rewrite unchanged roster metadata');
  assert.equal(result.focusPreserved, true);
  assert.equal(result.sameOption, true);
  assert.match(result.optionText, /更新名称.*已完成/);
  assert.equal(result.preview, 'a'.repeat(149), 'preview must remain bounded without splitting an emoji');
});

test('embedded Worker failure stays local and a later snapshot restores content and preserves drafts', async t => {
  const f = await fixture(t, 390), workers = initialWorkers();
  await f.emit(state(workers));
  await f.page.locator('#prompt-input').fill('保留主页面草稿');
  await f.page.evaluate(() => {
    window.originalMessage = UBOVMMessage;
    window.UBOVMMessage = { update(element, ...args) {
      if (element.closest('#worker-panel')) throw Error('Injected Worker failure');
      return window.originalMessage.update(element, ...args);
    } };
  });
  await f.cards.first().click();
  const retry = f.page.getByRole('button', { name: '重新显示日志', exact: true });
  assert.equal(await retry.isVisible(), true);
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await f.page.evaluate(() => { window.UBOVMMessage = window.originalMessage; });
  workers[0].parts = [text('recovered', '更新后恢复的日志')];
  await f.emit(state(workers));
  assert.equal(await retry.isVisible(), false);
  assert.match(await f.panel.locator('.worker-transcript').textContent(), /更新后恢复的日志/);
  await f.page.getByRole('button', { name: '关闭 Worker 详情' }).click();
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '保留主页面草稿');
});

test('restored tool-only workers show saved answers without adding empty-record placeholders', async t => {
  const f = await fixture(t);
  const worker = { id: 'cached', description: 'Saved work', status: 'completed', parts: [{ ...tool, status: 'completed' }] };
  await f.emit(state([worker])); await f.cards.first().click();
  assert.equal(await f.panel.locator('.tool-card').count(), 1);
  assert.equal(await f.panel.locator('.response-text').count(), 0);
  await f.emit(state([{ ...worker, result: 'Saved **answer**' }]));
  assert.equal(await f.panel.locator('.response-text strong').textContent(), 'answer');
  await f.emit(state([{ ...worker, parts: [] }]));
  assert.match(await f.panel.locator('.worker-transcript').textContent(), /任务已结束/);
});

test('completed workers prefer the final result over cached stream previews and incomplete parts', async t => {
  const f = await fixture(t);
  const worker = { id: 'cached', description: 'Saved work', status: 'running', streamText: 'Stale partial reply',
    parts: [text('intro', 'Earlier progress'), { ...tool, status: 'completed' }] };
  await f.emit(state([worker])); await f.cards.first().click();
  await f.panel.locator('.tool-card > summary').click();
  await f.page.evaluate(() => { window.cachedWorkerTool = document.querySelector('#worker-panel .tool-card'); });
  const completed = { ...worker, status: 'completed', result: 'Final **verified result**' };
  await f.emit(state([completed]));
  assert.match(await f.cards.first().locator('.worker-card-preview').textContent(), /Final/);
  assert.equal(await f.panel.locator('.response-text strong').textContent(), 'verified result');
  assert(await f.page.evaluate(() => cachedWorkerTool === document.querySelector('#worker-panel .tool-card') && cachedWorkerTool.open));
  assert(!(await f.panel.locator('.worker-transcript').textContent()).includes('Stale partial reply'));
  await f.emit(state([{ ...completed, parts: [...worker.parts, { ...text('answer', completed.result), status: 'completed' }] }]));
  assert.equal(await f.panel.locator('.response-text strong').count(), 1);
  await f.page.getByRole('button', { name: '关闭 Worker 详情' }).click(); await f.cards.first().click();
  assert.equal(await f.panel.locator('.response-text strong').textContent(), 'verified result');
  await f.emit(state([{ ...completed, parts: [] }]));
  assert.equal(await f.panel.locator('.response-text strong').textContent(), 'verified result');
});

test('goal Worker page filters live records, opens details, and clears filters on session changes', async t => {
  const f = await fixture(t), workers = initialWorkers();
  const goalState = state(workers, { mode: 'goal', goal: { objective: '检查项目', criteria: [], notes: [] } });
  await f.emit(goalState);
  await f.page.locator('#goal-view-switcher > summary').click(); await f.page.locator('#goal-tab-workers').click();
  const cards = f.page.locator('#goal-workers-list .worker-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 3);
  await f.page.screenshot({ path: '.cache/goal-workers-page.png' });
  await f.page.setViewportSize({ width: 390, height: 850 });
  assert(await f.page.locator('#goal-panels').evaluate(n => n.scrollWidth <= n.clientWidth));
  await f.page.setViewportSize({ width: 1280, height: 850 });
  await f.page.locator('#goal-workers-search').fill('项目结构');
  assert.equal(await cards.count(), 1); await cards.first().click();
  assert.match(await f.panel.textContent(), /已找到项目入口/);
  workers[0] = { ...workers[0], status: 'completed', parts: [text('done', '项目检查完成')] };
  await f.emit(state(workers, { mode: 'goal', goal: goalState.goal }));
  assert.match(await f.panel.textContent(), /项目检查完成/);
  await f.page.getByRole('button', { name: '关闭 Worker 详情' }).click();
  await f.page.locator('#goal-workers-filter').selectOption('issues');
  assert.equal(await cards.count(), 0); assert.match(await f.page.locator('#goal-workers-empty').textContent(), /没有匹配/);
  await f.page.locator('#goal-workers-filter').selectOption('completed'); assert.equal(await cards.count(), 1);
  await f.emit(state([], { mode: 'goal', goal: goalState.goal, conversation: { id: 'other-goal', title: '其他目标' } }));
  await f.page.locator('#goal-view-switcher > summary').click(); await f.page.locator('#goal-tab-workers').click();
  await f.page.waitForFunction(() => document.getElementById('goal-workers-empty').textContent.includes('开始执行目标'));
  assert.equal(await f.page.locator('#goal-workers-search').inputValue(), '');
  assert.equal(await cards.count(), 0); assert.match(await f.page.locator('#goal-workers-empty').textContent(), /开始执行目标/);
});

test('workers open independent live views and keep tool expansion, root draft and root output intact', async t => {
  const f = await fixture(t), workers = initialWorkers(); await f.emit(state(workers));
  assert.equal(await f.cards.count(), 3); assert.equal(await f.panel.isVisible(), false);
  await f.page.locator('#prompt-input').fill('保留我的后续问题');
  await f.cards.nth(0).click();
  assert.equal(await f.panel.isVisible(), true);
  assert.match(await f.panel.textContent(), /已找到项目入口/);
  assert(!/已找到项目入口/.test(await f.page.locator('#messages').textContent()));
  await f.panel.locator('.tool-card > summary').click();
  await f.page.evaluate(() => { window.savedWorkerTool = document.querySelector('#worker-panel .tool-card'); });
  workers[0].parts[1] = { ...tool, output: tool.output + '\nexport const tested = true;', status: 'completed', endedAt: Date.now() };
  workers[0].parts.push(text('alpha-end', '入口检查完成。'));
  await f.emit(state(workers));
  assert(await f.page.evaluate(() => savedWorkerTool === document.querySelector('#worker-panel .tool-card') && savedWorkerTool.open));
  assert.match(await f.panel.locator('.tool-output').textContent(), /tested/);
  await f.panel.getByRole('button', { name: '打开文件', exact: true }).click();
  const opened = await f.page.evaluate(() => hostMessages.findLast(message => message.action === 'openMessageLink'));
  assert.equal(opened.href, 'src/index.mjs');
  await f.emit({ type: 'uiResult', requestId: opened.requestId, ok: true });
  // Opening the right editor/file tree reduces the conversation webview width.
  await f.page.setViewportSize({ width: 820, height: 850 });
  assert.equal(await f.page.locator('#worker-picker').inputValue(), 'alpha');
  assert(await f.page.evaluate(() => savedWorkerTool === document.querySelector('#worker-panel .tool-card') && savedWorkerTool.open));
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '保留我的后续问题');
  await f.page.setViewportSize({ width: 1280, height: 850 });
  await f.page.locator('#worker-picker').selectOption('beta');
  assert.match(await f.panel.textContent(), /等待子任务检查/); assert(!/入口检查完成/.test(await f.panel.textContent()));
  await f.page.locator('#worker-picker').selectOption('alpha');
  assert(await f.panel.locator('.tool-card').evaluate(element => element.open));
  await f.page.keyboard.press('Escape'); assert.equal(await f.panel.isVisible(), false);
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '保留我的后续问题');
  assert.equal(await f.cards.nth(0).getAttribute('aria-expanded'), 'false');
  assert.equal(await f.cards.nth(0).evaluate(element => element === document.activeElement), true);
});

test('nested workers link to parents, show terminal failures and remain readable after completion', async t => {
  const f = await fixture(t), workers = initialWorkers(); await f.emit(state(workers));
  await f.cards.nth(2).click();
  assert.match(await f.panel.textContent(), /等待开始/);
  await f.panel.locator('.worker-parent').click();
  assert.equal(await f.page.locator('#worker-picker').inputValue(), 'beta');
  workers[1].status = 'failed'; workers[1].error = '测试服务不可用'; workers[2].status = 'interrupted';
  await f.emit(state(workers, { busy: false, execution: { status: 'completed', busy: false, workers, parts: [], activities: [] }, messages: [{ role: 'assistant', text: '已完成检查，测试服务需要进一步处理。' }] }));
  assert.equal(await f.panel.locator('.worker-detail-error').textContent(), '测试服务不可用');
  assert.equal(await f.panel.locator('.worker-detail-heading .worker-status').textContent(), '失败');
  await f.page.locator('#worker-picker').selectOption('leaf');
  assert.match(await f.panel.textContent(), /执行已停止/);
});

test('worker reading position survives stream updates and switching; another conversation closes the view', async t => {
  const f = await fixture(t), workers = initialWorkers();
  workers[0].parts = [text('long', Array.from({ length: 100 }, (_, i) => `记录 ${i}：检查实际文件内容。`).join('\n\n'))];
  await f.emit(state(workers)); await f.cards.nth(0).click();
  await f.panel.locator('.worker-detail-scroll').evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll')); });
  workers[0].parts[0].text += '\n\n新的执行记录。'; await f.emit(state(workers));
  assert.equal(await f.panel.locator('.worker-detail-scroll').evaluate(element => element.scrollTop), 100);
  await f.page.locator('#worker-picker').selectOption('beta'); await f.page.locator('#worker-picker').selectOption('alpha');
  assert.equal(await f.panel.locator('.worker-detail-scroll').evaluate(element => element.scrollTop), 100);
  await f.emit(state([], { conversation: { id: 'another', title: '另一个会话' } }));
  assert.equal(await f.panel.isVisible(), false); assert.equal(await f.cards.count(), 0);
  assert.equal(await f.page.locator('#main-content').evaluate(element => element.inert), false);
});

test('worker view fits narrow and wide windows and remains accessible in dark mode', async t => {
  const f = await fixture(t, 320), workers = initialWorkers(); await f.emit(state(workers)); await f.cards.nth(0).click();
  assert.equal(await f.page.locator('#main-content').evaluate(element => element.inert), true);
  assert(await f.panel.evaluate(element => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth));
  assert(await f.panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await f.page.evaluate(() => { const style = document.createElement('style'); style.nonce = 'worker-panel-test'; style.textContent = ':root { --vscode-foreground:#dedede; --vscode-editor-background:#1f2023; --vscode-descriptionForeground:#a4a6aa; --vscode-panel-border:#393a3d; }'; document.head.append(style); });
  await f.page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); });
  const directory = fileURLToPath(new URL('../../../../../.cache', import.meta.url)); await mkdir(directory, { recursive: true });
  await f.page.screenshot({ path: directory + '/worker-panel-narrow.png' });
  await f.page.setViewportSize({ width: 1280, height: 850 });
  await f.page.waitForFunction(() => !document.getElementById('main-content').inert);
  assert(await f.page.evaluate(() => document.getElementById('main-content').getBoundingClientRect().right <= document.getElementById('worker-panel').getBoundingClientRect().left + 1));
  await f.page.screenshot({ path: directory + '/worker-panel-wide.png' });
  await f.panel.locator('.worker-close').click(); assert.equal(await f.panel.isVisible(), false);
});

test('dragging and keyboard resizing persist width, preserve drafts and clamp to the viewport', async t => {
  const f = await fixture(t), workers = initialWorkers(); await f.emit(state(workers));
  await f.page.locator('#prompt-input').fill('调整面板时保留草稿'); await f.cards.nth(0).click();
  const handle = f.panel.getByRole('separator'), box = await handle.boundingBox();
  await f.page.mouse.move(box.x + 3, box.y + 80); await f.page.mouse.down();
  await f.page.mouse.move(box.x - 137, box.y + 80, { steps: 8 }); await f.page.mouse.up();
  assert.equal(Math.round((await f.panel.boundingBox()).width), 580);
  assert.equal(await handle.getAttribute('aria-valuenow'), '580');
  assert.equal(await f.page.evaluate(() => savedState.workerPanelWidth), 580);
  assert.equal(await f.page.evaluate(() => savedState.drafts.workers.assist), '调整面板时保留草稿');
  await handle.focus(); await f.page.keyboard.press('ArrowLeft');
  assert.equal(Math.round((await f.panel.boundingBox()).width), 596);
  await f.page.keyboard.press('Home'); assert.equal(Math.round((await f.panel.boundingBox()).width), 300);
  await f.page.keyboard.press('End'); assert.equal(Math.round((await f.panel.boundingBox()).width), 800);
  await f.panel.locator('.worker-close').click(); await f.cards.nth(1).click();
  assert.equal(Math.round((await f.panel.boundingBox()).width), 800);
  await f.page.setViewportSize({ width: 640, height: 850 });
  await f.page.waitForFunction(() => document.getElementById('worker-panel').getBoundingClientRect().width === 640);
  await f.page.setViewportSize({ width: 1280, height: 850 });
  await f.page.waitForFunction(() => document.getElementById('worker-panel').getBoundingClientRect().width === 800);
  await handle.dblclick(); assert.equal(Math.round((await f.panel.boundingBox()).width), 440);
  assert.equal(await f.page.evaluate(() => savedState.workerPanelWidth), 440);
  await handle.focus(); await f.page.keyboard.press('ArrowLeft');
  const reopened = await fixture(t, 1280, await f.page.evaluate(() => savedState));
  await reopened.emit(state(workers)); await reopened.cards.nth(0).click();
  assert.equal(Math.round((await reopened.panel.boundingBox()).width), 456);
  assert.equal(await reopened.page.locator('#prompt-input').inputValue(), '调整面板时保留草稿');
  await reopened.page.setViewportSize({ width: 1280, height: 500 });
  await reopened.page.waitForFunction(() => document.getElementById('worker-panel').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom);
});

test('worker can occupy the main space, stream and switch workers, then restore the sidebar width', async t => {
  const f = await fixture(t, 1280, { workerPanelWidth: 580 }), workers = initialWorkers();
  await f.emit(state(workers)); await f.page.locator('#prompt-input').fill('主空间切换时保留草稿'); await f.cards.nth(0).click();
  await f.panel.locator('.tool-card > summary').click();
  await f.page.evaluate(() => { window.savedWorkerTool = document.querySelector('#worker-panel .tool-card'); });
  const more = f.panel.locator('.worker-options-toggle');
  assert.equal(await f.panel.locator('.worker-expand').isVisible(), false);
  await more.click(); await f.page.keyboard.press('Escape');
  assert.equal(await f.panel.isVisible(), true); assert.equal(await f.panel.locator('.worker-expand').isVisible(), false);
  const expand = async () => { await more.click(); await f.panel.locator('.worker-expand').click(); };
  await expand();
  assert.equal(await f.panel.locator('.worker-expand').getAttribute('aria-pressed'), 'true');
  assert.equal(await f.panel.locator('.worker-options').getAttribute('open'), null);
  assert.equal(Math.round((await f.panel.boundingBox()).width), 1280);
  assert.equal(await f.panel.locator('.worker-resize-handle').isVisible(), false);
  assert.equal(await f.page.locator('#main-content').evaluate(element => element.inert), true);
  assert.equal(await f.page.locator('#main-content').isVisible(), false);
  assert.equal(await f.page.locator('.topbar').isVisible(), true);
  workers[0].parts[1] = { ...tool, output: '主空间实时工具输出', status: 'completed' };
  await f.emit(state(workers));
  assert(await f.page.evaluate(() => savedWorkerTool === document.querySelector('#worker-panel .tool-card') && savedWorkerTool.open));
  assert.match(await f.panel.locator('.tool-output').textContent(), /主空间实时工具输出/);
  await f.page.locator('#worker-picker').selectOption('beta'); await f.page.locator('#worker-picker').selectOption('alpha');
  assert.equal(Math.round((await f.panel.boundingBox()).width), 1280);
  assert(await f.panel.locator('.tool-card').evaluate(element => element.open));
  await f.page.setViewportSize({ width: 1440, height: 850 });
  assert.equal(Math.round((await f.panel.boundingBox()).width), 1440);
  const directory = fileURLToPath(new URL('../../../../../.cache', import.meta.url)); await mkdir(directory, { recursive: true });
  await f.page.screenshot({ path: directory + '/worker-panel-expanded.png' });
  await expand();
  assert.equal(Math.round((await f.panel.boundingBox()).width), 580);
  assert.equal(await f.panel.getByRole('separator').isVisible(), true);
  assert.equal(await f.page.locator('#main-content').evaluate(element => element.inert), false);
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '主空间切换时保留草稿');
  assert.equal(await f.page.evaluate(() => savedState.workerPanelWidth), 580);
  await expand(); await f.page.keyboard.press('Escape');
  assert.equal(await f.panel.isVisible(), false); assert.equal(await f.page.locator('#main-content').isVisible(), true);
  assert.equal(await f.cards.nth(0).evaluate(element => element === document.activeElement), true);
  await f.cards.nth(0).click(); assert.equal(Math.round((await f.panel.boundingBox()).width), 580);
  await expand(); await f.emit(state([], { conversation: { id: 'another', title: '另一个会话' } }));
  assert.equal(await f.panel.isVisible(), false); assert.equal(await f.page.locator('#main-content').isVisible(), true);
  assert.equal(await f.page.locator('#main-content').evaluate(element => element.inert), false);
});

const swarmWorkers = () => Array.from({ length: 12 }, (_, i) => ({
  id: `swarm-${i}`, name: `Worker ${i + 1}`, description: ['检查接口和调用链', '实现页面布局与状态', '验证测试和边界条件'][i % 3],
  status: i < 3 ? 'running' : i < 5 ? 'queued' : i === 5 ? 'waiting' : i === 11 ? 'failed' : 'completed',
  createdAt: Date.now() - 65000, ...(i < 3 ? { startedAt: Date.now() - 6000 } : {}),
  parts: i < 3 ? [text(`output-${i}`, `正在处理第 ${i + 1} 个独立任务`)] : [],
  ...(i === 11 ? { error: { message: '测试服务连接失败' } } : {})
}));

test('swarm strip stays above the composer, bounds a large roster and updates parallel output without moving cards', async t => {
  const f = await fixture(t), workers = swarmWorkers(); await f.emit(state(workers));
  assert.equal(await f.cards.count(), 12);
  assert.equal(await f.page.locator('#worker-swarm-status').textContent(), '3 执行 · 2 排队 · 1 等待 · 5 完成 · 1 异常');
  assert.equal(await f.cards.nth(11).locator('.worker-card-preview').textContent(), '测试服务连接失败');
  const roster = f.page.locator('#collaboration-workers'), strip = f.page.locator('#collaboration-worker-list');
  assert((await roster.boundingBox()).height < 58);
  assert.equal(await f.cards.first().locator('.worker-card-footer').isVisible(), false);
  await f.page.locator('#prompt-input').fill('让蜂群继续并行执行');
  await f.page.evaluate(() => { window.firstWorker = document.querySelector('.worker-card'); });
  for (let i = 0; i < 3; i++) workers[i].parts[0].text = `并行输出 ${i + 1}`;
  await f.emit(state(workers));
  assert(await f.page.evaluate(() => firstWorker === document.querySelector('.worker-card')));
  for (let i = 0; i < 3; i++) assert.equal(await f.cards.nth(i).locator('.worker-card-preview').textContent(), `并行输出 ${i + 1}`);
  const top = (await roster.boundingBox()).y;
  await f.emit(state(workers, { messages: [{ role: 'assistant', text: '长对话内容\n\n'.repeat(100) }] }));
  await f.page.locator('#conversation').evaluate(element => { element.scrollTop = 0; });
  assert(Math.abs((await roster.boundingBox()).y - top) < 1);
  const stack = await f.page.evaluate(() => {
    const workers = document.getElementById('collaboration-workers').getBoundingClientRect();
    const composer = document.getElementById('prompt-form').getBoundingClientRect();
    return {
      fade: getComputedStyle(document.getElementById('compose-dock'), '::before').content,
      workerBottom: workers.bottom,
      composerTop: composer.y,
      workerZ: getComputedStyle(document.getElementById('collaboration-workers')).zIndex,
    };
  });
  assert.equal(stack.fade, 'none', 'composer fade must not cover the Worker strip');
  assert(stack.workerBottom <= stack.composerTop + 1);
  assert((await roster.boundingBox()).y + (await roster.boundingBox()).height <= (await f.page.locator('#compose-dock').boundingBox()).y + 1);
  assert.equal(await f.page.locator('#worker-overview-toggle').count(), 0);
  assert(await strip.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight <= element.clientHeight + 1));
  await f.cards.nth(2).click();
  workers[0].parts[0].text = '后台 Worker 已更新'; workers[2].parts[0].text = '当前 Worker 正在流式输出'; await f.emit(state(workers));
  assert.match(await f.panel.textContent(), /当前 Worker 正在流式输出/);
  await f.page.locator('#worker-picker').selectOption('swarm-0'); assert.match(await f.panel.textContent(), /后台 Worker 已更新/);
  await f.panel.locator('.worker-close').click();
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '让蜂群继续并行执行');
  const directory = fileURLToPath(new URL('../../../../../.cache', import.meta.url)); await mkdir(directory, { recursive: true });
  await f.page.screenshot({ path: directory + '/worker-swarm-strip.png' });
  await f.page.setViewportSize({ width: 320, height: 700 });
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert((await roster.boundingBox()).height < 58);
  assert(await f.page.locator('#prompt-input').isVisible());
  await f.page.screenshot({ path: directory + '/worker-swarm-narrow.png' });
});

test('swarm scrolls horizontally with the mouse, preserves its position during updates and resets for the next session', async t => {
  const f = await fixture(t), workers = swarmWorkers(); await f.emit(state(workers));
  const strip = f.page.locator('#collaboration-worker-list');
  await strip.hover(); await f.page.mouse.wheel(0, 450);
  await f.page.waitForFunction(() => document.getElementById('collaboration-worker-list').scrollLeft > 0);
  const left = await strip.evaluate(element => element.scrollLeft);
  workers[0].status = 'completed'; workers[0].finishedAt = Date.now(); await f.emit(state(workers));
  assert.equal(await strip.evaluate(element => element.scrollLeft), left);
  assert.equal(await f.cards.count(), 12);
  await f.cards.first().click();
  assert.equal(await f.panel.locator('.worker-detail-heading .worker-status').textContent(), '已完成');
  await f.page.keyboard.press('Escape');
  assert(await f.cards.first().evaluate(element => element === document.activeElement));
  await f.cards.last().click(); assert.match(await f.panel.textContent(), /测试服务连接失败/);
  await f.emit(state(initialWorkers(), { conversation: { id: 'new-swarm' } }));
  assert.equal(await f.panel.isVisible(), false);   assert.equal(await f.cards.count(), 3);
  assert.equal(await strip.evaluate(element => element.scrollLeft), 0);
});

test('worker cards surface priority for coordinator-managed tasks', async t => {
  const f = await fixture(t);
  const workers = [
    { id: 'critical', name: '关键路径', description: '先做这项', status: 'queued', depth: 1, priority: 9, parts: [] },
    { id: 'background', name: '背景任务', description: '稍后即可', status: 'running', depth: 1, priority: 0, startedAt: Date.now(), parts: [text('bg', '正在运行')] },
  ];
  await f.emit(state(workers));
  await f.page.locator('#route-loading').waitFor({ state: 'hidden' });
  assert.equal(await f.cards.nth(0).getAttribute('data-priority'), '9');
  assert.equal(await f.cards.nth(0).locator('.worker-priority').textContent(), 'P9');
  assert.equal(await f.cards.nth(1).locator('.worker-priority').textContent(), '');
  await f.cards.first().click();
  assert.match(await f.panel.locator('.worker-status').textContent(), /排队中 · P9/);
});
