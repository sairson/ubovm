import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createModelClient } from '../../../model.mjs';
import { MemoryStore } from '../../../intools/shared/store/memory-store.mjs';
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

async function conversation({ tools, internal, onEvent } = {}) {
  const state = new Map(), requests = [], events = [];
  const client = createModelClient({ provider: 'conversation-tool-resilience', modelId: 'fake-chat', api: 'openai-completions',
    baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn: (model, request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return respond(model, [{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: { path: 'demo' } }]);
      }
      return respond(model, [{ type: 'text', text: 'Recovered after the tool failure.' }]);
    } });
  const result = await runConversation({ client, options: {}, workerId: 'chat', prompt: 'Inspect once', systemPrompt: 'Follow the user request.',
    history: [], tools: tools ?? [{ name: 'inspect', label: 'Inspect', description: 'Inspect evidence.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => { throw new Error('Provider unavailable'); } }],
    internal: internal ?? { contextProvider: async () => null, onToolResult: async () => {}, store: new MemoryStore({ sessionId: 'chat' }) },
    load: key => state.get(key), save: (key, value) => state.set(key, structuredClone(value)),
    audit: () => {}, onEvent: event => { events.push(event); onEvent?.(event); },
    swarm: { snapshot: () => ({ sessionId: 'chat', workers: [] }), settle: async () => {} },
  });
  return { result, requests, events, state };
}

test('thrown tool failures become tool results and the agent continues the turn', async () => {
  const { result, requests } = await conversation();
  assert.equal(result.answer, 'Recovered after the tool failure.');
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find(message => message.role === 'toolResult' && message.toolCallId === 'inspect-1');
  assert.equal(toolResult.isError, true);
  assert.match(plain(toolResult), /Provider unavailable/);
});

test('onToolResult store failures do not abort the conversational tool loop', async () => {
  const observed = [];
  const { result, requests, events } = await conversation({
    tools: [{ name: 'inspect', label: 'Inspect', description: 'Inspect evidence.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }],
    internal: {
      contextProvider: async () => null,
      store: new MemoryStore({ sessionId: 'chat' }),
      onToolResult: async () => { throw Object.assign(new Error('Evidence store unavailable'), { code: 'EVIDENCE_STORE_FAILED' }); },
    },
    onEvent: event => observed.push(event.type),
  });
  assert.equal(result.answer, 'Recovered after the tool failure.');
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find(message => message.role === 'toolResult' && message.toolCallId === 'inspect-1');
  assert.equal(toolResult.isError, false);
  assert.equal(plain(toolResult), 'ok');
  assert.equal(events.some(event => event.type === 'tool_evidence_failed' && event.phase === 'store'), true);
  assert.equal(observed.includes('tool_execution_end'), true);
});
