import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const { renderWebview } = require('../../../host/ui/webview.cjs');
const initialState = () => ({
  type: 'state', mode: 'goal', conversation: { id: 'goal-notes-1', title: '重构探索工作台' },
  messages: [], provider: { label: '测试模型', connected: true }, context: { workspace: 'UBOVM' }, busy: false,
  goal: { objective: '让探索工作台中的记录更容易查找与继续', criteria: [], notes: [
    { id: 'n1', text: '已确认：笔记和 Agent 记录需要区分来源。', createdAt: '2026-09-22T08:30:00Z' },
    { id: 'n2', text: '下一步\n检查窄屏下的输入体验，保留正在编辑的草稿。', createdAt: '2026-09-22T09:00:00Z' }
  ] }, execution: { status: 'idle', memory: { notes: [{ content: '检查结果：笔记页面可以独立浏览，无需滚动到页面底部再记录。', created_at: '2026-09-22T09:05:00Z' }] } }
});
async function send(page, data) {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('all agent notes remain searchable beyond fifty entries', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
  await page.route('http://notes-all.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'notes-all' }) }));
  await page.goto('http://notes-all.test/');
  const state = { ...initialState(), mode: 'assist', goal: undefined };
  state.execution.memory.notes = Array.from({ length: 65 }, (_, index) => ({ id: `note-${index}`, content: index === 0 ? '最早的记录仍然存在' : `记录 ${index}` }));
  await send(page, state);
  await page.locator('#assist-notes-toggle').click(); await paint(page);
  assert.equal(await page.locator('#notes-total').textContent(), '65 条记录');
  await page.locator('#notes-search').fill('最早');
  assert.equal(await page.locator('#agent-notes-list article:visible').count(), 1);
  await page.locator('#agent-notes-list article:visible .note-select').click();
  assert.equal((await page.locator('#note-reader-body').textContent()).trim(), '最早的记录仍然存在');
  await page.locator('#assist-notes-toggle').click(); await paint(page);
  await page.locator('#assist-notes-toggle').click(); await paint(page);
  assert.equal((await page.locator('#note-reader-body').textContent()).trim(), '最早的记录仍然存在');
});

test('new notes retain existing buttons and focus, and failed formatting retries on selection', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close()); const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ getState: () => ({ drafts: { 'goal-notes-1': { view: 'notes' } } }), setState() {}, postMessage() {} });
  });
  await page.route('http://notes-retry.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'notes-retry' }) }));
  await page.goto('http://notes-retry.test/');
  const state = initialState(); state.goal.notes[1].text = '**可恢复笔记**';
  await send(page, state);
  await page.evaluate(() => { window.savedButton = document.querySelector('#goal-notes-list .note-select'); savedButton.focus(); });
  state.goal.notes.push({ id: 'n3', text: '新增笔记', createdAt: '2026-09-22T10:00:00Z' });
  await send(page, state);
  assert(await page.evaluate(() => savedButton === document.querySelectorAll('#goal-notes-list .note-select')[1] && document.activeElement === savedButton));
  await page.evaluate(() => {
    document.querySelector('#goal-notes-list .note-select').click();
    window.originalMarkdown = UBOVMMarkdown;
    window.UBOVMMarkdown = { update() { throw new Error('note formatting failure'); } };
    savedButton.click();
  });
  assert.equal(await page.locator('#note-reader-body').textContent(), '**可恢复笔记**');
  await page.evaluate(() => { window.UBOVMMarkdown = originalMarkdown; savedButton.click(); });
  assert.equal(await page.locator('#note-reader-body strong').textContent(), '可恢复笔记');
  assert.deepEqual(errors, []);
});

test('restored and empty goal notebooks keep a visible content area through navigation and live updates', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [390, 834, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        let saved = { drafts: { 'goal-notes-1': { view: 'notes', note: '', assist: '', goalPrompt: '' } } };
        window.acquireVsCodeApi = () => ({ getState: () => saved, setState: value => { saved = value; }, postMessage() {} });
      });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'notebook-navigation' }) }));
      await page.goto('http://notes.test/');
      const state = initialState(); state.goal.notes = []; state.execution = { status: 'idle' };
      state.context = { workspace: 'C:\\Users\\Administrator\\.ubovm\\workspace\\ee06757e-e0e9-463d-955e-49eb5447a3db', workspaceConfigured: true };
      await send(page, state);
      assert.equal(await page.locator('#workspace-name').textContent(), state.context.workspace);
      assert.equal(await page.locator('#workspace-name').locator('..').getAttribute('title'), state.context.workspace + '\n点击切换当前会话的工作空间');
      for (let index = 0; index < 3; index++) {
        await page.locator('#notes-empty').waitFor({ state: 'visible' });
        const rect = await page.locator('.notebook-layout').boundingBox();
        assert(rect && rect.height > 200 && rect.width > 200, 'notebook must occupy usable space, not merely have hidden=false');
        assert(rect.y >= 0 && rect.y + rect.height <= 721, 'the notebook stays inside the visible content area');
        await send(page, { type: 'executionState', conversationId: state.conversation.id, busy: false, execution: { status: 'idle' } });
        assert.equal(await page.locator('#notes-empty').isVisible(), true);
        await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-overview').click(); await paint(page);
        assert.equal(await page.locator('#goal-overview').isVisible(), true);
        await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click(); await paint(page);
      }
      await send(page, initialState());
      await page.locator('#goal-notes-list .note-select').first().click();
      assert.equal(await page.locator('#note-reader-body').isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('goal setup requires the current session workspace before entering the run page', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(value) { window.sent.push(value); } });
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'workspace-test' }) }));
    await page.goto('http://workspace.test/');
    const state = initialState();
    state.goal = null;
    state.context = { workspace: '选择工作空间（必选）', workspaceConfigured: false };
    await send(page, state);
    await page.locator('#goal-objective-input').fill('保留未保存的探索目标');
    assert.equal(await page.locator('#goal-save').isDisabled(), true);
    assert.equal(await page.locator('#goal-workspace-required').isVisible(), true);
    await page.locator('#goal-editor').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => window.sent.some(message => message.action === 'saveGoal')), false);
    assert.equal(await page.locator('#goal-workspace').isVisible(), false);
    state.context = { workspace: 'C:/project', workspaceConfigured: true };
    await send(page, state);
    assert.equal(await page.locator('#goal-objective-input').inputValue(), '保留未保存的探索目标');
    assert.equal(await page.locator('#goal-save').isEnabled(), true);
    await page.locator('#goal-save').click();
    assert.equal(await page.evaluate(() => window.sent.some(message => message.action === 'saveGoal')), true);

    const historical = initialState();
    historical.conversation.id = 'historical-goal';
    historical.context.workspaceConfigured = false;
    await send(page, historical);
    assert.equal(await page.locator('#goal-editor').isVisible(), true);
    assert.equal(await page.locator('#goal-workspace').isVisible(), false);
    assert.equal(await page.locator('#goal-cancel').isVisible(), false);
    assert.equal(await page.locator('#goal-view-switcher').isVisible(), false);
    historical.context.workspaceConfigured = true;
    await send(page, historical);
    assert.equal(await page.locator('#goal-workspace').isVisible(), true);
  } finally { await browser.close(); }
});

test('assist notebook reads live and restored agent notes without losing the conversation draft', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [390, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'assist-notes-test' }) }));
      await page.goto('http://notes.test/');
      const state = { ...initialState(), mode: 'assist', goal: undefined };
      await send(page, state);
      const composer = page.locator('#prompt-input');
      await composer.fill('保留对话草稿');
      await page.locator('#assist-notes-toggle').click(); await paint(page);
      assert.equal(await page.locator('#goal-notes').isVisible(), true);
      assert.equal(await page.locator('#assist-mode').isVisible(), false);
      assert.equal(await page.locator('#note-new').isVisible(), false);
      assert.equal(await page.locator('#notes-total').textContent(), '1 条记录');
      await page.locator('#agent-notes-list .note-select').click();
      assert.match(await page.locator('#note-reader-body').textContent(), /检查结果/);
      assert.equal(await page.locator('#note-copy').isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (width < 700) await page.locator('#note-back').click();
      await send(page, { type: 'executionState', conversationId: state.conversation.id, busy: true,
        execution: { status: 'running', memory: { notes: { one: state.execution.memory.notes[0], two: { content: '新增的协助笔记' } } } } });
      assert.equal(await page.locator('#notes-total').textContent(), '2 条记录');
      await page.locator('#notes-search').fill('新增');
      assert.equal(await page.locator('#agent-notes-list article:visible').count(), 1);
      await page.locator('#assist-notes-toggle').click(); await paint(page);
      assert.equal(await composer.inputValue(), '保留对话草稿');
      assert.equal(await page.locator('#assist-mode').isVisible(), true);
      await send(page, { ...state, conversation: { id: 'assist-empty', title: '空白会话' }, execution: { status: 'idle' } });
      await page.locator('#assist-notes-toggle').click(); await paint(page);
      assert.equal(await page.locator('#notes-search').inputValue(), '');
      assert.equal(await page.locator('#notes-total').textContent(), '0 条记录');
      assert.equal(await page.locator('#notes-empty-title').textContent(), 'Agent 暂无记录');
      await send(page, initialState());
      assert.equal(await page.locator('#assist-notes-toggle').isVisible(), false);
      await page.locator('#goal-view-switcher > summary').click();
      await page.locator('#goal-tab-notes').click(); await paint(page);
      assert.equal(await page.locator('#note-new').isVisible(), true);
      assert.equal(await page.locator('#notes-total').textContent(), '3 条记录');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
test('goal notebook filters sources, retains drafts and only clears an acknowledged save', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [390, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState(value) { window.saved = value; }, postMessage(value) { window.sent.push(value); } }); });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'notes-test' }) }));
      await page.goto('http://notes.test/');
      const state = initialState();
      state.goal.notes[0].text += '\n' + '长篇笔记。'.repeat(250) + '末尾搜索词';
      await send(page, state);
      await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click(); await paint(page);
      assert.equal(await page.locator('#notes-total').textContent(), '3 条记录');
      assert.equal(await page.locator('#goal-prompt-form').isVisible(), false);
      assert.equal(await page.locator('#goal-note-input').isVisible(), false);
      await page.locator('#goal-notes-list .note-select').first().click();
      assert.match(await page.locator('#note-reader-body').textContent(), /下一步/);
      if (width < 700) await page.locator('#note-back').click();
      // Empty filtering used to detach the reader's cached Markdown container.
      // Returning to any note then updated an invisible node indefinitely.
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.locator('#notes-search').fill('没有匹配的内容');
        assert.equal(await page.locator('#notes-empty').isVisible(), true);
        await page.locator('#notes-search').fill('');
        await page.locator('#goal-notes-list .note-select').first().click();
        assert.match(await page.locator('#note-reader-body').textContent(), /下一步/, 'reader recovers after an empty filter');
        assert.equal(await page.locator('#note-reader-body').isVisible(), true);
        if (width < 700) await page.locator('#note-back').click();
      }
      await page.locator('#goal-notes-list .note-select').first().click();
      if (process.env.UBOVM_UI_PREVIEW) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/notes-' + width + '.png' });
      if (process.env.UBOVM_UI_PREVIEW) {
        await page.locator('#goal-view-switcher > summary').click();
        await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/goal-switcher-' + width + '.png' });
        await page.locator('#goal-view-switcher > summary').click();
      }
      if (width < 700) await page.locator('#note-back').click();
      assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.ok(await page.locator('#goal-notes-list .note-select p').evaluateAll(nodes => nodes.every(n => n.textContent.length <= 241)));
      await page.locator('#notes-search').fill('末尾搜索词');
      assert.equal(await page.locator('#goal-notes-list article:visible').count(), 1, 'search includes text beyond the preview');
      await page.locator('#notes-search').press('Escape');
      assert.equal(await page.locator('#notes-search').inputValue(), '');
      assert.equal(await page.locator('#goal-notes-list article:visible').count(), 2);
      await page.locator('#notes-search').fill('确认');
      assert.equal(await page.locator('#goal-notes-list article:visible').count(), 1);
      assert.equal(await page.locator('#agent-notes-section').isVisible(), false);
      await page.locator('[data-note-source="agent"]').click();
      assert.equal(await page.locator('#notes-empty-title').textContent(), '没有找到匹配的笔记');
      await page.locator('#notes-search').fill('');
      assert.equal(await page.locator('#agent-notes-list article:visible').count(), 1);
      const input = page.locator('#goal-note-input');
      const liveNote = { id: 'live', content: '运行中写入的笔记\n\n' + '详细记录\n\n'.repeat(150) };
      const updateNotes = notes => send(page, { type: 'executionState', conversationId: state.conversation.id, busy: true,
        execution: { status: 'running', memory: { notes } } });
      await updateNotes([liveNote]);
      await page.locator('#agent-notes-list .note-select').click();
      assert.match(await page.locator('#note-reader-body').textContent(), /运行中写入的笔记/);
      const scrollTop = await page.locator('#note-reader-body').evaluate(node => { node.scrollTop = 150; return node.scrollTop; });
      assert.ok(scrollTop > 0);
      await updateNotes([{ ...liveNote, content: liveNote.content + '补充内容' }, { id: 'another', content: '另一条新笔记' }]);
      assert.match(await page.locator('#note-reader-body').textContent(), /补充内容/);
      assert.equal(await page.locator('#note-reader-body').evaluate(node => node.scrollTop), scrollTop);
      assert.equal(await page.locator('#goal-notes').getAttribute('data-reading'), 'true');
      assert.equal(await page.locator('#agent-notes-list article').count(), 2);
      if (width < 700) await page.locator('#note-back').click();
      await send(page, { type: 'executionState', conversationId: state.conversation.id, busy: true, execution: { ...state.execution, status: 'running' } });
      await page.locator('#note-new').click();
      assert.equal(await input.isEnabled(), true);
      const editorBox = await page.locator('#note-editor').boundingBox();
      const inputBox = await input.boundingBox();
      assert.ok(inputBox.height > editorBox.height * .55, 'Writing area must occupy most of the editor.');
      await input.fill('任务执行期间写下的草稿');
      if (process.env.UBOVM_UI_PREVIEW) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/note-editor-' + width + '.png' });
      await input.press('Escape');
      assert.equal(await page.locator('#note-editor').isVisible(), false);
      await page.locator('#note-new').click();
      assert.equal(await input.inputValue(), '任务执行期间写下的草稿');
      assert.equal(await page.locator('#goal-add-note').isEnabled(), true, 'notes can be saved while workers are running');
      await input.press('Control+Enter');
      const request = await page.evaluate(() => window.sent.findLast(item => item.action === 'addGoalNote'));
      assert.equal(request.text, '任务执行期间写下的草稿');
      await send(page, { type: 'uiResult', requestId: request.requestId, ok: false, error: '保存失败，请重试' });
      assert.equal(await input.inputValue(), request.text);
      assert.equal(await page.locator('#note-editor-error').isVisible(), true);
      await page.locator('#goal-add-note').click();
      const retry = await page.evaluate(() => window.sent.findLast(item => item.action === 'addGoalNote'));
      await send(page, { type: 'uiResult', requestId: retry.requestId, ok: true });
      assert.equal(await page.locator('#note-editor').isVisible(), false);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('#note-length').textContent(), '0 / 2,000');
      await page.locator('#note-new').click();
      await input.fill('此目标的草稿');
      await page.locator('#note-close').click();
      await page.locator('#notes-search').fill('不存在');
      await send(page, { ...initialState(), conversation: { id: 'goal-notes-2', title: '另一个目标' }, goal: { objective: '另一个目标', criteria: [], notes: [] }, execution: { status: 'idle' } });
      await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click(); await paint(page);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('#notes-search').inputValue(), '');
      assert.equal(await page.locator('#notes-empty').isVisible(), true);
      await send(page, state);
      assert.equal(await input.inputValue(), '此目标的草稿');
      await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-overview').click(); await paint(page);
      assert.equal(await page.locator('#goal-prompt-form').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
