import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/store/memory-store.mjs';
import { createDomainInventoryTool, normalizeHostname, coverageSummary } from '../index.mjs';

function fixture() {
  const store = new MemoryStore({ sessionId: 'domains' });
  const tool = createDomainInventoryTool({ store, sessionId: store.sessionId });
  const call = async input => (await tool.execute('test', input)).details;
  return { store, tool, call };
}

test('normalizeHostname lowercases and extracts hosts from URLs', () => {
  assert.equal(normalizeHostname('Example.COM'), 'example.com');
  assert.equal(normalizeHostname('https://App.Example.com/path'), 'app.example.com');
  assert.equal(normalizeHostname('192.168.1.1'), '192.168.1.1');
  assert.throws(() => normalizeHostname(''), /nonempty/);
  assert.throws(() => normalizeHostname('not a host!!'), /Invalid hostname/);
});

test('bootstrap seeds, upsert related hosts, and enforce coverage', async () => {
  const { store, call } = fixture();
  await assert.rejects(call({ action: 'upsert', hostname: 'a.example.com' }), /Bootstrap/);
  const boot = await call({ action: 'bootstrap', seeds: ['Example.com', 'https://Example.com'] });
  assert.deepEqual(boot.seedRoots, ['example.com']);
  assert.equal(boot.coverage.total, 1);
  assert.equal(boot.coverage.complete, false);

  const upsert = await call({
    action: 'upsert',
    hostnames: ['api.example.com', 'cdn.example.com'],
    discovery: 'cert',
    relation_type: 'cert_san',
    evidence_refs: ['crt.sh#1']
  });
  assert.deepEqual(upsert.created.sort(), ['api.example.com', 'cdn.example.com']);

  await call({ action: 'mark_tested', hostname: 'example.com', evidence_refs: ['probe-1'] });
  await call({ action: 'mark_tested', hostname: 'api.example.com', evidence_refs: ['probe-2'] });
  await assert.rejects(call({ action: 'skip', hostname: 'cdn.example.com' }), /skip_reason/);
  await call({ action: 'skip', hostname: 'cdn.example.com', skip_reason: 'CDN only; no app surface', test_status: 'out_of_scope' });

  const coverage = await call({ action: 'coverage' });
  assert.equal(coverage.complete, true);
  assert.equal(coverage.counts.tested, 2);
  assert.equal(coverage.counts.out_of_scope, 1);

  const restored = MemoryStore.fromSnapshot({ snapshot: store.snapshot() });
  assert.equal(coverageSummary(restored.snapshot(['domainInventory']).domainInventory).complete, true);
});

test('relate merges evidence and list filters by status', async () => {
  const { call } = fixture();
  await call({ action: 'bootstrap', seeds: ['acme.test'] });
  await call({ action: 'upsert', hostname: 'www.acme.test', discovery: 'dns', relation_type: 'dns_cname' });
  await call({ action: 'relate', hostname: 'www.acme.test', relation_type: 'http_redirect', evidence_refs: ['redir-1'] });
  const listed = await call({ action: 'list', test_status: 'pending' });
  assert.equal(listed.total, 2);
  const www = listed.domains.find(item => item.hostname === 'www.acme.test');
  assert.ok(www.relations.some(rel => rel.type === 'dns_cname'));
  assert.ok(www.relations.some(rel => rel.type === 'http_redirect' && rel.evidence_refs.includes('redir-1')));
});

test('idempotent upsert and capacity-safe validation', async () => {
  const { call } = fixture();
  await call({ action: 'bootstrap', hostname: 'root.example' });
  await call({ action: 'upsert', hostname: 'a.root.example', discovery: 'enum' });
  const again = await call({ action: 'upsert', hostname: 'a.root.example', discovery: 'enum', relation_type: 'subdomain' });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.updated, ['a.root.example']);
  await assert.rejects(call({ action: 'bootstrap', seeds: [] }), /seed/);
});
