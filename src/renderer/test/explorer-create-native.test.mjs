import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('new-file toolbar and empty-folder button create files; cancel restores the welcome', { timeout: 65000 }, async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.cache/explorer-create-'));
  const workspace = path.join(fixture, 'window');
  const extension = path.join(fixture, 'extension'), home = path.join(fixture, 'home');
  await Promise.all([workspace, extension, home].map(folder => fs.mkdir(folder)));
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'session-explorer-test', publisher: 'ubovm', version: '0.0.1', engines: { vscode: '^1.100.0' } }));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const resultFile = path.join(fixture, 'result.json'), entry = path.join(extension, 'run.cjs');
  await fs.writeFile(entry, `
const fs = require('node:fs/promises'), assert = require('node:assert/strict');
exports.run = async () => {
  const vscode = require('vscode');
  let browser;
  try {
    const api = await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    await vscode.commands.executeCommand('workbench.view.explorer');
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright-core'))});
    browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'));
    assert(page, 'native workbench page'); page.setDefaultTimeout(10000);
    await page.getByText('文件夹还是空的', { exact: true }).waitFor();
    const filesPane = page.locator('.part.sidebar');
    const createButton = filesPane.locator('.title-actions .codicon-new-file, .pane-header .actions .codicon-new-file').filter({ visible: true });
    const filenameInput = filesPane.locator('.explorer-folders-view input');
    // The native toolbar uses an inline tree input, even when the folder is empty.
    await createButton.click();
    await filenameInput.waitFor({ state: 'visible' });
    await filenameInput.press('Escape');
    await filesPane.getByText('文件夹还是空的', { exact: true }).waitFor();
    await createButton.click();
    await filenameInput.fill('toolbar-created.txt');
    await filenameInput.press('Enter');
    await filesPane.getByText('toolbar-created.txt', { exact: true }).waitFor();
    const sessionRoot = api.assistantState().context.workspace;
    await fs.access(require('node:path').join(sessionRoot, 'toolbar-created.txt'));
    const remove = new vscode.WorkspaceEdit();
    remove.deleteFile(vscode.Uri.file(require('node:path').join(sessionRoot, 'toolbar-created.txt')));
    assert.equal(await vscode.workspace.applyEdit(remove), true);
    await filesPane.getByText('文件夹还是空的', { exact: true }).waitFor();
    // The empty-folder call to action uses the extension's filename dialog.
    await filesPane.getByRole('button', { name: '新建文件', exact: true }).click();
    const dialogInput = page.locator('.quick-input-widget input');
    await dialogInput.waitFor({ state: 'visible' });
    await dialogInput.fill('welcome-created.txt');
    await dialogInput.press('Enter');
    await filesPane.getByText('welcome-created.txt', { exact: true }).waitFor();
    await fs.access(require('node:path').join(sessionRoot, 'welcome-created.txt'));
    const cleanup = new vscode.WorkspaceEdit();
    cleanup.deleteFile(vscode.Uri.file(require('node:path').join(sessionRoot, 'welcome-created.txt')));
    assert.equal(await vscode.workspace.applyEdit(cleanup), true);
    await filesPane.getByText('文件夹还是空的', { exact: true }).waitFor();
    await page.screenshot({ path: ${JSON.stringify(path.join(fixture, 'empty-workspace.png'))} });
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  } finally { await browser?.close(); }
};`);
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, UBOVM_DATA_PROFILE: 'smoke' });
  const source = process.env.UBOVM_TEST_SOURCE === '1';
  const args = ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + entry, workspace];
  if (source) {
    env.VSCODE_DEV = '1';
    env.UBOVM_HARNESS_ENTRY = path.resolve(root, config.core.runtime.directory, 'resources/app/ubovm/harness/index.mjs');
    args.unshift(path.join(root, 'vendor/vscode'), '--extensionDevelopmentPath=' + path.join(root, 'src/renderer'));
  }
  const executable = source ? path.join(root, 'vendor/vscode/.build/electron/Code - OSS.exe') : path.resolve(root, config.core.runtime.directory, config.core.runtime.executable);
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Explorer test timed out: ' + output)); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(() => JSON.stringify({ ok: false, error: output })));
  assert.equal(report.ok, true, report.error);
  assert.equal(code, 0, output);
});
