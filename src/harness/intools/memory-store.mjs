import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeSnapshot } from '../blackboard/persistence.mjs';

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
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Invalid memory snapshot session or schema');
  for (const field of ['todos', 'notes', 'promotions', 'workers', 'audit']) if (!Array.isArray(state[field])) throw new Error(`Invalid memory snapshot ${field}`);
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
  snapshot() { return clone(this.#state); }
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async flush() { await this.#queue; }

  commit(mutate) {
    const operation = this.#queue.then(async () => {
      const next = clone(this.#state);
      const result = mutate(next);
      if (result?.then) throw new TypeError('MemoryStore.commit mutators must be synchronous');
      validate(next, this.sessionId);
      if (JSON.stringify(next) === JSON.stringify(this.#state)) return clone(result);
      if (next.revision >= Number.MAX_SAFE_INTEGER) throw new Error('MemoryStore revision exhausted');
      next.revision++;
      await this.#persist(clone(next));
      this.#state = clone(next);
      // Only publish durable commits; observers cannot fail or delay a write.
      for (const listener of this.#listeners) {
        try { Promise.resolve(listener({ revision: next.revision })).catch(() => {}); } catch {}
      }
      return clone(result);
    });
    this.#queue = operation.catch(() => {});
    return operation;
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
    return this.commit(state => {
      const previous = state.workers.find(item => item.worker_id === workerId);
      if (previous && previous.root_worker_id !== rootWorkerId) throw new Error('Worker root ownership cannot change');
      if (!previous) state.workers.push({ worker_id: workerId, root_worker_id: rootWorkerId });
    });
  }
}
