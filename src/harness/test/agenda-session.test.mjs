import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createHarness } from '../session_manager.mjs';
import { MemoryStore } from '../intools/shared/store/memory-store.mjs';
import { createDomainInventoryTool } from '../intools/domain-inventory/index.mjs';

const model = { provider: 'fixture', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function respond(content) {
  const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content, api: model.api, provider: model.provider, model: model.modelId, usage, stopReason, timestamp: Date.now() } });
  return stream;
}
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const lastUserText = request => {
  const user = request.messages.filter(message => message.role === 'user').at(-1);
  return typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('');
};
const headersFact = () => JSON.stringify({
  version: 1, outcome: 'confirmed', statement: 'Observed response headers',
  coverage: [{ point: 'headers', status: 'confirmed', result: 'two snapshots agree' }],
  evidence: [{ toolCallId: 'check', observation: 'header oracle passed' }],
  nextSteps: []
});

async function seededInventory(sessionId) {
  const store = new MemoryStore({ sessionId });
  const domains = createDomainInventoryTool({ store, sessionId });
  await domains.execute('bootstrap', { action: 'bootstrap', seeds: ['example.com'] });
  await domains.execute('upsert', { action: 'upsert', hostnames: ['api.example.com'], discovery: 'enum' });
  return store;
}

async function sessionWithSurface(store, streamFn, mode, worker = async () => headersFact()) {
  return createHarness({
    sessionId: store.sessionId,
    goal: 'penetration test example.com',
    contextSummary: false,
    surfaceGate: mode,
    intools: { store },
    reason: { model: { ...model, streamFn } },
    worker
  });
}

async function sessionWithReason(streamFn, worker = async () => 'observed headers') {
  return createHarness({ sessionId: 'agenda-e2e', goal: 'verify headers', contextSummary: false,
    reason: { model: { ...model, streamFn } }, worker });
}

test('exploration mode exposes the shared agenda to Reason and survives a run', async t => {
  let calls = 0;
  const session = await sessionWithReason((requestModel, request) => {
    calls++;
    const system = request.messages.find(message => message.role === 'system');
    const systemText = typeof system?.content === 'string' ? system.content : (system?.content ?? []).map(part => part.text ?? '').join('');
    assert.match(systemText, /exploration_todo/);
    if (calls === 1) {
      const user = request.messages.filter(message => message.role === 'user').at(-1);
      const evidence = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('');
      assert.match(evidence, /# Shared exploration agenda/);
      assert.match(evidence, /# Exploration graph \(complete topology\)/);
      return respond([toolCall('write-agenda', 'exploration_todo', { action: 'write', items: [
        { id: 'headers', content: 'Audit response headers', dedupe_key: 'audit response headers', method: 'fetch twice', acceptance: 'two header snapshots' }
      ] })]);
    }
    if (calls === 2) return respond([{ type: 'text', text: JSON.stringify({ intents: [
      { description: 'Fetch response headers', parentIds: ['n1'], priority: 'medium', keyPoints: ['headers'] }
    ] }) }]);
    const user = request.messages.filter(message => message.role === 'user').at(-1);
    const evidence = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('');
    assert.match(evidence, /# Exploration graph \(complete topology\)/);
    const fact = /(n\d+) fact/.exec(evidence);
    return respond([{ type: 'text', text: JSON.stringify(fact
      ? { complete: true, evidenceIds: [fact[1]], summary: 'headers observed' }
      : { wait: true }) }]);
  });
  t.after(async () => { await session.close(); });
  await session.addIntent({ description: 'Queued header audit', keyPoints: ['queued'], parentIds: [session.snapshot().rootId] });
  const before = session.agenda();
  assert.equal(before.items.some(item => item.kind === 'intent' && item.title === 'Queued header audit' && item.status === 'planned'), true);
  assert.deepEqual(before.items.filter(item => item.kind === 'direction'), []);
  const result = await session.run();
  assert.equal(result.complete, true);
  assert.equal(session.memory().agenda.length, 1);
  assert.equal(session.memory().agenda[0].content, 'Audit response headers');
  const finalAgenda = session.agenda();
  assert(finalAgenda.items.some(item => item.kind === 'direction' && item.title === 'Audit response headers' && item.method === 'fetch twice'));
  assert(finalAgenda.counts.done >= 2);
  const graph = session.graphInfo();
  assert.equal(graph.nodes, session.snapshot().nodes.length);
  assert(['full', 'summary', 'topology-only'].includes(graph.detail));
  assert.equal(graph.edges, session.snapshot().nodes.reduce((sum, node) => sum + node.parentIds.length, 0));
});

test('agenda directions block a duplicate intent description in the same run', async t => {
  let calls = 0;
  const session = await sessionWithReason((requestModel, request) => {
    calls++;
    if (calls === 1) return respond([toolCall('write-agenda', 'exploration_todo', { action: 'write', items: [
      { id: 'headers', content: 'Audit response headers', dedupe_key: 'audit response headers' }
    ] })]);
    return respond([{ type: 'text', text: JSON.stringify({ intents: [
      { description: 'Audit response headers', parentIds: ['n1'], priority: 'medium', keyPoints: ['headers'] }
    ] }) }]);
  });
  t.after(async () => { await session.close(); });
  await assert.rejects(session.run(), error => /shared agenda|duplicates/.test(error.message));
  assert.equal(session.status, 'failed');
  assert.equal(session.memory().agenda.length, 1);
});

test('sidebar intents may only branch from the root or a recorded fact', async t => {
  const session = await createHarness({ sessionId: 'sidebar-parent', goal: 'verify parents', contextSummary: false, reason: async () => ({ wait: true }), worker: async () => 'observed' });
  t.after(async () => { await session.close(); });
  const root = session.snapshot().rootId;
  const first = await session.addIntent({ description: 'first direction', keyPoints: ['k'], parentIds: [root] });
  await assert.rejects(
    session.addIntent({ description: 'second direction', keyPoints: ['k'], parentIds: [first.id] }),
    /root or a recorded fact/
  );
  const fact = await session.addFact({ content: 'recorded fact', parentIds: [root] });
  const third = await session.addIntent({ description: 'third direction', keyPoints: ['k'], parentIds: [fact.id] });
  assert.equal(third.intent.status, 'pending');
});

test('the domain ledger summary reaches Reason and a warn gate records its surface', async t => {
  const store = await seededInventory('surface-warn');
  let calls = 0;
  const session = await sessionWithSurface(store, (requestModel, request) => {
    calls++;
    const evidence = lastUserText(request);
    if (calls === 1) {
      assert.match(evidence, /# Attack surface \(domain ledger, navigation only\)/);
      assert.match(evidence, /hosts=2/);
      assert.match(evidence, /incomplete: example\.com, api\.example\.com/);
      return respond([{ type: 'text', text: JSON.stringify({ intents: [
        { description: 'Fetch response headers', parentIds: ['n1'], priority: 'medium', keyPoints: ['headers'] }
      ] }) }]);
    }
    const fact = /(n\d+) fact/.exec(evidence);
    assert.ok(fact, 'the worker fact must be visible in the next review');
    return respond([{ type: 'text', text: JSON.stringify({ complete: true, evidenceIds: [fact[1]], summary: 'headers observed' }) }]);
  });
  t.after(async () => { await session.close(); });
  const result = await session.run();
  assert.equal(result.complete, true);
  assert.equal(result.surfaceGate.status, 'warn');
  assert.equal(result.surfaceGate.code, 'COVERAGE_INCOMPLETE');
});

test('an enforce gate blocks completion through the coordinator and stops after bounded retries', async t => {
  const store = await seededInventory('surface-enforce');
  let calls = 0;
  const session = await createHarness({
    sessionId: store.sessionId,
    goal: 'penetration test example.com',
    contextSummary: false,
    surfaceGate: 'enforce',
    intools: { store },
    reason: async () => {
      calls++;
      return calls === 1
        ? { intents: [{ description: 'Fetch response headers', parentIds: ['n1'], priority: 'medium', keyPoints: ['headers'] }] }
        : { complete: true, evidenceIds: ['n3'], summary: 'headers observed' };
    },
    worker: async () => headersFact()
  });
  t.after(async () => { await session.close(); });
  await assert.rejects(session.run(), error => error?.code === 'SURFACE_GATE_BLOCKED' || /Coverage gate/.test(error.message));
  assert.equal(session.status, 'failed');
  assert(calls >= 2);
});
