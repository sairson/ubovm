import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

test('graph suspension coalesces snapshots and disposal rejects late updates and controls', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="board"></div><dialog id="settings-dialog"></dialog>');
  await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
  for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
  const result = await page.evaluate(async () => {
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let projections = 0, details = 0;
    const project = window.projectExplorationGraph;
    window.projectExplorationGraph = (...args) => { projections++; return project(...args); };
    const board = document.getElementById('board'), settings = document.getElementById('settings-dialog');
    const graph = createBlackboardGraph(board, { factText: value => value || '', statusText: value => value, onDetail: () => { details++; } });
    const snapshot = index => ({ sessionId: 'session-' + index, goal: 'goal-' + index, rootId: 'r', nodes: [{ id: 'r', kind: 'root', parentIds: [] }] });
    graph.update(snapshot(0)); await settle();
    let deliveredMutations = 0;
    const observer = new MutationObserver(records => { deliveredMutations += records.length; });
    observer.observe(board, { subtree: true, attributes: true, childList: true, characterData: true });
    document.querySelector('[aria-label="放大探索图"]').click();
    dispatchEvent(new Event('pagehide')); observer.takeRecords(); projections = 0;
    for (let index = 1; index <= 1000; index++) graph.update(snapshot(index));
    graph.select('r'); graph.closeDetail();
    let pausedMutations = observer.takeRecords().length;
    await settle();
    pausedMutations += observer.takeRecords().length + deliveredMutations;
    const pausedProjections = projections;
    dispatchEvent(new Event('pageshow')); await settle();
    const resumedProjections = projections, latest = document.querySelector('.graph-goal-badge .graph-node-title').textContent;
    settings.open = true; dispatchEvent(new Event('ubovm-settings-visibility')); observer.takeRecords(); projections = 0;
    graph.update(snapshot(1001));
    const settingsMutations = observer.takeRecords().length, settingsProjections = projections;
    settings.open = false; dispatchEvent(new Event('ubovm-settings-visibility')); await settle();
    const settingsLatest = document.querySelector('.graph-goal-badge .graph-node-title').textContent;
    const staleFit = document.querySelector('.graph-fit'), staleNode = document.querySelector('[data-node-id="r"]');
    graph.dispose(); observer.takeRecords(); deliveredMutations = 0; projections = details = 0;
    graph.update(snapshot(2000)); graph.select('r'); graph.closeDetail(); staleFit.click(); staleNode.click();
    dispatchEvent(new Event('pageshow')); dispatchEvent(new Event('visibilitychange')); await settle();
    const disposedMutations = observer.takeRecords().length + deliveredMutations;
    observer.disconnect();
    return { pausedMutations, pausedProjections, resumedProjections, latest, settingsMutations, settingsProjections, settingsLatest, disposedMutations, projections, details, children: board.childElementCount };
  });
  assert.deepEqual(result, { pausedMutations: 0, pausedProjections: 0, resumedProjections: 1, latest: 'goal-1000', settingsMutations: 0, settingsProjections: 0, settingsLatest: 'goal-1001', disposedMutations: 0, projections: 0, details: 0, children: 0 });
  assert.deepEqual(errors, []);
});

test('panned nodes can cross the original top and left canvas boundaries without clipping their edges', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.setContent('<div id="board" style="width:1100px"></div>');
  await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
  for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
  await page.evaluate(() => {
    window.graph = createBlackboardGraph(document.getElementById('board'), { factText: v => v || '', statusText: v => v });
    window.snapshot = { sessionId: 'negative-drag', rootId: 'r', nodes: [
      { id: 'r', kind: 'root', parentIds: [] },
      { id: 'a', kind: 'fact', parentIds: ['r'], fact: { content: '节点顶部应完整显示，位置可自由调整' } }
    ] };
    graph.update(snapshot);
  });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frames();
  const viewport = await page.locator('.graph-viewport').boundingBox();
  await page.mouse.move(viewport.x + 20, viewport.y + 20);
  await page.mouse.down(); await page.mouse.move(viewport.x + 260, viewport.y + 200, { steps: 5 }); await page.mouse.up();
  const node = page.locator('[data-node-id="a"]');
  const box = await node.boundingBox();
  const old = await node.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  const dx = -old.x - 40, dy = -old.y - 160;
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down(); await page.mouse.move(box.x + 30 + dx, box.y + 12 + dy, { steps: 8 }); await page.mouse.up(); await frames();
  const moved = await node.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  assert(Math.abs(moved.x + 40) < 2 && Math.abs(moved.y + 160) < 2, JSON.stringify(moved));
  const visible = await node.boundingBox();
  assert(visible.x >= viewport.x && visible.y >= viewport.y);
  assert.equal(await node.evaluate(el => document.elementFromPoint(el.getBoundingClientRect().x + 20, el.getBoundingClientRect().y + 5)?.closest('[data-node-id]') === el), true);
  assert.equal(await page.locator('.graph-edges').evaluate(el => getComputedStyle(el).overflow), 'visible');
  assert.equal(await page.locator('.graph-edge-hit').first().evaluate(edge => {
    const local = edge.getPointAtLength(edge.getTotalLength() - 10);
    const screen = new DOMPoint(local.x, local.y).matrixTransform(edge.getScreenCTM());
    return local.y < 0 && document.elementsFromPoint(screen.x, screen.y).includes(edge);
  }), true, 'the negative-coordinate segment remains visible and clickable after panning');
  await page.evaluate(() => graph.update({ ...snapshot, revision: 2 })); await frames();
  assert.deepEqual(await node.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })), moved);
  await page.getByRole('button', { name: '适应画布', exact: true }).click(); await frames();
  assert.deepEqual(await node.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })), old);
});

test('zoomed-out graphs skip label measurements and keep intent edges keyboard accessible', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="board"></div>');
    await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
    for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
    const result = await page.evaluate(async () => {
      const graph = createBlackboardGraph(document.getElementById('board'), { factText: v => v || '', statusText: v => v });
      graph.update({ sessionId: 'zoom', rootId: 'r', nodes: [
        { id: 'r', kind: 'root', parentIds: [] },
        { id: 'i', kind: 'intent', parentIds: ['r'], intent: { description: 'Explore', status: 'running' } }
      ] });
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await settle();
      const minus = document.querySelector('[aria-label="缩小探索图"]');
      for (let i = 0; i < 10; i++) minus.click();
      await settle();
      let reads = 0;
      for (const element of document.querySelectorAll('.graph-node, .graph-edge-label')) {
        const original = element.getBoundingClientRect.bind(element);
        element.getBoundingClientRect = () => { reads++; return original(); };
      }
      const label = document.querySelector('.graph-edge-label[data-selection-id="i"]');
      label.setAttribute('tabindex', '0'); label.style.visibility = 'visible'; label.focus();
      document.querySelector('[aria-label="放大探索图"]').click();
      await settle();
      const line = label.previousElementSibling;
      return { reads, hidden: label.getAttribute('aria-hidden'), tabindex: line.getAttribute('tabindex'), focused: document.activeElement === line };
    });
    assert.deepEqual(result, { reads: 0, hidden: 'true', tabindex: '0', focused: true });
  } finally { await browser.close(); }
});

test('live graph updates reuse edges, retain focus and resume layout after page restoration', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="board" style="width:900px"></div>');
    await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
    for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
    const result = await page.evaluate(() => {
      let textReads = 0, details = 0;
      const snapshot = { sessionId: 'stable', rootId: 'r', nodes: [
        { id: 'r', kind: 'root', parentIds: [] },
        { id: 'f', kind: 'fact', parentIds: ['r'], fact: { content: JSON.stringify({ version: 1, statement: 'Observed, needs control', outcome: 'partial', evidence: [] }) } },
        { id: 'i', kind: 'intent', parentIds: ['f'], intent: { description: 'Control', status: 'running' } }
      ] };
      const graph = createBlackboardGraph(document.getElementById('board'), { factText: value => { textReads++; return value || ''; }, statusText: value => value, onDetail: () => { details++; } });
      graph.update(snapshot);
      const line = document.querySelector('path[data-intent-id="i"]'); line.setAttribute('tabindex', '0'); line.focus();
      const original = [...document.querySelector('.graph-edges').children];
      for (let index = 0; index < 20; index++) graph.update(snapshot);
      const reused = original.every((element, index) => element === document.querySelector('.graph-edges').children[index]);
      const focused = document.activeElement === line;
      textReads = 0; graph.update(snapshot, true);
      const geometryReads = textReads;
      line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const detailCalls = details;
      window.dispatchEvent(new Event('pagehide'));
      document.getElementById('board').style.width = '1800px';
      window.dispatchEvent(new Event('pageshow'));
      const width = parseFloat(document.querySelector('.graph-canvas').style.width);
      const outcome = document.querySelector('[data-node-id="f"] .graph-node-state').textContent;
      graph.update({ ...snapshot, nodes: snapshot.nodes.slice(0, 2) });
      return { reused, focused, geometryReads, detailCalls, width, outcome, staleEdges: document.querySelectorAll('[data-intent-id="i"]').length };
    });
    assert.deepEqual(result, { reused: true, focused: true, geometryReads: 0, detailCalls: 1, width: 1800, outcome: '事实 · 待补证', staleEdges: 0 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('graph search locates intent frontiers and traces branches across live updates', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="board"></div>');
    await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
    for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
    await page.evaluate(() => {
      window.snapshot = { sessionId: 'search', rootId: 'r', nodes: [
        { id: 'r', kind: 'root', parentIds: [] },
        { id: 'a', kind: 'fact', parentIds: ['r'], fact: { content: '证据 A' } },
        { id: 'b', kind: 'fact', parentIds: ['r'], fact: { content: '证据 B' } },
        { id: 'i', kind: 'intent', parentIds: ['a'], intent: { description: '检查路径', status: 'running' } }
      ] };
      window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: v => v || '', statusText: v => v, onDetail: () => {} });
      window.graph.update(window.snapshot);
    });
    await page.getByRole('searchbox', { name: '搜索探索图' }).fill('检查路径');
    await page.getByRole('searchbox').press('Enter');
    assert.equal(await page.locator('.graph-search-count').textContent(), '1 / 1');
    assert.equal(await page.locator('.graph-frontier').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.graph-frontier').evaluate(n => n === document.activeElement), true);
    await page.getByLabel('探索路径').selectOption('upstream');
    assert.equal(await page.locator('[data-node-id="b"]').evaluate(n => n.classList.contains('is-muted')), true);
    assert.equal(await page.locator('[data-node-id="a"]').evaluate(n => n.classList.contains('is-muted')), false);
    await page.evaluate(() => {
      window.snapshot.nodes[3].resultId = 'result';
      window.snapshot.nodes[3].intent.status = 'completed';
      window.snapshot.nodes.push({ id: 'result', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '已确认' } });
      window.graph.update(window.snapshot);
      window.graph.select('i');
    });
    assert.equal(await page.locator('.graph-frontier').count(), 0);
    assert.equal(await page.locator('[data-node-id="result"]').getAttribute('aria-pressed'), 'true');
    await page.getByLabel('探索路径').selectOption('downstream');
    assert.equal(await page.locator('[data-node-id="result"]').evaluate(n => n.classList.contains('is-muted')), false);
    await page.getByRole('searchbox').fill('不存在');
    assert.equal(await page.getByRole('button', { name: '下一项' }).isDisabled(), true);
    await page.evaluate(() => window.graph.update({ ...window.snapshot, sessionId: 'other' }));
    assert.equal(await page.getByRole('searchbox').inputValue(), '');
    assert.equal(await page.getByLabel('探索路径').inputValue(), 'all');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

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
        const x = start.x - (root.left - canvas.left), y = start.y - (root.top - canvas.top);
        return { inside: x >= -1 && x <= root.width + 1 && y >= -1 && y <= root.height + 1,
          boundary: Math.min(Math.abs(x), Math.abs(y), Math.abs(x - root.width), Math.abs(y - root.height)) < 1 };
      });
      assert.equal(endpoint.inside, true); assert.equal(endpoint.boundary, true);
      await page.locator('[data-node-id="chinese"]').click();
      assert.equal(await page.locator('.graph-detail h3').textContent(), '事实详情');
      assert.match(await page.locator('.graph-detail-text').textContent(), /最新结果/);
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
      const project = window.projectExplorationGraph, rank = window.rankExplorationGraph;
      window.graphComputations = { project: 0, rank: 0 };
      window.projectExplorationGraph = value => { window.graphComputations.project++; return project(value); };
      window.rankExplorationGraph = value => { window.graphComputations.rank++; return rank(value); };
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
    assert.deepEqual(await page.evaluate(() => window.graphComputations), { project: 1, rank: 1 }, 'drag reuses the unchanged graph structure');
    await page.evaluate(() => window.graph.update({ ...window.snapshot, revision: 2 }));
    assert.deepEqual(await page.evaluate(() => window.graphComputations), { project: 2, rank: 2 }, 'new publications recompute structure');
    assert.deepEqual(await goal.boundingBox(), after, 'refresh preserves the dragged position');
    await goal.click();
    assert.equal(await page.evaluate(() => window.details.at(-1).title), '交付可使用的最终产品');
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    assert.deepEqual(await goal.evaluate(node => [node.style.left, node.style.top]), initialPosition, 'reset restores the default layout before fitting the zoom');
    await page.evaluate(() => {
      window.snapshot.nodes.push({ id: 'temporary', kind: 'fact', parentIds: ['root'], fact: { content: '临时节点' } });
      window.graph.update(window.snapshot);
    });
    const fact = page.locator('[data-node-id="temporary"]');
    const defaultPosition = await fact.evaluate(node => [node.style.left, node.style.top]);
    const factBox = await fact.boundingBox();
    await page.mouse.move(factBox.x + 40, factBox.y + 40);
    await page.mouse.down(); await page.mouse.move(factBox.x + 120, factBox.y + 60, { steps: 5 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.notDeepEqual(await fact.evaluate(node => [node.style.left, node.style.top]), defaultPosition);
    await page.evaluate(() => {
      const removed = window.snapshot.nodes.pop(); window.graph.update(window.snapshot);
      window.snapshot.nodes.push(removed); window.graph.update(window.snapshot);
    });
    assert.deepEqual(await fact.evaluate(node => [node.style.left, node.style.top]), defaultPosition, 'removed nodes do not retain stale drag positions');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('completed evidence points to the final goal node', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.setContent('<div id="board"></div>');
    for (const file of ['styles.css', 'theme.css', 'goal/blackboard-graph.css']) await page.addStyleTag({ path: 'src/renderer/webview/' + file });
    for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
    const board = {
      sessionId: 'done', rootId: 'root', goal: '交付可使用的最终产品',
      nodes: [
        { id: 'root', kind: 'root', parentIds: [] },
        { id: 'proof', kind: 'fact', parentIds: ['root'], fact: { content: '验收已通过' } },
        { id: 'intent-1', kind: 'intent', parentIds: ['proof'], intent: { description: '核对交付', status: 'completed' }, fact: { content: '交付物已经可以运行' } }
      ]
    };
    await page.evaluate(snapshot => {
      window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: value => value || '', statusText: value => value });
      window.graph.update(snapshot);
    }, board);
    assert.equal(await page.locator('.graph-edges path[data-kind="achieves"]').count(), 0);
    assert.equal(await page.locator('.graph-goal-badge').getAttribute('data-achieved'), 'false');
    await page.evaluate(snapshot => window.graph.update({ ...snapshot, completionEvidenceIds: ['proof', 'intent-1', 'missing'] }), board);
    const links = page.locator('.graph-edge-hit[data-target="final-goal"]');
    assert.deepEqual(await links.evaluateAll(nodes => nodes.map(node => node.dataset.source).sort()), ['proof', 'result:intent-1']);
    assert.equal(await page.locator('.graph-goal-badge').getAttribute('data-achieved'), 'true');
    assert.match(await page.locator('.graph-edge-label[data-kind="achieves"]').first().textContent(), /达成目标/);
    const attached = await links.evaluateAll(paths => {
      const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x - canvas.x, y: r.y - canvas.y, width: r.width, height: r.height }; };
      const goal = box(document.querySelector('.graph-goal-badge'));
      return paths.map(path => {
        const source = box(document.querySelector('[data-node-id="' + path.dataset.source + '"]'));
        const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
        const onBox = (p, r) => p.x >= r.x - 1 && p.x <= r.x + r.width + 1 && p.y >= r.y - 1 && p.y <= r.y + r.height + 1
          && Math.min(Math.abs(p.x - r.x), Math.abs(p.y - r.y), Math.abs(p.x - r.x - r.width), Math.abs(p.y - r.y - r.height)) < 1.5;
        return onBox(start, source) && onBox(end, goal);
      });
    });
    assert.deepEqual(attached, [true, true]);
    const goal = page.locator('.graph-goal-badge');
    const before = await goal.boundingBox();
    await page.mouse.move(before.x + 40, before.y + 30);
    await page.mouse.down(); await page.mouse.move(before.x + 140, before.y + 80, { steps: 6 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const moved = await links.evaluateAll(paths => {
      const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
      const goal = document.querySelector('.graph-goal-badge').getBoundingClientRect();
      return paths.every(path => {
        const end = path.getPointAtLength(path.getTotalLength());
        const x = end.x + canvas.x, y = end.y + canvas.y;
        return x >= goal.x - 1 && x <= goal.right + 1 && y >= goal.y - 1 && y <= goal.bottom + 1;
      });
    });
    assert.equal(moved, true);
    await page.evaluate(snapshot => window.graph.update(snapshot), board);
    assert.equal(await page.locator('.graph-edges path[data-kind="achieves"]').count(), 0);
    assert.equal(await page.locator('.graph-goal-badge').getAttribute('data-achieved'), 'false');
  } finally { await browser.close(); }
});

// Exercise the graph payload and the actual sidebar page together.
test('fact sidebar separates structured evidence and shows plain facts only once', async t => {
  const { renderSidebar } = await import('../../../host/ui/blackboard-sidebar.cjs');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const graphPage = await browser.newPage();
  await graphPage.setContent('<div id="board"></div>');
  for (const name of ['exploration-model', 'blackboard-graph']) await graphPage.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
  const detail = await graphPage.evaluate(() => {
    const fact = { version: 1, statement: '已确认配置文件中存在超时设置。', evidence: [{ observation: '读取配置文件得到 timeout=30。', toolCallId: 'read-1' }], coverage: [{ point: '检查配置', result: '已读取', status: 'confirmed' }], limitations: ['尚未验证实际运行行为。'], failedChecks: [], nextSteps: ['执行运行时验证。'] };
    const graph = window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: value => value || '', statusText: value => value, onDetail: value => window.detail = value });
    graph.update({ sessionId: 'test', rootId: 'r', nodes: [
      { id: 'r', kind: 'root', goal: '验证配置', parentIds: [] },
      { id: 'source', kind: 'fact', parentIds: ['r'], fact: { content: '来源信息'.repeat(100) } },
      { id: 'fact', kind: 'fact', parentIds: ['source'], fact: { content: JSON.stringify(fact) } },
      { id: 'plain', kind: 'fact', parentIds: ['r'], fact: { content: '普通事实只显示一次。\n第二行保留。' } }
    ] });
    graph.select('fact'); return window.detail;
  });
  assert.equal(detail.title, '事实详情');
  assert.deepEqual(detail.sections.map(section => section.label), ['结论', '验证覆盖', '证据', '限制', '后续步骤']);
  assert.match(detail.sections.find(section => section.label === '证据').text, /read-1/);
  assert.match(await graphPage.locator('[data-node-id="fact"] .graph-node-info').textContent(), /1 条证据 · 1 项限制/);
  assert(detail.links[0].label.length < 110, 'source links contain a summary, not the entire parent fact');
  await graphPage.getByRole('searchbox', { name: '搜索探索图' }).fill('timeout=30');
  assert.equal(await graphPage.locator('.graph-search-count').textContent(), '1 / 1', 'evidence remains searchable');
  const page = await browser.newPage({ viewport: { width: 300, height: 850 } });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
  await page.route('http://sidebar.test/', route => route.fulfill({ contentType: 'text/html', body: renderSidebar() }));
  await page.goto('http://sidebar.test/');
  const emit = detail => page.evaluate(detail => dispatchEvent(new MessageEvent('message', { data: { type: 'detail', detail } })), detail);
  await emit(detail);
  const text = await page.locator('#detail').innerText();
  assert.equal(text.split('已确认配置文件中存在超时设置。').length - 1, 1);
  assert.equal(await page.locator('h1').innerText(), '事实详情');
  assert(await page.locator('.section').first().evaluate(element => getComputedStyle(element).fontWeight === '400'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow detail does not overflow horizontally');
  await page.screenshot({ path: '.cache/fact-sidebar.png', fullPage: true });
  const plain = await graphPage.evaluate(() => { graph.select('plain'); return window.detail; });
  await emit(plain);
  assert.equal((await page.locator('#detail').innerText()).split('普通事实只显示一次。').length - 1, 1);
  assert.equal((await page.locator('.section').textContent()).trimEnd(), '普通事实只显示一次。\n第二行保留。');
  const reading = { ...detail, sections: [...detail.sections, { label: '详细记录', text: '保留阅读位置。\n'.repeat(120) }] };
  await emit(reading);
  await page.evaluate(() => {
    window.savedParagraph = document.querySelector('.section');
    window.savedLink = document.querySelector('.links button');
    savedLink.focus(); window.scrollTo(0, 200);
    const range = document.createRange(); range.selectNodeContents(savedParagraph);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.readingScroll = scrollY;
  });
  await emit({ ...reading, sections: [...reading.sections, { label: '新增记录', text: '新的证据已写入。' }] });
  assert.deepEqual(await page.evaluate(() => ({
    sameParagraph: savedParagraph === document.querySelector('.section'),
    sameLink: savedLink === document.querySelector('.links button'),
    focused: document.activeElement === savedLink,
    selection: getSelection().toString().trimEnd(), stableScroll: Math.abs(scrollY - readingScroll) <= 1
  })), { sameParagraph: true, sameLink: true, focused: true, selection: '已确认配置文件中存在超时设置。', stableScroll: true });
  await emit({ ...detail, id: 'different-fact' });
  assert.equal(await page.evaluate(() => scrollY), 0, 'a different fact starts at the top');
});

test('all graph edges stay straight and attach to node boundaries across ranks and dragging', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  await page.setContent('<div id="board"></div>');
  for (const file of ['styles.css', 'theme.css', 'goal/blackboard-graph.css']) await page.addStyleTag({ path: 'src/renderer/webview/' + file });
  for (const name of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${name}.js` });
  await page.evaluate(() => {
    window.graph = window.createBlackboardGraph(document.querySelector('#board'), { factText: value => value || '', statusText: value => value });
    graph.update(window.straightSnapshot = { sessionId: 'straight', rootId: 'r', nodes: [
      { id: 'r', kind: 'root', parentIds: [] },
      { id: 'c', kind: 'fact', parentIds: ['r'], fact: { content: '并行分支' } },
      { id: 'a', kind: 'fact', parentIds: ['r'], fact: { content: '中间事实' } },
      { id: 'b', kind: 'fact', parentIds: ['r', 'a'], fact: { content: '多来源事实' } }
    ] });
  });
  async function verify() {
    const results = await page.locator('.graph-edge-hit').evaluateAll(paths => paths.map(path => {
      const canvas = document.querySelector('.graph-canvas').getBoundingClientRect();
      const rect = id => { const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect(); return { x: r.x - canvas.x, y: r.y - canvas.y, width: r.width, height: r.height }; };
      const a = rect(path.dataset.source), b = rect(path.dataset.target);
      const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
      const boundary = (p, r) => p.x >= r.x - 1 && p.x <= r.x + r.width + 1 && p.y >= r.y - 1 && p.y <= r.y + r.height + 1 && Math.min(Math.abs(p.x - r.x), Math.abs(p.y - r.y), Math.abs(p.x - r.x - r.width), Math.abs(p.y - r.y - r.height)) < 1;
      const dx = b.x + b.width / 2 - a.x - a.width / 2, dy = b.y + b.height / 2 - a.y - a.height / 2;
      return { straight: /^M[-\d.,e+]+ L[-\d.,e+]+$/.test(path.getAttribute('d')), boundaries: boundary(start, a) && boundary(end, b), aligned: Math.abs((end.x - start.x) * dy - (end.y - start.y) * dx) < .1 };
    }));
    assert.equal(results.length, 4);
    for (const result of results) assert.deepEqual(result, { straight: true, boundaries: true, aligned: true });
    assert(await page.locator('.graph-edges path').evaluateAll(paths => paths.every(path => !/[CQAS]/i.test(path.getAttribute('d') || ''))));
  }
  await verify();
  const positions = () => page.locator('[data-node-id]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.nodeId, [node.style.left, node.style.top]])));
  const before = await positions();
  await page.evaluate(() => graph.update({ ...straightSnapshot, nodes: [...straightSnapshot.nodes].reverse() }));
  assert.deepEqual(await positions(), before, 'input ordering cannot move existing branches');
  assert(await page.locator('.graph-edge-label[data-source="r"][data-target="a"] textPath').evaluate(text => {
    const track = document.querySelector(text.getAttribute('href'));
    return Math.abs(track.getPointAtLength(0).y - track.getPointAtLength(track.getTotalLength()).y) < 1;
  }), 'vertical edges keep their labels horizontal');
  const target = await page.locator('[data-node-id="b"]').boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down(); await page.mouse.move(target.x + target.width / 2 + 320, target.y + target.height / 2 - 350, { steps: 8 }); await page.mouse.up();
  await verify();
  await page.screenshot({ path: '.cache/straight-graph.png' });
});
