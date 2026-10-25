import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const now = Date.now();
const fact = {
  version: 1, outcome: 'confirmed', statement: 'CSP 报告端点覆盖首页与 API。',
  coverage: [{ point: 'home headers', status: 'confirmed', result: 'CSP present' }], evidence: [], limitations: [], nextSteps: []
};
const snapshot = {
  sessionId: 'cards-test', revision: 3, rootId: 'root', goal: '审计响应头',
  nodes: [
    { id: 'root', kind: 'root', parentIds: [], goal: '审计响应头', intent: null, attempts: [], fact: { content: '审计响应头' } },
    { id: 'n2', kind: 'intent', parentIds: ['root'], intent: { description: '审计 CSP', status: 'completed', priority: 'high', keyPoints: ['CSP'] }, attempts: [{ id: 'a2', status: 'completed' }], resultId: 'n3' },
    { id: 'n3', kind: 'fact', parentIds: ['n2'], producerId: 'n2', intent: null, attempts: [], fact: { content: JSON.stringify(fact) } },
    { id: 'n4', kind: 'intent', parentIds: ['root'], intent: { description: '核对缓存', status: 'running', priority: 'medium', keyPoints: ['cache'] }, attempts: [{ id: 'a4', status: 'running', checkpoint: { phase: 'execute', plan: [{ description: '抓取回源响应' }] } }], resultId: null }
  ]
};
const agenda = {
  counts: { planned: 1, active: 1, blocked: 0, done: 1, dropped: 0, total: 3 }, gaps: [],
  items: [
    { id: 'intent:n4', kind: 'intent', intentId: 'n4', ref: 'n5', title: '核对缓存', status: 'active', priority: 'medium', planSteps: ['抓取回源响应'] },
    { id: 'intent:n2', kind: 'intent', intentId: 'n2', ref: 'n3', title: '审计 CSP', status: 'done' },
    { id: 'direction:1', kind: 'direction', directionId: '1', title: '检查缓存键', status: 'done', method: '冲突 Host 头' }
  ]
};
const notes = [{ id: 'n1', content: 'CSP 报告端点已确认。', created_at: now - 1000 }];
const state = {
  type: 'state', mode: 'goal', conversation: { id: 'cards-test', title: '卡片一致性' },
  goal: { objective: '审计响应头', criteria: [{ id: 'c1', text: '确认 CSP', done: true }], notes },
  messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: true,
  agenda, graph: { revision: 3, nodes: 4, intents: 2, facts: 1, edges: 3, root: 'n1', detail: 'full', omittedFacts: 1, overBudget: false },
  memory: { notes },
  execution: {
    status: 'running', busy: true, phase: 'execute', parts: [], blackboard: snapshot,
    activities: [{ label: 'Reason', status: 'running', timestamp: now - 2000, key: 'r' }],
    workers: [{ id: 'w-n4', intentId: 'n4', description: '核对缓存', status: 'running', priority: 2, createdAt: now - 5000, parts: [] }]
  }
};

async function card(page, selector) {
  return page.locator(selector).first().evaluate(node => {
    const style = getComputedStyle(node);
    return { radius: style.borderTopLeftRadius, border: `${style.borderTopWidth} ${style.borderTopStyle}`, background: style.backgroundColor, shadow: style.boxShadow };
  });
}

test('exploration tabs share one card surface, radius and flat elevation', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'exploration-cards-test' }) }));
    await page.goto('http://exploration-cards.test/');
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const openTab = async view => {
      if (view !== 'overview') {
        await page.locator('#goal-view-switcher > summary').click();
        await page.locator(`#goal-tab-${view}`).click();
        await frames(); await frames();
      }
    };
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state);
    await frames(); await frames();
    const cards = { overview: await card(page, '.goal-output-panel') };
    await openTab('agenda');
    cards.agenda = await card(page, '.goal-agenda-row');
    await openTab('board');
    cards.board = await card(page, '.graph-node:not([data-kind="root"]):not(.graph-goal-badge)');
    const root = await page.locator('.graph-node[data-kind="root"]').evaluate(node => getComputedStyle(node).borderTopLeftRadius);
    await openTab('workers');
    cards.workers = await card(page, '.worker-card');
    const workerTags = await page.evaluate(() => {
      const priority = document.querySelector('#goal-workers .worker-priority');
      const status = document.querySelector('#goal-workers .worker-status');
      const info = node => {
        const style = getComputedStyle(node);
        return { radius: style.borderTopLeftRadius, border: `${style.borderTopWidth} ${style.borderTopStyle}`, font: style.fontFamily, size: style.fontSize };
      };
      return { priority: info(priority), status: info(status) };
    });
    assert.equal(workerTags.priority.radius, '0px', 'priority label is a square tag');
    assert.equal(workerTags.status.radius, '0px', 'state label is a square tag');
    assert.equal(workerTags.priority.border, '1px solid');
    assert.equal(workerTags.status.border, '1px solid');
    assert.match(workerTags.priority.font, /Consolas|monospace/i);
    assert.equal(workerTags.status.size, '9.5px');
    await openTab('notes');
    cards.notes = await card(page, '.notebook-layout');
    const note = await card(page, '#goal-notes-list .note-select');
    for (const [name, value] of Object.entries(cards)) {
      assert.equal(value.radius, '12px', `${name} radius`);
      assert.equal(value.border, '1px solid', `${name} border`);
      assert.equal(value.shadow, 'none', `${name} shadow`);
      assert.notEqual(value.background, 'rgba(0, 0, 0, 0)', `${name} surface`);
    }
    assert.equal(note.radius, '12px');
    assert.equal(note.border, '1px solid');
    assert.equal(note.shadow, 'none');
    assert.equal(root, '999px', 'the graph target stays a pill, not a card');
    for (const selector of ['#goal-agenda .goal-page-heading h2', '#goal-workers .goal-page-heading h2', '#goal-board .goal-page-heading h2', '#goal-notes .notebook-heading h2']) {
      const size = await page.locator(selector).evaluate(node => getComputedStyle(node).fontSize);
      assert.equal(size, '20px', selector);
    }
    // Empty states across tabs are quiet messages, not dashed inner cards.
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
      ...state,
      agenda: { counts: { planned: 0, active: 0, blocked: 0, done: 0, dropped: 0, total: 0 }, gaps: [], items: [] },
      blackboard: { ...snapshot, nodes: [] }, graph: { revision: 4, nodes: 0, intents: 0, facts: 0, edges: 0, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false },
      memory: { notes: [] }, execution: { ...state.execution, parts: [], workers: [], blackboard: { ...snapshot, nodes: [] } }
    });
    await frames(); await frames();
    await openTab('agenda');
    const empty = await page.locator('#goal-agenda-empty').evaluate(node => {
      const style = getComputedStyle(node);
      return { display: style.display, border: `${style.borderTopWidth} ${style.borderTopStyle}` };
    });
    assert.notEqual(empty.display, 'none');
    assert.equal(empty.border, '0px none');
    await page.screenshot({ path: '.cache/exploration-cards/cards-test.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
