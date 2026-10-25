import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerCheckpoint, restoreWorkerCheckpoint } from '../checkpoint.mjs';
import { createPiWorker } from '../worker_pi_agent.mjs';

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

test('interrupted side-effecting calls resume with an explicit unknown-side-effects observation', () => {
  for (const name of ['run_linux_ssh_command', 'edit_workspace_file', 'unknown', 'read_workspace_code']) {
    const input = interrupted(name); input.ledger[0].recovery = 'retry-read-only';
    const restored = restoreWorkerCheckpoint(input, options);
    assert.equal(input.ledger[0].status, 'running', 'input is not mutated');
    assert.equal(restored.ledger[0].status, 'completed');
    assert.equal(restored.ledger[0].isError, true);
    assert.equal(restored.ledger[0].interrupted, true);
    assert.match(restored.ledger[0].result.content[0].text, /side effects are unknown/);
    assert.match(restored.ledger[0].result.content[0].text, /not re-executed/);
    assert.match(restored.ledger[0].result.content[0].text, /new tool call ID/);
    assert.equal(restored.messages.at(-1).role, 'toolResult');
    assert.equal(restored.messages.at(-1).isError, true);
    assert.equal(restored.messages.at(-1).content[0].text, restored.ledger[0].result.content[0].text);
    assert.deepEqual(restoreWorkerCheckpoint(restored, options), restored, 'repair is stable after another restart');
  }
  // A saved recovery flag never authorizes a read-only retry; only the current
  // host tool policy does.
  const flagged = interrupted('read_workspace_code'); flagged.ledger[0].recovery = 'retry-read-only';
  const restored = restoreWorkerCheckpoint(flagged, options);
  assert.match(restored.ledger[0].result.content[0].text, /side effects are unknown/);
  assert.doesNotMatch(restored.ledger[0].result.content[0].text, /read-only tool/);
});

test('interrupted side-effecting calls do not abort worker resumption or execute during recovery', async () => {
  let saved, executions = 0, recorded = 0, request;
  const worker = createPiWorker({ model,
    tools: [{ name: 'run_linux_ssh_command', description: 'run', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return { content: [] }; } }],
    onToolResult: async () => { recorded++; },
    streamFn: (_model, transcript) => { request = transcript; throw new Error('fixture model reached'); } });
  await assert.rejects(worker({ node: { id: 'intent', intent: { description: 'run', keyPoints: ['observed'] } }, attempt: { id: 'attempt' }, checkpoint: interrupted('run_linux_ssh_command'),
    getContext: () => ({ data: { goal: options.goal, nodes: [] }, text: options.goal }), saveCheckpoint: async value => { saved = value; } }), /fixture model reached/);
  assert.equal(executions, 0, 'recovery itself must not execute tools');
  assert.equal(recorded, 0, 'an interrupted error observation must not enter the tool evidence store');
  assert.equal(saved.ledger[0].status, 'completed');
  assert.equal(saved.ledger[0].interrupted, true);
  const recovered = request.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'call-interrupted');
  assert.equal(recovered.isError, true);
  assert.match(recovered.content[0].text, /side effects are unknown/);
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
