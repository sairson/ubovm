import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const runtime = '.runtime/vscodium-1.135.06055/resources/app';
const read = path => readFileSync(resolve(projectRoot, path), 'utf8');

test('sessions sidebar content is bound to the auxiliary bar width', () => {
  const css = read('src/renderer/workbench/workbench.css');
  assert.match(css, /\.part\.auxiliarybar > \.content\s*\{\s*width: 100% !important/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  const installed = read(`${runtime}/out/vs/workbench/workbench.desktop.main.css`);
  assert.match(installed, /\.part\.auxiliarybar > \.content\s*\{\s*width: 100% !important/);
});

test('installed mode switcher repairs a missing mode button', () => {
  const script = read(`${runtime}/out/vs/workbench/workbench.desktop.main.js`);
  assert.match(script, /button\.parentElement !== bar/);
  assert.match(script, /auxiliaryBarWidth = this\.stateModel\.getInitializationValue/);
  assert.doesNotMatch(script, /this\._mainContainerDimension\.this\._mainContainerDimension/);
});
