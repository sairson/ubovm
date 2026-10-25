import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createPiReason } from '../reason_agent.mjs';

const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function respond(content) {
  const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: Date.now() } });
  return stream;
}
const context = {
  data: { goal: 'verify', revision: 2, root: 'n1', nodes: [
    { ref: 'n1', kind: 'root', parents: [] },
    { ref: 'n2', kind: 'intent', parents: ['n1'], intent: { description: 'inspect', status: 'running', keyPoints: ['checked'] } }
  ] },
  resolveId: ref => ref, aliasFor: id => id
};
const decision = { wait: true };
const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });

function fakeControl(overrides = {}) {
  const calls = [];
  return { calls, control: {
    list: () => [{ worker: 'n2', status: 'running', description: 'inspect', priority: 'medium', attempts: 1 }],
    stop: async (worker, reason) => { calls.push(['stop', worker, reason]); return { worker, status: 'stopping', stopped: true }; },
    start: async worker => { calls.push(['start', worker]); return { worker, status: 'running', started: true }; },
    prompt: async (worker, message) => { calls.push(['prompt', worker, message]); return { worker, status: 'restarting', directed: true }; },
    ...overrides
  } };
}

test('Reason can call worker control tools before returning the JSON decision', async () => {
  const { control, calls } = fakeControl();
  const requests = [];
  const events = [];
  let turn = 0;
  const reason = createPiReason({ model, maxRepairs: 0, onEvent: event => events.push(event), streamFn: (requestModel, request) => {
    requests.push(structuredClone(request));
    turn++;
    return turn === 1
      ? respond([tool('call-stop', 'stop_worker', { worker: 'n2', reason: 'redundant' })])
      : turn === 2
        ? respond([tool('call-prompt', 'prompt_worker', { worker: 'n2', message: 'Focus only on TLS.' })])
        : respond([{ type: 'text', text: JSON.stringify(decision) }]);
  } });
  assert.deepEqual(await reason({ context, control }), decision);
  assert.deepEqual(calls, [['stop', 'n2', 'redundant'], ['prompt', 'n2', 'Focus only on TLS.']]);
  assert.equal(requests.length, 3);
  const system = requests[0].messages.find(message => message.role === 'system');
  const systemText = typeof system.content === 'string' ? system.content : system.content.map(part => part.text ?? '').join('');
  assert.match(systemText, /stop_worker/);
  assert.match(systemText, /prompt_worker/);
  const results = requests[2].messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.equal(results[0].isError, false);
  assert.match(results[0].content.map(part => part.text).join(''), /"stopped":true/);
  assert(events.some(event => event.type === 'pi_event'));
});

test('worker tool failures become tool results and the final decision still validates', async () => {
  const { control } = fakeControl({ stop: async () => { throw new Error('Worker n2 is completed; only running or pending workers can be stopped.'); } });
  const requests = [];
  let turn = 0;
  const reason = createPiReason({ model, maxRepairs: 0, streamFn: (requestModel, request) => {
    requests.push(structuredClone(request));
    return ++turn === 1
      ? respond([tool('call-stop', 'stop_worker', { worker: 'n2' })])
      : respond([{ type: 'text', text: JSON.stringify(decision) }]);
  } });
  assert.deepEqual(await reason({ context, control }), decision);
  const failure = requests[1].messages.find(message => message.role === 'toolResult' && message.toolCallId === 'call-stop');
  assert.equal(failure.isError, true);
  assert.match(failure.content.map(part => part.text).join(''), /only running or pending/);
});

test('worker action budget stops a model that loops on control tools', async () => {
  const { control } = fakeControl();
  let calls = 0;
  const reason = createPiReason({ model, maxRepairs: 0, maxWorkerActions: 2, streamFn: () => {
    calls++;
    return respond([tool(`call-list-${calls}`, 'list_workers', {})]);
  } });
  await assert.rejects(reason({ context, control }), { code: 'INVALID_REASON_DECISION' });
  assert(calls <= 2 + 1 + 4, 'bounded worker action turns');
});

test('shared agenda context and exploration_todo are available to Reason', async () => {
  let turn = 0, agendaCalls = 0;
  const requests = [];
  const agendaTool = {
    name: 'exploration_todo', label: 'Shared exploration agenda', description: 'Read the shared agenda and record directions.',
    parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
    async execute(_id, input) {
      agendaCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ action: input.action, planned: 1 }) }], details: { action: input.action } };
    }
  };
  const reason = createPiReason({ model, maxRepairs: 0, extraTools: [agendaTool],
    contextProvider: async () => '# Shared exploration agenda\n- [planned] intent n2 · inspect',
    streamFn: (requestModel, request) => {
      requests.push(structuredClone(request));
      return ++turn === 1
        ? respond([tool('call-agenda', 'exploration_todo', { action: 'list' })])
        : respond([{ type: 'text', text: JSON.stringify(decision) }]);
    } });
  assert.deepEqual(await reason({ context }), decision);
  assert.equal(agendaCalls, 1);
  const messageText = message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  const systemText = messageText(requests[0].messages.find(message => message.role === 'system'));
  assert.match(systemText, /exploration_todo/);
  assert.match(systemText, /shared exploration agenda/i);
  const evidence = messageText(requests[0].messages.find(message => message.role === 'user'));
  assert.match(evidence, /# Shared exploration agenda/);
  assert.match(evidence, /intent n2/);
});

test('complete graph evidence and exploration_graph are wired to Reason', async () => {
  let turn = 0, graphCalls = 0;
  const requests = [];
  const graphTool = {
    name: 'exploration_graph', label: 'Explore the complete graph', description: 'Read graph details.',
    parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
    async execute(_id, input) { graphCalls++; return { content: [{ type: 'text', text: JSON.stringify({ action: input.action, nodes: 2 }) }] }; }
  };
  const reason = createPiReason({ model, maxRepairs: 0, extraTools: [graphTool],
    evidenceProvider: async () => '# Exploration graph (complete topology)\nrevision=1 nodes=2 intents=1 facts=1 edges=1 root=n1 detail=summary\nn1 root "verify"\nn2 intent <-n1 status=pending desc="inspect"',
    streamFn: (requestModel, request) => {
      requests.push(structuredClone(request));
      return ++turn === 1
        ? respond([tool('graph-call', 'exploration_graph', { action: 'overview' })])
        : respond([{ type: 'text', text: JSON.stringify(decision) }]);
    } });
  assert.deepEqual(await reason({ context }), decision);
  assert.equal(graphCalls, 1);
  const textOf = message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  const systemText = textOf(requests[0].messages.find(message => message.role === 'system'));
  assert.match(systemText, /exploration_graph/);
  assert.match(systemText, /COMPLETE exploration graph/);
  const evidence = textOf(requests[0].messages.find(message => message.role === 'user'));
  assert.match(evidence, /# Exploration graph \(complete topology\)/);
  assert.match(evidence, /nodes=2/);
  assert.doesNotMatch(evidence, /"kind":"root"/);
});

test('a missing or malformed worker control surface is rejected', async () => {
  const reason = createPiReason({ model, streamFn: () => respond([{ type: 'text', text: JSON.stringify(decision) }]) });
  await assert.rejects(reason({ context, control: {} }), /control must expose/);
  assert.deepEqual(await reason({ context }), decision);
});
