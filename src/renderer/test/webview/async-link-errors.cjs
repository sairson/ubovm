const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

test('failed Worker message sends immediately release the pending request and timer', async () => {
  const source = readFileSync(path.join(__dirname, '../../webview/workers/native-panel.js'), 'utf8');
  const start = source.indexOf('  function request(');
  const code = source.slice(start, source.indexOf('  const actionStatus', start));
  let cleared = 0;
  const api = new Function('vscode', 'setTimeout', 'clearTimeout', `let sessionId = 'one', sequence = 0; const pending = new Map(); ${code} return { request, pending };`)(
    { postMessage() { throw Error('bridge unavailable'); } }, () => 123, id => { assert.equal(id, 123); cleared++; });
  await assert.rejects(api.request('copyText', { text: 'copy' }), /bridge unavailable/);
  assert.equal(api.pending.size, 0);
  assert.equal(cleared, 1);
});

test('conversation link failures stay attached to their original session', async () => {
  const source = readFileSync(path.join(__dirname, '../../webview/app.js'), 'utf8');
  const start = source.indexOf('    onOpenLink:');
  const code = source.slice(start, source.indexOf('    onPreviewHtml:', start));
  let reject;
  const errors = [];
  const api = new Function('renderRequest', 'showError', `let currentSessionId = 'old'; const actions = { ${code} }; return { actions, select(id) { currentSessionId = id; } };`)(
    () => new Promise((resolve, fail) => { reject = fail; }), (...args) => errors.push(args));
  const action = api.actions.onOpenLink('file:///example');
  api.select('new'); reject(Error('failed')); await action;
  assert.deepEqual(errors, [['failed', 'old']]);
});

test('Worker link failures do not overwrite a newly selected Worker or session', async () => {
  const source = readFileSync(path.join(__dirname, '../../webview/workers/native-panel.js'), 'utf8');
  const start = source.indexOf('    onOpenLink:');
  const code = source.slice(start, source.indexOf('    onPreviewHtml:', start));
  for (const destination of [['new', 'a'], ['old', 'b'], ['old', 'a']]) {
    let reject;
    const errors = [];
    const api = new Function('request', 'notify', `let sessionId = 'old'; const panel = { selected: 'a' }; const actions = { ${code} }; return { actions, select(session, worker) { sessionId = session; panel.selected = worker; } };`)(
      () => new Promise((resolve, fail) => { reject = fail; }), value => errors.push(value));
    const action = api.actions.onOpenLink('file:///example');
    api.select(...destination); reject(Error('failed')); await action;
    assert.deepEqual(errors, destination[0] === 'old' && destination[1] === 'a' ? ['failed'] : []);
  }
});
