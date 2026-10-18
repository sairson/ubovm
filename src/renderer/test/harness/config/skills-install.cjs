'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installSkill } = require('../../../harness/config/skills-install.cjs');
const { readSkillsCatalog } = require('../../../harness/config/skills-catalog.cjs');
const { zip, tarGz } = require('./build-archive.cjs');

const SKILL = '---\nname: demo-skill\ndescription: A demo skill\n---\n\n# Demo\n\nDo the thing.\n';

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ubovm-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'skills');
}

function fetchBuffer(buffer) {
  return async () => ({ ok: true, status: 200, headers: { get: () => String(buffer.length) }, arrayBuffer: async () => buffer });
}

test('inline install writes a discoverable skill with supporting files', async t => {
  const destination = await sandbox(t);
  const result = await installSkill({ name: 'demo-skill', content: SKILL, files: [{ path: 'scripts/run.sh', content: 'echo hi\n' }] }, { destination });
  assert.equal(result.name, 'demo-skill');
  assert.equal(result.source, 'inline');
  assert.deepEqual(result.files, ['SKILL.md', 'scripts/run.sh']);
  assert.equal(await fs.readFile(path.join(result.directory, 'scripts/run.sh'), 'utf8'), 'echo hi\n');
  const catalog = await readSkillsCatalog(destination);
  assert.equal(catalog.errors.length, 0);
  assert.equal(catalog.items[0].name, 'demo-skill');
  assert.equal(catalog.items[0].builtin, false);
});

test('install validates the request before touching the destination', async t => {
  const destination = await sandbox(t);
  await assert.rejects(installSkill({}, { destination }), /content（直接写入）或 url/);
  await assert.rejects(installSkill({ content: SKILL, url: 'https://example.test/x' }, { destination }), /content（直接写入）或 url/);
  await assert.rejects(installSkill({ name: 'other', content: SKILL }, { destination }), /名称与 SKILL.md 不一致/);
  await assert.rejects(installSkill({ name: 'demo-skill', content: '---\nname: demo-skill\n---\nbody' }, { destination }), /缺少 description/);
  await assert.rejects(installSkill({ name: 'demo-skill', content: SKILL, files: [{ path: '../escape', content: 'x' }] }, { destination }), /上级目录/);
  await assert.rejects(installSkill({ name: 'demo-skill', content: '---\nname: demo-skill\ndescription: x\ncontext: fork\n---\nbody' }, { destination }), /仅支持 inline/);
  assert.deepEqual(await fs.readdir(destination).catch(() => []), []);
});

test('an existing skill is preserved unless overwrite is requested', async t => {
  const destination = await sandbox(t);
  await installSkill({ name: 'demo-skill', content: SKILL }, { destination });
  await assert.rejects(installSkill({ name: 'demo-skill', content: SKILL }, { destination }), { code: 'SKILL_EXISTS' });
  const updated = SKILL.replace('Do the thing.', 'Do it differently.');
  const result = await installSkill({ name: 'demo-skill', content: updated, overwrite: true }, { destination });
  assert.equal(result.overwritten, true);
  assert.match(await fs.readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), /differently/);
  assert.deepEqual((await fs.readdir(destination)).filter(name => name.startsWith('.')), []);
});

test('a URL returning raw SKILL.md installs as a single-file skill', async t => {
  const destination = await sandbox(t);
  const result = await installSkill({ url: 'https://example.test/SKILL.md' }, { destination, fetch: fetchBuffer(Buffer.from(SKILL)) });
  assert.equal(result.name, 'demo-skill');
  assert.equal(result.source, 'url');
  assert.deepEqual(result.files, ['SKILL.md']);
});

test('a ZIP package installs the skill directory under its own name', async t => {
  const destination = await sandbox(t);
  const archive = zip([['demo-skill/SKILL.md', SKILL], ['demo-skill/references/a.md', 'note']]);
  const result = await installSkill({ url: 'https://example.test/demo.zip', name: 'demo-skill' }, { destination, fetch: fetchBuffer(archive) });
  assert.equal(result.name, 'demo-skill');
  assert.deepEqual(result.files, ['SKILL.md', 'references/a.md']);
  assert.equal(await fs.readFile(path.join(result.directory, 'references/a.md'), 'utf8'), 'note');
});

test('a GitHub-style tar.gz root is detected and ambiguous packages are rejected', async t => {
  const destination = await sandbox(t);
  const archive = tarGz([['repo-main/SKILL.md', SKILL]]);
  const result = await installSkill({ url: 'https://example.test/main.tar.gz', name: 'demo-skill' }, { destination, fetch: fetchBuffer(archive) });
  assert.equal(result.name, 'demo-skill');
  const ambiguous = zip([['one/SKILL.md', SKILL], ['two/SKILL.md', SKILL.replace('demo-skill', 'other-skill')]]);
  await assert.rejects(installSkill({ url: 'https://example.test/two.zip', name: 'demo-skill' }, { destination, fetch: fetchBuffer(ambiguous) }), { code: 'SKILL_AMBIGUOUS' });
});
