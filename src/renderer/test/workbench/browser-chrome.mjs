import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const styles = [
  'vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css',
  'vendor/vscode/src/vs/workbench/contrib/browserView/electron-browser/media/browser.css',
  'src/renderer/workbench/workbench.css',
];

test('integrated browser chrome keeps DSH toolbar metrics, actions and address field', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 980, height: 640 } });
  await mkdir('.cache', { recursive: true });
  await page.setContent(`
    <div class="monaco-workbench vs" style="
      --vscode-editor-background:#f7f8f5;
      --vscode-foreground:#303a34;
      --vscode-input-background:#ffffff;
      --vscode-input-foreground:#303a34;
      --vscode-input-border:#d5dbd4;
      --vscode-input-placeholderForeground:#6f776c;
      --vscode-focusBorder:#3d7a55;
      --vscode-widget-border:#d9dedb;
      --vscode-descriptionForeground:#5c645e;
      --vscode-errorForeground:#b42318;
      --vscode-statusBarItem-errorBackground:#b42318;
      --vscode-statusBarItem-errorForeground:#fff;
      --vscode-cornerRadius-medium:4px;
      --vscode-cornerRadius-small:2px;
      font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;
    ">
      <div class="part editor">
        <div class="monaco-toolbar chrome-toolbar">
          <ul class="actions-container">
            <li class="action-item"><a class="action-label codicon codicon-settings-gear"></a></li>
            <li class="action-item"><a class="action-label codicon codicon-toolbar-more"></a></li>
          </ul>
        </div>
        <div class="browser-root">
          <div class="browser-navbar">
            <div class="browser-nav-toolbar">
              <div class="monaco-toolbar">
                <div class="monaco-action-bar">
                <ul class="actions-container">
                  <li class="action-item"><a class="action-label"></a></li>
                  <li class="action-item"><a class="action-label codicon codicon-settings-gear"></a></li>
                  <li class="action-item"><a class="action-label codicon codicon-toolbar-more"></a></li>
                </ul>
                </div>
              </div>
            </div>
            <div class="browser-url-container">
              <div class="browser-url-display" data-placeholder="Search or enter URL" tabindex="0"></div>
              <div class="browser-url-bar-widgets">
                <button class="browser-favorite-indicator" title="Favorite">★</button>
                <button class="browser-share-toggle checked">Share</button>
              </div>
            </div>
          </div>
          <div class="browser-container-wrapper" style="height:480px">
            <div class="browser-container shared" style="inset:12px;width:auto;height:auto">
              <div class="browser-welcome-container">
                <div class="browser-welcome-content">
                  <div class="browser-welcome-icon"><span class="codicon"></span></div>
                  <div class="browser-welcome-title">Browser</div>
                  <div class="browser-welcome-subtitle">Enter a URL above to get started.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);
  for (const path of styles) await page.addStyleTag({ path });

  const hidden = await page.locator('.chrome-toolbar .action-item').evaluateAll(items =>
    items.map(item => getComputedStyle(item).display)
  );
  assert.deepEqual(hidden, ['none', 'none']);

  const browserToolbar = await page.locator('.browser-nav-toolbar .action-item').evaluateAll(items =>
    items.map(item => getComputedStyle(item).display)
  );
  assert.ok(browserToolbar.every(display => display !== 'none'));
  assert.equal(browserToolbar[1], 'flex');
  assert.equal(browserToolbar[2], 'flex');

  const url = await page.locator('.browser-url-container').evaluate(el => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      height: Math.round(box.height),
      radius: style.borderRadius,
      padding: getComputedStyle(el.querySelector('.browser-url-display')).paddingTop,
      fontSize: getComputedStyle(el.querySelector('.browser-url-display')).fontSize,
    };
  });
  assert.ok(url.height >= 28 && url.height <= 30, `address bar height ${url.height}`);
  assert.equal(url.radius, '8px');
  assert.equal(url.padding, '3px');
  assert.equal(url.fontSize, '12px');

  const tool = await page.locator('.browser-nav-toolbar .action-item .action-label').first().evaluate(el => {
    const box = el.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height), radius: getComputedStyle(el).borderRadius };
  });
  assert.deepEqual(tool, { width: 28, height: 28, radius: '8px' });
  const navbarHeight = await page.locator('.browser-navbar').evaluate(el => Math.round(el.getBoundingClientRect().height));
  assert.equal(navbarHeight, 38);

  const focus = await page.locator('.browser-url-display').evaluate(el => {
    el.focus();
    const style = getComputedStyle(el.closest('.browser-url-container'));
    return { width: style.outlineWidth, color: style.outlineColor };
  });
  assert.equal(focus.width, '1px');
  assert.notEqual(focus.color, 'rgba(0, 0, 0, 0)');
  await page.evaluate(() => document.activeElement?.blur());

  const share = await page.locator('.browser-share-toggle.checked').evaluate(el => {
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, color: style.backgroundColor };
  });
  assert.equal(share.image, 'none');
  assert.notEqual(share.color, 'rgba(0, 0, 0, 0)');

  assert.equal(await page.locator('.browser-favorite-indicator').evaluate(el => getComputedStyle(el).display), 'none');
  await page.locator('.browser-url-container').hover();
  assert.notEqual(await page.locator('.browser-favorite-indicator').evaluate(el => getComputedStyle(el).display), 'none');
  await page.mouse.move(0, 0);

  const welcome = await page.locator('.browser-welcome-icon').evaluate(el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { width: Math.round(box.width), height: Math.round(box.height), radius: style.borderRadius };
  });
  assert.equal(welcome.width, 40);
  assert.equal(welcome.height, 40);
  assert.equal(welcome.radius, '8px');

  const title = await page.locator('.browser-welcome-title').evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(title, '13px');

  const border = await page.locator('.browser-container.shared').evaluate(el => {
    const style = getComputedStyle(el, '::before');
    return { image: style.backgroundImage, color: style.backgroundColor };
  });
  assert.equal(border.image, 'none');
  assert.notEqual(border.color, 'rgba(0, 0, 0, 0)');

  await page.screenshot({ path: '.cache/browser-chrome.png' });

  await page.setViewportSize({ width: 600, height: 640 });
  const narrow = await page.evaluate(() => {
    const nav = document.querySelector('.browser-navbar').getBoundingClientRect();
    const url = document.querySelector('.browser-url-container').getBoundingClientRect();
    const tool = document.querySelector('.browser-nav-toolbar .action-label').getBoundingClientRect();
    return { nav: { height: Math.round(nav.height) }, url: { width: Math.round(url.width), height: Math.round(url.height) }, tool: { width: Math.round(tool.width) }, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.equal(narrow.nav.height, 38);
  assert.equal(narrow.url.height, 28);
  assert.ok(narrow.url.width > 120, `narrow address width ${narrow.url.width}`);
  assert.equal(narrow.tool.width, 26);
  assert.ok(narrow.scrollWidth <= 601, `narrow page overflows: ${narrow.scrollWidth}`);
  await page.screenshot({ path: '.cache/browser-chrome-narrow.png' });

  await page.setViewportSize({ width: 320, height: 640 });
  const tiny = await page.evaluate(() => ({
    nav: Math.round(document.querySelector('.browser-navbar').getBoundingClientRect().height),
    url: Math.round(document.querySelector('.browser-url-container').getBoundingClientRect().width),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(tiny.nav, 38);
  assert.ok(tiny.url > 80, `320px address width ${tiny.url}`);
  assert.ok(tiny.scrollWidth <= 321, `320px page overflows: ${tiny.scrollWidth}`);
});
