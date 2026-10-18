'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHumanQuestions } = require('../../../host/agent/human-questions.cjs');

const details = { conversationId: 'session', workerId: 'worker', toolCallId: 'call', question: 'Pick one', options: [{ label: 'a' }, { label: 'b', description: 'second' }], multiple: false, allowCustom: true };

test('question capacity rejects overload and releases on cancellation', async () => {
  const service = createHumanQuestions({ maxPending: 2 });
  const controller = new AbortController();
  const a = service.request({ ...details, signal: controller.signal }), b = service.request(details);
  await assert.rejects(service.request(details), { code: 'QUESTION_BUSY' });
  assert.equal(service.snapshot('session').length, 2);
  controller.abort();
  assert.deepEqual(await a, { selected: [], custom: '', cancelled: true });
  const c = service.request(details);
  assert.equal(service.snapshot('session').filter(entry => entry.status === 'pending').length, 2);
  service.dispose();
  assert.deepEqual((await Promise.all([b, c])).map(answer => answer.cancelled), [true, true]);
});

test('invalid questions fail closed without reserving capacity', async () => {
  const service = createHumanQuestions({ maxPending: 1 });
  await assert.rejects(service.request({ ...details, options: [] }), TypeError);
  await assert.rejects(service.request({ ...details, options: [{ label: 'x' }, { label: 'x' }] }), TypeError);
  await assert.rejects(service.request({ ...details, signal: {} }), TypeError);
  assert.deepEqual(service.snapshot('session'), []);
  const pending = service.request(details);
  assert.equal(service.snapshot('session').length, 1);
  service.dispose(); assert.equal((await pending).cancelled, true);
});

test('responses return only offered labels and enforce single choice', async () => {
  const service = createHumanQuestions();
  const result = service.request(details);
  const [card] = service.snapshot('session');
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: ['b', 'a', 'forged'] }), true);
  assert.deepEqual(await result, { selected: ['b'], custom: '', cancelled: false });
  assert.equal(service.snapshot('session')[0].status, 'answered');
  service.dispose();
});

test('multiple selection and a custom-only answer are both accepted', async () => {
  const service = createHumanQuestions();
  const multi = service.request({ ...details, multiple: true });
  const multiCard = service.snapshot('session')[0];
  assert.equal(service.respond({ id: multiCard.id, conversationId: 'session', selected: ['a', 'b'] }), true);
  assert.deepEqual(await multi, { selected: ['a', 'b'], custom: '', cancelled: false });

  const custom = service.request({ ...details, toolCallId: 'custom' });
  const customCard = service.snapshot('session').at(-1);
  assert.equal(service.respond({ id: customCard.id, conversationId: 'session', selected: [], custom: '  neither  ' }), true);
  assert.deepEqual(await custom, { selected: [], custom: 'neither', cancelled: false });
  service.dispose();
});

test('empty submissions, wrong sessions and repeated clicks cannot answer a question', async () => {
  const service = createHumanQuestions();
  const result = service.request(details);
  const [card] = service.snapshot('session');
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: [], custom: '   ' }), false);
  assert.equal(service.respond({ id: card.id, conversationId: 'other', selected: ['a'] }), false);
  assert.equal(service.respond({ id: 'missing', conversationId: 'session', selected: ['a'] }), false);
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: ['a'] }), true);
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: ['b'] }), false);
  assert.deepEqual(await result, { selected: ['a'], custom: '', cancelled: false });
  service.dispose();
});

test('abort and disposal cancel outstanding questions and reject late answers', async () => {
  const service = createHumanQuestions(), controller = new AbortController();
  const result = service.request({ ...details, signal: controller.signal });
  const [card] = service.snapshot('session');
  controller.abort();
  assert.deepEqual(await result, { selected: [], custom: '', cancelled: true });
  assert.equal(service.snapshot('session')[0].status, 'cancelled');
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: ['a'] }), false);
  const pending = service.request(details);
  service.dispose();
  assert.equal((await pending).cancelled, true);
  assert.equal((await service.request(details)).cancelled, true);
});

test('snapshots cannot mutate a pending question or smuggle an answer', async () => {
  const service = createHumanQuestions();
  const result = service.request(details);
  const card = service.snapshot('session')[0];
  card.status = 'answered';
  card.options[0].label = 'changed';
  const refreshed = service.snapshot('session')[0];
  assert.equal(refreshed.status, 'pending');
  assert.deepEqual(refreshed.options.map(option => option.label), ['a', 'b']);
  assert.equal(service.respond({ id: card.id, conversationId: 'session', selected: ['b'] }), true);
  assert.deepEqual(await result, { selected: ['b'], custom: '', cancelled: false });
  service.dispose();
});
