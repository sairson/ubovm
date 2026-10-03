import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeSnapshot } from '../../../blackboard/persistence.mjs';
import { validateDeliveryRecord } from '../../delivery/record.mjs';
import { validateDomainInventory } from '../../domain-inventory/record.mjs';

const clone = value => structuredClone(value);
export function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value.trim();
}
export function checkAbort(signal) { signal?.throwIfAborted(); }
export function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: clone(value) }; }
export function assertSession(store, sessionId) {
  if (!(store instanceof MemoryStore)) throw new TypeError('store must be a MemoryStore');
  if (store.sessionId !== required(sessionId, 'sessionId')) throw new Error('MemoryStore belongs to another session');
}

function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new TypeError('MemoryStore requires finite, acyclic JSON data');
  seen.add(value);
  for (const item of Object.values(value)) json(item, seen);
  seen.delete(value);
}
function validate(state, sessionId) {
  json(state);
  validateDeliveryRecord(state.delivery);
  validateDomainInventory(state.domainInventory);
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Invalid memory snapshot session or schema');
  for (const field of ['todos', 'notes', 'promotions', 'workers', 'audit']) if (!Array.isArray(state[field])) throw new Error(`Invalid memory snapshot ${field}`);
  const workerIds = new Set();
  for (const worker of state.workers) {
    const id = required(worker?.worker_id, 'worker.worker_id');
    required(worker?.root_worker_id, 'worker.root_worker_id');
    if (workerIds.has(id)) throw new Error('Duplicate memory worker identity');
    workerIds.add(id);
  }
  const noteIds = new Set();
  for (const note of state.notes) {
    required(note.id, 'note.id'); required(note.worker_id, 'note.worker_id');
    if (note.session_id !== sessionId || noteIds.has(note.id) || !['note', 'asset', 'vulnerability'].includes(note.note_type)) throw new Error('Invalid memory note session, type, or identity');
    noteIds.add(note.id);
  }
  const todoIds = new Set();
  for (const todo of state.todos) {
    required(todo.id, 'todo.id'); required(todo.worker_id, 'todo.worker_id'); required(todo.content, 'todo.content');
    const key = JSON.stringify([todo.worker_id, todo.id]);
    if (todoIds.has(key) || !['pending', 'in_progress', 'completed'].includes(todo.status)) throw new Error('Invalid memory todo identity or status');
    todoIds.add(key);
  }
  const promotionIds = new Set();
  for (const entry of state.promotions) {
    const key = JSON.stringify([entry.note_id, entry.kind]);
    if (!noteIds.has(entry.note_id) || entry.session_id !== sessionId || promotionIds.has(key) || !['fact', 'intent'].includes(entry.kind) || !['pending', 'completed'].includes(entry.status) || !entry.spec) throw new Error('Invalid promotion journal');
    required(entry.node_id, 'promotion.node_id');
    promotionIds.add(key);
  }
  return state;
}

/** One session host owns a live store/file. Every tool for its workers shares this instance. */
export class MemoryStore {
  #state;
  #persist;
  #queue = Promise.resolve();
  #locks = new Map();
  #listeners = new Set();

  constructor({ sessionId, persist = async () => {} } = {}) {
    sessionId = required(sessionId, 'sessionId');
    if (typeof persist !== 'function') throw new TypeError('persist must be a function');
    this.#state = { schemaVersion: 1, sessionId, revision: 0, todos: [], notes: [], promotions: [], workers: [], audit: [] };
    this.#persist = persist;
  }

  static fromSnapshot({ snapshot, persist = async () => {} } = {}) {
    const state = clone(snapshot);
    const store = new MemoryStore({ sessionId: required(state?.sessionId, 'snapshot.sessionId'), persist });
    store.#state = validate(state, store.sessionId);
    return store;
  }

  static async open({ filePath, sessionId } = {}) {
    const path = resolve(required(filePath, 'filePath'));
    let saved;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const persist = snapshot => writeSnapshot(path, snapshot);
    if (saved) {
      if (sessionId !== undefined && required(sessionId, 'sessionId') !== saved.sessionId) throw new Error('MemoryStore belongs to another session');
      return MemoryStore.fromSnapshot({ snapshot: saved, persist });
    }
    const store = new MemoryStore({ sessionId, persist });
    await persist(store.snapshot());
    return store;
  }

  get sessionId() { return this.#state.sessionId; }
  snapshot(fields) {
    if (fields === undefined) return clone(this.#state);
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string' || !(['toolEvidence', 'delivery', 'domainInventory'].includes(field) || Object.hasOwn(this.#state, field)))) {
      throw new TypeError('Snapshot fields must name existing memory fields');
    }
    return clone(Object.fromEntries(fields.map(field => [field, this.#state[field]])));
  }
  // Copy only the selected record, never the complete evidence history.
  toolEvidence(workerId, toolCallId) {
    return clone(this.#state.toolEvidence?.find(entry => entry.workerId === workerId && entry.toolCallId === toolCallId));
  }
  toolCallIds(workerId) {
    return (this.#state.toolEvidence ?? []).filter(entry => entry.workerId === workerId).map(entry => entry.toolCallId);
  }
  // Learning method lookup needs neither historical evidence nor pending model
  // results. Keep those potentially large/private bodies out of this read.
  knowledgeSnapshot() {
    const data = this.#state.agentKnowledge;
    return clone({ sessionId: this.#state.sessionId,
      ...(data ? { agentKnowledge: { version: data.version, lessons: data.lessons } } : {}) });
  }
  // Delivery reads select history BEFORE cloning. A long-lived ledger must
  // not allocate its entire archive at every model or UI status boundary.
  deliverySnapshot() {
    const record = this.#state.delivery;
    if (!record) return undefined;
    const { history, staleEvidence, evidenceFloor, ...current } = record;
    return clone({ ...current, history: history.slice(-8), historyCount: history.length });
  }
  deliveryHistory({ offset = 0, limit = 20, expectedRevision } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history pagination');
    const record = this.#state.delivery;
    const revision = record?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return clone({ status: 'revision_conflict', expectedRevision: revision, providedRevision: expectedRevision, message: 'Delivery revision conflict; call status and retry history with the current revision.', revision, total: 0, items: [], nextOffset: null });
    }
    const history = record?.history ?? [];
    return clone({ revision, total: history.length, items: history.slice(offset, offset + limit), nextOffset: offset + limit < history.length ? offset + limit : null });
  }
  // Scheduling and status reads need neither evidence bodies nor saved model
  // candidates. Return detached scalar metadata, including before initialization.
  learningJobs() {
    return (this.#state.agentKnowledge?.queue?.jobs ?? []).map(job => ({
      id: job.id, kind: job.kind, status: job.status, nextAttemptAt: job.nextAttemptAt,
      hasCandidates: job.candidates !== undefined
    }));
  }
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async flush() { await this.#queue; }

  #enqueue(invoke) {
    const operation = this.#queue.then(invoke);
    this.#queue = operation.catch(() => {});
    return operation;
  }

  commit(mutate) {
    return this.#enqueue(() => this.#commit(mutate));
  }

  async #commit(mutate) {
    const draft = clone(this.#state);
    const result = mutate(draft);
    if (result?.then) {
      Promise.resolve(result).catch(() => {});
      throw new TypeError('MemoryStore.commit mutators must be synchronous');
    }
    validate(draft, this.sessionId);
    if (draft.revision !== this.#state.revision) throw new Error('MemoryStore revision is managed by the store');
    // A mutator can retain its draft/result and change them during async disk
    // I/O. Detach both before yielding; publication must match the saved data.
    // Also reject an uncloneable result BEFORE any durable side effect.
    const output = clone(result);
    if (JSON.stringify(draft) === JSON.stringify(this.#state)) return output;
    if (draft.revision >= Number.MAX_SAFE_INTEGER) throw new Error('MemoryStore revision exhausted');
    const next = clone(draft);
    next.revision++;
    await this.#persist(clone(next));
    this.#state = next;
    // Only publish durable commits; observers cannot fail or delay a write.
    for (const listener of this.#listeners) {
      try { Promise.resolve(listener({ revision: next.revision })).catch(() => {}); } catch {}
    }
    return output;
  }

  /** Serialize cross-file promotion transactions without holding the commit queue. */
  serial(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.catch(() => {});
    this.#locks.set(key, tail);
    void tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return result;
  }

  registerWorker(workerId, { rootWorkerId = workerId } = {}) {
    workerId = required(workerId, 'workerId'); rootWorkerId = required(rootWorkerId, 'rootWorkerId');
    return this.#enqueue(() => {
      // Check inside the write queue so concurrent registrations and failed
      // writes cannot bypass ownership validation. Existing workers need no copy.
      const previous = this.#state.workers.find(item => item.worker_id === workerId);
      if (previous && previous.root_worker_id !== rootWorkerId) throw new Error('Worker root ownership cannot change');
      if (previous) return;
      return this.#commit(state => { state.workers.push({ worker_id: workerId, root_worker_id: rootWorkerId }); });
    });
  }
}
