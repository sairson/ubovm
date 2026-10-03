import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const patch = await readFile(new URL('../../../../resources/patches/sidebar-size.patch', import.meta.url), 'utf8');
const repair = new Function('width', 'LayoutStateKeys', patch.split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n'));
for (const [width, saved, expected] of [
  [1933, [1177, 283], [300, 283]],
  [1933, [320, 280], [320, 280]],
  [900, [700, 600], [225, 225]],
  [1933, [NaN, -1], [300, 300]],
]) {
  const values = [...saved];
  repair.call({ stateModel: {
    getInitializationValue: key => values[key],
    setInitializationValue: (key, value) => { values[key] = value; },
  } }, width, { SIDEBAR_SIZE: 0, AUXILIARYBAR_SIZE: 1 });
  assert.deepEqual(values, expected);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1933, height: 1033 } });
  const native = await readFile(new URL('../../../../vendor/vscode/src/vs/workbench/browser/parts/views/media/views.css', import.meta.url), 'utf8');
  const custom = await readFile(new URL('../../workbench/workbench.css', import.meta.url), 'utf8');
  // Exercise native wide-mode specificity, including when native CSS loads last.
  for (const css of [native + custom, custom + native]) {
    await page.setContent(`<style>${css}</style><div class="monaco-workbench"><div class="part sidebar" style="width:1177px"><div class="pane"><div class="pane-body"><div class="welcome-view-content wide"><p><span class="codicon codicon-folder"></span></p><p>Empty folder</p><p>Create your first file</p><div class="button-container"><a class="monaco-button" style="display:block;width:100%">Create</a></div></div></div></div></div></div>`);
    const area = await page.locator('.welcome-view-content').boundingBox();
    const button = await page.locator('.monaco-button').boundingBox();
    assert.ok(Math.abs(button.x + button.width / 2 - area.x - area.width / 2) < 1);
    assert.ok(button.width <= 230);
  }
  console.log('PASS: oversized saved sidebar recovery and native wide-mode button alignment');
} finally {
  await browser.close();
}
