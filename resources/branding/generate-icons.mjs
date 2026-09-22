import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../../', import.meta.url));
const media = path.join(root, 'src/renderer/media');
const mark = await fs.readFile(path.join(media, 'icon.svg'), 'utf8');
const app = mark.replace('fill="currentColor"', 'fill="#f4f7ed"').replace(/(<svg[^>]*>)/, '$1<rect width="64" height="64" rx="16" fill="#314c40"/><g transform="translate(8 8) scale(.75)">').replace('</svg>', '</g></svg>');
await fs.writeFile(path.join(media, 'app-icon.svg'), app);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent('<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh}</style>' + app);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    images.push(await page.screenshot({ omitBackground: true }));
  }
  await fs.writeFile(path.join(media, 'app-icon.png'), images.at(-1));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  await fs.writeFile(path.join(media, 'app-icon.ico'), Buffer.concat([header, ...images]));
  for (const size of [70, 150]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: path.join(media, `app-icon-${size}.png`), omitBackground: true });
  }
} finally { await browser.close(); }
console.log('UBOVM SVG, PNG and multi-resolution ICO generated.');
