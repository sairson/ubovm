import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedHistory, interruptedHistory } from '../history.mjs';
const user = content => ({ role: 'user', content });
const answer = content => ({ role: 'assistant', content: [{ type: 'text', text: content }], stopReason: 'stop' });

test('interrupted history preserves partial output and completed results while closing unknown tool outcomes', () => {
  const messages = [user('task'), answer('progress'),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'done', name: 'edit', arguments: {} }, { type: 'toolCall', id: 'unknown', name: 'exec', arguments: {} }], stopReason: 'aborted', errorMessage: 'cancelled' },
    { role: 'toolResult', toolCallId: 'done', content: [{ type: 'text', text: 'saved' }] }];
  const before = structuredClone(messages);
  const result = interruptedHistory(messages).messages;
  assert.deepEqual(result[3], messages[3]);
  assert.equal(result[4].toolCallId, 'unknown'); assert.equal(result[4].isError, true);
  assert.match(result[4].content[0].text, /effects are unknown/);
  assert.equal(result[2].stopReason, 'toolUse'); assert.equal(result[2].errorMessage, undefined);
  assert.deepEqual(messages, before);
});

test('history drops whole old turns while preserving tool exchanges and source messages', () => {
  const messages = [user('old'), answer('old answer'), user('current'),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'result' }] }, answer('done')];
  const before = structuredClone(messages);
  const result = boundedHistory(messages, { maxHistoryMessages: 4 });
  assert.deepEqual(result, { messages: messages.slice(2), omitted: true });
  assert.deepEqual(messages, before);
});

test('byte accounting includes UTF-8 text, JSON escaping and commas at the exact limit', () => {
  const prefix = [user('old'), answer('old response')];
  const current = [user('中文\\"\n'.repeat(8000)), answer('done')];
  const bytes = Buffer.byteLength(JSON.stringify(current));
  assert(bytes > 65536);
  assert.deepEqual(boundedHistory([...prefix, ...current], { maxHistoryBytes: bytes }), { messages: current, omitted: true });
  const clipped = boundedHistory(current, { maxHistoryBytes: bytes - 1 });
  assert.equal(clipped.omitted, true);
  assert(Buffer.byteLength(JSON.stringify(clipped.messages)) <= bytes - 1);
});

test('oversized single turns obey the byte cap for multi-byte and escaped text', () => {
  for (const text of ['中文🙂', '\u0000"\\']) {
    const messages = [user(text.repeat(30000)), answer(text.repeat(30000))];
    const result = boundedHistory(messages, { maxHistoryBytes: 65536 });
    assert.equal(result.omitted, true);
    assert.deepEqual(result.messages.map(message => message.role), ['user', 'assistant']);
    assert(Buffer.byteLength(JSON.stringify(result.messages)) <= 65536);
    assert.equal(messages[0].content, text.repeat(30000));
  }
});

test('oversized metadata fails explicitly instead of writing an unrecoverable history', () => {
  assert.throws(() => boundedHistory([{ ...user('hello'), metadata: 'x'.repeat(70000) }], { maxHistoryBytes: 65536 }), { code: 'COLLABORATION_HISTORY_LIMIT' });
});

test('pruning many turns serializes each message only once', () => {
  let reads = 0;
  const messages = Array.from({ length: 2000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', get content() { reads++; return 'x'.repeat(2000); } }));
  const result = boundedHistory(messages, { maxHistoryBytes: 65536 });
  assert.equal(reads, messages.length);
  assert(result.messages.length < 40);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages.at(-1), messages.at(-1));
});

test('empty and already bounded history preserve omission state and limits remain validated', () => {
  assert.deepEqual(boundedHistory([]), { messages: [], omitted: false });
  const messages = [user('ok'), answer('ok')];
  assert.deepEqual(boundedHistory(messages), { messages, omitted: false });
  assert.throws(() => boundedHistory([], { maxHistoryMessages: 3 }), TypeError);
  assert.throws(() => boundedHistory([], { maxHistoryBytes: 100 }), TypeError);
});
