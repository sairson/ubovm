import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const css = read('../../workbench/workbench.css');
const manifest = JSON.parse(read('../../package.json'));

test('explorer tree keeps Seti icons and native folder folding, without breadcrumbs', () => {
  assert.equal(manifest.contributes.configurationDefaults['workbench.iconTheme'], 'vs-seti');
  assert.notEqual(manifest.contributes.configurationDefaults['breadcrumbs.enabled'], true);
  assert.doesNotMatch(css, /\.monaco-breadcrumbs/);
  assert.match(css, /\.explorer-folders-view \.monaco-tl-twistie:not\(\.codicon-tree-item-loading\)::before \{ transition: transform/);
});

test('explorer rows stay flat with neutral hover and selection', () => {
  assert.match(css, /\.explorer-folders-view \.explorer-item \.label-name \{[^}]*font-size: 12px/s);
  assert.match(css, /\.explorer-folders-view \.monaco-list-row:hover \{ background: color-mix/s);
  assert.match(css, /\.explorer-folders-view \.monaco-list-row:is\(\.focused, \.selected/);
  assert.doesNotMatch(css, /\.explorer-folders-view \.monaco-tl-row \{[^}]*margin:/s);
  assert.doesNotMatch(css, /\.explorer-folders-view \.monaco-tl-row \{[^}]*border-radius/s);
});
