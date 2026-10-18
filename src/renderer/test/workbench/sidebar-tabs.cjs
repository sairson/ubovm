'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');

test('right sidebar keeps the file-tree tab and collapses its lone tab strip', () => {
  const patch = fs.readFileSync(path.join(root, 'resources/patches/sidebar-close-tabs.patch'), 'utf8');
  // Explorer is the sidebar's anchor view: its tab is marked for the chrome but
  // never gets the close-button wiring (including middle-click / Delete).
  assert.match(patch, /container\.dataset\.ubovmCompositeId = compositeId;/);
  assert.match(patch, /if \(compositeId !== 'workbench\.view\.explorer'\) \{/);

  const css = fs.readFileSync(path.join(root, 'src/renderer/workbench/workbench.css'), 'utf8');
  assert.match(css, /action-item:only-child\[data-ubovm-composite-id="workbench\.view\.explorer"\]/);
});
