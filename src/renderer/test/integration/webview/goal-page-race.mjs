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
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: () => true }); });
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
  return { browser, page, errors, frames, switchTo, pageInfo, waitForPage };
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
