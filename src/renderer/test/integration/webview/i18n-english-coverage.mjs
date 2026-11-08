import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { renderWebview } = require('../../../host/ui/webview.cjs');
const { createSettingsConfiguration } = require('../../../harness/config/settings-config.cjs');

const state = overrides => ({
  type: 'state', mode: 'assist', conversation: { id: 'i18n-coverage', title: '新对话' }, messages: [],
  context: { workspace: 'demo', file: '', fileSource: null },
  provider: { configured: true, connected: true, label: 'deepseek-v4' },
  execution: { status: 'idle', busy: false, activities: [], parts: [] },
  notes: [], projects: [], modelSelection: { selected: '', models: [] }, ...overrides
});

function leaks(page) {
  return page.evaluate(() => {
    const skip = '#messages, #goal-output-content, #note-reader-body, #blackboard-nodes, #assist-activities, #collaboration-worker-list, #goal-workers-list, #goal-notes-list, #agent-notes-list, #outline-list, #exploration-run-list, #assist-evidence-list, #assist-todos-groups, #criteria-list, #project-switcher-list, #ubovm-modal-list, #settings-fields, .settings-locale-options, #ui-error-detail, pre, code, textarea, script, style';
    const userIds = new Set(['goal-objective', 'context-label', 'goal-selection-label']);
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement;
      if (!el || el.closest(skip) || userIds.has(el.id)) continue;
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!/[\u4e00-\u9fff]/.test(text)) continue;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || (rect.width === 0 && rect.height === 0)) continue;
      out.push({ text, id: el.id, cls: String(el.className || '').slice(0, 60) });
    }
    return out;
  });
}

async function fixture() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: () => true }); });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ workspaceName: 'demo', nonce: 'i18n-en-coverage' }) }));
  await page.goto('http://i18n-en-coverage.test/');
  await page.evaluate(() => window.UBOVMi18n.setLocale('en'));
  return { browser, page };
}

test('English welcome, goal and settings surfaces contain no visible Chinese UI strings', async () => {
  const { browser, page } = await fixture();
  try {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await leaks(page), [], 'welcome page');

    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state({
      mode: 'goal', conversation: { id: 'i18n-goal', title: '探索任务' },
      goal: { objective: '检查登录接口', criteria: [{ id: 'c1', text: '验证通过', done: false }], notes: [] },
      agenda: { counts: { planned: 0, active: 0, blocked: 0, done: 0, dropped: 0, total: 0 }, items: [] },
      graph: { revision: 1, nodes: 1, intents: 0, facts: 0, edges: 0, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false }
    }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await leaks(page), [], 'goal page');

    const service = createSettingsConfiguration({ ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }, { secrets: { get: async () => undefined } });
    const data = await service.snapshot({ includeSkills: false });
    for (const target of ['settings', 'skills', 'mcp']) {
      await page.evaluate(([data, target]) => window.postMessage({ type: 'openSettings', page: target, data }, '*'), [data, target]);
      await page.waitForFunction(() => !document.getElementById('settings-dialog').hidden);
      await page.waitForTimeout(250);
      assert.deepEqual(await leaks(page), [], target + ' settings page');
    }
  } finally { await browser.close(); }
});

test('late DOM writes are translated while English is active', async () => {
  const { browser, page } = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const probe = document.createElement('p');
      probe.id = 'late-i18n-probe';
      probe.textContent = '继承默认模型';
      document.body.append(probe);
      await new Promise(resolve => setTimeout(resolve, 30));
      return probe.textContent;
    });
    assert.equal(result, 'Inherit default model');
  } finally { await browser.close(); }
});
