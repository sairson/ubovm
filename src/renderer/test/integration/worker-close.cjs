'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const host = readFileSync(path.join(root, 'host/ui/worker-panel.cjs'), 'utf8');
const extension = readFileSync(path.join(root, 'extension.cjs'), 'utf8');
const native = readFileSync(path.join(root, 'webview/workers/native-panel.js'), 'utf8');
const webview = readFileSync(path.join(root, 'webview/workers/worker-panel.js'), 'utf8');

test('native Worker panel close action is wired through the host to the sidebar', () => {
  assert.match(webview, /if \(standalone && onClose\) onClose\(\); else dismiss\(\)/);
  assert.match(webview, /setText\(close, '返回文件'\)/);
  assert.match(native, /onClose: \(\) => vscode\.postMessage\(\{ action: 'closeWorkerPanel' \}\)/);
  assert.match(host, /'backgroundCommand', 'closeWorkerPanel'/);
  assert.match(extension, /message\.action === 'closeWorkerPanel'\) await vscode\.commands\.executeCommand\('workbench\.view\.explorer'\)/);
});
