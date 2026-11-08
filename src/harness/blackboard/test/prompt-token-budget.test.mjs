import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { buildExplorationAgenda, renderAgenda } from '../agenda.mjs';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';

const LONG = 'Audit the public export endpoint for missing authorization checks across every tenant query parameter and record the exact request/response pairs for the report ';

async function boardFixture() {
  const board = new Blackboard({ sessionId: 'prompt-budget', goal: 'verify the export endpoint' });
  const pending = await board.createIntent({ description: `${LONG}pending`, keyPoints: ['pending'], priority: 'high' });
  const running = await board.createIntent({ description: `${LONG}running`, keyPoints: ['running'] });
  const runningAttempt = await board.beginAttempt(running.id);
  await board.saveCheckpoint(running.id, runningAttempt.id, { kind: 'ubovm.pi-worker', version: 1, phase: 'execute',
    plan: [{ description: 'Collect the export responses' }, { description: 'Compare tenant scoping' }], completed: [] });
  const done = await board.createIntent({ description: `${LONG}done`, keyPoints: ['done'] });
  const doneAttempt = await board.beginAttempt(done.id);
  await board.completeAttempt(done.id, doneAttempt.id, JSON.stringify({
    version: 1, outcome: 'confirmed', statement: 'the export endpoint returns every tenant',
    coverage: [{ point: 'done', status: 'confirmed', result: 'cross-tenant rows observed' }], evidence: [{ toolCallId: 't1', observation: 'rows' }],
    limitations: ['tenant list incomplete']
  }));
  const failed = await board.createIntent({ description: `${LONG}failed`, keyPoints: ['failed'] });
  const failedAttempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, failedAttempt.id, 'resolver timed out');
  const store = new MemoryStore({ sessionId: 'prompt-budget' });
  await store.commit(state => {
    state.agenda = [{ id: 'direction-1', worker_id: 'reason', content: 'Check cache poisoning via the CDN edge', status: 'active',
      dedupe_key: 'cache poisoning via cdn edge', method: 'send conflicting cache headers', acceptance: 'the edge returns both variants', created_at: 'x', updated_at: 'x' }];
  });
  return { board, store };
}

test('model-facing blackboard context is compact JSON with no information loss', async () => {
  const { board } = await boardFixture();
  const snapshot = board.snapshot();
  const context = buildBlackboardContext(snapshot);
  const pretty = JSON.stringify(context.data, null, 2);
  assert.equal(context.text, JSON.stringify(context.data), 'text must be compact JSON');
  assert.deepEqual(JSON.parse(context.text), context.data, 'every projected field survives serialization');
  assert.equal(context.text.includes('\n  "'), false, 'no pretty-printer indentation reaches the model');
  assert.ok(context.text.length < pretty.length * 0.9, `compact text must save size (${context.text.length} vs ${pretty.length})`);
  // Worker-scope evidence (focused context) is compact too.
  const focusId = snapshot.nodes.find(node => node.intent)?.id;
  const focused = buildBlackboardContext(snapshot, { focusId });
  assert.equal(focused.text, JSON.stringify(focused.data));
  assert.equal(focused.data.exploration, undefined, 'focused context keeps its existing projection');
});

test('compact prompt agenda addresses intents by graph alias and does not repeat descriptions', async () => {
  const { board, store } = await boardFixture();
  const agenda = buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  const full = renderAgenda(agenda);
  const compact = renderAgenda(agenda, { compact: true });
  assert.match(compact, /^# Shared exploration agenda/);
  assert.match(compact, /Open agenda:/);
  assert.match(compact, /intent n\d+/, 'intent lines are alias-addressed');
  assert.doesNotMatch(compact, /Audit the public export endpoint/, 'intent descriptions are not repeated in prompts');
  assert.match(compact, /Check cache poisoning via the CDN edge/, 'Reason-owned direction content stays verbatim');
  assert.match(compact, /method: send conflicting cache headers/);
  assert.match(compact, /current: Collect the export responses/);
  assert.match(compact, /blocker: resolver timed out/);
  assert.ok(compact.length <= full.length * 0.75, `compact agenda must be meaningfully smaller (${compact.length} vs ${full.length})`);
  // The human/tool view keeps the full descriptions it was designed for. The
  // dedupe rule may be reworded, so assert the semantic anchor rather than one
  // exact sentence.
  assert.match(full, /Audit the public export endpoint/);
  assert.match(full, /(?:never rerun|do not rerun|not repeat)[^.\n]*completed/i);
});

test('agenda suggestions carry the source intent alias for compact prompts', async () => {
  const { board, store } = await boardFixture();
  const agenda = buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  const suggestions = agenda.items.filter(item => item.kind === 'suggestion');
  assert.ok(suggestions.length >= 2, 'failed and gap suggestions are generated');
  for (const suggestion of suggestions) assert.match(suggestion.ref ?? '', /^n\d+$/, `${suggestion.id} keeps the source alias`);
  const rendered = renderAgenda(agenda, { compact: true });
  assert.match(rendered, /suggestion n\d+/);
});
