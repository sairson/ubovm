'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../../../extension.cjs'), 'utf8');
const navigation = source.slice(source.indexOf('  async function lockConversationChrome()'), source.indexOf('  async function deleteConversation('));

function fixture() {
  let current = 'first';
  const calls = [];
  const sandbox = {
    messageQueue: Promise.resolve(),
    shuttingDown: false,
    sessionsView: undefined,
    settingsPage: '',
    settingsOpenRevision: 0,
    settingsOpening: 0,
    settingsSection: 'model',
    sidebarChanged: { fire() {} },
    welcome: undefined,
    chromeLockedSessionId: undefined,
    chromeLockWatchdog: undefined,
    setTimeout: () => 1,
    clearTimeout() {},
    sessions: {
      summary: () => ({ id: current }),
      async select(id) { calls.push('select:' + id); current = id; },
      async openRelated(sourceId, id) { calls.push('related:' + sourceId); current = id; }
    },
    async restoreExecution() { calls.push('restore:' + current); },
    async openWelcome() { calls.push('open:' + current); },
    publishState() { calls.push('publish:' + current); return { id: current }; },
    executionPublisher: { schedule(id) { calls.push('execution:' + id); } },
    vscode: { commands: { executeCommand: async (command, key, value) => {
      if (command === 'setContext' && key === 'ubovm.contentReady' && value === false) calls.push('lock');
      return undefined;
    } } }
  };
  vm.runInNewContext(navigation, sandbox);
  return { sandbox, calls };
}

test('conversation navigation restores once and publishes one final snapshot', async () => {
  const f = fixture();
  const result = await f.sandbox.selectConversation('second');
  assert.equal(result, undefined);
  assert.deepEqual(f.calls, ['select:second', 'lock', 'open:second', 'publish:second', 'restore:second', 'execution:second']);
});

test('reopening the selected conversation skips execution recovery and preserves related validation', async () => {
  const f = fixture();
  await f.sandbox.selectConversation('first', 'source');
  assert.deepEqual(f.calls, ['related:source', 'open:first', 'publish:first']);
});

test('a failed navigation does not block the next queued selection', async () => {
  const f = fixture();
  f.sandbox.restoreExecution = async () => { throw Error('recovery failed'); };
  await assert.rejects(f.sandbox.selectConversation('second'), /recovery failed/);
  f.sandbox.restoreExecution = async () => { f.calls.push('restore:' + f.sandbox.sessions.summary().id); };
  await f.sandbox.selectConversation('third');
  assert.ok(f.calls.includes('select:third'));
});
