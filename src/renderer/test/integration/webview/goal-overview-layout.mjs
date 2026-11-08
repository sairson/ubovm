import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const screenshotDirectory = '.cache/goal-overview-layout';
const now = Date.now();
const criteria = Array.from({ length: 18 }, (_, index) => ({
  id: `c${index}`, text: `验收标准 ${index + 1}：检查目标站点的响应头与安全配置是否满足要求`, done: index % 3 === 0
}));
const parts = Array.from({ length: 36 }, (_, index) => ({
  id: `p${index}`, type: 'text', status: 'completed', startedAt: now - 1000 * (36 - index),
  text: `第 ${index + 1} 条调度记录：Reason 规划并派发 Worker 检查响应头、缓存策略与跨域配置，随后记录证据。`.repeat(2)
}));
const state = {
  type: 'state', mode: 'goal',
  conversation: { id: 'overview-layout', title: '思考与调度日志响应式' },
  goal: { objective: '让概览日志占满主空间，同时保留验收进度与验收清单', criteria, notes: [] },
  messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: true,
  execution: { status: 'running', busy: true, phase: 'execute', parts, activities: [], workers: [] }
};

let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const measure = page => page.evaluate(() => {
  const panels = document.getElementById('goal-panels');
  const overview = document.getElementById('goal-overview');
  const content = document.getElementById('goal-output-content');
  const summary = document.querySelector('.goal-overview-summary');
  const acceptance = document.querySelector('.goal-acceptance-panel');
  const rect = element => element?.getBoundingClientRect();
  const inViewport = element => { const box = rect(element); return Boolean(box) && box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.height > 0; };
  return {
    panelsHeight: Math.round(rect(panels)?.height ?? 0), overviewHeight: Math.round(rect(overview)?.height ?? 0),
    contentClient: content?.clientHeight ?? 0, contentScroll: content?.scrollHeight ?? 0,
    summaryVisible: inViewport(summary), acceptanceVisible: inViewport(acceptance),
    outputPanelHeight: Math.round(rect(document.getElementById('goal-output-panel'))?.height ?? 0),
    pageScrolling: document.scrollingElement.scrollHeight > window.innerHeight + 4
  };
});

for (const viewport of [{ width: 1180, height: 800, name: 'wide' }, { width: 390, height: 800, name: 'narrow' }]) {
  test(`overview log fills the workspace and keeps the acceptance header and footer visible (${viewport.name})`, async t => {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'overview-layout' }) }));
    await page.goto('http://overview-layout.test/');
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), state);
    await frames(); await frames();

    const collapsed = await measure(page);
    assert.ok(collapsed.overviewHeight >= collapsed.panelsHeight - 64, `overview fills the workspace: ${JSON.stringify(collapsed)}`);
    assert.ok(collapsed.contentScroll > collapsed.contentClient + 4, 'the execution log scrolls inside its card');
    assert.equal(collapsed.summaryVisible, true, 'acceptance progress header stays visible');
    assert.equal(collapsed.acceptanceVisible, true, 'acceptance checklist footer stays visible');
    assert.equal(collapsed.pageScrolling, false, 'the overview page itself does not scroll');
    await page.screenshot({ path: `${screenshotDirectory}/${viewport.name}-collapsed.png` });

    await page.locator('.goal-acceptance-panel > summary').click();
    await frames(); await frames();
    const expanded = await page.evaluate(() => {
      const list = document.querySelector('.goal-acceptance-panel[open] .criteria-list');
      const content = document.getElementById('goal-output-content');
      const rect = document.querySelector('.goal-acceptance-panel').getBoundingClientRect();
      return {
        open: document.querySelector('.goal-acceptance-panel').open,
        listClient: list?.clientHeight ?? 0, listScroll: list?.scrollHeight ?? 0,
        contentClient: content?.clientHeight ?? 0, acceptanceInViewport: rect.bottom <= window.innerHeight + 1,
        pageScrolling: document.scrollingElement.scrollHeight > window.innerHeight + 4
      };
    });
    assert.equal(expanded.open, true);
    assert.ok(expanded.listScroll > expanded.listClient + 4, 'an expanded checklist scrolls internally');
    assert.ok(expanded.contentClient >= 100, `the log keeps usable height while the checklist is open: ${JSON.stringify(expanded)}`);
    assert.equal(expanded.acceptanceInViewport, true, 'the expanded checklist footer stays inside the viewport');
    assert.equal(expanded.pageScrolling, false);
    await page.screenshot({ path: `${screenshotDirectory}/${viewport.name}-expanded.png` });
    assert.deepEqual(errors, []);
  });
}

test('live ticks that omit unchanged heavy projections keep the summary and domain ledger stable', async t => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage() {} }); });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'overview-heavy' }) }));
  await page.goto('http://overview-heavy.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = () => page.evaluate(() => {
    const summary = document.querySelector('.goal-overview-summary');
    return {
      signalsHidden: document.getElementById('goal-signals').hidden,
      domainHidden: document.getElementById('goal-domain-panel').hidden,
      domainRows: document.querySelectorAll('#goal-domain-list tr').length,
      summaryHeight: Math.round(summary?.getBoundingClientRect().height ?? 0)
    };
  });
  const blackboard = { sessionId: 'overview-heavy', revision: 8, rootId: 'root', goal: state.goal.objective, nodes: [
    { id: 'root', kind: 'root', parentIds: [], fact: { content: state.goal.objective } },
    { id: 'fact-1', kind: 'fact', parentIds: ['root'], fact: { content: JSON.stringify({ version: 1, outcome: 'confirmed', statement: '发现一个子域', coverage: [], evidence: [] }) } }
  ] };
  const memory = { revision: 2, notes: [{ id: 'n1', content: 'note' }], domainInventory: { revision: 1, seedRoots: ['example.com'], domains: [
    { hostname: 'a.example.com', kind: 'subdomain', discovery: 'seed', test_status: 'tested' },
    { hostname: 'b.example.com', kind: 'subdomain', discovery: 'enum', test_status: 'pending' }
  ] } };
  const baseExecution = { status: 'running', busy: true, phase: 'execute', parts, activities: [], workers: [], blackboard, memory,
    graph: { revision: 8, nodes: 2, intents: 0, facts: 1, edges: 1, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false } };
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
    ...state, viewRevision: 1, execution: baseExecution
  });
  await frames();
  const fullState = await measure();
  assert.equal(fullState.signalsHidden, false, 'signals strip starts visible');
  assert.equal(fullState.domainHidden, false, 'domain ledger starts visible');
  assert.equal(fullState.domainRows, 2);

  // The host deletes each unchanged heavy projection independently. A tick that
  // changes only the board must not blank unchanged memory (domain ledger), and a
  // tick that changes only memory must not blank the unchanged board (signals).
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
    type: 'executionState', conversationId: state.conversation.id, viewRevision: 2, busy: true,
    execution: { status: 'running', busy: true, phase: 'execute', parts, activities: [], workers: [], blackboard: { ...blackboard, revision: 9 } }
  });
  await frames();
  const boardOnly = await measure();
  assert.equal(boardOnly.signalsHidden, false, 'signals survive a board-only tick');
  assert.equal(boardOnly.domainHidden, false, 'omitted unchanged memory keeps the domain ledger visible');
  assert.equal(boardOnly.summaryHeight, fullState.summaryHeight, 'summary height must not jump');

  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
    type: 'executionState', conversationId: state.conversation.id, viewRevision: 3, busy: true,
    execution: { status: 'running', busy: true, phase: 'execute', parts, activities: [], workers: [], memory: { ...memory, revision: 3 } }
  });
  await frames();
  const memoryOnly = await measure();
  assert.equal(memoryOnly.signalsHidden, false, 'omitted unchanged board keeps the signals strip visible');
  assert.equal(memoryOnly.domainHidden, false);
  assert.equal(memoryOnly.summaryHeight, fullState.summaryHeight, 'summary height must not jump');

  // An explicitly empty projection still means "removed" and hides the ledger.
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
    type: 'executionState', conversationId: state.conversation.id, viewRevision: 4, busy: true,
    execution: { status: 'running', busy: true, phase: 'execute', parts, activities: [], workers: [], memory: { revision: 4, notes: [] } }
  });
  await frames();
  assert.equal((await measure()).domainHidden, true, 'an explicit memory without the ledger hides it');
  assert.deepEqual(errors, []);
});

