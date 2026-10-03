import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));

for (const emptyWindow of [false, true]) test(`native explorer replaces session roots and watches files (${emptyWindow ? 'empty window' : 'folder window'})`, { timeout: 65000 }, async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.cache/session-explorer-'));
  const workspace = path.join(fixture, 'window'), a = path.join(fixture, 'project-a'), b = path.join(fixture, 'project-b');
  const extension = path.join(fixture, 'extension'), home = path.join(fixture, 'home');
  await Promise.all([workspace, a, b, extension, home].map(folder => fs.mkdir(folder)));
  await fs.writeFile(path.join(a, 'only-project-a.txt'), 'A');
  await fs.writeFile(path.join(b, 'only-project-b.txt'), 'B');
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
    await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    // Activation schedules layout/recovery and initial session-root sync. Let
    // those finish before this test takes control of the core Explorer roots.
    await new Promise(resolve => setTimeout(resolve, 2200));
    await vscode.commands.executeCommand('workbench.view.explorer');
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright-core'))});
    browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'));
    assert(page, 'native workbench page'); page.setDefaultTimeout(10000);
    // A fresh session receives its own default directory even in an empty window.
    await page.getByText('文件夹还是空的', { exact: true }).waitFor();
    await vscode.commands.executeCommand('ubovm.setMode', 'goal');
    await vscode.commands.executeCommand('ubovm.sessions.focus');
    await page.getByText('还没有探索记录', { exact: true }).waitFor();
    const assertCentered = async () => {
      await page.waitForFunction(() => {
        const elements = [...document.querySelectorAll('.welcome-view-content')].filter(el => el.getBoundingClientRect().height > 0);
        return elements.length === 2 && elements.every(el => {
          const view = el.closest('.welcome-view').getBoundingClientRect();
          const first = el.firstElementChild.getBoundingClientRect(), last = el.lastElementChild.getBoundingClientRect();
          return Math.abs((first.top - view.top) - (view.bottom - last.bottom)) < 2;
        });
      }).catch(async error => {
        const geometry = await page.evaluate(() => [...document.querySelectorAll('.welcome-view-content')].map(el => {
          const view = el.closest('.welcome-view').getBoundingClientRect();
          const first = el.firstElementChild.getBoundingClientRect(), last = el.lastElementChild.getBoundingClientRect();
          return { text: el.textContent, height: el.getBoundingClientRect().height, view: view.height, top: first.top - view.top, bottom: view.bottom - last.bottom, offset: el.getBoundingClientRect().top - view.top, scroll: el.scrollTop, parentScroll: el.parentElement.scrollTop, parentHeight: el.parentElement.clientHeight, before: getComputedStyle(el, '::before').cssText, after: getComputedStyle(el, '::after').content, padding: getComputedStyle(el).padding, children: [...el.children].map(child => ({ tag: child.tagName, cls: child.className, margin: getComputedStyle(child).margin, padding: getComputedStyle(child).padding })) };
        }));
        throw new Error(error.message + JSON.stringify(geometry));
      });
    };
    await assertCentered();
    await vscode.commands.executeCommand('ubovm.setMode', 'assist');
    await page.getByText('还没有会话', { exact: true }).waitFor();
    await assertCentered();
    await vscode.commands.executeCommand('ubovm.setMode', 'goal');
    await page.getByText('还没有探索记录', { exact: true }).waitFor();
    await assertCentered();
    const original = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString());
    assert.equal(original.length, ${emptyWindow ? 0 : 1}, 'window workspace stays independent of the session root');
    // Mode changes schedule a debounced welcome-state check for the host session.
    await new Promise(resolve => setTimeout(resolve, 250));
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', false);
    await vscode.commands.executeCommand('setContext', 'ubovm.emptyFolder', false);
    const tree = page.locator('.explorer-folders-view');
    await vscode.commands.executeCommand('_ubovm.setExplorerWorkspace', ${JSON.stringify(a)});
    await tree.getByText('only-project-a.txt', { exact: true }).waitFor();
    await vscode.commands.executeCommand('_ubovm.setExplorerWorkspace', ${JSON.stringify(b)});
    await tree.getByText('only-project-b.txt', { exact: true }).waitFor();
    assert.equal(await tree.getByText('only-project-a.txt', { exact: true }).count(), 0);
    // The native filesystem watcher starts asynchronously after registration.
    await new Promise(resolve => setTimeout(resolve, 1200));
    await fs.writeFile(${JSON.stringify(path.join(b, 'created-in-b.txt'))}, 'new file');
    // The host still owns the unchanged session's welcome context; this test
    // changes core roots directly to isolate the native tree and watcher.
    await tree.getByText('created-in-b.txt', { exact: true }).waitFor({ state: 'attached' });
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', false);
    await vscode.commands.executeCommand('setContext', 'ubovm.emptyFolder', false);
    await tree.getByText('created-in-b.txt', { exact: true }).waitFor();
    await vscode.commands.executeCommand('_ubovm.setExplorerWorkspace', '');
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', true);
    await page.getByText('尚未选择工作空间', { exact: true }).waitFor();
    assert.equal(await tree.getByText('only-project-b.txt', { exact: true }).count(), 0);
    await vscode.commands.executeCommand('setContext', 'ubovm.emptyFolder', true);
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', false);
    await page.getByText('文件夹还是空的', { exact: true }).waitFor();
    await assertCentered();
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', true);
    await page.getByText('尚未选择工作空间', { exact: true }).waitFor();
    assert.deepEqual((vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()), original);
    await assertCentered();
    await page.screenshot({ path: ${JSON.stringify(path.join(fixture, 'empty-workspace.png'))} });
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    const page = browser?.contexts()[0]?.pages().find(page => page.url().includes('workbench'));
    if (page) {
      await page.screenshot({ path: ${JSON.stringify(path.join(fixture, 'failure.png'))} }).catch(() => {});
      await fs.writeFile(${JSON.stringify(path.join(fixture, 'failure.txt'))}, await page.locator('body').innerText()).catch(() => {});
    }
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  } finally { await browser?.close(); }
};`);
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, HOME: home, UBOVM_DATA_PROFILE: 'smoke' });
  const child = spawn(path.resolve(root, config.core.runtime.directory, config.core.runtime.executable), ['--no-sandbox', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + entry, ...(emptyWindow ? [] : [workspace])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
