'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolApprovals } = require('../host/tool-approvals.cjs');
const details = { conversationId: 'session', workerId: 'worker', toolCallId: 'call', toolName: 'run_local_shell_command', args: { command: 'npm test' } };

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
