import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('conversation page forces full paint and ready resync after visibility restore', () => {
  const app = fs.readFileSync(path.join(root, 'webview/app.js'), 'utf8');
  assert.match(app, /if \(hostState\) \{ renderPending = true; fullRenderPending = true; contentReadyPending = true; \}/);
  assert.match(app, /if \(firstContentPaint\) beginPageTransition\('正在加载会话…', 'session'\)/);
  assert.match(app, /const pageHidden = \(\) => suspended \|\| document\.hidden;/);
  assert.match(app, /if \(renderFrame \|\| pageHidden\(\)\) return;/);
  // The pending paint frame must be tracked, or bursted snapshots each paint the
  // whole page and cancelVisualFrames cannot cancel an in-flight frame.
  assert.match(app, /const frame = renderFrame = requestAnimationFrame/);
  // A transition cover must never outlive a committed paint.
  assert.match(app, /function armRouteWatchdog\(\)/);
  assert.match(app, /armRouteWatchdog\(\);/);
  assert.match(app, /function clearRouteWatchdog\(\)/);
  assert.match(app, /clearRouteWatchdog\(\);/);
  assert.match(app, /function resumeVisuals\(\) \{\s*if \(visualSuspended\(\)\) return;\s*scheduleRender\(true\);/s);
  assert.match(app, /function requestReadyResync\(\)/);
  assert.match(app, /window\.addEventListener\('pageshow', \(\) => \{\s*suspended = false;\s*resumeVisuals\(\);\s*resumeRouteTransition\(\);\s*requestReadyResync\(\);/s);
  assert.match(app, /else \{\s*resumeVisuals\(\);\s*resumeRouteTransition\(\);\s*requestReadyResync\(\);/s);
  // A route transition that was armed while the page was hidden must resume and
  // eventually release its full-surface loader instead of showing a blank canvas.
  assert.match(app, /function resumeRouteTransition\(\)/);
  assert.match(app, /if \(pageHidden\(\)\) \{ armRouteWatchdog\(\); return; \}/);
  assert.match(app, /state\?\.type === 'windowFocused'/);
  // Focus restore forces a full paint; a live-components-only resume leaves a
  // compositor-discarded surface blank until a resize.
  assert.match(app, /state\?\.type === 'windowFocused'\) \{[\s\S]{0,400}?cancelVisualFrames\(\);\s*resumeVisuals\(\);/s);
  // Occlusion without focus/visibility events heals via an idle compositor keep-alive.
  assert.match(app, /const keepAlive = \{ last: Date\.now\(\), intervalMs: 20000, idleMs: 15000/);
  assert.match(app, /if \(Date\.now\(\) - keepAlive\.last < keepAlive\.idleMs\) return;/);
  assert.match(app, /function keepAliveNudge\(\)/);
  assert.match(app, /setInterval\(\(\) => \{[\s\S]{0,240}?keepAliveNudge\(\);/s);
  assert.match(app, /window\.addEventListener\('focus', \(\) => \{[\s\S]{0,320}?cancelVisualFrames\(\);\s*resumeVisuals\(\);/s);
  assert.match(app, /function renderSafely\(full\) \{\s*keepAliveMark\(\);/s);
  assert.match(app, /function receiveHostMessage\(event\) \{\s*keepAliveMark\(\);/s);
  assert.match(app, /\['unresponsive', 'backend-disconnected'\]\.includes\(connectionStatus\)/);
  assert.doesNotMatch(app, /queueControlsBlocked[\s\S]{0,200}'reconnecting'/);
  // A probe miss is advisory: the page keeps its pending operations and drafts.
  assert.doesNotMatch(app, /连接已中断，已发送操作的结果尚未确认/);
  assert.match(app, /if \(status === 'connected' && \['unresponsive', 'backend-disconnected', 'backend-stalled', 'reconnecting'\]/);
  const extension = fs.readFileSync(path.join(root, 'extension.cjs'), 'utf8');
  assert.match(extension, /onDidChangeWindowState/);
  assert.match(extension, /type: 'windowFocused'/);
  assert.match(extension, /readyPublishTimer/);
  assert.match(extension, /editorPublishTimer/);
  assert.match(extension, /visibilityPublishTimer/);
  assert.match(extension, /Always answer the heartbeat first/);
  assert.match(extension, /replyConnectionProbe/);
  assert.match(extension, /Coalesce with ready\/visibility publishes/);
  assert.match(extension, /schedulePublishState/);
  assert.match(extension, /conversationConsumesSnapshot/);
  assert.match(extension, /conversationNeedsSnapshot/);
  assert.match(extension, /chromeLockedSessionId/);
  assert.match(extension, /chromeLockWatchdog/);
  assert.match(extension, /never leave native chrome locked forever/);
  assert.match(extension, /status: 'disconnected', recovering: true/);
  // Reconnection is an authoritative snapshot read, never a task replay.
  assert.match(extension, /harness\.authoritative\(conversation\.id\)/);
  assert.match(extension, /scheduleBackendResync/);
  assert.match(extension, /noteBackendHealth/);
  assert.doesNotMatch(extension, /isBusy\(currentId\)\) return \{ status: 'connected'/);
  assert.match(extension, /if \(switched\) await lockConversationChrome\(\);/);
  // Bursts of tree/mode clicks must collapse to the latest navigation request.
  assert.match(extension, /function navigationAction\(run\)/);
  assert.match(extension, /if \(ticket !== navigationTicket\) return undefined/);
  assert.match(extension, /welcome\.reveal\(welcome\.viewColumn \|\| vscode\.ViewColumn\.One, true\)/);
  assert.match(extension, /createSessions\(vscode, context, \(\) => schedulePublishState\(\)/);
  assert.match(extension, /ensureIdle/);
  const monitor = fs.readFileSync(path.join(root, 'webview/connection-monitor.js'), 'utf8');
  assert.match(monitor, /missCount/);
  assert.match(monitor, /missCount >= 2/);
  assert.match(monitor, /change\('unresponsive'\)/);
  assert.doesNotMatch(monitor, /change\('disconnected'\)/);
  assert.match(monitor, /backendMissCount/);
  assert.match(monitor, /graceUntil/);
  assert.match(app, /Soft reconnect ticks only need the connection strip/);
  assert.match(app, /window\.UBOVMRuntime\?\.cancel\(\)/);
  assert.match(app, /if \(executionOnly !== true\) \{\s*committedRender = undefined;\s*fullRenderPending = true;\s*\}/s);
  assert.match(app, /fullRenderPending = true;\s*renderPending = true;\s*cancelRenderTimer\(\);/s);
  assert.match(app, /if \(full \|\| !succeeded\) finishPageTransition\(\)/);
  assert.match(app, /contentReadyRetried/);
  assert.match(app, /finishPageTransition\(\)/);
  assert.match(app, /HISTORY_PROGRESSIVE_MIN/);
  assert.match(app, /scheduleHistoryFill/);
  assert.match(app, /queueThreadTeardown/);
  assert.match(app, /flushThreadTeardown/);
  assert.match(extension, /executionPublisher\.schedule\(sessions\.summary\(\)\.id\)/);
  assert.match(extension, /Carry host recovery chrome on execution ticks/);
  assert.match(monitor, /Keep `connected` while a live probe is outstanding/);
  assert.match(monitor, /else if \(pending\) \{\s*pending\.sent = now;/s);
  assert.match(monitor, /lastPong > lastTick/);
  assert.match(monitor, /let lastPong = 0/);
  assert.match(monitor, /One post-show miss \(timeout or failed bridge delivery\)/);
  assert.match(extension, /retainContextWhenHidden: true \}/);
  const threadRpc = fs.readFileSync(path.join(root, '../harness/ide/runtime/thread-rpc.cjs'), 'utf8');
  assert.match(threadRpc, /else if \(probe\) probe\.sent = now/);
  assert.match(extension, /registerWebviewViewProvider\('ubovm\.blackboardDetails'[\s\S]*retainContextWhenHidden: true/);
});

test('native window recovery schedules staggered invalidates', () => {
  const rendering = fs.readFileSync(path.join(root, '../main/window-rendering.mjs'), 'utf8');
  assert.match(rendering, /const delayMs = Object\.freeze\(\[0, 250, 1000\]\)/);
  assert.match(rendering, /keepAliveMs = 20000/);
  assert.match(rendering, /before-input-event/);
  // A lost compositor surface cannot be restored with invalidate() alone: the
  // smallest geometry change rebuilds the native surface (the manual resize fix).
  assert.match(rendering, /window\.setBounds\(\{ \.\.\.bounds, width: bounds\.width \+ 1 \}\)/);
  assert.match(rendering, /window\.on\('focus', focus\)/);
  assert.match(rendering, /powerMonitor\.on\('unlock-screen', resume\)/);
  // Resizes and unresponsive renderers must repaint rather than leave a blank surface.
  assert.match(rendering, /window\.on\('resized', resized\)/);
  assert.match(rendering, /window\.on\('responsive', responsive\)/);
  assert.match(rendering, /Window renderer unresponsive\.[\s\S]{0,120}recover\(\)/);
  const index = fs.readFileSync(path.join(root, '../main/index.mjs'), 'utf8');
  assert.match(index, /disable-renderer-backgrounding/);
  assert.match(index, /disable-backgrounding-occluded-windows/);
  assert.match(index, /disable-background-timer-throttling/);
  // Graphite's compositor is the upstream cause of idle blank windows. Windows
  // has a separate, opt-in DirectComposition fallback for the same symptom.
  assert.match(index, /disable-skia-graphite/);
  assert.match(index, /UBOVM_DISABLE_DIRECT_COMPOSITION/);
  assert.match(index, /getGPUFeatureStatus/);
});
