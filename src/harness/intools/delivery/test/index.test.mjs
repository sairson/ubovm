import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/store/memory-store.mjs';
import { createDeliveryTool, DELIVERY_STAGES } from '../index.mjs';
import { createDomainInventoryTool } from '../../domain-inventory/index.mjs';

function setup(persist) {
  const store = new MemoryStore({ sessionId: 'delivery', persist });
  const tool = createDeliveryTool({ store, sessionId: 'delivery', workerId: 'lead' });
  const domains = createDomainInventoryTool({ store, sessionId: 'delivery', workerId: 'lead' });
  const run = async input => (await tool.execute('call', input)).details;
  const status = () => run({ action: 'status' });
  const write = async input => run({ expectedRevision: (await status()).revision ?? 0, ...input });
  const seed = async (id, overrides = {}) => {
    await store.commit(state => { (state.toolEvidence ??= []).push({ workerId: 'tester', toolCallId: id, toolName: 'run_local_shell_command', status: 'completed', isError: false, digest: `digest-${id}`, ...overrides }); });
    return [{ workerId: 'tester', toolCallId: id }];
  };
  const coverDomains = async (hostname = 'service.example.test') => {
    await domains.execute('domains', { action: 'bootstrap', seeds: [hostname] });
    await domains.execute('domains', { action: 'mark_tested', hostname, evidence_refs: ['security-probe'] });
  };
  return { store, tool, domains, run, status, write, seed, coverDomains };
}
const initialize = env => env.write({ action: 'initialize', projectType: 'new-development', objective: 'Deliver service', artifact: 'sha256:v1' });
const accept = async (env, stage, evidence) => {
  if (stage === 'security') await env.coverDomains();
  return env.write({ action: 'accept', stage, summary: 'Observed expected behavior', evidence,
    ...(stage === 'security' ? { scope: 'Authorized staging service; authentication checks' } : {}),
    ...(stage === 'deploy' ? { endpoint: 'https://service.example.test', vantage: 'External client in intended access network' } : {}),
    ...(stage === 'operate' ? { rollback: 'Restore previous artifact and verify endpoint', monitoring: 'Health request and error logs', owner: 'Project operations team' } : {}) });
};
test('standalone tasks cannot initialize the full project workflow', async () => {
  const env = setup();
  for (const projectType of [undefined, 'existing', 'audit', 'deploy']) {
    await assert.rejects(env.write({ action: 'initialize', projectType, objective: 'Audit existing service', artifact: 'v1' }), /only for new development/);
    assert.equal((await env.status()).initialized, false);
  }
});

test('ordered acceptance, evidence validation and complete handoff survive recovery', async () => {
  const env = setup();
  assert.equal((await env.status()).initialized, false);
  await initialize(env);
  await assert.rejects(accept(env, 'deploy', await env.seed('early')), /Preceding/);
  await assert.rejects(accept(env, 'develop', [{ workerId: 'tester', toolCallId: 'missing' }]), /actual successful/);
  await assert.rejects(accept(env, 'develop', await env.seed('failed', { isError: true })), /actual successful/);
  await assert.rejects(accept(env, 'develop', await env.seed('todo', { toolName: 'todo' })), /actual successful/);
  for (const stage of DELIVERY_STAGES) await accept(env, stage, await env.seed(stage));
  assert.equal((await env.status()).complete, true);
  const recovered = MemoryStore.fromSnapshot({ snapshot: env.store.snapshot() });
  const result = await createDeliveryTool({ store: recovered, sessionId: 'delivery' }).execute('read', { action: 'status' });
  assert.equal(result.details.complete, true);
  await assert.rejects(accept(env, 'audit', await env.seed('again')), /invalidate/);
});

test('high findings block release; resolution requires evidence and renewed acceptance', async () => {
  const env = setup(); await initialize(env);
  await accept(env, 'develop', await env.seed('build'));
  await env.write({ action: 'finding', findingId: 'auth-1', severity: 'high', summary: 'Authorization bypass reproduced', evidence: await env.seed('repro') });
  await accept(env, 'audit', await env.seed('audit'));
  await accept(env, 'security', await env.seed('security'));
  await assert.rejects(accept(env, 'deploy', await env.seed('deploy')), /block release/);
  await assert.rejects(env.write({ action: 'resolve', findingId: 'auth-1', summary: 'Fixed', evidence: [] }), /1 to 20/);
  await assert.rejects(env.write({ action: 'resolve', findingId: 'auth-1', summary: 'Fixed', evidence: [{ workerId: 'tester', toolCallId: 'repro' }] }), /new retest/);
  await env.write({ action: 'resolve', findingId: 'auth-1', summary: 'Original reproduction and regression checks passed', evidence: await env.seed('retest') });
  assert.equal((await env.status()).nextStage, 'audit');
  await accept(env, 'audit', await env.seed('audit2'));
  await accept(env, 'security', await env.seed('security2'));
  await accept(env, 'deploy', await env.seed('deploy2'));
  await accept(env, 'operate', await env.seed('health'));
  assert.equal((await env.status()).complete, true);
  await env.write({ action: 'reopen', findingId: 'auth-1', summary: 'Regression reproduced', evidence: await env.seed('regression') });
  assert.equal((await env.status()).nextStage, 'audit');
  assert.equal((await env.status()).complete, false);
});

test('artifact invalidation rejects stale evidence and concurrent writes', async () => {
  const env = setup(); await initialize(env);
  const old = await env.seed('old'); await accept(env, 'develop', old);
  const revision = (await env.status()).revision;
  await env.write({ action: 'invalidate', stage: 'develop', artifact: 'sha256:v2', summary: 'Code changed' });
  await assert.rejects(accept(env, 'develop', old), /predates/);
  const stale = await env.run({ action: 'accept', expectedRevision: revision, stage: 'develop', summary: 'Stale writer', evidence: old });
  assert.equal(stale.status, 'revision_conflict');
  assert.equal(stale.expectedRevision, (await env.status()).revision);
  await accept(env, 'develop', await env.seed('new'));
  assert.equal((await env.status()).artifact, 'sha256:v2');
  const nextRevision = (await env.status()).revision;
  const refs = await env.seed('race');
  const input = { action: 'accept', expectedRevision: nextRevision, stage: 'audit', summary: 'Reviewed', evidence: refs };
  const results = await Promise.all([env.run(input), env.run(input)]);
  assert.equal(results.filter(item => item.status !== 'revision_conflict' && item.acceptance?.audit).length, 1);
  assert.equal(results.filter(item => item.status === 'revision_conflict').length, 1);
});

test('persistence failure leaves no accepted state', async () => {
  const env = setup(async () => { throw new Error('disk full'); });
  await assert.rejects(initialize(env), /disk full/);
  assert.equal((await env.status()).initialized, false);
});

test('damaged recovered records fail closed; legacy acceptance requires missing details', async () => {
  const env = setup(); await initialize(env);
  for (const stage of DELIVERY_STAGES) await accept(env, stage, await env.seed(stage));
  const corrupted = env.store.snapshot();
  corrupted.delivery.findings.push({ id: 'bad', severity: 'high', status: 'open', summary: 'bad evidence', evidence: [] });
  assert.throws(() => MemoryStore.fromSnapshot({ snapshot: corrupted }), /Invalid delivery snapshot/);
  const legacy = env.store.snapshot(); delete legacy.delivery.acceptance.security.scope;
  const store = MemoryStore.fromSnapshot({ snapshot: legacy });
  const tool = createDeliveryTool({ store, sessionId: 'delivery' });
  const state = (await tool.execute('read', { action: 'status' })).details;
  assert.equal(state.complete, false); assert.equal(state.releaseReady, false);
  assert.equal(state.nextStage, 'security');
});

test('blocked stages retain prerequisites and require structured deployment and operations handoff', async () => {
  const env = setup(); await initialize(env);
  await env.write({ action: 'block', stage: 'security', summary: 'Need staging test authorization', owner: 'Project owner' });
  assert.equal((await env.status()).stages.find(item => item.stage === 'security').status, 'blocked');
  await accept(env, 'develop', await env.seed('build'));
  await accept(env, 'audit', await env.seed('audit'));
  const refs = await env.seed('security');
  await assert.rejects(env.write({ action: 'accept', stage: 'security', summary: 'Passed', evidence: refs }), /Domain inventory|seed roots/);
  await env.coverDomains();
  const accepted = await env.write({ action: 'accept', stage: 'security', summary: 'Passed', evidence: refs });
  assert.match(accepted.acceptance.security.scope, /service\.example\.test|Seed roots/);
  assert.equal(accepted.acceptance.security.domainCoverage.complete, true);
  assert.equal((await env.status()).blocked.security, undefined);
  const deployed = await env.seed('deploy');
  await assert.rejects(env.write({ action: 'accept', stage: 'deploy', summary: 'Passed', evidence: deployed }), /deployed endpoint/);
  for (const endpoint of ['javascript:alert(1)', 'https://user:password@example.test', '/health']) {
    await assert.rejects(env.write({ action: 'accept', stage: 'deploy', summary: 'Passed', evidence: deployed, endpoint, vantage: 'External' }), /Endpoint|endpoint/);
  }
  await accept(env, 'deploy', deployed);
  await assert.rejects(env.write({ action: 'accept', stage: 'operate', summary: 'Passed', evidence: await env.seed('health') }), /rollback procedure/);
  await accept(env, 'operate', await env.seed('handoff'));
  assert.equal((await env.status()).complete, true);
});

test('security acceptance requires complete domain inventory coverage and can synthesize scope', async () => {
  const env = setup(); await initialize(env);
  await accept(env, 'develop', await env.seed('dev'));
  await accept(env, 'audit', await env.seed('audit'));
  const refs = await env.seed('sec');
  await assert.rejects(env.write({ action: 'accept', stage: 'security', summary: 'Passed', evidence: refs, scope: 'manual scope' }), /Domain inventory|seed roots/);
  await env.domains.execute('d', { action: 'bootstrap', seeds: ['app.example.test'] });
  await assert.rejects(env.write({ action: 'accept', stage: 'security', summary: 'Passed', evidence: refs, scope: 'manual scope' }), /coverage incomplete|pending/);
  await env.domains.execute('d', { action: 'mark_tested', hostname: 'app.example.test', evidence_refs: ['ok'] });
  const accepted = await env.write({ action: 'accept', stage: 'security', summary: 'Passed', evidence: refs });
  assert.match(accepted.acceptance.security.scope, /app\.example\.test/);
  assert.equal((await env.status()).domainCoverage.complete, true);
});
test('status stays bounded while paginated history retains invalidated evidence', async () => {
  const env = setup(); await initialize(env);
  await accept(env, 'develop', await env.seed('first-build'));
  await env.write({ action: 'invalidate', stage: 'develop', artifact: 'v2', summary: 'New source revision' });
  const status = await env.status();
  assert.equal(status.history, undefined);
  assert.equal(status.evidenceFloor, undefined);
  const first = await env.run({ action: 'history', offset: 0, limit: 2, expectedRevision: status.revision });
  assert.equal(first.items[1].evidence[0].toolCallId, 'first-build');
  assert.equal(first.items[1].acceptance.artifact, 'sha256:v1');
  assert.equal(first.nextOffset, 2);
  await env.write({ action: 'block', stage: 'develop', summary: 'Build prerequisite' });
  const conflict = await env.run({ action: 'history', offset: 2, expectedRevision: first.revision });
  assert.equal(conflict.status, 'revision_conflict');
  assert.equal(conflict.expectedRevision, (await env.status()).revision);
});

test('model-boundary delivery context remains compact and points to full evidence', async () => {
  const env = setup(); await initialize(env);
  for (let index = 0; index < 25; index++) await env.write({ action: 'finding', findingId: `risk-${index}`, severity: 'medium', summary: 'Long reproduction detail '.repeat(100), evidence: await env.seed(`repro-${index}`) });
  const summary = env.tool.summary();
  assert(summary.length < 12000);
  assert.match(summary, /use delivery_workflow status\/history/);
  assert.match(summary, /"openFindings":25/);
  assert.doesNotMatch(summary, /Long reproduction detail/);
});

test('runtime exposes independent tools without automatically creating a delivery project', async () => {
  const { createInternalTools } = await import('../../index.mjs');
  const runtime = await createInternalTools({ sessionId: 'independent', allowedTools: ['todo', 'delivery_workflow'], knowledge: false, browser: false, python: false });
  try {
    const tools = await runtime.forWorker('lead');
    const todo = tools.find(tool => tool.name === 'todo');
    await todo.execute('todo-call', { action: 'write', items: [{ content: 'Audit existing project', status: 'completed' }] });
    assert.equal(runtime.store.snapshot().delivery, undefined);
    assert.equal((await tools.find(tool => tool.name === 'delivery_workflow').execute('read', { action: 'status' })).details.initialized, false);
    assert.equal((await runtime.contextProvider({ node: { id: 'lead' } })).includes('New development project delivery ledger'), false);
  } finally { await runtime.close(); }
});

test('shared delivery acceptance uses evidence recorded by the real runtime hook', async () => {
  const { createInternalTools } = await import('../../index.mjs');
  const runtime = await createInternalTools({ sessionId: 'recorded-delivery', allowedTools: ['delivery_workflow'], knowledge: false });
  try {
    const tool = (await runtime.forWorker('lead'))[0];
    const run = async input => (await tool.execute('delivery', input)).details;
    await run({ action: 'initialize', projectType: 'new-development', expectedRevision: 0, objective: 'Create service', artifact: 'v1' });
    await runtime.onToolResult({ node: { id: 'tester' }, attempt: { id: 'attempt-1' }, entry: {
      toolCallId: 'test-call', toolName: 'run_local_shell_command', args: { command: 'project test' },
      status: 'completed', isError: false, result: { content: [{ type: 'text', text: '5 checks passed' }] }
    } });
    const accepted = await run({ action: 'accept', expectedRevision: 1, stage: 'develop', summary: '5 actual project checks passed', evidence: [{ workerId: 'tester', toolCallId: 'test-call' }] });
    assert.equal(accepted.acceptance.develop.evidence[0].digest.length, 64);
    assert.equal(accepted.nextStage, 'audit');
    const context = await runtime.contextProvider({ node: { id: 'lead' } });
    assert.match(context, /"nextStage":"audit"/);
  } finally { await runtime.close(); }
});

test('long ledger status, context and history pages never clone the full archive', async () => {
  const env = setup(); await initialize(env);
  const saved = env.store.snapshot();
  const template = saved.delivery.history[0];
  saved.delivery.history = Array.from({ length: 2000 }, (_, index) => ({ ...template, revision: index + 1, summary: 'archived evidence '.repeat(100) }));
  saved.delivery.revision = saved.delivery.history.length;
  const store = MemoryStore.fromSnapshot({ snapshot: saved });
  const tool = createDeliveryTool({ store, sessionId: 'delivery' });
  const originalClone = globalThis.structuredClone;
  const clonedHistorySizes = [];
  globalThis.structuredClone = (value, options) => {
    if (Array.isArray(value?.history)) clonedHistorySizes.push(value.history.length);
    if (Array.isArray(value?.delivery?.history)) clonedHistorySizes.push(value.delivery.history.length);
    if (Array.isArray(value?.items)) clonedHistorySizes.push(value.items.length);
    return originalClone(value, options);
  };
  try {
    for (let index = 0; index < 100; index++) {
      const status = (await tool.execute('read', { action: 'status' })).details;
      assert.equal(status.historyCount, 2000);
      assert.equal(status.recentActivity.length, 8);
      assert(tool.summary().length < 12000);
    }
    const page = (await tool.execute('page', { action: 'history', offset: 100, limit: 10, expectedRevision: 2000 })).details;
    assert.equal(page.total, 2000); assert.equal(page.items.length, 10);
    page.items[0].summary = 'caller mutation';
    const original = store.deliveryHistory({ offset: 100, limit: 1 });
    assert.notEqual(original.items[0].summary, 'caller mutation');
    assert(clonedHistorySizes.length > 100);
    assert(clonedHistorySizes.every(size => size <= 10), 'read paths must select before structuredClone');
  } finally { globalThis.structuredClone = originalClone; }
});
