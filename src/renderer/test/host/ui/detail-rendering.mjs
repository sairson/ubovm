import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderSidebar } from '../../../host/ui/blackboard-sidebar.cjs';

const launch = () => chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });

test('a failed fact section preserves original lines and other sections, then retries the same detail', async t => {
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
  await page.route('http://fact-retry.test/', route => route.fulfill({ contentType: 'text/html', body: renderSidebar() }));
  await page.goto('http://fact-retry.test/');
  await page.evaluate(() => {
    window.original = UBOVMMarkdown;
    window.UBOVMMarkdown = { update(element, text, options) {
      if (text.startsWith('**first**')) throw new Error('section failure');
      return original.update(element, text, options);
    } };
    window.fact = { id: 'f', sessionId: 's', title: '事实', meta: '已确认', links: [], sections: [
      { label: '一', text: '**first**\nsecond line' }, { label: '二', text: '**second**' }
    ] };
    dispatchEvent(new MessageEvent('message', { data: { type: 'detail', detail: fact } }));
  });
  assert.equal(await page.locator('.section').first().textContent(), '**first**\nsecond line');
  assert.equal(await page.locator('.section').first().evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
  assert.equal(await page.locator('.section').nth(1).locator('strong').textContent(), 'second');
  await page.evaluate(() => { window.UBOVMMarkdown = original; dispatchEvent(new MessageEvent('message', { data: { type: 'detail', detail: fact } })); });
  assert.equal(await page.locator('.section').first().locator('strong').textContent(), 'first');
  assert.equal(await page.locator('.meta').textContent(), '已确认');
  assert.deepEqual(errors, []);
});

test('late fact link failures cannot overwrite a different node or an unloaded page', async t => {
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.requests = [];
    window.acquireVsCodeApi = () => ({ postMessage(message) { requests.push(message); } });
  });
  await page.route('http://fact-lifecycle.test/', route => route.fulfill({ contentType: 'text/html', body: renderSidebar() }));
  await page.goto('http://fact-lifecycle.test/');
  const send = id => page.evaluate(id => dispatchEvent(new MessageEvent('message', { data: { type: 'detail', detail: {
    id, sessionId: 's', title: id, meta: '当前节点 ' + id, links: [], sections: [{ label: '内容', text: '[来源](https://example.com)' }]
  } } })), id);
  await send('old'); await page.getByRole('link', { name: '来源' }).click();
  const old = await page.evaluate(() => requests.at(-1).requestId);
  await send('new');
  await page.evaluate(requestId => dispatchEvent(new MessageEvent('message', { data: { type: 'uiResult', requestId, ok: false, error: '旧链接失败' } })), old);
  assert.equal(await page.locator('.meta').textContent(), '当前节点 new');
  await page.getByRole('link', { name: '来源' }).click();
  await page.evaluate(() => {
    dispatchEvent(new Event('pagehide'));
    dispatchEvent(new MessageEvent('message', { data: { type: 'uiResult', requestId: requests.at(-1).requestId, ok: false, error: '关闭后的错误' } }));
  });
  assert.equal(await page.locator('.meta').textContent(), '当前节点 new');
  assert.deepEqual(errors, []);
});

test('right sidebar text tabs keep their font and clear their close buttons with native styles', async t => {
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div class="monaco-workbench"><div class="part sidebar pane-composite-part" style="width:300px"><div class="title has-composite-bar"><div class="composite-bar-container"><div class="composite-bar"><div class="monaco-action-bar"><ul class="actions-container"><li class="action-item checked"><a class="action-label">Worker</a><button class="ubovm-sidebar-tab-close">×</button></li><li class="action-item"><a class="action-label">搜索</a><button class="ubovm-sidebar-tab-close">×</button></li></ul></div></div></div></div></div></div>');
  for (const path of ['vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css', 'vendor/vscode/src/vs/workbench/browser/parts/media/paneCompositePart.css', 'src/renderer/workbench/workbench.css']) await page.addStyleTag({ path });
  const labels = await page.locator('.action-label').evaluateAll(nodes => nodes.map(n => {
    const style = getComputedStyle(n), item = n.parentElement, close = item.querySelector('button');
    const itemStyle = getComputedStyle(item);
    return {
      font: style.fontSize,
      weight: style.fontWeight,
      transform: style.textTransform,
      closeDisplay: getComputedStyle(close).display,
      radius: itemStyle.borderRadius,
      height: Math.round(item.getBoundingClientRect().height)
    };
  }));
  assert.deepEqual(labels, [
    { font: '12px', weight: '600', transform: 'none', closeDisplay: 'none', radius: '6px', height: 24 },
    { font: '12px', weight: '500', transform: 'none', closeDisplay: 'none', radius: '6px', height: 24 }
  ]);
  await page.locator('.action-item').first().hover();
  const hovered = await page.locator('.action-item').first().evaluate(item => {
    const label = item.querySelector('.action-label').getBoundingClientRect();
    const close = item.querySelector('button');
    const closeRect = close.getBoundingClientRect();
    return {
      closeDisplay: getComputedStyle(close).display,
      closeWidth: closeRect.width,
      clear: label.right <= closeRect.left + 0.5,
    };
  });
  assert.deepEqual(hovered, { closeDisplay: 'flex', closeWidth: 14, clear: true });
  assert.equal(await page.locator('.actions-container').evaluate(el => getComputedStyle(el).borderRadius), '0px');
  assert.equal(await page.locator('.action-item').first().evaluate(el => getComputedStyle(el).textTransform), 'none');
});

test('fact Markdown stays readable in narrow themes, sanitizes HTML and routes copy/link actions', async t => {
  const browser = await launch(); t.after(() => browser.close());
  for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 300, height: 700 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.requests = [];
      window.acquireVsCodeApi = () => ({ postMessage(message) {
        requests.push(message);
        if (message.requestId) setTimeout(() => dispatchEvent(new MessageEvent('message', { data: { type: 'uiResult', requestId: message.requestId, ok: true } })), 0);
      } });
    });
    await page.route('http://detail.test/', route => route.fulfill({ contentType: 'text/html', body: renderSidebar() }));
    await page.goto('http://detail.test/');
    await page.evaluate(dark => {
      if (dark) {
        document.body.style.setProperty('--vscode-foreground', '#eeeeee');
        document.body.style.setProperty('--vscode-sideBar-background', '#202020');
        document.body.style.setProperty('--vscode-textCodeBlock-background', '#303030');
      }
      dispatchEvent(new MessageEvent('message', { data: { type: 'detail', detail: {
        sessionId: 's', id: 'f', title: '事实详情', meta: '已确认', links: [], sections: [{ label: '证据', text:
          '已确认 **配置有效**。\n\n- 检查一\n- 检查二\n\n```js\nconst path = "' + 'long_path/'.repeat(40) + '";\n```\n\n| 参数 | 结果 |\n| --- | --- |\n| timeout | 30 |\n\n[来源](https://example.com)\n\n<img src=x onerror="window.attacked=true"><script>window.attacked=true</script>' }]
      } } }));
    }, dark);
    assert.equal(await page.locator('.section strong').textContent(), '配置有效');
    assert.equal(await page.locator('.section li').count(), 2);
    assert.equal(await page.locator('.section table').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(window.attacked)), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (dark) assert.equal(await page.locator('.section').evaluate(n => getComputedStyle(n).color), 'rgb(238, 238, 238)');
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.getByRole('link', { name: '来源' }).click();
    assert.deepEqual(await page.evaluate(() => requests.filter(r => r.requestId).map(r => [r.action, r.sessionId])), [['copyText', 's'], ['openMessageLink', 's']]);
    await page.screenshot({ path: `.cache/detail-rendering-${dark ? 'dark' : 'light'}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('streaming Worker thoughts preserve code nodes and finish their generation state', async t => {
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  await page.setContent('<div id="message" class="worker-transcript"></div>');
  for (const file of ['styles.css', 'messages/message-markdown.css', 'messages/message-view.css', 'workers/worker-panel.css']) await page.addStyleTag({ path: 'src/renderer/webview/' + file });
  for (const file of ['vendor/marked.umd.js', 'messages/message-markdown.js', 'messages/message-view.js']) await page.addScriptTag({ path: 'src/renderer/webview/' + file });
  await page.evaluate(() => {
    window.part = { id: 'thought', type: 'thinking', source: 'worker', status: 'streaming', startedAt: Date.now() - 2000, text: '```js\nconst result = 1;' };
    window.draw = () => UBOVMMessage.update(document.querySelector('#message'), '', { role: 'assistant', parts: [part], streaming: part.status === 'streaming' });
    draw(); window.code = document.querySelector('.md-code-card');
  });
  assert.equal(await page.locator('.thinking-title').textContent(), '思考中');
  assert.equal(await page.locator('.md-code-status').textContent(), '生成中');
  assert.ok(await page.locator('.thinking-time').textContent());
  await page.evaluate(() => { part.text += '\nconst next = 2;'; draw(); });
  assert.ok(await page.evaluate(() => code === document.querySelector('.md-code-card')));
  await page.evaluate(() => { part.status = 'completed'; part.endedAt = Date.now(); draw(); });
  assert.equal(await page.locator('.thinking-title').textContent(), '已思考');
  assert.equal(await page.locator('.md-code-status').textContent(), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('graph relayout follows viewport resizing without losing selection', async t => {
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent('<div id="board"></div>');
  await page.addStyleTag({ path: 'src/renderer/webview/goal/blackboard-graph.css' });
  for (const file of ['exploration-model', 'blackboard-graph']) await page.addScriptTag({ path: `src/renderer/webview/goal/${file}.js` });
  await page.evaluate(() => {
    window.graph = createBlackboardGraph(document.querySelector('#board'), { factText: x => x || '', statusText: x => x, onDetail() {} });
    graph.update({ sessionId: 's', rootId: 'r', nodes: [{ id: 'r', kind: 'root', parentIds: [] }, { id: 'f', kind: 'fact', parentIds: ['r'], fact: { content: '已确认' } }] });
    graph.select('f');
  });
  await page.setViewportSize({ width: 520, height: 700 });
  await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('.graph-canvas').style.width) - document.querySelector('.graph-viewport').clientWidth) < 2);
  assert.equal(await page.locator('[data-node-id="f"]').getAttribute('aria-pressed'), 'true');
});
