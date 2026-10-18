import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

test('browser URL quick pick stays inside the browser column', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`
    <div class="monaco-workbench vs-dark">
      <div class="quick-input-widget" style="position:absolute;top:60px;left:40px;width:700px">
        <div class="quick-input-filter"><div class="monaco-inputbox"><input placeholder="Search or enter URL"></div></div>
        <div class="quick-input-list"><div class="monaco-list-row">Suggestion</div></div>
      </div>
    </div>
  `);
  await page.addStyleTag({ path: 'src/renderer/workbench/workbench.css' });

  const wide = await page.locator('.quick-input-widget').evaluate(el => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { width: Math.round(box.width), right: style.right, left: Math.round(box.left), radius: style.borderRadius };
  });
  assert.equal(wide.width, 380);
  assert.equal(wide.right, '18px');
  assert.equal(wide.radius, '12px');

  await page.setViewportSize({ width: 600, height: 700 });
  const narrow = await page.locator('.quick-input-widget').evaluate(el => {
    const style = getComputedStyle(el);
    return { width: Math.round(el.getBoundingClientRect().width), right: style.right };
  });
  assert.equal(narrow.width, 320);
  assert.equal(narrow.right, '12px');
});
