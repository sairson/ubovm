import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, createBrowserTools } from '../index.mjs';

test('large Unicode console entries paginate inside the tool envelope without losing entries or cursors', async () => {
  const manager = new BrowserManager();
  const state = { consoleEntries: Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1, level: index % 2 ? 'warning' : 'log', text: '消息😀'.repeat(1000),
  })), consoleSequence: 20, consoleDroppedThrough: 0 };
  const [tool] = createBrowserTools({ sessionId: 'test', workerId: 'test', manager: {
    call: (_scope, input) => manager.consoleEntries(state, input),
  } });
  let cursor = 0, hasMore = true;
  const seen = [];
  while (hasMore) {
    const result = await tool.execute('logs', { action: 'console', after_sequence: cursor, limit: 200 });
    assert.ok(Buffer.byteLength(result.content[0].text) < 60 * 1024);
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.truncated, undefined);
    assert.ok(page.next_sequence > cursor);
    seen.push(...page.entries.map(entry => entry.sequence));
    cursor = page.next_sequence; hasMore = page.has_more;
  }
  assert.deepEqual(seen, state.consoleEntries.map(entry => entry.sequence));
  const cleared = manager.consoleEntries(state, { level: 'warning', clear: true, limit: 1 });
  assert.deepEqual(cleared.entries.map(entry => entry.sequence), [2]);
  assert.equal(state.consoleEntries.length, 19);
  assert.ok(state.consoleEntries.some(entry => entry.sequence === 1));
  assert.equal(manager.consoleEntries(state, { query: 'missing' }).next_sequence, 20);
});
