'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { normalize, text } = require('../webview/errors.js');
const source = readFileSync(require.resolve('../extension.cjs'), 'utf8');
const handler = source.slice(source.indexOf('  async function onMessage('), source.indexOf('  const boundPanels'));
function fixture(overrides = {}) {
  const replies = [], notices = [];
  const panel = { webview: { postMessage: async value => { replies.push(value); return true; } } };
  const sandbox = { welcome: panel, normalizeError: normalize, errorText: text, output: { appendLine() {} },
    publishState() {}, vscode: { window: { showErrorMessage: message => notices.push(message) } },
    sessions: { current: () => ({ id: 'a', mode: 'goal' }), get: () => ({ mode: 'goal' }), goalSummaries: () => [] },
    ...overrides };
  runInNewContext(handler, sandbox);
  return { sandbox, replies, notices, send: message => sandbox.onMessage({ requestId: 'test', ...message }) };
}
test('invalid review modes and missing records fail explicitly without success acknowledgments', async () => {
  for (const action of ['reviewCodeChanges', 'openExploration', 'unknownAction']) {
    const f = fixture(); await f.send({ action, sessionId: 'a' });
    assert.equal(f.replies.length, 1); assert.equal(f.replies[0].ok, false);
    assert.equal(f.replies[0].failure.action, action); assert.equal(f.notices.length, 0);
  }
});
test('replies remain bound to the requesting page during asynchronous operations', async () => {
  let finish;
  const f = fixture({ copyText: () => new Promise(resolve => { finish = resolve; }) });
  const operation = f.send({ action: 'copyText', text: 'test' });
  const other = [];
  f.sandbox.welcome = { webview: { postMessage: async value => other.push(value) } };
  finish(); await operation;
  assert.equal(f.replies[0].ok, true); assert.equal(other.length, 0);
});
test('stale background selections do not create unknown action errors', async () => {
  const f = fixture(); await f.send({ action: 'blackboardDetail', sessionId: 'deleted', requestId: undefined });
  assert.equal(f.replies.length, 0); assert.equal(f.notices.length, 0);
});
test('browser installation wrapper failures return actionable page results', async () => {
  const f = fixture({ installBrowser: async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); } });
  await f.send({ action: 'settingsInstallBrowser' });
  assert.equal(f.replies[0].type, 'settingsBrowserInstallResult');
  assert.equal(f.replies[0].ok, false); assert.match(f.replies[0].message, /无法连接/);
});
