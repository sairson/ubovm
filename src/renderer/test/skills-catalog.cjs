'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installBundledSkills, readSkillsCatalog } = require('../harness/config/skills-catalog.cjs');

test('bundled skills install completely, preserve user edits and expose actual files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../harness/agents/skills');
  const destination = path.join(root, 'skills');
  await installBundledSkills(source, destination);
  let catalog = await readSkillsCatalog(destination);
  assert.deepEqual(catalog.items.map(item => item.name), ['browser-bridge', 'ceye-dnslog']);
  assert.ok(catalog.items.every(item => item.builtin));
  assert.deepEqual(catalog.errors, []);
  assert.ok((await fs.readdir(path.join(destination, 'browser-bridge', 'references'))).length > 0);
  const skill = path.join(destination, 'browser-bridge', 'SKILL.md');
  assert.equal(catalog.items[0].content, await fs.readFile(skill, 'utf8'));
  assert.equal(catalog.items[0].path, undefined);
  await fs.writeFile(skill, 'User modified skill');
  await installBundledSkills(source, destination);
  assert.equal(await fs.readFile(skill, 'utf8'), 'User modified skill');
  await fs.mkdir(path.join(destination, 'custom'));
  await fs.writeFile(path.join(destination, 'custom', 'SKILL.md'), '# Custom');
  catalog = await readSkillsCatalog(destination);
  assert.equal(catalog.items.length, 3);
  assert.equal(catalog.items.find(item => item.name === 'custom').builtin, false);
  assert.equal(catalog.items.find(item => item.name === 'browser-bridge').content, 'User modified skill');
  assert.equal(catalog.errors.length, 0);
  assert.equal((await readSkillsCatalog(path.join(root, 'missing'))).errors.length, 1);
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

test('failed installation leaves no partial discoverable package', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'skills');
  await assert.rejects(installBundledSkills(path.join(root, 'missing'), destination));
  assert.deepEqual(await fs.readdir(destination), []);
});
