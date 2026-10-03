// Run after `node build/build.mjs setup`; exercise the patched desktop, not a mocked VS Code API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

test('packaged workbench supports closable right-side tabs and reopening their views', { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const fixture = await fs.mkdtemp(path.join(root, '.cache/worker-desktop-'));
  const extension = path.join(fixture, 'probe');
  await fs.mkdir(extension);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'worker-panel-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(extension, 'extension.cjs'), `
    const vscode = require('vscode');
    exports.activate = async context => {
      await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
      vscode.window.createTerminal({ name: 'Worker panel regression', shellPath: process.env.ComSpec });
      await vscode.commands.executeCommand('ubovm.workerLogs.focus');
      const fs = require('node:fs/promises'), path = require('node:path');
      let previous = '', busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const request = JSON.parse(await fs.readFile(path.join(__dirname, '../request.json'), 'utf8'));
          if (request.id === previous) return;
          previous = request.id;
          await vscode.commands.executeCommand(request.command);
          await fs.writeFile(path.join(__dirname, '../response'), request.id);
        } catch {} finally { busy = false; }
      }, 30);
      context.subscriptions.push({ dispose() { clearInterval(timer); } });
    };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR'].includes(key)));
  const app = await _electron.launch({
    executablePath: path.resolve(root, config.core.runtime.directory, config.core.runtime.executable),
    args: ['--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--extensionDevelopmentPath=${extension}`],
    env: { ...env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' }, timeout: 60000
  });
  t.after(async () => {
    await page.screenshot({ path: path.join(root, '.cache/sidebar-lifecycle-latest.png') }).catch(() => {});
    await app.close();
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => document.querySelector('[id="workbench.parts.sidebar"]')?.textContent.includes('Worker 日志'), null, { timeout: 60000 });
  let workerFrame;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator('#worker-empty').count().catch(() => 0)) { workerFrame = frame; break; }
    }
    if (workerFrame) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!workerFrame) {
    await page.screenshot({ path: path.join(fixture, 'worker-load-failure.png') });
  }
  assert(workerFrame, 'Worker webview provider must actually resolve and load its page');
  assert.equal(await workerFrame.locator('#worker-empty').isVisible(), true);
  const sidebar = page.locator('[id="workbench.parts.sidebar"]');
  const workerContainer = sidebar.locator('[id="workbench.view.extension.ubovm-workers"]');
  await workerContainer.waitFor({ state: 'visible' });
  assert.equal(await sidebar.locator(':scope > .title .composite-bar-container').isVisible(), true, 'Worker tab must occupy the title row');
  assert.equal(await sidebar.locator(':scope > .title .title-label').isVisible(), false, 'Worker title must not repeat below its tab');
  const bounds = await sidebar.boundingBox(), editor = await page.locator('[id="workbench.parts.editor"]').boundingBox();
  assert(bounds.x >= editor.x + editor.width - 1, 'Worker must be to the right of the main editor');
  assert.equal(await page.locator('[id="workbench.parts.panel"] [id="workbench.view.extension.ubovm-workers"]').count(), 0);
  await page.screenshot({ path: path.join(fixture, 'worker-sidebar.png') });
  assert.equal(await workerFrame.locator('.worker-native-close').count(), 0);
  await sidebar.locator('.composite-bar-container').getByRole('tab', { name: /Explorer|资源管理器|文件/ }).locator('.action-label').click();
  await sidebar.locator('[id="workbench.view.explorer"]').waitFor({ state: 'visible' });
  const tabs = sidebar.locator('.composite-bar-container');
  await tabs.waitFor({ state: 'visible' });
  const initialBlackboard = tabs.getByRole('tab', { name: /黑板/ });
  if (await initialBlackboard.count()) {
    await initialBlackboard.locator('.ubovm-sidebar-tab-close').click();
    await initialBlackboard.waitFor({ state: 'detached' });
  }
  const workerTab = tabs.getByRole('tab', { name: /Worker/ });
  await workerTab.locator('.action-label').click();
  await workerContainer.waitFor({ state: 'visible' });
  // Native view actions suppress a second invocation within 300 ms.
  await new Promise(resolve => setTimeout(resolve, 350));
  await tabs.getByRole('tab', { name: /Explorer|资源管理器|文件/ }).locator('.action-label').click();
  await sidebar.locator('[id="workbench.view.explorer"]').waitFor({ state: 'visible' });
  let sequence = 0;
  async function open(command) {
    const id = String(++sequence);
    await fs.writeFile(path.join(fixture, 'request.json'), JSON.stringify({ id, command }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await fs.readFile(path.join(fixture, 'response'), 'utf8').catch(() => '') === id) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('View command timed out: ' + command);
  }
  await open('workbench.action.findInFiles');
  const searchTab = tabs.getByRole('tab', { name: /Search|搜索/ });
  await searchTab.waitFor({ state: 'visible' });
  const closeSearch = searchTab.locator('.ubovm-sidebar-tab-close');
  assert.equal(await closeSearch.count(), 1, 'Search tab exposes a close control');
  assert.equal(await closeSearch.evaluate(el => getComputedStyle(el).opacity), '1', 'Search close is always visible');
  await closeSearch.click();
  await searchTab.waitFor({ state: 'detached' });
  await sidebar.locator('[id="workbench.view.explorer"]').waitFor({ state: 'visible' });
  const closeWorker = tabs.getByRole('button', { name: /关闭.*Worker/ });
  await closeWorker.focus();
  await closeWorker.press('Enter');
  await workerTab.waitFor({ state: 'detached' });
  assert.equal(await sidebar.locator('[id="workbench.view.explorer"]').isVisible(), true, 'closing an inactive tab preserves the current view');
  assert.equal(await tabs.getByRole('tab', { name: /Explorer|资源管理器|文件/ }).evaluate(element => element === document.activeElement), true, 'keyboard closing keeps focus in the tab bar');
  await open('ubovm.workerLogs.focus');
  await workerTab.waitFor({ state: 'visible' });
  await closeWorker.focus();
  await closeWorker.press('Space');
  await workerTab.waitFor({ state: 'detached' });
  await sidebar.locator('[id="workbench.view.explorer"]').waitFor({ state: 'visible' });
  const fileTab = tabs.getByRole('tab', { name: /Explorer|资源管理器|文件/ });
  // The blackboard container may register after the initial extension startup.
  if (await initialBlackboard.count()) {
    await initialBlackboard.locator('.ubovm-sidebar-tab-close').click();
    await initialBlackboard.waitFor({ state: 'detached' });
  }
  assert.equal(await tabs.getByRole('tab').count(), 1, 'file tree is the last open tab');
  await fileTab.dispatchEvent('keydown', { key: 'Delete', repeat: true, bubbles: true });
  assert.equal(await fileTab.count(), 1, 'held Delete cannot close another tab after focus moves');
  await fileTab.focus(); await fileTab.press('Delete');
  const emptyAction = sidebar.getByRole('button', { name: /打开文件树/ });
  const openBrowser = sidebar.getByRole('button', { name: /打开浏览器/ });
  const openWorker = sidebar.getByRole('button', { name: /打开 Worker/ });
  await emptyAction.waitFor({ state: 'visible' });
  await openBrowser.waitFor({ state: 'visible' });
  await openWorker.waitFor({ state: 'visible' });
  assert.equal(await sidebar.getByText('文件树、浏览器与 Worker 同在右侧栏', { exact: true }).count(), 1, 'empty chooser exposes peer-tab prompt');
  assert.equal(await sidebar.isVisible(), true, 'last tab close keeps the sidebar open with the empty CTA');
  assert.equal(await tabs.getByRole('tab').count(), 0);
  await open('workbench.action.toggleSidebarVisibility');
  await sidebar.waitFor({ state: 'hidden' });
  await open('workbench.action.toggleSidebarVisibility');
  await emptyAction.waitFor({ state: 'visible' });
  await openBrowser.waitFor({ state: 'visible' });
  await openWorker.waitFor({ state: 'visible' });
  assert.equal(await tabs.getByRole('tab').count(), 0, 'reopening the sidebar must not reopen its closed tab');
  await openBrowser.click();
  const browserTab = tabs.getByRole('tab', { name: /浏览器|Browser/ });
  await browserTab.waitFor({ state: 'visible' });
  assert.equal(await emptyAction.count(), 0, 'opening browser clears the empty chooser');
  await browserTab.locator('.ubovm-sidebar-tab-close').click();
  await browserTab.waitFor({ state: 'detached' });
  await emptyAction.waitFor({ state: 'visible' });
  await emptyAction.click();
  await fileTab.waitFor({ state: 'visible' });
  assert.equal(await workerTab.count(), 0, 'closed Worker does not return with the file tab');
  await open('ubovm.workerLogs.focus');
  await workerTab.waitFor({ state: 'visible' });
  await workerContainer.waitFor({ state: 'visible' });
  await fileTab.locator('.action-label').click({ button: 'middle' });
  await fileTab.waitFor({ state: 'detached' });
  await workerContainer.waitFor({ state: 'visible' });
  await closeWorker.click();
  await emptyAction.waitFor({ state: 'visible' });
  await openBrowser.waitFor({ state: 'visible' });
  await openWorker.waitFor({ state: 'visible' });
  assert.equal(await sidebar.isVisible(), true, 'closing the last Worker tab keeps the empty CTA');
  assert.equal(await tabs.getByRole('tab').count(), 0);
  await openWorker.click();
  await workerTab.waitFor({ state: 'visible' });
  await workerContainer.waitFor({ state: 'visible' });
  await closeWorker.click();
  await emptyAction.waitFor({ state: 'visible' });
  assert.equal(await tabs.getByRole('tab').count(), 0, 'empty chooser Worker CTA pins and closes cleanly');
  await open('workbench.view.extension.ubovm-blackboard');
  const blackboardTab = tabs.getByRole('tab', { name: /黑板/ });
  await blackboardTab.waitFor({ state: 'visible' });
  await blackboardTab.locator('.ubovm-sidebar-tab-close').click();
  await blackboardTab.waitFor({ state: 'detached' });
  await emptyAction.waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
    console.error(await sidebar.evaluate(el => ({ text: el.textContent, state: { ...el.dataset }, classes: el.className, tabs: [...el.querySelectorAll('[role="tab"]')].map(tab => tab.textContent) })));
    throw error;
  });
  assert.equal(await sidebar.isVisible(), true, 'closing the last Blackboard tab keeps the empty CTA');
  await page.waitForFunction(() => !document.querySelector('[id="workbench.parts.sidebar"] .composite-bar-container [role="tab"]'));
  assert.equal(await tabs.getByRole('tab').count(), 0);
  await emptyAction.click();
  await fileTab.waitFor({ state: 'visible' });
  await blackboardTab.waitFor({ state: 'detached' });
  assert.equal(await tabs.getByRole('tab').count(), 1);
});
