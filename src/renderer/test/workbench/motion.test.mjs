import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Browser-level regression: real CSS display transitions and native snapshots.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const css = await readFile(new URL('../../webview/motion.css', import.meta.url), 'utf8');
  const workbenchCss = await readFile(new URL('../../workbench/workbench.css', import.meta.url), 'utf8');
  const patch = await readFile(new URL('../../../../resources/patches/panel-ui.patch', import.meta.url), 'utf8');
  const code = patch.split('diff --git ')[1].split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  await page.setContent(`<style>[hidden]{display:none!important}.worker-panel{width:300px;height:400px;background:white}${css}</style><aside class="worker-panel" hidden>Worker</aside>`);
  await page.evaluate(() => { document.querySelector('aside').hidden = false; });
  await page.waitForTimeout(280);
  await page.evaluate(() => { document.querySelector('aside').hidden = true; });
  await page.waitForTimeout(50);
  assert.notEqual(await page.locator('aside').evaluate(el => getComputedStyle(el).display), 'none', 'closing content survives during exit');
  await page.evaluate(() => { document.querySelector('aside').hidden = false; });
  await page.waitForTimeout(280);
  assert.equal(await page.locator('aside').evaluate(el => getComputedStyle(el).opacity), '1', 'reopening cancels the exit');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.querySelector('aside').hidden = true; });
  assert.equal(await page.locator('aside').evaluate(el => getComputedStyle(el).display), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setContent(`<style>${workbenchCss}.monaco-workbench{display:flex;width:900px;height:600px}.part{height:100%;background:#eee}.sidebar,.auxiliarybar{width:200px}.editor{flex:1}[hidden]{display:none!important}</style><div class="monaco-workbench"><div class="part auxiliarybar">Sessions</div><div class="part editor">Editor</div><div class="part sidebar">Files</div></div>`);
  await page.evaluate(code => {
    window.captures = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = callback => {
      const transition = start(callback);
      window.captures.push(transition);
      return transition;
    };
    window.layout = {
      mainContainer: document.querySelector('.monaco-workbench'),
      setPartHidden: new Function('hidden', 'part', code + `\n document.querySelector(part.endsWith('sidebar') ? '.sidebar' : '.auxiliarybar').hidden = hidden;`)
    };
    window.layout.setPartHidden(true, 'workbench.parts.sidebar');
  }, code);
  await page.evaluate(() => window.captures.at(-1).ready);
  assert.equal(await page.locator('.sidebar').evaluate(el => el.hidden), true);
  assert.ok(await page.evaluate(() => document.getAnimations().length > 0), 'native pane exit has a running snapshot animation');
  await page.evaluate(async () => {
    window.layout.setPartHidden(false, 'workbench.parts.sidebar');
    window.layout.setPartHidden(true, 'workbench.parts.sidebar');
    window.layout.setPartHidden(false, 'workbench.parts.sidebar');
    window.layout.setPartHidden(true, 'workbench.parts.auxiliarybar');
    await Promise.all(window.captures.map(transition => transition.finished));
  });
  assert.equal(await page.locator('.sidebar').evaluate(el => el.hidden), false, 'latest request wins');
  assert.equal(await page.locator('.auxiliarybar').evaluate(el => el.hidden), true, 'independent panes both commit');
  await page.evaluate(() => document.querySelector('.editor').append(document.createElement('iframe')));
  assert.equal(await page.evaluate(() => {
    const captures = window.captures.length;
    window.layout.setPartHidden(true, 'workbench.parts.sidebar');
    return document.querySelector('.sidebar').hidden && window.captures.length === captures;
  }), true, 'embedded webviews resize synchronously without blank snapshot frames');
  await page.evaluate(() => document.querySelector('iframe').remove());
  assert.equal(await page.locator('.editor').evaluate(el => getComputedStyle(el).viewTransitionName), 'none', 'the editor never becomes a snapshot texture');
  // The shell exists before the cross-process iframe mounts. Capturing in
  // this gap used to leave the editor gray after a layout change.
  await page.locator('.auxiliarybar').evaluate(el => el.classList.add('ubovm-sessions-body'));
  assert.equal(await page.evaluate(() => {
    const captures = window.captures.length;
    window.layout.setPartHidden(false, 'workbench.parts.auxiliarybar');
    return !document.querySelector('.auxiliarybar').hidden && window.captures.length === captures;
  }), true, 'the application shell resizes synchronously before iframe mounting');
  await page.locator('.auxiliarybar').evaluate(el => el.classList.remove('ubovm-sessions-body'));
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.className = 'webview-overlay-content';
    document.body.append(overlay);
  });
  assert.equal(await page.evaluate(() => {
    const captures = window.captures.length;
    window.layout.setPartHidden(false, 'workbench.parts.sidebar');
    return !document.querySelector('.sidebar').hidden && window.captures.length === captures;
  }), true, 'detached overlay roots also prevent document snapshots');
  await page.locator('.webview-overlay-content').evaluate(el => el.remove());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => {
    window.layout.setPartHidden(true, 'workbench.parts.sidebar');
    return document.querySelector('.sidebar').hidden;
  }), true, 'reduced motion commits synchronously');
  console.log('PASS: pane exit, rapid reversal, independent toggles, and reduced motion');
} finally {
  await browser.close();
}
