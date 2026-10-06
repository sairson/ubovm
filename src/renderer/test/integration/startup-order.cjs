'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

test('failed startup persistence is reported without poisoning the first queued retry', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const start = source.indexOf('  messageQueue = sessions.ready.then');
  const block = source.slice(start, source.indexOf('  const sidebarProvider', start));
  const errors = [];
  const sandbox = { sessions: { ready: Promise.reject(Error('storage temporarily unavailable')) },
    firstPaint: Promise.resolve(), shuttingDown: false, recovering: true, publishState() {},
    output: { appendLine: value => errors.push(value) } };
  vm.runInNewContext(block, sandbox);
  let retried = false;
  await sandbox.messageQueue.then(() => { retried = true; });
  assert.equal(retried, true);
  assert.equal(sandbox.recovering, false);
  assert.match(errors[0], /storage temporarily unavailable/);
});

test('IDE recovery errors remain a view overlay and never modify the backend snapshot', () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const start = source.indexOf('  function assistantExecution(');
  const block = source.slice(start, source.indexOf('  function publishState()', start));
  const snapshot = Object.freeze({ status: 'idle', busy: false, error: null });
  const sandbox = { harness: { state: () => snapshot }, sessions: { goalSummaries: () => [] }, restoreErrors: new Map([['test', 'recovery failed']]) };
  vm.runInNewContext("'use strict';\n" + block, sandbox);
  assert.equal(sandbox.assistantExecution({ id: 'test', mode: 'assist' }).error.message, 'recovery failed');
  assert.equal(snapshot.error, null);
  sandbox.restoreErrors.clear();
  assert.equal(sandbox.assistantExecution({ id: 'test', mode: 'assist' }).error, null);
});

test('registers session UI before persistence and restores execution only after first paint', async () => {
  const entry = path.resolve(__dirname, '../../extension.cjs');
  const nativeRequire = createRequire(entry);
  let releaseStorage, releaseHistory, restored = false, installed = false, registered = false;
  const storage = new Promise(resolve => { releaseStorage = resolve; });
  const history = new Promise(resolve => { releaseHistory = resolve; });
  const disposable = { dispose() {} };
  const session = { id: 'saved', title: 'Saved', mode: 'assist', messages: [{ role: 'user', text: 'Existing content' }] };
  let snapshotReads = 0;
  const sessions = {
    ready: storage, current: () => { snapshotReads++; return session; }, summary: () => ({ ...session, historyCount: 1 }), ids: () => ['saved'], goalSummaries: () => [], related: () => [],
    projects: () => [], projectSessions: () => [], runningModes: () => [],
    provider: { onDidChangeTreeData: () => disposable },
  };
  const vscode = {
    Disposable: class { constructor(fn) { this.dispose = fn; } },
    EventEmitter: class { event() { return disposable; } fire() {} },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ inspect: () => ({}) }) }, env: { appRoot: '/app' },
    commands: { executeCommand: async () => {} },
    window: {
      registerWebviewViewProvider: () => disposable,
      createOutputChannel: () => ({ appendLine() {} }),
      createTreeView: () => { registered = true; return {}; },
      onDidChangeWindowState: () => disposable
    },
  };
  const replacements = {
    // This activation-order fixture has no installed SDK; do not provision a native Python sandbox.
    'node:fs': { ...require('node:fs'), existsSync: () => false },
    './harness/workspace/workspace-search.cjs': { createWorkspaceSearch: () => ({ tools: () => [] }) },
    './harness/workspace/workspace-validation.cjs': { createWorkspaceValidation: () => ({ tools: () => [], capture() {}, dispose() {} }) },
    './host/system/theme.cjs': { readTheme: () => ({ mode: 'light' }) },
    './harness/coding/coding-service.cjs': { createCodingService: () => ({ tools: () => [], turnSummary: () => ({}), dispose() {} }) },
    vscode,
    './harness/session/sessions.cjs': { createSessions: () => sessions, inputMessageId: nativeRequire('./harness/session/sessions.cjs').inputMessageId, inputMessageIds: nativeRequire('./harness/session/sessions.cjs').inputMessageIds },
    './harness/config/model-config.cjs': { createModelConfiguration: () => ({ status: () => ({}) }) },
    './harness/config/settings-config.cjs': { createSettingsConfiguration: () => ({}), readSSHStatus: () => ({ configured: false }) },
    './host/agent/agent-service.cjs': { createHarnessService: () => ({ close: async () => {}, state: () => ({}), restore: async () => { restored = true; await history; } }) },
    './harness/config/skills-catalog.cjs': { installBundledSkills: async () => { installed = true; } },
    './harness/session/message-actions.cjs': { createMessageActions: () => ({}) },
    './host/agent/state-publisher.cjs': { createExecutionPublisher: () => ({ clear() {} }) },
    './host/system/terminal-service.cjs': { createTerminalService: () => ({ register: () => [] }) },
    './host/system/browser-install.cjs': { createBrowserInstaller: () => ({ status: () => ({}), dispose() {} }), BROWSER_PATH_KEY: 'browser.path' },
    './host/system/ide-browser-host.cjs': { createIdeBrowserHost: () => ({ dispose() {} }) },
  };
  // Stop after UI registration; use the real activation prelude and state
  // functions, without emulating unrelated editor/terminal VS Code APIs.
  const source = readFileSync(entry, 'utf8').replace(/  publishState\(\);\r?\n\r?\n  function sessionFolders/,
    '  publishState();\n  return { assistantState, paint: releaseFirstPaint, done: messageQueue };\n\n  function sessionFolders');
  const sandbox = { require: name => replacements[name] ?? nativeRequire(name), module: { exports: {} }, __dirname: path.dirname(entry), process, console, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox, { filename: entry });
  const api = await sandbox.module.exports.activate({
    subscriptions: [],
    globalStorageUri: { fsPath: '/storage' },
    globalState: { get() {}, update: async () => {} },
    storageUri: { fsPath: '/storage' }
  });
  assert.equal(registered, true);
  snapshotReads = 0;
  const published = api.assistantState();
  assert.equal(snapshotReads, 1, 'one publication must not copy the history again for its workspace label');
  assert.equal(published.context.workspace, '选择工作空间（必选）');
  assert.equal(api.assistantState().messages[0].text, 'Existing content');
  assert.equal(api.assistantState().recovering, true);
  assert.equal(installed, false);
  releaseStorage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored, false, 'storage completion does not block first content paint with SDK recovery');
  api.paint();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installed, true);
  assert.equal(restored, true);
  assert.equal(api.assistantState().recovering, true);
  releaseHistory();
  await api.done;
  assert.equal(api.assistantState().recovering, false);
});

// Run the activation startup block with stalled dependencies.
test('sidebar startup does not wait for settings or Explorer and survives Explorer failure', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const startup = source.slice(source.indexOf('  // Show navigation independently'), source.indexOf('  // Restoration/serialization must run after activation'));
  assert.ok(startup.length, 'test the real activation startup block');
  let releaseSettings, releaseExplorer;
  const settings = new Promise(resolve => { releaseSettings = resolve; });
  const explorer = new Promise((resolve, reject) => { releaseExplorer = reject; });
  const calls = [], errors = [];
  vm.runInNewContext(startup, {
    vscode: { commands: { executeCommand: async command => { calls.push(command); } } },
    applyUiPreset: () => settings,
    shuttingDown: false,
    explorerReady: false,
    sessions: { current: () => ({ workspace: 'C:/project' }) },
    sessionExplorer: { sync: () => explorer },
    refreshEmptyFolder: async () => {},
    hideUnusedViews: async () => {},
    output: { appendLine: message => errors.push(message) },
  });
  assert.deepEqual(calls, ['workbench.view.extension.ubovm-sessions', 'workbench.action.closeSidebar']);
  releaseSettings();
  await new Promise(resolve => setImmediate(resolve));
  releaseExplorer(Error('Explorer unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['workbench.view.extension.ubovm-sessions', 'workbench.action.closeSidebar']);
  assert.match(errors[0], /Explorer unavailable/);
});

test('settings contentReady without sessionId still unlocks chrome', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const start = source.indexOf("else if (message.action === 'contentReady')");
  const block = source.slice(start, source.indexOf("else if (message.action === 'prompt')", start))
    .replace(/^else\s+/, '');
  assert.match(block, /if \(chromeLockedSessionId\) \{\s*if \(message\.sessionId !== chromeLockedSessionId\) return;/s);
  assert.equal(block.includes('if (!message.sessionId) return'), false, 'initialize/settings paint has no sessionId');

  const contexts = [];
  const sandbox = {
    message: { action: 'contentReady' },
    chromeLockedSessionId: undefined,
    sessions: { current: () => ({ id: 'current' }) },
    vscode: { commands: { executeCommand: async (...args) => { contexts.push(args); } } },
    recoveryTimer: undefined,
    chromeLockWatchdog: undefined,
    clearTimeout() {},
    releaseFirstPaint() { contexts.push(['firstPaint']); }
  };
  await vm.runInNewContext(`(async () => { ${block} })()`, sandbox);
  assert.deepEqual(contexts, [['setContext', 'ubovm.contentReady', true], ['firstPaint']]);
  assert.equal(sandbox.chromeLockedSessionId, undefined);

  contexts.length = 0;
  sandbox.message = { action: 'contentReady', sessionId: 'stale' };
  await vm.runInNewContext(`(async () => { ${block} })()`, sandbox);
  assert.deepEqual(contexts, [], 'stale conversation paints must not unlock chrome');

  contexts.length = 0;
  sandbox.chromeLockedSessionId = 'locked';
  sandbox.message = { action: 'contentReady' };
  await vm.runInNewContext(`(async () => { ${block} })()`, sandbox);
  assert.deepEqual(contexts, [], 'settings paint must not unlock a conversation lock');
  assert.equal(sandbox.chromeLockedSessionId, 'locked');

  contexts.length = 0;
  sandbox.message = { action: 'contentReady', sessionId: 'locked' };
  await vm.runInNewContext(`(async () => { ${block} })()`, sandbox);
  assert.deepEqual(contexts, [['setContext', 'ubovm.contentReady', true], ['firstPaint']]);
  assert.equal(sandbox.chromeLockedSessionId, undefined, 'matching conversation paint clears the lock');
});

// Exercise the actual recovery command without starting an extension host.
test('conversation recovery reloads only the view and ignores a disposed panel', async () => {
  const entry = path.resolve(__dirname, '../../extension.cjs');
  const source = readFileSync(entry, 'utf8');
  const command = source.slice(source.indexOf('  async function reloadConversation()'), source.indexOf('  async function openWelcome('));
  const { renderWebview } = require('../../host/ui/webview.cjs');
  let clears = 0, reveals = 0;
  const panel = { webview: { html: renderWebview() }, viewColumn: 1, reveal() { reveals++; } };
  const original = panel.webview.html;
  const sandbox = { welcome: panel, welcomeReady: true, shuttingDown: false, renderWebview, workspaceName: () => 'fixture',
    settingsOpenRevision: 1, settingsOpening: 1, settingsPage: 'mcp', settingsSection: 'mcp', sidebarChanged: { fire() {} },
    executionPublisher: { clear() { clears++; } }, vscode: { version: 'test', ViewColumn: { One: 1 }, commands: { executeCommand: async () => {} } } };
  vm.runInNewContext(command, sandbox);
  await sandbox.reloadConversation();
  assert.notEqual(panel.webview.html, original, 'a new nonce forces the iframe to reload');
  assert.equal(sandbox.welcome, panel, 'the fixed editor survives');
  assert.equal(sandbox.welcomeReady, false, 'state publication waits for the new handshake');
  assert.equal(sandbox.settingsPage, '', 'reload must leave settings navigation with the closed dialog');
  assert.equal(sandbox.settingsOpenRevision, 2, 'reload invalidates outstanding settings loads');
  assert.equal(sandbox.settingsOpening, 0, 'the new handshake can resume unfinished initialization');
  assert.equal(clears, 1); assert.equal(reveals, 1);
  const refreshed = panel.webview.html;
  sandbox.vscode.commands.executeCommand = async () => { sandbox.welcome = undefined; };
  await sandbox.reloadConversation();
  assert.equal(panel.webview.html, refreshed, 'a disposed panel is never written after awaiting context');
});

test('fresh launches skip serialized conversation restore when no restored tab exists', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const start = source.indexOf('      async function resumeRestored() {');
  const end = source.indexOf('      if (await resumeRestored()) {', start);
  assert.ok(start > 0 && end > start);
  const settings = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../resources/app.json'), 'utf8')).settings;
  assert.equal(settings['workbench.editor.restoreEditors'], false);
  const sandbox = {
    welcome: undefined,
    shuttingDown: false,
    vscode: { workspace: { getConfiguration: () => ({ get: key => key === 'workbench.editor.restoreEditors' ? false : undefined }) } },
    restoredConversation() { return undefined; },
    focusColumn() { throw new Error('must not wait on a missing restored tab'); }
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  assert.equal(await sandbox.resumeRestored(), false);
});

test('a leftover restored conversation is awaited instead of opening a second panel', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../extension.cjs'), 'utf8');
  const start = source.indexOf('      async function resumeRestored() {');
  const end = source.indexOf('      if (await resumeRestored()) {', start);
  const sandbox = { Promise, welcome: undefined, shuttingDown: false, focused: false, opened: 0, ticks: 0 };
  sandbox.vscode = {
    workspace: { getConfiguration: () => ({ get: () => false }) },
    commands: { executeCommand: async () => { sandbox.opened++; } }
  };
  sandbox.restoredConversation = () => ({ group: { viewColumn: 2 }, index: 0 });
  sandbox.focusColumn = async () => { sandbox.focused = true; };
  sandbox.setTimeout = fn => { sandbox.ticks++; fn(); return 0; };
  vm.runInNewContext(source.slice(start, end), sandbox);
  assert.equal(await sandbox.resumeRestored(), false);
  assert.equal(sandbox.focused, true);
  assert.equal(sandbox.opened, 1);
  assert.equal(sandbox.ticks, 20);
  assert.match(source, /bindConversation\(panel, \{ freshSession: true \}\)/);
});
