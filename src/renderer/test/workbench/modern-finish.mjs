import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const cssPath = new URL('../../workbench/workbench.css', import.meta.url);

const markup = `
  <div class="monaco-workbench vs">
    <div class="part titlebar"><div class="titlebar-container"><div class="titlebar-center"><span class="window-title">UBOVM</span></div></div></div>
    <div class="part sidebar">
      <div class="title"><h2>文件</h2></div>
      <div class="pane-body ubovm-sessions-body">
        <div class="ubovm-sidebar-modes"><button type="button" data-mode="assist" aria-pressed="true">Assist</button><button type="button" data-mode="goal" aria-pressed="false">Explore</button></div>
        <div class="ubovm-session-tree"><div class="monaco-list">
          <div class="monaco-list-row" aria-label="测试，当前会话"><div class="monaco-tl-row"><span class="custom-view-tree-node-item-icon codicon codicon-circle-filled"></span><span class="label-name">当前会话</span></div></div>
        </div></div>
      </div>
      <div class="ubovm-sidebar-management"><button type="button">MCP</button></div>
    </div>
    <div class="part auxiliarybar" style="width:300px">
      <div class="composite has-composite-bar header-or-footer header"><div class="composite-bar-container"><div class="composite-bar"></div></div></div>
      <div class="title"><div class="title-label"><h2>项目与会话</h2></div><div class="title-actions"><div class="monaco-toolbar"><div class="monaco-action-bar"><ul class="actions-container">
        <li class="action-item"><a class="action-label codicon codicon-folder-opened"></a></li>
        <li class="action-item"><a class="action-label codicon codicon-new-folder"></a></li>
        <li class="action-item"><a class="action-label codicon codicon-search"></a></li>
        <li class="action-item"><a class="action-label codicon codicon-chevron-left"></a></li>
        <li class="action-item separator disabled"><a class="action-label separator disabled"></a></li>
      </ul></div></div></div></div>
      <div class="pane-body ubovm-sessions-body"><div class="ubovm-session-tree"><div class="monaco-list"><div class="monaco-list-row" aria-label="测试，当前会话"><div class="monaco-tl-row"></div></div></div></div></div>
    </div>
    <div class="part editor"><div class="content"><div class="editor-group-container">
      <div class="title tabs"><div class="tabs-and-actions-container"><div class="tabs-container">
        <div class="tab active"><div class="tab-fill"></div></div>
        <div class="tab"><div class="tab-fill"></div></div>
      </div></div></div>
    </div></div></div>
    <div class="part panel"><div class="title"></div></div>
    <div class="part statusbar"></div>
    <div class="quick-input-widget"></div>
    <div class="monaco-dialog-box"></div>
  </div>`;

const themeVars = {
  '--vscode-foreground': '#d4d4d4',
  '--vscode-editor-background': '#1b1b1c',
  '--vscode-sideBar-background': '#232324',
  '--vscode-sideBar-border': '#353638',
  '--vscode-widget-border': '#353638',
  '--vscode-list-activeSelectionBackground': '#3a4f43',
  '--vscode-list-activeSelectionForeground': '#f0f6f2',
  '--vscode-list-inactiveSelectionBackground': '#314339',
  '--vscode-list-hoverBackground': '#2c352f',
  '--vscode-focusBorder': '#a3c0ae'
};

async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
  await page.setContent(markup);
  await page.addStyleTag({ path: 'src/renderer/workbench/workbench.css' });
  return page;
}

async function applyTheme(page, dark) {
  await page.evaluate(({ dark, vars }) => {
    const workbench = document.querySelector('.monaco-workbench');
    workbench.classList.toggle('vs-dark', dark);
    workbench.classList.toggle('vs', !dark);
    for (const [key, value] of Object.entries(vars)) workbench.style.setProperty(key, value);
    if (!dark) workbench.style.setProperty('--vscode-editor-background', '#ffffff');
  }, { dark, vars: themeVars });
}

test('modern finish uses crisp strokes and quiet elevation, never gloss', async t => {
  const page = await fixture(t);
  for (const dark of [false, true]) {
    await applyTheme(page, dark);
    const report = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      return {
        titlebar: style('.part.titlebar'),
        titlebarImage: style('.part.titlebar').backgroundImage,
        sidebar: style('.part.sidebar'),
        sidebarImage: style('.part.sidebar').backgroundImage,
        title: style('.part.sidebar > .title'),
        auxTitle: style('.part.auxiliarybar > .title'),
        auxBar: style('.part.auxiliarybar > .composite.has-composite-bar'),
        auxLabel: style('.part.auxiliarybar > .title .title-label'),
        auxHeading: style('.part.auxiliarybar > .title .title-label h2'),
        auxAction: style('.part.auxiliarybar > .title .title-actions .action-label'),
        modes: style('.ubovm-sidebar-modes'),
        activeMode: style('.ubovm-sidebar-modes button[aria-pressed="true"]'),
        selectedRow: style('.ubovm-session-tree .monaco-list-row[aria-label] .monaco-tl-row'),
        selectedToken: getComputedStyle(document.querySelector('.ubovm-sessions-body')).getPropertyValue('--ubovm-nav-selected').trim(),
        tabs: style('.part.editor > .content .editor-group-container > .title.tabs'),
        activeFill: style('.tabs-container > .tab.active > .tab-fill'),
        activeFillGloss: getComputedStyle(document.querySelector('.tabs-container > .tab.active > .tab-fill'), '::after').display,
        inactiveFill: style('.tabs-container > .tab:not(.active) > .tab-fill'),
        editorContent: style('.part.editor > .content'),
        panelTitle: style('.part.panel > .title'),
        statusbar: style('.part.statusbar'),
        quickInput: style('.quick-input-widget'),
        dialog: style('.monaco-dialog-box')
      };
    });
    assert.equal(report.titlebarImage, 'none', 'the title bar stays flat');
    assert.equal(report.sidebarImage, 'none', 'the sidebar stays flat');
    assert.equal(report.auxTitle.minHeight, '40px', 'the sessions header keeps a stable modern height');
    assert.equal(report.auxBar.display, 'none', 'the redundant single-view tab bar does not leave a blank band above the header');
    assert.equal(report.auxHeading.fontSize, '12.5px', 'the sessions header uses the compact title size');
    assert.equal(report.auxHeading.fontWeight, '600');
    assert.equal(report.auxHeading.whiteSpace, 'nowrap');
    assert.equal(report.auxHeading.textOverflow, 'ellipsis', 'a long header title truncates instead of pushing the actions away');
    assert.equal(report.auxLabel.minWidth, '0px', 'the title label can shrink for the actions');
    assert.equal(report.auxAction.width, '24px', 'header actions keep a comfortable hit target');
    assert.equal(report.auxAction.height, '24px');
    for (const [name, value] of Object.entries({
      titlebar: report.titlebar, sidebar: report.sidebar, title: report.title,
      modes: report.modes, activeMode: report.activeMode, selectedRow: report.selectedRow,
      tabs: report.tabs, activeFill: report.activeFill, editorContent: report.editorContent,
      panelTitle: report.panelTitle, statusbar: report.statusbar,
      quickInput: report.quickInput, dialog: report.dialog
    })) {
      assert.match(value.boxShadow, /inset/, `${name} gets a crisp 1px stroke (dark=${dark})`);
      assert.notEqual(value.boxShadow, 'none', `${name} is visually separated (dark=${dark})`);
    }
    assert.match(report.activeFill.boxShadow, /inset/);
    assert.match(report.activeFill.boxShadow, /1px/);
    assert.match(report.activeFill.boxShadow, /-2px/, 'the native active-tab accent rail is preserved');
    assert.equal(report.activeFill.backgroundImage, 'none', 'the native active-tab fill stays flat');
    assert.equal(report.inactiveFill.boxShadow, 'none', 'inactive tabs stay flat');
    assert.equal(report.activeFillGloss, 'none', 'no pseudo gloss overlay exists');
    assert.notEqual(report.selectedRow.backgroundColor, 'rgba(0, 0, 0, 0)', 'the selected row keeps its theme surface');
    if (dark) assert.equal(report.selectedToken, '#314339', 'the dark selected token stays exactly the theme value');
    else assert.match(report.selectedToken, /color-mix|rgb/, 'the light selected token stays untouched');
    assert.match(report.selectedRow.boxShadow, /inset/, 'selection keeps an inset stroke');
    assert.ok((report.selectedRow.boxShadow.match(/inset/g) || []).length >= 2, 'selection gets the stroke ring in addition to the native accent rail');
  }
});

test('modern finish respects high contrast', async t => {
  const page = await fixture(t);
  await page.evaluate(() => document.querySelector('.monaco-workbench').classList.add('hc-black'));
  const report = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return {
      titlebar: style('.part.titlebar').boxShadow,
      sidebar: style('.part.sidebar').boxShadow,
      activeFill: style('.tabs-container > .tab.active > .tab-fill').boxShadow,
      selectedRow: style('.ubovm-session-tree .monaco-list-row[aria-label] .monaco-tl-row').boxShadow,
      quickInput: style('.quick-input-widget').boxShadow
    };
  });
  for (const [name, value] of Object.entries(report)) {
    if (name === 'activeFill') {
      assert.doesNotMatch(value, /inset 0 0 0 1px/, 'high contrast keeps the native ribbon without the added outline ring');
      continue;
    }
    if (name === 'selectedRow') {
      assert.doesNotMatch(value, /inset 0 0 0 1px/, 'high contrast keeps the native accent rail without the added ring');
      continue;
    }
    assert.equal(value, 'none', `${name} keeps native contrast outlines`);
  }
});

test('narrow sessions bars keep the header title readable by yielding secondary actions', async t => {
  const page = await fixture(t);
  await page.locator('.part.auxiliarybar').evaluate((element) => { element.style.width = '180px'; });
  await page.waitForTimeout(80);
  const state = await page.evaluate(() => {
    const actions = [...document.querySelectorAll('.part.auxiliarybar > .title .title-actions .action-item')];
    const visible = actions.filter(item => getComputedStyle(item).display !== 'none').map(item => item.querySelector('.action-label')?.className.match(/codicon-([a-z-]+)/)?.[1]);
    const label = document.querySelector('.part.auxiliarybar > .title .title-label');
    const heading = document.querySelector('.part.auxiliarybar > .title .title-label h2');
    return { visible, labelWidth: Math.round(label.getBoundingClientRect().width), headingWidth: Math.round(heading.getBoundingClientRect().width) };
  });
  assert.ok(!state.visible.includes('new-folder'), 'project creation yields on a narrow bar');
  assert.ok(!state.visible.includes('search'), 'search yields on a very narrow bar');
  assert.ok(state.visible.includes('folder-opened'), 'the project switcher stays available');
  assert.ok(state.visible.includes('chevron-left'), 'the collapse action stays available');
  assert.ok(state.labelWidth >= 40, `the title keeps a readable slot (got ${state.labelWidth})`);
  assert.ok(state.headingWidth >= 40, `the title text keeps a readable slot (got ${state.headingWidth})`);
});

test('sessions container title matches its header so the native shell does not add a prefix', async () => {
  for (const name of ['package.nls.json', 'package.nls.zh-cn.json']) {
    const strings = JSON.parse(await readFile(new URL('../../' + name, import.meta.url), 'utf8'));
    assert.equal(strings['view.sessions'], strings['view.projects'],
      `${name}: the sessions container title must equal the default view title to avoid "Container: View" headers`);
  }
  const english = JSON.parse(await readFile(new URL('../../package.nls.json', import.meta.url), 'utf8'));
  assert.equal(english['view.sessions'], 'Projects and sessions');
  assert.match(english['view.projects'], /Projects and sessions/);
});

test('modern finish introduces no hue, gradient or glossy colour literal', async () => {
  const css = await readFile(cssPath, 'utf8');
  const marker = '/* ============================================================================\n * UBOVM modern flat finish';
  const start = css.indexOf(marker);
  assert.ok(start >= 0, 'modern finish block is present');
  const block = css.slice(start);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'no hex colour is introduced');
  assert.doesNotMatch(block, /gradient\(/i, 'no gradient or gloss layer is introduced');
  assert.doesNotMatch(block, /\b(?:hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i, 'no colour-space function is introduced');
  for (const match of block.matchAll(/rgba?\(([^)]+)\)/g)) {
    const [r, g, b] = match[1].split(',').map(value => Number.parseFloat(value.trim()));
    assert.ok((r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0), `only white/black alpha may define depth (got ${match[0]})`);
  }
  // Palette is derived from the host: only the existing foreground token is used.
  assert.match(block, /color-mix\(in srgb, var\(--vscode-foreground/, 'strokes derive from the current theme foreground');
});
