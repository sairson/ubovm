'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../../../extension.cjs'), 'utf8');

test('conversation and project navigation restore before one final publish while serializing later actions', async () => {
  for (const kind of ['conversation', 'project']) {
    let release, active = 'previous';
    const calls = [], recovery = new Promise(resolve => { release = resolve; });
    const sandbox = { messageQueue: Promise.resolve(), sessionsView: undefined, shuttingDown: false,
      settingsPage: '', settingsOpenRevision: 0, settingsOpening: 0, settingsSection: 'model',
      sidebarChanged: { fire() {} }, welcome: undefined, chromeLockedSessionId: undefined, chromeLockWatchdog: undefined,
      sessions: { summary: () => ({ id: active }), current: () => ({ id: active }),
      select: async id => { active = id; calls.push('select'); }, selectProject: async id => { active = id; calls.push('select'); } },
      restoreExecution: async () => { calls.push('restore'); await recovery; },
      openWelcome: async () => { calls.push('view'); }, openAssistant: async () => { calls.push('view'); },
      publishState: () => { calls.push('publish'); },
      setTimeout: () => 1,
      clearTimeout() {},
      vscode: { commands: { executeCommand: async (command, key, value) => {
        if (command === 'setContext' && key === 'ubovm.contentReady' && value === false) calls.push('lock');
      } } } };
    const start = source.indexOf('  async function lockConversationChrome() {');
    vm.runInNewContext(source.slice(start, source.indexOf('  async function deleteConversation', start)), sandbox);
    const pending = kind === 'project' ? sandbox.openProject('next') : sandbox.selectConversation('next');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['select', 'lock', 'view', 'publish', 'restore']);
    let later = false; const queued = sandbox.messageQueue.then(() => { later = true; });
    assert.equal(later, false); release(); await pending; await queued;
    assert.equal(later, true);
    assert.deepEqual(calls, ['select', 'lock', 'view', 'publish', 'restore', 'publish']);
  }
});

test('new project command opens the shared webview project switcher create flow', async () => {
  const start = source.indexOf("registerCommand('ubovm.newProject', async options => {");
  const end = source.indexOf("    registerCommand('ubovm.newProjectConversation'", start);
  const block = source.slice(start, end).trim().replace(/,$/, '');
  const calls = [];
  const sandbox = {
    creatingProject: false,
    registerCommand: (_, callback) => { sandbox.create = callback; },
    openProjectSwitcher: async options => { calls.push(options); return options; }
  };
  vm.runInNewContext(block, sandbox);
  await sandbox.create({ suggestedName: 'Demo' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].create, true);
  assert.equal(calls[0].query, 'Demo');
  calls.length = 0;
  await sandbox.create();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].create, true);
  assert.equal(calls[0].query, undefined);
});
