import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const state = (id, viewRevision) => ({ type: 'state', viewRevision, mode: 'assist', conversation: { id, title: id },
  context: {}, provider: { configured: true }, messages: [], busy: false,
  execution: { status: 'idle', workers: [], activities: [] } });
async function fixture(t, transform = html => html, installClock = false) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.sent = []; window.saved = undefined; window.acquisitions = 0;
    window.acquireVsCodeApi = () => {
      if (++window.acquisitions > 1) throw Error('API acquired twice');
      return { getState: () => window.saved, setState: value => { window.saved = value; }, postMessage: value => window.sent.push(value) };
    };
  });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: transform(renderWebview()) }));
  if (installClock) await page.clock.install();
  await page.goto('http://stability.test/');
  const emit = value => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
  return { page, emit };
}

test('dependency syntax errors leave an independent recovery surface and never replay tasks', async t => {
  const { page } = await fixture(t, html => html.replace('window.createConnectionMonitor =', 'window.createConnectionMonitor = !syntax!'));
  await page.locator('#runtime-recovery').waitFor({ state: 'visible' });
  await page.locator('#runtime-resync').click();
  await page.locator('#runtime-reload').click();
  assert.equal(await page.evaluate(() => window.acquisitions), 1);
  assert.deepEqual(await page.evaluate(() => window.sent.map(message => message.action)), ['ready', 'reloadConversation']);
  assert.match(await page.locator('#runtime-recovery').innerText(), /页面恢复/);
});

test('session cleanup failures cannot strand the new conversation behind a transition mask', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('first', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('first draft');
  await page.evaluate(() => { window.UBOVMHtmlPreview.close = () => { throw Error('Injected cleanup fault'); }; });
  await emit(state('second', 2));
  await page.waitForFunction(() => document.getElementById('conversation-title').textContent === 'second' && document.body.dataset.switching === 'false');
  assert.equal(await page.locator('#route-loading').isVisible(), false);
  assert.equal(await page.locator('#prompt-input').inputValue(), '');
  await emit(state('first', 3));
  await page.waitForFunction(() => document.getElementById('conversation-title').textContent === 'first');
  assert.equal(await page.locator('#prompt-input').inputValue(), 'first draft');
});

test('failed state reception allows the same revision to be resynchronized', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('original', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('original session draft');
  await page.evaluate(next => {
    Object.defineProperty(next, 'conversationIds', { get() { throw Error('Injected receive fault'); } });
    window.dispatchEvent(new MessageEvent('message', { data: next }));
  }, state('recovered', 2));
  await page.locator('#runtime-recovery').waitFor({ state: 'visible' });
  await page.locator('#runtime-resync').click();
  await emit(state('recovered', 2));
  await page.waitForFunction(() => document.getElementById('conversation-title').textContent === 'recovered' && document.getElementById('runtime-recovery').hidden);
  assert.equal(await page.locator('#route-loading').isVisible(), false);
  assert.equal(await page.locator('#prompt-input').inputValue(), '', 'failed receive cannot transfer another session draft');
});

test('stalled animation frames have a recovery path and reload flushes live drafts', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('draft-owner', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.clock.install();
  await page.locator('#prompt-input').fill('unsent draft');
  await page.evaluate(() => { window.originalFrame = window.requestAnimationFrame; window.requestAnimationFrame = () => 999999; });
  await emit(state('draft-owner', 2));
  await page.clock.fastForward(20001);
  await page.locator('#runtime-recovery').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.requestAnimationFrame = window.originalFrame; });
  await page.locator('#runtime-resync').click();
  await page.clock.runFor(100);
  assert.equal(await page.locator('#runtime-recovery').isVisible(), false);
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'secret=should-not-display' })));
  await page.locator('#runtime-reload').click();
  assert.equal(await page.evaluate(() => window.saved.drafts['draft-owner'].assist), 'unsent draft');
  assert.doesNotMatch(await page.locator('#runtime-recovery').innerText(), /secret/);
  assert.equal(await page.evaluate(() => window.sent.some(message => ['prompt', 'runGoal', 'resumeRun'].includes(message.action))), false);
});

test('hidden reloads receive a fresh visible deadline without replaying commands or losing drafts', async t => {
  const { page, emit } = await fixture(t, html => html, true);
  await emit(state('hidden-reload', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('后台恢复后保留的草稿');
  await page.evaluate(() => {
    document.getElementById('runtime-reload').click();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(60000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5000);
  assert.equal(await page.locator('#runtime-reload').isDisabled(), true);
  assert.equal(await page.locator('#runtime-recovery').isVisible(), false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.clock.runFor(20000);
  assert.equal(await page.locator('#runtime-reload').isEnabled(), true);
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /重新加载未完成/);
  assert.equal(await page.locator('#prompt-input').inputValue(), '后台恢复后保留的草稿');
  assert.equal(await page.evaluate(() => window.saved.drafts['hidden-reload'].assist), '后台恢复后保留的草稿');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'reloadConversation').length), 1);
  assert.equal(await page.evaluate(() => window.sent.some(message => ['prompt', 'runGoal', 'resumeRun'].includes(message.action))), false);
});

test('wall clock rollback releases unanswered reloads and preserves the saved draft', async t => {
  const { page, emit } = await fixture(t, html => html, true);
  await emit(state('rollback-reload', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('校时后保留草稿');
  await page.evaluate(() => document.getElementById('runtime-reload').click());
  const before = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(before - 3600000);
  await page.clock.runFor(5000);
  assert.equal(await page.locator('#runtime-reload').isDisabled(), true);
  await page.clock.runFor(15000);
  assert.equal(await page.locator('#runtime-reload').isEnabled(), true);
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /重新加载未完成/);
  assert.equal(await page.locator('#prompt-input').inputValue(), '校时后保留草稿');
  assert.equal(await page.evaluate(() => window.saved.drafts['rollback-reload'].assist), '校时后保留草稿');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'reloadConversation').length), 1);
  assert.equal(await page.evaluate(() => window.sent.some(message => ['prompt', 'runGoal', 'resumeRun'].includes(message.action))), false);
});

test('draft storage failure blocks reload and keeps the live input available', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('storage-fault', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('cannot lose this draft');
  await page.evaluate(() => {
    window.UBOVMRuntime.api.setState = () => { throw Error('Storage unavailable'); };
    window.dispatchEvent(new ErrorEvent('error'));
  });
  await page.locator('#runtime-reload').click();
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /草稿暂时无法保存/);
  assert.equal(await page.locator('#prompt-input').inputValue(), 'cannot lose this draft');
  assert.equal(await page.evaluate(() => window.sent.some(message => message.action === 'reloadConversation')), false);
});

test('oversized Markdown bypasses rich parsing, preserves exact text and recovers to normal rendering', async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const element = document.createElement('div'); document.body.appendChild(element);
    const source = '<script>danger()</script>\n'.repeat(14000);
    const lexer = window.marked.lexer;
    window.marked.lexer = () => { throw Error('Large input must not enter the lexer'); };
    window.UBOVMMarkdown.update(element, source);
    const exact = element.querySelector('pre').textContent === source;
    const previous = element.querySelector('pre').firstChild;
    window.UBOVMMarkdown.update(element, source + 'stream tail');
    const reused = previous === element.querySelector('pre').firstChild;
    const appended = element.querySelector('pre').textContent === source + 'stream tail';
    element.querySelector('pre').firstChild.data = 'external replacement';
    window.UBOVMMarkdown.update(element, source + 'stream tail');
    const synchronousRepair = element.querySelector('pre').textContent === source + 'stream tail';
    element.querySelector('pre').textContent = 'delivered replacement';
    await Promise.resolve();
    window.UBOVMMarkdown.update(element, source + 'stream tail');
    const observerRepair = element.querySelector('pre').textContent === source + 'stream tail';
    const unsafe = element.querySelectorAll('script').length;
    window.marked.lexer = lexer;
    window.UBOVMMarkdown.update(element, '**recovered**');
    const recovered = element.querySelector('strong')?.textContent;
    window.UBOVMMarkdown.release(element); element.remove();
    return { exact, reused, appended, synchronousRepair, observerRepair, unsafe, recovered };
  });
  assert.deepEqual(result, { exact: true, reused: true, appended: true, synchronousRepair: true, observerRepair: true, unsafe: 0, recovered: 'recovered' });
});

test('header rendering errors do not prevent healthy messages or composer controls from updating', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('header-fault', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('retained draft');
  await page.evaluate(() => Object.defineProperty(document.getElementById('related-conversations'), 'hidden', { configurable: true, set() { throw Error('Header DOM fault'); } }));
  await emit({ ...state('header-fault', 2),
    messages: [{ id: 'healthy', role: 'assistant', text: 'healthy message still painted' }] });
  await page.locator('#ui-render-retry').waitFor({ state: 'visible' });
  assert.match(await page.locator('#messages').innerText(), /healthy message still painted/);
  assert.equal(await page.locator('#prompt-input').inputValue(), 'retained draft');
  assert.equal(await page.locator('#route-loading').isVisible(), false);
  await page.evaluate(() => { delete document.getElementById('related-conversations').hidden; });
  await emit(state('header-fault', 3));
  await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
});

test('malformed full and execution snapshots preserve the current page and allow the same revision to recover', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('valid', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#prompt-input').fill('owned draft');
  await emit({ ...state('invalid', 2), messages: { wrong: true } });
  await page.locator('#runtime-recovery').waitFor();
  assert.equal(await page.locator('#conversation-title').innerText(), 'valid');
  assert.equal(await page.locator('#prompt-input').inputValue(), 'owned draft');
  await emit(state('valid', 2));
  await page.waitForFunction(() => document.getElementById('runtime-recovery').hidden);
  await emit({ type: 'executionState', conversationId: 'valid', viewRevision: 3, execution: { parts: {} } });
  await page.locator('#runtime-recovery').waitFor();
  await emit({ ...state('valid', 3), messages: [{ id: 'correct', role: 'assistant', text: 'recovered exact revision' }] });
  await page.waitForFunction(() => document.getElementById('runtime-recovery').hidden);
  assert.match(await page.locator('#messages').innerText(), /recovered exact revision/);
});

test('reload rejects failed saves and failed bridge sends, and rapid clicks cannot issue duplicate reloads', async t => {
  const { page, emit } = await fixture(t, undefined, true);
  await emit(state('reload', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.evaluate(() => {
    window.UBOVMRuntime.saveDrafts = () => { throw Error('Save observer fault'); };
    window.dispatchEvent(new ErrorEvent('error'));
  });
  await page.locator('#runtime-reload').click();
  assert.equal(await page.evaluate(() => window.sent.some(item => item.action === 'reloadConversation')), false);
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /草稿暂时无法保存/);
  await page.evaluate(() => {
    window.UBOVMRuntime.saveDrafts = () => true;
    window.UBOVMRuntime.api.postMessage = () => Promise.reject(Error('Bridge rejected'));
  });
  await page.locator('#runtime-reload').click();
  await page.waitForFunction(() => !document.getElementById('runtime-reload').disabled);
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /页面连接不可用/);
  await page.evaluate(() => {
    window.UBOVMRuntime.api.postMessage = message => window.sent.push(message);
    document.getElementById('runtime-reload').click(); document.getElementById('runtime-reload').click();
  });
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.action === 'reloadConversation').length), 1);
  await page.clock.fastForward(20001);
  assert.equal(await page.locator('#runtime-reload').isDisabled(), false);
  assert.match(await page.locator('#runtime-recovery-message').innerText(), /重新加载未完成/);
});

test('cleanup dependency failures retire all running cards, timers and retained action handlers', async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(() => {
    const set = window.setInterval, clear = window.clearInterval, clocks = new Set();
    window.setInterval = (callback, delay, ...args) => { const id = set(callback, delay, ...args); if (delay === 1000) clocks.add(id); return id; };
    window.clearInterval = id => { clocks.delete(id); clear(id); };
    const element = document.createElement('div'); document.body.appendChild(element);
    let actions = 0, releases = 0;
    window.UBOVMMessage.update(element, '', { parts: [0, 1].map(index => ({ id: String(index), type: 'tool', name: 'read_workspace_file', status: 'running', output: 'retained', startedAt: Date.now() })), onCopy: () => { actions++; } });
    const runningClocks = clocks.size;
    const buttons = [...element.querySelectorAll('.tool-card .tool-action')];
    const markdown = window.UBOVMMarkdown;
    window.UBOVMMarkdown = { ...markdown, release(target) { releases++; markdown.release(target); throw Error('Injected dependency cleanup fault'); } };
    let caught = false;
    try { window.UBOVMMessage.release(element); } catch { caught = true; }
    window.UBOVMMarkdown = markdown;
    for (const button of buttons) button.click();
    const remainingClocks = clocks.size;
    element.remove(); window.setInterval = set; window.clearInterval = clear;
    return { runningClocks, remainingClocks, actions, releases, caught };
  });
  assert.equal(result.runningClocks, 1);
  assert.equal(result.remainingClocks, 0);
  assert.equal(result.actions, 0);
  assert.ok(result.releases >= 3, 'every dependency cleanup must be attempted');
  assert.equal(result.caught, true);
});

test('entry-animation failure leaves loading masks released and a recoverable page', async t => {
  const { page, emit } = await fixture(t);
  await emit(state('before-animation-fault', 1));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.evaluate(() => {
    window.originalAnimate = Element.prototype.animate;
    Element.prototype.animate = () => { throw Error('Animation compositor unavailable'); };
  });
  await emit(state('after-animation-fault', 2));
  await page.locator('#runtime-recovery').waitFor();
  assert.equal(await page.locator('#route-loading').isVisible(), false);
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.equal(await page.locator('#conversation-title').innerText(), 'after-animation-fault');
  await page.locator('#prompt-input').fill('draft during recovery');
  await page.evaluate(() => { Element.prototype.animate = window.originalAnimate; });
  await page.locator('#runtime-resync').click();
  await emit(state('after-animation-fault', 3));
  await page.waitForFunction(() => document.getElementById('runtime-recovery').hidden);
  assert.equal(await page.locator('#prompt-input').inputValue(), 'draft during recovery');
});
