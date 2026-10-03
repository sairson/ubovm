import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('conversation page forces full paint and ready resync after visibility restore', () => {
  const app = fs.readFileSync(path.join(root, 'webview/app.js'), 'utf8');
  assert.match(app, /if \(hostState\) \{ renderPending = true; fullRenderPending = true; contentReadyPending = true; \}/);
  assert.match(app, /function resumeVisuals\(\) \{\s*if \(visualSuspended\(\)\) return;\s*scheduleRender\(true\);/s);
  assert.match(app, /function requestReadyResync\(\)/);
  assert.match(app, /window\.addEventListener\('pageshow', \(\) => \{\s*suspended = false;\s*resumeVisuals\(\);\s*requestReadyResync\(\);/s);
  assert.match(app, /else \{\s*resumeVisuals\(\);\s*requestReadyResync\(\);/s);
  assert.match(app, /state\?\.type === 'windowFocused'/);
  assert.match(app, /\['disconnected', 'backend-disconnected'\]\.includes\(connectionStatus\)/);
  assert.doesNotMatch(app, /queueControlsBlocked[\s\S]{0,200}'reconnecting'/);
  const extension = fs.readFileSync(path.join(root, 'extension.cjs'), 'utf8');
  assert.match(extension, /onDidChangeWindowState/);
  assert.match(extension, /type: 'windowFocused'/);
  assert.match(extension, /readyPublishTimer/);
  assert.match(extension, /editorPublishTimer/);
  assert.match(extension, /visibilityPublishTimer/);
  assert.match(extension, /Always answer the heartbeat first/);
  assert.match(extension, /replyConnectionProbe/);
  assert.match(extension, /schedulePublishState/);
  assert.match(extension, /conversationConsumesSnapshot/);
  assert.match(extension, /createSessions\(vscode, context, \(\) => schedulePublishState\(\)/);
  assert.match(extension, /ensureIdle/);
  const monitor = fs.readFileSync(path.join(root, 'webview/connection-monitor.js'), 'utf8');
  assert.match(monitor, /missCount/);
  assert.match(monitor, /missCount >= 2/);
  assert.match(monitor, /backendMissCount/);
  assert.match(monitor, /graceUntil/);
  assert.match(app, /Soft reconnect ticks only need the connection strip/);
  assert.match(extension, /retainContextWhenHidden: true \}/);
  assert.match(extension, /registerWebviewViewProvider\('ubovm\.blackboardDetails'[\s\S]*retainContextWhenHidden: true/);
});

test('native window recovery schedules staggered invalidates', () => {
  const rendering = fs.readFileSync(path.join(root, '../main/window-rendering.mjs'), 'utf8');
  assert.match(rendering, /const delayMs = Object\.freeze\(\[0, 250, 1000\]\)/);
});
