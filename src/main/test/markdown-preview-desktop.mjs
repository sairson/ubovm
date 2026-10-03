import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright-core';

test('Markdown editor exposes preview and renders unsaved changes', { timeout: 90000 }, async t => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const fixture = await fs.mkdtemp(path.join(root, '.cache/markdown-preview-'));
  const extension = path.join(fixture, 'probe'); await fs.mkdir(extension);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'markdown-preview-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(extension, 'extension.cjs'), `
    const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
    exports.activate = async () => {
      try {
        await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
        await vscode.commands.executeCommand('ubovm.openWelcome');
        const uri = vscode.Uri.file(path.join(__dirname, '../preview.md'));
        await fs.writeFile(uri.fsPath, '# Markdown preview\\n');
        const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Two, preview: false });
        await editor.edit(edit => edit.insert(new vscode.Position(1, 0), '\\nUnsaved preview content'));
        await fs.writeFile(path.join(__dirname, '../ready'), 'ready');
      } catch (e) { await fs.writeFile(path.join(__dirname, '../error'), String(e.stack)); }
    };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR'].includes(key)));
  const app = await _electron.launch({ executablePath: path.resolve(root, config.core.runtime.directory, config.core.runtime.executable), args: ['--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--extensionDevelopmentPath=${extension}`], env: { ...env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' }, timeout: 60000 });
  t.after(() => app.close());
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  for (let n = 0; ; n++) {
    const error = await fs.readFile(path.join(fixture, 'error'), 'utf8').catch(() => '');
    if (error) throw Error(error);
    if (await fs.readFile(path.join(fixture, 'ready'), 'utf8').catch(() => '')) break;
    assert.ok(n < 200, 'probe startup timeout');
    await new Promise(r => setTimeout(r, 100));
  }
  await page.screenshot({ path: path.join(fixture, 'before.png') });
  const preview = page.locator('.part.editor .codicon-open-preview').last();
  await preview.click();
  await page.waitForFunction(() => document.querySelectorAll('.webview').length >= 2);
  let rendered = false;
  for (let n = 0; n < 100 && !rendered; n++) {
    for (const frame of page.frames()) {
      if (await frame.locator('h1').filter({ hasText: 'Markdown preview' }).count()) {
        rendered = (await frame.locator('body').innerText()).includes('Unsaved preview content');
      }
    }
    if (!rendered) await new Promise(r => setTimeout(r, 100));
  }
  await page.screenshot({ path: path.join(fixture, 'preview.png') });
  assert.equal(rendered, true, 'native preview renders unsaved Markdown');
  assert.equal(await fs.readFile(path.join(fixture, 'preview.md'), 'utf8'), '# Markdown preview\n');
});
