import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createWorkerPanel, renderWorkerPanel } from '../../../host/ui/worker-panel.cjs';
import { renderWebview } from '../../../host/ui/webview.cjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('native Worker failed sends, hidden replies and operation bursts remain bounded', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.messages = []; window.sendMode = 'pending';
    window.acquireVsCodeApi = () => ({ postMessage(message) {
      messages.push(message);
      if (!message.requestId) return;
      if (sendMode === 'false') return false;
      if (sendMode === 'reject') return Promise.reject(Error('bridge rejected'));
      if (sendMode === 'empty-reject') return Promise.reject(undefined);
      if (sendMode === 'hostile-reject') return Promise.reject({ get message() { throw Error('unreadable error'); } });
    } });
    let factory;
    Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
      factory = (actions, ...args) => { window.workerActions = actions; return value(actions, ...args); };
    } });
  });
  await page.route('http://worker-actions.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker-actions.test/');
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
    type: 'workers', sessionId: 'one', selected: 'a', revealRevision: 1,
    workers: [{ id: 'a', result: '保留的日志', status: 'completed' }]
  } })));
  const copy = page.getByRole('button', { name: '复制日志', exact: true });
  await page.evaluate(() => { sendMode = 'false'; }); await copy.click();
  await page.waitForFunction(() => document.querySelector('.worker-action-status').textContent.includes('发送失败'));
  assert.equal(await copy.isEnabled(), true);
  await page.evaluate(() => { sendMode = 'reject'; }); await copy.click();
  await page.waitForFunction(() => document.querySelector('.worker-action-status').textContent.includes('发送失败'));
  assert.equal(await copy.isEnabled(), true);
  for (const mode of ['empty-reject', 'hostile-reject']) {
    const result = await page.evaluate(async mode => {
      sendMode = mode;
      const status = document.querySelector('.worker-action-status'); status.textContent = '';
      const button = document.querySelector('.worker-native-toolbar .worker-copy-log');
      button.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { enabled: !button.disabled, notice: status.textContent };
    }, mode);
    assert.equal(result.enabled, true);
    assert.ok(result.notice.length > 0, mode + ' must show a readable failure');
  }
  await page.evaluate(() => { sendMode = 'pending'; }); await copy.click();
  const hidden = await page.evaluate(() => {
    const old = messages.at(-1).requestId;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    dispatchEvent(new MessageEvent('message', { data: { type: 'uiResult', requestId: old, ok: true } }));
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    return document.querySelector('.worker-action-status').textContent;
  });
  assert.notEqual(hidden, '日志已复制'); assert.equal(await copy.isEnabled(), true);
  const burst = await page.evaluate(async () => {
    const before = messages.length;
    const calls = Array.from({ length: 40 }, () => workerActions.onCopy('burst').catch(error => error.message));
    const sent = messages.length - before;
    dispatchEvent(new PageTransitionEvent('pagehide'));
    const results = await Promise.all(calls);
    dispatchEvent(new PageTransitionEvent('pageshow'));
    return { sent, limited: results.filter(text => text.includes('过多')).length };
  });
  assert.deepEqual(burst, { sent: 32, limited: 8 });
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId: 123, workers: null } })));
  assert.match(await page.locator('.worker-transcript').textContent(), /保留的日志/);
  const frames = await page.evaluate(() => {
    const raf = requestAnimationFrame, cancel = cancelAnimationFrame, callbacks = []; let id = 0;
    window.requestAnimationFrame = callback => { callbacks.push(callback); return ++id; };
    window.cancelAnimationFrame = () => {};
    try {
      dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId: 'one', selected: 'a', revealRevision: 1,
        workers: [{ id: 'a', result: '恢复后的最新日志', status: 'completed' }] } }));
      dispatchEvent(new PageTransitionEvent('pagehide'));
      dispatchEvent(new PageTransitionEvent('pageshow'));
      callbacks[0]();
      const before = document.querySelector('.worker-transcript').textContent;
      callbacks[1]();
      return { count: callbacks.length, before, after: document.querySelector('.worker-transcript').textContent };
    } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel; }
  });
  assert.equal(frames.count, 2);
  assert.match(frames.before, /保留的日志/);
  assert.match(frames.after, /恢复后的最新日志/);
  assert.deepEqual(errors, []);
});

test('native Worker command cards send scoped manual interruption requests', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
  await page.addInitScript(() => {
    window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  });
  await page.route('http://worker-interrupt.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker-interrupt.test/');
  const commandId = '33333333-3333-4333-8333-333333333333';
  await page.evaluate(data => dispatchEvent(new MessageEvent('message', { data })), { type: 'workers', sessionId: 'chat-one', selected: 'a', revealRevision: 1,
    workers: [{ id: 'a', status: 'running', parts: [{ id: 'tool-a', type: 'tool', name: 'run_linux_ssh_command', commandId, status: 'running', args: '{"command":"sleep 900"}', output: '', startedAt: Date.now() }] }] });
  const stop = page.getByRole('button', { name: '中断命令', exact: true });
  await stop.focus(); await page.keyboard.press('Enter');
  const sent = await page.evaluate(() => window.sent.filter(message => message.action === 'interruptCommand'));
  assert.equal(sent.length, 1); assert.equal(sent[0].sessionId, 'chat-one'); assert.equal(sent[0].commandId, commandId);
  assert.equal(await page.locator('.tool-card').evaluate(element => element.open), false);
  assert.equal(await page.getByRole('button', { name: '正在中断…' }).isDisabled(), true);
});

test('native Worker outer render failures retain selection and recover without a retry loop', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
    window.failRender = true; window.attempts = 0;
    let factory;
    Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
      factory = (...args) => { const panel = value(...args), update = panel.update; panel.update = (...params) => {
        attempts++; if (failRender) throw Error('Injected outer render failure'); return update(...params);
      }; return panel; };
    } });
  });
  await page.route('http://worker-retry.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker-retry.test/');
  const send = async (sessionId, result) => {
    await page.evaluate(data => dispatchEvent(new MessageEvent('message', { data })), {
      type: 'workers', sessionId, selected: 'b', revealRevision: 1,
      workers: [{ id: 'a', result: '其他记录', status: 'completed' }, { id: 'b', result, status: 'completed' }]
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await send('one', '应恢复的记录');
  const retry = page.getByRole('button', { name: '重新显示 Worker 视图', exact: true });
  assert.equal(await retry.isVisible(), true);
  assert.equal(await page.locator('#worker-panel').evaluate(element => element.inert), true);
  assert.equal(await page.locator('#worker-empty').getAttribute('aria-busy'), 'false');
  assert.equal(await page.evaluate(() => attempts), 1);
  await page.evaluate(() => { failRender = false; });
  await retry.click();
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.locator('#worker-panel').evaluate(element => element.inert), false);
  assert.equal(await page.locator('#worker-picker').inputValue(), 'b');
  assert.match(await page.locator('.worker-transcript').textContent(), /应恢复的记录/);
  await page.evaluate(() => { failRender = true; });
  await send('one', '失效的旧更新');
  assert.equal(await retry.isVisible(), true);
  await page.evaluate(() => { failRender = false; });
  await send('two', '新会话记录');
  assert.equal(await retry.isVisible(), false);
  assert.match(await page.locator('.worker-transcript').textContent(), /新会话记录/);
  await page.evaluate(() => { failRender = true; });
  await send('two', '重试前的旧内容');
  const retried = await page.evaluate(() => {
    failRender = false;
    dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId: 'two', selected: 'b', revealRevision: 1,
      workers: [{ id: 'b', result: '重试必须显示最新快照', status: 'completed' }] } }));
    [...document.querySelectorAll('button')].find(button => button.textContent === '重新显示 Worker 视图').click();
    return document.querySelector('.worker-transcript').textContent;
  });
  assert.match(retried, /重试必须显示最新快照/);
  assert.deepEqual(errors, []);
});

test('Worker output bursts render once per frame and navigation discards obsolete frames', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
    window.renderCount = 0;
    let factory;
    Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
      factory = (...args) => { const panel = value(...args), update = panel.update; panel.update = (...params) => { window.renderCount++; return update(...params); }; return panel; };
    } });
  });
  await page.route('http://worker.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker.test/');
  const outcome = await page.evaluate(async () => {
    const emit = (sessionId, result) => dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId, selected: 'a', workers: [{ id: 'a', result, status: 'running' }] } }));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    emit('one', 'initial');
    for (let i = 0; i < 1000; i++) emit('one', 'update ' + i);
    const beforeFrame = renderCount; await frame();
    const afterFrame = renderCount, text = document.querySelector('.worker-transcript').textContent;
    emit('one', 'obsolete'); emit('two', 'new session'); await frame();
    return { beforeFrame, afterFrame, text, finalCount: renderCount, finalText: document.querySelector('.worker-transcript').textContent };
  });
  assert.equal(outcome.beforeFrame, 1); assert.equal(outcome.afterFrame, 2);
  assert.match(outcome.text, /update 999/); assert.equal(outcome.finalCount, 3);
  assert.match(outcome.finalText, /new session/); assert.ok(!outcome.finalText.includes('obsolete'));
  const lifecycle = await page.evaluate(async () => {
    const emit = (sessionId, result) => dispatchEvent(new MessageEvent('message', { data: { type: 'workers', sessionId, selected: 'a', workers: [{ id: 'a', result, status: 'running' }] } }));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const start = renderCount;
    emit('two', 'pending at suspension'); dispatchEvent(new Event('pagehide'));
    for (let i = 0; i < 1000; i++) emit('two', 'suspended-' + i);
    await frame(); const suspendedCount = renderCount - start;
    dispatchEvent(new Event('pageshow')); await frame();
    const resumedText = document.querySelector('.worker-transcript').textContent;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    emit('three', 'new hidden session'); emit('three', 'latest hidden result');
    await frame(); const hiddenCount = renderCount - start;
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); await frame();
    return { suspendedCount, resumedText, hiddenCount, total: renderCount - start, text: document.querySelector('.worker-transcript').textContent };
  });
  assert.equal(lifecycle.suspendedCount, 0); assert.match(lifecycle.resumedText, /suspended-999/);
  assert.equal(lifecycle.hiddenCount, 1); assert.equal(lifecycle.total, 2);
  assert.match(lifecycle.text, /latest hidden result/);
});

test('worker assets are cached while each page receives a fresh CSP nonce', () => {
  const entry = new URL('../../../host/ui/worker-panel.cjs', import.meta.url), nativeRequire = createRequire(entry);
  let reads = 0;
  const sandbox = { module: { exports: {} }, __dirname: fileURLToPath(new URL('../../../host', import.meta.url)),
    require: name => name === 'node:fs' ? { readFileSync(...args) { reads++; return readFileSync(...args); } } : nativeRequire(name) };
  vm.runInNewContext(readFileSync(entry, 'utf8'), sandbox);
  const first = sandbox.module.exports.renderWorkerPanel(), count = reads;
  const second = sandbox.module.exports.renderWorkerPanel();
  assert(count > 0); assert.equal(reads, count);
  assert.notEqual(first.match(/script nonce="([^"]+)/)[1], second.match(/script nonce="([^"]+)/)[1]);
});

test('rapid selections share loading, hidden views skip state reads and disposed loads can retry', async () => {
  const commands = [], messages = [];
  let receive, dispose, reads = 0;
  const provider = createWorkerPanel({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    readState: () => { reads++; return { sessionId: 'one', workers: [{ id: 'a' }, { id: 'b' }] }; },
    onAction() {}, onError(error) { throw error; }, readyTimeout: 1000
  });
  provider.publish(); assert.equal(reads, 0);
  const first = provider.show('a', 'one'), second = provider.show('b', 'one');
  await new Promise(resolve => setImmediate(resolve));
  const view = { visible: true, show() {}, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
    postMessage(message) { messages.push(message); }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose(fn) { dispose = fn; } };
  provider.resolveWebviewView(view); await receive({ action: 'ready' });
  await Promise.all([first, second]);
  assert.equal(commands.length, 3); assert.equal(messages.at(-1).selected, 'b');
  await provider.show('a', 'one');
  assert.deepEqual(commands.slice(3), ['ubovm.workerLogs.focus']);
  const before = reads;
  provider.publish({ sessionId: 'one', workers: [{ id: 'a' }] }); assert.equal(reads, before);
  view.visible = false; provider.publish(); assert.equal(reads, before);
  const cancelled = provider.show('b', 'one');
  const rejection = assert.rejects(cancelled, /加载已取消/);
  await new Promise(resolve => setImmediate(resolve)); dispose(); await rejection;
  const retry = provider.show('b', 'one');
  await new Promise(resolve => setImmediate(resolve));
  view.visible = true; provider.resolveWebviewView(view); await receive({ action: 'ready' }); await retry;
  assert.equal(messages.at(-1).selected, 'b');
});

test('native provider restores hidden updates and rejects workers from a stale session', async () => {
  let state = { sessionId: 'one', workers: [{ id: 'a', parts: [] }] }, receive, visibility, dispose;
  const messages = [], commands = [];
  const provider = createWorkerPanel({ commands: { async executeCommand(id) { commands.push(id); } } }, {
    readState: () => state, onAction() {}, onError(error) { throw error; }
  });
  const opening = provider.show('a', 'one');
  await new Promise(resolve => setTimeout(resolve, 20));
  const view = { visible: false, show() {}, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
    postMessage(message) { messages.push(structuredClone(message)); }
  }, onDidChangeVisibility(fn) { visibility = fn; return { dispose() {} }; }, onDidDispose(fn) { dispose = fn; } };
  provider.resolveWebviewView(view);
  await receive({ action: 'ready' });
  view.visible = true; visibility();
  await opening;
  assert.equal(messages.at(-1).selected, 'a');
  assert.deepEqual(commands, ['workbench.view.extension.ubovm-workers.resetViewContainerLocation', 'ubovm.workerLogs.resetViewLocation', 'ubovm.workerLogs.focus']);
  view.visible = false;
  const count = messages.length;
  state.workers[0].result = 'background output'; provider.publish();
  assert.equal(messages.length, count);
  view.visible = true; visibility();
  assert.equal(messages.at(-1).workers[0].result, 'background output');
  state = { sessionId: 'two', workers: [] }; provider.publish();
  assert.equal(messages.at(-1).selected, '');
  await assert.rejects(provider.show('a', 'one'), /Worker/);
  dispose(); assert.equal(provider.visible, false);
});

test('visibility snapshot failures are reported and do not prevent a later publication', async () => {
  let receive, visibility, fail = false;
  const errors = [], messages = [];
  const provider = createWorkerPanel({ commands: { async executeCommand() {} } }, {
    readState() { if (fail) throw Error('snapshot unavailable'); return { sessionId: 'one', workers: [] }; },
    onAction() {}, onError: error => errors.push(error.message)
  });
  provider.resolveWebviewView({ visible: true, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; }, postMessage(message) { messages.push(message); }
  }, onDidChangeVisibility(fn) { visibility = fn; return { dispose() {} }; }, onDidDispose() {} });
  await receive({ action: 'ready' });
  fail = true; assert.doesNotThrow(() => visibility());
  assert.deepEqual(errors, ['snapshot unavailable']);
  fail = false; visibility();
  assert.equal(messages.length, 2);
});

test('an unavailable worker view reports a retryable timeout', async () => {
  const provider = createWorkerPanel({ commands: { async executeCommand() {} } }, {
    readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }] }), onAction() {}, onError() {}, readyTimeout: 20
  });
  await assert.rejects(provider.show('a', 'one'), /加载超时.*重试/);
});

test('a stalled layout command times out and a retry is independent of the old completion', async () => {
  let release, receive, calls = 0;
  const messages = [];
  const provider = createWorkerPanel({ commands: { async executeCommand() {
    if (++calls === 1) await new Promise(resolve => { release = resolve; });
  } } }, { readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }] }), onAction() {}, onError() {}, readyTimeout: 50 });
  await assert.rejects(provider.show('a', 'one'), /加载超时/);
  const retry = provider.show('a', 'one');
  provider.resolveWebviewView({ visible: true, show() {}, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; }, postMessage(message) { messages.push(message); }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose() {} });
  await receive({ action: 'ready' }); await retry;
  const count = calls, published = messages.length;
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, count, 'timed-out layout must not proceed to focus');
  assert.equal(messages.length, published);
});

test('disposing releases the opening task before its command resolves and preserves a new load', async () => {
  const releases = [], listeners = [], disposals = [], messages = [];
  let calls = 0;
  const provider = createWorkerPanel({ commands: { async executeCommand() {
    if (++calls <= 2) await new Promise(resolve => releases.push(resolve));
  } } }, { readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }, { id: 'b' }] }), onAction() {}, onError() {}, readyTimeout: 1000 });
  const view = () => ({ visible: true, show() {}, webview: {
    onDidReceiveMessage(fn) { listeners.push(fn); return { dispose() {} }; }, postMessage(message) { messages.push(message); }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose(fn) { disposals.push(fn); } });
  provider.resolveWebviewView(view());
  const old = provider.show('a', 'one');
  const rejected = assert.rejects(old, /加载已取消/);
  disposals[0]();
  const retry = provider.show('a', 'one');
  await rejected;
  assert.equal(calls, 2, 'retry starts without waiting for the disposed command');
  releases[0](); await new Promise(resolve => setImmediate(resolve));
  const latest = provider.show('b', 'one');
  assert.equal(calls, 2, 'old completion cannot clear the shared retry task');
  provider.resolveWebviewView(view()); await listeners[1]({ action: 'ready' });
  releases[1](); await Promise.all([retry, latest]);
  assert.equal(messages.at(-1).selected, 'b');
});

test('disposing or switching sessions during layout stops stale Worker opens before focus', async () => {
  for (const scenario of ['dispose', 'session']) {
    let finish, dispose;
    let state = { sessionId: 'one', workers: [{ id: 'a' }] };
    const commands = [];
    const provider = createWorkerPanel({ commands: { executeCommand(command) {
      commands.push(command); return new Promise(resolve => { finish = resolve; });
    } } }, { readState: () => state, onAction() {}, onError() {}, readyTimeout: 20 });
    provider.resolveWebviewView({ visible: false, webview: {
      onDidReceiveMessage() { return { dispose() {} }; }, postMessage() {}
    }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose(fn) { dispose = fn; } });
    const opening = provider.show('a', 'one');
    const rejected = assert.rejects(opening, scenario === 'dispose' ? /加载已取消/ : /Worker 已失效/);
    if (scenario === 'dispose') dispose(); else state = { sessionId: 'two', workers: [] };
    finish(); await rejected;
    assert.equal(commands.length, 1, 'obsolete opens must not continue moving or focusing views');
  }
});

test('late copy results cannot unlock a newer copy or leak status across Worker selections', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message), getState: () => ({}), setState() {} });
    let factory;
    Object.defineProperty(window, 'createWorkerPanel', { get: () => factory, set: value => {
      factory = (actions, ...args) => { window.workerActions = actions; return value(actions, ...args); };
    } });
  });
  await page.route('http://worker.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker.test/');
  const emit = data => page.evaluate(async data => { dispatchEvent(new MessageEvent('message', { data })); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, data);
  const snapshot = { type: 'workers', sessionId: 'one', selected: 'a', workers: [
    { id: 'a', status: 'completed', result: 'A', parts: [null] }, { id: 'b', status: 'completed', result: 'B' }
  ] };
  await emit(snapshot);
  const copy = page.getByRole('button', { name: '复制日志', exact: true });
  const requestId = () => page.evaluate(() => messages.findLast(message => message.action === 'copyText').requestId);
  await copy.click(); const first = await requestId();
  await page.locator('#worker-picker').selectOption('b');
  assert.equal(await copy.isEnabled(), true);
  await copy.click(); const second = await requestId();
  await emit({ type: 'uiResult', requestId: first, ok: true });
  assert.equal(await copy.isDisabled(), true);
  assert.equal(await page.locator('.worker-action-status').isVisible(), false);
  await emit({ type: 'uiResult', requestId: second, ok: true });
  assert.equal(await copy.isEnabled(), true);
  await copy.click(); const third = await requestId();
  await emit({ ...snapshot, sessionId: 'two' });
  assert.equal(await copy.isEnabled(), true);
  await copy.click(); const fourth = await requestId();
  await emit({ type: 'uiResult', requestId: third, ok: false, error: 'stale failure' });
  assert.equal(await copy.isDisabled(), true);
  assert.equal(await page.locator('.worker-action-status').isVisible(), false);
  await emit({ type: 'uiResult', requestId: fourth, ok: true });
  assert.equal(await copy.isEnabled(), true);
  for (const navigation of ['picker', 'host']) {
    await page.evaluate(() => { window.linkResult = workerActions.onOpenLink('https://example.com'); });
    const link = await page.evaluate(() => messages.findLast(message => message.action === 'openMessageLink').requestId);
    if (navigation === 'picker') {
      await page.locator('#worker-picker').selectOption('b');
      await page.locator('#worker-picker').selectOption('a');
    } else {
      await emit({ ...snapshot, sessionId: 'two', selected: 'b', revealRevision: 1 });
      await emit({ ...snapshot, sessionId: 'two', selected: 'a', revealRevision: 2 });
    }
    await emit({ type: 'uiResult', requestId: link, ok: false, error: 'obsolete link failure' });
    assert.equal(await page.evaluate(() => linkResult), false);
    assert.equal(await page.locator('.worker-action-status').isVisible(), false, navigation + ' must invalidate old link notices');
  }
  assert.deepEqual(errors, []);
});

test('Worker render failures recover on retry, selection and new snapshots without stale errors', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 500 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
  await page.route('http://worker.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker.test/');
  const emit = data => page.evaluate(async data => { dispatchEvent(new MessageEvent('message', { data })); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, data);
  const workers = [{ id: 'a', name: 'Worker A', status: 'completed', result: '内容 A' }, { id: 'b', name: 'Worker B', status: 'completed', result: '内容 B' }];
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
  await page.evaluate(() => {
    window.originalMessage = UBOVMMessage; window.failures = 0;
    window.UBOVMMessage = { update(...args) {
      if (args[1] === '内容 B') { window.failures++; throw Error('Injected render failure'); }
      return window.originalMessage.update(...args);
    } };
  });
  await page.locator('#worker-picker').selectOption('b');
  const retry = page.getByRole('button', { name: '重新显示日志', exact: true });
  assert.equal(await retry.isVisible(), true);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await retry.click();
  assert.equal(await page.evaluate(() => window.failures), 2);
  await page.locator('#worker-picker').selectOption('a');
  assert.equal(await retry.isVisible(), false);
  await page.locator('#worker-picker').selectOption('b');
  await page.evaluate(() => { window.UBOVMMessage = window.originalMessage; });
  await retry.click();
  assert.equal(await retry.isVisible(), false);
  assert.match(await page.locator('.worker-transcript').textContent(), /内容 B/);
  for (let index = 0; index < 120; index++) {
    await emit({ type: 'workers', sessionId: 'cycle-' + index, workers: [null, ...workers, workers[0]], selected: 'a' });
    assert.equal(await page.locator('#worker-picker option').count(), 2);
    assert.equal(await page.locator('.worker-transcript').count(), 1);
  }
  await emit({ type: 'workers', sessionId: 'empty', workers: {} });
  assert.equal(await page.locator('#worker-empty').isVisible(), false, 'malformed snapshots retain readable logs');
  assert.match(await page.locator('.worker-transcript').textContent(), /内容 A/);
  await emit({ type: 'workers', sessionId: 'empty', workers: [] });
  assert.equal(await page.locator('#worker-empty').isVisible(), true);
  assert.equal(await retry.isVisible(), false);
  assert.deepEqual(errors, []);
});

test('native log streams independently, preserves tool state and clears on session changes', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 360 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message), getState: () => ({}), setState() {} }); });
  await page.route('http://worker.test/', route => route.fulfill({ contentType: 'text/html', body: renderWorkerPanel() }));
  await page.goto('http://worker.test/');
  assert.equal(await page.locator('#worker-empty').textContent(), '正在加载 Worker 日志…');
  const emit = data => page.evaluate(async data => { dispatchEvent(new MessageEvent('message', { data })); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, data);
  const workers = [{ id: 'a', name: '检查实现', status: 'running', parts: [{ id: 'tool', type: 'tool', name: 'read_workspace_file', status: 'running', args: '{}', output: 'first' }] }, { id: 'b', name: '验证测试', status: 'completed', result: '测试完成' }];
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
  assert.equal(await page.locator('.worker-panel').isVisible(), true);
  assert.equal(await page.locator('.worker-resize-handle').isVisible(), false);
  assert.equal(await page.locator('.worker-close').isVisible(), false);
  await page.setViewportSize({ width: 260, height: 360 });
  const searchBounds = await page.locator('.worker-search').boundingBox();
  const copyBounds = await page.locator('.worker-native-toolbar .worker-copy-log').boundingBox();
  assert(searchBounds.width >= 220, 'narrow sidebar keeps the search input readable');
  assert(copyBounds.y >= searchBounds.y + searchBounds.height, 'narrow toolbar wraps actions below search');
  assert(copyBounds.x + copyBounds.width <= 260, 'copy action stays within the sidebar');
  await page.setViewportSize({ width: 900, height: 360 });
  await page.locator('.tool-card > summary').click();
  await page.evaluate(() => { window.tool = document.querySelector('.tool-card'); });
  workers[0].parts[0].output = 'updated output';
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
  assert(await page.evaluate(() => tool === document.querySelector('.tool-card') && tool.open));
  assert.match(await page.locator('.tool-output').textContent(), /updated output/);
  await page.locator('#worker-picker').selectOption('b');
  assert.match(await page.locator('.worker-transcript').textContent(), /测试完成/);
  // An in-flight stream snapshot must not undo the user's local selection.
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a' });
  assert.equal(await page.locator('#worker-picker').inputValue(), 'b');
  await page.getByRole('button', { name: '复制日志', exact: true }).click();
  const copied = await page.evaluate(() => messages.findLast(message => message.action === 'copyText'));
  assert.match(copied.text, /验证测试[\s\S]*测试完成/);
  await emit({ type: 'uiResult', requestId: copied.requestId, ok: true });
  assert.equal(await page.locator('.worker-action-status').textContent(), '日志已复制');
  const search = page.getByRole('searchbox');
  await search.fill('不存在');
  assert.equal(await page.locator('.worker-search-result').textContent(), '0 个匹配');
  await search.fill('检查'); await search.press('Enter');
  assert.equal(await page.locator('#worker-picker').inputValue(), 'a');
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  workers[0].parts.push({ id: 'long', type: 'text', text: '执行记录\n\n'.repeat(100) });
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a', revealRevision: 1 });
  const follow = page.locator('.worker-follow'), scroll = page.locator('.worker-detail-scroll');
  // Switching back can restore a paused reading position; resume before testing pause.
  if (await follow.getAttribute('aria-pressed') === 'false') await follow.click();
  await follow.click();
  assert.equal(await follow.getAttribute('aria-pressed'), 'false');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  workers[0].parts[1].text += '最新记录\n\n'.repeat(10);
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'a', revealRevision: 1 });
  assert.equal(await scroll.evaluate(element => element.scrollTop), 0);
  await follow.click();
  assert.equal(await follow.getAttribute('aria-pressed'), 'true');
  assert(await scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2));
  // Explicit opens from a conversation card still switch the native view.
  await emit({ type: 'workers', sessionId: 'one', workers, selected: 'b', revealRevision: 2 });
  assert.equal(await page.locator('#worker-picker').inputValue(), 'b');
  await page.setViewportSize({ width: 320, height: 500 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await emit({ type: 'workers', sessionId: 'two', workers: [] });
  assert.equal(await page.locator('.worker-panel').isVisible(), false);
  assert.equal(await page.locator('#worker-empty').isVisible(), true);
  assert.deepEqual(errors, []);

  await page.route('http://conversation.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
  await page.goto('http://conversation.test/');
  await emit({ type: 'state', nativeWorkerPanel: true, mode: 'assist', conversation: { id: 'one' }, messages: [], execution: { workers }, provider: { configured: true }, context: {} });
  await page.locator('#collaboration-worker-list .worker-card').first().click();
  assert.equal(await page.locator('#worker-panel').isVisible(), false);
  assert.equal(await page.locator('#main-content').evaluate(element => element.inert), false);
  assert(await page.evaluate(() => messages.some(message => message.action === 'openWorker' && message.workerId === 'a' && message.sessionId === 'one')));
  assert.deepEqual(errors, []);
});

test('hiding a loading Worker cancels the wait and late focus cannot reopen it', async () => {
  let visibility, receive, finishFocus, stalled = true, shown = 0;
  const provider = createWorkerPanel({ commands: { executeCommand(command) {
    if (command === 'ubovm.workerLogs.focus' && stalled) return new Promise(resolve => { finishFocus = resolve; });
    return Promise.resolve();
  } } }, { readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }] }), onAction() {}, readyTimeout: 1000 });
  const view = { visible: true, show() { shown++; }, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; }, postMessage() {}
  }, onDidChangeVisibility(fn) { visibility = fn; return { dispose() {} }; }, onDidDispose() {} };
  provider.resolveWebviewView(view);
  const opening = provider.show('a', 'one');
  const cancelled = assert.rejects(opening, /加载已取消/);
  await new Promise(resolve => setImmediate(resolve));
  view.visible = false; visibility(); await cancelled;
  finishFocus(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown, 0, 'obsolete loading must not reveal the closed tab');
  stalled = false; view.visible = true; visibility(); await receive({ action: 'ready' });
  await provider.show('a', 'one'); assert.equal(shown, 1);
});
