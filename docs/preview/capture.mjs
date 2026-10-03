import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const images = path.join(root, 'docs/images');
const gallery = path.join(root, 'docs/preview/gallery.html');
const mark = await fs.readFile(path.join(root, 'src/renderer/media/icon.svg'), 'utf8');
const app = await fs.readFile(path.join(root, 'src/renderer/media/app-icon.svg'), 'utf8');
await fs.mkdir(images, { recursive: true });
await fs.writeFile(path.join(images, 'mark.svg'), mark);
await fs.writeFile(path.join(images, 'logo.svg'), app);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width: 256, height: 256 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${app}`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(images, 'logo.png'), omitBackground: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(gallery).href, { waitUntil: 'load' });
  const shots = ['splash', 'home', 'assist', 'explore', 'setup'];
  for (const id of shots) {
    const el = page.locator('#' + id);
    await el.scrollIntoViewIfNeeded();
    await el.screenshot({ path: path.join(images, id + '.png') });
  }
} finally {
  await browser.close();
}
console.log('Wrote docs/images logos and interface shots.');
