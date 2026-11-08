import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createHarness } from '../session_manager.mjs';
import { HarnessDatabase } from '../blackboard/database/database.mjs';

const model = { provider: 'fixture', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// A provider response that streams partial text, so the pi Agent emits
// `message_update` events and the session projects transient `reason.event`
// rows for each partial (the behavior that used to grow an unbounded DB).
function streamedResponse(fullText) {
  const stream = new AssistantMessageEventStream();
  const message = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.modelId, usage, stopReason: 'stop', timestamp: Date.now() });
  const split = Math.max(1, Math.floor(fullText.length / 2));
  stream.push({ type: 'text_start', contentIndex: 0, partial: message('') });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: fullText.slice(0, split), partial: message(fullText.slice(0, split)) });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: fullText.slice(split), partial: message(fullText) });
  stream.push({ type: 'text_end', contentIndex: 0, content: fullText, partial: message(fullText) });
  stream.push({ type: 'done', reason: 'stop', message: message(fullText) });
  return stream;
}

test('streaming projections reach listeners but are not persisted as event rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-event-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const decision = JSON.stringify({ intents: [{ description: 'inspect files', parentIds: ['n1'], priority: 'medium', keyPoints: ['checked'] }] });
  const session = await createHarness({
    directory, goal: 'verify event persistence', contextSummary: false, maxRounds: 3,
    reason: { model: { ...model, streamFn: () => streamedResponse(decision) } },
    worker: async () => 'observed one file'
  });
  const seen = [];
  const unsubscribe = session.subscribe(event => seen.push(event.type));
  await session.run().catch(() => {});
  unsubscribe();
  const sessionId = session.id;
  await session.close();

  const database = await HarnessDatabase.open({ filePath: join(directory, 'harness.sqlite') });
  try {
    const persisted = database.events(sessionId, { limit: 1000 }).map(event => event.type);
    // Live listeners still receive every streamed partial...
    assert.ok(seen.includes('reason.event'), 'live listeners receive streaming projections');
    // ...but the durable event log only keeps lifecycle/state events.
    assert.equal(persisted.includes('reason.event'), false, 'streaming partials must not become durable rows');
    assert.equal(persisted.includes('worker.event'), false, 'worker streaming partials must not become durable rows');
    assert.ok(persisted.some(type => ['session.state', 'reason.start', 'reason.decision', 'blackboard.changed'].includes(type)),
      'durable lifecycle events keep being persisted');
    const sequences = database.events(sessionId, { limit: 1000 }).map(event => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), 'durable events stay ordered by sequence');
  } finally {
    database.close();
  }
});
