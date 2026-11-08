import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

// Tool results can inline one image (`part.image`) and flag more (`part.imageOmitted`).
// The same fixture as tool-cards.mjs: a real Webview assembled from the bundled
// scripts/styles and a fake host bridge. Browser coverage cannot run in every
// sandbox, so keep this file aligned with the shared fixture contract.
let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const start = Date.now();
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const user = { role: 'user', text: '读取一张图片。' };

const image = (overrides = {}) => ({ mimeType: 'image/png', data: PNG_BASE64, width: 64, height: 32, bytes: 3000, ...overrides });
const imageTool = (overrides = {}) => ({
  id: 'read-image', type: 'tool', name: 'read_image', status: 'completed',
  args: '{"path":"assets/hero.png"}', output: '[Image result]', startedAt: start, endedAt: start + 500,
  image: image(), ...overrides
});

function state(parts, overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: 'tool-images', title: '工具图片' },
    messages: [user], goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    execution: { status: 'running', busy: true, parts, streamText: '', activities: [] }, ...overrides
  };
}

async function fixture(t, { savedState, ...options } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  // Data URLs must never become network requests.
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://tool-images.test/') requests.push(request.url()); });
  await page.addInitScript(saved => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => saved, setState() {}, postMessage: message => hostMessages.push(message) });
  }, savedState ?? {});
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'tool-images-test' });
  await page.route('http://tool-images.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://tool-images.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value); await frames(); };
  const card = index => page.locator('#messages .tool-card').nth(index);
  const toggle = async index => {
    await card(index).locator(':scope > summary').click(); await frames();
    await card(index).evaluate(async element => {
      const transitions = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity);
      await Promise.allSettled(transitions.map(animation => animation.finished));
    });
  };
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'the webview must not throw browser errors'); assert.deepEqual(requests, [], 'inlined images must not fetch remote resources'); });
  return { page, emit, frames, card, toggle };
}

test('read_image result inlines a compact figure, format/dimensions/size caption and data URL', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool()]));
  const card = f.card(0);
  // read_image is a read-only tool, but the image makes the card expandable.
  assert.equal(await card.getAttribute('data-readonly'), 'false');
  assert.equal(await card.getAttribute('data-expandable'), 'true');
  assert.equal(await card.evaluate(element => element.open), false);
  assert.equal(await card.locator('.tool-image').isVisible(), false, 'the thumbnail waits for the expanded body');
  await f.toggle(0);
  const figure = card.locator('.tool-image');
  assert.equal(await figure.isVisible(), true);
  assert.equal(await figure.getAttribute('aria-expanded'), 'false');
  const preview = figure.locator('img');
  assert.match(await preview.getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await preview.getAttribute('loading'), 'lazy');
  assert.equal(await preview.getAttribute('decoding'), 'async');
  assert.equal(await figure.locator('.tool-image-caption').textContent(), 'PNG · 64×32 · 2.9 KB');
});

test('tool image activates and restores the enlarged state by click and keyboard', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool()]));
  await f.toggle(0);
  const figure = f.card(0).locator('.tool-image');
  await figure.click();
  assert.equal(await figure.getAttribute('data-expanded'), 'true');
  assert.equal(await figure.getAttribute('aria-expanded'), 'true');
  assert.equal(await figure.getAttribute('aria-label'), '缩小图片');
  await figure.press('Enter');
  assert.equal(await figure.getAttribute('data-expanded'), 'false');
  assert.equal(await figure.getAttribute('aria-label'), '放大图片');
  await figure.press('Space');
  assert.equal(await figure.getAttribute('data-expanded'), 'true');
});

test('an omitted image note stays readable while the card remains expandable without an image', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool({ id: 'read-image-omitted', image: undefined, imageOmitted: true, output: '{"status":"ok","images":3}' })]));
  const card = f.card(0);
  assert.equal(await card.getAttribute('data-readonly'), 'false');
  assert.equal(await card.getAttribute('data-expandable'), 'true');
  await f.toggle(0);
  assert.equal(await card.locator('.tool-image').isVisible(), false);
  assert.equal(await card.locator('.tool-image-note').isVisible(), true);
  assert.match(await card.locator('.tool-image-note').textContent(), /部分图片未内联显示/);
});

test('changed image data re-renders the existing figure while identical data is ignored', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool()]));
  await f.toggle(0);
  const card = f.card(0);
  assert.equal(await card.evaluate(element => element.open), true);
  await f.page.evaluate(() => { window.toolImageFigure = document.querySelector('#messages .tool-image'); });
  const firstSource = await card.locator('.tool-image img').getAttribute('src');
  // A new object with the same projected fields must not be treated as a change.
  await f.emit(state([imageTool({ image: image() })]));
  assert.equal(await card.evaluate(element => element.open), true);
  assert.equal(await f.page.evaluate(() => document.querySelector('#messages .tool-image') === window.toolImageFigure), true);
  assert.equal(await card.locator('.tool-image img').getAttribute('src'), firstSource);
  // A changed payload updates the same figure in place, keeping the enlarged state.
  await f.emit(state([imageTool({ image: image({ mimeType: 'image/jpeg', width: 128, height: 64, bytes: 6000 }) })]));
  assert.equal(await f.page.evaluate(() => document.querySelector('#messages .tool-image') === window.toolImageFigure), true);
  assert.equal(await card.evaluate(element => element.open), true);
  assert.match(await card.locator('.tool-image img').getAttribute('src'), /^data:image\/jpeg;base64,/);
  assert.equal(await card.locator('.tool-image-caption').textContent(), 'JPEG · 128×64 · 5.9 KB');
});

test('read_image without an inlined image keeps the flat read-only row', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool({ image: undefined, output: '{"path":"assets/hero.png","status":"ok"}' })]));
  const card = f.card(0);
  assert.equal(await card.getAttribute('data-readonly'), 'true');
  assert.equal(await card.getAttribute('data-expandable'), 'false');
  assert.equal(await card.locator('.tool-image').isVisible(), false);
  await card.evaluate(element => { element.open = true; });
  await f.frames();
  assert.equal(await card.evaluate(element => element.open), false);
});

test('a collapsed tool row shows a compact thumbnail without opening the card', async t => {
  const f = await fixture(t);
  await f.emit(state([imageTool()]));
  const card = f.card(0);
  assert.equal(await card.evaluate(element => element.open), false);
  const thumb = card.locator('.tool-summary-image');
  assert.equal(await thumb.isVisible(), true, 'the screenshot is visible while the card stays folded');
  assert.match(await thumb.getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await thumb.getAttribute('loading'), 'lazy');
  assert.equal(await card.locator('.tool-image').isVisible(), false, 'the full figure still waits for expansion');
  // The thumbnail refreshes in place when the projected image changes.
  await f.emit(state([imageTool({ image: image({ mimeType: 'image/jpeg', width: 128, height: 64, bytes: 6000 }) })]));
  assert.match(await card.locator('.tool-summary-image').getAttribute('src'), /^data:image\/jpeg;base64,/);
  // An omitted-only result carries no thumbnail; the note explains it instead.
  await f.emit(state([imageTool({ image: undefined, imageOmitted: true, imageOmittedNote: true })]));
  assert.equal(await card.locator('.tool-summary-image').isVisible(), false);
});
