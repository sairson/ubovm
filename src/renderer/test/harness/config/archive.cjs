'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readArchive, readZip, isZip, isGzip } = require('../../../harness/config/archive.cjs');
const { zip, tarGz } = require('./build-archive.cjs');

test('stores and deflates ZIP entries without external dependencies', () => {
  const archive = zip([['SKILL.md', '# Skill\n'], ['scripts/run.sh', 'echo hi\n', { deflate: true }]]);
  assert.ok(isZip(archive));
  const files = readArchive(archive);
  assert.deepEqual([...files.keys()].sort(), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(files.get('SKILL.md').toString('utf8'), '# Skill\n');
  assert.equal(files.get('scripts/run.sh').toString('utf8'), 'echo hi\n');
});

test('reads gzip-compressed tar archives and detects the format by magic bytes', () => {
  const archive = tarGz([['demo/SKILL.md', '---\nname: demo\n---\nbody\n'], ['demo/references/a.md', 'ref']]);
  assert.ok(isGzip(archive));
  const files = readArchive(archive);
  assert.equal(files.get('demo/SKILL.md').toString('utf8'), '---\nname: demo\n---\nbody\n');
  assert.equal(files.get('demo/references/a.md').toString('utf8'), 'ref');
});

test('rejects symbolic links and unknown formats', () => {
  assert.throws(() => readZip(zip([['link', 'target', { symlink: true }]])), /符号链接/);
  assert.throws(() => readArchive(Buffer.from('not an archive')), /无法识别/);
});

test('enforces entry and total limits and stops decompression bombs', () => {
  assert.throws(() => readArchive(zip([['a.txt', 'x'.repeat(64)]]), { maxEntryBytes: 16 }), { code: 'ARCHIVE_LIMIT' });
  assert.throws(() => readArchive(zip([['a.txt', 'x'.repeat(64)]]), { maxTotalBytes: 16 }), { code: 'ARCHIVE_LIMIT' });
  assert.throws(() => readArchive(zip([['a.txt', 'a'], ['b.txt', 'b']]), { maxEntries: 1 }), { code: 'ARCHIVE_LIMIT' });
  const bomb = zip([['bomb', 'x'.repeat(4096), { deflate: true, declaredSize: 16 }]]);
  assert.throws(() => readArchive(bomb));
});
