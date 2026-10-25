import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../../../.cache', import.meta.url));
const start = Date.now();
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const lead = { name: 'lead', role: 'lead', status: 'running', description: '协调团队并汇总结果', updatedAt: start };
const alice = { name: 'alice', role: 'teammate', status: 'running', context: 'fork', description: '实现后端服务与测试', activity: { label: 'team_task_update', status: 'running', at: start }, updatedAt: start };
const bob = { name: 'bob', role: 'teammate', status: 'inactive', context: 'fresh', description: '等待分配任务' };
const team = (overrides = {}) => ({
  revision: 3,
  roster: [lead, alice, bob],
  tasks: [{ id: 'task-1', revision: 2, subject: '实现协作服务', description: '实现团队服务与任务板。', status: 'in_progress', ownerName: 'alice', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }],
  ...overrides
});
const toolPart = (id, name, args, output, overrides = {}) => ({
  id, type: 'tool', name, args: JSON.stringify(args), output: typeof output === 'string' ? output : JSON.stringify(output),
  status: 'completed', startedAt: start, endedAt: start + 1000, ...overrides
});
const textPart = (id, text, status = 'completed') => ({ id, type: 'text', text, status, startedAt: start, endedAt: start + 500 });
const thinkingPart = (id, text, overrides = {}) => ({ id, type: 'thinking', text, status: 'completed', startedAt: start, endedAt: start + 800, ...overrides });
const userEntry = { id: 'entry-user', role: 'user', text: '请检查 Worker 的流式事件顺序。\n确认中断后记录依旧完整。', timestamp: start };
const assistantEntry = {
  id: 'entry-assistant', role: 'assistant', text: '已完成检查，**顺序正确**。', timestamp: start + 900,
  parts: [
    thinkingPart('part-thinking', '先核对 **Worker 配置**，再检查流式事件。'),
    textPart('part-answer', '已完成检查，**顺序正确**。'),
    toolPart('part-tool', 'read_workspace_file', { path: 'src/harness/worker/index.mjs' }, 'export const order = 1;')
  ]
};
const teamWatch = (overrides = {}) => ({
  name: 'alice', role: 'teammate', status: 'running', description: '实现后端服务与测试',
  activity: { label: 'team_task_update', status: 'running', at: start },
  running: true,
  history: { entries: [userEntry, assistantEntry], omitted: 0 },
  live: { parts: [], streamText: '' },
  updatedAt: start,
  ...overrides
});
// Long synthetic histories for the progressive-rendering tests. Odd entries are
// tool-rich assistant turns (the entries whose synchronous render actually
// costs), so a frame budget must spread the older tail over several frames.
const bigEntry = (count, prefix = 'big') => {
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      entries.push({ id: `${prefix}-user-${i}`, role: 'user', text: `第 ${i} 条任务消息：请继续检查并汇报。` });
      continue;
    }
    entries.push({
      id: `${prefix}-assistant-${i}`, role: 'assistant', text: `第 ${i} 条回复：检查完成。`,
      parts: [
        thinkingPart(`${prefix}-think-${i}`, `先核对第 ${i} 组事件顺序。`),
        textPart(`${prefix}-text-${i}`, `第 ${i} 条回复：检查完成。`),
        toolPart(`${prefix}-tool-${i}-0`, 'read_workspace_file', { path: `src/module-${i}.mjs` }, `export const ok${i} = true;\n`),
        toolPart(`${prefix}-tool-${i}-1`, 'search_workspace', { query: `case-${i}` }, `found ${i} matches`)
      ]
    });
  }
  return entries;
};
function state(execution = {}, overrides = {}) {
  const { team: teamValue = team(), ...rest } = execution;
  return {
    type: 'state', mode: 'assist', conversation: { id: 'team-member-view-test', title: '团队协作' },
    messages: [{ role: 'user', text: '请安排 alice 检查 Worker。' }], goal: null,
    context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    ...overrides,
    execution: {
      status: 'running', busy: true, parts: [], streamText: '', activities: [],
      ...(teamValue === undefined ? {} : { team: teamValue }),
      ...rest,
      ...(overrides.execution || {})
    }
  };
}
const watchState = (watch, overrides = {}) => state({ teamWatch: watch }, overrides);

async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://team-member-view.test/') requests.push(request.url()); });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'team-member-view-test' });
  await page.route('http://team-member-view.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://blocked-team-member.invalid/**', route => route.abort());
  await page.goto('http://team-member-view.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paint = async () => { await frames(); await page.waitForTimeout(8); await frames(); };
  const emit = async value => { await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), value); await paint(); };
  // Dispatch without waiting a frame: the message handler is synchronous, so the
  // next evaluate sees exactly the state the first paint produced.
  const dispatch = value => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), value);
  const toggle = page.locator('#team-toggle');
  const panel = page.locator('#team-panel');
  const view = page.locator('#team-member-view');
  const openPanel = async () => { await toggle.click(); await paint(); };
  const selectMember = async name => {
    await openPanel();
    await panel.locator('.team-member').filter({ hasText: name }).first().click();
    await paint();
  };
  const watchMessages = () => page.evaluate(() => window.hostMessages.filter(message => message && message.action === 'watchTeamMember'));
  const activeId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || '');
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the webview must not throw browser errors');
    assert.deepEqual(requests, [], 'the teammate view must not fetch remote resources');
  });
  return { page, emit, dispatch, frames, paint, toggle, panel, view, openPanel, selectMember, watchMessages, activeId };
}

test('clicking a teammate opens the view, posts watchTeamMember and shows loading', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  assert.equal(await f.view.isVisible(), true, 'the teammate conversation view opens');
  assert.equal(await f.panel.isVisible(), false, 'selecting a member closes the team popover');
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await f.page.evaluate(() => document.getElementById('assist-mode').dataset.teamMember), 'true');
  assert.equal(await f.page.locator('#conversation').isVisible(), false, 'the main conversation is hidden');
  assert.equal(await f.page.locator('#prompt-form').isVisible(), false, 'the composer is hidden');
  assert.equal(await f.page.locator('#team-member-view-name').textContent(), 'alice');
  assert.equal(await f.page.locator('.team-member-view-breadcrumb').textContent(), '团队/alice');
  assert.equal(await f.page.locator('.team-member-view-hint').textContent(), '消息由主 Agent 协调');
  assert.equal(await f.page.locator('#team-member-view-loading').isVisible(), true);
  assert.equal(await f.page.locator('#team-member-view-loading').textContent(), '正在读取 alice 的会话…');
  assert.equal(await f.page.locator('#team-member-view-history .team-member-message').count(), 0, 'nothing is rendered before the watch snapshot');
  assert.equal(await f.activeId(), 'team-member-back', 'opening moves focus to the back button');
  const messages = await f.watchMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].name, 'alice');
  assert.equal(messages[0].sessionId, 'team-member-view-test');
  assert.match(messages[0].requestId, /^ui-/);
  // Live updates do not rebuild the reading surface: the view stays open.
  await f.emit(watchState(teamWatch()));
  assert.equal(await f.view.isVisible(), true);
  assert.equal(await f.page.locator('#team-member-view-loading').isVisible(), false);
});

test('history, tool/thinking cards, omitted notice, tokens, narrow layout and locale', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  await f.emit(watchState(teamWatch({ history: { entries: [userEntry, assistantEntry], omitted: 3 } })));
  const rows = f.page.locator('#team-member-view-history .team-member-message');
  assert.equal(await rows.count(), 2);
  const userRow = f.page.locator('#team-member-view-history .team-member-message-user').first();
  assert.equal(await userRow.getAttribute('data-entry-role'), 'user');
  const bubble = userRow.locator('.team-member-message-text');
  assert.equal(await bubble.textContent(), userEntry.text, 'user text is preserved as plain text');
  assert.equal(await bubble.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap', 'newlines are preserved');
  assert.match(await userRow.evaluate(element => getComputedStyle(element).justifyContent), /flex-end/, 'user bubbles sit on the trailing edge');
  const assistantRow = f.page.locator('#team-member-view-history .team-member-message-assistant').first();
  assert.equal(await assistantRow.getAttribute('data-entry-id'), 'entry-assistant');
  assert.equal(await assistantRow.locator('.message-text').count(), 1);
  assert.match(await assistantRow.locator('.response-text strong').first().textContent(), /顺序正确/);
  assert.equal(await f.page.locator('#team-member-view-history .thinking-card').count(), 1, 'thinking cards keep their behavior');
  assert.equal(await f.page.locator('#team-member-view-history .tool-card').count(), 1, 'tool cards keep their behavior');
  assert.equal(await f.page.locator('#team-member-view-history .tool-title').textContent(), '读取文件');
  assert.match(await f.page.locator('#team-member-view-history .tool-path').textContent(), /src\/harness\/worker\/index\.mjs/);
  assert.equal(await f.page.locator('#team-member-view-omitted').isVisible(), true);
  assert.equal(await f.page.locator('#team-member-view-omitted').textContent(), '已省略 3 条更早的会话记录。');
  assert.equal(await f.page.locator('#team-member-view-status-text').textContent(), '运行中');
  assert.equal(await f.page.locator('#team-member-view-status').getAttribute('data-status'), 'running');
  assert.equal(await f.page.locator('#team-member-view-status').getAttribute('data-live'), 'true');
  assert.equal(await f.page.locator('#team-member-view-live').isVisible(), true);
  assert.match(await f.page.locator('#team-member-view-activity').textContent(), /更新任务 · 进行中/);
  assert.equal(await f.page.locator('#team-member-view-description').textContent(), '实现后端服务与测试');

  // DSH tokens: the same elements recolour in dark mode without layout change.
  const read = () => f.page.evaluate(() => {
    const root = document.getElementById('team-member-view');
    return {
      background: getComputedStyle(root).backgroundColor,
      color: getComputedStyle(root).color,
      bubble: getComputedStyle(document.querySelector('#team-member-view .team-member-message-user .team-member-message-text')).backgroundColor
    };
  });
  const light = await read();
  assert.notEqual(light.background, 'rgba(0, 0, 0, 0)');
  assert.notEqual(light.bubble, 'rgba(0, 0, 0, 0)');
  await f.page.screenshot({ path: screenshotDirectory + '/team-member-view-light.png' });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.paint();
  const dark = await read();
  assert.notEqual(dark.background, light.background, 'dark mode swaps the DSH base surface');
  assert.notEqual(dark.color, light.color, 'dark mode swaps the label token');
  await f.page.screenshot({ path: screenshotDirectory + '/team-member-view-dark.png' });

  await f.page.setViewportSize({ width: 420, height: 820 }); await f.paint();
  assert.equal(await f.view.isVisible(), true, 'the view survives a resize');
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 420 && document.body.scrollWidth <= 420));
  assert(await f.page.evaluate(() => document.getElementById('team-member-view').scrollWidth <= 420));
  assert(await f.page.evaluate(() => document.querySelector('#team-member-view-history .tool-card').scrollWidth <= 420));
  const box = await f.view.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 420);
  await f.page.screenshot({ path: screenshotDirectory + '/team-member-view-narrow.png' });

  // Reduced motion removes the live pulse, never the status text.
  await f.page.emulateMedia({ reducedMotion: 'reduce' }); await f.paint();
  assert.equal(await f.page.locator('#team-member-view-live').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await f.page.locator('#team-member-view-status-text').textContent(), '运行中', 'status is never color-only');
  await f.page.emulateMedia({ reducedMotion: 'no-preference' });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.page.setViewportSize({ width: 1100, height: 820 }); await f.paint();

  // English locale re-renders the header, status, hint and state copy.
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  await f.paint();
  assert.equal(await f.page.locator('#team-member-back').textContent(), 'Main chat');
  assert.equal(await f.page.locator('#team-member-view-role').textContent(), 'Teammate');
  assert.equal(await f.page.locator('#team-member-view-status-text').textContent(), 'Running');
  assert.equal(await f.page.locator('.team-member-view-hint').textContent(), 'Messages are coordinated by the Main Agent');
  assert.equal(await f.page.locator('#team-member-view-omitted').textContent(), '3 earlier conversation entries are not shown.');
  await f.page.locator('#team-member-back').click(); await f.paint();
  await f.selectMember('bob');
  assert.equal(await f.page.locator('#team-member-view-loading').textContent(), 'Loading the conversation for bob…');
  await f.emit(watchState(teamWatch({ name: 'bob', status: 'inactive', running: false, history: { entries: [], omitted: 0 }, live: { parts: [], streamText: '' } })));
  assert.equal(await f.page.locator('#team-member-view-empty').textContent(), 'This teammate has no conversation yet.');
});

test('live streaming grows in place and settles without rebuilding the live entry', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  await f.emit(watchState(teamWatch({
    history: { entries: [userEntry], omitted: 0 },
    live: { parts: [], streamText: '正在检查事件' }
  })));
  const live = f.page.locator('#team-member-view-history [data-entry-id="live"]');
  assert.equal(await live.count(), 1);
  assert.equal(await live.getAttribute('data-streaming'), 'true');
  assert.match(await live.textContent(), /正在检查事件/);
  await f.page.evaluate(() => { window.savedLive = document.querySelector('#team-member-view-history [data-entry-id="live"]'); });
  await f.emit(watchState(teamWatch({
    history: { entries: [userEntry], omitted: 0 },
    live: { parts: [textPart('live-text', '正在检查事件顺序，稍后汇总。', 'streaming')], streamText: '正在检查事件顺序，稍后汇总。' }
  })));
  assert.equal(await f.page.evaluate(() => document.querySelector('#team-member-view-history [data-entry-id="live"]') === window.savedLive), true, 'the live entry element is reused across ticks');
  assert.match(await live.textContent(), /稍后汇总/);
  await f.emit(watchState(teamWatch({
    status: 'inactive', running: false,
    history: { entries: [userEntry, { id: 'entry-final', role: 'assistant', text: '检查完成，顺序正确。', parts: [textPart('final-answer', '检查完成，顺序正确。')] }], omitted: 0 },
    live: { parts: [], streamText: '' }
  })));
  assert.equal(await f.page.locator('#team-member-view-history [data-entry-id="live"]').count(), 0, 'the settled snapshot is published as history');
  assert.equal(await f.page.locator('#team-member-view-status').getAttribute('data-status'), 'inactive');
  assert.equal(await f.page.locator('#team-member-view-status').getAttribute('data-live'), 'false');
  assert.match(await f.page.locator('#team-member-view-history .team-member-message').last().textContent(), /检查完成，顺序正确/);
});

test('back and Escape close, clear the watch and restore focus; session switch closes too', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  await f.emit(watchState(teamWatch()));
  await f.page.locator('#team-member-back').click(); await f.paint();
  assert.equal(await f.view.isVisible(), false);
  assert.equal(await f.page.evaluate(() => document.getElementById('assist-mode').dataset.teamMember), undefined);
  assert.equal(await f.page.locator('#conversation').isVisible(), true, 'the main conversation returns');
  assert.equal(await f.page.locator('#prompt-form').isVisible(), true);
  assert.equal(await f.activeId(), 'team-toggle', 'focus returns to the team trigger');
  let messages = await f.watchMessages();
  assert.equal(messages.at(-1).name, null, 'back sends watchTeamMember name:null');
  assert.equal(messages.at(-1).sessionId, 'team-member-view-test');

  await f.selectMember('alice');
  await f.emit(watchState(teamWatch()));
  await f.page.keyboard.press('Escape'); await f.paint();
  assert.equal(await f.view.isVisible(), false);
  assert.equal(await f.page.locator('#assist-mode').isVisible(), true);
  messages = await f.watchMessages();
  assert.equal(messages.at(-1).name, null, 'Escape sends watchTeamMember name:null');
  assert.equal(await f.page.locator('#team-member-view-history .team-member-message').count(), 0, 'closed view releases its entries');

  await f.selectMember('alice');
  await f.emit(watchState(teamWatch()));
  assert.equal(await f.view.isVisible(), true);
  await f.emit(state({}, { conversation: { id: 'another-session', title: '另一个会话' }, messages: [] }));
  assert.equal(await f.view.isVisible(), false, 'switching sessions closes the member view');
  assert.equal(await f.page.evaluate(() => document.getElementById('assist-mode').dataset.teamMember), undefined);
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length >= 2, true);
  assert.equal(clears.some(message => message.sessionId === 'team-member-view-test'), true, 'the clear targets the session that owned the watch');
});

test('teammate rows are keyboard-selectable buttons; the Lead row is a non-selectable no-op', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.openPanel();
  const row = f.panel.locator('.team-member').filter({ hasText: 'alice' }).first();
  assert.equal(await row.getAttribute('role'), 'button');
  assert.equal(await row.getAttribute('tabindex'), '0');
  assert.equal(await row.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await row.getAttribute('aria-controls'), 'team-member-view');
  assert.equal(await row.getAttribute('aria-label'), '查看 alice 的会话');
  assert.equal(await row.evaluate(element => element.classList.contains('team-member-selectable')), true);
  const leadRow = f.panel.locator('.team-member[data-current="true"]');
  assert.equal(await leadRow.getAttribute('role'), null, 'the Lead row is not a button');
  assert.equal(await leadRow.getAttribute('tabindex'), null);
  assert.equal(await leadRow.getAttribute('aria-haspopup'), null);
  await row.focus();
  await f.page.keyboard.press('Enter'); await f.paint();
  assert.equal(await f.view.isVisible(), true, 'Enter selects the teammate');
  assert.equal(await f.panel.isVisible(), false);
  assert.equal(await f.activeId(), 'team-member-back');
  await f.emit(watchState(teamWatch()));

  // The Lead row never opens the view; from a watched member it returns home.
  await f.openPanel();
  assert.equal(await f.panel.locator('.team-member').filter({ hasText: 'lead' }).count(), 1);
  await leadRow.click(); await f.paint();
  assert.equal(await f.view.isVisible(), false, 'clicking the Lead returns to the main conversation');
  assert.equal(await f.panel.isVisible(), false);
  const messages = await f.watchMessages();
  assert.equal(messages.at(-1).name, null);
  assert.deepEqual(messages.filter(message => message.name === 'lead'), [], 'no watch request is posted for the Lead');
  await f.openPanel();
  await leadRow.click(); await f.paint();
  assert.equal(await f.view.isVisible(), false, 'the Lead row does not open the view');
});

test('loading, error with retry, empty and running-empty states are explicit', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  assert.equal(await f.page.locator('#team-member-view-loading').isVisible(), true, 'absence of teamWatch means loading, not empty');

  const requestId = await f.page.evaluate(() => window.hostMessages.filter(message => message.action === 'watchTeamMember').at(-1).requestId);
  await f.emit({
    type: 'uiResult', requestId, ok: false,
    failure: { code: 'OPERATION_FAILED', message: '读取该成员的会话失败，请重试。' }
  });
  assert.equal(await f.page.locator('#team-member-view-error').isVisible(), true, 'a uiResult failure shows the error state');
  assert.match(await f.page.locator('#team-member-view-error-text').textContent(), /读取该成员的会话失败/);
  assert.equal(await f.page.locator('#team-member-view-retry').isVisible(), true);
  assert.equal(await f.page.locator('#team-member-view-loading').isVisible(), false);

  const beforeRetry = (await f.watchMessages()).length;
  await f.page.locator('#team-member-view-retry').click(); await f.paint();
  assert.equal(await f.page.locator('#team-member-view-loading').isVisible(), true, 'retry returns to loading');
  const afterRetry = await f.watchMessages();
  assert.equal(afterRetry.length, beforeRetry + 1);
  assert.equal(afterRetry.at(-1).name, 'alice');

  await f.emit(watchState(teamWatch({ name: 'alice', status: 'running', running: true, history: { entries: [], omitted: 0 }, live: { parts: [], streamText: '' } })));
  assert.equal(await f.page.locator('#team-member-view-empty').isVisible(), true);
  assert.equal(await f.page.locator('#team-member-view-empty').textContent(), '等待该成员开始执行…');

  await f.emit(watchState(teamWatch({ status: 'inactive', running: false, history: { entries: [], omitted: 0 }, live: { parts: [], streamText: '' } })));
  assert.equal(await f.page.locator('#team-member-view-empty').textContent(), '该成员还没有会话记录。');

  await f.emit(watchState(teamWatch({ status: 'inactive', running: false, history: { entries: [userEntry], omitted: 0 }, live: { parts: [], streamText: '' } })));
  assert.equal(await f.page.locator('#team-member-view-empty').isVisible(), false, 'history clears the empty state');

  // A member creation/turn failure is a non-blocking note, not a blocked view.
  await f.emit(watchState(teamWatch({
    status: 'failed', running: false, error: '模型连接失败：请求被上游拒绝',
    history: { entries: [userEntry], omitted: 0 }, live: { parts: [], streamText: '' }
  })));
  assert.equal(await f.page.locator('#team-member-view-member-error').isVisible(), true);
  assert.match(await f.page.locator('#team-member-view-member-error').textContent(), /模型连接失败/);
  assert.equal(await f.page.locator('#team-member-view-history .team-member-message').count(), 1, 'history remains readable after a member failure');
  assert.equal(await f.page.locator('#team-member-view-status').getAttribute('data-status'), 'failed');
  assert.equal(await f.page.locator('#team-member-view-status-text').textContent(), '失败');
});

// ---------------------------------------------------------------------------
// Progressive history rendering (>12 entries): newest six sync, older ones fill
// in above the tail within a per-frame budget, indicator while loading.
// ---------------------------------------------------------------------------
const historyIds = page => page.evaluate(() =>
  [...document.querySelectorAll('#team-member-view-history article.team-member-message')]
    .map(row => row.getAttribute('data-entry-id')));
const fillFacts = page => page.evaluate(() => {
  const fill = document.getElementById('team-member-view-fill');
  return { hidden: fill.hidden, text: fill.textContent };
});

test('long member history paints newest six first, then fills older entries in order', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const entries = bigEntry(20, 'progressive');
  const ids = entries.map(entry => entry.id);
  await f.page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await f.page.evaluate(async message => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    // State commits paint on the next animation frame; this resolves right after
    // that paint and before the queued progressive fill frame runs.
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      ids: [...document.querySelectorAll('#team-member-view-history article.team-member-message')].map(row => row.getAttribute('data-entry-id')),
      fillHidden: document.getElementById('team-member-view-fill').hidden,
      fillText: document.getElementById('team-member-view-fill').textContent,
      fillAnimation: getComputedStyle(document.getElementById('team-member-view-fill'), '::before').animationName
    };
  }, watchState(teamWatch({ history: { entries, omitted: 0 } })));
  assert.deepEqual(first.ids, ids.slice(-6), 'only the newest six entries paint on the first update');
  assert.equal(first.fillHidden, false, 'the fill indicator is visible while older entries load');
  assert.equal(first.fillText, '正在载入较早的记录…');
  assert.equal(first.fillAnimation, 'none', 'the indicator animation respects reduced motion');
  await f.page.emulateMedia({ reducedMotion: 'no-preference' });
  await f.page.waitForFunction(count =>
    document.querySelectorAll('#team-member-view-history article.team-member-message').length === count,
  entries.length, { timeout: 5000 });
  const done = await f.page.evaluate(() => ({
    ids: [...document.querySelectorAll('#team-member-view-history article.team-member-message')].map(row => row.getAttribute('data-entry-id')),
    fillHidden: document.getElementById('team-member-view-fill').hidden,
    thinkingCards: document.querySelectorAll('#team-member-view-history .thinking-card').length,
    toolCards: document.querySelectorAll('#team-member-view-history .tool-card').length,
    loadingVisible: document.getElementById('team-member-view-loading').getClientRects().length > 0
  }));
  assert.deepEqual(done.ids, ids, 'every entry is present exactly once in transcript order');
  assert.equal(done.fillHidden, true, 'the fill indicator hides once the transcript is complete');
  assert.equal(done.thinkingCards, 10, 'assistant history keeps its thinking cards');
  assert.equal(done.toolCards, 20, 'assistant history keeps its tool cards');
  assert.equal(done.loadingVisible, false, 'the loading surface is replaced by the transcript');
  // English locale translates the static indicator copy.
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  assert.deepEqual(await fillFacts(f.page), { hidden: true, text: 'Loading earlier messages…' });
});

test('histories of at most twelve entries still render synchronously without a fill', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const entries = bigEntry(12, 'short');
  const first = await f.page.evaluate(async message => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      ids: [...document.querySelectorAll('#team-member-view-history article.team-member-message')].map(row => row.getAttribute('data-entry-id')),
      count: document.querySelectorAll('#team-member-view-history article.team-member-message').length,
      fillHidden: document.getElementById('team-member-view-fill').hidden
    };
  }, watchState(teamWatch({ history: { entries, omitted: 0 } })));
  assert.equal(first.count, 12, 'a short history paints synchronously in the first update');
  assert.deepEqual(first.ids, entries.map(entry => entry.id));
  assert.equal(first.fillHidden, true, 'no fill indicator is shown for short histories');
});

test('a reader scrolled up keeps the visual anchor while older entries fill above', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const entries = bigEntry(20, 'anchor');
  const ids = entries.map(entry => entry.id);
  // Dispatch, wait for the first paint, then put the reader into the middle of
  // the painted tail before the queued fill frames run. Everything below runs in
  // one page task so per-frame fill batches are observed without round-trip gaps.
  const observed = await f.page.evaluate(async payload => {
    window.dispatchEvent(new MessageEvent('message', { data: payload.message }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const scroll = document.getElementById('team-member-view-scroll');
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll'));
    scroll.scrollTop = Math.max(8, Math.round(scroll.scrollHeight * 0.15));
    scroll.dispatchEvent(new Event('scroll'));
    const rows = () => [...document.querySelectorAll('#team-member-view-history article.team-member-message')];
    const anchor = rows()[1] || rows()[0];
    const anchorId = anchor.getAttribute('data-entry-id');
    const batches = [];
    for (let frame = 0; frame < 180; frame++) {
      const before = { count: rows().length, top: anchor.getBoundingClientRect().top };
      await new Promise(resolve => requestAnimationFrame(resolve));
      const after = { count: rows().length, top: anchor.getBoundingClientRect().top };
      if (after.count !== before.count) batches.push({ inserted: after.count - before.count, moved: after.top - before.top });
      if (after.count === payload.count) break;
    }
    return {
      anchorId,
      batches,
      ids: rows().map(row => row.getAttribute('data-entry-id')),
      fillHidden: document.getElementById('team-member-view-fill').hidden,
      atBottom: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 32
    };
  }, { message: watchState(teamWatch({ history: { entries, omitted: 0 } })), count: entries.length });
  assert.notEqual(observed.anchorId, ids[ids.length - 1], 'the anchor is not the newest entry');
  assert.deepEqual(observed.ids, ids, 'the anchored fill still completes in transcript order');
  assert.equal(observed.fillHidden, true);
  assert.ok(observed.batches.length >= 1, 'the anchor was checked across at least one prepended batch');
  for (const batch of observed.batches) {
    assert.ok(Math.abs(batch.moved) <= 1.5,
      `the anchored row must not move while ${batch.inserted} older entries are prepended (moved ${batch.moved.toFixed(2)}px)`);
  }
  assert.equal(observed.atBottom, false, 'a reader who scrolled up is not snapped back to the end');
});

// ---------------------------------------------------------------------------
// Steady-state ticks: a cached history signature skips the render pass.
// ---------------------------------------------------------------------------
test('an unchanged history signature skips re-rendering while header and live update', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const entries = bigEntry(40, 'signature');
  await f.dispatch(watchState(teamWatch({ history: { entries, omitted: 0 } })));
  await f.page.waitForFunction(() =>
    document.getElementById('team-member-view-history')?.children.length === 40, undefined, { timeout: 5000 });
  await f.page.evaluate(() => {
    const original = window.UBOVMMessage;
    window.__memberUpdates = 0;
    window.__rows = [...document.querySelectorAll('#team-member-view-history article.team-member-message')];
    window.UBOVMMessage = {
      ...original,
      update: (element, ...args) => {
        if (element?.closest?.('#team-member-view')) window.__memberUpdates += 1;
        return original.update(element, ...args);
      }
    };
  });
  await f.emit(watchState(teamWatch({
    history: { entries, omitted: 0 },
    description: '签名缓存命中后的头部更新',
    activity: { label: 'team_task_update', status: 'running', at: start }
  })));
  const skipped = await f.page.evaluate(() => ({
    updates: window.__memberUpdates,
    sameRows: [...document.querySelectorAll('#team-member-view-history article.team-member-message')]
      .every((row, index) => row === window.__rows[index]),
    rowCount: document.querySelectorAll('#team-member-view-history article.team-member-message').length,
    description: document.getElementById('team-member-view-description').textContent
  }));
  assert.equal(skipped.updates, 0, 'an identical history must not re-render any message body');
  assert.equal(skipped.sameRows, true, 'the existing entry DOM nodes are retained');
  assert.equal(skipped.rowCount, 40);
  assert.equal(skipped.description, '签名缓存命中后的头部更新', 'the header still updates on every tick');

  // A live-only tick updates exactly the live entry, on its existing node.
  await f.emit(watchState(teamWatch({
    history: { entries, omitted: 0 },
    live: { parts: [textPart('signature-live', '实时补充', 'streaming')], streamText: '实时补充' }
  })));
  const liveOnly = await f.page.evaluate(() => ({
    updates: window.__memberUpdates,
    sameRows: window.__rows.every((row, index) =>
      row === document.querySelectorAll('#team-member-view-history article.team-member-message')[index]),
    liveText: document.querySelector('#team-member-view-history [data-entry-id="live"]')?.textContent || ''
  }));
  assert.equal(liveOnly.updates, 1, 'only the live entry is re-rendered by a live tick');
  assert.equal(liveOnly.sameRows, true, 'history rows are untouched by a live tick');
  assert.match(liveOnly.liveText, /实时补充/);

  // Long transcripts opt into offscreen containment.
  const dense = await f.page.evaluate(() => {
    const history = document.getElementById('team-member-view-history');
    return {
      marker: history.classList.contains('is-long'),
      contentVisibility: getComputedStyle(history.querySelector('article.team-member-message')).contentVisibility
    };
  });
  assert.equal(dense.marker, true, 'more than 30 rendered messages mark the transcript as long');
  assert.equal(dense.contentVisibility, 'auto', 'long transcripts contain their offscreen turns');
});

// ---------------------------------------------------------------------------
// Cancellation: close and history replacement drop a pending progressive fill.
// ---------------------------------------------------------------------------
test('closing the view cancels a pending progressive fill', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const pending = await f.page.evaluate(async message => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const count = document.querySelectorAll('#team-member-view-history article.team-member-message').length;
    const fillHidden = document.getElementById('team-member-view-fill').hidden;
    // Close synchronously before the queued fill frame gets a chance to run.
    document.getElementById('team-member-back').click();
    return { count, fillHidden };
  }, watchState(teamWatch({ history: { entries: bigEntry(24, 'cancel'), omitted: 0 } })));
  assert.equal(pending.count, 6, 'the first update painted the newest six entries');
  assert.equal(pending.fillHidden, false, 'the fill was still pending before closing');
  assert.equal(await f.view.isVisible(), false);
  assert.equal(await f.page.evaluate(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length), 0);
  for (let frame = 0; frame < 8; frame++) await f.frames();
  assert.equal(await f.page.evaluate(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length), 0,
    'a cancelled fill must not repopulate the closed view');
});

test('a replacement history cancels the pending fill and restarts from its newest entries', async t => {
  const f = await fixture(t);
  await f.emit(state());
  await f.selectMember('alice');
  const older = bigEntry(20, 'replaced-old');
  const replacement = bigEntry(18, 'replaced-new');
  const ids = replacement.map(entry => entry.id);
  const replaced = await f.page.evaluate(async ([first, second]) => {
    const read = () => [...document.querySelectorAll('#team-member-view-history article.team-member-message')]
      .map(row => row.getAttribute('data-entry-id'));
    window.dispatchEvent(new MessageEvent('message', { data: first }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const afterFirst = read();
    window.dispatchEvent(new MessageEvent('message', { data: second }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { afterFirst, afterSecond: read(), fillHidden: document.getElementById('team-member-view-fill').hidden };
  }, [watchState(teamWatch({ history: { entries: older, omitted: 0 } })), watchState(teamWatch({ history: { entries: replacement, omitted: 0 } }))]);
  assert.deepEqual(replaced.afterFirst, older.slice(-6).map(entry => entry.id), 'the first history paints its newest six entries');
  assert.deepEqual(replaced.afterSecond, ids.slice(-6), 'a replacement repaints from its own newest six entries');
  assert.equal(replaced.fillHidden, false, 'the replacement fills its older entries too');
  await f.page.waitForFunction(count =>
    document.querySelectorAll('#team-member-view-history article.team-member-message').length === count,
  ids.length, { timeout: 5000 });
  assert.deepEqual(await historyIds(f.page), ids, 'the replacement transcript fills completely in order');
  assert.equal((await fillFacts(f.page)).hidden, true);
});

