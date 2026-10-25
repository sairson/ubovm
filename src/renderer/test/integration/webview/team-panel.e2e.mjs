// End-to-end verification for the assist-mode Agent Teams panel (team-verify).
//
// Independent of team-ui's own integration suite: this file drives the real
// rendered webview bundle (renderWebview) in headless Edge, mocks the VS Code
// host bridge, projects realistic `execution.team` snapshots and asserts the
// DOM contract from .tmp-team/contract.md (trigger, roster, task board, a11y,
// focus, live updates, dark theme, 420px narrow layout, no page/network errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://team-panel-e2e.test/';
const startedAt = Date.now();
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const lead = () => ({
  name: 'lead', role: 'lead', status: 'running', description: '协助会话主 Agent：拆分任务并汇总结果',
  activity: { label: '协调团队成员', status: 'running', at: startedAt - 1000 },
  createdAt: startedAt - 60000, updatedAt: startedAt - 1000
});
const reviewer = () => ({
  name: 'reviewer', role: 'teammate', status: 'running', context: 'fork',
  description: '审查协作模块的执行代码与状态投影', activity: { label: '读取执行代码', status: 'running', at: startedAt - 500 },
  createdAt: startedAt - 9000, updatedAt: startedAt - 500
});
const tester = () => ({
  name: 'tester', role: 'teammate', status: 'inactive', context: 'fork',
  description: '编写并运行回归测试，采集截图证据', activity: { label: '已完成回归测试报告', status: 'completed', at: startedAt - 30000 },
  createdAt: startedAt - 8000, updatedAt: startedAt - 30000
});
const deployer = () => ({
  name: 'deployer', role: 'teammate', status: 'failed', context: 'fresh',
  description: '部署验证与回滚检查',
  error: '启动失败：模型连接在首次请求时中断（ECONNRESET）。请检查 provider 配置后重新创建团队成员。',
  activity: { label: '启动失败', status: 'failed', at: startedAt - 40000 },
  createdAt: startedAt - 20000, updatedAt: startedAt - 40000
});
const task = (id, overrides = {}) => ({
  id, revision: 1, subject: id, description: '任务描述', status: 'pending',
  blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...overrides
});
const tasks = () => [
  task('task-1', { subject: '梳理协作模块接口', description: '列出 createTeam / team tools 的接口边界与事件顺序。', writeScopes: ['src/harness/agents/collaboration/'] }),
  task('task-2', { subject: '实现团队状态投影', description: '在 harness-service 中接收 team.status 与 team.member.event，维护 entry.team 并输出完整快照。需要覆盖状态只存快照、activity 只保留最近一步，不得把完整 transcript 写进视图。', blockedBy: ['task-1'], ready: false, writeScopes: ['src/harness/ide/runtime/harness-service.cjs'] }),
  task('task-3', { subject: '审查执行代码改动', description: '确认错误码、CAS 行为、abort 清理和持久化顺序。', status: 'in_progress', ownerName: 'reviewer' }),
  task('task-4', { subject: '回归测试与截图验证', description: '运行相关测试并采集浅色、深色与窄屏截图。', status: 'completed', ownerName: 'tester' })
];
const team = (overrides = {}) => ({ revision: 7, roster: [lead(), reviewer(), tester(), deployer()], tasks: tasks(), ...overrides });
const message = (id, text) => ({ id, role: 'user', text });
function state(teamValue, overrides = {}) {
  const { execution: executionOverrides, ...rest } = overrides;
  const execution = {
    status: 'running', busy: true, parts: [], streamText: '', activities: [],
    ...(teamValue !== undefined ? { team: teamValue } : {}),
    ...(executionOverrides || {})
  };
  return {
    type: 'state', mode: 'assist', conversation: { id: 'team-panel-e2e', title: '协作团队审查' },
    messages: [message('user-1', '请组建一个团队，审查协作模块的实现并补齐回归测试。')],
    goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' },
    busy: true, ...rest, execution
  };
}

async function fixture(t, { width = 1100, height = 820 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  const pageErrors = [];
  const consoleErrors = [];
  const remoteRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url + ' (failed)');
  });
  await page.addInitScript(({ now }) => {
    window.fixtureNow = now;
    Date.now = () => window.fixtureNow;
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState() {},
      postMessage: value => { window.hostMessages.push(value); }
    });
  }, { now: startedAt });
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'team-panel-e2e-test' })
  }));
  await page.route('https://blocked-team.invalid/**', route => route.abort());
  await page.goto(origin);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => {
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), value);
    await frames();
  };
  // First paint: the webview stays in its loading shell until a host state arrives.
  await emit(state(undefined));
  await page.waitForFunction(() => document.body.dataset.loading === 'false', undefined, { timeout: 8000 });
  t.after(async () => {
    await page.close();
    assert.deepEqual(pageErrors, [], 'the Team panel must not throw page errors');
    assert.deepEqual(consoleErrors, [], 'the Team panel must not log console errors');
    assert.deepEqual(remoteRequests, [], 'the Team panel must not request remote resources');
  });
  const toggle = page.locator('#team-toggle');
  const panel = page.locator('#team-panel');
  return { page, emit, frames, toggle, panel };
}

const openPanel = async (f, trigger = f.toggle) => {
  await trigger.click();
  await f.panel.waitFor({ state: 'visible' });
  await f.frames();
  return f.panel;
};
const memberCard = (f, name) => f.panel.locator('.team-member', { has: f.page.locator('.team-member-name-text', { hasText: new RegExp('^' + name + '$') }) });
const taskCard = (f, subject) => f.panel.locator('.team-task', { hasText: subject });

const panelFacts = f => f.page.evaluate(() => {
  const panel = document.getElementById('team-panel');
  const trigger = document.getElementById('team-toggle');
  const count = document.getElementById('team-count');
  const rect = panel.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  return {
    panelHidden: panel.hidden,
    panelRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
    triggerRect: { right: triggerRect.right, bottom: triggerRect.bottom },
    expanded: trigger.getAttribute('aria-expanded'),
    controls: trigger.getAttribute('aria-controls'),
    triggerTitle: trigger.getAttribute('title'),
    triggerLabel: trigger.getAttribute('aria-label'),
    triggerHidden: trigger.hidden,
    countText: count.textContent,
    countHidden: count.hidden,
    triggerAfterNotes: Boolean(document.getElementById('assist-notes-toggle')?.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING),
    role: panel.getAttribute('role'),
    ariaLabel: panel.getAttribute('aria-label'),
    live: panel.getAttribute('aria-live'),
    tabIndex: panel.tabIndex,
    activeId: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  };
});

// ---------------------------------------------------------------------------
// 1. Trigger visibility + teammate count
// ---------------------------------------------------------------------------
test('the team trigger is hidden without a team and shows the teammate count when one exists', async t => {
  const f = await fixture(t);
  assert.equal((await panelFacts(f)).triggerHidden, true, 'no execution.team must keep the trigger hidden');
  await f.emit(state(undefined));
  assert.equal((await panelFacts(f)).triggerHidden, true, 're-emitting no team keeps the trigger hidden');

  await f.emit(state(team()));
  const facts = await panelFacts(f);
  assert.equal(facts.triggerHidden, false, 'a roster with teammates must show #team-toggle');
  assert.equal(facts.countText, '3', '#team-count must show roster length - 1 teammates');
  assert.equal(facts.countHidden, false);
  assert.equal(facts.expanded, 'false', 'the trigger starts collapsed');
  assert.equal(facts.controls, 'team-panel');
  assert.equal(facts.triggerTitle, '团队成员与任务板');
  assert.equal(facts.triggerLabel, '团队成员与任务板');
  assert.equal(facts.triggerAfterNotes, true, '#team-toggle must follow #assist-notes-toggle in the topbar');

  // Tasks alone (no teammates yet) still surface the trigger but not a count.
  await f.emit(state({ revision: 8, roster: [lead()], tasks: [task('task-9', { subject: '仅任务板' })] }));
  const solo = await panelFacts(f);
  assert.equal(solo.triggerHidden, false, 'a task board without teammates must still show the trigger');
  assert.equal(solo.countHidden, true, 'with no teammates the count badge must stay hidden');
});

// ---------------------------------------------------------------------------
// 2. Open by click, roster + board rendering, accessibility, placement
// ---------------------------------------------------------------------------
test('clicking the trigger opens an accessible dialog with the roster and task board', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  const facts = await panelFacts(f);

  assert.equal(facts.panelHidden, false);
  assert.equal(facts.expanded, 'true', 'aria-expanded must report the open state');
  assert.equal(facts.role, 'dialog', '#team-panel must be role=dialog');
  assert.equal(facts.ariaLabel, '团队');
  assert.equal(facts.live, 'polite', 'the open panel must announce updates with aria-live=polite');
  assert.equal(facts.tabIndex, -1, 'the panel must be programmatically focusable');
  assert.equal(facts.activeId, 'team-panel', 'opening the panel moves focus into it');

  // Popover geometry: below the trigger, right-aligned, inside the viewport.
  assert(facts.panelRect.top >= facts.triggerRect.bottom, `panel top ${facts.panelRect.top} must sit below the trigger bottom ${facts.triggerRect.bottom}`);
  assert(facts.panelRect.left >= 0 && facts.panelRect.right <= facts.innerWidth + 1, 'panel must stay inside the viewport');
  assert(facts.panelRect.width <= 480, `panel width ${facts.panelRect.width} must be capped at 480px`);
  assert(facts.panelRect.height <= 640, `panel height ${facts.panelRect.height} must be capped at 640px`);

  assert.equal(await f.panel.locator('.team-roster .team-member').count(), 4);
  assert.equal(await f.panel.locator('.team-tasks .team-task').count(), 4);
  assert.equal(await f.panel.locator('.team-roster-section .team-section-title').textContent(), '成员');
  assert.equal(await f.panel.locator('.team-roster-section .team-section-count').textContent(), '4');
  assert.equal(await f.panel.locator('.team-tasks-section .team-section-title').textContent(), '任务');
  assert.equal(await f.panel.locator('.team-tasks-section .team-section-count').textContent(), '4');
  // Regression: the roster card for the Lead must not be a button (no navigation in v1).
  assert.equal(await f.panel.locator('.team-member').first().evaluate(node => node.closest('button') !== null), false);
});

// ---------------------------------------------------------------------------
// 3. Escape close + focus return (opened from the keyboard)
// ---------------------------------------------------------------------------
test('Escape closes the panel and returns focus to the trigger', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.toggle.focus();
  await f.page.keyboard.press('Enter');
  await f.panel.waitFor({ state: 'visible' });
  await f.frames();
  assert.equal((await panelFacts(f)).expanded, 'true', 'the trigger must open from the keyboard too');
  await f.page.keyboard.press('Escape');
  await f.frames();
  const facts = await panelFacts(f);
  assert.equal(facts.panelHidden, true, 'Escape must close the panel');
  assert.equal(facts.expanded, 'false');
  assert.equal(facts.live, null, 'aria-live must be removed while closed');
  assert.equal(facts.activeId, 'team-toggle', 'Escape must return focus to the trigger');
});

// ---------------------------------------------------------------------------
// 4. Outside pointerdown close
// ---------------------------------------------------------------------------
test('a pointerdown outside the panel closes it', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  const panel = await openPanel(f);
  const rect = await panel.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; });
  const x = Math.max(8, rect.left - 40);
  const y = Math.min(800, rect.top + 40);
  await f.page.mouse.click(x, y);
  await f.frames();
  const facts = await panelFacts(f);
  assert.equal(facts.panelHidden, true, `a pointerdown at ${x},${y} outside the panel must close it`);
  assert.equal(facts.expanded, 'false');
});

// ---------------------------------------------------------------------------
// 5. Live roster/task update while open
// ---------------------------------------------------------------------------
test('an open panel updates live from a new state without closing or losing focus', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  await f.page.evaluate(() => { window.__lead = document.querySelector('#team-panel .team-member[data-current="true"]'); window.__panel = document.getElementById('team-panel'); });
  assert.equal((await memberCard(f, 'reviewer').locator('.team-member-status').textContent()), '运行中');

  const updatedRoster = [
    lead(), { ...reviewer(), status: 'inactive', activity: { label: '审查完成', status: 'completed', at: startedAt } },
    { ...tester(), status: 'running', activity: { label: '运行回归测试', status: 'running', at: startedAt } }
  ];
  const updatedTasks = [
    task('task-1', { subject: '梳理协作模块接口', status: 'completed', ownerName: 'reviewer', revision: 2 }),
    task('task-2', { subject: '实现团队状态投影', ready: true, blockedBy: [], revision: 2 }),
    task('task-3', { subject: '审查执行代码改动', status: 'in_progress', ownerName: 'reviewer', revision: 2 }),
    task('task-4', { subject: '回归测试与截图验证', status: 'completed', ownerName: 'tester', revision: 5 }),
    task('task-5', { subject: '补充团队面板文档', description: '新增协作团队一节。' })
  ];
  await f.emit(state({ revision: 9, roster: updatedRoster, tasks: updatedTasks }));
  await f.frames();
  const facts = await panelFacts(f);

  assert.equal(facts.panelHidden, false, 'a live state update must not close the open panel');
  assert.equal(facts.expanded, 'true');
  assert.equal(facts.activeId, 'team-panel', 'focus must stay inside the open panel across state updates');
  assert.equal(await f.panel.locator('.team-roster .team-member').count(), 3, 'removed teammates must disappear');
  assert.equal(await f.panel.locator('.team-roster-section .team-section-count').textContent(), '3');
  assert.equal(await f.panel.locator('.team-tasks .team-task').count(), 5, 'new tasks must appear live');
  assert.equal(await f.panel.locator('.team-tasks-section .team-section-count').textContent(), '5');
  assert.equal(await f.panel.locator('.team-member', { hasText: 'deployer' }).count(), 0, 'the failed teammate was removed from the new snapshot');
  assert.equal(await memberCard(f, 'reviewer').locator('.team-member-status').textContent(), '未运行');
  assert.equal(await memberCard(f, 'tester').locator('.team-member-status').textContent(), '运行中');
  assert.match(await memberCard(f, 'tester').locator('.team-member-activity').textContent(), /运行回归测试.*进行中/);
  assert.match(await taskCard(f, '梳理协作模块接口').locator('.team-task-status').textContent(), /已完成/);
  assert.equal(await taskCard(f, '实现团队状态投影').getAttribute('data-ready'), 'true', 'a live update must flip the blocked task to ready');
  assert.equal(await taskCard(f, '补充团队面板文档').count(), 1, 'newly created tasks must render');
  // Unchanged roster rows are reconciled, not rebuilt (stable DOM identity).
  const reused = await f.page.evaluate(() => window.__lead === document.querySelector('#team-panel .team-member[data-current="true"]') && window.__panel === document.getElementById('team-panel'));
  assert.equal(reused, true, 'the panel and unchanged member cards must be reconciled in place');
});

// ---------------------------------------------------------------------------
// 6. Failed member error text
// ---------------------------------------------------------------------------
test('failed teammates show their error text and failed status', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  const card = memberCard(f, 'deployer');
  assert.equal(await card.count(), 1);
  assert.equal(await card.getAttribute('data-status'), 'failed');
  assert.equal(await card.locator('.team-member-status').textContent(), '失败');
  assert.equal(await card.locator('.team-member-dot').getAttribute('data-state'), 'error');
  const error = card.locator('.team-member-error');
  assert.equal(await error.isVisible(), true, 'the failed error line must be visible');
  assert.match(await error.textContent(), /启动失败.*ECONNRESET/, 'the error detail must be rendered, not hidden');
  // Status is announced as text, not only by color.
  assert.match(await card.locator('.team-member-text').textContent(), /失败/);
});

// ---------------------------------------------------------------------------
// 7. Task readiness: blocked pending vs ready pending vs in progress / done
// ---------------------------------------------------------------------------
test('task cards distinguish ready, dependency-blocked, in-progress and completed states', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);

  const ready = taskCard(f, '梳理协作模块接口');
  assert.equal(await ready.getAttribute('data-status'), 'pending');
  assert.equal(await ready.getAttribute('data-ready'), 'true');
  assert.equal(await ready.locator('.team-task-state').getAttribute('data-state'), 'idle');
  assert.equal(await ready.locator('.team-task-status').textContent(), '可开始');
  assert.equal(await ready.locator('.team-task-owner').textContent(), '负责人：未认领');

  const blocked = taskCard(f, '实现团队状态投影');
  assert.equal(await blocked.getAttribute('data-ready'), 'false');
  assert.equal(await blocked.locator('.team-task-state').getAttribute('data-state'), 'warning');
  assert.equal(await blocked.locator('.team-task-status').textContent(), '被依赖阻塞');
  assert.equal(await blocked.locator('.team-task-blocked').textContent(), '依赖：task-1');
  assert.equal(await blocked.locator('.team-task-dot').getAttribute('data-state'), 'warning');

  const ongoing = taskCard(f, '审查执行代码改动');
  assert.equal(await ongoing.locator('.team-task-state').getAttribute('data-state'), 'ongoing');
  assert.equal(await ongoing.locator('.team-task-status').textContent(), '进行中');
  assert.equal(await ongoing.locator('.team-task-owner').textContent(), '负责人：reviewer');

  const done = taskCard(f, '回归测试与截图验证');
  assert.equal(await done.locator('.team-task-state').getAttribute('data-state'), 'done');
  assert.equal(await done.locator('.team-task-status').textContent(), '已完成');
  assert.equal(await done.locator('.team-task-owner').textContent(), '负责人：tester');
  // The task id and write scopes are part of the card metadata.
  assert.equal(await ongoing.locator('.team-task-id').textContent(), 'task-3');
  assert.match(await ready.locator('.team-task-scopes').textContent(), /写入范围：src\/harness\/agents\/collaboration\//);
});

// ---------------------------------------------------------------------------
// 8. Empty task board copy
// ---------------------------------------------------------------------------
test('an empty task board shows the dedicated empty copy', async t => {
  const f = await fixture(t);
  await f.emit(state({ revision: 3, roster: [lead(), reviewer()], tasks: [] }));
  await openPanel(f);
  const empty = f.panel.locator('.team-empty');
  assert.equal(await empty.isVisible(), true);
  assert.equal(await empty.textContent(), '任务板为空。主 Agent 创建任务后会显示在这里。');
  assert.equal(await f.panel.locator('.team-tasks-section .team-section-count').textContent(), '0');
  assert.equal(await f.panel.locator('.team-tasks .team-task').count(), 0);
});

// ---------------------------------------------------------------------------
// 9. Dark theme token parity
// ---------------------------------------------------------------------------
test('the panel follows the dark theme tokens', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  const read = () => f.page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('team-panel'));
    const heading = getComputedStyle(document.querySelector('#team-panel .team-section-heading'));
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, headingColor: heading.color };
  });
  const light = await read();
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames();
  const dark = await read();
  assert.equal(await f.page.evaluate(() => document.body.classList.contains('vscode-dark')), true);
  assert.equal((await panelFacts(f)).panelHidden, false, 'theme changes must not close the panel');
  assert.notDeepEqual(dark, light, 'panel colors must change with the dark theme tokens');
  assert.notEqual(dark.background, light.background, 'panel surface must use the dark token');
  assert.notEqual(dark.color, light.color, 'panel label color must follow the dark token');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
});

// ---------------------------------------------------------------------------
// 10. 420px narrow layout
// ---------------------------------------------------------------------------
test('the panel fits a 420px viewport without horizontal overflow', async t => {
  const f = await fixture(t, { width: 420, height: 820 });
  await f.emit(state(team()));
  await openPanel(f);
  const facts = await panelFacts(f);
  assert.equal(facts.documentScrollWidth, 420, `document scrollWidth ${facts.documentScrollWidth} must equal the 420px viewport`);
  assert(facts.bodyScrollWidth <= 420, `body scrollWidth ${facts.bodyScrollWidth} must not overflow 420px`);
  assert(facts.panelRect.left >= 0 && facts.panelRect.right <= 420 + 1, `panel [${facts.panelRect.left}, ${facts.panelRect.right}] must stay inside the 420px viewport`);
  assert(facts.panelRect.width <= 420 - 24 + 1, `panel width ${facts.panelRect.width} must be capped at viewport - 24px`);
  const columns = await f.page.evaluate(() => getComputedStyle(document.querySelector('#team-panel .team-roster')).gridTemplateColumns);
  assert.equal(columns.trim().split(/\s+/).length, 1, `the roster must be a single column at 420px (got ${columns})`);
  const toggleFacts = await f.page.evaluate(() => ({
    labelDisplay: getComputedStyle(document.querySelector('#team-toggle .team-toggle-label')).display,
    countHidden: document.getElementById('team-count').hidden,
    countText: document.getElementById('team-count').textContent
  }));
  assert.equal(toggleFacts.labelDisplay, 'none', 'the narrow topbar keeps only the icon for the team trigger');
  assert.equal(toggleFacts.countHidden, false, 'the teammate count stays visible on narrow widths');
  assert.equal(toggleFacts.countText, '3');
  // Every rendered card stays inside the panel body.
  const overflow = await f.page.evaluate(() => {
    const panel = document.getElementById('team-panel');
    const limit = panel.getBoundingClientRect().right + 1;
    return [...panel.querySelectorAll('.team-member, .team-task')]
      .filter(node => node.getBoundingClientRect().right > limit).length;
  });
  assert.equal(overflow, 0, 'no member/task card may overflow the panel at 420px');
});

// ---------------------------------------------------------------------------
// 11. Mode switch closes the panel; session switch cannot keep it open
// ---------------------------------------------------------------------------
test('switching mode closes the panel and hides the trigger outside assist mode', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  await f.emit(state(team(), { mode: 'goal', conversation: { id: 'team-panel-e2e', title: '目标' } }));
  await f.frames();
  const facts = await panelFacts(f);
  assert.equal(facts.panelHidden, true, 'switching to goal mode must close the team panel');
  assert.equal(facts.triggerHidden, true, 'the team trigger belongs to assist mode only');
});

// ---------------------------------------------------------------------------
// 12. Malformed team payloads must not break the panel
// ---------------------------------------------------------------------------
test('malformed team payloads are downgraded without page errors and recover on the next state', async t => {
  const f = await fixture(t);
  await f.emit(state({ revision: 1, roster: 'bad', tasks: {} }));
  assert.equal((await panelFacts(f)).triggerHidden, true, 'a malformed team payload must not advertise a panel');
  await f.emit(state(team()));
  assert.equal((await panelFacts(f)).triggerHidden, false, 'a valid snapshot after a malformed one must restore the trigger');
  await openPanel(f);
  assert.equal(await f.panel.locator('.team-roster .team-member').count(), 4);
});

// ---------------------------------------------------------------------------
// 14. Team tool calls render as labelled conversation cards
// ---------------------------------------------------------------------------
test('team tool calls render as labelled, compact conversation cards', async t => {
  const f = await fixture(t);
  const parts = [
    {
      id: 'team-call-spawn', type: 'tool', name: 'spawn_teammate',
      args: '{"name":"reviewer","context":"fork","task":"审查执行代码"}',
      output: '{"member":{"name":"reviewer","status":"provisioning"}}',
      status: 'completed', startedAt: startedAt - 5000, endedAt: startedAt - 4000
    },
    {
      id: 'team-call-task', type: 'tool', name: 'team_task_update',
      args: '{"task_id":"task-1","status":"completed","expectedRevision":1}',
      output: '{"id":"task-1","status":"completed"}',
      status: 'completed', startedAt: startedAt - 3000, endedAt: startedAt - 2500
    },
    {
      id: 'team-call-wait', type: 'tool', name: 'wait_agent',
      args: '{"target":"reviewer","timeout_ms":60000}',
      output: '{"noProgress":true}',
      status: 'completed', startedAt: startedAt - 2000, endedAt: startedAt - 1500
    }
  ];
  await f.emit(state(team(), { execution: { parts } }));
  await f.frames();
  const cards = f.page.locator('#messages .tool-card');
  assert.equal(await cards.count(), 3, 'each team tool call must render a conversation tool card');
  const snapshot = await cards.evaluateAll(nodes => nodes.map(node => ({
    title: node.querySelector('.tool-title')?.textContent || '',
    path: node.querySelector('.tool-path')?.textContent || '',
    aria: node.querySelector('.tool-card-summary')?.getAttribute('aria-label') || ''
  })));
  assert.equal(snapshot[0].title, '创建团队成员');
  assert.match(snapshot[0].path, /reviewer/, 'spawn_teammate must name its target');
  assert.equal(snapshot[1].title, '更新任务');
  assert.match(snapshot[1].path, /task-1/, 'team_task_update must name the task it changed');
  assert.equal(snapshot[2].title, '等待团队进展');
  assert.match(snapshot[2].path, /没有可等待的成员/, 'wait_agent must summarise its outcome instead of echoing JSON');
  for (const card of snapshot) {
    assert.doesNotMatch(card.aria, /\{"|"task_id"|"expectedRevision"/, 'tool summaries must not echo raw JSON arguments');
  }
});

// ---------------------------------------------------------------------------
// 13. prefers-reduced-motion keeps status readable without pulsing
// ---------------------------------------------------------------------------
test('reduced motion disables the status pulses but keeps textual states', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await openPanel(f);
  const motion = await f.page.evaluate(() => {
    const member = document.querySelector('#team-panel .team-member[data-status="running"] .team-member-dot');
    const task = document.querySelector('#team-panel .team-task[data-status="in_progress"] .team-task-dot');
    return {
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      member: getComputedStyle(member, '::after').animationName,
      task: getComputedStyle(task).animationName,
      memberState: member.getAttribute('data-state'),
      taskState: task.getAttribute('data-state')
    };
  });
  assert.equal(motion.reduced, true, 'the fixture must run with prefers-reduced-motion: reduce');
  assert.equal(motion.member, 'none', `the running member pulse must be disabled (got ${motion.member})`);
  assert.equal(motion.task, 'none', `the in-progress task pulse must be disabled (got ${motion.task})`);
  assert.equal(motion.memberState, 'ongoing');
  assert.equal(motion.taskState, 'ongoing');
  assert.match(await f.panel.locator('.team-member[data-status="running"] .team-member-status').first().textContent(), /运行中/);
  assert.match(await f.panel.locator('.team-task[data-status="in_progress"] .team-task-status').textContent(), /进行中/);
});
