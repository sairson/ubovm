import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createPiReason } from '../reason_agent.mjs';
import { createReasonWorkerTools } from '../worker-tools.mjs';

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
      ? respond([tool('call-stop', 'stop_worker', { worker: 'n2', reason: 'cleanup' })])
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
  // Prompt wording is allowed to evolve; the durable contract is that Reason is
  // told a shared agenda is injected and how to read it, not the exact sentence.
  assert.match(systemText, /shared (?:exploration )?agenda/i);
  assert.match(systemText, /navigation, never evidence/i);
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

test('Reason accepts a validated submit_decision tool call', async () => {
  const events = [];
  const args = { intents: [{ description: 'check tls', parentIds: ['n1'], priority: 'medium', keyPoints: ['tls negotiated'] }] };
  const decisionValue = await createPiReason({ model, maxRepairs: 0, onEvent: event => events.push(event),
    streamFn: () => respond([tool('call-decision', 'submit_decision', args)]) })({ context });
  assert.deepEqual(decisionValue, args);
  assert.equal(events.find(event => event.type === 'reason_decision').viaTool, true);
});

test('submit_decision reports invalid aliases to the model without spending a repair', async () => {
  let turn = 0;
  const events = [];
  const requests = [];
  const bad = { intents: [{ description: 'check tls', parentIds: ['n20'], priority: 'medium', keyPoints: ['tls negotiated'] }] };
  const good = { intents: [{ description: 'check tls', parentIds: ['n1'], priority: 'medium', keyPoints: ['tls negotiated'] }] };
  const reason = createPiReason({ model, maxRepairs: 1, onEvent: event => events.push(event),
    streamFn: (requestModel, request) => {
      requests.push(structuredClone(request));
      return ++turn === 1
        ? respond([tool('call-bad-decision', 'submit_decision', bad)])
        : respond([{ type: 'text', text: JSON.stringify(good) }]);
    } });
  assert.deepEqual(await reason({ context }), good);
  assert.equal(turn, 2);
  assert.equal(events.some(event => event.type === 'reason_repair'), false);
  const textOf = message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  const toolResult = requests[1].messages.find(message => message.role === 'toolResult');
  assert.equal(toolResult.isError, true);
  assert.match(textOf(toolResult), /n20/);
  assert.match(textOf(toolResult), /only valid aliases/);
});

test('list_workers omits completed rounds unless explicitly requested', async () => {
  const control = {
    list: () => [
      { worker: 'n2', status: 'completed', description: 'old audit', result: 'n3' },
      { worker: 'n4', status: 'running', description: 'current audit', priority: 'high' }
    ],
    stop: async () => ({}), start: async () => ({}), prompt: async () => ({})
  };
  const list = createReasonWorkerTools({ control }).find(entry => entry.name === 'list_workers');
  const summary = JSON.parse((await list.execute('list-1', {}, new AbortController().signal)).content[0].text);
  assert.deepEqual(summary.workers.map(worker => worker.worker), ['n4'], 'only actionable Workers are listed');
  assert.equal(summary.completed.count, 1);
  assert.deepEqual(summary.completed.result_aliases, ['n3']);
  const full = JSON.parse((await list.execute('list-2', { include_completed: true }, new AbortController().signal)).content[0].text);
  assert.equal(full.workers.length, 2, 'include_completed restores the archived roster');
  assert.equal(full.completed, 1);
});

test('wait_worker_sleep pauses, reports live Workers and requests a fresh review', async () => {
  const { control } = fakeControl();
  const notified = [];
  let waited = 0;
  const tools = createReasonWorkerTools({ control,
    sleep: async milliseconds => { waited = milliseconds; },
    onSleep: info => notified.push(info) });
  const wait = tools.find(entry => entry.name === 'wait_worker_sleep');
  assert.ok(wait, 'wait_worker_sleep is part of the Reason tool surface');
  const output = await wait.execute('wait-1', { seconds: 5, reason: 'waiting for n2' }, new AbortController().signal);
  assert.equal(waited, 5000);
  assert.deepEqual(notified, [{ seconds: 5, reason: 'waiting for n2' }]);
  const details = JSON.parse(output.content[0].text);
  assert.equal(details.slept_seconds, 5);
  assert.equal(details.workers[0].worker, 'n2');
  assert.match(details.note, /fresh review/);
});

test('wait_worker_sleep wakes early when a Worker settles', async () => {
  const { control: base } = fakeControl();
  let wake;
  const control = { ...base, waitForActivity: signal => new Promise((resolve, reject) => {
    wake = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const notified = [];
  const tools = createReasonWorkerTools({ control,
    sleep: () => new Promise(() => {}),
    onSleep: info => notified.push(info) });
  const wait = tools.find(entry => entry.name === 'wait_worker_sleep');
  const pending = wait.execute('wait-wake', { seconds: 30, reason: 'waiting' }, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  wake();
  const details = JSON.parse((await pending).content[0].text);
  assert.equal(details.interrupted_by_activity, true);
  assert.equal(details.slept_seconds, 0);
  assert.deepEqual(notified, [{ seconds: 30, reason: 'waiting', interrupted: true }]);
});

test('wait_worker_sleep returns guidance instead of failing when no Worker is active', async () => {
  const idle = {
    list: () => [{ worker: 'n1', status: 'completed' }],
    stop: async () => ({}), start: async () => ({}), prompt: async () => ({})
  };
  const tools = createReasonWorkerTools({ control: idle, sleep: async () => { assert.fail('must not sleep'); } });
  const wait = tools.find(entry => entry.name === 'wait_worker_sleep');
  const output = await wait.execute('wait-2', { seconds: 5 }, new AbortController().signal);
  const details = JSON.parse(output.content[0].text);
  assert.equal(details.slept_seconds, 0);
  assert.equal(details.completed, 1);
  assert.match(details.note, /Submit the JSON decision now/);
});

test('stop_worker requires a concrete reason', async () => {
  const { control, calls } = fakeControl();
  const tools = createReasonWorkerTools({ control });
  const stop = tools.find(entry => entry.name === 'stop_worker');
  assert.ok(stop, 'stop_worker is part of the Reason tool surface');
  assert.deepEqual(stop.parameters.required, ['worker', 'reason']);
  assert.equal(stop.parameters.properties.reason.minLength, 1);
  const signal = new AbortController().signal;
  await assert.rejects(stop.execute('stop-missing', { worker: 'n2' }, signal), /requires a concrete reason/);
  await assert.rejects(stop.execute('stop-blank', { worker: 'n2', reason: '   ' }, signal), /requires a concrete reason/);
  assert.deepEqual(calls, [], 'no Worker is stopped without a reason');
  const output = await stop.execute('stop-valid', { worker: 'n2', reason: '  stuck in a retry loop  ' }, signal);
  const details = JSON.parse(output.content[0].text);
  assert.equal(details.reason, 'stuck in a retry loop');
  assert.deepEqual(calls, [['stop', 'n2', 'stuck in a retry loop']]);
});

test('wait_worker_sleep stops the current review so the coordinator re-reads the board', async () => {
  const { control } = fakeControl();
  const reason = createPiReason({ model, maxRepairs: 0, sleep: async () => {},
    streamFn: () => respond([tool('wait-call', 'wait_worker_sleep', { seconds: 5 })]) });
  await assert.rejects(reason({ context, control }), { code: 'REVIEW_REFRESH' });
});
