'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateOrder } = require('../../webview/state-order.js');
const full = (viewRevision, id = 'a', status = 'running') => ({ type: 'state', viewRevision,
  conversation: { id }, execution: { status }, busy: status === 'running', messages: [] });
const delta = (viewRevision, id = 'a', status = 'completed') => ({ type: 'executionState', viewRevision,
  conversationId: id, execution: { status }, busy: status === 'running' });

test('failed receive transactions restore both ordering counters for an identical resync', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  const checkpoint = order.checkpoint();
  order.full(full(3, 'b'), current);
  order.restore(checkpoint);
  current = order.full(full(3, 'b'), current);
  assert.equal(current.conversation.id, 'b');
  const executionCheckpoint = order.checkpoint();
  order.execution(delta(4, 'b'), current);
  order.restore(executionCheckpoint);
  assert.equal(order.execution(delta(4, 'b'), current).execution.status, 'completed');
});

test('invalid fields are downgraded and the revision advances instead of retrying forever', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  for (const invalid of [{ messages: {} }, { relatedConversations: {} }, { context: [] }, { mode: 'invalid' }, { execution: { parts: {} } }]) {
    assert.doesNotThrow(() => { current = order.full({ ...full(2), ...invalid }, current); });
  }
  current = order.full(full(8), current);
  assert.equal(current.conversation.id, 'a');
  assert.doesNotThrow(() => { current = order.full({ ...full(9), messages: {} }, current); });
  assert.doesNotThrow(() => order.execution({ ...delta(10), execution: [] }, current));
  assert.equal(order.execution(delta(11), current).execution.status, 'completed');
});

test('old and duplicate execution updates cannot undo completion or a newer full state', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution(delta(3), current);
  assert.equal(order.execution(delta(2, 'a', 'running'), current), null);
  assert.equal(order.execution(delta(3), current), null);
  current = order.full(full(4, 'a', 'idle'), current);
  assert.equal(order.execution(delta(3), current), null);
  assert.equal(current.execution.status, 'idle');
});

test('late full state refreshes conversation metadata without rolling back newer execution', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution(delta(3), current);
  current = order.full({ ...full(2), messages: ['saved answer'], toolApprovals: ['new approval'] }, current);
  assert.deepEqual(current.messages, ['saved answer']);
  assert.deepEqual(current.toolApprovals, ['new approval']);
  assert.equal(current.execution.status, 'completed'); assert.equal(current.busy, false);
  assert.equal(order.full(full(1), current), null);
});

test('stale full states cannot switch conversations back and foreign deltas consume no revision', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.full(full(3, 'b'), current);
  assert.equal(order.full(full(2), current), null);
  assert.equal(order.execution(delta(100, 'a'), current), null);
  current = order.execution(delta(4, 'b'), current);
  assert.equal(current.conversation.id, 'b'); assert.equal(current.execution.status, 'completed');
});

test('legacy execution fixtures continue to apply without a view revision', () => {
  const order = createStateOrder();
  let current = order.full(full(undefined));
  current = order.execution(delta(undefined), current);
  assert.equal(current.execution.status, 'completed');
  assert.equal(order.full({ viewRevision: 100 }, current), null);
  current = order.full(full(2), current);
  assert.equal(order.full(full(undefined), current), null);
  assert.equal(order.execution(delta(undefined), current).execution.status, 'completed');
});

test('unversioned execution uses seq for deduplication when provided', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution({ ...delta(undefined), seq: 2, execution: { status: 'running' } }, current);
  assert.equal(order.execution({ ...delta(undefined), seq: 2, execution: { status: 'completed' } }, current), null);
  current = order.execution({ ...delta(undefined), seq: 3, execution: { status: 'completed' } }, current);
  assert.equal(current.execution.status, 'completed');
});

test('execution ticks can clear recovering without replacing conversation history', () => {
  const order = createStateOrder();
  let current = order.full({ ...full(1), recovering: true, messages: ['saved'] });
  assert.equal(current.recovering, true);
  current = order.execution({ ...delta(2), recovering: false }, current);
  assert.equal(current.recovering, false);
  assert.deepEqual(current.messages, ['saved']);
  current = order.execution(delta(3, 'a', 'running'), current);
  assert.equal(current.recovering, false);
});
