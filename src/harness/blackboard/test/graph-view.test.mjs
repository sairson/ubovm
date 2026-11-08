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
  assert.match(lines[1], /nodes=500 intents=250 facts=249 edges=499 root=n1 detail=full/);
  assert.match(lines[1], /budget=\d+\/1000000/);
  assert.match(lines[1], /over_budget=false/);
  assert.match(lines[1], /omitted_ranges=none/);
  assert.match(lines[1], /cites=0/);
  assert.match(lines[1], /omitted_fact_bodies=249/);
  // Completed Workers are archived: one line with status/result, no repeated task prose.
  const completedIntent = nodeLines.find(line => /^n2 .*status=completed/.test(line));
  assert.ok(completedIntent, 'completed intent line is present');
  assert.match(completedIntent, /result=n3/);
  assert.match(completedIntent, /detail=archived/);
  assert.doesNotMatch(completedIntent, /Audit component/);
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
  assert.match(tiny.text, /over_budget=true/);
  assert.equal(tiny.stats.budgetChars, 500);
  assert.doesNotMatch(topology.text, /Statement 0/);
  assert(topology.stats.omittedFacts > 0);
  assert.equal(buildGraphView(small, { maxChars: Math.floor(smallFull.text.length * 0.8) }).text, summary.text, 'rendering is deterministic');
  assert.equal(graphStats(small, { maxChars: Math.floor(smallFull.text.length * 0.8) }).detail, 'summary');
});

test('long campaigns bound topology under an explicit node budget', () => {
  const snapshot = syntheticSnapshot();
  const view = buildGraphView(snapshot, { maxChars: 60000, maxNodes: 60 });
  assert.equal(view.truncated, true);
  assert.equal(view.stats.truncated, true);
  assert.equal(view.stats.nodes, 500);
  assert(view.stats.listedNodes <= 100, 'bounded view keeps only the actionable frontier and recent tail');
  assert.match(view.text, /nodes=500/);
  assert.match(view.text, /truncated=true/);
  assert.match(view.text, /omitted_nodes=/);
  assert.match(view.text, /omitted_ranges=\[[^\]]+\]/);
  assert.match(view.text, /^n1 root/m);
  assert.doesNotMatch(view.text, /^n2 /m, 'older completed entries outside the frontier are omitted');
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

function citationSnapshot() {
  const factA = JSON.stringify({
    version: 1, outcome: 'confirmed', statement: 'Found admin panel',
    coverage: [{ point: 'k1', status: 'confirmed', result: 'panel returns 200' }],
    evidence: [{ toolCallId: 't1', observation: 'GET /admin 200' }]
  });
  const factC = JSON.stringify({
    version: 1, outcome: 'confirmed', statement: 'Admin export is reachable',
    coverage: [{ point: 'k1', status: 'confirmed', result: 'export succeeds' }],
    evidence: [
      { nodeRef: 'n3', observation: 'reuses the admin discovery' },
      { toolCallId: 't2', observation: 'GET /admin/export 200' }
    ]
  });
  return {
    schemaVersion: 1, sessionId: 'cites', goal: 'verify citations', revision: 3, rootId: 'root', nodes: [
      { id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'verify citations' } },
      { id: 'i1', kind: 'intent', parentIds: ['root'], resultId: 'f1', intent: { description: 'discover admin panel', keyPoints: ['k1'], priority: 'high', status: 'completed' }, attempts: [{ id: 'a1', status: 'completed' }], fact: null },
      { id: 'f1', kind: 'fact', parentIds: ['i1'], producerId: 'i1', intent: null, attempts: [], fact: { content: factA } },
      { id: 'i2', kind: 'intent', parentIds: ['f1'], intent: { description: 'probe export endpoint', keyPoints: ['k1'], priority: 'medium', status: 'pending' }, attempts: [], fact: null },
      { id: 'i3', kind: 'intent', parentIds: ['f1'], resultId: 'f3', intent: { description: 'reuse admin session for export', keyPoints: ['k1'], priority: 'medium', status: 'completed' }, attempts: [{ id: 'a3', status: 'completed' }], fact: null },
      { id: 'f3', kind: 'fact', parentIds: ['i3'], producerId: 'i3', intent: null, attempts: [], fact: { content: factC } }
    ]
  };
}

test('cross-fact citations render without changing parent edges', () => {
  const snapshot = citationSnapshot();
  const view = buildGraphView(snapshot, { maxChars: 1_000_000 });
  const factLine = view.text.split('\n').find(line => /^n6 fact/.test(line));
  assert.ok(factLine, 'the citing fact line is rendered');
  assert.match(factLine, /cites=n3/);
  assert.match(view.text.split('\n')[1], /cites=1/);
  // Citations are not parent edges: the headline edge count is still 5.
  assert.match(view.text.split('\n')[1], /edges=5/);
});

test('completed branches still relevant to open work keep a coverage index', () => {
  const snapshot = citationSnapshot();
  const withRelevance = buildGraphView(snapshot, { maxChars: 1_000_000, relevantRefs: new Set(['n3', 'n4']) });
  const expanded = withRelevance.text.split('\n').find(line => /^n2 intent/.test(line));
  assert.match(expanded, /status=completed/);
  assert.match(expanded, /result=n3/);
  assert.match(expanded, /cov=1\/1/);
  assert.match(expanded, /kp=\[k1\]/);
  // Unrelated completed branches stay archived.
  const archived = buildGraphView(snapshot, { maxChars: 1_000_000 }).text.split('\n').find(line => /^n2 intent/.test(line));
  assert.match(archived, /detail=archived/);
  assert.doesNotMatch(archived, /kp=/);
});

