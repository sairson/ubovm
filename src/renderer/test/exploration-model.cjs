const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const context = { window: {} };
runInNewContext(readFileSync(join(__dirname, '../webview/goal/exploration-model.js'), 'utf8'), context);
const project = value => JSON.parse(JSON.stringify(context.window.projectExplorationGraph(value)));

test('native independent results keep durable identity without synthesizing duplicate facts', () => {
  const input = { nodes: [
    { id: 'a', kind: 'intent', resultId: 'f', parentIds: [], intent: { status: 'completed' }, fact: null },
    { id: 'f', kind: 'fact', producerId: 'a', parentIds: ['a'], fact: { content: 'observed' } },
    { id: 'b', kind: 'intent', parentIds: ['f'], intent: { status: 'pending' } }
  ] };
  const result = project(input);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.factCount, 1);
  assert.equal(result.nodes[0].resultId, 'f');
  assert.equal(result.nodes[1].producerId, 'a');
  assert.deepEqual(result.nodes[2].parentIds, ['f']);
});

test('completed intents retain identity while results become independent facts and feed subsequent exploration', () => {
  const input = { rootId: 'root', goal: '目标', nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'a', kind: 'intent', parentIds: ['root'], intent: { status: 'completed', description: '探索 A' }, fact: { content: '证据 A', attemptId: 'attempt-1' } },
    { id: 'b', kind: 'intent', parentIds: ['a', 'external'], intent: { status: 'running' } },
    { id: 'external', kind: 'fact', parentIds: ['root'], fact: { content: '输入事实' } }
  ] };
  const original = JSON.stringify(input), result = project(input), intent = result.nodes.find(n => n.id === 'a');
  assert.equal(intent.kind, 'intent'); assert.equal(intent.fact, null);
  const fact = result.nodes.find(n => n.id === intent.resultId);
  assert.equal(fact.kind, 'fact'); assert.equal(fact.fact.content, '证据 A');
  assert.deepEqual(fact.parentIds, ['a']); assert.equal(fact.producerId, 'a');
  assert.deepEqual(result.nodes.find(n => n.id === 'b').parentIds, [fact.id, 'external']);
  assert.equal(result.intentCount, 2); assert.equal(result.factCount, 2);
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(project(input), result);
});

test('failed or unfinished attempts never create facts; result IDs avoid existing node IDs', () => {
  const result = project({ nodes: [
    { id: 'a', kind: 'intent', intent: { status: 'failed' }, fact: { content: 'not a confirmed result' } },
    { id: 'b', kind: 'intent', intent: { status: 'completed' }, fact: { content: 'result' } },
    { id: 'result:b', kind: 'fact', fact: { content: 'existing' } }
  ] });
  assert.equal(result.nodes.find(n => n.id === 'a').resultId, undefined);
  assert.equal(new Set(result.nodes.map(n => n.id)).size, 4);
  assert.equal(result.nodes.find(n => n.id === 'b').resultId, 'result:result:b');
  assert.equal(project(undefined).nodes.length, 0);
});

test('intent edges connect all source facts to their result; unresolved branches are not facts', () => {
  const result = project({ nodes: [
    { id: 'r', kind: 'root', parentIds: [] },
    { id: 'x', kind: 'fact', parentIds: ['r'], fact: { content: 'input' } },
    { id: 'y', kind: 'fact', parentIds: ['r'], fact: { content: 'control' } },
    { id: 'i', kind: 'intent', parentIds: ['x', 'y'], resultId: 'z', intent: { description: 'compare', status: 'completed' } },
    { id: 'z', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: 'verified' } },
    { id: 'pending', kind: 'intent', parentIds: ['z'], intent: { status: 'running' } }
  ] });
  assert.equal(result.graphNodes.some(n => n.kind === 'intent'), false);
  assert.deepEqual(result.edges.filter(e => e.intentId === 'i').map(e => [e.source, e.target]), [['x', 'z'], ['y', 'z']]);
  assert.equal(result.graphNodes.filter(n => n.kind === 'frontier').length, 1);
  assert.equal(result.factCount, 3);
  assert.equal(result.graphNodes.find(n => n.kind === 'frontier').intentId, 'pending');
});
