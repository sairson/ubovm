import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

// Run against the compiled source desktop, using an isolated profile seeded
// like the normal launcher. An empty settings file hides the startup regression.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = path.join(root, 'vendor/vscode');
const executablePath = process.env.UBOVM_TEST_ELECTRON || path.join(source, '.build/electron/Code - OSS.exe');
await fs.mkdir(path.join(root, '.cache'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, '.cache/theme-desktop-'));
const portable = path.join(fixture, '.ubovm/smoke');
const profile = path.join(portable, 'user-data');
const settingsFile = path.join(profile, 'User/settings.json');
await fs.mkdir(path.dirname(settingsFile), { recursive: true });
const { settings } = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
await fs.writeFile(settingsFile, JSON.stringify(settings));

async function launch() {
  return _electron.launch({
    executablePath,
    args: [source, '--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      `--user-data-dir=${profile}`, `--extensions-dir=${path.join(portable, 'extensions')}`,
      `--shared-data-dir=${path.join(portable, 'shared-data')}`,
      `--extensionDevelopmentPath=${path.join(root, 'src/renderer')}`],
    env: { ...process.env, VSCODE_DEV: '1', VSCODE_CLI: '1',
      USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke',
      UBOVM_HARNESS_ENTRY: path.join(root, 'src/harness/index.mjs') },
    timeout: 60000
  });
}

async function expectTheme(page, mode) {
  await page.waitForFunction(expected => {
    const workbench = document.querySelector('.monaco-workbench');
    return workbench?.classList.contains(`ubovm-ubovm-core-themes-ubovm-${expected}-json`);
  }, mode, { timeout: 45000 });
  const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(saved['workbench.colorTheme'], `UBOVM ${mode === 'light' ? 'Light' : 'Dark'}`);
}

let app;
try {
  app = await launch();
  let page = await app.firstWindow({ timeout: 60000 });
  await expectTheme(page, 'light');
  console.log('[OK] Seeded light setting is applied on first launch');
  for (const mode of ['dark', 'light', 'dark']) {
    await page.locator('.codicon-color-mode').click();
    await expectTheme(page, mode);
    console.log(`[OK] Title bar switches to ${mode} and saves the setting`);
  }
  await app.close();
  app = undefined;
  app = await launch();
  page = await app.firstWindow({ timeout: 60000 });
  await expectTheme(page, 'dark');
  console.log('[OK] Selected dark theme survives restart');
} finally {
  await app?.close();
  await fs.rm(fixture, { recursive: true, force: true });
}
