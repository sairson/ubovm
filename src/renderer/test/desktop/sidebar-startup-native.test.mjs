import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('desktop keeps session navigation visible on a fresh profile', { timeout: 65000 }, async () => {
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
  const runtimeConfig = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const playwrightPath = process.env.UBOVM_TEST_PREBUILT === '1'
    ? path.join(root, runtimeConfig.core.runtime.directory, 'resources/app/ubovm/node_modules/playwright-core')
    : path.join(root, 'node_modules/playwright-core');
  const fixture = await fs.mkdtemp(path.join(root, '.cache/sidebar-startup-'));
  const home = path.join(fixture, 'home');
  const workspace = path.join(fixture, 'workspace');
  await Promise.all([home, workspace].map(dir => fs.mkdir(dir)));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const resultFile = path.join(fixture, 'result.json');
  const entry = path.join(fixture, 'run.cjs');
  await fs.writeFile(entry, `
exports.run = async () => {
  const fs = require('node:fs/promises');
  const assert = require('node:assert/strict');
  const vscode = require('vscode');
  const { chromium } = require(${JSON.stringify(playwrightPath)});
  let browser;
  try {
    await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'));
    page.setDefaultTimeout(20000);
    const filesSidebar = page.locator('[id="workbench.parts.sidebar"]');
    assert.equal(await filesSidebar.isVisible(), false, 'file sidebar starts collapsed');
    await page.locator('.ubovm-sidebar-modes').waitFor({ state: 'visible' });
    await page.locator('.ubovm-sidebar-management').waitFor({ state: 'visible' });
    await page.getByText('还没有会话', { exact: true }).waitFor();
    for (const mode of ['goal', 'assist', 'goal', 'assist']) {
      await page.locator('[data-mode="' + mode + '"]').click();
      await page.locator('[data-mode="' + mode + '"][aria-pressed="true"]').waitFor();
      assert(await page.locator('[data-mode="assist"]').isVisible());
      assert(await page.locator('[data-mode="goal"]').isVisible());
      assert.equal(await filesSidebar.isVisible(), false, 'mode changes must not open files');
    }
    for (const [settingsPage, command] of [['settings', 'ubovm.openSettings'], ['mcp', 'ubovm.openMcp'], ['skills', 'ubovm.openSkills']]) {
      await vscode.commands.executeCommand(command);
      await page.locator('[data-settings-page="' + settingsPage + '"][aria-current="page"]').waitFor();
      assert(await page.locator('[data-mode="assist"]').isVisible());
      assert(await page.locator('[data-mode="goal"]').isVisible());
      await page.locator('[data-mode="goal"]').click();
      await page.locator('[data-mode="goal"][aria-pressed="true"]').waitFor();
      await page.waitForFunction(() => !document.querySelector('.ubovm-sidebar-management [aria-current="page"]'));
      await page.getByText('还没有探索记录', { exact: true }).waitFor();
    }
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    await page.locator('.ubovm-sidebar-modes').waitFor({ state: 'hidden' });
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    await page.locator('.ubovm-sidebar-modes').waitFor({ state: 'visible' });
    assert(await page.locator('[data-mode="assist"]').isVisible());
    assert(await page.locator('[data-mode="goal"]').isVisible());
    await vscode.commands.executeCommand('ubovm.setMode', 'assist');
    await vscode.commands.executeCommand('ubovm.newChat');
    assert.equal(await filesSidebar.isVisible(), false, 'new conversations must not open files');
    assert((await vscode.commands.getCommands()).includes('_ubovm.setExplorerWorkspace'), 'Explorer service initializes while its panel stays hidden');
    await vscode.commands.executeCommand('workbench.view.explorer');
    await filesSidebar.waitFor({ state: 'visible' });
    await vscode.commands.executeCommand('ubovm.newChat');
    assert.equal(await filesSidebar.isVisible(), true, 'manual visibility survives session changes');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await page.locator('.ubovm-session-tree .monaco-list-row').first().click();
    assert.equal(await page.locator('.ubovm-sessions-body').evaluate(el => el.scrollTop), 0);
    assert(await page.locator('[data-mode="assist"]').isVisible());
    for (let attempt = 0; vscode.workspace.getConfiguration().get('window.customMenuBarAltFocus') !== false && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(vscode.workspace.getConfiguration().get('window.enableMenuBarMnemonics'), false);
    assert.equal(vscode.workspace.getConfiguration().get('window.customMenuBarAltFocus'), false);
    for (const key of ['Alt', 'Alt+f', 'Alt+e', 'Alt+s', 'F10']) {
      await page.locator('[data-mode="assist"]').focus();
      await page.keyboard.press(key);
      assert.equal(await page.locator('.menubar').first().isVisible(), false, key + ' must not reveal the original menu');
      await page.keyboard.press('Escape');
    }
    const layout = () => page.evaluate(() => ['sidebar', 'panel', 'auxiliarybar'].map(part => {
      const el = document.getElementById('workbench.parts.' + part);
      return Boolean(el && el.getBoundingClientRect().width && el.getBoundingClientRect().height);
    }));
    const terminalPanel = page.locator('[id="workbench.parts.panel"]');
    assert.equal(await terminalPanel.isVisible(), false, 'startup and session changes must not open the terminal');
    const local = await vscode.commands.executeCommand('ubovm.openLocalTerminal');
    await terminalPanel.waitFor({ state: 'visible' });
    assert.equal(local.creationOptions.shellPath, vscode.env.shell);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await terminalPanel.waitFor({ state: 'hidden' });
    // Extensions and background work may reveal a terminal without requesting focus.
    local.show(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await terminalPanel.isVisible(), false, 'background reveal must respect a manually closed panel');
    await vscode.commands.executeCommand('ubovm.newChat');
    assert.equal(await terminalPanel.isVisible(), false, 'session changes must keep the panel closed');
    await vscode.commands.executeCommand('ubovm.openLocalTerminal');
    await terminalPanel.waitFor({ state: 'visible' });
    assert.equal(vscode.window.activeTerminal, local, 'manual reopen reuses the shell');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    local.dispose();
    await terminalPanel.waitFor({ state: 'hidden' });
    const beforeShortcuts = await layout();
    for (const key of ['Control+Shift+p', 'Control+p', 'Control+b', 'Control+j', 'Control+Shift+e', 'Control+Shift+f', 'Control+Shift+x', 'Control+Comma', 'Control+Backslash', 'Control+n', 'Control+w', 'F1', 'F5', 'F11']) {
      await page.locator('[data-mode="assist"]').focus();
      await page.keyboard.press(key);
      assert.deepEqual(await layout(), beforeShortcuts, key + ' must not change the workbench layout');
      assert.equal(await page.locator('.quick-input-widget:visible').count(), 0, key + ' must not open upstream navigation');
      assert.equal(await page.locator('.monaco-dialog-box:visible').count(), 0, key + ' must not open upstream dialogs');
    }
    await page.screenshot({ path: ${JSON.stringify(path.join(fixture, 'sidebar.png'))} });
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  } finally { await browser?.close(); }
};`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, UBOVM_DATA_PROFILE: 'smoke', UBOVM_HARNESS_ENTRY: path.join(root, 'src/harness/index.mjs') });
  if (process.env.UBOVM_TEST_PREBUILT !== '1') env.VSCODE_DEV = '1';
  const executable = process.env.UBOVM_TEST_ELECTRON || path.join(root, 'vendor/vscode/.build/electron/Code - OSS.exe');
  const appArgs = process.env.UBOVM_TEST_PREBUILT === '1' ? [] : [path.join(root, 'vendor/vscode')];
  const child = spawn(executable, [...appArgs, '--no-sandbox', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir=' + path.join(home, 'user-data'), '--extensions-dir=' + path.join(home, 'extensions'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + path.join(root, 'src/renderer'), '--extensionTestsPath=' + entry, workspace], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Sidebar test timed out: ' + output)); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(() => JSON.stringify({ ok: false, error: output })));
  assert.equal(report.ok, true, report.error + '\nFixture: ' + fixture);
  assert.equal(code, 0, output);
});
