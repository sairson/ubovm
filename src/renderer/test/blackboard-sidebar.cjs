const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlackboardSidebar } = require('../host/blackboard-sidebar.cjs');

test('native details preserve file navigation, reject stale sessions and allow only related-node jumps', async () => {
  const commands = [], messages = [], selections = [];
  let listener, closed = 0;
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    onSelect: (...args) => selections.push(args), onClose: () => closed++
  });
  sidebar.resolveWebviewView({ webview: {
    onDidReceiveMessage(fn) { listener = fn; return { dispose() {} }; },
    postMessage(message) { messages.push(structuredClone(message)); }
  }, onDidDispose() {}, show() {} });
  sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: '事实', meta: '', sections: [], links: [{ id: 'b', label: '来源' }] };
  await sidebar.update(detail, true);
  assert.deepEqual(commands, ['workbench.view.extension.ubovm-blackboard']);
  await sidebar.update({ ...detail, title: '更新事实' }, false);
  assert.equal(commands.length, 1, 'live updates must not reopen the sidebar');
  listener({ action: 'select', sessionId: 'one', id: 'b' });
  listener({ action: 'select', sessionId: 'one', id: 'unrelated' });
  assert.deepEqual(selections, [['b', 'one']]);
  sidebar.setSession('two');
  await sidebar.update(detail, true);
  assert.equal(messages.at(-1).detail, null);
  assert.equal(commands.length, 1);
  await sidebar.showFiles();
  assert.equal(commands.at(-1), 'workbench.view.explorer');
  assert.equal(closed, 1);
});
