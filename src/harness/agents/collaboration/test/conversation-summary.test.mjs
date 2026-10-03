import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createModelClient } from '../../../model.mjs';
import { MemoryStore } from '../../../intools/shared/store/memory-store.mjs';
import { createContextSummaryMiddleware } from '../../../middleware/context-summary.mjs';
import { plain, runConversation } from '../conversation.mjs';

function respond(model, content) {
  const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 1 };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}

async function conversation({ summary, history = [], prompt = 'Current user request', hostEvidence = true, signal }) {
  const state = new Map(), requests = [];
  const client = createModelClient({ provider: 'conversation-summary-test', modelId: 'fake-chat', api: 'openai-completions',
    baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn: (model, request) => {
      requests.push(structuredClone(request));
      return respond(model, requests.length === 1
        ? [{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: {} }]
        : [{ type: 'text', text: 'Done.' }]);
    } });
  const admission = () => ({ occupied_slots: 0, max_concurrency: 3, next: null, ready_queue: [], preemptable: [], releasing: [] });
  const workers = hostEvidence
    ? [{ id: 'chat/worker-1', parentId: 'chat', status: 'completed', result: 'WORKER_EVIDENCE ' + 'w'.repeat(1200) },
      { id: 'chat/worker-2', parentId: 'chat', status: 'queued', task: 'queued', priority: 9,
        blocked: { reason: 'concurrency', occupying: 3, preemptable: [] } }]
    : [];
  const result = await runConversation({ client, options: {}, workerId: 'chat', prompt, systemPrompt: 'Follow the user request.',
    history, signal, tools: [{ name: 'inspect', label: 'Inspect', description: 'Inspect deterministic test evidence.',
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'Inspected.' }] }) }],
    ...(hostEvidence ? {
      skills: { instructionProvider: async () => 'Fixed skill instructions.' },
      internal: { contextProvider: async () => 'MEMORY_EVIDENCE ' + 'm'.repeat(1200),
        onToolResult: async () => {}, store: new MemoryStore({ sessionId: 'chat' }) },
    } : {}), summary,
    load: key => state.get(key), save: (key, value) => state.set(key, structuredClone(value)), audit: () => {},
    swarm: { snapshot: () => ({ sessionId: 'chat', workers }),
      settle: async () => {},
      admission,
      inspect: () => ({ workers, admission: admission() }),
    },
  });
  return { result, requests };
}

test('conversation protects its real user request and stable host evidence on every model call', async () => {
  const transforms = [];
  const { result } = await conversation({ summary: { transform: async event => {
    transforms.push(structuredClone({ context: event.context, protectedMessageIndexes: event.protectedMessageIndexes }));
    return event.context;
  } } });
  assert.equal(transforms.length, 2);
  for (const event of transforms) {
    const protectedMessages = event.protectedMessageIndexes.map(index => event.context.messages[index]);
    assert.equal(protectedMessages.length, 3);
    assert.equal(plain(protectedMessages[0]), 'Current user request');
    assert.match(plain(protectedMessages[1]), /^Session memory/);
    assert.match(plain(protectedMessages[2]), /^Swarm execution state/);
  }
  const injected = event => event.context.messages.filter(message => /^(Fixed skill|Session memory|Swarm execution state)/.test(plain(message)));
  assert.deepEqual(injected(transforms[0]), injected(transforms[1]));
  assert.equal(injected(transforms[0]).length, 3);
  assert.ok(injected(transforms[0]).every(message => message.timestamp === 0));
  assert.equal(result.transcript.messages.some(message => /MEMORY_EVIDENCE|WORKER_EVIDENCE|Fixed skill/.test(plain(message))), false);
});

test('repeated worker context is bounded and points to full result retrieval', async () => {
  let observed;
  const { result } = await conversation({ summary: { transform: async event => {
    const message = event.context.messages.find(message => plain(message).startsWith('Swarm execution state'));
    observed = JSON.parse(plain(message).slice(plain(message).indexOf('\n') + 1));
    return event.context;
  } } });
  assert.equal(result.answer, 'Done.');
  const completed = observed.workers.find(worker => worker.id === 'chat/worker-1');
  assert.equal(completed.result.length, 1024);
  assert.equal(completed.resultTruncated, true);
  assert.match(observed.guidance, /read_worker_result/);
  assert.match(observed.guidance, /blocked.reason/);
  assert.equal(observed.admission.next, null);
  assert.equal(observed.workers.find(worker => worker.id === 'chat/worker-2').blocked.reason, 'concurrency');
});

test('conversation protects the real user request without optional host evidence', async () => {
  await conversation({ hostEvidence: false, summary: { transform: async event => {
    assert.equal(event.protectedMessageIndexes.length, 1);
    assert.equal(plain(event.context.messages[event.protectedMessageIndexes[0]]), 'Current user request');
    return event.context;
  } } });
});

test('actual compaction preserves the current request and host evidence while a tool loop advances', async t => {
  const summarized = [];
  const summary = createContextSummaryMiddleware({ triggerTokens: 1000, targetTokens: 500, triggerMessages: 3,
    keepRecentMessages: 1, maxSummaryTokens: 100, summarize: async ({ text }) => { summarized.push(text); return 'Historical evidence retained.'; } });
  t.after(() => summary.close());
  const prompt = 'CURRENT_REQUEST ' + 'p'.repeat(1200);
  const history = [{ role: 'user', content: 'Old request ' + 'a'.repeat(1200), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Old reply ' + 'b'.repeat(1200) }], timestamp: 2 }];
  const { requests } = await conversation({ summary, history, prompt });
  assert.equal(requests.length, 2);
  assert.ok(summarized.length > 0, 'the fixture must compact older history');
  assert.equal(summarized.some(text => /CURRENT_REQUEST|MEMORY_EVIDENCE|WORKER_EVIDENCE/.test(text)), false);
  for (const request of requests) {
    assert.ok(request.messages.some(message => plain(message) === prompt));
    assert.ok(request.messages.some(message => plain(message).includes('MEMORY_EVIDENCE')));
    assert.ok(request.messages.some(message => plain(message).includes('WORKER_EVIDENCE')));
  }
});

test('summary transform failures do not stop the conversational tool loop', async () => {
  let attempts = 0;
  const { result, requests } = await conversation({ summary: { transform: async event => {
    attempts++;
    throw Object.assign(new Error('Summary storage unavailable'), { code: 'CONTEXT_STORAGE_FAILED' });
  } } });
  assert.equal(result.answer, 'Done.');
  assert.equal(requests.length, 2);
  assert.equal(attempts, 2, 'each model call still attempts compaction');
  assert.ok(requests.every(request => request.messages.some(message => plain(message) === 'Current user request')));
});

test('summary abort still interrupts the conversation model call', async () => {
  const controller = new AbortController();
  const cancel = Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
  await assert.rejects(conversation({ summary: { transform: async () => {
    controller.abort(cancel);
    throw cancel;
  } }, signal: controller.signal }), error => error === cancel || error?.code === 'ABORT_ERR' || error?.name === 'AbortError');
});
