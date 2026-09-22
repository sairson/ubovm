import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { renderWebview } = require('../host/webview.cjs');
const { createSettingsConfiguration } = require('../harness/config/settings-config.cjs');

test('Skills catalog and MCP lifecycle remain usable on narrow and wide pages', async () => {
  const service = createSettingsConfiguration({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
  const data = await service.snapshot();
  data.skillsCatalog = { directory: '~/.ubovm/skills', errors: [], items: [
    { name: 'browser-bridge', builtin: true, description: '浏览器操作与验证', content: '# Browser Bridge\n\n使用浏览器工具检查页面。\n\n<script>window.skillExecuted = true</script>' },
    { name: 'ceye-dnslog', builtin: true, description: 'DNS / HTTP 回连验证', content: '# DNSLog\n\n查看 DNS / HTTP 回连记录。' }
  ] };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [320, 1100]) {
      const page = await browser.newPage({ viewport: { width, height: 820 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) { window.sent.push(message); } }); });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'extensions-test' }) }));
      await page.goto('http://extensions.test/');
      await page.evaluate(data => window.postMessage({ type: 'openSettings', page: 'skills', data }, '*'), data);
      await page.locator('.settings-skill-card').first().waitFor();
      assert.equal(await page.locator('.settings-skill-card').count(), 2);
      assert.equal(await page.locator('#setting-directories').count(), 0);
      await page.locator('.settings-skill-card summary').first().click();
      assert.equal(await page.locator('.settings-skill-detail').first().isVisible(), true);
      assert.equal(await page.locator('.settings-skill-content').first().textContent(), data.skillsCatalog.items[0].content);
      assert.equal(await page.evaluate(() => window.skillExecuted), undefined);
      assert.equal((await page.locator('#settings-fields').textContent()).includes('~/.ubovm'), false);
      assert.equal(await page.locator('#settings-form').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (process.env.UBOVM_UI_PREVIEW && width === 1100) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/skills.png' });
      await page.locator('.settings-skill-card summary').first().click();
      await page.evaluate(data => window.postMessage({ type: 'openSettings', page: 'mcp', data }, '*'), data);
      await page.locator('#settings-add-mcp').click();
      const card = page.locator('[data-server-card]');
      assert.equal(await card.locator('[data-setting="enabled"]').isChecked(), true);
      await card.getByText('工具权限与连接选项', { exact: true }).click();
      assert.equal(await card.locator('[data-setting="cwd"]').isVisible(), false);
      await card.getByText('工具权限与连接选项', { exact: true }).click();
      await card.locator('[data-setting="name"]').fill('my-service');
      assert.equal(await card.locator('h4').textContent(), 'my-service');
      await card.locator('[data-setting="transport"]').selectOption('streamable_http');
      assert.equal(await card.locator('[data-setting="url"]').isVisible(), true);
      assert.equal(await card.locator('[data-setting="command"]').isVisible(), false);
      await card.locator('[data-setting="enabled"]').uncheck();
      assert.match(await page.locator('.settings-library-summary').textContent(), /0 个已启用/);
      assert.equal(await page.locator('#settings-form').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await card.locator('.settings-server-edit').click();
      assert.equal(await card.locator('[data-setting="url"]').isVisible(), false);
      assert.equal(await card.locator('[data-setting="enabled"]').isVisible(), true);
      if (process.env.UBOVM_UI_PREVIEW && width === 1100) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/mcp.png' });
      await card.locator('.settings-server-edit').click();
      await card.getByRole('button', { name: '移除服务' }).click();
      assert.equal(await page.locator('#setting-servers .settings-empty').isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
