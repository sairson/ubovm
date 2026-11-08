import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const now = Date.now();
const state = () => ({
  type: 'state', mode: 'goal', conversation: { id: 'page-race', title: '页面竞争' },
  goal: {
    objective: '检查快速切换时页面组件仍能渲染',
    criteria: [{ id: 'c1', text: '切换后内容可见', done: false }],
    notes: [{ id: 'n1', text: '笔记一', createdAt: '2026-10-23T08:00:00Z' }, { id: 'n2', text: '笔记二', createdAt: '2026-10-23T09:00:00Z' }]
  },
  messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: { workspace: 'UBOVM' }, busy: true,
  agenda: {
    counts: { planned: 1, active: 1, blocked: 0, done: 0, dropped: 0, total: 2 },
    items: [
      { id: 'a1', title: '检查入口', status: 'active', kind: 'intent', ref: 'n1' },
      { id: 'a2', title: '核对响应头', status: 'planned', kind: 'intent', ref: 'n2' }
    ]
  },
  graph: { revision: 2, nodes: 3, intents: 1, facts: 1, edges: 2, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false },
  execution: {
    status: 'running', busy: true, phase: 'reason',
    parts: [{ id: 'th', type: 'thinking', source: 'reason', text: '检查页面切换。', status: 'running', startedAt: now }],
    activities: [{ label: 'Reason', status: 'running', timestamp: now, key: 'r' }],
    workers: [{ id: 'w1', name: '检查页面', description: '检查渲染', status: 'running', createdAt: now - 5000, startedAt: now - 4000, parts: [] }],
    blackboard: {
      revision: 3, rootId: 'root', goal: '检查快速切换时页面组件仍能渲染',
      nodes: [
        { id: 'root', kind: 'root', parentIds: [], fact: { content: '检查快速切换时页面组件仍能渲染' } },
        { id: 'n2', kind: 'fact', parentIds: ['root'], fact: { content: '事实一' } },
        { id: 'n3', kind: 'fact', parentIds: ['root'], fact: { content: '事实二' } }
      ]
    },
    memory: { notes: [] }
  }
});

const views = ['overview', 'agenda', 'board', 'workers', 'notes'];
const rootOf = { agenda: '#goal-agenda-list', board: '#blackboard-nodes', notes: '#goal-notes-list', overview: '#goal-output-content' };

async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage(message) { window.__posted.push(message); return true; } });
  });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'page-race' }) }));
  await page.goto('http://page-race.test/');
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const switchTo = async view => {
    await page.evaluate(view => {
      document.getElementById('goal-view-switcher').open = true;
      document.getElementById('goal-tab-' + view).click();
    }, view);
    await frames();
  };
  const pageInfo = () => page.evaluate(() => ({
    selected: [...document.querySelectorAll('#goal-tabs [role="tab"]')].filter(node => node.getAttribute('aria-selected') === 'true').map(node => node.id.replace('goal-tab-', '')),
    visible: [...document.querySelectorAll('#goal-overview, #goal-agenda, #goal-board, #goal-workers, #goal-notes')].filter(node => !node.hidden).map(node => node.id.replace('goal-', '')),
    loaderHidden: document.getElementById('route-loading').hidden,
    switching: document.body.dataset.switching,
    retryHidden: document.getElementById('ui-render-retry').hidden,
    content: {
      overview: document.getElementById('goal-output-content').children.length,
      agenda: document.getElementById('goal-agenda-list').children.length,
      board: document.getElementById('blackboard-nodes').children.length,
      workers: document.getElementById('goal-workers-list').children.length,
      notes: document.getElementById('goal-notes-list').children.length
    }
  }));
  const waitForPage = async (view, minimum) => {
    await page.waitForFunction(({ view, minimum }) => {
      const panel = document.getElementById('goal-' + view);
      const roots = { overview: 'goal-output-content', agenda: 'goal-agenda-list', board: 'blackboard-nodes', workers: 'goal-workers-list', notes: 'goal-notes-list' };
      return panel && !panel.hidden && document.getElementById(roots[view])?.children.length >= minimum &&
        document.body.dataset.switching === 'false' && document.getElementById('route-loading').hidden &&
        document.getElementById('ui-render-retry').hidden;
    }, { view, minimum });
  };
  const emit = value => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
  return { browser, page, errors, frames, switchTo, pageInfo, waitForPage, emit };
}

test('rapid page switching always renders the final selected page', async t => {
  const f = await fixture(t);
  const sequences = [
    ['overview', 'board', 'notes'],
    ['agenda', 'overview', 'workers', 'notes'],
    ['board', 'agenda', 'workers', 'overview', 'notes'],
    ['notes', 'board', 'agenda'],
    ['workers', 'notes', 'overview', 'board', 'agenda']
  ];
  for (const sequence of sequences) {
    for (const view of sequence) await f.switchTo(view);
    const final = sequence.at(-1);
    const info = await f.pageInfo();
    assert.deepEqual(info.selected, [final], 'the last clicked page stays selected');
    assert.deepEqual(info.visible, [final], 'only the final page is visible');
    assert.equal(info.loaderHidden, true, 'the route mask must not stay over the final page');
    assert.equal(info.switching, 'false');
    assert.equal(info.retryHidden, true);
    assert.ok(info.content[final] > 0, `${final} content must render (got ${info.content[final]})`);
  }
  // Burst clicks in one task: only the final intent may win, never an intermediate page.
  await f.page.evaluate(() => {
    document.getElementById('goal-view-switcher').open = true;
    for (const view of ['board', 'notes', 'agenda', 'workers', 'overview']) document.getElementById('goal-tab-' + view).click();
  });
  await f.waitForPage('overview', 1);
  const burst = await f.pageInfo();
  assert.deepEqual(burst.selected, ['overview']);
  assert.deepEqual(burst.visible, ['overview']);
  assert.deepEqual(f.errors, []);
});

test('empty selected page components rebuild themselves after a competing update or lost rows', async t => {
  const f = await fixture(t);
  for (const [view, selector, minimum] of [
    ['agenda', '#goal-agenda-list', 2],
    ['board', '#blackboard-nodes', 2],
    ['workers', '#goal-workers-list', 1],
    ['notes', '#goal-notes-list', 2],
    ['overview', '#goal-output-content', 1]
  ]) {
    await f.switchTo(view);
    await f.waitForPage(view, minimum);
    // Simulate a competing render/discarded subtree that leaves the active page blank.
    await f.page.evaluate(selector => document.querySelector(selector).replaceChildren(), selector);
    const away = view === 'overview' ? 'board' : 'overview';
    await f.switchTo(away);
    await f.switchTo(view);
    await f.waitForPage(view, minimum);
    const info = await f.pageInfo();
    assert.ok(info.content[view] >= minimum, `${view} must self-heal instead of staying blank`);
    assert.deepEqual(info.selected, [view]);
    assert.deepEqual(info.visible, [view]);
    assert.equal(info.retryHidden, true);
  }
  assert.deepEqual(f.errors, []);
});

test('a state update arriving during a page transition renders the selected page', async t => {
  const f = await fixture(t);
  await f.switchTo('board');
  await f.page.evaluate(() => {
    document.getElementById('goal-view-switcher').open = true;
    document.getElementById('goal-tab-workers').click();
    // A host snapshot lands while the workers page transition is still pending.
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', mode: 'goal', conversation: { id: 'page-race', title: '页面竞争' },
      goal: { objective: '检查快速切换时页面组件仍能渲染', criteria: [], notes: [] },
      messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: { workspace: 'UBOVM' }, busy: true,
      agenda: { counts: { planned: 0, active: 1, blocked: 0, done: 0, dropped: 0, total: 1 }, items: [{ id: 'a9', title: '仍在运行', status: 'active', kind: 'intent' }] },
      graph: { revision: 3, nodes: 1, intents: 0, facts: 0, edges: 0, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false },
      execution: {
        status: 'running', busy: true, phase: 'execute',
        parts: [{ id: 'th2', type: 'thinking', source: 'reason', text: '继续检查。', status: 'running', startedAt: Date.now() }],
        activities: [], workers: [{ id: 'w2', name: '继续检查', description: '处理更新', status: 'running', createdAt: Date.now() - 1000, parts: [] }], memory: { notes: [] }
      }
    } }));
  });
  await f.waitForPage('workers', 1);
  const info = await f.pageInfo();
  assert.deepEqual(info.selected, ['workers']);
  assert.deepEqual(info.visible, ['workers']);
  assert.ok(info.content.workers > 0);
  assert.deepEqual(f.errors, []);
});

test('the blackboard page exposes a refresh control that requests an authoritative snapshot', async t => {
  const f = await fixture(t);
  await f.switchTo('board');
  await f.waitForPage('board', 2);
  const button = f.page.locator('.graph-navigation .graph-refresh');
  assert.equal(await button.isVisible(), true, 'the blackboard refresh control must be visible in the graph toolbar');
  await button.click();
  await f.frames();
  const posted = await f.page.evaluate(() => window.__posted || []);
  assert.ok(posted.some(message => message?.action === 'refreshBlackboard'), 'refresh must ask the host for a snapshot: ' + JSON.stringify(posted));
  const rendered = await f.page.locator('#blackboard-nodes .graph-node').count();
  assert.ok(rendered >= 2, 'refresh must keep the graph rendered');
  assert.deepEqual(f.errors, []);
});

test('light goal page switches avoid the full-route loader flash', async t => {
  const f = await fixture(t);
  const first = await f.page.evaluate(async () => {
    const animations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(...args) {
      animations.push({ id: this.id, frames: args[0], options: args[1] });
      return animate.apply(this, args);
    };
    document.getElementById('goal-view-switcher').open = true;
    document.getElementById('goal-tab-agenda').click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      loaderHidden: document.getElementById('route-loading').hidden,
      animations
    };
  });
  assert.equal(first.loaderHidden, true, 'a fast agenda switch must not flash the full-surface cover');
  await f.waitForPage('agenda', 1);
  await f.frames();
  assert.deepEqual(f.errors, []);
});

test('a stale expanded worker panel cannot leave the primary surface blank', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    document.querySelector('.shell').classList.add('worker-panel-expanded');
    const panel = document.getElementById('worker-panel');
    if (panel) panel.hidden = true;
  });
  const before = await f.page.evaluate(() => getComputedStyle(document.getElementById('main-content')).visibility);
  assert.equal(before, 'visible', 'the CSS guard keeps the surface visible even before the JS repair runs');
  await f.switchTo('board');
  await f.frames();
  const after = await f.page.evaluate(() => ({
    expanded: document.querySelector('.shell').classList.contains('worker-panel-expanded'),
    main: getComputedStyle(document.getElementById('main-content')).visibility,
    goalVisible: !document.getElementById('goal-mode').hidden,
    assistVisible: !document.getElementById('assist-mode').hidden
  }));
  assert.equal(after.expanded, false, 'stale worker-panel expansion is cleared on the next render');
  assert.equal(after.main, 'visible');
  assert.equal(after.goalVisible, true);
  assert.equal(after.assistVisible, false);
  assert.deepEqual(f.errors, []);
});

test('an empty blackboard still exposes refresh so a missed projection can be reloaded', async t => {
  const f = await fixture(t);
  const empty = state();
  empty.busy = false;
  empty.execution = { ...empty.execution, status: 'idle', busy: false, parts: [], activities: [], workers: [], blackboard: { revision: 0, rootId: 'root', goal: empty.goal.objective, nodes: [] } };
  await f.emit(empty);
  await f.frames();
  await f.switchTo('board');
  await f.frames();
  assert.equal(await f.page.locator('#blackboard-empty').isVisible(), true);
  const refresh = f.page.locator('#blackboard-empty-refresh');
  assert.equal(await refresh.isVisible(), true, 'the empty board must offer a refresh action');
  await refresh.click();
  await f.frames();
  const posted = await f.page.evaluate(() => window.__posted || []);
  assert.ok(posted.some(message => message?.action === 'refreshBlackboard'), 'empty-state refresh must ask the host for a snapshot');
  assert.equal(await refresh.isEnabled(), true, 'refresh must not stay disabled after the click');
  assert.deepEqual(f.errors, []);
});

test('a board-less reloaded project requests the authoritative checkpoint and explains failures', async t => {
  const f = await fixture(t);
  // Fresh page + one full snapshot without any blackboard: this is what a
  // restored exploration looks like before the backend checkpoint is loaded.
  await f.page.reload();
  await f.frames();
  const restored = state();
  restored.busy = false;
  restored.execution = { status: 'completed', busy: false, parts: [], activities: [], workers: [], error: { message: '执行记录恢复超时，请在黑板页重试' } };
  await f.emit(restored);
  await f.frames();
  await f.switchTo('board');
  await f.frames(); await f.frames();
  const posted = await f.page.evaluate(() => window.__posted || []);
  const refreshes = posted.filter(message => message?.action === 'refreshBlackboard');
  assert.equal(refreshes.length, 1, 'a run without a board asks the host to reload it exactly once per session: ' + JSON.stringify(posted));
  assert.equal(await f.page.locator('#blackboard-empty').isVisible(), true);
  const hint = await f.page.locator('#blackboard-empty-hint').textContent();
  assert.match(hint, /黑板读取失败/);
  assert.match(hint, /执行记录恢复超时/);
  // Re-rendering the same state must not spam the host with more requests.
  await f.emit(restored);
  await f.frames(); await f.frames();
  assert.equal(await f.page.evaluate(() => (window.__posted || []).filter(message => message?.action === 'refreshBlackboard').length), 1);
  // When the checkpoint arrives, the graph replaces the empty state.
  await f.emit(state());
  await f.frames(); await f.frames();
  assert.ok(await f.page.locator('#blackboard-nodes .graph-node').count() >= 2);
  assert.equal(await f.page.locator('#blackboard-empty').isVisible(), false);
  assert.match(await f.page.locator('#blackboard-empty-hint').textContent(), /如果长时间没有内容/);
  assert.deepEqual(f.errors, []);
});

test('an idle goal that never ran does not auto-request the blackboard', async t => {
  const f = await fixture(t);
  await f.page.reload();
  await f.frames();
  const idle = state();
  idle.busy = false;
  idle.execution = { status: 'idle', busy: false, parts: [], activities: [], workers: [] };
  await f.emit(idle);
  await f.frames();
  await f.switchTo('board');
  await f.frames(); await f.frames();
  const posted = await f.page.evaluate(() => window.__posted || []);
  assert.equal(posted.filter(message => message?.action === 'refreshBlackboard').length, 0, 'a new goal with no run must not auto-request a nonexistent board');
  // A just-started run without any produced part/worker is not a missed board either.
  const starting = state();
  starting.busy = true;
  starting.execution = { status: 'running', busy: true, phase: 'reason', parts: [], activities: [], workers: [] };
  await f.emit(starting);
  await f.frames(); await f.frames();
  assert.equal(await f.page.evaluate(() => (window.__posted || []).filter(message => message?.action === 'refreshBlackboard').length), 0, 'a running session without produced work must not auto-request');
  // The manual escape hatch still works.
  await f.page.locator('#blackboard-empty-refresh').click();
  await f.frames();
  assert.equal(await f.page.evaluate(() => (window.__posted || []).filter(message => message?.action === 'refreshBlackboard').length), 1);
  assert.deepEqual(f.errors, []);
});
