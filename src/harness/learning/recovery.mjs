import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessDatabase } from '../blackboard/database/database.mjs';
import { MemoryStore } from '../intools/shared/store/memory-store.mjs';
import { createKnowledge } from './index.mjs';
import { LearningLibrary } from './library.mjs';
import { createBackgroundLearning } from './runner.mjs';

/** Offline startup recovery. No model client, network transport, or execution tools. */
export async function startLocalLearningRecovery({ libraryFile, onEvent, intervalMs = 30000, maxSourcesPerPass = 8,
  storageDirectory, reflection = true, maxLessons, maxSharedLessons, maxContextChars, maxPending, maxAttempts, retryBaseMs } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) throw new RangeError('Invalid recovery interval');
  if (!Number.isSafeInteger(maxSourcesPerPass) || maxSourcesPerPass < 1 || maxSourcesPerPass > 1000) throw new RangeError('Invalid source batch size');
  const library = await LearningLibrary.open({ filePath: libraryFile, maxLessons: maxSharedLessons });
  let pass, current, timer, cursor = 0, paused = 0, closing = false, closePromise;
  let restored = 0, busy = 0, failures = 0;
  let discovered = !storageDirectory;
  const report = event => { try { Promise.resolve(onEvent?.(event)).catch(() => {}); } catch {} };
  async function discover() {
    const known = new Set(library.sources().map(source => JSON.stringify([source.filePath, source.sessionId])));
    const directories = [storageDirectory];
    let visited = 0;
    while (directories.length && !closing && !paused) {
      if (++visited > 10000) throw new Error('Learning source discovery directory limit reached');
      const directory = directories.pop();
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (closing || paused) return;
        if (entry.isSymbolicLink()) continue;
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) { directories.push(filePath); continue; }
        if (!entry.isFile() || !['assist.sqlite', 'harness.sqlite'].includes(entry.name)) continue;
        let database;
        try {
          database = await HarnessDatabase.open({ filePath });
          for (let offset = 0; ; offset += 100) {
            const sessions = database.listSessions({ offset });
            for (const session of sessions) {
              const id = JSON.stringify([database.filePath, session.sessionId]);
              if (!known.has(id) && database.loadSession(session.sessionId)?.memory?.toolEvidence?.length) {
                library.registerSource({ filePath: database.filePath, sessionId: session.sessionId, reflection }); known.add(id);
              }
            }
            if (sessions.length < 100) break;
          }
        } catch { failures++; report({ type: 'knowledge.failed', message: 'A legacy learning source could not be inspected locally.' }); }
        finally { database?.close(); }
      }
    }
    if (!closing && !paused) discovered = true;
  }
  async function recover(source) {
    if (!source.enabled || closing || paused) return;
    let database, lease, runner;
    try {
      if (!(await stat(source.filePath)).isFile() || closing || paused) return;
      database = await HarnessDatabase.open({ filePath: source.filePath });
      if (closing || paused || !database.loadSession(source.sessionId)?.memory) return;
      lease = database.acquireSession(source.sessionId);
      const snapshot = database.loadSession(source.sessionId).memory;
      const store = MemoryStore.fromSnapshot({ snapshot, persist: value => database.saveMemory(source.sessionId, value) });
      const knowledge = createKnowledge({ maxLessons, maxContextChars, store, library });
      runner = createBackgroundLearning({ maxPending, maxAttempts, retryBaseMs, store, knowledge,
        reflection: source.reflection, maxReflections: 0, onEvent: report });
      current = runner;
      if (closing || paused) await runner.close(); else await runner.flush();
      restored++; report({ type: 'knowledge.recovered', sessionId: source.sessionId, pending: runner.status().pending });
    } catch (error) {
      if (error.code === 'SESSION_LOCKED') busy++;
      else if (error.code !== 'ENOENT') { failures++; report({ type: 'knowledge.failed', message: 'Local learning recovery deferred; original session data retained.' }); }
    } finally {
      try { await runner?.close(); }
      catch { failures++; report({ type: 'knowledge.failed', message: 'Could not checkpoint learning recovery.' }); }
      finally { current = undefined; try { lease?.release(); } finally { database?.close(); } }
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!closing && !paused) { timer = setTimeout(runOnce, intervalMs); timer.unref?.(); }
  }
  function runOnce() {
    if (closing || paused) return Promise.resolve();
    if (pass) return pass;
    pass = Promise.resolve().then(async () => {
      if (!discovered) await discover();
      const sources = library.sources();
      const count = Math.min(maxSourcesPerPass, sources.length);
      for (let index = 0; index < count && !closing && !paused; index++) {
        const source = sources[cursor % sources.length]; cursor++;
        await recover(source);
      }
    }).catch(() => { failures++; report({ type: 'knowledge.failed', message: 'Local recovery scan failed.' }); })
      .finally(() => { pass = undefined; schedule(); });
    return pass;
  }
  void runOnce();
  return {
    runOnce,
    status: () => ({ running: Boolean(pass), paused: paused > 0, restored, busy, failures }),
    async pause() {
      paused++; clearTimeout(timer);
      try { await current?.close(); await pass; }
      catch { /* Foreground work must not depend on a background checkpoint succeeding. */ }
      let released = false;
      return () => { if (released) return; released = true; paused--; schedule(); };
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearTimeout(timer);
      closePromise = Promise.resolve().then(async () => {
        try { await current?.close(); await pass; } finally { library.close(); }
      });
      return closePromise;
    }
  };
}
