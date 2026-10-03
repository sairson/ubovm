import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSnapshot } from '../persistence.mjs';

test('snapshot bytes are fixed before asynchronous filesystem work starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const snapshot = { revision: 1, nested: { value: 'submitted' } };
  const writing = writeSnapshot(path, snapshot);
  snapshot.revision = 2; snapshot.nested.value = 'changed';
  await writing;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 1, nested: { value: 'submitted' } });
});

test('invalid snapshots fail before creating directories or replacing durable data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  await writeSnapshot(path, { valid: true });
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(writeSnapshot(path, cycle), /circular/i);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { valid: true });
  const absent = join(directory, 'absent');
  await assert.rejects(writeSnapshot(join(absent, 'state.json'), cycle), /circular/i);
  await assert.rejects(access(absent), { code: 'ENOENT' });
});

test('failed snapshot replacement removes temporary files and permits a later retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-rename-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'state.json');
  await mkdir(target);
  await writeFile(join(target, 'sentinel'), 'preserve');
  for (let attempt = 0; attempt < 20; attempt++) {
    await assert.rejects(writeSnapshot(target, { revision: attempt }));
    assert.deepEqual(await readdir(directory), ['state.json'], 'failed rename must leave no temporary snapshot');
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'preserve');
  }
  await rm(target, { recursive: true });
  await writeSnapshot(target, { revision: 21 });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { revision: 21 });
  assert.deepEqual(await readdir(directory), ['state.json']);
});
