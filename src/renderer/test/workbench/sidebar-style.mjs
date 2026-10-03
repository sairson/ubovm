import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

test('running session glyph animates without rotating its row and retains selected styling', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 360 } });
  await page.setContent('<html class="ubovm-content-ready"><body><div class="monaco-workbench" style="--vscode-list-activeSelectionBackground:rgb(20, 40, 60);--vscode-list-activeSelectionForeground:#f0f6f2;--vscode-list-inactiveSelectionBackground:#314339;--vscode-list-hoverBackground:#2c352f;--vscode-sideBar-background:#1a1e1c;--vscode-foreground:#e4e8e3;--vscode-focusBorder:#a3c0ae"><div class="ubovm-sessions-body" data-active-mode="assist"><div class="ubovm-session-tree"><div class="monaco-list"><div class="monaco-list-row" aria-label="测试，当前会话，运行中，协助模式"><div class="monaco-tl-row"><span class="custom-view-tree-node-item-icon codicon codicon-loading codicon-modifier-spin"></span><span>正在运行的会话</span></div></div></div></div></div></div></body></html>');
  await page.addStyleTag({ path: 'vendor/vscode/src/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css' });
  await page.addStyleTag({ content: '.codicon-loading::before { content: "◌"; }' });
  await page.addStyleTag({ path: 'src/renderer/workbench/workbench.css' });
  const icon = page.locator('.custom-view-tree-node-item-icon');
  assert.equal(await icon.evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await icon.evaluate(el => getComputedStyle(el, '::before').animationName), 'ubovm-loading-turn');
  for (const dark of [false, true]) {
    await page.locator('.monaco-workbench').evaluate((el, dark) => {
      el.classList.toggle('vs-dark', dark);
      el.classList.toggle('vs', !dark);
    }, dark);
    const row = await page.locator('.monaco-tl-row').evaluate(el => {
      const style = getComputedStyle(el);
      return { shadow: style.boxShadow, color: style.color, weight: style.fontWeight };
    });
    assert.match(row.shadow, /inset/);
    assert.equal(row.color, 'rgb(240, 246, 242)');
    assert.ok(Number.parseInt(row.weight, 10) >= 500);
    if (!dark) continue;
    const tokens = await page.locator('.ubovm-sessions-body').evaluate(el => {
      const style = getComputedStyle(el);
      return {
        selected: style.getPropertyValue('--ubovm-nav-selected').trim(),
        hover: style.getPropertyValue('--ubovm-nav-hover').trim(),
        accent: style.getPropertyValue('--ubovm-nav-accent').trim(),
      };
    });
    // Dark mode should use solid theme list surfaces, not washed-out mixes.
    assert.equal(tokens.selected, '#314339');
    assert.equal(tokens.hover, '#2c352f');
    assert.equal(tokens.accent, '#a3c0ae');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await icon.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await icon.evaluate(el => el.classList.remove('codicon-loading', 'codicon-modifier-spin'));
  assert.equal(await icon.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
});

test('sidebar tabs have comfortable spacing and tree rows retain native geometry across themes', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 620, height: 360 } });
  await mkdir('.cache', { recursive: true });
  const tabs = ['文件', '搜索', 'Worker'].map((name, i) => `<li class="action-item ${i === 0 ? 'checked' : ''}" role="tab" tabindex="0"><a class="action-label">${name}</a><div class="active-item-indicator"></div><button class="ubovm-sidebar-tab-close" aria-label="关闭 ${name}">×</button></li>`).join('');
  const rows = ['src', 'renderer', 'workbench.css', '一个很长的文件名用于验证侧边栏中的省略显示.ts'].map((name, i) => `<div class="monaco-list-row" style="height:22px"><div class="monaco-tl-row"><div class="monaco-tl-twistie ${i < 2 ? 'collapsed' : ''}"></div><div class="monaco-tl-contents"><div class="explorer-item"><span class="label-name">${name}</span></div></div></div></div>`).join('');
  await page.setContent(`<div class="monaco-workbench"><div class="part sidebar pane-composite-part"><div class="title has-composite-bar"><div class="composite-bar-container"><div class="composite-bar"><div class="monaco-action-bar"><ul class="actions-container">${tabs}</ul></div></div></div></div><div class="explorer-folders-view"><div class="monaco-list">${rows}</div></div></div></div>`);
  for (const file of ['base/browser/ui/actionbar/actionbar.css', 'base/browser/ui/tree/media/tree.css', 'workbench/browser/parts/media/paneCompositePart.css']) await page.addStyleTag({ path: 'vendor/vscode/src/vs/' + file });
  await page.addStyleTag({ content: `body{margin:24px;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}.sidebar{background:var(--vscode-sideBar-background);color:var(--vscode-foreground);height:300px;border:1px solid #8884}.title{height:35px;border-bottom:1px solid #8883}.monaco-tl-twistie::before{content:'⌄'}.explorer-item{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.monaco-list-row:hover{background:var(--vscode-toolbar-hoverBackground)}` });
  await page.addStyleTag({ path: 'src/renderer/workbench/workbench.css' });
  for (const dark of [false, true]) {
    await page.evaluate(dark => {
      const style = document.querySelector('.monaco-workbench').style;
      for (const [key, value] of Object.entries({ foreground: dark ? '#e4e4e4' : '#303a34', 'sideBar-background': dark ? '#242826' : '#f7f8f5', 'toolbar-hoverBackground': dark ? '#ffffff12' : '#00000009', 'list-inactiveSelectionBackground': dark ? '#3b443e' : '#e6ebe4', focusBorder: '#538d68' })) style.setProperty('--vscode-' + key, value);
    }, dark);
    for (const width of [240, 300, 460]) {
      await page.locator('.sidebar').evaluate((el, width) => { el.style.width = width + 'px'; }, width);
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
      const track = await page.locator('.actions-container').evaluate(el => {
        const style = getComputedStyle(el);
        return { radius: style.borderRadius, padding: style.padding, border: style.borderStyle, background: style.backgroundColor };
      });
      assert.equal(track.radius, '0px');
      assert.equal(track.padding, '0px');
      assert.equal(track.border, 'none');
      assert.equal(track.background, 'rgba(0, 0, 0, 0)');
      const bounds = await page.locator('.action-item').evaluateAll(items => items.map(item => {
        const style = getComputedStyle(item);
        const box = item.getBoundingClientRect(), label = item.querySelector('.action-label').getBoundingClientRect();
        return {
          height: box.height,
          radius: style.borderRadius,
          left: label.left - box.left,
          top: label.top - box.top,
          bottom: box.bottom - label.bottom,
          closeDisplay: getComputedStyle(item.querySelector('button')).display,
        };
      }));
      for (const box of bounds) {
        assert.equal(box.height, 24);
        assert.equal(box.radius, '6px');
        assert(box.left >= 6, JSON.stringify(box));
        assert(box.top >= 2 && box.bottom >= 2, JSON.stringify(box));
        assert.equal(box.closeDisplay, 'none');
      }
      assert(await page.locator('.sidebar').evaluate(el => el.scrollWidth <= el.clientWidth));
      assert.deepEqual(await page.locator('.monaco-list-row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)), [22, 22, 22, 22]);
      if (width === 300) await page.screenshot({ path: `.cache/sidebar-style-${dark ? 'dark' : 'light'}.png` });
    }
  }
  await page.locator('.action-item').first().hover();
  const hovered = await page.locator('.action-item').first().evaluate(item => {
    const label = item.querySelector('.action-label').getBoundingClientRect();
    const close = item.querySelector('button');
    const closeBox = close.getBoundingClientRect();
    return {
      closeDisplay: getComputedStyle(close).display,
      closeWidth: closeBox.width,
      gap: closeBox.left - label.right,
      labelBeforeClose: label.right <= closeBox.left + 0.5,
    };
  });
  assert.equal(hovered.closeDisplay, 'flex');
  assert.equal(hovered.closeWidth, 14);
  assert(hovered.gap >= 0, JSON.stringify(hovered));
  assert.equal(hovered.labelBeforeClose, true);
  await page.mouse.move(0, 0);
  await page.locator('.action-item').first().focus();
  assert.equal(await page.locator('.action-item').first().evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.title').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await page.locator('.monaco-tl-twistie').first().evaluate(el => getComputedStyle(el, '::before').transitionDuration), '0s');
});

test('Run and Debug welcome keeps native text layout instead of empty-state icon chrome', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 520 } });
  await page.setContent(`<div class="monaco-workbench"><div class="part sidebar" style="width:300px;height:480px"><div class="pane" style="height:100%"><div class="pane-body welcome" style="height:100%"><div class="welcome-view"><div class="welcome-view-content"><div class="button-container"><a class="monaco-button">运行和调试</a></div><p>要自定义运行和调试，请<a href="#">创建 launch.json 文件</a>。</p><p>打开一个可调试或运行的文件。</p></div></div></div></div></div></div>`);
  await page.addStyleTag({ path: 'vendor/vscode/src/vs/workbench/browser/parts/views/media/views.css' });
  await page.addStyleTag({ path: 'src/renderer/workbench/workbench.css' });
  const first = await page.locator('.welcome-view-content > p').first().evaluate(el => {
    const style = getComputedStyle(el);
    const link = el.querySelector('a');
    return {
      display: style.display,
      height: style.height,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textAlign: style.textAlign,
      text: el.textContent,
      linkWrap: link ? getComputedStyle(link).whiteSpace : null
    };
  });
  assert.match(first.text, /launch\.json/);
  assert.notEqual(first.display, 'grid');
  assert.notEqual(first.height, '46px');
  assert.equal(first.fontSize, '13px');
  assert.equal(first.textAlign, 'left');
  assert.equal(first.linkWrap, 'nowrap');
  assert.ok(Number.parseInt(first.fontWeight, 10) < 600);
  const button = await page.locator('.monaco-button').boundingBox();
  const paragraph = await page.locator('.welcome-view-content > p').first().boundingBox();
  const link = await page.locator('.welcome-view-content > p a').boundingBox();
  assert.ok(button && paragraph && link);
  assert.ok(paragraph.width > 120, JSON.stringify(paragraph));
  const gaps = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.welcome-view-content > *')];
    return nodes.slice(0, -1).map((node, index) => nodes[index + 1].getBoundingClientRect().top - node.getBoundingClientRect().bottom);
  });
  assert.ok(gaps.every(gap => gap >= 10 && gap <= 14), JSON.stringify(gaps));
});

test('sidebar styles text tabs even when Run and Debug has no close button', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 240 } });
  const tabs = [
    ['文件', true, true],
    ['运行和调试', false, false],
    ['Worker', false, true],
  ].map(([name, checked, close]) => `<li class="action-item${checked ? ' checked' : ''}" role="tab"><a class="action-label">${name}</a>${close ? '<button class="ubovm-sidebar-tab-close">×</button>' : ''}</li>`).join('');
  await page.setContent(`<div class="monaco-workbench"><div class="part sidebar pane-composite-part"><div class="title has-composite-bar"><div class="composite-bar-container"><div class="composite-bar"><div class="monaco-action-bar"><ul class="actions-container">${tabs}</ul></div></div></div></div></div></div>`);
  for (const path of ['vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css', 'vendor/vscode/src/vs/workbench/browser/parts/media/paneCompositePart.css', 'src/renderer/workbench/workbench.css']) {
    await page.addStyleTag({ path });
  }
  const report = await page.locator('.action-item').evaluateAll(items => items.map(item => {
    const label = item.querySelector('.action-label');
    return {
      text: label.textContent,
      radius: getComputedStyle(item).borderRadius,
      transform: getComputedStyle(label).textTransform,
      size: getComputedStyle(label).fontSize,
      hasClose: !!item.querySelector('.ubovm-sidebar-tab-close')
    };
  }));
  assert.deepEqual(report.map(item => item.radius), ['6px', '6px', '6px']);
  assert.deepEqual(report.map(item => item.transform), ['none', 'none', 'none']);
  assert.deepEqual(report.map(item => item.size), ['12px', '12px', '12px']);
  assert.equal(report[1].hasClose, false);
});

test('sidebar text tabs stay as matching chips under modern-ui-tabs', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 480, height: 220 } });
  const tabs = ['Worker 日志', 'Explorer'].map((name, i) => (
    `<li class="action-item${i === 0 ? ' checked' : ''}" role="tab">` +
    `<a class="action-label">${name}</a>` +
    `<div class="active-item-indicator"></div>` +
    `<button class="ubovm-sidebar-tab-close">×</button></li>`
  )).join('');
  await page.setContent(
    `<div class="monaco-workbench modern-ui-tabs" style="--vscode-sideBar-background:#f7f8f5;--vscode-editor-background:#ffffff;--vscode-sideBar-foreground:#303a34;--vscode-foreground:#303a34;--modern-ui-tab-active-background:#ffffff">` +
    `<div class="part sidebar pane-composite-part" style="width:360px;background:var(--vscode-sideBar-background)">` +
    `<div class="title has-composite-bar" style="height:35px">` +
    `<div class="composite-bar-container"><div class="composite-bar"><div class="monaco-action-bar">` +
    `<ul class="actions-container">${tabs}</ul>` +
    `</div></div></div></div></div></div>`
  );
  for (const path of [
    'vendor/vscode/src/vs/base/browser/ui/actionbar/actionbar.css',
    'vendor/vscode/src/vs/workbench/browser/parts/media/paneCompositePart.css',
    'vendor/vscode/src/vs/workbench/contrib/modernUI/browser/media/tabs.css',
    'src/renderer/workbench/workbench.css',
  ]) await page.addStyleTag({ path });
  const report = await page.locator('.action-item').evaluateAll(items => items.map(item => {
    const style = getComputedStyle(item);
    const label = getComputedStyle(item.querySelector('.action-label'));
    const indicator = item.querySelector('.active-item-indicator');
    return {
      radius: style.borderRadius,
      height: Math.round(item.getBoundingClientRect().height),
      background: style.backgroundColor,
      labelColor: label.color,
      indicatorDisplay: indicator ? getComputedStyle(indicator).display : 'missing',
    };
  }));
  assert.deepEqual(report.map(item => item.radius), ['6px', '6px']);
  assert.deepEqual(report.map(item => item.height), [24, 24]);
  assert.deepEqual(report.map(item => item.indicatorDisplay), ['none', 'none']);
  // Checked must not paint the flush white editor-background rectangle.
  assert.notEqual(report[0].background, 'rgb(255, 255, 255)');
  assert.notEqual(report[0].background, report[1].background);
  assert.notEqual(report[1].labelColor, 'rgba(0, 0, 0, 0)');
  const track = await page.locator('.actions-container').evaluate(el => ({
    border: getComputedStyle(el).borderStyle,
    background: getComputedStyle(el).backgroundColor,
  }));
  assert.equal(track.border, 'none');
  assert.equal(track.background, 'rgba(0, 0, 0, 0)');
});
