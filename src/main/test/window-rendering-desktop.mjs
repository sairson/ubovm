import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';

async function eventually(check) {
  const end = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < end, 'native window state did not settle');
    await delay(50);
  }
}

const root = path.resolve(import.meta.dirname, '../../..');
const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
const runtime = path.resolve(root, config.core.runtime.directory);
const fixture = await fs.mkdtemp(path.join(root, '.cache/background-desktop-'));
const portable = path.join(fixture, '.ubovm/smoke');
let desktop;
const env = { ...process.env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' };
delete env.ELECTRON_RUN_AS_NODE;
try {
  desktop = await _electron.launch({
    executablePath: path.join(runtime, config.core.runtime.executable),
    args: ['--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      `--user-data-dir=${path.join(portable, 'user-data')}`,
      `--extensions-dir=${path.join(portable, 'extensions')}`],
    env,
    timeout: 60000
  });
  const page = await desktop.firstWindow({ timeout: 60000 });
  await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
  const win = await desktop.browserWindow(page);
  await delay(2000);
  const originalThrottling = await win.evaluate(window => window.webContents.getBackgroundThrottling());
  await page.evaluate(() => { globalThis.restorationIdentity = { draft: 'unsaved restoration sentinel' }; });
  await win.evaluate(window => {
    const invalidate = window.webContents.invalidate.bind(window.webContents);
    globalThis.restorationPaints = 0;
    window.webContents.invalidate = () => { globalThis.restorationPaints++; invalidate(); };
  });
  for (let cycle = 0; cycle < 12; cycle++) {
    await win.evaluate(window => window.minimize());
    await delay(50);
    await win.evaluate(window => { window.restore(); window.show(); window.focus(); });
    await desktop.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); powerMonitor.emit('unlock-screen'); });
    await delay(350);
    assert.equal(await page.evaluate(() => globalThis.restorationIdentity?.draft), 'unsaved restoration sentinel');
    const pixels = await win.evaluate(window => {
      return window.webContents.capturePage().then(image => {
        const bitmap = image.toBitmap(); let colored = 0;
        for (let offset = 0; offset < bitmap.length; offset += 4) {
          if (Math.min(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) < 220) colored++;
        }
        return { colored, total: bitmap.length / 4 };
      });
    });
    if (cycle === 0) await page.screenshot({ path: path.join(root, '.cache/window-restoration.png') });
    assert(pixels.colored / pixels.total > 0.001, `restored native surface must contain visible IDE content: cycle=${cycle}, ${JSON.stringify(pixels)}`);
  }
  assert(await desktop.evaluate(() => globalThis.restorationPaints) >= 24);
  // Observe the real tray without adding test-only hooks to production code.
  await desktop.evaluate(({ Tray, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 }); // This fixture explicitly chooses background.
    const setMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.backgroundTestTray = this;
      globalThis.backgroundTestMenu = menu;
      return setMenu.call(this, menu);
    };
    globalThis.backgroundTestHints = [];
    // Do not show test notifications on the developer's desktop.
    Tray.prototype.displayBalloon = function (options) { globalThis.backgroundTestHints.push(options); };
  });
  await win.evaluate(window => window.minimize());
  await eventually(() => win.evaluate(window => window.isMinimized() && !window.webContents.getBackgroundThrottling()));
  assert.equal(await win.evaluate(window => window.webContents.getBackgroundThrottling()), false);
  assert.match(await desktop.evaluate(() => globalThis.backgroundTestMenu.items[0].label), /后台运行中/);
  await desktop.evaluate(() => globalThis.backgroundTestTray.emit('click'));
  await eventually(() => win.evaluate(window => !window.isMinimized() && window.isVisible()));
  assert.equal(await win.evaluate(window => window.isMinimized()), false);
  assert.equal(await win.evaluate(window => window.webContents.getBackgroundThrottling()), originalThrottling);
  await page.evaluate(() => {
    globalThis.backgroundTestTicks = 0;
    globalThis.backgroundTestTimer = setInterval(() => globalThis.backgroundTestTicks++, 50);
  });
  // A real native close must be intercepted before Code OSS unloads anything.
  await win.evaluate(window => { window.close(); });
  assert.equal(await win.evaluate(window => window.isDestroyed()), false);
  assert.equal(await win.evaluate(window => window.isVisible()), false);
  const ticks = await page.evaluate(() => globalThis.backgroundTestTicks);
  await page.waitForTimeout(600);
  assert.ok(await page.evaluate(() => globalThis.backgroundTestTicks) > ticks + 2, 'renderer timers continue while hidden');
  assert.equal(await page.locator('.monaco-workbench').count(), 1);
  assert.equal(await desktop.evaluate(() => globalThis.backgroundTestHints.length), 1);
  assert.equal(await desktop.evaluate(() => globalThis.backgroundTestHints[0].noSound), true);
  await desktop.evaluate(() => globalThis.backgroundTestTray.emit('balloon-click'));
  assert.equal(await win.evaluate(window => window.isVisible()), true);
  assert.equal(await win.evaluate(window => window.webContents.getBackgroundThrottling()), originalThrottling);
  await desktop.evaluate(() => globalThis.backgroundTestMenu.items.find(item => item.label === '后台运行').click());
  assert.equal(await win.evaluate(window => window.isVisible()), false);
  assert.equal(await desktop.evaluate(() => globalThis.backgroundTestHints.length), 1);
  await desktop.evaluate(() => globalThis.backgroundTestTray.emit('click'));
  await page.evaluate(() => clearInterval(globalThis.backgroundTestTimer));
  // Explicit quit must finish instead of hiding the window again.
  await desktop.close(); desktop = undefined;
  console.log('[OK] Real desktop: 12 minimize/restore/wake/unlock cycles preserve page identity and visible native pixels; background lifecycle succeeds');
} finally {
  await desktop?.close();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
