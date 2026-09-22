'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

test('registers session UI before persistence and restores execution only after first paint', async () => {
  const entry = path.resolve(__dirname, '../extension.cjs');
  const nativeRequire = createRequire(entry);
  let releaseStorage, releaseHistory, restored = false, installed = false, registered = false;
  const storage = new Promise(resolve => { releaseStorage = resolve; });
  const history = new Promise(resolve => { releaseHistory = resolve; });
  const disposable = { dispose() {} };
  const session = { id: 'saved', title: 'Saved', mode: 'assist', messages: [{ role: 'user', text: 'Existing content' }] };
  const sessions = {
    ready: storage, current: () => session, summary: () => ({ ...session, historyCount: 1 }), ids: () => ['saved'], goalSummaries: () => [],
    provider: { onDidChangeTreeData: () => disposable },
  };
  const vscode = {
    Disposable: class { constructor(fn) { this.dispose = fn; } },
    EventEmitter: class { event() { return disposable; } fire() {} },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ inspect: () => ({}) }) }, env: { appRoot: '/app' },
    commands: { executeCommand: async () => {} },
    window: { registerWebviewViewProvider: () => disposable, createOutputChannel: () => ({ appendLine() {} }), createTreeView: () => { registered = true; return {}; } },
  };
  const replacements = {
    './harness/workspace-search.cjs': { createWorkspaceSearch: () => ({ tools: () => [] }) },
    './harness/workspace-validation.cjs': { createWorkspaceValidation: () => ({ tools: () => [], capture() {}, dispose() {} }) },
    './host/theme.cjs': { readTheme: () => ({ mode: 'light' }) },
    './harness/coding-service.cjs': { createCodingService: () => ({ tools: () => [], dispose() {} }) },
    vscode,
    './harness/sessions.cjs': { createSessions: () => sessions },
    './harness/config/model-config.cjs': { createModelConfiguration: () => ({ status: () => ({}) }) },
    './harness/config/settings-config.cjs': { createSettingsConfiguration: () => ({}), readSSHStatus: () => ({ configured: false }) },
    './harness/harness-service.cjs': { createHarnessService: () => ({ close: async () => {}, state: () => ({}), restore: async () => { restored = true; await history; } }) },
    './harness/config/skills-catalog.cjs': { installBundledSkills: async () => { installed = true; } },
    './harness/message-actions.cjs': { createMessageActions: () => ({}) },
    './host/state-publisher.cjs': { createExecutionPublisher: () => ({ clear() {} }) },
    './host/terminal-service.cjs': { createTerminalService: () => ({ register: () => [] }) },
  };
  // Stop after UI registration; use the real activation prelude and state
  // functions, without emulating unrelated editor/terminal VS Code APIs.
  const source = readFileSync(entry, 'utf8').replace(/  publishState\(\);\r?\n\r?\n  function sessionFolders/,
    '  publishState();\n  return { assistantState, paint: releaseFirstPaint, done: messageQueue };\n\n  function sessionFolders');
  const sandbox = { require: name => replacements[name] ?? nativeRequire(name), module: { exports: {} }, __dirname: path.dirname(entry), process, console, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox, { filename: entry });
  const api = await sandbox.module.exports.activate({ subscriptions: [], globalStorageUri: { fsPath: '/storage' } });
  assert.equal(registered, true);
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
  const source = readFileSync(path.resolve(__dirname, '../extension.cjs'), 'utf8');
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
  assert.deepEqual(calls, ['workbench.view.extension.ubovm-sessions']);
  releaseSettings();
  await new Promise(resolve => setImmediate(resolve));
  releaseExplorer(Error('Explorer unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['workbench.view.extension.ubovm-sessions']);
  assert.match(errors[0], /Explorer unavailable/);
});

// Exercise the actual recovery command without starting an extension host.
test('conversation recovery reloads only the view and ignores a disposed panel', async () => {
  const entry = path.resolve(__dirname, '../extension.cjs');
  const source = readFileSync(entry, 'utf8');
  const command = source.slice(source.indexOf('  async function reloadConversation()'), source.indexOf('  async function openWelcome('));
  const { renderWebview } = require('../host/webview.cjs');
  let clears = 0, reveals = 0;
  const panel = { webview: { html: renderWebview() }, viewColumn: 1, reveal() { reveals++; } };
  const original = panel.webview.html;
  const sandbox = { welcome: panel, welcomeReady: true, shuttingDown: false, renderWebview, workspaceName: () => 'fixture',
    executionPublisher: { clear() { clears++; } }, vscode: { version: 'test', ViewColumn: { One: 1 }, commands: { executeCommand: async () => {} } } };
  vm.runInNewContext(command, sandbox);
  await sandbox.reloadConversation();
  assert.notEqual(panel.webview.html, original, 'a new nonce forces the iframe to reload');
  assert.equal(sandbox.welcome, panel, 'the fixed editor survives');
  assert.equal(sandbox.welcomeReady, false, 'state publication waits for the new handshake');
  assert.equal(clears, 1); assert.equal(reveals, 1);
  const refreshed = panel.webview.html;
  sandbox.vscode.commands.executeCommand = async () => { sandbox.welcome = undefined; };
  await sandbox.reloadConversation();
  assert.equal(panel.webview.html, refreshed, 'a disposed panel is never written after awaiting context');
});
