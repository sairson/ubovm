import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiWorker } from '../worker_pi_agent.mjs';
import { createWorkerCheckpoint, restoreWorkerCheckpoint } from '../checkpoint.mjs';
import { createHarness } from '../../session_manager.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };
const node = { id: 'intent', intent: { description: 'inspect', keyPoints: ['evidence'] } };
function args(checkpoint, saveCheckpoint) {
  return { node, attempt: { id: 'attempt' }, checkpoint, saveCheckpoint,
    getContext: () => ({ data: { goal: 'verify', nodes: [] }, text: 'verify' }) };
}
function toolStream() {
  const stream = new AssistantMessageEventStream();
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'toolCall', id: 'call', name: 'inspect', arguments: {} }], stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'done', reason: 'toolUse', message }); return stream;
}
test('default checkpoints retain and restore more than 2 MiB without losing evidence', async () => {
  const checkpoint = createWorkerCheckpoint({ intentId: node.id, goal: 'verify' });
  checkpoint.completed.push({ step: { description: 'inspect', doneWhen: 'observed' }, output: 'x'.repeat(3 * 1024 * 1024) });
  let saved;
  const worker = createPiWorker({ model, streamFn: () => { throw new Error('fixture stopped model'); } });
  await assert.rejects(worker(args(checkpoint, async value => { saved = value; })), /fixture stopped model/);
  assert.equal(restoreWorkerCheckpoint(saved, { intentId: node.id, goal: 'verify' }).completed[0].output, checkpoint.completed[0].output);
});
test('insufficient checkpoint capacity stops before executing a tool and preserves a safe checkpoint', async () => {
  const checkpoint = createWorkerCheckpoint({ intentId: node.id, goal: 'verify' });
  checkpoint.phase = 'execute'; checkpoint.plan = [{ description: 'inspect', doneWhen: 'observed' }];
  let calls = 0, saved;
  const worker = createPiWorker({ model, streamFn: toolStream, maxCheckpointBytes: 8192, maxToolResultBytes: 4096,
    tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object', properties: {} }, execute: async () => { calls++; return { content: [] }; } }] });
  await assert.rejects(worker(args(checkpoint, async value => { saved = value; })), { code: 'WORKER_CHECKPOINT_LIMIT' });
  assert.equal(calls, 0); assert.deepEqual(saved.ledger, []);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(saved, { intentId: node.id, goal: 'verify' }));
});
test('storage failures retain their cause and still use the infrastructure failure code', async () => {
  const worker = createPiWorker({ model, streamFn: toolStream });
  await assert.rejects(worker(args(undefined, async () => { throw new Error('disk full'); })), error => error.code === 'WORKER_CHECKPOINT_FAILED' && error.message.includes('disk full'));
});
test('one Worker reaching a capacity limit does not interrupt its peers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-capacity-'));
  let session, decisions = 0, completed = false;
  t.after(async () => { await session?.close(); await rm(directory, { recursive: true, force: true }); });
  session = await createHarness({ directory, sessionId: 'capacity', goal: 'verify', intools: false, contextSummary: false,
    reason: async ({ context }) => {
      if (!decisions++) return { intents: ['limited', 'peer'].map(description => ({ description, parentIds: [context.data.root], keyPoints: ['evidence'], priority: 'medium' })) };
      if (!completed) return { wait: true };
      return { complete: true, evidenceIds: context.data.nodes.filter(n => n.kind === 'fact').map(n => n.ref), summary: 'peer completed' };
    },
    worker: async ({ node, signal }) => {
      if (node.intent.description === 'limited') throw Object.assign(new Error('capacity'), { code: 'WORKER_CHECKPOINT_LIMIT' });
      await new Promise(resolve => setTimeout(resolve, 10)); signal.throwIfAborted(); completed = true; return 'peer evidence';
    }
  });
  await session.run(); assert.equal(completed, true);
});
