import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

test('long Chinese text and paths stay inside readable cards with aligned connections', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
      await page.setContent('<div id="board"></div>');
      for (const path of ['styles.css', 'theme.css', 'goal/blackboard-graph.css']) await page.addStyleTag({ path: 'src/renderer/webview/' + path });
      for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
      await page.evaluate(dark => {
        document.body.classList.toggle('vscode-dark', dark);
        window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: value => value || '', statusText: value => value });
        window.graph.update({ sessionId: 'text', rootId: 'root', goal: '优化探索过程中的信息展示，让重要结论更容易阅读和追溯', nodes: [
          { id: 'root', kind: 'root', parentIds: [] },
          { id: 'chinese', kind: 'fact', parentIds: ['root'], fact: { content: '已经确认笔记在持久化成功后可以立即展示，探索任务仍在执行时也能查看最新结果。'.repeat(4) } },
          { id: 'path', kind: 'fact', parentIds: ['root'], fact: { content: 'src/renderer/webview/goal/very_long_unbroken_path_segment_that_must_wrap_without_overflow.js' } },
          { id: 'pending', kind: 'intent', parentIds: ['chinese'], intent: { description: '继续检查显示效果', status: 'running' } }
        ] });
      }, dark);
      const cards = await page.locator('.graph-node[data-kind="fact"]').evaluateAll(nodes => nodes.map(node => {
        const title = node.querySelector('.graph-node-title'), info = node.querySelector('.graph-node-info');
        const box = node.getBoundingClientRect(), text = title.getBoundingClientRect(), footer = info.getBoundingClientRect();
        return { width: box.width, titleHeight: text.height, fontSize: getComputedStyle(title).fontSize,
          inside: text.left >= box.left && text.right <= box.right && footer.bottom <= box.bottom,
          separate: text.bottom <= footer.top, overflow: node.scrollWidth > node.clientWidth };
      }));
      for (const card of cards) {
        assert.equal(card.width, 240); assert.equal(card.fontSize, '13px');
        assert.ok(card.titleHeight <= 60 && card.titleHeight > 20);
        assert.ok(card.inside && card.separate); assert.equal(card.overflow, false);
      }
      const endpoint = await page.locator('.graph-edges path[data-source="root"][data-target="chinese"]:not(.graph-edge-hit)').evaluate(line => {
        const root = document.querySelector('[data-node-id="root"]').getBoundingClientRect(), canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
        const start = line.getPointAtLength(0);
        return { x: start.x, y: start.y, expectedX: root.left - canvas.left + root.width / 2, expectedY: root.bottom - canvas.top };
      });
      assert.equal(endpoint.x, endpoint.expectedX); assert.equal(endpoint.y, endpoint.expectedY);
      await page.locator('[data-node-id="chinese"]').click();
      assert.match(await page.locator('.graph-detail h3').textContent(), /最新结果/);
      await page.locator('.graph-detail-close').click();
      if (process.env.UBOVM_UI_PREVIEW) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/graph-' + (dark ? 'dark' : 'light') + '.png' });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('final goal displays the objective and supports dragging, refresh and layout reset', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="board"></div>');
    await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
    for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
    await page.evaluate(() => {
      window.snapshot = { sessionId: 'one', rootId: 'root', goal: '交付可使用的最终产品', nodes: [{ id: 'root', kind: 'root', parentIds: [] }] };
      window.details = [];
      window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: value => value || '', statusText: value => value, onDetail: value => window.details.push(value) });
      window.graph.update(window.snapshot);
    });
    const goal = page.locator('.graph-goal-badge');
    assert.match(await goal.textContent(), /最终目标交付可使用的最终产品/);
    const before = await goal.boundingBox();
    const initialPosition = await goal.evaluate(node => [node.style.left, node.style.top]);
    await page.mouse.move(before.x + 50, before.y + 30);
    await page.mouse.down(); await page.mouse.move(before.x + 150, before.y + 90, { steps: 8 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const after = await goal.boundingBox();
    assert.ok(Math.abs(after.x - before.x - 100) < 2);
    assert.ok(Math.abs(after.y - before.y - 60) < 2);
    assert.equal(await page.evaluate(() => window.details.length), 0, 'drag does not open details');
    await page.evaluate(() => window.graph.update({ ...window.snapshot, revision: 2 }));
    assert.deepEqual(await goal.boundingBox(), after, 'refresh preserves the dragged position');
    await goal.click();
    assert.equal(await page.evaluate(() => window.details.at(-1).title), '交付可使用的最终产品');
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    assert.deepEqual(await goal.evaluate(node => [node.style.left, node.style.top]), initialPosition, 'reset restores the default layout before fitting the zoom');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
