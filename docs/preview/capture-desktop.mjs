import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const images = path.join(root, 'docs/images');
const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
const executable = path.resolve(root, config.core.runtime.directory, config.core.runtime.executable);
const fixture = path.join(root, '.cache/readme-desktop');
const workspace = path.join(fixture, 'workspace');
const userData = path.join(fixture, 'user-data');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(images, { recursive: true });
await fs.writeFile(path.join(workspace, 'notes.md'), 'lab notes\n');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR'].includes(key)));
Object.assign(env, {
  USERPROFILE: fixture,
  HOME: fixture,
  UBOVM_DATA_PROFILE: 'smoke',
  UBOVM_HARNESS_ENTRY: path.join(root, 'src/harness/index.mjs')
});

const app = await _electron.launch({
  executablePath: executable,
  args: [
    '--no-sandbox',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    `--user-data-dir=${userData}`,
    workspace
  ],
  cwd: root,
  env,
  timeout: 120000
});

async function shot(page, name) {
  await page.screenshot({ path: path.join(images, name + '.png') });
  console.log('wrote', name + '.png');
}

async function dismiss(page) {
  for (const name of ['Never', '稍后配置']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.count()) await button.first().click({ timeout: 2000 }).catch(() => {});
  }
}

async function waitForAppText(page, pattern, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const frame of page.frames()) {
      const text = await frame.locator('body').innerText().catch(() => '');
      if (pattern.test(text)) return frame;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + pattern);
}

try {
  const page = await app.firstWindow({ timeout: 120000 });
  page.setDefaultTimeout(15000);
  const win = await app.browserWindow(page);
  await win.evaluate(window => { window.setBounds({ x: 40, y: 40, width: 1440, height: 900 }); window.show(); window.focus(); });

  try {
    await page.locator('#ubovm-startup').waitFor({ state: 'visible', timeout: 8000 });
    await shot(page, 'splash');
  } catch {
    await shot(page, 'splash');
  }

  await page.locator('.monaco-workbench').waitFor({ timeout: 120000 });
  await waitForAppText(page, /配置对话模型|今天，想完成什么？|定义一个值得完成的目标/).catch(() => {});
  await delay(800);
  await dismiss(page);
  await delay(400);
  await dismiss(page);

  const later = page.getByRole('button', { name: '稍后配置' });
  if (await later.count()) {
    await later.first().click();
    await delay(1500);
  }

  const assist = page.getByRole('button', { name: /^协助模式/ });
  if (await assist.count()) {
    await assist.first().click();
    await delay(1800);
  }
  await dismiss(page);
  await waitForAppText(page, /今天，想完成什么？/, 30000).catch(() => {});
  await delay(800);
  await shot(page, 'home');
  await shot(page, 'assist');

  const gear = page.locator('[aria-label="系统配置"], [title="系统配置"]');
  if (await gear.count()) await gear.last().click().catch(() => {});
  await waitForAppText(page, /配置对话模型|连接参数|服务商/, 20000).catch(() => {});
  await delay(600);
  await shot(page, 'setup');
  if (await later.count()) await later.first().click().catch(() => {});
  await delay(800);

  const explore = page.getByRole('button', { name: /^探索模式/ });
  if (await explore.count()) {
    await explore.first().click();
    await delay(2000);
  }
  await dismiss(page);
  await waitForAppText(page, /定义一个值得完成的目标|探索工作台/, 20000).catch(() => {});
  await delay(600);
  await shot(page, 'explore');
} finally {
  await app.close();
}
