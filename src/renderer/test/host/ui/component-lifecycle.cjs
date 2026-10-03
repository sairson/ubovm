const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerPanel } = require('../../../host/ui/worker-panel.cjs');
const { createBlackboardSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');

for (const kind of ['worker', 'blackboard']) {
  test(`${kind} component replacement releases subscriptions and disposal is terminal`, async () => {
    let active = 0, registrations = 0, actions = 0;
    const errors = [], views = [];
    const vscode = { commands: { async executeCommand() { actions++; } } };
    const provider = kind === 'worker'
      ? createWorkerPanel(vscode, { readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }] }), onAction() { actions++; }, onError: error => errors.push(error) })
      : createBlackboardSidebar(vscode, { onSelect() { actions++; }, onClose() { actions++; }, onError: error => errors.push(error) });
    function view() {
      const callbacks = {};
      const subscribe = type => fn => {
        active++; registrations++; callbacks[type] = fn; let disposed = false;
        return { dispose() { if (!disposed) { disposed = true; active--; } } };
      };
      const value = { visible: true, callbacks, webview: { onDidReceiveMessage: subscribe('message'), postMessage() {} }, onDidChangeVisibility: subscribe('visibility'), onDidDispose: subscribe('dispose'), show() {} };
      views.push(value); return value;
    }
    for (let i = 0; i < 100; i++) {
      const next = view(); provider.resolveWebviewView(next);
      assert.equal(active, 3, 'only the current page owns listeners');
      const before = registrations; provider.resolveWebviewView(next);
      assert.equal(registrations, before, 'resolving the same page twice does not reload it');
    }
    for (const previous of views.slice(0, -1)) {
      await previous.callbacks.message({ action: kind === 'worker' ? 'copyText' : 'files' });
      previous.callbacks.visibility(); previous.callbacks.dispose();
    }
    assert.equal(actions, 0); assert.equal(active, 3);
    provider.dispose(); provider.dispose(); assert.equal(active, 0);
    await views.at(-1).callbacks.message({ action: kind === 'worker' ? 'copyText' : 'files' });
    provider.resolveWebviewView(view()); assert.equal(active, 0);
    if (kind === 'worker') await assert.rejects(provider.show('a', 'one'), /组件已关闭/);
    else await provider.showFiles();
    assert.equal(actions, 0); assert.deepEqual(errors, []);
  });
}

test('disposing the Worker provider immediately rejects pending loading and ignores late completion', async () => {
  let finish, commands = 0;
  const provider = createWorkerPanel({ commands: { executeCommand() { commands++; return new Promise(resolve => { finish = resolve; }); } } }, {
    readState: () => ({ sessionId: 'one', workers: [{ id: 'a' }] }), onAction() {}, readyTimeout: 1000
  });
  const loading = provider.show('a', 'one');
  const rejected = assert.rejects(loading, /加载已取消/);
  provider.dispose(); await rejected; finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands, 1);
});

for (const kind of ['worker', 'blackboard']) test(`${kind} cleanup and message errors remain isolated when observers fail`, async () => {
  const errors = [], released = [];
  const fail = () => { throw Error('action failed'); };
  const onError = error => { errors.push(error.message); return Promise.reject(Error('observer failed')); };
  const provider = kind === 'worker'
    ? createWorkerPanel({ commands: {} }, { readState: () => ({ sessionId: 'one', workers: [] }), onAction: fail, onError })
    : createBlackboardSidebar({ commands: {} }, { onSelect: fail, onClose: fail, onError });
  let receive;
  function view(broken) {
    const subscription = index => ({ dispose() {
      released.push(index);
      if (broken && index === 0) throw Error('sync cleanup');
      if (broken && index === 1) return Promise.reject(Error('async cleanup'));
    } });
    return { visible: true, webview: {
      postMessage() {}, onDidReceiveMessage(fn) { receive = fn; return subscription(0); }
    }, onDidChangeVisibility() { return subscription(1); }, onDidDispose() { return subscription(2); } };
  }
  provider.resolveWebviewView(view(true));
  if (kind === 'worker') await receive({ action: 'copyText' });
  else await receive({ action: 'files' });
  provider.resolveWebviewView(view(false));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [0, 1, 2]);
  assert(errors.includes('sync cleanup')); assert(errors.includes('async cleanup'));
  provider.dispose(); assert.deepEqual(released, [0, 1, 2, 0, 1, 2]);
});
