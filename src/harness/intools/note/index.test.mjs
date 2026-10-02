import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../memory-store.mjs';
import { createNoteTool } from './index.mjs';

function fixture() {
  const store = new MemoryStore({ sessionId: 'note-types' });
  const tool = createNoteTool({ store, sessionId: store.sessionId });
  const call = async input => (await tool.execute('test', input)).details;
  return { store, tool, call };
}

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

test('flattened vulnerability fields are normalized for tool adapters', async () => {
  const { call } = fixture();
  const result = await call({ action: 'write', note_type: 'vulnerability', vulnerability_type: 'ssti',
    title: 'Template injection', target: 'http://example.test/render', status: 'verified', severity: 'critical',
    vector: 'POST /render', effects: ['Template expressions are evaluated'],
    preconditions: ['Endpoint is reachable'], evidence: ['{{7*7}} -> 49'], details: { param: 'template' } });
  assert.equal(result.note.vulnerability_type, 'ssti');
  assert.equal(result.note.vulnerability.status, 'verified');
  assert.deepEqual(result.note.vulnerability.effects, ['Template expressions are evaluated']);
});

test('plain notes and legacy category aliases still work', async () => {
  const { call, tool } = fixture();
  for (const note_type of [undefined, 'note', 'NOTE', 'note-knowledge', 'note_knowledge']) {
    assert.equal((await call({ action: 'write', note_type, content: '原始笔记' })).note.content, '原始笔记');
  }
  assert.equal((await call({ action: 'list' })).total, 5);
  assert.deepEqual(tool.parameters.properties.note_type.anyOf.map(item => item.const), ['note', 'asset', 'vulnerability']);
});

test('invalid inputs remain actionable and never mutate stored notes', async () => {
  const { store, call } = fixture();
  for (const type of ['', 'a', '1endpoint', 'http/endpoint', '资产', 'x'.repeat(65)]) {
    await assert.rejects(call({ action: 'write', note_type: 'asset', asset: { type, locator: '/' } }), /asset.type/);
  }
  await assert.rejects(call({ action: 'write', note_type: 'fact', content: 'claim' }), /expected note, asset, or vulnerability.*promotion_kind/);
  await assert.rejects(call({ action: 'write', asset: {}, vulnerability: {} }), /Specify note_type/);
  await assert.rejects(call({ action: 'write', asset: { type: 'endpoint' } }), /asset.locator/);
  assert.equal(store.snapshot().notes.length, 0);
  assert.equal(store.snapshot().revision, 0);
});
