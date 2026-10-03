import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright-core';
import { normalizeLaunchArguments } from '../launch-policy.mjs';
import { installWindowFocusRestore } from '../background.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
const executable = path.resolve(root, config.core.runtime.directory, config.core.runtime.executable);
const fixture = await fs.mkdtemp(path.join(root, '.cache/launch-desktop-'));
const env = { ...process.env, USERPROFILE: fixture, HOME: fixture, UBOVM_DATA_PROFILE: 'smoke' };
delete env.ELECTRON_RUN_AS_NODE;
const base = ['--no-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'];
const args = extra => normalizeLaunchArguments([executable, ...base, ...extra]).slice(1);
const children = new Set();
let desktop;
async function launch(extra = []) {
  const child = spawn(executable, args(extra), { env, windowsHide: true, stdio: 'ignore' });
  children.add(child);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Secondary launch did not exit')); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Secondary exit: ' + code)); });
    });
  } finally { children.delete(child); }
}
async function windows() {
  return desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter(window => /\/(?:workbench|sessions)(?:-dev)?\.html(?:[?#]|$)/.test(window.webContents.getURL()))
    .map(window => ({ id: window.id, visible: window.isVisible() })));
}
try {
  desktop = await _electron.launch({ executablePath: executable, args: args([]), env, timeout: 60000 });
  const page = await desktop.firstWindow({ timeout: 60000 });
  await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
  const original = await windows(); assert.equal(original.length, 1);
  // The downloaded runtime may predate the source change. Exercise the source
  // focus adapter against its real native window without modifying that runtime.
  await desktop.evaluate(({ BrowserWindow }, source) => {
    const install = (0, eval)('(' + source + ')');
    for (const window of BrowserWindow.getAllWindows()) install(window);
  }, installWindowFocusRestore.toString());
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
  await Promise.all(Array.from({ length: 4 }, () => launch()));
  const restored = await windows();
  assert.equal(restored.length, 1); assert.equal(restored[0].id, original[0].id); assert.equal(restored[0].visible, true);
  await launch(['--new-window']);
  const deadline = Date.now() + 30000;
  while ((await windows()).length !== 2) { assert(Date.now() < deadline, 'Explicit new window was not opened'); await delay(100); }
  console.log('PASS: four concurrent launches reuse and reveal the original window; explicit new-window remains available.');
} finally {
  for (const child of children) child.kill();
  await desktop?.close();
}
