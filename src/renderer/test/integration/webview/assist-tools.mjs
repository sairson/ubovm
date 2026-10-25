import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const now = Date.now();
const tool = (id, name, status, extra = {}) => ({
  id, type: 'tool', name, status, startedAt: now - 5000, endedAt: now - 4000,
  args: '{"path":"src/app.js"}', output: 'ok', ...extra
});
const stateFor = parts => ({
  type: 'state', mode: 'assist', conversation: { id: 'assist-tools', title: '工具组审计' },
  messages: [
    { id: 'u1', role: 'user', text: '检查工具调用卡片。' },
    { id: 'a1', role: 'assistant', text: '我会先读取相关文件。', parts }
  ],
  provider: { label: '测试模型', connected: true }, context: { workspace: 'UBOVM' },
  execution: { status: 'idle', parts: [], workers: [], activities: [] }, busy: false
});
const blue = color => Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 10;

async function colorOf(page, selector, prop = 'backgroundColor') {
  return page.locator(selector).first().evaluate((node, property) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(node)[property]; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }, prop);
}

test('assist tool groups and cards use page surfaces, neutral live states and no blue', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'assist-tools-test' }) }));
    await page.goto('http://assist-tools.test/');
    await page.evaluate(() => {
      document.body.classList.add('vscode-dark');
      for (const [key, value] of Object.entries({
        '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d',
        '--vscode-editor-background': '#1e1e1e', '--vscode-sideBar-background': '#252526',
        '--vscode-editorWidget-background': '#252526', '--vscode-widget-border': '#454545',
        '--vscode-panel-border': '#3c3c3c', '--vscode-focusBorder': '#007fd4',
        '--vscode-input-background': '#313131', '--vscode-button-background': '#0e639c',
        '--vscode-errorForeground': '#f14c4c', '--vscode-editorWarning-foreground': '#cca700'
      })) document.documentElement.style.setProperty(key, value);
    });
    const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const emit = async parts => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), stateFor(parts)); await paint(); };

    await emit([
      tool('a', 'read_workspace_file', 'completed'),
      tool('b', 'search_workspace', 'completed'),
      tool('c', 'run_local_shell_command', 'running', { endedAt: undefined, output: 'streaming...' })
    ]);
    assert.equal(await page.locator('.tool-group-toggle').isVisible(), true, 'live batch exposes its summary');
    assert.match(await page.locator('.tool-group-toggle').textContent(), /3 个工具调用/);
    assert.match(await page.locator('.tool-group-toggle').textContent(), /1 个运行中/);
    const group = await colorOf(page, '.tool-group');
    const groupBorder = await colorOf(page, '.tool-group', 'borderTopColor');
    assert.equal(blue(group), false, 'group surface stays neutral');
    assert.equal(blue(groupBorder), false, 'group border stays neutral');
    assert.equal(await page.locator('.tool-group').evaluate(node => getComputedStyle(node).borderRadius), '10px');
    const runningCard = await colorOf(page, '.tool-group > .tool-card[data-status="running"]');
    const runningIcon = await colorOf(page, '.tool-group > .tool-card[data-status="running"] .tool-kind-icon', 'color');
    assert.equal(blue(runningCard), false, 'running tool card uses page tint, not blue');
    assert.equal(blue(runningIcon), false, 'running tool icon is neutral');
    assert.equal(await page.locator('.tool-group > .tool-card[data-status="running"] .tool-kind-icon').evaluate(node => getComputedStyle(node).backgroundColor) !== 'rgba(0, 0, 0, 0)', true);

    await emit([
      tool('a', 'read_workspace_file', 'completed'),
      tool('b', 'search_workspace', 'completed'),
      tool('c', 'run_local_shell_command', 'completed'),
      tool('d', 'scan_workspace_secrets', 'failed', { output: 'permission denied' })
    ]);
    assert.notEqual(await page.locator('.tool-group-toggle').getAttribute('data-expanded'), 'true');
    const failedStatus = await page.locator('.tool-group > .tool-card[data-status="failed"] .tool-status').evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderTopLeftRadius, border: style.borderTopWidth, color: style.color };
    });
    assert.equal(failedStatus.radius, '2px');
    assert.equal(failedStatus.border, '1px');
    const failed = await colorOf(page, '.tool-group > .tool-card[data-status="failed"] .tool-status', 'color');
    assert(failed.r > failed.g, 'failed label stays red');

    await emit([tool('only', 'read_workspace_file', 'completed')]);
    assert.equal(await page.locator('.tool-group').getAttribute('data-compact'), 'false');
    const single = await colorOf(page, '.tool-group > .tool-card');
    assert.equal(blue(single), false);
    const singleCard = await page.locator('.tool-group > .tool-card').evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderTopLeftRadius, border: style.borderTopWidth };
    });
    assert.equal(singleCard.radius, '8px');
    assert.equal(singleCard.border, '1px');
    await page.screenshot({ path: '.cache/assist-tools/final-dark.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
