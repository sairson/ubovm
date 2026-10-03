import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessProject, applyHarnessProfile } from '../harness-project.mjs';

const profile = { name: 'reviewer', instructions: 'Inspect tests and report evidence.', allowedTools: ['read'], maxModelCalls: 10 };

test('profile versions persist, remain immutable and export the latest version per name', async () => {
  let saved;
  const project = createHarnessProject({ save: state => { saved = state; } });
  const first = await project.manage({ action: 'define', profile });
  await project.manage({ action: 'define', profile: { ...profile, instructions: 'New review instructions' } });
  assert.equal(project.get(first.profiles[0].id).instructions, profile.instructions);
  first.profiles[0].allowedTools.push('write');
  assert.deepEqual(project.get('reviewer@1').allowedTools, ['read']);
  const restored = createHarnessProject({ state: saved });
  const exported = await restored.manage({ action: 'export' });
  assert.equal(exported.profiles.length, 1);
  assert.equal(exported.profiles[0].instructions, 'New review instructions');
  const imported = createHarnessProject();
  await imported.manage({ action: 'import', project: exported });
  assert.deepEqual(await imported.manage({ action: 'export' }), exported);
});

test('concurrent definitions serialize and failed writes never publish a profile', async () => {
  let fail = true;
  const project = createHarnessProject({ save: async () => { if (fail) { fail = false; throw Error('disk full'); } } });
  await assert.rejects(project.manage({ action: 'define', profile }), /disk full/);
  assert.equal(project.snapshot().profiles.length, 0);
  await Promise.all([project.manage({ action: 'define', profile }), project.manage({ action: 'define', profile })]);
  assert.deepEqual(project.snapshot().profiles.map(item => item.id), ['reviewer@1']);
  await assert.rejects(project.manage({ action: 'import', project: { version: 1, profiles: [profile, profile] } }), /Duplicate/);
  assert.equal(project.snapshot().profiles.length, 1);
});

test('optimistic revisions prevent stale changes and validation never saves', async () => {
  let writes = 0;
  const project = createHarnessProject({ save: () => { writes++; } });
  assert.equal((await project.manage({ action: 'validate', profile })).valid, true);
  assert.equal(writes, 0);
  const first = project.manage({ action: 'define', profile, expectedRevision: 0 });
  const stale = assert.rejects(project.manage({ action: 'define', profile: { ...profile, instructions: 'stale' }, expectedRevision: 0 }), { code: 'HARNESS_PROJECT_CONFLICT' });
  await first; await stale;
  assert.equal(writes, 1);
  const retry = await project.manage({ action: 'define', profile: { maxModelCalls: 10, allowedTools: ['read', 'read'], instructions: profile.instructions, name: 'reviewer' }, expectedRevision: 1 });
  assert.equal(retry.unchanged, true);
  assert.equal(retry.profiles[0].id, 'reviewer@1');
  assert.equal(writes, 1);
});

test('queued reads wait for durable writes and identical imports work at full capacity', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const project = createHarnessProject({ save: () => gate });
  const pending = project.manage({ action: 'define', profile });
  const listing = project.manage({ action: 'list' });
  release(); await pending;
  assert.equal((await listing).profiles.length, 1);
  const full = createHarnessProject();
  const manifest = { version: 1, profiles: Array.from({ length: 64 }, (_, i) => ({ ...profile, name: `profile-${i}` })) };
  await full.manage({ action: 'import', project: manifest });
  const retry = await full.manage({ action: 'import', project: manifest });
  assert.equal(retry.unchanged, true);
  assert.equal(full.snapshot().revision, 1);
  await assert.rejects(full.manage({ action: 'define', profile }), /capacity/);
});

test('profiles cannot expand parent tools or budgets and invalid manifests are rejected', async () => {
  const tools = [{ name: 'read' }, { name: 'write' }];
  const parent = applyHarnessProfile({ profile, options: { maxModelCalls: 5 }, tools });
  const child = applyHarnessProfile({ options: { maxModelCalls: 0 }, tools, inherited: parent });
  assert.equal(child.options.maxModelCalls, 5);
  assert.deepEqual(child.tools.map(tool => tool.name), ['read']);
  assert.throws(() => applyHarnessProfile({ profile: { ...profile, allowedTools: ['write'] }, options: {}, tools, inherited: parent }), /unavailable tool/);
  assert.throws(() => applyHarnessProfile({ profile: { ...profile, allowedTools: ['missing'] }, options: {}, tools }), /unavailable tool/);
  const project = createHarnessProject();
  for (const invalid of [{ ...profile, requireToolApproval: false }, { ...profile, maxToolCalls: -1 }, { ...profile, name: '../escape' }, { ...profile, model: 'untrusted' }]) {
    await assert.rejects(project.manage({ action: 'define', profile: invalid }), TypeError);
  }
});
