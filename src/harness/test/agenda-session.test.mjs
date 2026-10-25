import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createHarness } from '../session_manager.mjs';

const model = { provider: 'fixture', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function respond(content) {
  const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content, api: model.api, provider: model.provider, model: model.modelId, usage, stopReason, timestamp: Date.now() } });
  return stream;
}
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });

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
