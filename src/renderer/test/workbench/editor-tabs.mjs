import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

function tab(name, { active = false, browser = false } = {}) {
  return `
    <div class="tab${active ? ' active selected' : ''} has-icon" role="tab" style="width:${browser ? 168 : 148}px">
      <div class="tab-fill"></div>
      <div class="tab-border-top-container"></div>
      <div class="tab-label monaco-icon-label">
        <div class="monaco-icon-label-container"><div class="monaco-icon-name-container">
          <a class="label-name">${name}</a>
        </div></div>
      </div>
      <div class="tab-actions"><div class="monaco-action-bar"><ul class="actions-container">
        <li class="action-item"><a class="action-label codicon codicon-close"></a></li>
      </ul></div></div>
    </div>`;
}

test('file and browser editor tabs share compact chips instead of native rectangles', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 920, height: 220 } });
  await mkdir('.cache', { recursive: true });
  await page.setContent(`
    <div class="monaco-workbench modern-ui-tabs vs" style="
      --vscode-editor-background:#ffffff;
      --vscode-foreground:#303a34;
      --vscode-focusBorder:#3d7a55;
      --vscode-tab-activeBackground:#ffffff;
      --vscode-modernEditorTab-activeBackground:#ffffff;
      --vscode-modernEditorTab-inactiveBackground:#00000000;
      --vscode-modernEditorTab-activeForeground:#1a1a1a;
      --vscode-modernEditorTab-hoverBackground:#00000012;
      --vscode-fontSize-body1:13px;
      --vscode-cornerRadius-small:2px;
      --vscode-spacing-size20:2px;
      --vscode-spacing-size40:4px;
      font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;
    ">
      <div class="part editor">
        <div class="content">
          <div class="editor-group-container active">
            <div class="title tabs">
              <div class="tabs-and-actions-container">
                <div class="monaco-scrollable-element">
                  <div class="tabs-container" role="tablist">
                    ${tab('workbench.css', { active: true })}
                    ${tab('example.com', { browser: true })}
                    ${tab('README.md')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);
  for (const path of [
    'vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css',
    'vendor/vscode/src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css',
    'vendor/vscode/src/vs/workbench/contrib/modernUI/browser/media/tabs.css',
    'src/renderer/workbench/workbench.css',
  ]) await page.addStyleTag({ path });
  await page.addStyleTag({ content: '.codicon-close::before{content:"\\00d7";font-size:14px;line-height:16px}' });

  const report = await page.locator('.tab').evaluateAll(items => items.map(item => {
    const fill = getComputedStyle(item.querySelector('.tab-fill'));
    const label = getComputedStyle(item.querySelector('.label-name'));
    const close = getComputedStyle(item.querySelector('.codicon-close'));
    const top = getComputedStyle(item.querySelector('.tab-border-top-container'));
    return {
      tabBg: getComputedStyle(item).backgroundColor,
      fill: fill.backgroundColor,
      radius: fill.borderRadius,
      inset: fill.inset,
      shadow: fill.boxShadow,
      font: label.fontSize,
      weight: Number.parseInt(label.fontWeight, 10),
      closeOpacity: close.opacity,
      topDisplay: top.display,
    };
  }));

  assert.equal(report[0].font, '12px');
  assert.ok(report[0].weight >= 600);
  assert.equal(report[2].font, '12px');
  assert.ok(report[2].weight < 600);
  assert.equal(report[0].radius, '3px');
  assert.equal(report[0].tabBg, 'rgba(0, 0, 0, 0)');
  assert.notEqual(report[0].fill, 'rgb(255, 255, 255)');
  assert.notEqual(report[0].fill, 'rgba(0, 0, 0, 0)');
  assert.notEqual(report[2].fill, 'rgba(0, 0, 0, 0)');
  assert.notEqual(report[0].fill, report[2].fill);
  assert.match(report[0].shadow, /inset/);
  assert.equal(report[2].shadow, 'none');
  assert.equal(report[0].closeOpacity, '0.82');
  assert.equal(report[2].closeOpacity, '0');
  assert.equal(report[0].topDisplay, 'none');

  const strip = await page.locator('.title.tabs').evaluate(el => {
    const style = getComputedStyle(el);
    return {
      heightToken: style.getPropertyValue('--editor-group-tab-height').trim(),
      border: style.borderBottomStyle,
      paddingLeft: style.paddingLeft,
    };
  });
  assert.equal(strip.heightToken, '24px');
  assert.equal(strip.border, 'solid');
  assert.equal(strip.paddingLeft, '6px');

  await page.screenshot({ path: '.cache/editor-tabs.png' });
});
