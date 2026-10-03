const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const context = { window: {} };
runInNewContext(readFileSync(join(__dirname, '../../../webview/goal/exploration-model.js'), 'utf8'), context);
const project = value => JSON.parse(JSON.stringify(context.window.projectExplorationGraph(value)));

test('spatial collisions preserve brute-force visibility including cell boundaries and oversized boxes', () => {
  const index = context.window.createGraphCollisionIndex(), boxes = [];
  const intersects = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;
  let seed = 41;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 2500; i++) {
    const left = Math.floor(random() * 20000) - 10000, top = Math.floor(random() * 20000) - 10000;
    const box = { left, top, right: left + random() * 600, bottom: top + random() * 300 };
    assert.equal(index.intersects(box), boxes.some(other => intersects(box, other)));
    if (i % 3 === 0) { index.add(box); boxes.push(box); }
  }
  for (const box of [
    { left: 252, right: 256, top: 0, bottom: 10 },
    { left: -1e8, right: 1e8, top: 50000, bottom: 50001 },
    { left: 1e30, right: 1e30, top: 0, bottom: 10 }
  ]) { index.add(box); boxes.push(box); }
  for (const box of [
    { left: 259, right: 260, top: 0, bottom: 10 },
    { left: 260, right: 261, top: 0, bottom: 10 },
    { left: 0, right: 1, top: 50003, bottom: 50004 },
    { left: -1e9, right: 1e9, top: -1e9, bottom: 1e9 }
  ]) assert.equal(index.intersects(box), boxes.some(other => intersects(box, other)));
});

test('spatial queries avoid scanning distant nodes', () => {
  const index = context.window.createGraphCollisionIndex();
  let reads = 0;
  for (let i = 0; i < 10000; i++) index.add({ left: i * 1024, get right() { reads++; return i * 1024 + 240; }, top: 0, bottom: 128 });
  reads = 0;
  for (let i = 0; i < 10000; i++) assert.equal(index.intersects({ left: i * 1024 + 244, right: i * 1024 + 250, top: 0, bottom: 20 }), false);
  assert(reads <= 10000, `expected local candidates only, got ${reads} rectangle checks`);
});

test('directional traces handle joins, pending intents and cycles without including siblings', () => {
  const graph = { graphNodes: ['r', 'a', 'b', 'c'].map(id => ({ id })), edges: [
    { source: 'r', target: 'a' }, { source: 'r', target: 'b' },
    { source: 'a', target: 'c', intentId: 'work' }, { source: 'b', target: 'c', intentId: 'work' }
  ] };
  const trace = (id, direction) => [...context.window.traceExplorationGraph(graph, id, direction)].sort();
  assert.deepEqual(trace('a', 'upstream'), ['a', 'r']);
  assert.deepEqual(trace('a', 'downstream'), ['a', 'c']);
  assert.deepEqual(trace('work', 'upstream'), ['a', 'b', 'r']);
  assert.deepEqual(trace('work', 'downstream'), ['c']);
  graph.graphNodes.push({ id: 'frontier', intentId: 'pending' });
  graph.edges.push({ source: 'c', target: 'frontier', intentId: 'pending' }, { source: 'c', target: 'a' });
  assert.deepEqual(trace('pending', 'upstream'), ['a', 'b', 'c', 'frontier', 'r']);
  assert.deepEqual(trace('missing', 'downstream'), []);
});

test('graph layering visits a long reversed chain once and keeps longest-parent joins', () => {
  let reads = 0;
  const nodes = Array.from({ length: 10000 }, (_, id) => ({ id: String(id), get parentIds() { reads++; return id ? [String(id - 1)] : []; } })).reverse();
  const ranks = context.window.rankExplorationGraph(nodes);
  assert.equal(ranks.get('9999'), 9999);
  assert.equal(reads, nodes.length);
  const joined = context.window.rankExplorationGraph([
    { id: 'join', parentIds: ['root', 'middle', 'middle', 'missing'] },
    { id: 'middle', parentIds: ['root'] }, { id: 'root', parentIds: [] },
    { id: 'cycle-a', parentIds: ['cycle-b'] }, { id: 'cycle-b', parentIds: ['cycle-a'] },
    { id: 'blocked', parentIds: ['join', 'cycle-a'] }
  ]);
  assert.equal(joined.get('join'), 2);
  for (const id of ['cycle-a', 'cycle-b', 'blocked']) assert.equal(joined.get(id), 0);
});

test('linear graph layering agrees with prior layering for varied cyclic and acyclic graphs', () => {
  let seed = 19;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let trial = 0; trial < 100; trial++) {
    const nodes = Array.from({ length: 30 }, (_, id) => ({ id, parentIds: Array.from({ length: Math.floor(random() * 4) }, () => Math.floor(random() * (trial % 2 ? id + 1 : 35))) }));
    const byId = new Map(nodes.map(n => [n.id, n])), expected = new Map(), remaining = new Set(byId.keys());
    while (remaining.size) {
      let advanced = false;
      for (const id of remaining) {
        const parents = byId.get(id).parentIds.filter(p => byId.has(p));
        if (parents.every(p => expected.has(p))) { expected.set(id, parents.length ? Math.max(...parents.map(p => expected.get(p))) + 1 : 0); remaining.delete(id); advanced = true; }
      }
      if (!advanced) { for (const id of remaining) expected.set(id, 0); break; }
    }
    const actual = context.window.rankExplorationGraph(nodes);
    for (const [id, rank] of expected) assert.equal(actual.get(id), rank);
  }
});

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
