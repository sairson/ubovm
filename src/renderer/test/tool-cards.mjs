import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../host/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../.cache', import.meta.url));
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const start = Date.now();
const text = (id, value, status = 'completed') => ({ id, type: 'text', text: value, status });
const tool = (id, overrides = {}) => ({
  id, type: 'tool', name: 'read_workspace_file', args: '{"path":"src/harness/worker/index.mjs","startLine":1}',
  output: 'export function createWorker(options) {\n  return new Worker(options);\n}',
  status: 'completed', startedAt: start, endedAt: start + 1234, ...overrides
});
const intro = text('intro', '我会先检查 **Worker 配置** 和工具注册，再验证流式输出。');
const read = tool('read');
const listing = tool('listing', { name: 'list_workspace_files', args: '{"path":"src/harness"}', output: 'worker/index.mjs\nreason/index.mjs\nblackboard/index.mjs' });
const explanation = text('explanation', '工具已注册，接下来运行相关检查。');
const command = tool('command', { name: 'run_linux_ssh_command', args: '{"command":"node --test test/worker-streaming.test.mjs"}', output: 'TAP version 13\nok 1 - worker streams text and tools\nok 2 - interruption retains history\n# tests 2\n# pass 2', status: 'running', endedAt: undefined });
const user = { role: 'user', text: '检查工具调用与 Worker 的流式输出。' };
function state(parts, overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: 'inline-tool-cards', title: '工具执行记录' },
    messages: [user], goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    execution: { status: 'running', busy: true, parts, streamText: '', activities: [] }, ...overrides
  };
}
async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://tool-cards.test/') requests.push(request.url()); });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => hostMessages.push(message) });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'tool-cards-test' });
  await page.route('http://tool-cards.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://blocked-preview.invalid/**', route => route.abort());
  await page.goto('http://tool-cards.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value); await frames(); };
  const sent = action => page.evaluate(action => window.hostMessages.filter(message => message.action === action), action);
  const ack = async (action, ok = true) => {
    const message = (await sent(action)).at(-1);
    assert(message?.requestId, action + ' must use a tracked host request');
    await emit({ type: 'uiResult', requestId: message.requestId, ok, ...(ok ? {} : { error: 'fixture rejected' }) });
    return message;
  };
  const card = index => page.locator('#messages .tool-card').nth(index);
  const toggle = async index => { await card(index).locator(':scope > summary').click(); await frames(); };
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'the webview must not throw browser errors'); assert.deepEqual(requests, [], 'tool output and HTML preview must not fetch remote resources'); });
  return { page, emit, frames, sent, ack, card, toggle };
}

test('tool groups remain inline with prose and retain expanded nodes through streaming and history promotion', async t => {
  const f = await fixture(t);
  await f.emit(state([intro, read, listing, explanation, command]));
  const timeline = f.page.locator('#messages .message-timeline');
  assert.deepEqual(await timeline.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.classList.contains('tool-group') ? 'tools' : 'text')), ['text', 'tools', 'text', 'tools']);
  assert.deepEqual(await f.page.locator('#messages .tool-group').evaluateAll(nodes => nodes.map(node => node.querySelectorAll(':scope > .tool-card').length)), [2, 1]);
  assert.equal(await f.page.locator('#messages .tool-kind-icon svg, #messages svg.tool-kind-icon').count(), 3);
  assert.equal(await f.page.locator('#assist-execution').isVisible(), false, 'inline calls must not be repeated in the activity footer');
  await f.toggle(0);
  await f.card(0).locator('.tool-arguments > summary').click();
  await f.page.evaluate(() => {
    window.savedTool = document.querySelector('#messages .tool-card');
    window.savedToolGroup = savedTool.parentElement;
    window.savedArguments = savedTool.querySelector('.tool-arguments');
    window.savedArticle = savedTool.closest('article');
    window.savedProse = document.querySelector('#messages .response-text p').firstChild;
    const range = document.createRange(); range.setStart(savedProse, 0); range.setEnd(savedProse, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const extra = tool('second-read', { args: '{"path":"src/harness/reason/index.mjs"}', output: 'export function createReason() {}' });
  const progressed = { ...command, output: command.output + '\nok 3 - cards retain their state' };
  const parts = [intro, read, listing, extra, explanation, progressed];
  await f.emit(state(parts));
  assert.deepEqual(await f.page.evaluate(() => ({
    tool: savedTool === document.querySelector('#messages .tool-card'), group: savedToolGroup === savedTool.parentElement,
    arguments: savedArguments === savedTool.querySelector('.tool-arguments'), open: savedTool.open && savedArguments.open,
    prose: savedProse === document.querySelector('#messages .response-text p').firstChild, selection: getSelection().toString()
  })), { tool: true, group: true, arguments: true, open: true, prose: true, selection: '我会先检查' });
  assert.deepEqual(await f.page.locator('#messages .tool-group').evaluateAll(nodes => nodes.map(node => node.querySelectorAll(':scope > .tool-card').length)), [3, 1]);
  const finalParts = [...parts.slice(0, -1), { ...progressed, status: 'completed', endedAt: start + 2500 }, text('answer', '检查通过，流式记录已经保留。')];
  await f.emit(state(finalParts, { busy: false, messages: [user, { role: 'assistant', text: '检查通过，流式记录已经保留。', parts: finalParts }], execution: { busy: false, status: 'completed', parts: finalParts } }));
  assert.equal(await f.page.locator('#messages article.assistant').count(), 1);
  assert.equal(await f.page.locator('#messages article[data-streaming]').count(), 0);
  assert(await f.page.evaluate(() => savedArticle === document.querySelector('#messages article.assistant') && savedTool === document.querySelector('#messages .tool-card') && savedTool.open && savedArguments.open));
  assert.equal(await f.card(3).locator('.tool-time').textContent(), '2.5s');
});

test('running, completed, failed and interrupted calls expose real state without automatic expansion', async t => {
  const f = await fixture(t);
  let parts = [tool('changing', { status: 'running', endedAt: undefined, output: '' }), tool('done'), tool('stopped', { status: 'interrupted', output: '', endedAt: start + 800 })];
  await f.emit(state(parts));
  assert.deepEqual(await f.page.locator('#messages .tool-card').evaluateAll(nodes => nodes.map(node => node.dataset.status)), ['running', 'completed', 'interrupted']);
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  assert.equal(await f.card(1).evaluate(node => node.open), false);
  assert.equal(await f.card(2).locator('.tool-status').textContent(), '已停止');
  parts = [{ ...parts[0], status: 'failed', endedAt: start + 700, output: 'ENOENT: file not found' }, ...parts.slice(1)];
  await f.emit(state(parts));
  assert.equal(await f.card(0).getAttribute('data-status'), 'failed');
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'failure must not automatically expand the card');
  assert.equal(await f.card(0).locator('.tool-output').isVisible(), false);
  await f.toggle(0);
  assert.equal(await f.card(0).locator('.tool-output').isVisible(), true, 'failure details can still be expanded manually');
  await f.emit(state(parts));
  assert.equal(await f.card(0).evaluate(node => node.open), true, 'updates preserve manual expansion');
  await f.toggle(0);
  await f.card(0).locator(':scope > summary').focus();
  await f.emit(state([{ ...parts[0], output: parts[0].output + '\nThe path is unavailable.' }, ...parts.slice(1)]));
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'a later failure update respects a manually collapsed card');
  assert.equal(await f.card(0).locator(':scope > summary').evaluate(node => document.activeElement === node), true, 'stream updates retain keyboard focus');
  await f.card(2).locator(':scope > summary').focus();
  await f.page.keyboard.press('Enter');
  assert.match(await f.card(2).locator('.tool-output').textContent(), /停止/);
  assert.equal(await f.card(2).locator('.tool-output').isVisible(), true, 'native summaries support keyboard expansion');
  await f.page.keyboard.press('Space');
  assert.equal(await f.card(2).evaluate(node => node.open), false, 'Space collapses the focused summary');
});

test('streamed output appends preserve its text selection and only follow a reader already at the bottom', async t => {
  const f = await fixture(t);
  let streamed = { ...command, output: Array.from({ length: 80 }, (_, index) => 'line ' + index + ': output content').join('\n') };
  await f.emit(state([streamed]));
  await f.toggle(0);
  const output = f.card(0).locator('.tool-output');
  assert(await output.evaluate(node => node.scrollHeight > node.clientHeight), 'large output must have its own scroll area');
  await output.evaluate(node => {
    window.outputNode = node; window.outputText = node.firstChild;
    node.scrollTop = 40; window.outputScroll = node.scrollTop;
    const range = document.createRange(); range.setStart(outputText, 0); range.setEnd(outputText, 6);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  streamed = { ...streamed, output: streamed.output + '\n' + 'new line: more output\n'.repeat(20) };
  await f.emit(state([streamed]));
  assert.deepEqual(await output.evaluate(node => ({ sameNode: node === outputNode, sameText: node.firstChild === outputText, selected: getSelection().toString(), scroll: node.scrollTop })), {
    sameNode: true, sameText: true, selected: 'line 0', scroll: 40
  });
  await output.evaluate(node => { getSelection().removeAllRanges(); node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  streamed = { ...streamed, output: streamed.output + 'final progress\n'.repeat(20) };
  await f.emit(state([streamed]));
  assert(await output.evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2), 'a reader at the bottom follows new output');
  const final = { ...streamed, status: 'completed', endedAt: start + 1000 };
  await f.emit(state([final], { busy: false, execution: { busy: false, status: 'completed', parts: [final] }, messages: [user, { role: 'assistant', text: '', parts: [final] }] }));
  assert.equal(await output.evaluate(node => node.firstChild === outputText), true);
});

test('tool actions await copy receipts, open explicit file paths and isolate HTML preview from the chat', async t => {
  const f = await fixture(t);
  const rawHtml = '<!doctype html><html><head><style>body{background:#123456;color:#fff}h1{font-size:23px}</style></head><body><h1>工具预览</h1><script>parent.previewExecuted=true</script><img src="https://blocked-preview.invalid/image.png" onerror="parent.previewExecuted=true"></body></html>';
  const htmlTool = tool('html', { name: 'mcp_fixture_render', args: '{}', output: rawHtml });
  const accidentalPath = tool('terminal-path', { ...command, id: 'terminal-path', args: '{"command":"echo safe","path":"/etc/passwd"}', status: 'completed', endedAt: start + 1000 });
  const malformedFile = tool('partial-file', { args: '{"path":"incomplete', output: 'partial arguments' });
  const secondRoot = tool('second-root', { args: '{"path":"src/special%file#draft?.mjs","root":1}', output: 'file from the second workspace' });
  await f.emit(state([read, accidentalPath, malformedFile, htmlTool, secondRoot]));
  await f.page.locator('#review-code-changes').click();
  const review = (await f.sent('reviewCodeChanges')).at(-1);
  assert(review?.sessionId, 'diff review must carry the originating conversation');
  await f.page.locator('#validate-code-changes').click();
  assert.equal((await f.sent('validateCodeChanges')).at(-1).sessionId, review.sessionId);
  await f.toggle(0);
  const copy = f.card(0).getByRole('button', { name: '复制输出', exact: true });
  await copy.click();
  assert.equal(await copy.isDisabled(), true, 'copy remains pending until the host responds');
  assert.equal((await f.ack('copyText')).text, read.output);
  assert.equal(await f.card(0).getByRole('button', { name: '已复制', exact: true }).count(), 1);
  await f.card(0).getByRole('button', { name: '打开文件', exact: true }).click();
  const openedFile = await f.ack('openMessageLink');
  assert.equal(openedFile.href, 'src/harness/worker/index.mjs');
  assert.equal(openedFile.rootIndex, 0);
  assert.equal(f.page.url(), 'http://tool-cards.test/');
  await f.toggle(1);
  assert.equal(await f.card(1).getByRole('button', { name: '打开文件', exact: true }).count(), 0, 'a command containing a path never becomes a file action');
  assert.equal((await f.sent('runCommand')).length, 0);
  await f.toggle(2);
  assert.equal(await f.card(2).getByRole('button', { name: '打开文件', exact: true }).count(), 0, 'truncated JSON must not invent a file action');
  await f.toggle(3);
  assert.equal(await f.card(3).locator('.tool-output').textContent(), rawHtml);
  assert.equal(await f.card(3).locator('.tool-output img, .tool-output script').count(), 0);
  await f.card(3).getByRole('button', { name: '预览 HTML', exact: true }).click();
  const iframe = f.page.locator('.html-preview iframe');
  await f.page.frameLocator('.html-preview iframe').getByRole('heading', { name: '工具预览' }).waitFor();
  assert.equal(await iframe.getAttribute('sandbox'), '');
  assert.equal(await f.page.frameLocator('.html-preview iframe').locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
  assert.equal(await f.page.evaluate(() => window.previewExecuted), undefined);
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('.html-preview').count(), 0);
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent), '预览 HTML');
  await f.card(3).getByRole('button', { name: '复制输出', exact: true }).click();
  assert.equal((await f.ack('copyText', false)).text, rawHtml);
  assert.equal(await f.card(3).getByRole('button', { name: '复制失败', exact: true }).count(), 1);
  await f.toggle(4);
  await f.card(4).getByRole('button', { name: '打开文件', exact: true }).click();
  const rootedFile = await f.ack('openMessageLink');
  assert.equal(rootedFile.rootIndex, 1, 'file actions retain the selected workspace root');
  assert.equal(rootedFile.href, 'src/special%25file%23draft%3F.mjs', 'path punctuation remains a literal filename at the host boundary');
});

test('embedded cards stay compact and readable at 320px, including dark mode and reduced motion', async t => {
  const f = await fixture(t, { reducedMotion: 'reduce' });
  await f.emit(state([intro, read, listing, explanation, command]));
  await f.toggle(2);
  await f.page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await f.page.screenshot({ path: screenshotDirectory + '/embedded-tool-cards.png' });
  await f.page.setViewportSize({ width: 320, height: 800 });
  await f.page.evaluate(() => {
    document.body.classList.add('vscode-dark');
    const style = document.createElement('style'); style.nonce = 'tool-cards-test';
    style.textContent = ':root{--vscode-foreground:#ddd;--vscode-descriptionForeground:#a5a5a5;--vscode-editor-background:#181818;--vscode-panel-border:#363636;--vscode-button-background:#52715f}';
    document.head.append(style);
  });
  const narrowRead = { ...read, name: 'mcp_project_with_a_very_long_namespace_inspect_worker_configuration', args: '{"path":"src/harness/very-long-nested-directory-without-spaces/worker-with-an-extremely-long-file-name.mjs"}' };
  await f.emit(state([intro, narrowRead, listing, explanation, command]));
  await f.frames();
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320 && document.body.scrollWidth <= 320 && document.querySelector('#messages').scrollWidth <= 320), 'long names and paths cannot widen the page');
  assert(await f.page.locator('#messages .tool-card-summary').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().width <= 320 && node.getBoundingClientRect().height < 64)), 'tool summaries remain compact at narrow widths');
  assert.equal(await f.page.locator('#messages .tool-card[data-status="running"] .tool-indicator').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert(await f.card(2).locator('.tool-output').isVisible());
  await f.page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await f.page.screenshot({ path: screenshotDirectory + '/embedded-tool-cards-narrow-dark.png' });
});

test('composer selects automatic or manual approval per conversation and sends the chosen mode', async t => {
  const f = await fixture(t);
  const idle = { busy: false, execution: { status: 'idle', busy: false, parts: [], activities: [] } };
  await f.emit(state([], { ...idle, requireToolApproval: true }));
  const select = f.page.locator('#tool-approval-mode');
  const selected = () => select.locator('input:checked').inputValue();
  assert.equal(await selected(), 'manual');
  await select.locator('label').filter({ hasText: '自动' }).click();
  await f.page.locator('#prompt-input').fill('test automatic');
  await f.page.locator('#submit-prompt').click();
  assert.equal((await f.ack('prompt')).approvalMode, 'auto');
  await f.emit(state([], { ...idle, conversation: { id: 'another', title: 'Another session' }, requireToolApproval: true }));
  assert.equal(await selected(), 'manual');
  await f.emit(state([], { ...idle, requireToolApproval: true }));
  assert.equal(await selected(), 'auto');
  await select.locator('label').filter({ hasText: '人工' }).click();
  await f.page.locator('#prompt-input').fill('test manual');
  await f.page.locator('#submit-prompt').click();
  assert.equal((await f.ack('prompt')).approvalMode, 'manual');
  await f.emit(state([], { requireToolApproval: false }));
  assert.equal(await select.locator('input').first().isDisabled(), true);
  assert.equal(await selected(), 'manual');
  await f.page.setViewportSize({ width: 320, height: 760 });
  await f.frames();
  const bounds = await select.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await f.page.screenshot({ path: screenshotDirectory + '/composer-approval.png' });
});
