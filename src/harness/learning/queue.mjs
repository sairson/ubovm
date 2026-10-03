import { createHash } from 'node:crypto';
import { LearningValidationError } from './validation.mjs';

const excluded = new Set(['learn_capability', 'note', 'todo', 'inspect_harness', 'load_skill', 'read_skills_resource']);
export const eligibleEvidence = record => record?.status === 'completed' && !excluded.has(record.toolName);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = item => ({ toolCallId: item.toolCallId, digest: item.digest });

export function learningQueue(state) {
  state.agentKnowledge ??= { version: 1, lessons: [] };
  state.agentKnowledge.queue ??= { version: 1, cursor: 0, jobs: [], windows: [] };
  const queue = state.agentKnowledge.queue;
  if (queue.version !== 1 || !Number.isSafeInteger(queue.cursor) || queue.cursor < 0 ||
      queue.cursor > (state.toolEvidence?.length ?? 0) || !Array.isArray(queue.jobs) || !Array.isArray(queue.windows)) throw new Error('Invalid learning queue');
  const ids = new Set();
  for (const job of queue.jobs) {
    if (!job || !['base', 'reflection'].includes(job.kind) || typeof job.id !== 'string' || ids.has(job.id) ||
        typeof job.workerId !== 'string' || !Array.isArray(job.refs) || !job.refs.length || job.refs.length > 8 ||
        job.refs.some(item => !item || typeof item.toolCallId !== 'string' || typeof item.digest !== 'string') ||
        !['pending', 'running', 'completed', 'failed'].includes(job.status) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 ||
        !Number.isFinite(job.nextAttemptAt) || job.nextAttemptAt < 0) throw new Error('Invalid learning job');
    ids.add(job.id);
  }
  for (const window of queue.windows) {
    if (!window || typeof window.workerId !== 'string' || !Array.isArray(window.refs) || !Array.isArray(window.successes) ||
        window.refs.length > 8 || window.refs.length !== window.successes.length ||
        (window.fingerprints !== undefined && (!Array.isArray(window.fingerprints) || window.fingerprints.length !== window.refs.length)) ||
        (window.reflectedFingerprints !== undefined && (!Array.isArray(window.reflectedFingerprints) || window.reflectedFingerprints.length > 8)) ||
        !Number.isSafeInteger(window.unreflected) || window.unreflected < 0) throw new Error('Invalid learning window');
  }
  return queue;
}

/** Called inside the evidence transaction: a durable observation and its work cannot diverge. */
export function enqueueLearningWork(state, { reflection = false, finalize = false } = {}) {
  const queue = learningQueue(state), evidence = state.toolEvidence ?? [];
  const windows = new Map(queue.windows.map(window => [window.workerId, window]));
  const ids = new Set(queue.jobs.map(job => job.id));
  const append = (kind, workerId, refs) => {
    const key = kind === 'reflection' ? hash(refs.map(item => [workerId, item.toolCallId, item.digest])) : hash([workerId, refs.at(-1).toolCallId, refs.at(-1).digest]);
    const id = `${kind}:${key}`;
    if (ids.has(id)) return;
    ids.add(id);
    queue.jobs.push({ id, kind, workerId, refs: structuredClone(refs), status: kind === 'reflection' && state.agentKnowledge.reflectionKeys?.includes(key) ? 'completed' : 'pending',
      attempts: 0, nextAttemptAt: 0, createdAt: Date.now() });
  };
  const reflectWindow = window => {
    if (!reflection || window.refs.length < 3 || !window.successes.some(Boolean)) return;
    const known = window.fingerprints?.filter(Boolean) ?? [];
    // Legacy windows have no novelty metadata and retain their recovery path.
    if (known.length === window.refs.length && (new Set(known).size < 2 ||
        known.every(fingerprint => window.reflectedFingerprints?.includes(fingerprint)))) {
      window.unreflected = 0;
      return;
    }
    append('reflection', window.workerId, window.refs);
    window.reflectedFingerprints = [...new Set(known)].slice(-8);
    window.unreflected = 0;
  };
  while (queue.cursor < evidence.length) {
    const record = evidence[queue.cursor++];
    if (!eligibleEvidence(record)) continue;
    let window = windows.get(record.workerId);
    if (!window) {
      window = { workerId: record.workerId, refs: [], successes: [], unreflected: 0 };
      windows.set(record.workerId, window); queue.windows.push(window);
    }
    window.fingerprints ??= Array(window.refs.length).fill(null);
    window.refs.push(ref(record)); window.successes.push(!record.isError);
    window.fingerprints.push(record.learningFingerprint ?? null);
    window.fingerprints = window.fingerprints.slice(-8);
    window.refs = window.refs.slice(-8); window.successes = window.successes.slice(-8); window.unreflected++;
    append('base', record.workerId, window.refs);
    if (window.unreflected >= 3) reflectWindow(window);
  }
  if (finalize) for (const window of windows.values()) if (window.unreflected) reflectWindow(window);
  return queue;
}

export function jobEvidence(store, job) {
  return job.refs.map(reference => {
    const found = store.toolEvidence(job.workerId, reference.toolCallId);
    if (!found || found.digest !== reference.digest) throw new LearningValidationError('Learning job evidence is missing or changed', 'KNOWLEDGE_EVIDENCE_CHANGED');
    return found;
  });
}

export function recoverLearningJobs(state) {
  for (const job of learningQueue(state).jobs) {
    if (job.status === 'running') {
      job.status = 'pending'; job.nextAttemptAt = 0;
      job.attempts = Math.max(0, job.attempts - 1);
    }
  }
}
