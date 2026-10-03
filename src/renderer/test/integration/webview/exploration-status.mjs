import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

test('global header shows live exploration status across assist, notes and goal views', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(value) { window.sent.push(value); } }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'status-test' }) }));
    await page.goto('http://status.test/');
    const run = { id: 'goal-1', title: '交付最终产品', status: 'running', busy: true, workerCount: 3, activeWorkers: 2 };
    const inactiveRuns = ['idle', 'completed', 'failed', 'interrupted'].map(status => ({ ...run, id: status, title: status, status, busy: false }));
    const execution = { status: 'idle', busy: false, explorationRuns: [run, ...inactiveRuns] };
    const send = async data => {
      await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await send({ type: 'state', mode: 'assist', conversation: { id: 'assist-1', title: '协助' }, messages: [], provider: { label: '测试', connected: true }, context: { workspace: '测试' }, busy: false, execution });
    assert.equal(await page.locator('#exploration-runs').isVisible(), true);
    assert.equal(await page.locator('.topbar #exploration-runs').count(), 1);
    assert.equal(await page.locator('#exploration-run-count').textContent(), '1 运行中');
    assert.equal(await page.locator('#exploration-run-list .exploration-run').count(), 1);
    await page.locator('#exploration-runs > summary').click();
    assert.match(await page.locator('#exploration-run-list').textContent(), /2 个任务运行中 \/ 共 3 个/);
    await page.locator('#prompt-input').click();
    await page.locator('#prompt-input').fill('继续协助工作');
    await page.waitForFunction(() => !document.getElementById('submit-prompt').disabled);
    assert.equal(await page.locator('#submit-prompt').isEnabled(), true);
    await send({ type: 'executionState', conversationId: 'assist-1', busy: false, execution: { ...execution, explorationRuns: [{ ...run, status: 'failed', busy: false, activeWorkers: 0, error: '连接中断' }] } });
    assert.equal(await page.locator('#exploration-runs').isVisible(), false);
    assert.equal(await page.locator('#exploration-run-list .exploration-run').count(), 0);
    await send({ type: 'executionState', conversationId: 'assist-1', busy: false, execution });
    await page.locator('#exploration-runs > summary').click();
    await page.getByRole('button', { name: '交付最终产品', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'openExploration', goalSessionId: 'goal-1' });
    await page.locator('#assist-notes-toggle').click();
    assert.equal(await page.locator('#exploration-runs').isVisible(), true);
    await send({ type: 'state', mode: 'goal', conversation: { id: 'goal-2', title: '另一个探索' },
      goal: { objective: '另一个探索', criteria: [], notes: [] }, messages: [], provider: { connected: true }, context: {}, busy: false, execution });
    for (const width of [390, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['overview', 'board', 'workers', 'notes']) {
        await page.locator('#goal-view-switcher > summary').click();
        await page.locator('#goal-tab-' + view).click();
        assert.equal(await page.locator('#exploration-runs').isVisible(), true);
        await page.locator('#exploration-runs > summary').click();
        assert.equal(await page.getByRole('button', { name: '交付最终产品', exact: true }).isVisible(), true);
        const box = await page.locator('.exploration-runs-popover').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${view} at ${width}px: ${JSON.stringify(box)}`);
        await page.locator('#exploration-runs > summary').press('Escape');
        assert.equal(await page.locator('#exploration-runs').getAttribute('open'), null);
      }
    }
    await page.locator('#exploration-runs > summary').click();
    await send({ type: 'executionState', conversationId: 'goal-2', busy: false, execution: { ...execution, explorationRuns: [{ ...run, status: 'completed', busy: false }, ...inactiveRuns] } });
    assert.equal(await page.locator('#exploration-runs').isVisible(), false);
    assert.equal(await page.locator('#exploration-runs').getAttribute('open'), null);
    assert.equal(await page.locator('#exploration-run-list .exploration-run').count(), 0);
    await send({ type: 'executionState', conversationId: 'goal-2', busy: false, execution: { ...execution, explorationRuns: [] } });
    assert.equal(await page.locator('#exploration-runs').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
