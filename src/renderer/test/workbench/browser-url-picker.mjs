import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

test('browser address bar edits inline instead of opening a URL quick pick', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`
    <div class="monaco-workbench vs-dark">
      <div class="browser-root">
        <div class="browser-navbar"><div class="browser-url-container">
          <div class="browser-url-display" contenteditable="plaintext-only" tabindex="0" data-placeholder="Search or enter URL"></div>
        </div></div>
      </div>
    </div>
  `);
  await page.addStyleTag({ path: path.join(root, 'src/renderer/workbench/workbench.css') });

  const field = await page.locator('.browser-url-display').evaluate(el => ({
    cursor: getComputedStyle(el).cursor,
    editable: el.getAttribute('contenteditable'),
    role: el.getAttribute('role') || 'textbox'
  }));
  assert.equal(field.cursor, 'text', 'address field advertises inline editing');
  assert.equal(field.editable, 'plaintext-only');

  const css = fs.readFileSync(path.join(root, 'src/renderer/workbench/workbench.css'), 'utf8');
  assert.doesNotMatch(css, /quick-input-widget:has\(\.quick-input-filter input\[placeholder\*="URL"/i,
    'the removed URL quick-pick overlay must not be styled back in');

  const series = JSON.parse(fs.readFileSync(path.join(root, 'resources/patches/series.json'), 'utf8'));
  assert.ok(series.patches.includes('browser-inline-url.patch'), 'inline URL patch is registered in the source series');
  const patch = fs.readFileSync(path.join(root, 'resources/patches/browser-inline-url.patch'), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1));
  assert.ok(added.some(line => line.includes('this.focusUrlInput();')), 'openUrlPicker focuses the inline field');
  assert.ok(!added.some(line => line.includes('_openPicker(')), 'no new picker promotion path is introduced');
  assert.ok(patch.includes('-		this._openPicker();'), 'the explicit picker open path is removed');
  assert.ok(patch.includes('-			const value = this._urlDisplay.textContent'), 'the click handler no longer promotes to the picker');
});
