import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createInternalTools } from '../../intools/index.mjs';
import { HarnessDatabase } from '../../blackboard/database/database.mjs';
import { LearningLibrary } from '../library.mjs';
import { enqueueLearningWork } from '../queue.mjs';
import { startLocalLearningRecovery } from '../recovery.mjs';

const evidence = index => ({ sessionId: 'recover', workerId: 'worker', toolCallId: `call-${index}`, attemptId: 'attempt',
  toolName: 'read_file', status: 'completed', isError: false, digest: `digest-${index}`, observations: 'Read result', learningInputKeys: ['path'], imageCount: 0 });
const candidate = { title: 'Recovered procedure', trigger: 'Inspect a file', steps: ['Read', 'Verify'], tool_call_ids: ['call-3'], portable: true };
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'learning-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function savedStore(root, count, reflection = false) {
  const store = await MemoryStore.open({ filePath: join(root, 'memory.json'), sessionId: 'recover' });
  await store.commit(state => { state.toolEvidence = Array.from({ length: count }, (_, index) => evidence(index + 1)); enqueueLearningWork(state, { reflection }); });
  return store;
}
async function registered(root, count = 3) {
  const database = await HarnessDatabase.open({ filePath: join(root, 'session.sqlite') });
  database.ensureSession({ sessionId: 'recover', goal: 'Original task must not execute again' });
  const lease = database.acquireSession('recover');
  const store = new MemoryStore({ sessionId: 'recover', persist: value => database.saveMemory('recover', value) });
  await store.commit(state => { state.toolEvidence = Array.from({ length: count }, (_, i) => evidence(i + 1)); enqueueLearningWork(state, { reflection: true }); });
  const libraryFile = join(root, 'learning.sqlite');
  const library = await LearningLibrary.open({ filePath: libraryFile });
  library.registerSource({ filePath: database.filePath, sessionId: 'recover', reflection: true });
  library.close();
  return { database, lease, store, libraryFile };
}

test('restart recovers the entire backlog beyond 32 records, without reprocessing completed work', async t => {
  const root = await scratch(t);
  await savedStore(root, 75);
  const options = { sessionId: 'recover', memoryFile: join(root, 'memory.json'), allowedTools: [], knowledge: { maxPending: 4 } };
  const first = await createInternalTools(options);
  try {
    await first.flushLearning();
    assert.equal(first.learningStatus().completed, 75);
    assert.equal(first.learningStatus().pending, 0);
    assert.equal(first.learningStatus().dropped, 0);
  } finally { await first.close(); }
  const second = await createInternalTools(options);
  try { await second.flushLearning(); assert.equal(second.learningStatus().processed, 0); assert.equal(second.learningStatus().completed, 75); }
  finally { await second.close(); }
});

test('a killed process leaves its reflection pending for the next runtime', { timeout: 15000 }, async t => {
  const root = await scratch(t);
  const moduleURL = pathToFileURL(join(import.meta.dirname, '../../intools/index.mjs')).href;
  const script = `import { createInternalTools } from ${JSON.stringify(moduleURL)};
    setInterval(() => {}, 1000);
    const runtime = await createInternalTools({ sessionId: 'recover', memoryFile: ${JSON.stringify(join(root, 'memory.json'))}, allowedTools: [], knowledge: {
      reflect: async () => { process.stdout.write('REFLECTING\\n'); return new Promise(() => {}); }
    } });
    for (let i = 1; i <= 3; i++) await runtime.onToolResult({ node: { id: 'worker' }, attempt: { id: 'a' }, entry: {
      toolCallId: 'call-' + i, toolName: 'read_file', status: 'completed', isError: false, args: { path: 'source-' + i }, result: { content: [{ type: 'text', text: 'Read' }] }
    } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.stdout.on('data', data => { output += data; if (output.includes('REFLECTING')) resolve(); });
    child.once('error', reject); child.once('exit', () => reject(new Error(errors || 'Child exited before reflection')));
  });
  child.kill('SIGKILL'); await exited;
  const saved = await MemoryStore.open({ filePath: join(root, 'memory.json'), sessionId: 'recover' });
  assert.equal(saved.snapshot().agentKnowledge.queue.jobs.find(job => job.kind === 'reflection').status, 'running');
  let calls = 0;
  const runtime = await createInternalTools({ sessionId: 'recover', store: saved, allowedTools: [], knowledge: { reflect: async () => { calls++; return [candidate]; } } });
  try {
    await runtime.flushLearning();
    assert.equal(calls, 1);
    assert.equal(runtime.learningStatus().pending, 0);
    assert.equal(saved.snapshot().agentKnowledge.queue.jobs.find(job => job.kind === 'reflection').attempts, 1);
  } finally { await runtime.close(); }
});

test('checkpointed model output is applied after restart without another model request', async t => {
  const root = await scratch(t), store = await savedStore(root, 3, true);
  await store.commit(state => {
    for (const job of state.agentKnowledge.queue.jobs) {
      if (job.kind === 'base') job.status = 'completed';
      else { job.status = 'running'; job.attempts = 1; job.candidates = [candidate]; }
    }
  });
  const runtime = await createInternalTools({ sessionId: 'recover', memoryFile: join(root, 'memory.json'), allowedTools: [], knowledge: {
    reflect: async () => { throw new Error('Model must not be called'); }
  } });
  try {
    await runtime.flushLearning();
    assert.equal(runtime.learningStatus().reflections, 0);
    assert.equal(runtime.learningStatus().pending, 0);
    assert.equal(runtime.store.snapshot().agentKnowledge.lessons[0].title, candidate.title);
  } finally { await runtime.close(); }
});

test('model budget exhaustion defers persisted jobs and a new runtime completes them', async t => {
  const root = await scratch(t); await savedStore(root, 6, true);
  const options = { sessionId: 'recover', memoryFile: join(root, 'memory.json'), allowedTools: [], knowledge: { maxReflections: 1, reflect: async () => [] } };
  const first = await createInternalTools(options);
  try { await first.flushLearning(); assert.equal(first.learningStatus().reflections, 1); assert.equal(first.learningStatus().pending, 1); }
  finally { await first.close(); }
  const second = await createInternalTools(options);
  try { await second.flushLearning(); assert.equal(second.learningStatus().reflections, 1); assert.equal(second.learningStatus().pending, 0); }
  finally { await second.close(); }
});

test('retry deadlines and attempts survive restart; permanent failures stay inspectable', async t => {
  const root = await scratch(t); await savedStore(root, 3, true);
  const options = { sessionId: 'recover', memoryFile: join(root, 'memory.json'), allowedTools: [], knowledge: {
    maxAttempts: 2, retryBaseMs: 60000, reflect: async () => { throw new Error('offline'); }
  } };
  const first = await createInternalTools(options);
  try { await first.flushLearning(); assert.equal(first.learningStatus().failures, 1); }
  finally { await first.close(); }
  const second = await createInternalTools(options);
  try {
    await second.flushLearning(); assert.equal(second.learningStatus().reflections, 0);
    await second.store.commit(state => { state.agentKnowledge.queue.jobs.find(job => job.kind === 'reflection').nextAttemptAt = 0; });
    await second.flushLearning(); assert.equal(second.learningStatus().failed, 1);
    assert.equal(second.store.snapshot().agentKnowledge.queue.jobs.find(job => job.kind === 'reflection').attempts, 2);
  } finally { await second.close(); }
});

test('invalid checkpointed reflection stops once without a provider request or learned method', async t => {
  const root = await scratch(t), store = await savedStore(root, 3, true);
  await store.commit(state => {
    for (const job of state.agentKnowledge.queue.jobs) {
      if (job.kind === 'base') job.status = 'completed';
      else { job.status = 'running'; job.attempts = 1; job.candidates = [{ ...candidate, tool_call_ids: ['outside-window'] }]; }
    }
  });
  let calls = 0;
  const options = { sessionId: 'recover', memoryFile: join(root, 'memory.json'), allowedTools: [], knowledge: {
    maxAttempts: 3, retryBaseMs: 1, reflect: async () => { calls++; return [candidate]; }
  } };
  const runtime = await createInternalTools(options);
  try {
    await runtime.flushLearning(); await runtime.flushLearning();
    const failed = runtime.store.snapshot().agentKnowledge.queue.jobs.find(job => job.kind === 'reflection');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.errorCode, 'KNOWLEDGE_REFLECTION_INVALID');
    assert.equal(runtime.store.snapshot().agentKnowledge.lessons.length, 0);
    assert.equal(calls, 0);
  } finally { await runtime.close(); }
  const reopened = await createInternalTools(options);
  try { await reopened.flushLearning(); assert.equal(reopened.learningStatus().reflections, 0); assert.equal(calls, 0); }
  finally { await reopened.close(); }
});

test('offline application startup completes local work but preserves unreflected jobs without a provider', async t => {
  const root = await scratch(t), saved = await registered(root);
  saved.lease.release(); saved.database.close();
  const recovery = await startLocalLearningRecovery({ libraryFile: saved.libraryFile });
  try {
    await recovery.runOnce();
    const db = await HarnessDatabase.open({ filePath: join(root, 'session.sqlite') });
    try {
      const memory = db.loadSession('recover').memory;
      assert.equal(memory.agentKnowledge.queue.jobs.filter(job => job.kind === 'base' && job.status === 'completed').length, 3);
      assert.equal(memory.agentKnowledge.queue.jobs.find(job => job.kind === 'reflection').status, 'pending');
      assert.equal(db.loadSession('recover').record, undefined, 'No foreground task was resumed');
    } finally { db.close(); }
  } finally { await recovery.close(); }
});

test('offline recovery applies saved candidates and skips sessions with a live owner', async t => {
  const root = await scratch(t), saved = await registered(root);
  await saved.store.commit(state => { const job = state.agentKnowledge.queue.jobs.find(job => job.kind === 'reflection'); job.status = 'running'; job.candidates = [candidate]; job.attempts = 1; });
  const recovery = await startLocalLearningRecovery({ libraryFile: saved.libraryFile });
  try {
    await recovery.runOnce(); assert.equal(recovery.status().busy, 1);
    saved.lease.release();
    await recovery.runOnce();
    const memory = saved.database.loadSession('recover').memory;
    assert.equal(memory.agentKnowledge.queue.jobs.every(job => job.status === 'completed'), true);
    assert.ok(memory.agentKnowledge.lessons.some(lesson => lesson.title === candidate.title));
    const release = await recovery.pause();
    const before = recovery.status().restored;
    await recovery.runOnce(); assert.equal(recovery.status().restored, before);
    release(); release(); assert.equal(recovery.status().paused, false);
  } finally { await recovery.close(); saved.lease.release(); saved.database.close(); }
});

test('library schema 1 migrates without losing existing lessons', async t => {
  const root = await scratch(t), filePath = join(root, 'old.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA application_id=1430408267; PRAGMA user_version=1;
    CREATE TABLE lessons (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE feedback (lesson_id TEXT NOT NULL, source_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(lesson_id, source_id)) STRICT;`);
  db.prepare('INSERT INTO lessons VALUES (?, ?, ?)').run('existing', JSON.stringify({ title: 'Existing lesson', trigger: 'Test', steps: ['Check'] }), new Date().toISOString());
  db.close();
  const library = await LearningLibrary.open({ filePath });
  try { assert.deepEqual(library.sources(), []); assert.equal(library.list()[0].title, 'Existing lesson'); }
  finally { library.close(); }
});

test('offline startup discovers legacy task databases without prior source registration', async t => {
  const root = await scratch(t);
  const filePath = join(root, 'legacy', 'assist.sqlite');
  const database = await HarnessDatabase.open({ filePath });
  database.ensureSession({ sessionId: 'recover', goal: 'Legacy task' });
  const lease = database.acquireSession('recover');
  const store = new MemoryStore({ sessionId: 'recover', persist: value => database.saveMemory('recover', value) });
  await store.commit(state => { state.toolEvidence = [evidence(1)]; });
  lease.release(); database.close();
  const recovery = await startLocalLearningRecovery({ libraryFile: join(root, 'learning.sqlite'), storageDirectory: join(root, 'legacy') });
  try {
    await recovery.runOnce();
    const restored = await HarnessDatabase.open({ filePath });
    try { assert.equal(restored.loadSession('recover').memory.agentKnowledge.queue.jobs[0].status, 'completed'); }
    finally { restored.close(); }
  } finally { await recovery.close(); }
});
