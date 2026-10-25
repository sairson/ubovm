import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphView, graphNodeRef, graphStats, fullFactContent, renderGraphSubset } from '../graph-view.mjs';

function syntheticSnapshot(pairs = 249) {
  const nodes = [{ id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'verify the complete graph' } }];
  for (let index = 0; index < pairs; index++) {
    const intentId = `intent-${index}`;
    const factId = `fact-${index}`;
    const content = JSON.stringify({
      version: 1, outcome: 'partial', statement: `Statement ${index} ${'detail '.repeat(40)}`,
      coverage: [{ point: `k${index}`, status: 'partial', result: 'needs a second probe' }], evidence: [], limitations: [`limitation ${index}`], nextSteps: [`next ${index}`]
    });
    nodes.push({
      id: intentId, kind: 'intent', parentIds: ['root'], childIds: [factId], resultId: factId, intent: {
        description: `Audit component ${index} ${'context '.repeat(30)}`, keyPoints: [`k${index}`, `j${index}`], priority: 'medium', status: 'completed'
      }, attempts: [{ id: `a-${index}`, status: 'completed' }], fact: null
    });
    nodes.push({
      id: factId, kind: 'fact', parentIds: [intentId], childIds: [], producerId: intentId,
      intent: null, attempts: [], fact: { content }
    });
  }
  nodes.push({ id: 'pending', kind: 'intent', parentIds: ['root'], childIds: [], intent: { description: 'Queued final audit', keyPoints: ['final'], priority: 'high', status: 'pending' }, attempts: [], fact: null });
  return { schemaVersion: 1, sessionId: 'graph-view', goal: 'verify the complete graph', revision: 7, rootId: 'root', nodes };
}

test('the complete graph renderer never drops a node or parent edge', () => {
  const snapshot = syntheticSnapshot();
  assert.equal(snapshot.nodes.length, 500);
  const view = buildGraphView(snapshot, { maxChars: 1_000_000 });
  assert.equal(view.stats.nodes, 500);
  assert.equal(view.stats.edges, 499);
  assert.equal(view.detail, 'full');
  assert.equal(view.overBudget, false);
  const lines = view.text.split('\n');
  const nodeLines = lines.filter(line => /^n\d+ /.test(line));
  assert.equal(nodeLines.length, 500);
  const refs = nodeLines.map(line => Number(line.slice(1).split(' ')[0]));
  assert.deepEqual(refs, Array.from({ length: 500 }, (_, index) => index + 1));
  // Every parent ref resolves to a line in the same render.
  const known = new Set(refs);
  for (const line of nodeLines) {
    for (const match of line.matchAll(/<-([\dn,]+)/g)) {
      for (const ref of match[1].split(',')) assert(known.has(Number(ref.replace(/^n/, ''))), `unknown parent ${ref} in ${line}`);
    }
  }
  assert.match(lines[0], /complete topology/);
  assert.match(lines[1], /nodes=500 intents=250 facts=249 edges=499 root=n1 detail=full omitted_fact_bodies=249/);
  assert.equal(view.stats.omittedFacts, 249);
});

test('budget pressure degrades detail deterministically while preserving topology', () => {
  const snapshot = syntheticSnapshot();
  const full = buildGraphView(snapshot, { maxChars: 2_000_000 });
  const small = syntheticSnapshot(30);
  const smallFull = buildGraphView(small, { maxChars: 2_000_000 });
  const summary = buildGraphView(small, { maxChars: Math.floor(smallFull.text.length * 0.8) });
  const topology = buildGraphView(snapshot, { maxChars: 60000 });
  const tiny = buildGraphView(snapshot, { maxChars: 500 });
  assert.deepEqual([summary.detail, topology.detail], ['summary', 'topology-only']);
  assert.equal(tiny.overBudget, true);
  for (const view of [summary, topology, tiny]) {
    const expected = view === summary ? 62 : 500;
    assert.equal(view.text.split('\n').filter(line => /^n\d+ /.test(line)).length, expected, `${view.detail} keeps every node`);
    assert.match(view.stats.detail, /summary|topology-only/);
  }
  assert.match(summary.text, /detail=summary/);
  assert.match(topology.text, /detail=omitted/);
  assert.doesNotMatch(topology.text, /Statement 0/);
  assert(topology.stats.omittedFacts > 0);
  assert.equal(buildGraphView(small, { maxChars: Math.floor(smallFull.text.length * 0.8) }).text, summary.text, 'rendering is deterministic');
  assert.equal(graphStats(small, { maxChars: Math.floor(smallFull.text.length * 0.8) }).detail, 'summary');
});

test('fact references and subset rendering stay addressable', () => {
  const snapshot = syntheticSnapshot(2);
  assert.equal(graphNodeRef(snapshot, 'n2').node.id, 'intent-0');
  assert.match(fullFactContent(snapshot, 'n3'), /Statement 0/);
  assert.equal(graphNodeRef(snapshot, 'n3').node.kind, 'fact');
  assert.throws(() => graphNodeRef(snapshot, 'n99'), /Unknown graph ref/);
  assert.throws(() => graphNodeRef(snapshot, 'x1'), /look like n3/);
  const subset = renderGraphSubset(snapshot, [snapshot.nodes[2].id, snapshot.nodes[3].id]);
  assert.match(subset, /^n3 fact/m);
  assert.match(subset, /^n4 intent/m);
  assert.equal(subset.split('\n').length, 2);
});
