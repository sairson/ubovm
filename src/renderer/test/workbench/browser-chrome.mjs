import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const styles = [
  'vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css',
  'vendor/vscode/src/vs/workbench/contrib/browserView/electron-browser/media/browser.css',
  'src/renderer/workbench/workbench.css',
];

test('integrated browser chrome keeps toolbar actions and a taller address bar', async t => {
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
              <div class="browser-url-display" data-placeholder="Search or enter URL"></div>
              <div class="browser-url-bar-widgets">
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
    };
  });
  assert.ok(url.height >= 32, `address bar height ${url.height}`);
  assert.equal(url.radius, '4px');
  assert.equal(url.padding, '6px');

  const share = await page.locator('.browser-share-toggle.checked').evaluate(el => {
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, color: style.backgroundColor };
  });
  assert.equal(share.image, 'none');
  assert.notEqual(share.color, 'rgba(0, 0, 0, 0)');

  const welcome = await page.locator('.browser-welcome-icon').evaluate(el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { width: Math.round(box.width), height: Math.round(box.height), radius: style.borderRadius };
  });
  assert.equal(welcome.width, 52);
  assert.equal(welcome.height, 52);
  assert.equal(welcome.radius, '6px');

  const title = await page.locator('.browser-welcome-title').evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(title, '16px');

  const border = await page.locator('.browser-container.shared').evaluate(el =>
    getComputedStyle(el, '::before').backgroundImage
  );
  assert.equal(border, 'none');

  await page.screenshot({ path: '.cache/browser-chrome.png' });
});
