import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../../blackboard/blackboard.mjs';
import { buildExplorationAgenda } from '../../blackboard/agenda.mjs';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createAgendaTool } from '../agenda-tool.mjs';

const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

async function fixture() {
  const board = new Blackboard({ sessionId: 'agenda-tool', goal: 'verify' });
  const pending = await board.createIntent({ description: 'Audit headers', keyPoints: ['headers'] });
  const store = new MemoryStore({ sessionId: 'agenda-tool' });
  const build = () => buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  return { board, store, pending, tool: createAgendaTool({ store, build, sessionId: 'agenda-tool' }) };
}

test('exploration_todo lists projected intent status and recorded directions', async () => {
  const { tool } = await fixture();
  const before = await tool.execute('list', { action: 'list' });
  const data = before.details;
  // The pending intent is projected as planned.
  assert.equal(data.counts.planned, 1);
  assert.match(textOf(before), /# Shared exploration agenda/);
  const written = await tool.execute('write', { action: 'write', items: [
    { id: 'headers', content: 'Check cache headers on the edge', dedupe_key: 'edge cache headers', method: 'fetch twice', acceptance: 'two cache states observed' }
  ] });
  assert.equal(written.details.directions.length, 1);
  assert.equal(written.details.directions[0].status, 'planned');
  assert.match(written.details.directions[0].dedupe_key, /edge cache headers/);
  const listed = await tool.execute('list', { action: 'list' });
  const direction = listed.details.open.find(item => item.kind === 'direction');
  assert.equal(direction.title, 'Check cache headers on the edge');
  assert.equal(direction.method, 'fetch twice');
});

test('exploration_todo updates and drops Reason directions atomically', async () => {
  const { tool, store } = await fixture();
  await tool.execute('write', { action: 'write', items: [
    { id: 'one', content: 'Direction one' },
    { id: 'two', content: 'Direction two' }
  ] });
  const updated = await tool.execute('update', { action: 'update', direction_id: 'one', status: 'done', acceptance: 'verified twice' });
  assert.equal(updated.details.updated.status, 'done');
  assert.equal(updated.details.updated.acceptance, 'verified twice');
  assert.equal(store.snapshot(['agenda']).agenda.length, 2);
  await tool.execute('update', { action: 'update', direction_id: 'two', status: 'dropped' });
  assert.equal(store.snapshot(['agenda']).agenda.find(entry => entry.id === 'two').status, 'dropped');
  await assert.rejects(tool.execute('update', { action: 'update', direction_id: 'missing', status: 'done' }), /was not found/);
  await assert.rejects(tool.execute('update', { action: 'update', direction_id: 'one', status: 'urgent' }), /Agenda status/);
});

test('exploration_todo replaces only its own directions and validates input', async () => {
  const { tool, store } = await fixture();
  await tool.execute('write', { action: 'write', items: [{ id: 'one', content: 'First' }] });
  await tool.execute('write', { action: 'write', items: [{ id: 'two', content: 'Second' }] });
  const agenda = store.snapshot(['agenda']).agenda;
  assert.deepEqual(agenda.map(entry => entry.id), ['two']);
  await assert.rejects(tool.execute('write', { action: 'write', items: [] }), /requires 1 to/);
  await assert.rejects(tool.execute('write', { action: 'write', items: [{ id: 'x', content: 'x'.repeat(501) }] }), /at most 500/);
  await assert.rejects(tool.execute('write', { action: 'write', items: [{ id: 'dup', content: 'A' }, { id: 'dup', content: 'B' }] }), /Duplicate/);
  await assert.rejects(tool.execute('nope', { action: 'nope' }), /Unknown exploration_todo action/);
  await assert.rejects(tool.execute('extra', { action: 'list', extra: true }), /Unknown exploration_todo field/);
});
