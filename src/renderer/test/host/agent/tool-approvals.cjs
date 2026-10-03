'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolApprovals } = require('../../../host/agent/tool-approvals.cjs');
const details = { conversationId: 'session', workerId: 'worker', toolCallId: 'call', toolName: 'run_local_shell_command', args: { command: 'npm test' } };

test('approval capacity rejects overload without evicting requests and returns after cancellation', async () => {
  const service = createToolApprovals({ maxPending: 2 });
  const controller = new AbortController();
  const a = service.request({ ...details, signal: controller.signal }), b = service.request(details);
  for (let i = 0; i < 1000; i++) await assert.rejects(service.request(details), { code: 'APPROVAL_BUSY' });
  assert.equal(service.snapshot('session').length, 2);
  controller.abort(); assert.equal(await a, false);
  const c = service.request(details);
  assert.equal(service.snapshot('session').filter(x => x.status === 'pending').length, 2);
  service.dispose(); assert.deepEqual(await Promise.all([b, c]), [false, false]);
});

test('oversized and unserializable arguments fail closed and release reserved capacity', async () => {
  const service = createToolApprovals({ maxPending: 1, maxArgumentChars: 64 });
  await assert.rejects(service.request({ ...details, args: { text: 'x'.repeat(65) } }), { code: 'APPROVAL_TOO_LARGE' });
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(service.request({ ...details, args: cycle }), TypeError);
  await assert.rejects(service.request({ ...details, signal: {} }), TypeError);
  assert.deepEqual(service.snapshot('session'), []);
  const pending = service.request(details); service.dispose(); assert.equal(await pending, false);
});

test('serialization reentry cannot bypass pending limit', async () => {
  const service = createToolApprovals({ maxPending: 1 }); let nested;
  const result = service.request({ ...details, args: { toJSON() { nested = service.request(details); return {}; } } });
  await assert.rejects(nested, { code: 'APPROVAL_BUSY' });
  assert.equal(service.snapshot('session').length, 1);
  service.dispose(); assert.equal(await result, false);
});

test('serialization cancellation and disposal cannot enqueue orphan approvals', async () => {
  for (const dispose of [false, true]) {
    const service = createToolApprovals(); const controller = new AbortController();
    const result = service.request({ ...details, signal: controller.signal, args: { toJSON() {
      if (dispose) service.dispose(); else controller.abort();
      return {};
    } } });
    assert.equal(await result, false); assert.deepEqual(service.snapshot('session'), []);
    service.dispose();
  }
});

test('changing the input signal cannot detach approval from original cancellation', async () => {
  const service = createToolApprovals(); const controller = new AbortController();
  const input = { ...details, signal: controller.signal };
  const result = service.request(input); input.signal = new AbortController().signal;
  controller.abort(); assert.equal(await result, false); service.dispose();
});

test('completed approval retention stays bounded and cancelled listeners are released', async () => {
  const { getEventListeners } = require('node:events');
  const service = createToolApprovals(); const controller = new AbortController();
  for (let i = 0; i < 2000; i++) {
    const result = service.request({ ...details, signal: controller.signal });
    const card = service.snapshot('session').at(-1);
    service.respond({ id: card.id, conversationId: 'session', decision: 'deny' });
    assert.equal(await result, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  assert.equal(service.snapshot('session').length, 100);
  service.dispose(); assert.deepEqual(service.snapshot('session'), []);
});

test('rejected async UI observers cannot become unhandled approval failures', async () => {
  const service = createToolApprovals({ onChange: async () => { throw new Error('view failed'); } });
  const pending = service.request(details);
  const id = service.snapshot('session')[0].id;
  assert.equal(service.respond({ id, conversationId: 'session', decision: 'approve' }), true);
  assert.equal(await pending, true);
  await new Promise(resolve => setImmediate(resolve));
  service.dispose();
});

test('concurrent requests appear inline and can be decided independently', async () => {
  let updates = 0;
  const service = createToolApprovals({ onChange: () => updates++ });
  const first = service.request(details), second = service.request({ ...details, workerId: 'child', toolCallId: 'second' });
  const cards = service.snapshot('session');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].workerId, 'child');
  assert.equal(service.respond({ id: cards[1].id, conversationId: 'session', decision: 'deny' }), true);
  assert.equal(await second, false);
  assert.equal(service.snapshot('session')[0].status, 'pending');
  service.respond({ id: cards[0].id, conversationId: 'session', decision: 'approve' });
  assert.equal(await first, true);
  assert.equal(service.snapshot('session')[0].status, 'approved');
  assert.equal(updates, 4);
  service.dispose();
});

test('wrong sessions, unknown decisions and repeated clicks cannot authorize calls', async () => {
  const service = createToolApprovals();
  const result = service.request(details), id = service.snapshot('session')[0].id;
  assert.deepEqual(service.snapshot('other'), []);
  for (const response of [{ id, conversationId: 'other', decision: 'approve' }, { id, conversationId: 'session', decision: 'unknown' }, { id: 'old', conversationId: 'session', decision: 'approve' }]) assert.equal(service.respond(response), false);
  service.respond({ id, conversationId: 'session', decision: 'deny' });
  assert.equal(service.respond({ id, conversationId: 'session', decision: 'approve' }), false);
  assert.equal(await result, false);
  service.dispose();
});

test('abort and disposal deny outstanding calls and reject late approvals', async () => {
  const service = createToolApprovals(), controller = new AbortController();
  const result = service.request({ ...details, signal: controller.signal });
  const id = service.snapshot('session')[0].id;
  controller.abort();
  assert.equal(await result, false);
  assert.equal(service.snapshot('session')[0].status, 'cancelled');
  assert.equal(service.respond({ id, conversationId: 'session', decision: 'approve' }), false);
  const pending = service.request(details);
  service.dispose();
  assert.equal(await pending, false);
  assert.equal(await service.request(details), false);
});

test('state snapshots survive reloads, retain full arguments and cannot mutate authorization', async () => {
  const service = createToolApprovals();
  const args = { command: '</pre><script>alert(1)</script>' + 'x'.repeat(20000) };
  const result = service.request({ ...details, args });
  const card = service.snapshot('session')[0];
  card.status = 'approved';
  args.command = 'changed';
  const refreshed = service.snapshot('session')[0];
  assert.equal(refreshed.status, 'pending');
  assert.ok(refreshed.args.includes('x'.repeat(20000)));
  assert.ok(!refreshed.args.includes('changed'));
  service.dispose(); assert.equal(await result, false);
});
