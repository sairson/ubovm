import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

test('native file tab drag attaches to the composer instead of opening an editor', { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const fixture = await fs.mkdtemp(path.join(root, '.cache/composer-drop-'));
  const extension = path.join(fixture, 'probe'); await fs.mkdir(extension);
  await fs.writeFile(path.join(fixture, 'drag-context.txt'), 'Attached through a native file drag.');
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'composer-drop-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(extension, 'extension.cjs'), `
    const vscode = require('vscode'), path = require('node:path');
    exports.activate = async () => {
      await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
      await vscode.commands.executeCommand('ubovm.openWelcome');
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(__dirname, '../drag-context.txt')), { viewColumn: vscode.ViewColumn.Two, preview: false });
    };
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR'].includes(key)));
  const app = await _electron.launch({ executablePath: path.resolve(root, config.core.runtime.directory, config.core.runtime.executable),
    args: ['--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--extensionDevelopmentPath=${extension}`],
    env: { ...env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' }, timeout: 60000 });
  t.after(() => app.close());
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const tab = page.locator('.tab').filter({ hasText: 'drag-context.txt' }).first();
  await tab.waitFor({ state: 'visible' });
  let frame;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const candidate of page.frames()) {
      if (await candidate.locator('#prompt-input').isVisible().catch(() => false)) { frame = candidate; break; }
    }
    if (frame) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(frame, 'conversation composer is visible');
  await frame.locator('#attach-file').waitFor({ state: 'visible' });
  await frame.waitForFunction(() => !document.getElementById('attach-file').disabled);
  await frame.locator('#prompt-input').fill('Keep this draft');
  const before = await page.locator('.tab').count();
  const source = await tab.boundingBox(), target = await frame.locator('#prompt-input').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 - 15, source.y + source.height / 2 + 15, { steps: 5 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await frame.waitForFunction(() => !document.getElementById('composer-file').hidden && document.getElementById('composer-file').title.includes('drag-context.txt'));
  assert.equal(await frame.locator('#prompt-input').inputValue(), 'Keep this draft');
  assert.equal(await page.locator('.tab').count(), before);
  await page.screenshot({ path: path.join(fixture, 'attached.png') });
});
