import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphIndex, collectRelevantRefs } from '../graph-index.mjs';
import { buildExplorationIndex } from '../exploration-index.mjs';

const structured = (statement, evidence) => JSON.stringify({
  version: 1,
  outcome: 'confirmed',
  statement,
  coverage: [{ point: 'k1', status: 'confirmed', result: `${statement} verified` }],
  evidence
});

function syntheticSnapshot() {
  return {
    schemaVersion: 1,
    sessionId: 'graph-index',
    goal: 'verify the index',
    revision: 2,
    rootId: 'root',
    nodes: [
      { id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'verify the index' } },
      { id: 'i1', kind: 'intent', parentIds: ['root'], resultId: 'f1', intent: { description: 'discover admin panel', keyPoints: ['k1'], priority: 'high', status: 'completed' }, attempts: [{ id: 'a1', status: 'completed' }], fact: null },
      { id: 'f1', kind: 'fact', parentIds: ['i1'], producerId: 'i1', intent: null, attempts: [], fact: { content: structured('Found admin panel', [{ toolCallId: 't1', observation: 'GET /admin 200' }]) } },
      { id: 'i2', kind: 'intent', parentIds: ['f1'], intent: { description: 'probe export endpoint', keyPoints: ['k1'], priority: 'medium', status: 'pending' }, attempts: [], fact: null },
      { id: 'i3', kind: 'intent', parentIds: ['f1'], resultId: 'f3', intent: { description: 'reuse admin session', keyPoints: ['k1'], priority: 'medium', status: 'completed' }, attempts: [{ id: 'a3', status: 'completed' }], fact: null },
      { id: 'f3', kind: 'fact', parentIds: ['i3'], producerId: 'i3', intent: null, attempts: [], fact: { content: structured('Admin export is reachable', [{ nodeRef: 'n3', observation: 'reuses n3' }, { toolCallId: 't2', observation: 'export 200' }]) } },
      { id: 'f4', kind: 'fact', parentIds: ['root'], intent: null, attempts: [], fact: { content: 'not json at all' } },
      { id: 'f5', kind: 'fact', parentIds: ['root'], intent: null, attempts: [], fact: { content: structured('Dangling citation', [{ nodeRef: 'n99', observation: 'missing target' }]) } }
    ]
  };
}

test('the index maps refs, parents, children and ids without touching the snapshot', () => {
  const snapshot = syntheticSnapshot();
  const before = JSON.stringify(snapshot);
  const index = createGraphIndex(snapshot);
  assert.equal(index.refById.get('f3'), 'n6');
  assert.equal(index.idByRef.get('n3'), 'f1');
  assert.equal(index.positionById.get('f3'), 5);
  assert.deepEqual(index.parentsOf('f3'), ['i3']);
  assert.deepEqual(index.childrenOf('root'), ['i1', 'f4', 'f5']);
  assert.equal(index.resultOf('i1'), 'f1');
  assert.equal(index.producerOf('f1'), 'i1');
  assert.equal(JSON.stringify(snapshot), before, 'the index is a read-only projection');
});

test('fact views decode once and expose structured and malformed states', () => {
  const index = createGraphIndex(syntheticSnapshot());
  const view = index.factViewOf('f1');
  assert.equal(view.structured, true);
  assert.equal(view.parsed, true);
  assert.equal(view.outcome, 'confirmed');
  assert.equal(view.statement, 'Found admin panel');
  assert.equal(view.coverage.length, 1);
  const malformed = index.factViewOf('f4');
  assert.equal(malformed.malformed, true);
  assert.equal(malformed.parsed, false);
  assert.equal(index.stats.malformedFacts, 1);
});

test('cross-fact citations are indexed bidirectionally and dangling refs counted', () => {
  const index = createGraphIndex(syntheticSnapshot());
  assert.deepEqual(index.citesOf('f3'), ['f1']);
  assert.deepEqual(index.citedByOf('f1'), ['f3']);
  assert.deepEqual(index.citationsOf('f3'), [{ targetId: 'f1', observation: 'reuses n3' }]);
  assert.deepEqual(index.citationsTo('f1'), [{ sourceId: 'f3', observation: 'reuses n3' }]);
  assert.equal(index.stats.cites, 1);
  assert.equal(index.stats.danglingCites, 1);
  // A self citation and a root citation would not create an edge; n99 is already
  // covered by the dangling count.
  assert.deepEqual(index.citesOf('f5'), []);
});

test('navigation nodes reproduce the exploration-index projection contract', () => {
  const index = createGraphIndex(syntheticSnapshot());
  const nodes = index.navigationNodes();
  assert.equal(nodes.length, 8);
  const fact = nodes[2];
  assert.equal(fact.ref, 'n3');
  assert.equal(fact.kind, 'fact');
  assert.equal(fact.producer, 'n2');
  assert.equal(typeof fact.fact, 'string');
  assert.equal(fact.assessment.completionIssue, null);
  assert.deepEqual(fact.assessment.unresolvedKeyPoints, []);
  const exploration = buildExplorationIndex(nodes);
  assert.equal(exploration.activeIntents.includes('n4'), true);
  const relevant = collectRelevantRefs({ snapshot: syntheticSnapshot(), index, exploration });
  assert(relevant.has('n3'), 'facts open work depends on stay relevant');
  assert(relevant.has('n4'), 'open intents stay relevant');
  assert(!relevant.has('n6'), 'unrelated completed results stay archived');
});

test('invalid snapshots are rejected instead of producing a partial index', () => {
  assert.throws(() => createGraphIndex(undefined), /snapshot/i);
  assert.throws(() => createGraphIndex({ schemaVersion: 1, nodes: [{ id: 'a' }, { id: 'a' }] }), /unique/i);
});
