import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../../blackboard/blackboard.mjs';
import { buildGraphView } from '../../blackboard/graph-view.mjs';
import { createExplorationGraphTool } from '../graph-tool.mjs';

async function fixture() {
  const board = new Blackboard({ sessionId: 'graph-tool', goal: 'verify' });
  const long = await board.createIntent({ description: 'Long evidence audit', keyPoints: ['long'] });
  const longAttempt = await board.beginAttempt(long.id);
  const content = '0123456789'.repeat(2000);
  await board.completeAttempt(long.id, longAttempt.id, content);
  const running = await board.createIntent({ description: 'Running TLS audit', keyPoints: ['tls'] });
  const runningAttempt = await board.beginAttempt(running.id);
  await board.saveCheckpoint(running.id, runningAttempt.id, { kind: 'ubovm.pi-worker', version: 1, phase: 'execute', plan: [{ description: 'Collect ciphers' }], completed: [] });
  const failed = await board.createIntent({ description: 'Failed DNS audit', keyPoints: ['dns'] });
  const failedAttempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, failedAttempt.id, 'resolver timed out');
  const build = () => ({ snapshot: board.snapshot() });
  const tool = createExplorationGraphTool({ build, info: () => ({ stats: buildGraphView(board.snapshot(), { maxChars: 1_000_000 }).stats }) });
  return { board, tool, content };
}

test('exploration_graph overviews the complete graph and reads node details', async () => {
  const { tool } = await fixture();
  const overview = await tool.execute('overview', { action: 'overview' });
  assert.equal(overview.details.nodes, 5);
  assert.equal(overview.details.root, 'n1');
  assert.equal(overview.details.counts.running, 1);
  assert.equal(overview.details.counts.failed, 1);
  assert.equal(overview.details.counts.completed, 1);
  const node = await tool.execute('node', { action: 'node', ref: 'n2' });
  assert.match(node.details.intent.description, /Long evidence audit/);
  assert.equal(node.details.result, 'n3');
  const fact = await tool.execute('node', { action: 'node', ref: 'n3' });
  assert.equal(fact.details.fact_chars, 20000);
  await assert.rejects(tool.execute('node', { action: 'node', ref: 'n99' }), /Unknown graph ref/);
});

test('exploration_graph traverses parents, children, subtree and search', async () => {
  const { tool } = await fixture();
  assert.deepEqual((await tool.execute('parents', { action: 'parents', ref: 'n3' })).details.nodes.map(line => line.split(' ')[0]), ['n2']);
  const children = await tool.execute('children', { action: 'children', ref: 'n1' });
  assert.deepEqual(children.details.nodes.map(line => line.split(' ')[0]).sort(), ['n2', 'n4', 'n5']);
  const subtree = await tool.execute('subtree', { action: 'subtree', ref: 'n2', depth: 1 });
  assert.deepEqual(subtree.details.nodes.map(line => line.split(' ')[0]), ['n2', 'n3']);
  // One representation: nodes describe lines only, no rendered duplicate subset.
  assert.equal(Object.hasOwn(subtree.details, 'compact'), false);
  assert.equal(subtree.content[0].text, JSON.stringify(subtree.details));
  const search = await tool.execute('search', { action: 'search', query: 'tls' });
  assert.equal(search.details.matches.length, 1);
  assert.match(search.details.matches[0], /^n4 intent/);
  await assert.rejects(tool.execute('search', { action: 'search' }), /requires query/);
  await assert.rejects(tool.execute('bad', { action: 'nope' }), /Unknown exploration_graph action/);
  await assert.rejects(tool.execute('extra', { action: 'overview', extra: true }), /Unknown exploration_graph field/);
});

test('exploration_graph reads facts in bounded chunks and follows intent results', async () => {
  const { tool, content } = await fixture();
  const first = await tool.execute('read', { action: 'read_fact', ref: 'n2' });
  assert.equal(first.details.ref, 'n3');
  assert.equal(first.details.total, 20000);
  assert.equal(first.details.nextOffset, 12000);
  assert.equal(first.details.content, content.slice(0, 12000));
  const second = await tool.execute('read', { action: 'read_fact', ref: 'n3', offset: first.details.nextOffset, limit: 12000 });
  assert.equal(second.details.nextOffset, null);
  assert.equal(second.details.truncated, false);
  assert.equal(second.details.content, content.slice(12000));
  await assert.rejects(tool.execute('read', { action: 'read_fact', ref: 'n4' }), /has not produced a fact yet/);
});

function citationBoard() {
  const structured = (statement, evidence) => JSON.stringify({
    version: 1, outcome: 'confirmed', statement,
    coverage: [{ point: 'k1', status: 'confirmed', result: `${statement} verified` }],
    evidence
  });
  const nodes = [
    { id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'verify' } },
    { id: 'i1', kind: 'intent', parentIds: ['root'], resultId: 'f1', intent: { description: 'discover admin panel', keyPoints: ['k1'], priority: 'high', status: 'completed' }, attempts: [{ id: 'a1', status: 'completed' }], fact: null },
    { id: 'f1', kind: 'fact', parentIds: ['i1'], producerId: 'i1', intent: null, attempts: [], fact: { content: structured('Found admin panel', [{ toolCallId: 't1', observation: 'GET /admin 200' }]) } },
    { id: 'i2', kind: 'intent', parentIds: ['f1'], intent: { description: 'probe export endpoint', keyPoints: ['k1'], priority: 'medium', status: 'pending' }, attempts: [], fact: null },
    { id: 'i3', kind: 'intent', parentIds: ['f1'], resultId: 'f3', intent: { description: 'reuse admin session', keyPoints: ['k1'], priority: 'medium', status: 'completed' }, attempts: [{ id: 'a3', status: 'completed' }], fact: null },
    { id: 'f3', kind: 'fact', parentIds: ['i3'], producerId: 'i3', intent: null, attempts: [], fact: { content: structured('Admin export is reachable', [{ nodeRef: 'n3', observation: 'reuses n3' }, { toolCallId: 't2', observation: 'export 200' }]) } }
  ];
  return { schemaVersion: 1, sessionId: 'graph-tool-v2', goal: 'verify', revision: 5, rootId: 'root', nodes };
}

test('exploration_graph explains paths, neighbors and can infer the action', async () => {
  const snapshot = citationBoard();
  const tool = createExplorationGraphTool({ build: () => ({ snapshot }) });
  const path = await tool.execute('path', { action: 'path', from: 'n6', to: 'n3' });
  assert.equal(path.details.found, true);
  assert.deepEqual(path.details.nodes, ['n6', 'n3']);
  assert.equal(path.details.edges[0].kind, 'cites');
  assert.equal(path.details.edges[0].observation, 'reuses n3');
  const ancestors = await tool.execute('ancestors', { action: 'path', from: 'n3', to: 'n1' });
  assert.equal(ancestors.details.found, true);
  assert.deepEqual(ancestors.details.nodes, ['n3', 'n2', 'n1']);
  assert.deepEqual(ancestors.details.edges.map(edge => edge.kind), ['parent', 'parent']);
  const missing = await tool.execute('missing', { action: 'path', from: 'n1', to: 'n6', depth: 1 });
  assert.equal(missing.details.found, false);
  assert.match(missing.details.guidance, /No path within the depth limit/);
  const neighbours = await tool.execute('neighbours', { action: 'neighbors', ref: 'n3' });
  const relations = neighbours.details.neighbors.map(entry => entry.relation).sort();
  for (const relation of ['parent', 'child', 'citedBy']) assert(relations.includes(relation), `missing ${relation}`);
  // Action inference keeps common one-off calls terse for the model.
  assert.equal((await tool.execute('infer-node', { ref: 'n3' })).details.node, 'fact');
  assert.equal((await tool.execute('infer-find', { where: 'kind:fact' })).details.total, 2);
  assert((await tool.execute('infer-search', { query: 'admin' })).details.total >= 2);
  assert.equal((await tool.execute('infer-path', { from: 'n6', to: 'n3' })).details.found, true);
});

test('exploration_graph filters, paginates and follows citations', async () => {
  const snapshot = citationBoard();
  const tool = createExplorationGraphTool({ build: () => ({ snapshot }) });
  const facts = await tool.execute('find', { action: 'find', where: 'kind:fact' });
  assert.equal(facts.details.total, 2);
  assert.equal(facts.details.nodes.length, 2);
  const confirmed = await tool.execute('find', { action: 'find', where: 'outcome:confirmed' });
  assert.equal(confirmed.details.total, 2);
  const citing = await tool.execute('find', { action: 'find', where: 'has:cites' });
  assert.equal(citing.details.total, 1);
  assert.match(citing.details.nodes[0], /^n6 fact/);
  await assert.rejects(tool.execute('find', { action: 'find', where: 'severity:high' }), /Unknown filter field/);
  await assert.rejects(tool.execute('find', { action: 'find', where: 'parent:n99' }), /Unknown parent alias/);
  const page = await tool.execute('page', { action: 'page', offset: 1, limit: 2 });
  assert.equal(page.details.total, 6);
  assert.equal(page.details.nodes.length, 2);
  assert.equal(page.details.nextOffset, 3);
  const search = await tool.execute('search', { action: 'search', query: 'admin', limit: 1 });
  assert(search.details.total >= 2);
  assert.equal(search.details.matches.length, 1);
  assert.equal(search.details.nextOffset, 1);
  const dependents = await tool.execute('dependents', { action: 'dependents', ref: 'n3' });
  assert.deepEqual(dependents.details.nodes.map(line => line.split(' ')[0]), ['n6']);
  assert.deepEqual(dependents.details.citations, [{ from: 'n6', to: 'n3', observation: 'reuses n3' }]);
  const sources = await tool.execute('sources', { action: 'sources', ref: 'n6' });
  assert.deepEqual(sources.details.nodes.map(line => line.split(' ')[0]), ['n3']);
  assert.deepEqual(sources.details.citations, [{ from: 'n6', to: 'n3', observation: 'reuses n3' }]);
  const node = await tool.execute('node', { action: 'node', ref: 'n6' });
  assert.equal(node.details.parents.length, 1);
  assert.deepEqual(node.details.cites, ['n3']);
  assert.equal(node.details.coverage.confirmed, 1);
  const overview = await tool.execute('overview', { action: 'overview' });
  assert.equal(overview.details.cites, 1);
  assert.equal(overview.details.dangling_cites, 0);
});

