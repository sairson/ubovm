'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../../../extension.cjs'), 'utf8');
const open = source.slice(source.indexOf('  async function openSettings('), source.indexOf('  function newChat('));
function fixture() {
  const messages = [], waits = [], snapshots = [];
  const panel = { webview: { postMessage: async message => { messages.push(message); return true; } } };
  const sandbox = { welcome: panel, welcomeReady: false, shuttingDown: false, settingsOpenRevision: 0,
    modelConfiguration: { status: () => ({ configured: true }) },
    readSSHStatus: () => ({ configured: true }), vscode: {},
    openWelcome: async () => {}, setTimeout: resolve => waits.push(resolve),
    settingsConfiguration: { snapshot: () => new Promise(resolve => snapshots.push(resolve)) },
    browserInstaller: { status: () => ({}) }, errorText: String, normalizeError: String, output: { appendLine() {} } };
  vm.runInNewContext(open, sandbox);
  return { sandbox, messages, waits, snapshots };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('settings wait for webview readiness and only the latest click loads', async () => {
  const f = fixture();
  const first = f.sandbox.openSettings('mcp');
  await tick();
  const second = f.sandbox.openSettings('skills');
  await tick();
  assert.equal(f.messages.length, 0);
  f.sandbox.welcomeReady = true;
  f.waits.splice(0).forEach(resolve => resolve());
  await tick();
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.messages[0].page, 'skills');
  f.snapshots[0]({});
  await Promise.all([first, second]);
  assert.deepEqual(f.messages.map(message => message.type), ['settingsLoading', 'openSettings']);
});

test('late settings snapshots cannot replace a newer page', async () => {
  const f = fixture(); f.sandbox.welcomeReady = true;
  const first = f.sandbox.openSettings('mcp'); await tick();
  const second = f.sandbox.openSettings('skills'); await tick();
  f.snapshots[1]({}); await second;
  f.snapshots[0]({}); await first;
  assert.deepEqual(f.messages.filter(message => message.type === 'openSettings').map(message => message.page), ['skills']);
});

test('closing or disposing a loading panel cancels pending navigation', async () => {
  for (const cancel of [f => f.sandbox.settingsOpenRevision++, f => { f.sandbox.welcome = undefined; }]) {
    const f = fixture(); const operation = f.sandbox.openSettings(); await tick();
    cancel(f); f.waits.splice(0).forEach(resolve => resolve()); await operation;
    assert.equal(f.messages.length, 0);
  }
});
