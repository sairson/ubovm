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
