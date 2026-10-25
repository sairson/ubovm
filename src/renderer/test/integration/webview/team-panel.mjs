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

const longDescription = '实现团队服务、任务板与等待机制，并为每一处持久化改动补齐测试；同时核对 Webview 面板、工具卡片和英文文案是否与主对话一致。'
  + '这里再补充一段足够长的说明，用来验证两行截断与展开按钮在真实溢出时才会出现，而不是按字符数猜测。';
const lead = { name: 'lead', role: 'lead', status: 'running', description: '协调团队并汇总结果', updatedAt: start };
const alice = { name: 'alice', role: 'teammate', status: 'running', context: 'fork', description: '实现后端服务与测试', activity: { label: 'team_task_update', status: 'running', at: start }, updatedAt: start };
const bob = { name: 'bob', role: 'teammate', status: 'inactive', context: 'fresh', description: '等待分配任务' };
const task = (id, overrides = {}) => ({
  id, revision: 1, subject: '实现协作服务', description: '实现团队服务与任务板。', status: 'pending',
  blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...overrides
});
const sampleTasks = () => [
  task('task-1', { revision: 2, subject: '实现协作服务', description: longDescription, ownerName: 'alice', writeScopes: ['src/harness/agents/collaboration/team.mjs'] }),
  task('task-2', { subject: '接入 Webview 面板', description: '渲染成员与任务板。', ready: false, blockedBy: ['task-1'], writeScopeWarnings: ['写入范围与 task-1 重叠：src/harness'] }),
  task('task-3', { revision: 3, subject: '补充回归测试', description: '覆盖空状态与失败成员。', status: 'in_progress', ownerName: 'bob', writeScopes: ['src/renderer/test'] }),
  task('task-4', { revision: 4, subject: '准备文档', description: '更新 README。', status: 'completed', ownerName: 'alice' })
];
const team = (overrides = {}) => ({ revision: 3, roster: [lead, alice, bob], tasks: sampleTasks(), ...overrides });

function state(teamValue, overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: 'team-panel-test', title: '团队协作' },
    messages: [{ role: 'user', text: '请安排团队完成这项工作。' }], goal: null,
    context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true, ...overrides,
    execution: {
      status: 'running', busy: true, parts: [], streamText: '', activities: [],
      ...(teamValue === undefined ? {} : { team: teamValue }), ...(overrides.execution || {})
    }
  };
}
const toolPart = (id, name, args, output, overrides = {}) => ({
  id, type: 'tool', name, args: JSON.stringify(args), output: typeof output === 'string' ? output : JSON.stringify(output),
  status: 'completed', startedAt: start, endedAt: start + 1000, ...overrides
});

async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://team-panel.test/') requests.push(request.url()); });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'team-panel-test' });
  await page.route('http://team-panel.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://blocked-team.invalid/**', route => route.abort());
  await page.goto('http://team-panel.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paint = async () => { await frames(); await page.waitForTimeout(20); await frames(); };
  const emit = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value); await paint(); };
  const toggle = page.locator('#team-toggle');
  const panel = page.locator('#team-panel');
  const openPanel = async () => {
    await toggle.click(); await paint();
    await panel.evaluate(element => element.querySelector('.team-panel-body')?.scrollTo(0, 0));
  };
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the webview must not throw browser errors');
    assert.deepEqual(requests, [], 'the team panel must not fetch remote resources');
  });
  return { page, emit, frames, paint, toggle, panel, openPanel };
}
const activeId = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || '');

test('trigger stays hidden without a team, then shows the teammate count and projectable title', async t => {
  const f = await fixture(t);
  assert.equal(await f.toggle.evaluate(element => element.hidden), true, 'no team data means no trigger');
  await f.emit(state(undefined, { busy: false, execution: { status: 'idle', activities: [] } }));
  assert.equal(await f.toggle.isVisible(), false);
  assert.equal(await f.panel.isVisible(), false);

  await f.emit(state(team()));
  assert.equal(await f.toggle.isVisible(), true);
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await f.toggle.getAttribute('aria-controls'), 'team-panel');
  assert.equal(await f.toggle.getAttribute('title'), '团队成员与任务板');
  assert.equal(await f.page.locator('#team-count').textContent(), '2', 'count is teammates, not including the Lead');
  assert.equal(await f.panel.isVisible(), false, 'the panel opens only from the trigger');

  // Lead only, no tasks: nothing to inspect yet.
  await f.emit(state({ revision: 1, roster: [lead], tasks: [] }));
  assert.equal(await f.toggle.isVisible(), false);
  // Tasks but no teammates: still worth opening.
  await f.emit(state({ revision: 2, roster: [lead], tasks: [task('task-9')] }));
  assert.equal(await f.toggle.isVisible(), true);
  assert.equal(await f.page.locator('#team-count').evaluate(element => element.hidden), true);
  assert.equal(await f.panel.locator('.team-task').count(), 1);
});

test('click, Escape and outside pointer close the popover with correct focus handling', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  const dialog = f.page.getByRole('dialog', { name: '团队' });
  await f.toggle.click(); await f.paint();
  assert.equal(await f.panel.isVisible(), true);
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await f.panel.getAttribute('aria-live'), 'polite');
  assert.equal(await dialog.count(), 1);
  assert.equal(await activeId(f.page), await f.panel.getAttribute('id'), 'opening moves focus into the dialog');

  await f.page.keyboard.press('Escape'); await f.paint();
  assert.equal(await f.panel.isVisible(), false);
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await f.panel.getAttribute('aria-live'), null);
  assert.equal(await activeId(f.page), 'team-toggle', 'Escape returns focus to the trigger');

  await f.toggle.click(); await f.paint();
  assert.equal(await f.panel.isVisible(), true);
  await f.page.mouse.click(6, 400); await f.paint();
  assert.equal(await f.panel.isVisible(), false, 'an outside pointer press closes the popover');
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'false');

  // Trigger click is a toggle and must not count as an outside press.
  await f.toggle.click(); await f.paint();
  assert.equal(await f.panel.isVisible(), true);
  await f.toggle.click(); await f.paint();
  assert.equal(await f.panel.isVisible(), false);
});

test('roster shows lead highlight, statuses, activity and failed diagnostics', async t => {
  const f = await fixture(t);
  const failed = { name: 'carol', role: 'teammate', status: 'failed', error: '模型连接失败：请求被上游拒绝', description: '负责代码审计' };
  const provisioning = { name: 'dave', role: 'teammate', status: 'provisioning', description: '正在创建' };
  await f.emit(state(team({ roster: [lead, alice, bob, failed, provisioning] })));
  await f.openPanel();
  const members = f.panel.locator('.team-member');
  assert.equal(await members.count(), 5);
  const leadCard = members.filter({ hasText: 'lead' }).first();
  assert.equal(await leadCard.getAttribute('data-current'), 'true');
  assert.equal(await leadCard.locator('.team-current-tag').textContent(), '主 Agent');
  assert.equal(await leadCard.locator('.team-member-name-text').evaluate(element => /Mono|Consolas|Menlo/.test(getComputedStyle(element).fontFamily)), true, 'member names use the compact code font');
  for (const member of [lead, alice, bob, failed, provisioning]) {
    const card = members.filter({ hasText: member.name }).first();
    assert.equal(await card.getAttribute('data-status'), member.status);
    const status = await card.locator('.team-member-status').textContent();
    assert.equal(status, { running: '运行中', inactive: '未运行', provisioning: '准备中', failed: '失败' }[member.status]);
    const dot = card.locator('.team-member-dot');
    const stateName = { running: 'ongoing', provisioning: 'ongoing', failed: 'error', inactive: 'inactive' }[member.status];
    assert.equal(await dot.getAttribute('data-state'), stateName);
    if (member.status === 'inactive') assert.equal(await dot.locator('svg').count(), 1, 'inactive members use a person icon');
    else assert.equal(await dot.locator('svg').count(), 0);
  }
  const aliceCard = members.filter({ hasText: 'alice' }).first();
  assert.match(await aliceCard.locator('.team-member-activity').textContent(), /更新任务 · 进行中/, 'activity keeps the friendly tool label and status');
  const failedCard = members.filter({ hasText: 'carol' }).first();
  assert.match(await failedCard.locator('.team-member-error').textContent(), /模型连接失败/);
  const bobCard = members.filter({ hasText: 'bob' }).first();
  assert.equal(await bobCard.locator('.team-current-tag').isVisible(), false, 'only the Lead carries the main-agent tag');
  assert.equal(await bobCard.locator('.team-member-description').getAttribute('title'), '等待分配任务');
});

test('task board renders readiness, owners, dependencies, write scopes and warnings', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.openPanel();
  const cards = f.panel.locator('.team-task');
  assert.equal(await cards.count(), 4);
  const statuses = await f.panel.locator('.team-task-status').allTextContents();
  assert.deepEqual(statuses, ['可开始', '被依赖阻塞', '进行中', '已完成']);
  assert.deepEqual(await f.panel.locator('.team-task').evaluateAll(nodes => nodes.map(node => [node.dataset.status, node.dataset.ready])), [
    ['pending', 'true'], ['pending', 'false'], ['in_progress', 'true'], ['completed', 'true']
  ]);
  assert.deepEqual(await f.panel.locator('.team-task-dot').evaluateAll(nodes => nodes.map(node => node.dataset.state)), ['idle', 'warning', 'ongoing', 'done']);

  const first = cards.nth(0);
  assert.match(await first.locator('.team-task-owner').textContent(), /负责人：alice/);
  assert.match(await first.locator('.team-task-scopes').textContent(), /写入范围：src\/harness\/agents\/collaboration\/team\.mjs/);
  assert.equal(await first.locator('.team-task-blocked').evaluate(element => element.hidden), true);
  const second = cards.nth(1);
  assert.match(await second.locator('.team-task-blocked').textContent(), /依赖：task-1/);
  assert.match(await second.locator('.team-task-warnings').textContent(), /写入范围与 task-1 重叠/);
  const third = cards.nth(2);
  assert.match(await third.locator('.team-task-owner').textContent(), /负责人：bob/);
  const unowned = await f.page.evaluate(() => {
    const article = [...document.querySelectorAll('#team-panel .team-task')].find(node => node.textContent.includes('task-2'));
    return article.querySelector('.team-task-owner').textContent;
  });
  assert.match(unowned, /未认领/);
  assert.equal(await f.panel.locator('.team-task-id').first().textContent(), 'task-1');

  // Long descriptions clamp to two lines and only then offer the toggle.
  const description = first.locator('.team-task-description');
  assert.equal(await description.evaluate(element => element.classList.contains('team-clamped')), true);
  await f.page.waitForFunction(() => !document.querySelector('#team-panel .team-task .team-task-expand').hidden);
  const expand = first.locator('.team-task-expand');
  assert.equal(await expand.isVisible(), true);
  assert.equal(await description.evaluate(element => element.scrollHeight > element.clientHeight), true, 'the clamped text really overflows');
  await expand.click(); await f.paint();
  assert.equal(await description.evaluate(element => element.classList.contains('team-clamped')), false);
  assert.equal(await expand.getAttribute('aria-expanded'), 'true');
  assert.equal(await expand.textContent(), '收起');
  await expand.click(); await f.paint();
  assert.equal(await description.evaluate(element => element.classList.contains('team-clamped')), true);
  assert.equal(await expand.textContent(), '展开');
});

test('empty task board explains how tasks appear', async t => {
  const f = await fixture(t);
  await f.emit(state(team({ tasks: [] })));
  await f.openPanel();
  assert.equal(await f.panel.locator('.team-task').count(), 0);
  assert.equal(await f.panel.locator('.team-empty').textContent(), '任务板为空。主 Agent 创建任务后会显示在这里。');
  assert.equal(await f.panel.locator('.team-empty').isVisible(), true);
  assert.equal(await f.panel.locator('.team-tasks').isVisible(), false);
  assert.equal(await f.panel.locator('.team-section-count').first().textContent(), '3');
});

test('live updates keep the panel open, preserve focus, expansion and reading position', async t => {
  const f = await fixture(t);
  const many = Array.from({ length: 8 }, (_, index) => task('task-' + (index + 1), {
    description: index === 0 ? longDescription : `第 ${index + 1} 个任务的说明。`, subject: '任务 ' + (index + 1)
  }));
  await f.emit(state(team({ tasks: many })));
  await f.openPanel();
  await f.page.waitForFunction(() => !document.querySelector('#team-panel .team-task .team-task-expand').hidden);
  const expand = f.panel.locator('.team-task .team-task-expand').first();
  await expand.focus();
  await expand.click(); await f.paint();
  await f.page.evaluate(() => {
    window.savedExpand = document.querySelector('#team-panel .team-task-expand');
    window.savedTask = document.querySelector('#team-panel .team-task');
    const body = document.querySelector('#team-panel .team-panel-body');
    body.scrollTop = 48;
  });
  const scrollBefore = await f.panel.locator('.team-panel-body').evaluate(element => element.scrollTop);
  assert(scrollBefore > 0, 'the fixture board must overflow so reading position is meaningful');

  const updatedRoster = [lead, { ...alice, status: 'inactive', activity: undefined }, { ...bob, status: 'running' }];
  const updatedTasks = many.map((entry, index) => index === 0
    ? { ...entry, status: 'completed', ownerName: 'bob' }
    : entry).concat(task('task-9', { subject: '新任务', description: '实时更新追加的任务。' }));
  await f.emit(state(team({ revision: 9, roster: updatedRoster, tasks: updatedTasks })));

  assert.equal(await f.panel.isVisible(), true, 'incoming state must not close the open panel');
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await f.page.evaluate(() => ({
    expand: document.querySelector('#team-panel .team-task-expand') === window.savedExpand,
    task: document.querySelector('#team-panel .team-task') === window.savedTask,
    focused: document.activeElement === window.savedExpand
  })), { expand: true, task: true, focused: true }, 'focused controls and expanded descriptions survive updates');
  assert.equal(await f.page.locator('#team-panel .team-task').count(), 9);
  assert.equal(await f.page.locator('#team-panel .team-task').last().getAttribute('data-status'), 'pending');
  assert.match(await f.page.locator('#team-panel .team-task').first().getAttribute('data-status'), /completed/);
  assert.equal(await f.panel.locator('.team-task').first().locator('.team-task-expand').getAttribute('aria-expanded'), 'true');
  assert.equal(await f.panel.locator('.team-panel-body').evaluate(element => element.scrollTop), scrollBefore, 'reading position is retained');
  assert.equal(await f.page.locator('#team-panel .team-member[data-status="running"]').filter({ hasText: 'bob' }).count(), 1);
});

test('session switch, mode switch and team removal close the popover without stealing focus', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.openPanel();
  assert.equal(await f.panel.isVisible(), true);

  await f.emit(state(team(), { conversation: { id: 'another-session', title: '另一个会话' } }));
  assert.equal(await f.panel.isVisible(), false, 'switching sessions closes the team panel');
  assert.equal(await f.toggle.getAttribute('aria-expanded'), 'false');

  await f.toggle.click(); await f.paint();
  assert.equal(await f.panel.isVisible(), true);
  await f.emit(state(team(), {
    mode: 'goal', goal: { objective: '测试目标', criteria: [], notes: [] },
    execution: { status: 'idle', busy: false, activities: [], team: team() }
  }));
  assert.equal(await f.panel.isVisible(), false, 'goal mode must not keep the assist Team popover open');
  assert.equal(await f.toggle.isVisible(), false);

  await f.emit(state(team()));
  assert.equal(await f.toggle.isVisible(), true);
  await f.openPanel();
  assert.equal(await f.panel.isVisible(), true);
  await f.emit(state(undefined, { busy: false, execution: { status: 'idle', activities: [] } }));
  assert.equal(await f.panel.isVisible(), false);
  assert.equal(await f.toggle.isVisible(), false);
});

test('light and dark themes use the same DSH panel tokens and readable status text', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.openPanel();
  const read = () => f.panel.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, radius: style.borderRadius, shadow: style.boxShadow, color: style.color };
  });
  const light = await read();
  assert.equal(light.radius, '12px');
  assert.notEqual(light.background, 'rgba(0, 0, 0, 0)');
  assert.notEqual(light.shadow, 'none');
  assert.equal(await f.panel.locator('.team-task-status').first().textContent(), '可开始');

  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.paint();
  const dark = await read();
  assert.notEqual(dark.background, light.background, 'dark mode swaps the translucent menu surface');
  assert.notEqual(dark.color, light.color);
  assert.equal(await f.panel.locator('.team-task-status').first().textContent(), '可开始', 'status text stays readable, not color-only');
  await f.page.screenshot({ path: screenshotDirectory + '/team-panel-dark.png' });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.paint();
  await f.page.screenshot({ path: screenshotDirectory + '/team-panel-light.png' });
});

test('narrow viewport keeps one column and stays inside the viewport', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.page.setViewportSize({ width: 1000, height: 820 }); await f.paint();
  await f.openPanel();
  const wideColumns = await f.panel.locator('.team-roster').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length);
  assert.equal(wideColumns, 2);
  await f.panel.evaluate(element => element.querySelector('.team-panel-body')?.scrollTo(0, 0));
  await f.page.screenshot({ path: screenshotDirectory + '/team-panel-wide.png' });

  await f.page.setViewportSize({ width: 420, height: 820 }); await f.paint();
  assert.equal(await f.panel.isVisible(), true, 'resizing must keep the panel open');
  assert.equal(await f.toggle.isVisible(), true);
  assert.equal(await f.page.locator('.team-toggle-label').evaluate(element => getComputedStyle(element).display), 'none', 'the trigger collapses to its icon on narrow headers');
  const bounds = await f.panel.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 420, 'the panel is clamped inside the viewport');
  assert(bounds.width <= 420 - 24 + 1);
  assert.equal(await f.panel.locator('.team-roster').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length), 1);
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 420 && document.body.scrollWidth <= 420));
  assert(await f.page.evaluate(() => document.querySelector('#team-panel').scrollWidth <= 420));
  await f.page.screenshot({ path: screenshotDirectory + '/team-panel-narrow.png' });
});

test('reduced motion disables ongoing pulses and spinner rings', async t => {
  const f = await fixture(t, { reducedMotion: 'reduce' });
  const provisioning = { name: 'carol', role: 'teammate', status: 'provisioning', description: '正在创建' };
  const runningTask = task('task-5', { subject: '运行中的任务', status: 'in_progress', ownerName: 'bob' });
  await f.emit(state(team({ roster: [lead, provisioning], tasks: [runningTask] })));
  await f.openPanel();
  const animation = (selector, pseudo = null) => f.page.evaluate(({ selector, pseudo }) => {
    const element = document.querySelector(selector);
    return getComputedStyle(element, pseudo).animationName;
  }, { selector, pseudo });
  assert.equal(await animation('#team-panel .team-member-dot[data-state="ongoing"]', '::after'), 'none');
  assert.equal(await animation('#team-panel .team-task-dot[data-state="ongoing"]'), 'none');
});

test('team tool cards label kinds and summarize targets without echoing content', async t => {
  const f = await fixture(t);
  const parts = [
    toolPart('spawn', 'spawn_teammate', { name: 'alice', description: '后端', prompt: '实现团队服务' }, { member: { target: 'alice', role: 'teammate', status: 'provisioning' } }),
    toolPart('send', 'send_message', { target: 'bob', message: '这是不应出现在摘要里的正文内容' }, { sent: true }),
    toolPart('list', 'list_agents', {}, [{ target: 'lead' }, { target: 'alice' }, { target: 'bob' }]),
    toolPart('wait', 'wait_agent', { timeout_ms: 30000 }, { timedOut: true }),
    toolPart('interrupt', 'interrupt_agent', { target: 'alice' }, { previousStatus: 'running' }),
    toolPart('create', 'team_task_create', { subject: '创建团队面板测试', description: '详情' }, { id: 'task-7', revision: 1, subject: '创建团队面板测试' }),
    toolPart('tasks', 'team_task_list', {}, { tasks: [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }, { id: 'task-4' }] }),
    toolPart('get', 'team_task_get', { task_id: 'task-7' }, { id: 'task-7', subject: '创建团队面板测试' }),
    toolPart('update', 'team_task_update', { task_id: 'task-7', expected_revision: 1, action: 'claim' }, { id: 'task-7', subject: '创建团队面板测试' })
  ];
  await f.emit(state(undefined, { execution: { status: 'running', busy: true, parts, activities: [] } }));
  const titles = await f.page.locator('#messages .tool-title').allTextContents();
  assert.deepEqual(titles, ['创建团队成员', '向团队发消息', '查看团队成员', '等待团队进展', '中断团队成员', '创建任务', '查看任务板', '读取任务', '更新任务']);
  assert.deepEqual(await f.page.locator('#messages .tool-kind-icon').evaluateAll(nodes => nodes.map(node => node.dataset.kind)), Array(9).fill('team'));
  const paths = await f.page.locator('#messages .tool-path').allTextContents();
  assert.equal(paths[0], 'alice');
  assert.equal(paths[1], 'bob');
  assert.match(paths[2], /lead, alice, bob/);
  assert.equal(paths[3], '等待超时');
  assert.equal(paths[4], 'alice');
  assert.match(paths[5], /task-7|创建团队面板测试/);
  assert.match(paths[6], /task-1, task-2, task-3/);
  assert.equal(paths[7], 'task-7');
  assert.equal(paths[8], 'task-7');
  // Read-only team lookups stay flat and never render the returned snapshot.
  for (const index of [2, 3, 6, 7]) {
    assert.equal(await f.page.locator('#messages .tool-card').nth(index).getAttribute('data-readonly'), 'true');
  }
  const messagesText = await f.page.locator('#messages').textContent();
  assert.doesNotMatch(messagesText, /这是不应出现在摘要里的正文内容/, 'target summaries never echo message bodies');
  assert.doesNotMatch(messagesText, /创建团队面板测试/, 'collapsed cards do not echo returned task details');
});

test('wait_agent joins the maintenance group beside wait_workers and summaries', async t => {
  const f = await fixture(t);
  const summary = id => ({ id, type: 'summary', source: 'assistant', text: '已保留执行记录', status: 'completed', startedAt: start, endedAt: start + 1000 });
  const runningWait = toolPart('wait-1', 'wait_agent', { timeout_ms: 30000 }, '', { status: 'running', endedAt: undefined });
  const doneWait = toolPart('wait-2', 'wait_agent', { timeout_ms: 30000 }, { timedOut: false });
  const parts = [summary('summary-1'), runningWait, summary('summary-2'), doneWait];
  await f.emit(state(undefined, { execution: { status: 'running', busy: true, parts, activities: [] } }));
  const group = f.page.locator('#messages .maintenance-group');
  assert.equal(await group.count(), 1, 'consecutive waits and summaries fold into one group');
  assert.equal(await group.evaluate(element => element.open), false);
  assert.match(await group.locator(':scope > summary').textContent(), /正在等待团队进展/);
  assert.equal(await f.page.locator('#messages > .tool-card, #messages > .thinking-card').count(), 0);

  const finished = parts.map(part => part.id === 'wait-1' ? { ...part, status: 'completed', endedAt: start + 5000, output: JSON.stringify({ timedOut: false }) } : part);
  await f.emit(state(undefined, { execution: { status: 'running', busy: true, parts: finished, activities: [] } }));
  assert.match(await group.locator(':scope > summary').textContent(), /后台步骤已完成/);
  await group.locator(':scope > summary').click(); await f.paint();
  assert.equal(await group.locator('.tool-card').count(), 2);
});

test('English locale translates the trigger, panel copy, statuses and tool labels', async t => {
  const f = await fixture(t);
  await f.emit(state(team()));
  await f.openPanel();
  await f.page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  await f.paint();
  assert.equal(await f.toggle.getAttribute('title'), 'Team members and task board');
  assert.equal(await f.panel.getAttribute('aria-label'), 'Team');
  assert.match(await f.panel.locator('.team-section-title').first().textContent(), /Members/);
  assert.equal(await f.panel.locator('.team-member-status').first().textContent(), 'Running');
  assert.match(await f.panel.locator('.team-task-owner').first().textContent(), /Owner: alice/);
  assert.equal(await f.panel.locator('.team-task-status').nth(1).textContent(), 'Blocked by dependencies');
  await f.emit(state(team({ tasks: [] })));
  assert.equal(await f.panel.locator('.team-empty').textContent(), 'The task board is empty. Tasks the Lead creates appear here.');
  const parts = [toolPart('spawn-en', 'spawn_teammate', { name: 'alice', description: '后端', prompt: '实现团队服务' }, { member: { target: 'alice' } })];
  await f.emit(state(team(), { execution: { status: 'running', busy: true, parts, activities: [] } }));
  assert.equal(await f.page.locator('#messages .tool-title').first().textContent(), 'Create a teammate');
});
