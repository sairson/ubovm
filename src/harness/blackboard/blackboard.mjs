import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeSnapshot } from './persistence.mjs';
import { assertIntentCapacity, MAX_OPEN_INTENTS, normalizeOpenIntents, takeOpenIntentSlots } from './intent-capacity.mjs';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const priorities = { high: 0, medium: 1, low: 2 };
const intentStates = ['pending', 'running', 'completed', 'failed', 'interrupted'];
const attemptStates = ['running', 'completed', 'failed', 'interrupted'];

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value.trim();
}

function strings(value = [], name = 'values') {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

export function normalizePriority(value = 'medium') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(priorities, normalized) ? normalized : 'medium';
}

export function normalizeKeyPoints(values = []) {
  const seen = new Set();
  const points = strings(values, 'keyPoints').map(value => value.replace(/\s+/gu, ' ').trim())
    .filter(value => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (points.length > 6) throw new RangeError('keyPoints must contain at most 6 distinct checks; split the task without dropping requirements');
  if (points.some(point => point.length > 2048)) throw new RangeError('Each key point must be at most 2048 characters; shorten it without dropping acceptance conditions');
  return points;
}

function provenance(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('provenance must be an object');
  return {
    sourceType: required(value.sourceType, 'provenance.sourceType'),
    noteIds: strings(value.noteIds, 'noteIds'),
    workerIds: strings(value.workerIds, 'workerIds'),
    toolCallIds: strings(value.toolCallIds, 'toolCallIds')
  };
}

function mergedProvenance(previous, source) {
  const next = provenance(source);
  if (!next) return previous;
  if (!previous) return next;
  return {
    sourceType: previous.sourceType,
    ...Object.fromEntries(['noteIds', 'workerIds', 'toolCallIds'].map(key => [key, [...new Set([...previous[key], ...next[key]])]]))
  };
}

function assertJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('checkpoint must contain only finite JSON values without cycles');
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJSON(item, ancestors);
  ancestors.delete(value);
}

function findNode(state, id) {
  const node = state.nodes.find(item => item.id === id);
  if (!node) throw new Error(`Unknown blackboard node: ${id}`);
  return node;
}

function intentNode(state, id) {
  const node = findNode(state, id);
  if (node.kind !== 'intent') throw new Error(`Node ${id} is not an intent`);
  return node;
}

function activeAttempt(state, id, attemptId) {
  const node = intentNode(state, id);
  const attempt = node.attempts.at(-1);
  if (node.intent.status !== 'running' || !attempt || attempt.id !== attemptId || attempt.status !== 'running') {
    throw new Error(`Attempt ${attemptId} is no longer active for ${id}`);
  }
  return { node, attempt };
}

function touch(node) {
  node.updatedAt = now();
  if (node.intent) node.intent.updatedAt = node.updatedAt;
}

function makeNode(state, spec, kind) {
  if (!spec || typeof spec !== 'object') throw new TypeError('node specification is required');
  const id = spec.id === undefined ? `n_${randomUUID()}` : required(spec.id, 'id');
  if (state.nodes.some(node => node.id === id)) throw new Error(`Duplicate node: ${id}`);
  const parentIds = [...new Set(strings(spec.parentIds ?? [state.rootId], 'parentIds').map(id => findNode(state, id).resultId || id))];
  if (!parentIds.length) throw new Error('Non-root nodes require at least one parent');
  const parents = parentIds.map(parentId => findNode(state, parentId));
  const timestamp = now();
  const node = {
    id, kind, parentIds, childIds: [], createdAt: timestamp, updatedAt: timestamp,
    intent: kind === 'intent' ? {
      description: required(spec.description, 'description'),
      hint: typeof spec.hint === 'string' ? spec.hint.trim() : '',
      priority: normalizePriority(spec.priority), keyPoints: normalizeKeyPoints(spec.keyPoints),
      status: 'pending', createdAt: timestamp, updatedAt: timestamp
    } : null,
    attempts: [],
    fact: kind === 'fact' ? { content: required(spec.content, 'content'), createdAt: timestamp } : null,
    provenance: provenance(spec.provenance)
  };
  for (const parent of parents) parent.childIds.push(id);
  state.nodes.push(node);
  return node;
}

// Validate durable input before making any of it visible. Parent edges are canonical.
function validateSnapshot(input) {
  const state = clone(input);
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.nodes)) {
    throw new Error('Invalid blackboard snapshot schema or revision');
  }
  required(state.sessionId, 'sessionId');
  required(state.goal, 'goal');
  required(state.rootId, 'rootId');
  const nodes = new Map();
  const attemptIds = new Set();
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  for (const node of state.nodes) {
    required(node.id, 'node.id');
    if (nodes.has(node.id)) throw new Error(`Duplicate node: ${node.id}`);
    if (!['root', 'intent', 'fact'].includes(node.kind) || !date(node.createdAt) || !date(node.updatedAt)) throw new Error('Invalid node metadata');
    if (!Array.isArray(node.parentIds) || strings(node.parentIds).length !== node.parentIds.length) throw new Error('Invalid parent IDs');
    node.childIds = [];
    if (!Array.isArray(node.attempts)) throw new Error('Invalid attempts');
    node.provenance = provenance(node.provenance);
    if (node.fact) {
      required(node.fact.content, 'fact.content');
      if (!date(node.fact.createdAt)) throw new Error('Invalid fact timestamp');
    }
    for (const attempt of node.attempts) {
      required(attempt.id, 'attempt.id');
      if (attemptIds.has(attempt.id) || !attemptStates.includes(attempt.status) || !date(attempt.startedAt)) throw new Error('Invalid execution attempt');
      attemptIds.add(attempt.id);
      if (attempt.status === 'running' ? attempt.completedAt != null : !date(attempt.completedAt)) throw new Error('Invalid attempt completion timestamp');
      if (attempt.error !== undefined && typeof attempt.error !== 'string') throw new Error('Invalid attempt error');
      if (Object.hasOwn(attempt, 'checkpoint')) assertJSON(attempt.checkpoint);
    }
    if (node.kind === 'intent') {
      if (!node.intent || !intentStates.includes(node.intent.status)) throw new Error('Invalid intent lifecycle');
      required(node.intent.description, 'intent.description');
      if (typeof node.intent.hint !== 'string' || !Object.hasOwn(priorities, node.intent.priority)) throw new Error('Invalid intent metadata');
      if (!date(node.intent.createdAt) || !date(node.intent.updatedAt)) throw new Error('Invalid intent timestamp');
      node.intent.keyPoints = normalizeKeyPoints(node.intent.keyPoints);
      const latest = node.attempts.at(-1);
      const running = node.attempts.filter(attempt => attempt.status === 'running');
      if (running.length > 1 || (running.length === 1 && (latest !== running[0] || node.intent.status !== 'running'))) throw new Error('Invalid active attempt');
      if (['running', 'failed', 'interrupted', 'completed'].includes(node.intent.status) && latest?.status !== node.intent.status) throw new Error('Intent and attempt lifecycle disagree');
      if (node.intent.status === 'pending' && latest && !['failed', 'interrupted'].includes(latest.status)) throw new Error('Invalid pending intent');
      if (node.intent.status === 'completed' ?
        (node.resultId ? node.fact != null || typeof node.resultId !== 'string' : !node.fact || node.fact.attemptId !== latest.id) :
        node.fact != null || node.resultId != null) throw new Error('Intent and fact lifecycle disagree');
      if (node.attempts.slice(0, -1).some(attempt => attempt.status === 'completed')) throw new Error('Completed attempts cannot be retried');
    } else if (node.intent != null || node.attempts.length || !node.fact) {
      throw new Error('Fact/root nodes cannot have an intent or attempts');
    }
    nodes.set(node.id, node);
  }
  const root = nodes.get(state.rootId);
  for (const node of nodes.values()) {
    if (node.resultId != null) {
      const fact = nodes.get(node.resultId);
      if (node.kind !== 'intent' || node.intent.status !== 'completed' || fact?.kind !== 'fact' || fact.producerId !== node.id ||
          fact.parentIds.length !== 1 || fact.parentIds[0] !== node.id || fact.fact?.attemptId !== node.attempts.at(-1)?.id) throw new Error('Invalid intent result relationship');
    }
    if (node.producerId != null && (node.kind !== 'fact' || nodes.get(node.producerId)?.resultId !== node.id)) throw new Error('Invalid fact producer relationship');
  }
  if (!root || root.kind !== 'root' || root.parentIds.length || root.fact.content !== state.goal) throw new Error('Invalid blackboard root');
  for (const node of nodes.values()) {
    if (node !== root && (node.kind === 'root' || !node.parentIds.length)) throw new Error('Graph must have exactly one root');
    for (const parentId of node.parentIds) {
      const parent = nodes.get(parentId);
      if (!parent || parent === node) throw new Error(`Invalid parent: ${parentId}`);
      parent.childIds.push(node.id);
    }
  }
  // Kahn's algorithm also rejects cycles in disconnected components without recursion.
  const degrees = new Map([...nodes.values()].map(node => [node.id, node.parentIds.length]));
  const ready = [root];
  for (let cursor = 0; cursor < ready.length; cursor++) {
    for (const id of ready[cursor].childIds) {
      degrees.set(id, degrees.get(id) - 1);
      if (degrees.get(id) === 0) ready.push(nodes.get(id));
    }
  }
  if (ready.length !== nodes.size) throw new Error('Blackboard graph contains a cycle');
  return state;
}

/** A session-owned DAG. Writes are serialized; readers only see persisted commits. */
export class Blackboard {
  #state;
  #persist;
  #openIntents = MAX_OPEN_INTENTS;
  #queue = Promise.resolve();
  #listeners = new Set();

  constructor({ sessionId, goal, persist = async () => {}, openIntents = MAX_OPEN_INTENTS } = {}) {
    sessionId = required(sessionId, 'sessionId');
    goal = required(goal, 'goal');
    if (typeof persist !== 'function') throw new TypeError('persist must be a function');
    this.#openIntents = normalizeOpenIntents(openIntents);
    const timestamp = now();
    const rootId = `n_${randomUUID()}`;
    this.#state = {
      schemaVersion: 1, sessionId, goal, rootId, revision: 0,
      nodes: [{ id: rootId, kind: 'root', parentIds: [], childIds: [], createdAt: timestamp,
        updatedAt: timestamp, intent: null, attempts: [], fact: { content: goal, createdAt: timestamp }, provenance: null }]
    };
    this.#persist = persist;
  }

  get openIntents() { return this.#openIntents; }

  static fromSnapshot({ snapshot, persist = async () => {}, openIntents = MAX_OPEN_INTENTS } = {}) {
    const state = validateSnapshot(snapshot);
    const board = new Blackboard({ sessionId: state.sessionId, goal: state.goal, persist, openIntents });
    board.#state = state;
    return board;
  }

  /** One live owner per file; cross-process arbitration belongs to the session host. */
  static async open({ filePath, sessionId, goal, openIntents = MAX_OPEN_INTENTS } = {}) {
    const path = resolve(required(filePath, 'filePath'));
    let saved;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = saved === undefined ? undefined : validateSnapshot(saved);
    if (state && ((sessionId !== undefined && state.sessionId !== sessionId.trim()) || (goal !== undefined && state.goal !== goal.trim()))) {
      throw new Error('Blackboard session or goal does not match the persisted graph');
    }
    const board = new Blackboard({ sessionId: sessionId ?? state?.sessionId, goal: goal ?? state?.goal, openIntents, persist: snapshot => writeSnapshot(path, snapshot) });
    if (state) board.#state = state;
    else await board.#persist(clone(board.#state));
    return board;
  }

  snapshot() { return clone(this.#state); }
  node(id) { return clone(this.#state.nodes.find(node => node.id === id)); }
  pendingIntents() {
    return this.snapshot().nodes.filter(node => node.intent?.status === 'pending')
      .sort((left, right) => priorities[left.intent.priority] - priorities[right.intent.priority]);
  }

  // The read barrier includes already-enqueued writes, not just visible state.
  verifyRevision(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a nonnegative safe integer');
    }
    return this.#commit('blackboard.revision.checked', state => state.revision, expectedRevision);
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #commit(type, mutate, expectedRevision) {
    const operation = this.#queue.then(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.#state.revision) {
        const error = new Error('Blackboard changed since the planning snapshot');
        error.code = 'STALE_DECISION';
        throw error;
      }
      const next = clone(this.#state);
      const result = mutate(next);
      // A no-op must not look like new evidence or consume a graph generation.
      if (JSON.stringify(next) === JSON.stringify(this.#state)) return clone(result);
      if (next.revision === Number.MAX_SAFE_INTEGER) throw new Error('Blackboard revision exhausted');
      next.revision++;
      await this.#persist(clone(next));
      this.#state = next;
      const event = { type, sessionId: next.sessionId, revision: next.revision };
      for (const listener of this.#listeners) {
        try { Promise.resolve(listener(clone(event))).catch(() => {}); } catch { /* observers cannot roll back commits */ }
      }
      return clone(result);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async createIntent(spec) { return (await this.createIntents([spec]))[0]; }
  createIntents(specs, { expectedRevision } = {}) {
    const copied = clone(specs);
    return this.#commit('blackboard.intents.created', state => {
      if (!Array.isArray(copied)) throw new TypeError('intents must be an array');
      const accepted = copied.slice(0, takeOpenIntentSlots(state.nodes, copied.length, this.#openIntents));
      return accepted.map(spec => makeNode(state, spec, 'intent'));
    }, expectedRevision);
  }

  createFact(spec) {
    const copied = clone(spec);
    return this.#commit('blackboard.fact.created', state => makeNode(state, copied, 'fact'));
  }

  // This API is for user guidance. The coordinator never accepts Hint from Reason.
  updateHint(id, hint) {
    return this.#commit('blackboard.hint.updated', state => {
      if (typeof hint !== 'string') throw new TypeError('hint must be a string');
      const node = intentNode(state, id);
      if (node.intent.hint !== hint.trim()) { node.intent.hint = hint.trim(); touch(node); }
      return node;
    });
  }

  mergeProvenance(id, source) {
    const copied = clone(source);
    return this.#commit('blackboard.provenance.updated', state => {
      const node = findNode(state, id);
      const merged = mergedProvenance(node.provenance, copied);
      if (JSON.stringify(merged) !== JSON.stringify(node.provenance)) { node.provenance = merged; touch(node); }
      return node;
    });
  }

  beginAttempt(id) {
    return this.#commit('blackboard.attempt.started', state => {
      const node = intentNode(state, id);
      if (node.intent.status !== 'pending') throw new Error(`Intent ${id} must be pending before execution`);
      const attempt = { id: `a_${randomUUID()}`, status: 'running', startedAt: now() };
      node.attempts.push(attempt);
      node.intent.status = 'running';
      touch(node);
      return attempt;
    });
  }

  completeAttempt(id, attemptId, content, { provenance: source } = {}) {
    const copied = clone(source);
    return this.#commit('blackboard.intent.completed', state => {
      content = required(content, 'content');
      const { node, attempt } = activeAttempt(state, id, attemptId);
      attempt.status = 'completed';
      attempt.completedAt = now();
      delete attempt.error;
      delete attempt.checkpoint;
      node.intent.status = 'completed';
      const fact = makeNode(state, { content, parentIds: [id], provenance: copied }, 'fact');
      fact.producerId = id;
      fact.fact.attemptId = attemptId;
      node.resultId = fact.id;
      node.fact = null;
      node.provenance = mergedProvenance(node.provenance, copied);
      touch(node);
      return node;
    });
  }

  failAttempt(id, attemptId, error, { interrupted = false } = {}) {
    const detail = error instanceof Error ? error.message : error;
    return this.#commit(interrupted ? 'blackboard.attempt.interrupted' : 'blackboard.attempt.failed', state => {
      const { node, attempt } = activeAttempt(state, id, attemptId);
      attempt.status = interrupted ? 'interrupted' : 'failed';
      attempt.completedAt = now();
      attempt.error = required(detail, 'error');
      node.intent.status = attempt.status;
      touch(node);
      return node;
    });
  }

  saveCheckpoint(id, attemptId, data) {
    assertJSON(data);
    const copied = clone(data);
    return this.#commit('blackboard.checkpoint.saved', state => {
      const { node, attempt } = activeAttempt(state, id, attemptId);
      attempt.checkpoint = clone(copied);
      touch(node);
      return attempt;
    });
  }

  retryIntent(id) {
    return this.#commit('blackboard.intent.reopened', state => {
      const node = intentNode(state, id);
      if (!['failed', 'interrupted'].includes(node.intent.status)) throw new Error('Only failed or interrupted intents can be retried');
      assertIntentCapacity(state.nodes, 1, this.#openIntents);
      node.intent.status = 'pending';
      touch(node);
      return node;
    });
  }

  recoverInterrupted() {
    return this.#commit('blackboard.attempts.recovered', state => {
      const recovered = [];
      for (const node of state.nodes) {
        if (node.intent?.status !== 'running') continue;
        const attempt = node.attempts.at(-1);
        attempt.status = 'interrupted';
        attempt.completedAt = now();
        attempt.error = 'Previous execution ended before committing a result';
        node.intent.status = 'interrupted';
        touch(node);
        recovered.push(node);
      }
      return recovered;
    });
  }
}
