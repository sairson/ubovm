import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';

const active = new Set(['queued', 'running', 'waiting']);
const terminal = new Set(['completed', 'failed', 'interrupted']);
const textLimits = { task: 32768, result: 16384, error: 4096, name: 80 };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const errorText = error => error instanceof Error ? error.message : String(error);
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

  const workers = new Map(), watchers = new Set(), running = new Set(), resumes = [];
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
      || (!active.has(saved.status) && !terminal.has(saved.status))
      || (saved.depth !== undefined && (!Number.isSafeInteger(saved.depth) || saved.depth < 1))
      || ['createdAt', 'startedAt', 'finishedAt'].some(key => saved[key] !== undefined && (typeof saved[key] !== 'number' || !Number.isFinite(saved[key])))
      || ['name', 'result', 'error'].some(key => saved[key] !== undefined && typeof saved[key] !== 'string')) {
      omit(saved); continue;
    }
    const recovered = { id: saved.id, parentId: saved.parentId, ...textFields('task', saved.task, saved.taskTruncated === true),
      depth: saved.depth ?? 1, status: saved.status, createdAt: saved.createdAt ?? Date.now() };
    for (const key of ['name', 'result', 'error']) {
      if (saved[key] !== undefined) Object.assign(recovered, textFields(key, saved[key], saved[`${key}Truncated`] === true));
    }
    for (const key of ['startedAt', 'finishedAt']) if (saved[key] !== undefined) recovered[key] = saved[key];
    if (active.has(recovered.status)) Object.assign(recovered, { status: 'interrupted',
      error: 'Worker was interrupted before this conversation resumed; it was not replayed.', finishedAt: Date.now() });
    workers.set(recovered.id, { data: recovered, historical: true });
  }

  function omissions() { return { omittedWorkerCount, omittedInterruptedWorkerCount }; }
  function snapshot() {
    // Records contain only validated primitives, so every returned snapshot is detached.
    return { version: 1, sessionId, workers: [...workers.values()].map(worker => ({ ...worker.data })), ...omissions() };
  }
  function changed() {
    const value = snapshot();
    try { Promise.resolve(onEvent?.({ type: 'swarm.status', workers: value.workers.map(worker => ({ ...worker })), ...omissions() })).catch(() => {}); } catch { /* Observers cannot stop cleanup. */ }
    for (const watcher of [...watchers]) watcher();
    const write = persistTail.then(() => persist?.(value));
    persistTail = write.catch(error => { persistenceError ??= error; });
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
  function ensureOpen(workerId, callSignal) {
    callSignal?.throwIfAborted();
    signal?.throwIfAborted();
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
    while (slots < maxConcurrency && resumes.length) {
      const entry = resumes.shift();
      if (entry.worker.controller.signal.aborted) { entry.reject(entry.worker.controller.signal.reason); continue; }
      entry.worker.slot = true;
      slots++;
      entry.worker.data.status = 'running';
      changed().then(entry.resolve, entry.reject);
    }
    while (slots < maxConcurrency) {
      const worker = [...workers.values()].find(item => item.ready && item.data.status === 'queued');
      if (!worker) break;
      worker.slot = true;
      slots++;
      Object.assign(worker.data, { status: 'running', startedAt: Date.now() });
      const launchSaved = changed();
      const task = (async () => {
        try {
          // Persist both the request and its dispatch before invoking an external loop.
          await launchSaved;
          worker.controller.signal.throwIfAborted();
          const value = await runWorker({ workerId: worker.data.id, parentId: worker.data.parentId,
            task: worker.data.task, depth: worker.data.depth, signal: worker.controller.signal });
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
      let timer;
      const finish = (error, timedOut = false) => {
        clearTimeout(timer);
        watchers.delete(update);
        callSignal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(timedOut);
      };
      const update = () => { if (check()) finish(undefined); };
      const aborted = () => finish(callSignal.reason ?? abortError());
      if (callSignal?.aborted) { aborted(); return; }
      if (check()) { resolve(false); return; }
      watchers.add(update);
      callSignal?.addEventListener('abort', aborted, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(undefined, true), timeoutMs);
    });
  }
  async function withoutSlot(workerId, callback) {
    const worker = owner(workerId);
    if (!worker?.slot) return callback();
    release(worker);
    worker.data.status = 'waiting';
    try {
      await changed();
      schedule();
      return await callback();
    } finally {
      if (!closed && !worker.controller.signal.aborted) {
        await new Promise((resolve, reject) => { resumes.push({ worker, resolve, reject }); schedule(); });
      }
    }
  }
  function combinedSignal(workerId, callSignal) {
    const signals = [signal, owner(workerId)?.controller.signal, callSignal].filter(Boolean);
    return signals.length ? AbortSignal.any(signals) : undefined;
  }
  async function spawn(workerId, input = {}, callSignal) {
    const parent = ensureOpen(workerId, callSignal);
    if (typeof input.task !== 'string' || !input.task.trim()) throw new TypeError('task must be a non-empty string');
    if (input.task.length > textLimits.task) throw new RangeError(`task must contain at most ${textLimits.task} characters`);
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 80)) throw new TypeError('name must be a string of at most 80 characters');
    const depth = (parent?.data.depth ?? 0) + 1;
    if (depth > maxDepth) throw new Error(`Worker nesting is limited to ${maxDepth} levels`);
    if (created >= maxWorkers) throw new Error(`This conversation turn is limited to ${maxWorkers} workers`);
    created++;
    const data = { id: `${sessionId}/worker-${randomUUID()}`, parentId: workerId, task: input.task.trim(),
      depth, status: 'queued', createdAt: Date.now(), ...(input.name ? { name: input.name } : {}) };
    const worker = { data, controller: new AbortController(), ready: false, slot: false };
    workers.set(data.id, worker);
    try {
      await initialized;
      await changed();
      ensureOpen(workerId, callSignal);
      worker.ready = true;
      schedule();
      return { worker_id: data.id, status: data.status };
    } catch (error) {
      Object.assign(data, { status: closed || signal?.aborted ? 'interrupted' : 'failed', ...textFields('error', errorText(error)), finishedAt: Date.now() });
      await changed().catch(() => {});
      throw error;
    }
  }
  async function wait(workerId, input = {}, callSignal) {
    ensureOpen(workerId, callSignal);
    const timeoutMs = input.timeout_ms ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new RangeError('timeout_ms must be 0..60000');
    let selected;
    if (input.worker_ids === undefined) selected = descendants(workerId);
    else {
      if (!Array.isArray(input.worker_ids) || input.worker_ids.some(id => typeof id !== 'string')) throw new TypeError('worker_ids must be an array of worker IDs');
      selected = [...new Set(input.worker_ids)].map(id => {
        const worker = workers.get(id);
        if (!worker || !descendant(worker, workerId)) throw new Error(`Cannot wait for worker outside your descendants: ${id}`);
        return worker;
      });
    }
    const done = () => selected.every(worker => terminal.has(worker.data.status));
    const timedOut = done() ? false : timeoutMs === 0 ? true : await withoutSlot(workerId,
      () => waitUntil(done, { timeoutMs, callSignal: combinedSignal(workerId, callSignal) }));
    return { workers: selected.map(worker => ({ ...worker.data })), timed_out: timedOut, ...omissions() };
  }
  async function settle(workerId = sessionId) {
    owner(workerId);
    const done = () => descendants(workerId).every(worker => terminal.has(worker.data.status));
    if (!done()) await withoutSlot(workerId, () => waitUntil(done, { callSignal: combinedSignal(workerId) }));
    await persistTail;
    if (persistenceError) throw persistenceError;
    return descendants(workerId).map(worker => ({ ...worker.data }));
  }
  function toolsFor(workerId = sessionId) {
    owner(workerId);
    return [{
      name: 'spawn_worker', label: 'Spawn collaboration worker', executionMode: 'sequential',
      description: 'Start an independent chat/tool worker for a concrete task and return its worker_id immediately. Workers share the turn concurrency and total-worker limits. Use wait_workers to collect their results.',
      parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: textLimits.task }), name: Type.Optional(Type.String({ maxLength: 80 })) }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => result(await spawn(workerId, input, callSignal)),
    }, {
      name: 'wait_workers', label: 'Wait for collaboration workers', executionMode: 'sequential',
      description: 'Wait for selected descendants (all current descendants when omitted) to finish. Returns their status, plain-text result or error. Wait up to 60000 ms; use timeout_ms: 0 only for an immediate snapshot.',
      parameters: Type.Object({ worker_ids: Type.Optional(Type.Array(Type.String())), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })) }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => result(await wait(workerId, input, callSignal)),
    }, {
      name: 'list_workers', label: 'List collaboration workers', executionMode: 'sequential',
      description: 'List your descendant workers and their current status, result or error. Truncated text is flagged. Omitted interrupted history means older worker effects remain unknown; do not assume they completed or replay them automatically.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _input, callSignal) => { callSignal?.throwIfAborted(); return result({ workers: descendants(workerId).map(worker => ({ ...worker.data })), ...omissions() }); },
    }];
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    signal?.removeEventListener('abort', aborted);
    const reason = signal?.reason ?? abortError();
    for (const worker of workers.values()) {
      if (!active.has(worker.data.status)) continue;
      worker.controller.abort(reason);
      if (worker.data.status === 'queued') Object.assign(worker.data, { status: 'interrupted', ...textFields('error', errorText(reason)), finishedAt: Date.now() });
    }
    for (const entry of resumes.splice(0)) entry.reject(reason);
    closePromise = (async () => {
      await changed().catch(() => {});
      await Promise.allSettled([...running]);
      await persistTail;
      if (persistenceError) throw persistenceError;
    })();
    return closePromise;
  }
  function aborted() { close().catch(() => {}); }
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  return { toolsFor, snapshot, settle, close };
}
