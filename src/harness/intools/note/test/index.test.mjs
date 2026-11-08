import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/store/memory-store.mjs';
import { createNoteTool } from '../index.mjs';
import { Blackboard } from '../../../blackboard/blackboard.mjs';

function fixture() {
  const store = new MemoryStore({ sessionId: 'note-types' });
  const tool = createNoteTool({ store, sessionId: store.sessionId });
  const call = async input => (await tool.execute('test', input)).details;
  return { store, tool, call };
}

test('promoted facts use the structured v1 fact shape', async () => {
  const store = new MemoryStore({ sessionId: 'note-promotion' });
  const board = new Blackboard({ sessionId: 'note-promotion', goal: 'verify promotion' });
  await store.commit(state => { state.workers = [{ worker_id: 'worker', root_worker_id: board.snapshot().rootId }]; });
  const tool = createNoteTool({ store, sessionId: store.sessionId, workerId: 'worker', blackboard: board });
  const result = await tool.execute('promote-write', {
    action: 'write', note_type: 'note', content: 'Observed a control',
    promotion_kind: 'fact', outcome: 'confirmed', statement: 'Control observed',
    evidence: ['curl returned 200'], failed_checks: ['no header check'], limitations: ['single sample']
  });
  assert.equal(result.details.status, 'promoted');
  const fact = board.snapshot().nodes.find(node => node.kind === 'fact' && node.id !== board.snapshot().rootId);
  const parsed = JSON.parse(fact.fact.content);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.outcome, 'confirmed');
  assert.deepEqual(parsed.evidence, [{ observation: 'curl returned 200' }]);
  assert.deepEqual(parsed.failedChecks, ['no header check']);
  assert.deepEqual(parsed.limitations, ['single sample']);
  assert.equal(Object.hasOwn(parsed, 'failed_checks'), false);
});

test('notes expose a continuation offset until the final filtered page', async () => {
  const { call } = fixture();
  for (const content of ['match first', 'other', 'match last']) await call({ action: 'write', content });
  const first = await call({ action: 'list', query: 'match', limit: 1 });
  assert.equal(first.next_offset, 1);
  assert.equal(first.total, 2);
  const last = await call({ action: 'list', query: 'match', limit: 1, offset: first.next_offset });
  assert.equal(last.next_offset, null);
  assert.notEqual(first.notes[0].id, last.notes[0].id);
  assert.equal((await call({ action: 'list', offset: 99 })).next_offset, null);
});

test('asset type variants share an identity and can be queried after reloading', async () => {
  const { store, call } = fixture();
  let id;
  for (const type of ['http_endpoint', 'http-endpoint', 'HTTP Endpoint', 'httpEndpoint', 'HTTPEndpoint']) {
    const result = await call({ action: 'write', note_type: 'asset', asset: { type, locator: '/health' } });
    assert.equal(result.status, id ? 'already_known' : 'saved');
    id ||= result.note.id;
    assert.equal(result.note.id, id);
    assert.equal(result.note.asset.type, 'http_endpoint');
  }
  const restored = MemoryStore.fromSnapshot({ snapshot: store.snapshot() });
  const tool = createNoteTool({ store: restored, sessionId: restored.sessionId });
  const result = (await tool.execute('list', { action: 'list', asset_type: 'HTTP Endpoint' })).details;
  assert.equal(result.total, 1);
  assert.equal(result.notes[0].seen_count, 5);
});

test('structured writes infer category for nested, JSON and flat assets', async () => {
  const { call } = fixture();
  for (const payload of [
    { asset: { type: 'source-file', locator: '/app.js' } },
    { asset: JSON.stringify({ type: 'sourceFile', locator: '/app.js' }) },
    { asset_type: 'Source File', locator: '/app.js' }
  ]) {
    const result = await call({ action: 'write', ...payload });
    assert.equal(result.note.note_type, 'asset');
    assert.equal(result.note.asset_type, 'source_file');
  }
  const vulnerability = await call({ action: 'write', vulnerability: {
    type: 'sql-injection', title: 'Candidate', target: '/search', effects: ['query affected'], evidence: ['observed response']
  } });
  assert.equal(vulnerability.note.note_type, 'vulnerability');
  assert.equal(vulnerability.note.vulnerability_type, 'sql_injection');
  assert.equal((await call({ action: 'list', vulnerability_type: 'sqlInjection' })).total, 1);
});

test('flag ledger records observed flags and gates verified states on real evidence', async () => {
  const { call, tool } = fixture();
  const flag = { value: 'flag{observed_only}', target: 'https://ctf.example/challenge/1', source: 'response body' };
  const found = await call({ action: 'write', note_type: 'flag', flag });
  assert.equal(found.status, 'saved');
  assert.equal(found.note.note_type, 'flag');
  assert.equal(found.note.flag.status, 'found');
  const duplicate = await call({ action: 'write', flag });
  assert.equal(duplicate.status, 'already_known');
  assert.equal(duplicate.note.seen_count, 2);
  await assert.rejects(call({ action: 'write', flag: { ...flag, status: 'verified' } }), /flag.verification/);
  await assert.rejects(call({ action: 'write', flag: { ...flag, status: 'verified', verification: 'accepted by checker' } }), /flag.evidence or flag.tool_call_ids/);
  await assert.rejects(call({ action: 'write', flag: { ...flag, status: 'plausible' } }), /flag.status/);
  const verified = await call({ action: 'write', flag: { ...flag, status: 'verified', verification: 'accepted by checker', evidence: ['checker output: accepted'] } });
  assert.equal(verified.note.flag.status, 'verified');
  assert.equal(verified.note.flag.verification, 'accepted by checker');
  const noDowngrade = await call({ action: 'write', flag: { ...flag, status: 'found' } });
  assert.equal(noDowngrade.note.flag.status, 'verified');
  const listed = await call({ action: 'list', note_type: 'flag' });
  assert.equal(listed.total, 1);
  assert.equal(listed.notes[0].flag.value, flag.value);
  const summary = tool.summary();
  assert.match(summary, /Security engagement ledger/);
  assert.match(summary, /flag\{observed_only\}/);
  assert.match(summary, /"status":"verified"/);
});

test('engagement scope ledger keeps authorized and excluded targets together', async () => {
  const { call } = fixture();
  const saved = await call({ action: 'write', scope: {
    targets: ['app.example.test', 'api.example.test'],
    out_of_scope: ['admin.example.test'],
    authorization: 'signed rules of engagement 2026-11-04',
    rules: 'read-only, low rate'
  } });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.note.note_type, 'scope');
  assert.deepEqual(saved.note.scope.targets, ['app.example.test', 'api.example.test']);
  const merged = await call({ action: 'write', scope: {
    targets: ['api.example.test', 'app.example.test'],
    out_of_scope: ['admin.example.test', 'billing.example.test']
  } });
  assert.equal(merged.status, 'already_known');
  assert.deepEqual(merged.note.scope.targets, ['app.example.test', 'api.example.test']);
  assert.deepEqual(merged.note.scope.out_of_scope, ['admin.example.test', 'billing.example.test']);
  assert.equal(merged.note.scope.authorization, 'signed rules of engagement 2026-11-04');
  await assert.rejects(call({ action: 'write', scope: { targets: [] } }), /scope.targets/);
  assert.equal((await call({ action: 'list', note_type: 'scope' })).total, 1);
});

test('plain notes and legacy category aliases still work', async () => {
  const { call, tool } = fixture();
  for (const note_type of [undefined, 'note', 'NOTE', 'note-knowledge', 'note_knowledge']) {
    assert.equal((await call({ action: 'write', note_type, content: '原始笔记' })).note.content, '原始笔记');
  }
  assert.equal((await call({ action: 'list' })).total, 5);
  assert.deepEqual(tool.parameters.properties.note_type.anyOf.map(item => item.const), ['note', 'asset', 'vulnerability', 'flag', 'scope']);
});

test('invalid inputs remain actionable and never mutate stored notes', async () => {
  const { store, call } = fixture();
  for (const type of ['', 'a', '1endpoint', 'http/endpoint', '资产', 'x'.repeat(65)]) {
    await assert.rejects(call({ action: 'write', note_type: 'asset', asset: { type, locator: '/' } }), /asset.type/);
  }
  await assert.rejects(call({ action: 'write', note_type: 'fact', content: 'claim' }), /expected note, asset, vulnerability, flag, or scope.*promotion_kind/);
  await assert.rejects(call({ action: 'write', asset: {}, vulnerability: {} }), /Specify note_type/);
  await assert.rejects(call({ action: 'write', asset: { type: 'endpoint' } }), /asset.locator/);
  assert.equal(store.snapshot().notes.length, 0);
  assert.equal(store.snapshot().revision, 0);
});
