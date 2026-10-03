import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserManager, createBrowserTools } from './index.mjs';

// Opt-in integration test: use a host-installed Chromium, never download one.
test('real Chromium tools operate controls, capture images and isolate worker storage', {
  skip: !process.env.UBOVM_TEST_BROWSER_PATH, timeout: 60000,
}, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>工具验证</title><body>
      <label>Name <input id="name"></label><button onclick="document.querySelector('#out').textContent = document.querySelector('#name').value">Save</button>
      <p id="out">Ready</p></body>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const manager = new BrowserManager({ executablePath: process.env.UBOVM_TEST_BROWSER_PATH });
  t.after(() => manager.close());
  const binding = { sessionId: 'native-smoke', workerId: 'first' };
  const [tool] = createBrowserTools({ manager, ...binding });
  const call = async input => JSON.parse((await tool.execute('smoke', input)).content[0].text);
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await call({ action: 'tab_new', url });
  assert.equal(page.title, '工具验证');
  const snapshot = await call({ action: 'snapshot' });
  const input = snapshot.elements.find(item => item.role === 'textbox');
  const button = snapshot.elements.find(item => item.role === 'button');
  assert.ok(input?.ref); assert.ok(button?.ref);
  await call({ action: 'fill', ref: input.ref, value: '验证😀' });
  await call({ action: 'click', ref: button.ref });
  assert.equal((await call({ action: 'evaluate', script: 'document.querySelector("#out").textContent' })).result, '验证😀');
  await call({ action: 'evaluate', script: 'localStorage.setItem("owner", "first")' });
  const screenshot = await tool.execute('image', { action: 'screenshot' });
  const image = screenshot.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(image.data, 'base64').length > 100);
  const other = { ...binding, workerId: 'second' };
  await manager.call(other, { action: 'tab_new', url });
  assert.equal((await manager.call(other, { action: 'evaluate', script: 'localStorage.getItem("owner")' })).result, null);
  await assert.rejects(manager.call(other, { action: 'snapshot', page_id: page.page_id }), /another Worker/);
  await manager.close();
  assert.equal((await manager.status(binding)).state, 'closed');
});
