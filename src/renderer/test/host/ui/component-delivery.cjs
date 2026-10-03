const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerPanel } = require('../../../host/ui/worker-panel.cjs');
const { createBlackboardSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('a stalled Worker bridge times out and publishes the current snapshot without reopening', async () => {
  const messages = [], errors = [];
  let receive, release, state = { sessionId: 'one', workers: [{ id: 'a', result: 'initial' }] };
  const provider = createWorkerPanel({ commands: {} }, {
    readState: () => state, onAction() {}, onError: error => errors.push(error.message)
  });
  provider.resolveWebviewView({ visible: true, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
    postMessage(message) {
      messages.push(structuredClone(message));
      if (messages.length === 1) return new Promise(resolve => { release = resolve; });
      return true;
    }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose() { return { dispose() {} }; } });
  try {
    const ready = receive({ action: 'ready' });
    state = { ...state, workers: [{ id: 'a', result: 'latest' }] };
    provider.publish(); await ready;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].workers[0].result, 'latest');
    assert.deepEqual(errors, ['Component state delivery timed out']);
    release(false); await nextTurn(); assert.equal(errors.length, 1);
  } finally { provider.dispose(); release?.(); }
});

test('Worker bursts defer snapshot reads and a recreated view is independent of the old bridge', async () => {
  let state = { sessionId: 'one', workers: [{ id: 'a', result: 'first' }] }, reads = 0, release;
  const messages = [], receivers = [], disposals = [], errors = [];
  const provider = createWorkerPanel({ commands: { async executeCommand() {} } }, {
    readState: () => { reads++; return state; }, onAction() {}, onError: e => errors.push(e), readyTimeout: 100
  });
  function view(held) {
    return { visible: true, webview: {
      onDidReceiveMessage(fn) { receivers.push(fn); return { dispose() {} }; },
      postMessage(message) { messages.push(structuredClone(message)); if (held) return new Promise(resolve => { release = resolve; }); }
    }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose(fn) { disposals.push(fn); } };
  }
  provider.resolveWebviewView(view(true));
  const oldReady = receivers[0]({ action: 'ready' });
  for (let i = 0; i < 1000; i++) { state = { ...state, workers: [{ id: 'a', result: String(i) }] }; provider.publish(); }
  assert.equal(messages.length, 1); assert.equal(reads, 1);
  await provider.show('a', 'one');
  const navigationReads = reads;
  disposals[0](); await oldReady;
  state = { sessionId: 'two', workers: [{ id: 'b', result: 'new component' }] };
  provider.resolveWebviewView(view(false)); await receivers[1]({ action: 'ready' });
  release(); await nextTurn();
  assert.equal(messages.length, 2);
  assert.equal(messages.at(-1).sessionId, 'two'); assert.equal(reads, navigationReads + 1);
  assert.deepEqual(errors, []);
});

test('blackboard updates coalesce while a slow bridge retains only the latest session detail', async () => {
  let release;
  const messages = [];
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand() {} } }, { onSelect() {}, onClose() {} });
  sidebar.resolveWebviewView({ webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    postMessage(message) { messages.push(structuredClone(message)); if (messages.length === 1) return new Promise(resolve => { release = resolve; }); }
  }, onDidDispose() {} });
  sidebar.setSession('one');
  for (let i = 0; i < 1000; i++) await sidebar.update({ sessionId: 'one', id: String(i), title: String(i), sections: [], links: [] });
  assert.equal(messages.length, 1);
  sidebar.setSession('two');
  await sidebar.update({ sessionId: 'two', id: 'new', title: 'New', sections: [], links: [] });
  release(); await nextTurn();
  assert.equal(messages.length, 2); assert.equal(messages.at(-1).detail.sessionId, 'two');
});
