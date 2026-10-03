'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('batch legacy IDs preserve every previous prefix hash while serializing each record once', () => {
  const filename = require.resolve('../harness/session/sessions.cjs'); let bytes = 0, calls = 0;
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Buffer, structuredClone,
    JSON: { stringify(value) { const text = JSON.stringify(value); bytes += Buffer.byteLength(text); calls++; return text; } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const { inputMessageId, inputMessageIds } = sandbox.module.exports;
  const messages = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
    text: '历史\\\"\n汉字'.repeat(2000), ...(index % 7 === 0 ? { id: 'saved-' + index } : {}) }));
  const expected = messages.map((_, index) => inputMessageId(messages, index));
  const previousBytes = bytes; bytes = calls = 0;
  assert.equal(JSON.stringify(inputMessageIds(messages)), JSON.stringify(expected));
  assert.equal(calls, messages.length);
  assert.ok(bytes < previousBytes / 10, 'batch hashing must avoid repeated prefix serialization');
  bytes = calls = 0;
  const userIds = inputMessageIds(messages, 'user');
  for (let index = 0; index < messages.length; index++) if (messages[index].role === 'user') assert.equal(userIds[index], expected[index]);
  assert.equal(calls, 39, 'the final assistant response does not need user IDs');
  calls = 0;
  const modern = messages.map((message, index) => message.role === 'user' ? { ...message, id: 'modern-' + index } : message);
  inputMessageIds(modern, 'user'); assert.equal(calls, 0, 'identified user messages require no history serialization');
  assert.equal(JSON.stringify(inputMessageIds([])), '[]');
});

test('metadata commits reuse historical byte budgets and message edits budget only the changed history', async () => {
  const filename = require.resolve('../harness/session/sessions.cjs'); let arrays = 0;
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Buffer, structuredClone,
    JSON: { stringify(value) { if (Array.isArray(value)) arrays++; return JSON.stringify(value); } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const vscode = { EventEmitter: class { event() {} fire() {} dispose() {} } };
  const context = { workspaceState: { get(_, fallback) { return fallback; }, async update() {} } };
  const store = sandbox.module.exports.createSessions(vscode, context);
  try {
    await store.ready;
    const first = await store.createProject('项目', 'C:\\cached');
    await store.appendMessage(first.id, { role: 'assistant', text: 'x'.repeat(60000) });
    await store.create(); arrays = 0;
    await store.select(first.id); await store.renameProject(first.projectId, '重命名');
    assert.equal(arrays, 0, 'metadata operations must not serialize unchanged histories for budgeting');
    await store.appendMessage(first.id, { role: 'user', text: '继续' });
    assert.equal(arrays, 1, 'only the edited history needs a new budget');
  } finally { store.dispose(); }
});

test('history byte trimming preserves the original suffix without repeatedly serializing the array', () => {
  const filename = require.resolve('../harness/session/sessions.cjs');
  let arrays = 0, messages = 0;
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Buffer, structuredClone,
    JSON: { parse: JSON.parse, stringify(value) { if (Array.isArray(value)) arrays++; else messages++; return JSON.stringify(value); } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.cleanMessages = cleanMessages;', sandbox);
  const inputs = [[], [{ role: 'user', text: '边界内容' }],
    Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', id: String(i), text: '汉'.repeat(60000) })),
    Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', id: String(i), text: 'x'.repeat(60000) }))];
  for (const input of inputs) {
    arrays = messages = 0;
    const actual = sandbox.module.exports.cleanMessages(input);
    const expected = structuredClone(input);
    while (expected.length > 1 && Buffer.byteLength(JSON.stringify(expected)) > (2 << 20)) expected.shift();
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.ok(arrays <= 1, 'budgeting must not serialize every remaining suffix');
    assert.ok(messages <= input.length, 'each message is budgeted at most once');
  }
});

test('global budget counts empty arrays correctly after removing a session last message', async () => {
  const filename = require.resolve('../harness/session/sessions.cjs');
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Buffer, structuredClone };
  const source = fs.readFileSync(filename, 'utf8').replace('const MAX_ALL_MESSAGE_BYTES = 12 << 20;', 'const MAX_ALL_MESSAGE_BYTES = 100;');
  vm.runInNewContext(source, sandbox);
  const sessions = Array.from({ length: 3 }, (_, i) => ({ id: String(i), mode: 'assist', title: 'budget',
    messages: [{ role: 'user', text: 'x'.repeat(71) }], createdAt: i, updatedAt: i }));
  let saved;
  const vscode = { EventEmitter: class { event() {} fire() {} dispose() {} } };
  const context = { workspaceState: { get(key, fallback) { return key === 'conversations' ? { version: 3, activeMode: 'assist', currentIds: { assist: '0' }, sessions } : fallback; },
    async update(_, value) { saved = value; } } };
  const store = sandbox.module.exports.createSessions(vscode, context);
  try {
    await store.ready;
    const bytes = saved.sessions.reduce((sum, session) => sum + Buffer.byteLength(JSON.stringify(session.messages)), 0);
    assert.ok(bytes <= 100, 'persisted arrays exceed the actual global budget: ' + bytes);
  } finally { store.dispose(); }
});
