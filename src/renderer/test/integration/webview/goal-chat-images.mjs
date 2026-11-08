import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createGoalChatPanel } from '../../../host/ui/goal-chat-panel.cjs';

// Exploration sidebar chat image attachment contract. The host panel ships the
// real page bundle; the page reports intents through `uiResult`/action messages,
// so the test drives the same request/ack bridge the extension host uses.
const screenshotDirectory = fileURLToPath(new URL('../../../../../.cache', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

function panelHtml() {
  const view = {
    visible: true,
    webview: { options: undefined, html: '', onDidReceiveMessage() { return { dispose() {} }; }, postMessage() { return Promise.resolve(true); } },
    onDidChangeVisibility() { return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; }
  };
  const panel = createGoalChatPanel({ commands: { async executeCommand() {} } }, { onAction() {} });
  panel.resolveWebviewView(view);
  panel.dispose();
  return view.webview.html;
}

function goalChat(overrides = {}, messages = []) {
  return {
    type: 'goalChat', sessionId: 'goal-one', mode: 'goal', available: true, modelReady: true, offline: false,
    goalMissing: false, imageInput: true, threads: [{ id: 'thread-1', title: '图片验证', active: true }],
    chat: { status: 'idle', messages, streamText: '', streamParts: [], error: null, canStop: false },
    ...overrides
  };
}

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.hostMessages.push(message) });
  });
  await page.route('http://goal-chat-images.test/', route => route.fulfill({ contentType: 'text/html', body: panelHtml() }));
  await page.goto('http://goal-chat-images.test/');
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'the exploration chat page must not throw');
  });
  const emit = async value => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), value);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  return { page, emit, messages: () => page.evaluate(() => window.hostMessages) };
}

test('exploration chat attaches an image, sends an image-only turn and clears the pending chip on ack', async t => {
  const f = await fixture(t);
  await f.emit(goalChat());
  const attach = f.page.locator('#goal-chat-attach');
  assert.equal(await attach.isDisabled(), false, 'a vision model exposes the attach control');
  await f.page.locator('#goal-chat-image-input').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
  const chip = f.page.locator('#goal-chat-images .goal-chat-image');
  await assert.doesNotReject(chip.waitFor({ state: 'visible' }));
  assert.match(await chip.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await f.page.locator('#goal-chat-send').isDisabled(), false, 'an image-only turn can be sent');

  await f.page.locator('#goal-chat-send').click();
  await f.page.waitForFunction(() => window.hostMessages.some(message => message.action === 'goalChatSend'));
  const sent = (await f.messages()).find(message => message.action === 'goalChatSend');
  assert.equal(sent.text, '');
  assert.equal(sent.images.length, 1);
  assert.equal(sent.images[0].name, 'screen.png');
  assert.equal(sent.images[0].mimeType, 'image/png');
  assert.equal(sent.images[0].data, 'data:image/png;base64,' + PNG.toString('base64'));

  await f.emit({ type: 'uiResult', requestId: sent.requestId, ok: true });
  await chip.waitFor({ state: 'detached' });
  assert.equal(await f.page.locator('#goal-chat-images .goal-chat-image').count(), 0, 'the acknowledged turn clears its pending images');
});

test('a text-only model disables image intake with an explanatory control', async t => {
  const f = await fixture(t);
  await f.emit(goalChat({ imageInput: false }));
  const attach = f.page.locator('#goal-chat-attach');
  assert.equal(await attach.isDisabled(), true);
  assert.match(await attach.getAttribute('title'), /不支持图片/);
  await f.page.locator('#goal-chat-image-input').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
  await f.page.waitForTimeout(120);
  assert.equal(await f.page.locator('#goal-chat-images .goal-chat-image').count(), 0, 'a text-only model never receives a pending image');
});

test('saved user images render through a lazy host thumbnail request and fall back to a name chip', async t => {
  const f = await fixture(t);
  const saved = goalChat({}, [{ id: 'user-1', role: 'user', text: '', at: 1, images: [{ id: 'img-1', name: 'screen.png', mimeType: 'image/png', bytes: PNG.length }] }]);
  await f.emit(saved);
  await f.page.waitForFunction(() => window.hostMessages.some(message => message.action === 'goalChatImage'));
  const asked = (await f.messages()).find(message => message.action === 'goalChatImage');
  assert.equal(asked.imageId, 'img-1');
  const uri = 'data:image/png;base64,' + 'A'.repeat(120);
  await f.emit({ type: 'uiResult', requestId: asked.requestId, ok: true, value: { uri, name: 'screen.png' } });
  const image = f.page.locator('.goal-chat-message-images img').first();
  await image.waitFor({ state: 'visible' });
  assert.equal(await image.getAttribute('src'), uri);
  assert.equal(await f.page.locator('.goal-chat-bubble').first().isVisible(), false, 'an image-only turn hides the empty bubble');

  // A failed thumbnail request degrades to the readable file-name chip.
  const second = await fixture(t);
  await second.emit(goalChat({}, [{ id: 'user-2', role: 'user', text: '', at: 2, images: [{ id: 'img-2', name: 'broken.png', mimeType: 'image/png', bytes: 10 }] }]));
  await second.page.waitForFunction(() => window.hostMessages.some(message => message.action === 'goalChatImage'));
  const failed = (await second.messages()).find(message => message.action === 'goalChatImage');
  await second.emit({ type: 'uiResult', requestId: failed.requestId, ok: false, error: '图片已不存在或不属于当前对话。' });
  const fallback = second.page.locator('.goal-chat-image-fallback').first();
  await fallback.waitFor({ state: 'visible' });
  assert.match(await fallback.textContent(), /broken\.png/);
  await second.page.screenshot({ path: screenshotDirectory + '/goal-chat-images.png' });
});
