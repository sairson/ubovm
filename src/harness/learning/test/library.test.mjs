import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInternalTools } from '../../intools/index.mjs';
import { createSkillsMiddleware } from '../../middleware/skills.mjs';
import { LearningLibrary } from '../library.mjs';
import { DatabaseSync } from 'node:sqlite';
import { learningFingerprint, learningRequestFingerprint } from '../fingerprint.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'learning-library-'));
  const runtimes = [];
  t.after(async () => { await Promise.all(runtimes.map(runtime => runtime.close())); await rm(directory, { recursive: true, force: true }); });
  async function runtime(sessionId) {
    const runtime = await createInternalTools({ sessionId, allowedTools: ['learn_capability'], knowledge: { background: false, libraryFile: join(directory, 'knowledge.sqlite') } });
    runtimes.push(runtime);
    const [tool] = await runtime.forWorker('worker');
    const record = (id, isError = false) => runtime.onToolResult({ node: { id: 'worker' }, attempt: { id: `attempt-${id}` }, entry: {
      toolCallId: id, toolName: 'inspect_source', status: 'completed', isError,
      args: { resource: `${sessionId}/${id}` },
      result: { content: [{ type: 'text', text: isError ? 'Failed' : 'Private raw output not for publication' }] }
    } });
    return { runtime, tool, record };
  }
  return { directory, runtime };
}
const input = { action: 'learn', title: 'Inspect source', trigger: 'Source inspection', steps: ['Read source', 'Verify requested condition'], tool_call_ids: ['call-1'] };

test('confidence counts independent attempts, excludes publication evidence and isolates failed calls', async t => {
  const library = await LearningLibrary.open({ filePath: ':memory:' });
  t.after(() => library.close());
  const { id } = library.publish({ ...input, workerId: 'w', evidence: [{ toolCallId: 'origin', tool: 'inspect_source' }] }, 's');
  const record = (toolCallId, attemptId, isError = false) => ({ sessionId: 's', workerId: 'w', status: 'completed', toolName: 'inspect_source',
    learningRequestFingerprint: learningRequestFingerprint({ toolName: 'inspect_source', args: { resource: toolCallId } }),
    learningFingerprint: learningFingerprint({ toolName: 'inspect_source', args: { resource: toolCallId }, isError }), toolCallId, attemptId, isError });
  const assess = (records, outcome = 'success') => library.feedback(id, { sessionId: 's', workerId: 'w', records, outcome });
  assert.equal(assess([record('origin', 'a')]).recorded, false);
  assess([record('one', 'b'), record('two', 'b')]);
  assess([record('three', 'b')]);
  assert.equal(library.list()[0].successes, 1);
  assert.equal(library.list()[0].status, 'candidate');
  assert.equal(assess([record('two', 'b')]).recorded, false);
  assess([record('four', 'c')]);
  assert.equal(library.list()[0].status, 'candidate');
  assert.equal(library.list()[0].independentSessions, 1);
  assess([record('ok', 'd'), record('bad', 'd', true)], 'failure');
  assert.doesNotThrow(() => assess([record('ok', 'd')]));
  assert.equal(library.list()[0].failures, 1);
  assert.equal(library.list()[0].status, 'needs-review');
  assert.throws(() => assess([record('bad', 'd')]), /Conflicting/);
  assert.throws(() => assess([{ ...record('malformed', 'e'), toolCallId: undefined }]), /actual execution/);
});

test('legacy feedback migrates conservatively and preserves failure warnings', async t => {
  const f = await fixture(t), filePath = join(f.directory, 'legacy.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA application_id=1430408267; PRAGMA user_version=2;
    CREATE TABLE lessons (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE feedback (lesson_id TEXT NOT NULL, source_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(lesson_id, source_id)) STRICT;
    CREATE TABLE learning_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;`);
  db.prepare('INSERT INTO lessons VALUES (?, ?, ?)').run('old', JSON.stringify({ title: 'Legacy', trigger: 'Read', steps: ['Check'], source: { sessionId: 's', workerId: 'w', evidence: [] } }), new Date().toISOString());
  for (const id of ['a', 'b', 'c']) db.prepare('INSERT INTO feedback VALUES (?, ?, ?)').run('old', id, 'success');
  db.prepare('INSERT INTO feedback VALUES (?, ?, ?)').run('old', 'd', 'failure');
  db.close();
  const library = await LearningLibrary.open({ filePath });
  try {
    assert.equal(library.list()[0].successes, 0);
    assert.equal(library.list()[0].failures, 1);
    assert.equal(library.list()[0].status, 'needs-review');
  } finally { library.close(); }
});

test('schema 4 migration removes duplicated cross-method credit without erasing feedback', async t => {
  const f = await fixture(t), filePath = join(f.directory, 'schema4.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA application_id=1430408267; PRAGMA user_version=4;
    CREATE TABLE lessons (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, family_id TEXT NOT NULL, parent_id TEXT) STRICT;
    CREATE TABLE feedback (lesson_id TEXT NOT NULL, source_id TEXT NOT NULL, outcome TEXT NOT NULL, assessment_id TEXT NOT NULL, fingerprint TEXT, context_id TEXT, PRIMARY KEY(lesson_id, source_id)) STRICT;
    CREATE TABLE learning_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
    CREATE TABLE evidence_claims (family_id TEXT NOT NULL, fingerprint TEXT NOT NULL, lesson_id TEXT NOT NULL, PRIMARY KEY(family_id, fingerprint)) STRICT;`);
  const fingerprint = learningFingerprint({ toolName: 'inspect_source', args: { resource: 'trial' } });
  for (const id of ['first', 'renamed']) {
    const payload = { title: id, trigger: 'Inspect source', steps: ['Check'], source: { sessionId: 'origin', workerId: 'w', evidence: [{ tool: 'inspect_source', toolCallId: 'origin' }] } };
    db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?)').run(id, JSON.stringify(payload), '2026-01-01', `family-${id}`, null);
    db.prepare('INSERT INTO feedback VALUES (?, ?, ?, ?, ?, ?)').run(id, `source-${id}`, 'success', `attempt-${id}`, fingerprint, 'session-trial');
    db.prepare('INSERT INTO evidence_claims VALUES (?, ?, ?)').run(`family-${id}`, fingerprint, id);
  }
  db.close();
  const library = await LearningLibrary.open({ filePath });
  try {
    assert.equal(library.list().reduce((sum, item) => sum + item.successes, 0), 1);
    const result = library.feedback('renamed', { sessionId: 'new', workerId: 'w', outcome: 'success', records: [{
      sessionId: 'new', workerId: 'w', attemptId: 'new', status: 'completed', isError: false, toolName: 'inspect_source', toolCallId: 'new',
      learningFingerprint: fingerprint, learningRequestFingerprint: learningRequestFingerprint({ toolName: 'inspect_source', args: { resource: 'trial' } })
    }] });
    assert.equal(result.recorded, false);
  } finally { library.close(); }
  const inspect = new DatabaseSync(filePath);
  try { assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM feedback').get().count, 2); }
  finally { inspect.close(); }
});

test('curated methods cross session boundaries, raw logs stay local, live readers see feedback', async t => {
  const f = await fixture(t), a = await f.runtime('session-a'), b = await f.runtime('session-b');
  await a.record('call-1');
  const local = (await a.tool.execute('learn', input)).details;
  const shared = (await a.tool.execute('publish', { action: 'publish', id: local.id })).details;
  assert.notEqual(local.id, shared.id);
  const recall = () => b.tool.execute('recall', { action: 'recall', query: 'source' }).then(value => value.details);
  const result = await recall();
  assert.equal(result.libraryAvailable, true);
  assert.equal(result.lessons[0].scope, 'library');
  assert.equal(result.lessons[0].source.sessionId, 'session-a');
  assert.doesNotMatch(JSON.stringify(result), /Private raw output/);
  await b.record('call-1');
  const feedback = { action: 'feedback', id: shared.id, outcome: 'success', tool_call_ids: ['call-1'] };
  await b.tool.execute('feedback', feedback); await b.tool.execute('feedback', feedback);
  assert.equal((await recall()).lessons[0].successes, 1);
  await b.record('call-2', true);
  await assert.rejects(b.tool.execute('feedback', { ...feedback, tool_call_ids: ['call-2'] }), /outcome/);
  await b.tool.execute('feedback', { ...feedback, outcome: 'failure', tool_call_ids: ['call-2'] });
  assert.equal((await recall()).lessons[0].status, 'needs-review');
  assert.match(await a.runtime.contextProvider({ node: { id: 'worker' } }), /needs-review/);
  await a.runtime.close(); await b.runtime.close();
  const c = await f.runtime('session-c');
  const recovered = (await c.tool.execute('recall', { action: 'recall' })).details.lessons[0];
  assert.equal(recovered.failures, 1);
  assert.equal(recovered.id, shared.id);
});

test('publishing is idempotent and changed procedures create independent versions', async t => {
  const f = await fixture(t), a = await f.runtime('a');
  await a.record('call-1');
  const original = (await a.tool.execute('learn', input)).details;
  const first = (await a.tool.execute('publish', { action: 'publish', id: original.id })).details;
  assert.deepEqual((await a.tool.execute('publish', { action: 'publish', id: original.id })).details, first);
  await a.tool.execute('learn', { ...input, steps: ['Read source', 'Use a stronger verification'] });
  await assert.rejects(a.tool.execute('publish', { action: 'publish', id: original.id }), /new host-recorded observation/);
  await a.record('call-2');
  await a.tool.execute('learn', { ...input, tool_call_ids: ['call-2'], steps: ['Read source', 'Use a stronger verification'] });
  const next = (await a.tool.execute('publish', { action: 'publish', id: original.id })).details;
  assert.notEqual(next.id, first.id);
  const shared = (await a.tool.execute('recall', { action: 'recall' })).details.lessons.filter(item => item.scope === 'library');
  assert.equal(shared.length, 2);
  assert.equal(shared.find(item => item.id === next.id).parentId, first.id);
  assert.equal(shared.find(item => item.id === next.id).needsValidation, true);
});

test('publication and feedback reject foreign ownership, missing evidence and absent library', async t => {
  const f = await fixture(t), a = await f.runtime('a');
  await a.record('call-1');
  const local = (await a.tool.execute('learn', input)).details;
  const [other] = await a.runtime.forWorker('other');
  await assert.rejects(other.execute('publish', { action: 'publish', id: local.id }), /own local/);
  await assert.rejects(a.tool.execute('feedback', { action: 'feedback', id: 'missing', outcome: 'success', tool_call_ids: ['unknown'] }), /actual tool/);
  await a.runtime.store.commit(state => { state.toolEvidence[0].digest = 'changed'; });
  await assert.rejects(a.tool.execute('publish', { action: 'publish', id: local.id }), /changed/);
  const localOnly = await createInternalTools({ sessionId: 'local', allowedTools: ['learn_capability'] });
  t.after(() => localOnly.close());
  const [tool] = await localOnly.forWorker('worker');
  await assert.rejects(tool.execute('publish', { action: 'publish', id: 'unknown' }), /not configured/);
});

test('independent library connections preserve concurrent methods and capacity checks', async t => {
  const f = await fixture(t), filePath = join(f.directory, 'bounded.sqlite');
  const a = await LearningLibrary.open({ filePath, maxLessons: 2 });
  const b = await LearningLibrary.open({ filePath, maxLessons: 2 });
  try {
    const lesson = { title: 'One', trigger: 'Condition', steps: ['Check'], workerId: 'w', evidence: [{ toolCallId: 'c' }] };
    a.publish(lesson, 'a'); b.publish({ ...lesson, title: 'Two' }, 'b');
    assert.equal(a.list().length, 2);
    assert.throws(() => a.publish({ ...lesson, title: 'Three' }, 'a'), /capacity/);
    assert.equal(b.list().length, 2);
  } finally { a.close(); b.close(); }
});

test('bundled self-learning skill is discoverable by the real skills middleware', async () => {
  const skills = await createSkillsMiddleware({ skills: [{ directory: resolve('src/harness/agents/skills/self-learning') }] });
  try {
    assert.equal(skills.list()[0].name, 'self-learning');
    assert.match(await skills.contextProvider({ node: { id: 'worker' } }), /self-learning/);
  } finally { await skills.close(); }
});
