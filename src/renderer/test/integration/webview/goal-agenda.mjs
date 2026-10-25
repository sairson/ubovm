import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const agenda = {
  counts: { planned: 1, active: 1, blocked: 1, done: 1, dropped: 1, total: 5 },
  gaps: [],
  items: [
    { id: 'intent:a', kind: 'intent', intentId: 'a', ref: 'n2', title: 'Queued header audit', status: 'planned', priority: 'high', source: 'blackboard', dedupeKey: 'queued header audit' },
    { id: 'intent:b', kind: 'intent', intentId: 'b', ref: 'n3', title: 'Running CSP audit', status: 'active', priority: 'medium', source: 'blackboard',
      planSteps: ['Collect response headers', 'Compare CSP directives'], currentStep: 'Collect response headers', attempts: 1 },
    { id: 'intent:c', kind: 'intent', intentId: 'c', ref: 'n4', title: 'Failed DNS audit', status: 'blocked', priority: 'medium', source: 'blackboard',
      blocker: 'resolver timed out', attempts: 2 },
    { id: 'direction:1', kind: 'direction', directionId: '1', title: 'Check cache poisoning via CDN edge', status: 'done', source: 'reason',
      method: 'send conflicting cache headers', acceptance: 'edge returns both variants' },
    { id: 'suggestion:retry:c', kind: 'suggestion', source: 'failure', status: 'planned', intentId: 'c', title: '换一种方法继续：Failed DNS audit', blocker: 'resolver timed out' },
    { id: 'intent:d', kind: 'intent', intentId: 'd', ref: 'n5', title: 'Dropped duplicate audit', status: 'dropped', priority: 'low', source: 'blackboard' }
  ]
};

test('exploration agenda tab shows shared status, worker steps, blockers and evidence', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'agenda-test' }) }));
    await page.goto('http://agenda.test/');
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
      type: 'state', mode: 'goal', conversation: { id: 'goal-agenda', title: '议程探索' },
      goal: { objective: '验证探索议程', criteria: [], notes: [] }, messages: [], provider: { connected: true, label: '测试模型' },
      context: {}, busy: false, agenda,
      graph: { revision: 3, nodes: 5, intents: 3, facts: 1, edges: 4, root: 'n1', detail: 'summary', omittedFacts: 0, overBudget: false },
      execution: { status: 'running', busy: true, parts: [], activities: [], workers: [] }
    });
    await frames();
    assert.equal(await page.locator('#goal-graph-status').isVisible(), true);
    assert.match(await page.locator('#goal-graph-status').textContent(), /图摘要 · 5 节点/);
    assert.match(await page.locator('#goal-graph-status').getAttribute('title'), /5 个节点、4 条边/);
    await page.locator('#goal-view-switcher > summary').click();
    await page.locator('#goal-tab-agenda').click();
    await frames(); await frames();
    assert.equal(await page.locator('#goal-agenda').isVisible(), true);
    assert.equal(await page.locator('#goal-tab-agenda').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('#goal-agenda-summary').textContent(), /1 待查 · 1 在查 · 1 受阻 · 1 已确认/);
    assert.equal(await page.locator('#goal-nav-agenda').textContent(), '3');
    assert.equal(await page.locator('#goal-agenda-list .goal-agenda-row').count(), 6);
    const active = page.locator('#goal-agenda-list .goal-agenda-row[data-status="active"]');
    assert.equal(await active.count(), 1);
    assert.match(await active.textContent(), /Running CSP audit/);
    assert.match(await active.textContent(), /Collect response headers/);
    assert.equal(await active.locator('.goal-agenda-step[data-current="true"]').count(), 1);
    const blocked = page.locator('#goal-agenda-list .goal-agenda-row[data-status="blocked"]');
    assert.match(await blocked.textContent(), /resolver timed out/);
    assert.match(await page.locator('#goal-agenda-list .goal-agenda-row[data-kind="direction"]').textContent(), /cache poisoning/);
    assert.match(await page.locator('#goal-agenda-list .goal-agenda-row[data-kind="suggestion"]').textContent(), /建议/);
    assert.equal(await page.locator('#goal-agenda-empty').isVisible(), false);
    // Narrow layout must stay inside the panel without horizontal scrolling.
    await page.setViewportSize({ width: 430, height: 900 });
    await frames(); await frames();
    const overflow = await page.evaluate(() => {
      const panel = document.getElementById('goal-agenda');
      return { scroll: panel.scrollWidth, client: panel.clientWidth };
    });
    assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
    await page.screenshot({ path: '.cache/agenda-tab-narrow.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
