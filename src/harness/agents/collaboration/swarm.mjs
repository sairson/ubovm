import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { flagHelpProperties, withActionHelp, withProgressiveDisclosure } from '../../intools/shared/disclosure.mjs';
import {
  SPAWN_WORKER_CATALOG, WAIT_WORKERS_CATALOG, CANCEL_WORKERS_CATALOG, LIST_WORKERS_CATALOG,
  MANAGE_WORKERS_CATALOG,
} from '../../intools/shared/tool-catalogs.mjs';

const active = new Set(['queued', 'running', 'waiting']);
const terminal = new Set(['completed', 'failed', 'interrupted']);
const textLimits = { task: 32768, result: 16384, error: 4096, name: 80, cancelReason: 1024 };
const priorityLimit = { min: 0, max: 9 };
const normalizePriority = value => {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < priorityLimit.min || value > priorityLimit.max) {
    throw new TypeError(`priority must be an integer ${priorityLimit.min}..${priorityLimit.max}`);
  }
  return value;
};
const admissionRank = worker => {
  const data = worker.data ?? worker;
  return [-(data.priority ?? 0), worker.seq ?? data.createdAt ?? 0, data.id ?? ''];
};
const compareAdmission = (left, right) => {
  const a = admissionRank(left), b = admissionRank(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
};
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const errorText = error => {
  try { return String(error instanceof Error ? error.message : error); }
  catch { return 'Worker failed with an unreadable error'; }
};
const abortError = () => new DOMException('Collaboration swarm closed', 'AbortError');
const textFields = (key, text, wasTruncated = false) => ({ [key]: text.slice(0, textLimits[key]),
  ...(wasTruncated || text.length > textLimits[key] ? { [`${key}Truncated`]: true } : {}) });

/**
 * A bounded tree of independent chat/tool loops. runWorker must honor its signal.
 * Saved in-flight work is evidence only and is never replayed. settle(ownerId)
 * returns all descendant snapshots and releases a worker's slot while waiting.
 */
export function createSwarm({ sessionId, maxConcurrency = 3, maxWorkers = 12, maxDepth = 2,
  runWorker, onEvent, signal, persist, state } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('swarm requires sessionId');
  if (typeof runWorker !== 'function') throw new TypeError('swarm requires runWorker');
  for (const [key, value] of Object.entries({ persist, onEvent })) {
    if (value !== undefined && typeof value !== 'function') throw new TypeError(`${key} must be a function`);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (state !== undefined && state !== null && (typeof state !== 'object' || Array.isArray(state))) throw new TypeError('state must be an object');
  if (state?.workers !== undefined && !Array.isArray(state.workers)) throw new TypeError('Saved workers must be an array');
  for (const [key, value] of Object.entries({ maxConcurrency, maxWorkers, maxDepth })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
  }
  if (state?.sessionId && state.sessionId !== sessionId) throw new TypeError('Saved swarm belongs to another session');

  const workers = new Map(), watchers = new Set(), running = new Set(), spawning = new Set(), resumes = [];
  let slots = 0, created = 0, closed = false, closePromise, persistenceError;
  let persistTail = Promise.resolve();
  let omittedWorkerCount = state?.omittedWorkerCount ?? 0;
  let omittedInterruptedWorkerCount = state?.omittedInterruptedWorkerCount ?? 0;
  for (const [key, value] of Object.entries({ omittedWorkerCount, omittedInterruptedWorkerCount })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a nonnegative safe integer`);
  }
  if (omittedInterruptedWorkerCount > omittedWorkerCount) throw new TypeError('Omitted interrupted count exceeds total omitted count');
  const savedWorkers = state?.workers ?? [];
  function omit(saved) {
    omittedWorkerCount = Math.min(Number.MAX_SAFE_INTEGER, omittedWorkerCount + 1);
    if (saved?.status !== 'completed' && saved?.status !== 'failed') {
      omittedInterruptedWorkerCount = Math.min(Number.MAX_SAFE_INTEGER, omittedInterruptedWorkerCount + 1);
    }
  }
  for (let index = 0; index < savedWorkers.length; index++) {
    const saved = savedWorkers[index];
    if (index < savedWorkers.length - 100) { omit(saved); continue; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || typeof saved.id !== 'string' || !saved.id || saved.id.length > 1024 || saved.id === sessionId
      || typeof saved.parentId !== 'string' || !saved.parentId || saved.parentId.length > 1024
      || typeof saved.task !== 'string' || workers.has(saved.id)
      || (saved.profile !== undefined && (typeof saved.profile !== 'string' || saved.profile.length > 80))
      || (saved.modelProfile !== undefined && (typeof saved.modelProfile !== 'string' || !/^[\w.-]{1,86}$/.test(saved.modelProfile)))
      || (saved.dependsOn !== undefined && (!Array.isArray(saved.dependsOn) || saved.dependsOn.length > 8 || saved.dependsOn.some(id => typeof id !== 'string' || !id || id.length > 1024)))
      || (saved.priority !== undefined && (!Number.isSafeInteger(saved.priority) || saved.priority < priorityLimit.min || saved.priority > priorityLimit.max))
      || (!active.has(saved.status) && !terminal.has(saved.status))
      || (saved.depth !== undefined && (!Number.isSafeInteger(saved.depth) || saved.depth < 1))
      || ['createdAt', 'startedAt', 'finishedAt', 'cancelRequestedAt'].some(key => saved[key] !== undefined && (typeof saved[key] !== 'number' || !Number.isFinite(saved[key])))
      || ['name', 'result', 'error', 'cancelReason'].some(key => saved[key] !== undefined && typeof saved[key] !== 'string')) {
      omit(saved); continue;
    }
    const recovered = { id: saved.id, parentId: saved.parentId, ...textFields('task', saved.task, saved.taskTruncated === true),
      depth: saved.depth ?? 1, status: saved.status, createdAt: saved.createdAt ?? Date.now() };
    recovered.priority = saved.priority ?? 0;
    if (saved.dependsOn) recovered.dependsOn = [...new Set(saved.dependsOn)];
    if (saved.profile !== undefined) recovered.profile = saved.profile;
    if (saved.modelProfile !== undefined) recovered.modelProfile = saved.modelProfile;
    for (const key of ['name', 'result', 'error', 'cancelReason']) {
      if (saved[key] !== undefined) Object.assign(recovered, textFields(key, saved[key], saved[`${key}Truncated`] === true));
    }
    for (const key of ['startedAt', 'finishedAt', 'cancelRequestedAt']) if (saved[key] !== undefined) recovered[key] = saved[key];
    if (active.has(recovered.status)) Object.assign(recovered, { status: 'interrupted',
      error: 'Worker was interrupted before this conversation resumed; it was not replayed.', finishedAt: Date.now() });
    workers.set(recovered.id, { data: recovered, historical: true });
  }

  function omissions() { return { omittedWorkerCount, omittedInterruptedWorkerCount }; }
  function snapshot() {
    // Dependency arrays, like other state, must never escape by reference.
    return { version: 1, sessionId, workers: [...workers.values()].map(worker => structuredClone(worker.data)), ...omissions() };
  }
  function changed() {
    const value = snapshot();
    try { Promise.resolve(onEvent?.({ type: 'swarm.status', workers: structuredClone(value.workers), ...omissions() })).catch(() => {}); } catch { /* Observers cannot stop cleanup. */ }
    for (const watcher of [...watchers]) watcher();
    const write = persistTail.then(() => persist?.(value));
    persistTail = write.then(() => {
      // Terminal status is observable before its journal write finishes. Only
      // release waiters once that exact terminal record has become durable.
      for (const saved of value.workers) {
        const worker = workers.get(saved.id);
        if (terminal.has(saved.status) && worker?.data.status === saved.status && worker.data.finishedAt === saved.finishedAt) worker.durableTerminal = true;
      }
      for (const watcher of [...watchers]) watcher();
    }, error => {
      if (persistenceError) return;
      persistenceError = error instanceof Error ? error : new Error(errorText(error));
      // A broken execution journal invalidates every live worker, not only
      // future dispatches. Keep slots held until their cleanup really settles.
      for (const worker of workers.values()) {
        if (!worker.historical && worker.executing && active.has(worker.data.status)) worker.controller.abort(persistenceError);
      }
      schedule();
      for (const watcher of [...watchers]) watcher();
    });
    return write;
  }
  const initialized = changed();
  initialized.catch(() => {});

  function owner(workerId) {
    if (workerId === sessionId) return undefined;
    const worker = workers.get(workerId);
    if (!worker || worker.historical) throw new Error(`Unknown active worker: ${workerId}`);
    return worker;
  }
  function descendant(worker, ownerId) {
    if (worker.data.id === ownerId) return false;
    // Root owns the entire saved tree, including old records whose parents were pruned.
    if (ownerId === sessionId) return true;
    let parentId = worker.data.parentId;
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      if (parentId === ownerId) return true;
      seen.add(parentId);
      parentId = workers.get(parentId)?.data.parentId;
    }
    return false;
  }
  function descendants(ownerId) { return [...workers.values()].filter(worker => descendant(worker, ownerId)); }
  function ancestorOf(candidateId, workerId) {
    let parentId = workers.get(workerId)?.data.parentId;
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      if (parentId === candidateId) return true;
      seen.add(parentId);
      parentId = workers.get(parentId)?.data.parentId;
    }
    return false;
  }
  function readyQueued(ownerId) {
    return [...workers.values()].filter(item => item.ready && item.data.status === 'queued' && descendant(item, ownerId)
      && (item.data.dependsOn ?? []).every(id => workers.get(id)?.data.status === 'completed'));
  }
  function nextQueued(ownerId = sessionId) {
    return readyQueued(ownerId).sort(compareAdmission)[0];
  }
  function occupants() {
    return [...workers.values()].filter(item => item.slot && item.data.status === 'running');
  }
  function readyFocus(ownerId, focus) {
    return (focus ?? readyQueued(ownerId)).filter(item => item.ready && item.data.status === 'queued' && descendant(item, ownerId)
      && (item.data.dependsOn ?? []).every(id => workers.get(id)?.data.status === 'completed')).sort(compareAdmission);
  }
  function preemptableRunners(ownerId, queued) {
    if (!queued.length) return [];
    const best = queued[0];
    return [...workers.values()].filter(item => !item.historical && item.data.status === 'running' && descendant(item, ownerId)
      && !item.controller.signal.aborted && (item.data.priority ?? 0) < (best.data.priority ?? 0)
      && !queued.some(worker => ancestorOf(item.data.id, worker.data.id)))
      .sort((left, right) => (left.data.priority ?? 0) - (right.data.priority ?? 0)
        || (left.data.startedAt ?? 0) - (right.data.startedAt ?? 0) || compareAdmission(left, right));
  }
  function blockage(worker, ownerId = sessionId) {
    if (worker.data.status !== 'queued') return undefined;
    const unmet = (worker.data.dependsOn ?? []).filter(id => workers.get(id)?.data.status !== 'completed');
    if (unmet.length) return { reason: 'dependencies', worker_ids: unmet.slice(0, 8) };
    if (!worker.ready) return { reason: 'persisting' };
    if (slots >= maxConcurrency) {
      const releasing = occupants().filter(item => item.controller.signal.aborted).map(item => item.data.id);
      return {
        reason: 'concurrency',
        occupying: slots,
        ...(releasing.length ? { releasing: releasing.slice(0, 8) } : {}),
        preemptable: preemptableRunners(ownerId, [worker]).slice(0, 8).map(item => item.data.id),
      };
    }
    return { reason: 'dispatching' };
  }
  function present(worker, ownerId = sessionId) {
    const data = structuredClone(worker.data);
    const blocked = blockage(worker, ownerId);
    if (blocked) data.blocked = blocked;
    if (worker.slot && worker.data.cancelRequestedAt) data.releasing = true;
    return data;
  }
  const statusOrder = { running: 0, waiting: 1, queued: 2, interrupted: 3, failed: 4, completed: 5 };
  function presentMany(list, ownerId = sessionId) {
    return list.map(worker => present(worker, ownerId)).sort((left, right) => (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9)
      || (right.priority ?? 0) - (left.priority ?? 0) || (left.createdAt ?? 0) - (right.createdAt ?? 0));
  }
  function preemptSkip(worker) {
    const unmet = (worker.data.dependsOn ?? []).filter(id => workers.get(id)?.data.status !== 'completed');
    if (unmet.length) return 'dependencies';
    if (slots < maxConcurrency) return 'slot_available';
    return 'no_lower_priority_runner';
  }
  function releasingSnapshot() {
    return [...workers.values()].filter(item => item.slot && item.data.cancelRequestedAt)
      .slice(0, 8).map(item => ({ worker_id: item.data.id, priority: item.data.priority ?? 0 }));
  }
  function admissionSnapshot(ownerId) {
    const queued = readyQueued(ownerId).sort(compareAdmission);
    const waiting = resumes.filter(entry => !entry.worker.controller.signal.aborted && descendant(entry.worker, ownerId))
      .sort((left, right) => compareAdmission(left.worker, right.worker));
    const resume = waiting[0]?.worker, queuedHead = queued[0];
    const preferQueue = queuedHead && (!resume || compareAdmission(queuedHead, resume) < 0);
    const next = preferQueue ? queuedHead : resume;
    return {
      occupied_slots: slots, max_concurrency: maxConcurrency,
      next: next ? { worker_id: next.data.id, kind: preferQueue ? 'queue' : 'resume', priority: next.data.priority ?? 0 } : null,
      ready_queue: queued.slice(0, 8).map(worker => ({ worker_id: worker.data.id, priority: worker.data.priority ?? 0 })),
      preemptable: preemptableRunners(ownerId, queued).slice(0, 8).map(worker => ({ worker_id: worker.data.id, priority: worker.data.priority ?? 0 })),
      releasing: releasingSnapshot(),
    };
  }
  function preemptCandidates(ownerId, focus) {
    const queued = readyFocus(ownerId, focus);
    if (!queued.length || slots < maxConcurrency) return [];
    const needed = Math.min(queued.length, maxConcurrency) - (maxConcurrency - slots);
    if (needed <= 0) return [];
    return preemptableRunners(ownerId, queued).slice(0, needed);
  }
  function inspect(ownerId = sessionId) {
    return { workers: presentMany(descendants(ownerId), ownerId), admission: structuredClone(admissionSnapshot(ownerId)) };
  }
  function managementSummary(workerId) {
    const counts = Object.fromEntries([...active, ...terminal].map(status => [status, 0]));
    for (const worker of descendants(workerId)) counts[worker.data.status]++;
    return { counts, capacity: { max_concurrency: maxConcurrency, occupied_slots: slots,
      resuming_workers: resumes.length,
      queued_workers: descendants(workerId).filter(worker => worker.data.status === 'queued').length,
      max_workers: maxWorkers, remaining_workers: maxWorkers - created, max_depth: maxDepth } };
  }
  function ensureOpen(workerId, callSignal) {
    callSignal?.throwIfAborted();
    signal?.throwIfAborted();
    if (persistenceError) throw persistenceError;
    if (closed) throw abortError();
    const parent = owner(workerId);
    parent?.controller.signal.throwIfAborted();
    if (parent && terminal.has(parent.data.status)) throw new Error('Completed workers cannot create or wait for work');
    return parent;
  }
  function release(worker) {
    if (!worker.slot) return;
    worker.slot = false;
    slots--;
  }
  function schedule() {
    if (closed) return;
    if (persistenceError) {
      let updated = false;
      for (const worker of workers.values()) {
        if (worker.historical || worker.data.status !== 'queued') continue;
        Object.assign(worker.data, { status: 'failed', ...textFields('error', errorText(persistenceError)), finishedAt: Date.now() });
        updated = true;
      }
      for (const entry of resumes.splice(0)) entry.reject(persistenceError);
      if (updated) changed().catch(() => {});
      return;
    }
    let blocked = false;
    for (const worker of workers.values()) {
      if (worker.historical || worker.data.status !== 'queued') continue;
      const failed = worker.data.dependsOn?.find(id => ['failed', 'interrupted'].includes(workers.get(id)?.data.status));
      if (failed) {
        Object.assign(worker.data, { status: 'failed', error: `Dependency ${failed} did not complete successfully; this worker was not started.`, finishedAt: Date.now() });
        blocked = true;
      }
    }
    if (blocked) changed().catch(() => {});
    const pruneResumes = () => {
      resumes.sort((left, right) => compareAdmission(left.worker, right.worker));
      while (resumes.length && resumes[0].worker.controller.signal.aborted) {
        const entry = resumes.shift();
        entry.reject(entry.worker.controller.signal.reason);
      }
    };
    while (slots < maxConcurrency) {
      pruneResumes();
      const queued = nextQueued();
      const resume = resumes[0];
      if (!queued && !resume) break;
      if (!queued || resume && compareAdmission(queued, resume.worker) >= 0) {
        const entry = resumes.shift();
        entry.worker.slot = true;
        slots++;
        entry.worker.data.status = 'running';
        changed().then(() => {
          if (persistenceError) entry.reject(persistenceError);
          else if (entry.worker.controller.signal.aborted) entry.reject(entry.worker.controller.signal.reason);
          else if (closed) entry.reject(abortError());
          else entry.resolve();
        }, entry.reject);
        continue;
      }
      const worker = queued;
      worker.slot = true;
      slots++;
      Object.assign(worker.data, { status: 'running', startedAt: Date.now() });
      const launchSaved = changed();
      const task = (async () => {
        try {
          // Persist both the request and its dispatch before invoking an external loop.
          await launchSaved;
          if (persistenceError) throw persistenceError;
          worker.controller.signal.throwIfAborted();
          worker.executing = true;
          const value = await runWorker({ workerId: worker.data.id, parentId: worker.data.parentId,
            task: worker.data.task, depth: worker.data.depth, signal: worker.controller.signal, profile: worker.data.profile, modelProfile: worker.data.modelProfile,
            dependencies: (worker.data.dependsOn ?? []).map(id => {
              const data = workers.get(id).data;
              return { worker_id: id, status: data.status, result: (data.result ?? '').slice(0, 4096),
                resultTruncated: data.resultTruncated === true || (data.result?.length ?? 0) > 4096 };
            }) });
          worker.controller.signal.throwIfAborted();
          Object.assign(worker.data, { status: 'completed', ...textFields('result', typeof value === 'string' ? value : String(value ?? '')) });
        } catch (error) {
          Object.assign(worker.data, { status: worker.controller.signal.aborted ? 'interrupted' : 'failed', ...textFields('error', errorText(error)) });
        } finally {
          worker.data.finishedAt = Date.now();
          release(worker);
          await changed().catch(() => {});
          schedule();
        }
      })();
      running.add(task);
      task.finally(() => { running.delete(task); }).catch(() => {});
    }
  }
  function waitUntil(check, { timeoutMs, callSignal } = {}) {
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watchers.delete(update);
        callSignal?.removeEventListener('abort', aborted);
        callback(value);
      };
      const update = () => { if (persistenceError) finish(reject, persistenceError); else if (check()) finish(resolve, false); };
      const aborted = () => finish(reject, callSignal.reason);
      if (callSignal?.aborted) { aborted(); return; }
      if (persistenceError) { finish(reject, persistenceError); return; }
      if (check()) { resolve(false); return; }
      watchers.add(update);
      callSignal?.addEventListener('abort', aborted, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(resolve, true), timeoutMs);
    });
  }
  async function withoutSlot(workerId, callback) {
    const worker = owner(workerId);
    if (worker?.waitingCall) throw new Error('Worker already has an active wait');
    if (!worker?.slot) return callback();
    worker.waitingCall = true;
    release(worker);
    worker.data.status = 'waiting';
    try {
      await changed();
      schedule();
      return await callback();
    } finally {
      try {
        if (!closed && !worker.controller.signal.aborted) await reacquire(worker);
      } finally { worker.waitingCall = false; }
    }
  }
  function reacquire(worker) {
    return new Promise((resolve, reject) => {
      const signal = worker.controller.signal;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        const index = resumes.indexOf(entry);
        if (index >= 0) resumes.splice(index, 1);
        callback(value);
      };
      const entry = { worker, resolve: () => finish(resolve), reject: error => finish(reject, error) };
      const abort = () => entry.reject(signal.reason);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      resumes.push(entry);
      // Cancellation while waiting for a slot must not depend on an unrelated
      // worker releasing capacity. Admitted workers retain their cleanup slot.
      schedule();
    });
  }
  function combinedSignal(workerId, callSignal) {
    const signals = [signal, owner(workerId)?.controller.signal, callSignal].filter(Boolean);
    return signals.length ? AbortSignal.any(signals) : undefined;
  }
  function spawn(workerId, input, callSignal) {
    const task = createWorker(workerId, input, callSignal);
    spawning.add(task);
    void task.finally(() => spawning.delete(task)).catch(() => {});
    return task;
  }
  async function createWorker(workerId, input = {}, callSignal) {
    const parent = ensureOpen(workerId, callSignal);
    if (persistenceError) throw persistenceError;
    if (typeof input.task !== 'string' || !input.task.trim()) throw new TypeError('task must be a non-empty string');
    if (input.task.length > textLimits.task) throw new RangeError(`task must contain at most ${textLimits.task} characters`);
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 80)) throw new TypeError('name must be a string of at most 80 characters');
    if (input.profile !== undefined && (typeof input.profile !== 'string' || !input.profile || input.profile.length > 80)) throw new TypeError('Invalid Harness profile ID');
    if (input.modelProfile !== undefined && (typeof input.modelProfile !== 'string' || !/^[\w.-]{1,86}$/.test(input.modelProfile))) throw new TypeError('Invalid model profile ID');
    if (input.depends_on !== undefined && (!Array.isArray(input.depends_on) || input.depends_on.length > 8)) throw new TypeError('depends_on must contain at most 8 worker IDs');
    if (input.preempt !== undefined && typeof input.preempt !== 'boolean') throw new TypeError('preempt must be a boolean');
    if (input.reason !== undefined && (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1024)) throw new TypeError('reason must contain 1..1024 characters');
    const priority = normalizePriority(input.priority);
    // Only existing descendants can be referenced: no forward edges, cycles,
    // parent waits or access to another worker's sibling branch.
    const dependencies = selectWorkers(workerId, input.depends_on ?? [], 'depend on');
    const depth = (parent?.data.depth ?? 0) + 1;
    if (depth > maxDepth) throw new Error(`Worker nesting is limited to ${maxDepth} levels`);
    if (created >= maxWorkers) throw new Error(`This conversation turn is limited to ${maxWorkers} workers`);
    created++;
    const data = { id: `${sessionId}/worker-${randomUUID()}`, parentId: workerId, task: input.task.trim(),
      depth, status: 'queued', createdAt: Date.now(), priority, ...(input.name ? { name: input.name } : {}) };
    if (dependencies.length) data.dependsOn = dependencies.map(worker => worker.data.id);
    if (input.profile !== undefined) data.profile = input.profile;
    if (input.modelProfile !== undefined) data.modelProfile = input.modelProfile;
    const worker = { data, controller: new AbortController(), ready: false, slot: false, seq: created };
    workers.set(data.id, worker);
    try {
      await initialized;
      await changed();
      ensureOpen(workerId, callSignal);
      if (persistenceError) throw persistenceError;
      worker.ready = true;
      let preemption = { cancellation_requested: [] };
      if (input.preempt === true) {
        preemption = await cancelLower(workerId, [worker], input.reason?.trim() || 'Preempted for higher-priority spawn', callSignal);
      }
      schedule();
      return report(worker, workerId, preemption, input.preempt === true);
    } catch (error) {
      Object.assign(data, { status: closed || signal?.aborted || callSignal?.aborted || parent?.controller.signal.aborted || worker.controller.signal.aborted ? 'interrupted' : 'failed', ...textFields('error', errorText(error)), finishedAt: Date.now() });
      await changed().catch(() => {});
      throw error;
    }
  }
  function selectWorkers(workerId, ids, verb = 'wait for') {
    if (ids === undefined) return descendants(workerId);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('worker_ids must be an array of worker IDs');
    return [...new Set(ids)].map(id => {
        const worker = workers.get(id);
        if (!worker || !descendant(worker, workerId)) throw new Error(`Cannot ${verb} worker outside your descendants: ${id}`);
        return worker;
    });
  }
  async function wait(workerId, input = {}, callSignal) {
    const parent = ensureOpen(workerId, callSignal);
    if (parent?.waitingCall) throw new Error('Worker already has an active wait');
    const timeoutMs = input.timeout_ms ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new RangeError('timeout_ms must be 0..60000');
    const mode = input.mode ?? 'all';
    if (!['all', 'any'].includes(mode)) throw new TypeError('mode must be all or any');
    const selected = selectWorkers(workerId, input.worker_ids);
    const done = () => !selected.length || selected[mode === 'any' ? 'some' : 'every'](isSettled);
    const timedOut = done() ? false : timeoutMs === 0 ? true : await withoutSlot(workerId,
      () => waitUntil(done, { timeoutMs, callSignal: combinedSignal(workerId, callSignal) }));
    return { workers: selected.map(worker => present(worker, workerId)), timed_out: timedOut, admission: structuredClone(admissionSnapshot(workerId)), ...omissions(),
      ...(timedOut && timeoutMs > 0 ? { guidance: 'Wait timed out. Read workers[].blocked and admission.next/preemptable/releasing; preempt or interrupt instead of waiting on the same occupancy.' } : {}) };
  }
  async function cancel(workerId, input = {}, callSignal) {
    ensureOpen(workerId, callSignal);
    if (!Array.isArray(input.worker_ids) || !input.worker_ids.length) throw new TypeError('worker_ids must be a nonempty array');
    if (input.reason !== undefined && (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1024)) throw new TypeError('reason must contain 1..1024 characters');
    // Validate the whole request before affecting any worker, then include the
    // complete subtree so a cancelled parent cannot leave orphaned work.
    const selected = selectWorkers(workerId, input.worker_ids, 'cancel');
    const targets = new Set(selected.flatMap(worker => [worker, ...descendants(worker.data.id)]));
    const reason = new DOMException(input.reason?.trim() || 'Worker cancelled by its owner', 'AbortError');
    const requested = [];
    for (const worker of targets) {
      if (worker.historical || !active.has(worker.data.status) || worker.controller.signal.aborted) continue;
      Object.assign(worker.data, { cancelRequestedAt: Date.now(), cancelReason: reason.message });
      if (worker.data.status === 'queued') Object.assign(worker.data, { status: 'interrupted', ...textFields('error', reason.message), finishedAt: Date.now() });
      requested.push(worker.data.id);
      worker.controller.abort(reason);
    }
    if (requested.length) await changed();
    schedule();
    return { cancellation_requested: requested, workers: [...targets].map(worker => present(worker, workerId)),
      guidance: 'Running workers retain their slots until cleanup finishes. Use wait_workers to observe terminal status; cancellation does not roll back tool effects.' };
  }
  async function cancelLower(workerId, focus, reason, callSignal) {
    const victims = preemptCandidates(workerId, focus);
    if (!victims.length) return { cancellation_requested: [] };
    return cancel(workerId, { worker_ids: victims.map(worker => worker.data.id), reason }, callSignal);
  }
  function report(worker, ownerId, preemption = {}, requestedPreempt = false) {
    const admission = structuredClone(admissionSnapshot(ownerId));
    const preempted = preemption.cancellation_requested ?? [];
    const skip = requestedPreempt && !preempted.length ? preemptSkip(worker) : undefined;
    const blocked = blockage(worker, ownerId);
    return {
      worker_id: worker.data.id, status: worker.data.status, priority: worker.data.priority ?? 0, admission, preempted,
      ...(skip ? { skip_preempt: skip } : {}),
      ...(blocked ? { blocked } : {}),
      ...(worker.slot && worker.data.cancelRequestedAt ? { releasing: true } : {}),
      ...(worker.data.status === 'queued' ? { guidance: skip === 'dependencies'
        ? 'Queued on unmet depends_on; preemption waits until predecessors complete.'
        : admission.preemptable.length
          ? 'Queued behind occupancy. Set preempt=true or manage_workers action=prioritize with preempt=true to interrupt lower-priority runners in admission.preemptable.'
          : admission.releasing.length
            ? 'Queued until interrupted workers finish cleanup and release slots (admission.releasing).'
            : 'Queued until a concurrency slot is free. Higher priority starts first among ready work and slot reacquisitions.' } : {}),
    };
  }
  async function manage(workerId, input = {}, callSignal) {
    ensureOpen(workerId, callSignal);
    const action = input.action;
    if (action === 'interrupt') return { action, ...await cancel(workerId, input, callSignal) };
    if (action !== 'prioritize') throw new TypeError('action must be prioritize or interrupt');
    const priority = normalizePriority(input.priority);
    if (!Array.isArray(input.worker_ids) || !input.worker_ids.length) throw new TypeError('worker_ids must be a nonempty array');
    if (input.preempt !== undefined && typeof input.preempt !== 'boolean') throw new TypeError('preempt must be a boolean');
    const selected = selectWorkers(workerId, input.worker_ids, 'prioritize');
    const updated = [];
    for (const worker of selected) {
      if (worker.historical || terminal.has(worker.data.status) || worker.data.priority === priority) continue;
      worker.data.priority = priority;
      updated.push(worker.data.id);
    }
    let preemption = { cancellation_requested: [] };
    const queuedFocus = readyFocus(workerId, selected);
    if (input.preempt === true && queuedFocus.length) {
      preemption = await cancelLower(workerId, queuedFocus,
        input.reason?.trim() || 'Preempted for higher-priority queued work', callSignal);
    }
    if (updated.length && !preemption.cancellation_requested.length) await changed();
    schedule();
    const skip = input.preempt === true && !preemption.cancellation_requested.length
      ? (queuedFocus[0] ? preemptSkip(queuedFocus[0]) : 'no_ready_queued_target')
      : undefined;
    return {
      action, updated, priority, preempted: preemption.cancellation_requested,
      admission: structuredClone(admissionSnapshot(workerId)),
      workers: selected.map(worker => present(worker, workerId)),
      ...(skip ? { skip_preempt: skip } : {}),
      ...(preemption.workers ? { preempted_workers: preemption.workers } : {}),
      guidance: 'Higher priority starts first among ready queued work and waiting slot reacquisitions. preempt=true interrupts lower-priority running descendants of the listed ready queued targets only; they keep their slots until cleanup finishes. Interruption does not roll back tool effects.',
    };
  }
  async function settle(workerId = sessionId, callSignal) {
    if (owner(workerId)?.waitingCall) throw new Error('Worker already has an active wait');
    const done = () => descendants(workerId).every(isSettled);
    if (!done()) await withoutSlot(workerId, () => waitUntil(done, { callSignal: combinedSignal(workerId, callSignal) }));
    await persistTail;
    if (persistenceError) throw persistenceError;
    return descendants(workerId).map(worker => structuredClone(worker.data));
  }
  function isSettled(worker) {
    return terminal.has(worker.data.status) && (worker.historical || worker.durableTerminal === true);
  }
  function toolsFor(workerId = sessionId) {
    owner(workerId);
    return [
      withProgressiveDisclosure({
        name: 'spawn_worker', label: 'Spawn collaboration worker', executionMode: 'sequential',
        description: SPAWN_WORKER_CATALOG.description,
        parameters: Type.Object({
          task: Type.Optional(Type.String({ minLength: 1, maxLength: textLimits.task })),
          name: Type.Optional(Type.String({ maxLength: 80 })),
          profile: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
          depends_on: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
          priority: Type.Optional(Type.Integer({ minimum: priorityLimit.min, maximum: priorityLimit.max })),
          preempt: Type.Optional(Type.Boolean()),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
          ...flagHelpProperties()
        }, { additionalProperties: false }),
        execute: async (_id, input, callSignal) => result(await spawn(workerId, input, callSignal)),
      }, { ...SPAWN_WORKER_CATALOG, mode: 'flag' }),
      withProgressiveDisclosure({
        name: 'wait_workers', label: 'Wait for collaboration workers', executionMode: 'sequential',
        description: WAIT_WORKERS_CATALOG.description,
        parameters: Type.Object({
          worker_ids: Type.Optional(Type.Array(Type.String())),
          mode: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('any')])),
          timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
          ...flagHelpProperties()
        }, { additionalProperties: false }),
        execute: async (_id, input, callSignal) => result(await wait(workerId, input, callSignal)),
      }, { ...WAIT_WORKERS_CATALOG, mode: 'flag' }),
      withProgressiveDisclosure({
        name: 'cancel_workers', label: 'Cancel collaboration workers', executionMode: 'sequential',
        description: CANCEL_WORKERS_CATALOG.description,
        parameters: Type.Object({
          worker_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
          ...flagHelpProperties()
        }, { additionalProperties: false }),
        execute: async (_id, input, callSignal) => result(await cancel(workerId, input, callSignal)),
      }, { ...CANCEL_WORKERS_CATALOG, mode: 'flag' }),
      withProgressiveDisclosure({
        name: 'manage_workers', label: 'Manage collaboration workers', executionMode: 'sequential',
        description: MANAGE_WORKERS_CATALOG.description,
        parameters: Type.Object(withActionHelp({
          worker_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
          priority: Type.Optional(Type.Integer({ minimum: priorityLimit.min, maximum: priorityLimit.max })),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
          preempt: Type.Optional(Type.Boolean()),
        }), { additionalProperties: false }),
        execute: async (_id, input, callSignal) => result(await manage(workerId, input, callSignal)),
      }, MANAGE_WORKERS_CATALOG),
      withProgressiveDisclosure({
        name: 'list_workers', label: 'List collaboration workers', executionMode: 'sequential',
        description: LIST_WORKERS_CATALOG.description,
        parameters: Type.Object({ ...flagHelpProperties() }, { additionalProperties: false }),
        execute: async (_id, _input, callSignal) => { callSignal?.throwIfAborted(); return result({ workers: presentMany(descendants(workerId), workerId),
          admission: structuredClone(admissionSnapshot(workerId)), ...managementSummary(workerId), ...omissions() }); },
      }, { ...LIST_WORKERS_CATALOG, mode: 'flag' }),
    ];
  }
  function close() {
    if (closePromise) return closePromise;
    // Install before firing synchronous abort listeners, which may call close.
    let resolveClose, rejectClose;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    closed = true;
    signal?.removeEventListener('abort', aborted);
    const reason = signal?.reason ?? abortError();
    for (const worker of workers.values()) {
      if (!active.has(worker.data.status)) continue;
      worker.controller.abort(reason);
      if (worker.data.status === 'queued') Object.assign(worker.data, { status: 'interrupted', ...textFields('error', errorText(reason)), finishedAt: Date.now() });
    }
    for (const entry of resumes.splice(0)) entry.reject(reason);
    (async () => {
      await changed().catch(() => {});
      // Admission can still be waiting on its durable queue record. Its failure
      // path also writes state, so it must settle before closing shared storage.
      await Promise.allSettled([...spawning, ...running]);
      await persistTail;
      if (persistenceError) throw persistenceError;
    })().then(resolveClose, rejectClose);
    return closePromise;
  }
  function aborted() { close().catch(() => {}); }
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  return { toolsFor, snapshot, settle, close, admission: (id = sessionId) => structuredClone(admissionSnapshot(id)), inspect };
}
