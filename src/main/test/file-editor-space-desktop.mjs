import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

test('file editor temporarily occupies main space without losing dirty buffers or conversation', { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const fixture = await fs.mkdtemp(path.join(root, '.cache/file-space-'));
  const extension = path.join(fixture, 'probe'); await fs.mkdir(extension);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'file-space-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(extension, 'extension.cjs'), `
    const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
    exports.activate = async context => {
      try {
        await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
        await vscode.commands.executeCommand('ubovm.openWelcome');
        const original = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputWebview);
        const uri = vscode.Uri.file(path.join(__dirname, '../file.txt'));
        await fs.writeFile(uri.fsPath, 'original');
        const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Two, preview: false });
        await editor.edit(edit => edit.insert(new vscode.Position(0, 8), ' unsaved'));
        await new Promise(r => setTimeout(r, 400));
        let busy = false, previous = '';
        const timer = setInterval(async () => {
          if (busy) return;
          busy = true;
          try {
            const request = await fs.readFile(path.join(__dirname, '../request'), 'utf8').catch(() => '');
            if (!request || request === previous) return;
            previous = request;
            if (request.startsWith('conversation')) await vscode.commands.executeCommand('ubovm.openWelcome');
            if (request.startsWith('file')) await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.Two, preview: false });
            if (request.startsWith('close')) { await editor.document.save(); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); }
            await new Promise(r => setTimeout(r, 100));
            await fs.writeFile(path.join(__dirname, '../response.json'), JSON.stringify({ request,
              sameConversation: vscode.window.tabGroups.all.flatMap(g => g.tabs).includes(original),
              dirty: editor.document.isDirty, text: editor.document.getText(),
              groups: vscode.window.tabGroups.all.length,
              layout: await vscode.commands.executeCommand('vscode.getEditorLayout') }));
          } catch (e) { await fs.writeFile(path.join(__dirname, '../error'), String(e.stack)); }
          finally { busy = false; }
        }, 30);
        context.subscriptions.push({dispose: () => clearInterval(timer)});
        await fs.writeFile(path.join(__dirname, '../ready'), 'ready');
      } catch (e) { await fs.writeFile(path.join(__dirname, '../error'), String(e.stack)); }
    };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR'].includes(key)));
  const app = await _electron.launch({ executablePath: path.resolve(root, config.core.runtime.directory, config.core.runtime.executable),
    args: ['--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--extensionDevelopmentPath=${extension}`],
    env: { ...env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' }, timeout: 60000 });
  t.after(() => app.close());
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  async function poll(read) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const error = await fs.readFile(path.join(fixture, 'error'), 'utf8').catch(() => '');
      if (error) throw Error(error);
      const result = await read(); if (result) return result;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('Timed out waiting for desktop probe: ' + fixture);
  }
  await poll(() => fs.readFile(path.join(fixture, 'ready'), 'utf8').catch(() => ''));
  async function inspect(request) {
    await fs.writeFile(path.join(fixture, 'request'), request);
    return poll(async () => {
      const result = await fs.readFile(path.join(fixture, 'response.json'), 'utf8').then(JSON.parse).catch(() => null);
      return result?.request === request ? result : null;
    });
  }
  const expand = page.locator('.part.editor .editor-actions .codicon-screen-full');
  const restore = page.locator('.part.editor .editor-actions .codicon-screen-normal');
  const before = await inspect('before');
  assert.equal(before.groups, 2); assert.equal(before.dirty, true);
  try { await expand.click(); }
  catch (error) {
    await page.screenshot({ path: path.join(fixture, 'expand-failure.png') }).catch(() => {});
    await fs.writeFile(path.join(fixture, 'expand-failure-actions.json'), JSON.stringify(await page.locator('.part.editor .editor-actions').evaluateAll(elements => elements.map(element => ({ text: element.textContent, html: element.innerHTML }))), null, 2)).catch(() => {});
    throw error;
  }
  await restore.waitFor({ state: 'visible' });
  const expanded = await inspect('expanded');
  assert.equal(expanded.sameConversation, true); assert.equal(expanded.dirty, true);
  assert.equal(expanded.text, 'original unsaved');
  const area = await page.locator('[id="workbench.parts.editor"]').boundingBox();
  const file = await page.locator('.part.editor .editor-group-container:visible').last().boundingBox();
  assert.ok(file.width >= area.width - 5, 'File editor occupies the entire editor area');
  await page.screenshot({ path: path.join(fixture, 'expanded.png') });
  await restore.click(); await expand.waitFor({ state: 'visible' });
  const restored = await inspect('restored');
  const assertRestoredLayout = layout => {
    assert.equal(layout.orientation, before.layout.orientation);
    assert.equal(layout.groups.length, before.layout.groups.length);
    const total = layout.groups.reduce((sum, group) => sum + group.size, 0);
    const originalTotal = before.layout.groups.reduce((sum, group) => sum + group.size, 0);
    assert.ok(total > 0 && originalTotal > 0);
    for (let i = 0; i < layout.groups.length; i++) {
      assert.ok(Math.abs(layout.groups[i].size / total - before.layout.groups[i].size / originalTotal) < 0.005,
        'Restored editor proportions must survive workbench size changes');
    }
  };
  assertRestoredLayout(restored.layout); assert.equal(restored.dirty, true);
  await expand.click(); await restore.waitFor({ state: 'visible' });
  const conversation = await inspect('conversation');
  assert.equal(conversation.sameConversation, true);
  assertRestoredLayout(conversation.layout);
  await inspect('file'); await expand.click(); await restore.waitFor({ state: 'visible' });
  const closed = await inspect('close');
  assert.equal(closed.groups, 1); assert.equal(closed.sameConversation, true);
  assert.equal(await fs.readFile(path.join(fixture, 'file.txt'), 'utf8'), 'original unsaved');
});
