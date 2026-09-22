import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('source desktop opens the session sidebar on a fresh profile', { timeout: 65000 }, async () => {
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
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
  const vscode = require('vscode');
  const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright-core'))});
  let browser;
  try {
    await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'));
    page.setDefaultTimeout(20000);
    await page.locator('.ubovm-sidebar-modes').waitFor({ state: 'visible' });
    await page.locator('.ubovm-sidebar-management').waitFor({ state: 'visible' });
    await page.getByText('还没有会话', { exact: true }).waitFor();
    await page.screenshot({ path: ${JSON.stringify(path.join(fixture, 'sidebar.png'))} });
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  } finally { await browser?.close(); }
};`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, VSCODE_DEV: '1', UBOVM_DATA_PROFILE: 'smoke', UBOVM_HARNESS_ENTRY: path.join(root, 'src/harness/index.mjs') });
  const child = spawn(path.join(root, 'vendor/vscode/.build/electron/Code - OSS.exe'), [path.join(root, 'vendor/vscode'), '--no-sandbox', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + path.join(root, 'src/renderer'), '--extensionTestsPath=' + entry, workspace], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
