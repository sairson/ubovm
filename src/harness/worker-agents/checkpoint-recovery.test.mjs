import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerCheckpoint, restoreWorkerCheckpoint } from './checkpoint.mjs';
import { createPiWorker } from './worker_pi_agent.mjs';

const options = { intentId: 'intent', goal: 'read code' };
const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };
function interrupted(name = 'read_workspace_code') {
  const checkpoint = createWorkerCheckpoint(options);
  checkpoint.phase = 'execute'; checkpoint.plan = [{ description: 'read file', doneWhen: 'observed' }];
  checkpoint.ledger = [{ toolCallId: 'call-interrupted', toolName: name, args: { path: 'app.js' }, status: 'running' }];
  checkpoint.messages = [{ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-interrupted', name, arguments: { path: 'app.js' } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  return checkpoint;
}

test('legacy interrupted read recovers as an explicit error without fabricating a result', () => {
  const input = interrupted();
  const restored = restoreWorkerCheckpoint(input, { ...options, retryableReadTools: ['read_workspace_code'] });
  assert.equal(input.ledger[0].status, 'running');
  assert.equal(restored.ledger[0].status, 'completed');
  assert.equal(restored.messages.at(-1).isError, true);
  assert.match(restored.messages.at(-1).content[0].text, /read the latest state/);
  assert.deepEqual(restoreWorkerCheckpoint(restored, options), restored, 'repair is stable after another restart');
});

test('writes, unknown tools and checkpoint-provided recovery flags cannot bypass replay protection', () => {
  for (const name of ['edit_workspace_file', 'unknown', 'read_workspace_code']) {
    const input = interrupted(name); input.ledger[0].recovery = 'retry-read-only';
    assert.throws(() => restoreWorkerCheckpoint(input, options), { code: 'UNSAFE_TOOL_REPLAY' });
  }
  assert.throws(() => restoreWorkerCheckpoint(interrupted('edit_workspace_file'), { ...options, retryableReadTools: ['read_workspace_code'] }), { code: 'UNSAFE_TOOL_REPLAY' });
});

test('safe read repair still validates transcript identity and arguments', () => {
  const input = interrupted(); input.messages[0].content[0].arguments.path = 'different.js';
  assert.throws(() => restoreWorkerCheckpoint(input, { ...options, retryableReadTools: ['read_workspace_code'] }), { code: 'INVALID_CHECKPOINT' });
});

test('worker uses current host policy and persists the repaired read before the next model call', async () => {
  let saved, executions = 0;
  const worker = createPiWorker({ model,
    tools: [{ name: 'read_workspace_code', recovery: 'retry-read-only', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return { content: [] }; } }],
    streamFn: () => { assert.equal(saved.ledger[0].isError, true); throw new Error('fixture model reached'); } });
  await assert.rejects(worker({ node: { id: 'intent', intent: { description: 'read', keyPoints: ['observed'] } }, attempt: { id: 'attempt' }, checkpoint: interrupted(),
    getContext: () => ({ data: { goal: options.goal, nodes: [] }, text: options.goal }), saveCheckpoint: async value => { saved = value; } }), /fixture model reached/);
  assert.equal(executions, 0, 'recovery itself must not execute tools');
  assert.doesNotThrow(() => restoreWorkerCheckpoint(saved, options));
});
