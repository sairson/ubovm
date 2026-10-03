import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { runCollaboration } from '../index.mjs';

const plain = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const results = (request, name) => request.messages.filter(message => message.role === 'toolResult' && message.toolName === name);

function respond(model, content) {
  const stopReason = Array.isArray(content) ? 'toolUse' : 'stop';
  const message = { role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message });
  return stream;
}

const modelConfiguration = (modelId, streamFn) => ({ provider: 'collaboration-recovery-test', modelId,
  api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn });

async function fixture(t, configuration) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'ubovm-collaboration-recovery-'));
  t.after(async () => {
    const location = relative(parent, directory);
    assert(location && !location.startsWith('..') && !isAbsolute(location));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, sessionId: randomUUID(), workspaceRoots: [], configuration: { intools: false, contextSummary: false, ...configuration } };
}

test('a new turn exposes interrupted child effects and reads durable evidence without replaying the operation', async t => {
  const controller = new AbortController();
  const resource = 'unresolved-resource-482';
  let recovering = false, effects = 0, childCalls = 0, recoveryCalls = 0, workerId, durableEvidence;
  const options = await fixture(t, {
    model: modelConfiguration('chat', (model, request) => {
      if (recovering) {
        recoveryCalls++;
        assert.match(request.messages.map(plain).join('\n'), new RegExp(resource), 'restored Chat must see the interrupted child call arguments');
        const evidence = results(request, 'read_worker_evidence').at(-1);
        if (!evidence) return respond(model, [toolCall('inspect-interrupted-child', 'read_worker_evidence', { worker_id: workerId, limit: 1 })]);
        assert.equal(evidence.isError, false);
        durableEvidence = JSON.parse(plain(evidence));
        return respond(model, 'The prior child operation may have taken effect. I inspected its record without repeating it.');
      }
      if (request.messages.some(message => message.role === 'system' && plain(message).includes('You are a Swarm Worker'))) {
        childCalls++;
        return respond(model, [toolCall('child-effect', 'apply_effect', { resource })]);
      }
      if (!results(request, 'spawn_worker').length) return respond(model, [toolCall('spawn-effect-worker', 'spawn_worker', { task: 'Perform the assigned operation.' })]);
      return respond(model, [toolCall('wait-for-effect-worker', 'wait_workers')]);
    }),
    tools: [{ name: 'apply_effect', label: 'Apply test effect', description: 'Apply an operation to the requested resource.',
      parameters: Type.Object({ resource: Type.String() }),
      async execute(_id, input) {
        assert.equal(input.resource, resource);
        effects++;
        // Cancellation occurs after the effect but before the tool-end commit,
        // so persisted running evidence must survive even a successful return.
        controller.abort(new Error('Stopped after child effect'));
        return { content: [{ type: 'text', text: 'Applied the effect.' }] };
      } }],
  });

  await assert.rejects(runCollaboration({ ...options, text: 'Delegate the operation.', signal: controller.signal,
    onEvent: event => { if (event.type === 'swarm.status' && event.workers.length) workerId = event.workers[0].id; },
  }), /stopp|abort|interrupt/i);
  assert.equal(effects, 1);
  assert.equal(childCalls, 1);
  assert.equal(typeof workerId, 'string');

  recovering = true;
  const answer = await runCollaboration({ ...options, text: 'Inspect the previous operation before doing anything else.' });
  assert.match(answer, /without repeating/);
  assert.equal(recoveryCalls, 2, 'recovery should read evidence and then answer');
  assert.equal(durableEvidence.worker_id, workerId);
  assert.equal(durableEvidence.status, 'running');
  assert.equal(durableEvidence.total, 1);
  assert.equal(durableEvidence.nextOffset, null);
  assert.deepEqual(durableEvidence.tools, [{ id: 'child-effect', name: 'apply_effect', status: 'running', args: { resource } }]);
  assert.equal(effects, 1, 'inspection must not repeat the effect');
  assert.equal(childCalls, 1, 'interrupted workers must not be restarted');
});

test('conversation summary retains the configured Worker model fallback', async t => {
  let chatCalls = 0, summaryCalls = 0;
  const options = await fixture(t, {
    model: modelConfiguration('default-chat', model => { chatCalls++; return respond(model, 'The latest request is answered.'); }),
    worker: { model: modelConfiguration('worker-summary', model => {
      summaryCalls++;
      assert.equal(model.id, 'worker-summary');
      return respond(model, 'Earlier turns established the project background.');
    }) },
    contextSummary: { triggerMessages: 4, keepRecentMessages: 2 },
  });
  const messages = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `Earlier turn ${index}: ` + 'Project background. '.repeat(80) }));
  assert.equal(await runCollaboration({ ...options, messages, text: 'Answer the latest request.' }), 'The latest request is answered.');
  assert.equal(chatCalls, 1, 'summary requests must not use the default Chat model');
  assert(summaryCalls > 0, 'older conversation turns should be summarized by the configured Worker model');
});
