'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installBundledSkills, readSkillsCatalog } = require('../../../harness/config/skills-catalog.cjs');

test('bundled skills install completely, preserve user edits and expose actual files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../../../harness/agents/skills');
  const destination = path.join(root, 'skills');
  await installBundledSkills(source, destination);
  let catalog = await readSkillsCatalog(destination);
  assert.deepEqual(catalog.items.map(item => item.name), ['attack-surface', 'browser-bridge', 'ceye-dnslog', 'code-audit', 'pentest', 'pentest-report', 'self-learning', 'swarm', 'team']);
  assert.ok(catalog.items.every(item => item.builtin));
  assert.deepEqual(catalog.errors, []);
  assert.ok((await fs.readdir(path.join(destination, 'browser-bridge', 'references'))).length > 0);
  assert.deepEqual((await fs.readdir(path.join(destination, 'code-audit', 'references'))).sort(), ['audit-checklist.md', 'finding-template.md']);
  const codeAuditSkill = await fs.readFile(path.join(destination, 'code-audit', 'SKILL.md'), 'utf8');
  assert.match(codeAuditSkill, /name: code-audit/);
  assert.match(codeAuditSkill, /## Verification gate \(mandatory\)/);
  assert.match(codeAuditSkill, /confirmed only when a runnable reproduction\s+was\s+actually executed/i);
  assert.match(codeAuditSkill, /CAND-/);
  const candidateTemplate = await fs.readFile(path.join(destination, 'code-audit', 'references', 'finding-template.md'), 'utf8');
  assert.match(candidateTemplate, /verification: executed/);
  assert.match(candidateTemplate, /reproduction: passed/);
  assert.match(candidateTemplate, /confirmation gate/);
  assert.deepEqual((await fs.readdir(path.join(destination, 'pentest-report', 'references'))).sort(), ['example-report.md', 'report-template.md', 'severity-guide.md', 'tool-recipes.md']);
  assert.match(await fs.readFile(path.join(destination, 'pentest-report', 'SKILL.md'), 'utf8'), /name: pentest-report/);
  const pentestSkill = await fs.readFile(path.join(destination, 'pentest', 'SKILL.md'), 'utf8');
  assert.match(pentestSkill, /## Objective \/ flag ledger/);
  assert.match(pentestSkill, /verified.*submitted.*accepted/s);
  assert.match(pentestSkill, /never guess/i);
  assert.match(pentestSkill, /Finding verification gate/);
  const skill = path.join(destination, 'browser-bridge', 'SKILL.md');
  const browser = catalog.items.find(item => item.name === 'browser-bridge');
  assert.equal(browser.content, await fs.readFile(skill, 'utf8'));
  assert.equal(browser.path, undefined);
  await fs.writeFile(skill, 'User modified skill');
  await installBundledSkills(source, destination);
  assert.equal(await fs.readFile(skill, 'utf8'), 'User modified skill');
  await fs.mkdir(path.join(destination, 'custom'));
  await fs.writeFile(path.join(destination, 'custom', 'SKILL.md'), '# Custom');
  catalog = await readSkillsCatalog(destination);
  assert.equal(catalog.items.length, 10);
  assert.equal(catalog.items.find(item => item.name === 'custom').builtin, false);
  assert.equal(catalog.items.find(item => item.name === 'browser-bridge').content, 'User modified skill');
  assert.equal(catalog.errors.length, 0);
  // A deleted built-in is re-seeded on the next startup, not left missing.
  await fs.rm(path.join(destination, 'team'), { recursive: true, force: true });
  await installBundledSkills(source, destination);
  const restored = await readSkillsCatalog(destination);
  assert.equal(restored.items.find(item => item.name === 'team')?.builtin, true);
  assert.equal((await readSkillsCatalog(path.join(root, 'missing'))).errors.length, 1);
});

test('flat Markdown skills are listed alongside directory bundles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-flat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bundle'));
  await fs.writeFile(path.join(root, 'bundle', 'SKILL.md'), '# Bundle');
  await fs.writeFile(path.join(root, 'flat.md'), '# Flat');
  const catalog = await readSkillsCatalog(root);
  assert.deepEqual(catalog.items.map(item => item.name).sort(), ['bundle', 'flat']);
  assert.equal(catalog.items.find(item => item.name === 'flat').content, '# Flat');
});

test('oversized skill content has an explicit preview error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'large'));
  await fs.writeFile(path.join(root, 'large', 'SKILL.md'), 'x'.repeat(256 * 1024 + 1));
  const catalog = await readSkillsCatalog(root);
  assert.equal(catalog.items[0].content, undefined);
  assert.match(catalog.items[0].contentError, /超出/);
});

test('concurrent window startup installs complete skills without spurious failures or staging leftovers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-concurrent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../../../harness/agents/skills');
  const destination = path.join(root, 'skills');
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => installBundledSkills(source, destination)));
  assert.ok(results.every(result => result.status === 'fulfilled'), results.filter(result => result.status === 'rejected').map(result => result.reason).join('\n'));
  assert.deepEqual((await fs.readdir(destination)).sort(), ['attack-surface', 'browser-bridge', 'ceye-dnslog', 'code-audit', 'pentest', 'pentest-report', 'self-learning', 'swarm', 'team']);
  const catalog = await readSkillsCatalog(destination);
  assert.equal(catalog.errors.length, 0);
  assert.ok(catalog.items.every(item => item.content?.length > 0));
});

test('failed installation leaves no partial discoverable package', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'skills');
  await assert.rejects(installBundledSkills(path.join(root, 'missing'), destination));
  assert.deepEqual(await fs.readdir(destination), []);
});

test('publication permission failure without a winning package remains an error and clears staging', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-denied-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../../../harness/agents/skills');
  const destination = path.join(root, 'skills');
  const { runInNewContext } = require('node:vm');
  const filename = require.resolve('../../../harness/config/skills-catalog.cjs');
  const sandbox = { module: { exports: {} }, Buffer, require: name => name === 'node:fs/promises'
    ? { ...fs, async rename() { throw Object.assign(Error('permission denied'), { code: 'EPERM' }); } } : require(name) };
  runInNewContext(await fs.readFile(filename, 'utf8'), sandbox);
  await assert.rejects(sandbox.module.exports.installBundledSkills(source, destination), { code: 'EPERM' });
  assert.deepEqual(await fs.readdir(destination), []);
});
