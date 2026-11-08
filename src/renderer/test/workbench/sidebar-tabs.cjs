'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');

test('right sidebar tabs, including Explorer, expose a working close affordance', () => {
  const patch = fs.readFileSync(path.join(root, 'resources/patches/sidebar-close-tabs.patch'), 'utf8');
  // Every right-sidebar tab, including the Explorer anchor, owns the close
  // wiring; closing the last pinned tab collapses the pane.
  assert.match(patch, /container\.dataset\.ubovmCompositeId = compositeId;/);
  assert.doesNotMatch(patch, /compositeId !== 'workbench\.view\.explorer'/);
  assert.match(patch, /container\.appendChild\(close\);/);
  // The injected prebuilt bundle is plain JavaScript; localize is not in scope
  // there and would abort the whole tab render with a ReferenceError.
  assert.doesNotMatch(patch, /localize\(/);
  const empty = fs.readFileSync(path.join(root, 'resources/patches/sidebar-empty.patch'), 'utf8');
  assert.doesNotMatch(empty, /localize\(/);

  const css = fs.readFileSync(path.join(root, 'src/renderer/workbench/workbench.css'), 'utf8');
  assert.match(css, /\.ubovm-sidebar-tab-close/);
  assert.doesNotMatch(css, /action-item:only-child\[data-ubovm-composite-id="workbench\.view\.explorer"\]/);

  const html = fs.readFileSync(path.join(root, 'src/renderer/webview/index.html'), 'utf8');
  assert.match(html, /id="open-files"[^>]*data-action="openFiles"/);
  const extension = fs.readFileSync(path.join(root, 'src/renderer/extension.cjs'), 'utf8');
  assert.match(extension, /registerCommand\('ubovm\.openFiles'/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'ubovm.openFiles'));
});
