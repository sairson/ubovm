import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const now = Date.now();
const snapshot = {
  sessionId: 'dark-palette', revision: 2, rootId: 'root', goal: '审计响应头',
  nodes: [
    { id: 'root', kind: 'root', parentIds: [], goal: '审计响应头', intent: null, attempts: [], fact: { content: '审计响应头' } },
    { id: 'n2', kind: 'intent', parentIds: ['root'], intent: { description: '审计 CSP', status: 'completed', priority: 'high' }, attempts: [], resultId: 'n3' },
    { id: 'n3', kind: 'fact', parentIds: ['n2'], producerId: 'n2', intent: null, attempts: [], fact: { content: '{"version":1,"outcome":"confirmed","statement":"CSP 覆盖首页","coverage":[],"evidence":[]}' } },
    { id: 'n4', kind: 'intent', parentIds: ['root'], intent: { description: '核对缓存', status: 'running', priority: 'medium' }, attempts: [], resultId: null }
  ]
};
const state = {
  type: 'state', mode: 'goal', conversation: { id: 'dark-palette', title: '深色配色' },
  goal: { objective: '审计响应头', criteria: [{ id: 'c1', text: '确认 CSP', done: false }], notes: [{ id: 'n1', content: '记录一条深色模式笔记。', created_at: now - 1000 }] },
  messages: [], provider: { configured: true, connected: true, label: '测试模型' }, context: {}, busy: true,
  agenda: {
    counts: { planned: 1, active: 1, blocked: 1, done: 1, dropped: 0, total: 4 }, gaps: [],
    items: [
      { id: 'intent:n4', kind: 'intent', intentId: 'n4', ref: 'n5', title: '核对缓存', status: 'active', source: 'blackboard' },
      { id: 'intent:n2', kind: 'intent', intentId: 'n2', ref: 'n3', title: '审计 CSP', status: 'done', source: 'blackboard' },
      { id: 'intent:n6', kind: 'intent', intentId: 'n6', ref: 'n8', title: '枚举 TLS', status: 'blocked', source: 'blackboard' },
      { id: 'suggestion:retry:n6', kind: 'suggestion', title: '换一种方法继续：枚举 TLS', status: 'planned', source: 'failure' }
    ]
  },
  graph: { revision: 2, nodes: 4, intents: 2, facts: 1, edges: 3, root: 'n1', detail: 'full', omittedFacts: 1, overBudget: false },
  memory: { notes: [{ id: 'n1', content: '记录一条深色模式笔记。', created_at: now - 1000 }] },
  execution: {
    status: 'running', busy: true, phase: 'execute', parts: [
      { id: 'plan', type: 'thinking', source: 'reason', status: 'running', text: '正在规划深色模式。' },
      { id: 'conclusion', type: 'text', source: 'reason', status: 'completed', text: '结论：深色卡片需要层级。' }
    ], blackboard: snapshot,
    activities: [{ label: 'Reason', status: 'running', timestamp: now - 3000, key: 'r' }],
    workers: [
      { id: 'w-n2', intentId: 'n2', description: '审计 CSP', status: 'completed', priority: 1, createdAt: now - 7000, finishedAt: now - 4000, result: 'CSP 覆盖首页' },
      { id: 'w-n4', intentId: 'n4', description: '核对缓存', status: 'running', priority: 2, createdAt: now - 5000, parts: [] }
    ]
  }
};

async function colorOf(page, selector, property) {
  return page.locator(selector).first().evaluate((node, prop) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(node)[prop];
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }, property);
}
const channel = color => color.r + color.g + color.b;
const contrast = (a, b) => {
  const lum = color => {
    const values = [color.r, color.g, color.b].map(value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  };
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

test('assist dark surfaces follow the same neutral palette as exploration', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'dark-assist-test' }) }));
    await page.goto('http://dark-assist.test/');
    await page.evaluate(() => {
      document.body.classList.add('vscode-dark');
      for (const [key, value] of Object.entries({
        '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d',
        '--vscode-editor-background': '#1e1e1e', '--vscode-sideBar-background': '#252526',
        '--vscode-editorWidget-background': '#252526', '--vscode-widget-border': '#454545',
        '--vscode-panel-border': '#3c3c3c', '--vscode-focusBorder': '#007fd4',
        '--vscode-input-background': '#313131', '--vscode-button-background': '#0e639c'
      })) document.documentElement.style.setProperty(key, value);
    });
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
      type: 'state', mode: 'assist', conversation: { id: 'assist-dark', title: '深色审计' },
      messages: [], provider: { label: '测试模型', connected: true }, context: { workspace: 'UBOVM' },
      execution: { status: 'idle', parts: [], workers: [], activities: [] }, busy: false
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const selector of ['.composer', '.composer .submit', '.topbar']) {
      const color = await colorOf(page, selector, 'backgroundColor');
      if (color.a === 0) continue;
      assert(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 6, `${selector} should stay neutral`);
    }
    await page.screenshot({ path: '.cache/exploration-cards/dark-assist-audit.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the neutral dark exploration palette introduces no decorative blue', async () => {
  const css = readFileSync('src/renderer/webview/styles.css', 'utf8');
  const marker = '/* Neutral dark palette for exploration';
  const block = css.slice(css.indexOf(marker));
  assert(block.length > 1000);
  for (const blue of ['#7aaaff', '#0e639c', '#007fd4', '#04395e']) {
    assert.equal(block.includes(blue), false, `dark exploration palette should not use ${blue}`);
  }
});

test('dark exploration headers ignore the host theme green accents', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'dark-green-host' }) }));
    await page.goto('http://dark-green-host.test/');
    // The bundled dark theme uses green primary/focus/selection colors. Goal
    // chrome must stay monochrome while semantic state colors remain green.
    await page.evaluate(() => {
      document.body.classList.add('vscode-dark');
      for (const [key, value] of Object.entries({
        '--vscode-foreground': '#d4d4d4', '--vscode-descriptionForeground': '#a0a0a0',
        '--vscode-editor-background': '#1b1b1c', '--vscode-sideBar-background': '#232324',
        '--vscode-editorWidget-background': '#232324', '--vscode-widget-border': '#353638',
        '--vscode-panel-border': '#353638', '--vscode-focusBorder': '#a3c0ae',
        '--vscode-input-background': '#2c2c2e', '--vscode-button-background': '#96b3a0',
        '--vscode-button-foreground': '#202422', '--vscode-button-hoverBackground': '#aec6b7',
        '--vscode-list-activeSelectionBackground': '#3a4f43', '--vscode-list-activeSelectionForeground': '#f0f6f2',
        '--vscode-list-inactiveSelectionBackground': '#314339', '--vscode-list-hoverBackground': '#2c352f',
        '--vscode-progressBar-background': '#658473', '--vscode-charts-green': '#4ed17e',
        '--vscode-textLink-foreground': '#7aaaff'
      })) document.documentElement.style.setProperty(key, value);
    });
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state);
    await frames(); await frames();
    await page.locator('#goal-view-switcher > summary').click();
    await page.locator('#goal-tab-notes').click();
    await frames(); await frames();
    const neutral = (color, label) => assert(
      Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 10,
      `${label} should stay neutral in dark exploration: ${JSON.stringify(color)}`);
    neutral(await colorOf(page, '.note-reader-toolbar', 'backgroundColor'), 'notes reader toolbar');
    neutral(await colorOf(page, '#note-new', 'backgroundColor'), 'notes header primary action');
    neutral(await colorOf(page, '.notebook-filters button[aria-pressed="true"]', 'color'), 'notes filter selection');
    neutral(await colorOf(page, '.notebook-heading', 'borderBottomColor'), 'notes page heading hairline');
    const focus = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--focus)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return { r, g, b };
    });
    neutral(focus, 'goal focus color');
    // Semantic success colors are intentionally still green in the same view.
    const memoryState = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--dsw-alias-state-success-primary)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return { r, g, b };
    });
    assert(memoryState.g > memoryState.r && memoryState.g > memoryState.b, 'semantic success stays green');
    await page.screenshot({ path: '.cache/exploration-cards/dark-notes-header-green-host.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('dark exploration palette uses layered surfaces, calm accents and readable state tints', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} }); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'dark-palette-test' }) }));
    await page.goto('http://dark-palette.test/');
    await page.evaluate(() => {
      document.body.classList.add('vscode-dark');
      for (const [key, value] of Object.entries({
        '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d',
        '--vscode-editor-background': '#1e1e1e', '--vscode-sideBar-background': '#252526',
        '--vscode-editorWidget-background': '#252526', '--vscode-widget-border': '#454545',
        '--vscode-panel-border': '#3c3c3c', '--vscode-focusBorder': '#007fd4',
        '--vscode-input-background': '#313131', '--vscode-button-background': '#0e639c',
        '--vscode-button-foreground': '#ffffff', '--vscode-errorForeground': '#f14c4c',
        '--vscode-editorWarning-foreground': '#cca700'
      })) document.documentElement.style.setProperty(key, value);
    });
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const openTab = async view => {
      if (view === 'overview') return;
      await page.locator('#goal-view-switcher > summary').click();
      await page.locator(`#goal-tab-${view}`).click();
      await frames(); await frames();
    };
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state);
    await frames(); await frames();
    const canvas = await colorOf(page, '.goal-mode', 'backgroundColor');
    const panel = await colorOf(page, '.goal-output-panel', 'backgroundColor');
    const content = await colorOf(page, '#goal-output-content', 'backgroundColor');
    assert(channel(panel) > channel(canvas) + 20, `card surface should lift off the page: ${JSON.stringify({ canvas, panel })}`);
    assert(channel(content) < channel(panel), 'log stream should sit below the raised card');
    const ink = await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.color = 'var(--ink)'; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    });
    const inkColor = await page.evaluate(color => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return { r, g, b };
    }, ink);
    assert(contrast(inkColor, panel) >= 7, 'primary text should be high contrast on cards');
    const spinner = await page.locator('#header-execution-status').evaluate(node => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const ctx = canvas.getContext('2d');
      ctx.fillStyle = getComputedStyle(node, '::before').borderTopColor; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return { r, g, b };
    });
    assert(Math.max(spinner.r, spinner.g, spinner.b) - Math.min(spinner.r, spinner.g, spinner.b) <= 10, 'live spinner stays neutral');
    await openTab('agenda');
    const normal = await colorOf(page, '.goal-agenda-row:not([data-status="active"])', 'backgroundColor');
    const active = await colorOf(page, '.goal-agenda-row[data-status="active"]', 'backgroundColor');
    assert.equal(normal.r, panel.r);
    assert(channel(active) > channel(normal), 'active agenda row lifts neutrally');
    const activeChip = await colorOf(page, '.goal-agenda-row[data-status="active"] .goal-agenda-chip', 'color');
    const doneChip = await colorOf(page, '.goal-agenda-row[data-status="done"] .goal-agenda-chip', 'color');
    const blockedChip = await colorOf(page, '.goal-agenda-row[data-status="blocked"] .goal-agenda-chip', 'color');
    assert(Math.max(activeChip.r, activeChip.g, activeChip.b) - Math.min(activeChip.r, activeChip.g, activeChip.b) <= 10, 'running state stays neutral, not blue');
    assert(doneChip.g > doneChip.r && doneChip.g > doneChip.b, 'done state is green');
    assert(blockedChip.r > blockedChip.g, 'blocked state is red');
    await openTab('workers');
    const completed = await colorOf(page, '.worker-status[data-status="completed"]', 'color');
    assert(completed.g > completed.r && completed.g > completed.b, 'completed worker is green');
    const priority = await colorOf(page, '.worker-priority', 'color');
    assert(Math.max(priority.r, priority.g, priority.b) - Math.min(priority.r, priority.g, priority.b) <= 10, 'priority stays neutral');
    await openTab('notes');
    const library = await colorOf(page, '.notebook-library', 'backgroundColor');
    const layout = await colorOf(page, '.notebook-layout', 'backgroundColor');
    const note = await colorOf(page, '.note-select', 'backgroundColor');
    assert(channel(library) < channel(layout), 'library sits below the notebook card');
    assert(channel(note) > channel(library) + 20, 'note rows lift off the library');
    const primary = await colorOf(page, '#note-new', 'backgroundColor');
    assert(Math.max(primary.r, primary.g, primary.b) - Math.min(primary.r, primary.g, primary.b) <= 10, 'primary action is neutral, not blue');
    await openTab('board');
    const root = await colorOf(page, '.graph-node[data-kind="root"]', 'backgroundColor');
    assert(Math.max(root.r, root.g, root.b) - Math.min(root.r, root.g, root.b) <= 10, 'root target stays neutral, not blue');
    const viewport = await colorOf(page, '.graph-viewport', 'backgroundColor');
    assert(channel(viewport) < channel(panel), 'graph canvas stays inset');
    await page.screenshot({ path: '.cache/exploration-cards/dark-palette-test.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
