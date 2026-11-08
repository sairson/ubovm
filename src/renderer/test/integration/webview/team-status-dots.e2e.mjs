// Independent end-to-end verification for distinct team status dot colours
// (.tmp-team-status/contract.md): running = accent + pulse/spin, waiting
// (provisioning) = warning amber with NO running spinner, failed = error red,
// inactive = gray person icon; three distinct non-transparent backgrounds in dark
// AND light; teammate conversation live dot follows the same semantic colours
// (hidden when not live) while the chip text stays the non-colour signal; the
// task-board dots keep their existing mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://team-status-dots-e2e.test/';
const now = Date.now();
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

const member = (name, status, overrides = {}) => ({
  name, role: name === 'lead' ? 'lead' : 'teammate', status,
  description: name + ' 状态样例', updatedAt: now - 1000, ...overrides
});
const roster = () => [
  member('lead', 'running', { description: '协调团队并汇总结果' }),
  member('runner', 'running', { description: '正在实现后端服务', activity: { label: '执行工具', status: 'running', at: now - 500 } }),
  member('waiter', 'provisioning', { description: '等待模型连接，准备启动' }),
  member('failer', 'failed', { description: '启动失败样例', error: '启动失败：模型连接中断（ECONNRESET）。' }),
  member('idle', 'inactive', { description: '等待分配任务' })
];
const task = (id, overrides = {}) => ({
  id, revision: 1, subject: id, description: '任务描述', status: 'pending',
  blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...overrides
});
const tasks = () => [
  task('task-run', { subject: '运行中的任务', status: 'in_progress', ownerName: 'runner' }),
  task('task-wait', { subject: '等待中的任务', ready: false, blockedBy: ['task-run'] }),
  task('task-done', { subject: '已完成的任务', status: 'completed', ownerName: 'lead' })
];
const team = () => ({ revision: 5, roster: roster(), tasks: tasks() });
const buildState = ({ teamWatch } = {}) => ({
  type: 'state', mode: 'assist',
  conversation: { id: 'team-status-dots-e2e', title: '团队状态颜色' },
  messages: [{ id: 'm-user', role: 'user', text: '检查团队状态点颜色。' }],
  goal: null, context: { workspace: 'UBOVM', file: '' },
  provider: { configured: true, connected: true, label: '测试模型' },
  busy: true,
  execution: { status: 'running', busy: true, parts: [], streamText: '', activities: [], team: team(), ...(teamWatch !== undefined ? { teamWatch } : {}) }
});
const watch = (status, overrides = {}) => ({
  name: 'runner', role: 'teammate', status,
  description: '被查看的成员', running: status === 'running' || status === 'provisioning',
  history: {
    entries: [
      { id: 'w-user', role: 'user', text: 'Team message from lead: 检查状态点。' },
      { id: 'w-assistant', role: 'assistant', text: '状态点由语义颜色标示。' }
    ],
    omitted: 0
  },
  live: { parts: [], streamText: '' },
  updatedAt: now - 1000, ...overrides
});

async function fixture(t, { reducedMotion, width = 1100, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, ...(reducedMotion ? { reducedMotion } : {}) });
  page.setDefaultTimeout(10000);
  const errors = [];
  const consoleErrors = [];
  const remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remote.push(url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remote.push(url + ' (failed)');
  });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'team-status-dots-e2e' })
  }));
  await page.goto(origin);
  const frames = (count = 2) => page.evaluate(async amount => {
    for (let index = 0; index < amount; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, count);
  const emit = async value => {
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), value);
    await frames(2);
    await page.waitForTimeout(120);
  };
  const panel = page.locator('#team-panel');
  const openPanel = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('#team-toggle').click();
      await panel.waitFor({ state: 'visible' });
    }
    await page.evaluate(() => document.querySelector('#team-panel .team-panel-body')?.scrollTo(0, 0));
    await frames(2);
  };
  const openMember = async name => {
    await openPanel();
    const row = page.locator('#team-panel .team-member', { has: page.locator('.team-member-name-text', { hasText: new RegExp('^' + name + '$') }) });
    await row.click();
    await page.locator('#team-member-view').waitFor({ state: 'visible' });
    await frames(2);
  };
  const rosterDots = () => page.evaluate(() => [...document.querySelectorAll('#team-panel .team-member')].map(row => {
    const dot = row.querySelector('.team-member-dot');
    const style = dot ? getComputedStyle(dot) : null;
    return {
      name: (row.querySelector('.team-member-name-text')?.textContent || '').trim(),
      statusText: (row.querySelector('.team-member-status')?.textContent || '').trim(),
      dataState: dot?.getAttribute('data-state') || '',
      ariaHidden: dot?.getAttribute('aria-hidden') || '',
      hasPersonIcon: Boolean(dot?.querySelector('svg')),
      background: style?.backgroundColor ?? null,
      animation: style?.animationName ?? null,
      afterAnimation: dot ? getComputedStyle(dot, '::after').animationName : null,
      beforeAnimation: dot ? getComputedStyle(dot, '::before').animationName : null
    };
  }));
  const taskDots = () => page.evaluate(() => [...document.querySelectorAll('#team-panel .team-task')].map(item => {
    const dot = item.querySelector('.team-task-dot');
    return {
      subject: (item.querySelector('.team-task-subject')?.textContent || '').trim(),
      state: (item.querySelector('.team-task-state')?.getAttribute('data-state') || ''),
      dataState: dot?.getAttribute('data-state') || '',
      statusText: (item.querySelector('.team-task-status')?.textContent || '').trim(),
      background: dot ? getComputedStyle(dot).backgroundColor : null,
      animation: dot ? getComputedStyle(dot).animationName : null
    };
  }));
  const memberFacts = () => page.evaluate(() => {
    const chip = document.getElementById('team-member-view-status');
    const live = document.getElementById('team-member-view-live');
    const style = live ? getComputedStyle(live) : null;
    return {
      chipStatus: chip?.getAttribute('data-status') || '',
      chipLive: chip?.getAttribute('data-live') || '',
      chipText: (document.getElementById('team-member-view-status-text')?.textContent || '').trim(),
      liveHidden: live ? live.hidden : null,
      liveVisible: Boolean(live?.getClientRects().length),
      liveBackground: style?.backgroundColor ?? null,
      liveAnimation: style?.animationName ?? null,
      liveAriaHidden: live?.getAttribute('aria-hidden') || ''
    };
  });
  await emit(buildState());
  await page.waitForFunction(() => document.body.dataset.loading === 'false', undefined, { timeout: 8000 }).catch(() => {});
  t.after(async () => {
    await page.close().catch(() => {});
    assert.deepEqual(errors, [], 'the team surfaces must not throw page errors');
    assert.deepEqual(consoleErrors, [], 'the team surfaces must not log console errors');
    assert.deepEqual(remote, [], 'the team surfaces must not request remote resources');
  });
  return { page, emit, frames, openPanel, openMember, rosterDots, taskDots, memberFacts };
}

const solid = colour => Boolean(colour) && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent';
const byName = (rows, name) => rows.find(row => row.name === name);
const ANIMATION = row => [row.animation, row.afterAnimation, row.beforeAnimation].filter(name => name && name !== 'none');

// ---------------------------------------------------------------------------
// 1. Running roster dot: ongoing state with the accent colour and its pulse/spin.
// ---------------------------------------------------------------------------
test('a running member renders the ongoing accent dot with the existing pulse/spin', async t => {
  const f = await fixture(t);
  await f.emit(buildState());
  await f.openPanel();
  const rows = await f.rosterDots();
  const runner = byName(rows, 'runner');
  assert.ok(runner, 'the running member row must exist');
  assert.equal(runner.dataState, 'ongoing', 'a running member must use the ongoing dot state');
  assert.equal(solid(runner.background), true, `the running dot must have an accent background (got ${runner.background})`);
  assert.ok(ANIMATION(runner).length >= 1, `the running dot must keep its pulse/spin animation (got ${JSON.stringify(ANIMATION(runner))})`);
  assert.match(runner.statusText, /运行中/, 'the status text stays a non-color signal');
  assert.equal(runner.ariaHidden, 'true', 'decorative status dots stay hidden from the accessibility tree');
});

// ---------------------------------------------------------------------------
// 2. Provisioning/waiting dot: dedicated waiting state, amber, NO running spinner.
// ---------------------------------------------------------------------------
test('a waiting (provisioning) member renders a distinct amber dot without the running spinner', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const rows = await f.rosterDots();
  const waiter = byName(rows, 'waiter');
  const runner = byName(rows, 'runner');
  const failer = byName(rows, 'failer');
  assert.ok(waiter, 'the waiting member row must exist');
  assert.equal(waiter.dataState, 'waiting', 'provisioning members must use the dedicated waiting dot state');
  assert.equal(solid(waiter.background), true, `the waiting dot must have a non-transparent colour (got ${waiter.background})`);
  assert.notEqual(waiter.background, runner.background, 'waiting must not reuse the running accent colour');
  assert.notEqual(waiter.background, failer.background, 'waiting must not reuse the failed error colour');
  assert.equal(waiter.animation, 'none', 'the waiting dot must not run the ongoing row animation');
  assert.equal(waiter.afterAnimation, 'none', 'the waiting dot must not reuse the running spinner (::after)');
  assert.match(waiter.statusText, /准备中/, 'the waiting status text stays explicit');
});

// ---------------------------------------------------------------------------
// 3. Failed dot: error state and the error red background.
// ---------------------------------------------------------------------------
test('a failed member renders the error red dot', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const rows = await f.rosterDots();
  const failer = byName(rows, 'failer');
  assert.ok(failer, 'the failed member row must exist');
  assert.equal(failer.dataState, 'error', 'a failed member must use the error dot state');
  assert.equal(solid(failer.background), true, `the failed dot must have a red background (got ${failer.background})`);
  assert.equal(ANIMATION(failer).length, 0, 'the failed dot must not animate');
  assert.match(failer.statusText, /失败/, 'the failed status text stays explicit');
});

// ---------------------------------------------------------------------------
// 4. Inactive member: gray person icon, no coloured state dot.
// ---------------------------------------------------------------------------
test('an inactive member keeps the gray person icon and no coloured dot background', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const rows = await f.rosterDots();
  const idle = byName(rows, 'idle');
  assert.ok(idle, 'the inactive member row must exist');
  assert.equal(idle.dataState, 'inactive', 'inactive members keep the inactive state');
  assert.equal(idle.hasPersonIcon, true, 'the inactive member must keep the gray person icon');
  assert.equal(solid(idle.background), false, 'the inactive member must not render a coloured dot background');
  assert.equal(ANIMATION(idle).length, 0, 'the inactive icon must not animate');
  assert.match(idle.statusText, /未运行/, 'the inactive status text stays explicit');
});

// ---------------------------------------------------------------------------
// 5. Three distinct non-transparent backgrounds in BOTH light and dark themes.
// ---------------------------------------------------------------------------
test('running/waiting/failed backgrounds are three distinct non-transparent colours in light and dark', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const check = (rows, theme) => {
    const values = ['runner', 'waiter', 'failer'].map(name => byName(rows, name));
    assert.ok(values.every(Boolean), `all three status rows must exist in ${theme}`);
    for (const row of values) assert.equal(solid(row.background), true, `${theme}: ${row.name} must have a non-transparent background (got ${row.background})`);
    assert.equal(new Set(values.map(row => row.background)).size, 3, `${theme}: running/waiting/failed backgrounds must be three distinct colours (got ${JSON.stringify(values.map(row => [row.name, row.background]))})`);
  };
  check(await f.rosterDots(), 'light');
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames(2);
  await f.page.waitForTimeout(100);
  check(await f.rosterDots(), 'dark');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.frames(2);
});

// ---------------------------------------------------------------------------
// 6. Reduced motion disables waiting/running animations.
// ---------------------------------------------------------------------------
test('reduced motion disables the waiting and running dot animations', async t => {
  const f = await fixture(t, { reducedMotion: 'reduce' });
  await f.openPanel();
  const rows = await f.rosterDots();
  for (const name of ['runner', 'waiter']) {
    const row = byName(rows, name);
    assert.equal(ANIMATION(row).length, 0, `reduced motion must disable ${name} dot animations (got ${JSON.stringify(ANIMATION(row))})`);
  }
  assert.equal(byName(rows, 'waiter').dataState, 'waiting', 'the waiting state stays distinct under reduced motion');
});

// ---------------------------------------------------------------------------
// 7. Teammate conversation live dot follows the same semantic colours.
// ---------------------------------------------------------------------------
test('teammate conversation live dot uses accent/amber/red and hides when not live', async t => {
  const f = await fixture(t);
  await f.openPanel();
  await f.openMember('runner');
  await f.emit(buildState({ teamWatch: watch('running') }));
  const running = await f.memberFacts();
  assert.equal(running.chipStatus, 'running');
  assert.equal(running.liveHidden, false, 'the live dot must show while the member runs');
  assert.equal(solid(running.liveBackground), true, `the running live dot must use the accent colour (got ${running.liveBackground})`);
  await f.emit(buildState({ teamWatch: watch('provisioning') }));
  const provisioning = await f.memberFacts();
  assert.equal(provisioning.chipStatus, 'provisioning');
  assert.equal(provisioning.liveHidden, false, 'the live dot shows while the member is provisioning (waiting to start)');
  assert.equal(solid(provisioning.liveBackground), true, `the provisioning live dot must be amber (got ${provisioning.liveBackground})`);
  assert.notEqual(provisioning.liveBackground, running.liveBackground, 'provisioning live dot must differ from running');
  await f.emit(buildState({ teamWatch: watch('failed') }));
  const failed = await f.memberFacts();
  assert.equal(failed.chipStatus, 'failed');
  assert.equal(failed.liveHidden, true, 'the live dot must hide when the member is not live (failed)');
  assert.equal(solid(failed.liveBackground), true, `the failed chip colour must stay red (got ${failed.liveBackground})`);
  await f.emit(buildState({ teamWatch: watch('inactive', { running: false }) }));
  const inactive = await f.memberFacts();
  assert.equal(inactive.liveHidden, true, 'the live dot must hide for an inactive member');
  // Chip text remains the non-colour-only signal for every status.
  for (const facts of [running, provisioning, failed, inactive]) assert.ok(facts.chipText.length > 0, 'the chip text must stay present as the non-colour signal');
});

// ---------------------------------------------------------------------------
// 8. Task-board dots keep their existing mapping/appearance.
// ---------------------------------------------------------------------------
test('task board dots keep their existing states and colours', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const dots = await f.taskDots();
  const states = dots.map(dot => dot.dataState);
  assert.deepEqual(states, ['ongoing', 'warning', 'done'], `task dot mapping must stay unchanged (got ${JSON.stringify(states)})`);
  assert.match(dots[0].animation, /team-task-pulse/, 'the in-progress task dot keeps its pulse');
  for (const dot of dots) assert.equal(solid(dot.background), true, `task dot ${dot.subject} must keep a solid colour`);
  const windows = await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(windows, true, 'the panel must not overflow horizontally');
});

// ---------------------------------------------------------------------------
// 9. Narrow layout keeps the roster readable and the dots distinguishable.
// ---------------------------------------------------------------------------
test('the panel keeps distinct status dots at a 430px viewport', async t => {
  const f = await fixture(t, { width: 430, height: 900 });
  await f.openPanel();
  const rows = await f.rosterDots();
  const values = ['runner', 'waiter', 'failer'].map(name => byName(rows, name));
  assert.ok(values.every(Boolean), 'all state rows render at 430px');
  for (const row of values) assert.equal(solid(row.background), true, `narrow: ${row.name} dot keeps a solid colour`);
  assert.equal(new Set(values.map(row => row.background)).size, 3, 'narrow: the three state colours stay distinct');
  const overflow = await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(overflow, true, 'the team panel must not overflow horizontally at 430px');
});
