import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Blackboard, BlackboardCoordinator, buildBlackboardContext } from './blackboard/index.mjs';
import { writeSnapshot } from './blackboard/persistence.mjs';
import { workerEvidence } from './blackboard/evidence.mjs';
import { createInternalTools, MemoryStore } from './intools/index.mjs';
import { createPiWorker } from './worker-agents/index.mjs';
import { createPiReason } from './agents/index.mjs';
import { createModelClient } from './model.mjs';
import { HarnessDatabase } from './blackboard/database/database.mjs';
import { createContextSummaryMiddleware } from './middleware/context-summary.mjs';
import { createMcpMiddleware } from './middleware/mcp.mjs';
import { createSkillsMiddleware } from './middleware/skills.mjs';

const directories = new Set();
const databaseOwners = new WeakMap();
const constructionKey = Symbol('HarnessSession');
const clone = value => structuredClone(value);
const failure = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
const errorData = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
function text(value, label) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string`); return value.trim(); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value; }
function observer(listener, event) { try { Promise.resolve(listener?.(clone(event))).catch(() => {}); } catch { /* UI observers never control execution. */ } }
function signalCheck(signal) { if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal'); signal?.throwIfAborted(); }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function readRecord(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function validateMiddlewareState(state, sessionId) {
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || !state.values || typeof state.values !== 'object' || Array.isArray(state.values)) throw new Error('Invalid middleware state');
  return state;
}
function roleConfiguration(role, shared, name) {
  if (typeof role === 'function') return { callback: role };
  const { model = shared, ...options } = object(role ?? {}, name);
  if (!model) throw new TypeError(`${name} requires a model configuration or callback`);
  return { options, client: createModelClient(model) };
}
function combineHook(first, second) {
  if (!first) return second;
  if (!second) return first;
  return async event => { await first(event); event.signal?.throwIfAborted(); return second(event); };
}
function combineText(...hooks) {
  return async event => {
    const sections = [];
    for (const hook of hooks) {
      const value = await hook?.(event); event.signal?.throwIfAborted();
      if (value !== undefined && typeof value !== 'string') throw new TypeError('Context providers must return text');
      if (value) sections.push(value);
    }
    return sections.join('\n\n');
  };
}
function combineTransforms(host, summary) {
  if (!host && !summary) return undefined;
  return async event => {
    // Host transforms run after compaction; they can supply application-specific
    // context without invalidating the evidence indexes supplied by adapters.
    const context = summary ? await summary.transform(event) : event.context;
    event.signal?.throwIfAborted();
    return host ? host({ ...event, context }) : context;
  };
}
function completedResult(result, snapshot) {
  if (!result || result.complete !== true || typeof result.summary !== 'string' || !result.summary.trim() || !Number.isSafeInteger(result.rounds) || result.rounds < 1 || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.evidenceIds) || !result.evidenceIds.length || new Set(result.evidenceIds).size !== result.evidenceIds.length) throw new Error('Invalid persisted session result');
  if (snapshot.revision !== result.revision) return false;
  if (snapshot.nodes.some(node => ['pending', 'running'].includes(node.intent?.status))) return false;
  for (const id of result.evidenceIds) {
    const evidence = workerEvidence(snapshot.nodes, id);
    if (!evidence) throw new Error('Persisted result references incomplete evidence');
    const { node } = evidence;
    let fact; try { fact = JSON.parse(node.fact.content); } catch { /* Legacy custom Worker facts remain supported. */ }
    if (node.provenance?.sourceType === 'pi-worker' || fact?.version === 1 && typeof fact.outcome === 'string') {
      if (!['confirmed', 'negative'].includes(fact?.outcome) || !Array.isArray(fact.evidence) || !fact.evidence.length || !Array.isArray(fact.coverage) || fact.coverage.some(item => !['confirmed', 'negative'].includes(item.status))) throw new Error('Persisted result contains unresolved Worker evidence');
    }
  }
  return true;
}
function restoredRecord(record, snapshot) {
  if (!record) return { schemaVersion: 1, sessionId: snapshot.sessionId, goal: snapshot.goal, status: snapshot.nodes.some(node => node.intent?.status === 'running') ? 'interrupted' : 'idle', runId: null, result: null, error: null };
  if (record.schemaVersion !== 1 || record.sessionId !== snapshot.sessionId || record.goal !== snapshot.goal || !['idle', 'running', 'completed', 'interrupted', 'failed'].includes(record.status) || !(record.runId === null || typeof record.runId === 'string') || !(record.error === null || typeof record.error?.message === 'string' && typeof record.error?.name === 'string')) throw new Error('Invalid session metadata or session identity');
  record = clone(record);
  if (record.status === 'completed') {
    if (!completedResult(record.result, snapshot)) { record.status = 'idle'; record.result = null; }
  } else if (record.result !== null) throw new Error('Only completed sessions may contain a result');
  if (record.status === 'running' || snapshot.nodes.some(node => node.intent?.status === 'running')) record.status = 'interrupted';
  return record;
}

/** One session owns its board, providers and optional tool services. Use createHarness(). */
export class HarnessSession {
  #board;
  #runtime;
  #record;
  #metadataFile;
  #directoryKey;
  #reasonConfig;
  #workerConfig;
  #extraTools;
  #limits;
  #listeners = new Set();
  #sequence = 0;
  #queue = Promise.resolve();
  #edits = new Set();
  #active;
  #controller;
  #closing;
  #closed = false;
  #unsubscribe;
  #unsubscribeMemory;
  #database;
  #databaseOwned;
  #databaseSessionKey;
  #lease;
  #recordRevision;
  #storageFailure;
  #history = [];
  #summary;
  #mcp;
  #skills;
  constructor(key, config) {
    if (key !== constructionKey) throw new TypeError('Use await createHarness(options)');
    this.#board = config.board; this.#runtime = config.runtime; this.#record = config.record;
    this.#metadataFile = config.metadataFile; this.#directoryKey = config.directoryKey;
    this.#reasonConfig = config.reason; this.#workerConfig = config.worker; this.#extraTools = config.tools;
    this.#limits = config.limits;
    this.#database = config.database; this.#databaseOwned = config.databaseOwned; this.#lease = config.lease;
    this.#databaseSessionKey = config.databaseSessionKey;
    this.#recordRevision = config.recordRevision; this.#sequence = config.sequence ?? 0;
    this.#summary = config.summary; this.#mcp = config.mcp; this.#skills = config.skills;
    config.setMiddlewareObserver?.(event => { if (!this.#closed) this.#emit('middleware.event', { event }); });
    if (config.onEvent) this.#listeners.add(config.onEvent);
    this.#unsubscribe = this.#board.subscribe(event => this.#emit('blackboard.changed', { event }));
    this.#unsubscribeMemory = this.#runtime?.store.subscribe(event => this.#emit('memory.changed', event));
  }
  get id() { return this.#record.sessionId; }
  get goal() { return this.#record.goal; }
  get status() { return this.#closed ? 'closed' : this.#active ? 'running' : this.#record.status; }
  get storage() { return this.#database ? { kind: 'sqlite', filePath: this.#database.filePath } : this.#metadataFile ? { kind: 'json', filePath: this.#metadataFile } : { kind: 'memory' }; }
  snapshot() { return this.#board.snapshot(); }
  memory() { return this.#runtime?.store.snapshot(); }
  getContext(options) { return buildBlackboardContext(this.#board.snapshot(), options); }
  getState() { return clone({ sessionId: this.id, goal: this.goal, status: this.status, runId: this.#record.runId, result: this.#record.result, error: this.#record.error, revision: this.#board.snapshot().revision }); }
  events({ afterSequence = 0, limit = 100 } = {}) {
    this.#assertOpen();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid event page');
    return this.#database ? this.#database.events(this.id, { afterSequence, limit }) : clone(this.#history.filter(event => event.sequence > afterSequence).slice(0, limit));
  }
  middlewareStatus() { return { contextSummary: Boolean(this.#summary), mcp: this.#mcp?.diagnostics() ?? [], skills: this.#skills?.list() ?? [] }; }
  readEvidence(artifactId, options) {
    this.#assertOpen();
    if (!this.#summary) throw failure('MIDDLEWARE_DISABLED', 'Context summary middleware is disabled');
    return this.#summary.readEvidence(artifactId, options);
  }
  subscribe(listener) { this.#assertOpen(); if (typeof listener !== 'function') throw new TypeError('listener must be a function'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #assertOpen() { if (this.#closed || this.#closing) throw failure('SESSION_CLOSED', 'Harness session is closed'); }
  #emit(type, detail = {}, runId = this.#record.runId) {
    let event = { ...detail, type, sessionId: this.id, runId, sequence: this.#sequence + 1, timestamp: new Date().toISOString() };
    if (this.#database && !this.#storageFailure) {
      try { event = this.#database.appendEvent(this.id, JSON.parse(JSON.stringify(event))); }
      catch (cause) {
        this.#storageFailure = failure('SESSION_PERSISTENCE_FAILED', 'Session event could not be persisted', cause);
        this.#controller?.abort(this.#storageFailure);
      }
    }
    this.#sequence = event.sequence;
    if (!this.#database) { this.#history.push(clone(event)); if (this.#history.length > 1000) this.#history.shift(); }
    for (const listener of this.#listeners) observer(listener, event);
  }
  #save(patch) {
    const operation = this.#queue.then(async () => {
      const record = { ...this.#record, ...patch, updatedAt: new Date().toISOString() };
      if (this.#storageFailure) throw this.#storageFailure;
      if (this.#database) this.#recordRevision = this.#database.saveRecord(this.id, record, { expectedRevision: this.#recordRevision });
      if (this.#metadataFile) await writeSnapshot(this.#metadataFile, record);
      this.#record = record;
      this.#emit('session.state', { state: this.getState() });
      if (this.#storageFailure) throw this.#storageFailure;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  #edit(operation) {
    this.#assertOpen();
    if (this.#active) throw failure('SESSION_BUSY', 'Cancel and await the current run before changing host guidance or work');
    const pending = Promise.resolve().then(operation).then(async result => { await this.#save({ status: 'idle', result: null, error: null }); return result; });
    this.#edits.add(pending);
    pending.finally(() => this.#edits.delete(pending)).catch(() => {});
    return pending;
  }
  addIntent(spec) { const copied = clone(spec); return this.#edit(() => this.#board.createIntent(copied)); }
  addFact(spec) { const copied = clone(spec); return this.#edit(() => this.#board.createFact(copied)); }
  setHint(id, hint) { return this.#edit(() => this.#board.updateHint(id, hint)); }
  retryIntent(id) { return this.#edit(() => this.#board.retryIntent(id)); }
  run({ resume = false, signal } = {}) {
    this.#assertOpen(); signalCheck(signal);
    if (typeof resume !== 'boolean') throw new TypeError('resume must be a boolean');
    if (this.#active || this.#edits.size) throw failure('SESSION_BUSY', 'The session is already running or accepting host changes');
    if (this.#record.status === 'completed' && completedResult(this.#record.result, this.#board.snapshot())) return Promise.resolve(clone(this.#record.result));
    if (!resume && (this.#record.status === 'interrupted' || this.#board.snapshot().nodes.some(node => node.intent?.status === 'running'))) throw failure('RESUME_REQUIRED', 'Use session.resume() to recover an interrupted session');
    const controller = new AbortController();
    this.#controller = controller;
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = this.#execute(resume, runSignal, controller);
    this.#active = operation.finally(() => {
      this.#active = undefined; this.#controller = undefined; this.#emit('session.state', { state: this.getState() });
      if (this.#storageFailure) {
        this.#record = { ...this.#record, status: 'failed', result: null, error: errorData(this.#storageFailure) };
        throw this.#storageFailure;
      }
    });
    return this.#active;
  }
  resume({ signal } = {}) { return this.run({ resume: true, signal }); }
  cancel(reason = 'Cancelled by the host') {
    if (!this.#controller || this.#controller.signal.aborted) return false;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#controller.abort(error);
    this.#emit('session.cancel_requested', { reason: errorData(error) });
    return true;
  }
  async #execute(resume, signal, controller) {
    const runId = `run_${randomUUID()}`;
    let active = true, fatal;
    const emit = (type, detail) => { if (active && !this.#closed) this.#emit(type, detail, runId); };
    try {
      await this.#save({ status: 'running', runId, result: null, error: null, startedAt: new Date().toISOString() });
      signal.throwIfAborted();
      const reasonConfig = this.#reasonConfig, workerConfig = this.#workerConfig;
      const reason = reasonConfig.callback ?? createPiReason({ ...reasonConfig.client, ...reasonConfig.options,
        beforeModel: combineTransforms(reasonConfig.options?.beforeModel, this.#summary), onEvent: event => {
        if (active && !signal.aborted) { emit('reason.event', { event }); observer(reasonConfig.options.onEvent, event); }
      } });
      const memory = this.#runtime?.workerOptions ?? {};
      const configuredTools = workerConfig.options?.tools;
      const sources = [memory.tools, this.#mcp?.tools, this.#skills?.tools, this.#summary?.tools, configuredTools, this.#extraTools].filter(value => value !== undefined);
      const tools = async context => {
        const output = [];
        for (const source of sources) {
          context.signal?.throwIfAborted();
          const values = typeof source === 'function' ? await source(context) : source;
          if (!Array.isArray(values)) throw new TypeError('Tool factories must return an array');
          output.push(...values);
        }
        return output;
      };
      const worker = workerConfig.callback ?? createPiWorker({ ...workerConfig.client, ...workerConfig.options, tools,
        onProgress: combineHook(memory.onProgress, workerConfig.options?.onProgress),
        onToolResult: combineHook(memory.onToolResult, workerConfig.options?.onToolResult),
        contextProvider: combineText(memory.contextProvider, workerConfig.options?.contextProvider),
        instructionProvider: combineText(this.#skills?.instructionProvider, workerConfig.options?.instructionProvider),
        beforeModel: combineTransforms(workerConfig.options?.beforeModel, this.#summary),
        onEvent: event => { if (active && !signal.aborted) { emit('worker.event', { event }); observer(workerConfig.options.onEvent, event); } }
      });
      const coordinator = new BlackboardCoordinator({ blackboard: this.#board, ...this.#limits,
        reason: async args => {
          emit('reason.start', { revision: args.context.revision });
          try { const decision = await reason(args); signal.throwIfAborted(); emit('reason.decision', { revision: args.context.revision, decision }); return decision; }
          catch (error) { emit('reason.error', { revision: args.context.revision, error: errorData(error) }); throw error; }
        },
        worker: async args => {
          const identity = { intentId: args.node.id, attemptId: args.attempt.id };
          emit('worker.start', identity);
          try { const result = await worker(args); signal.throwIfAborted(); emit('worker.result', { ...identity, result }); return result; }
          catch (error) {
            emit('worker.error', { ...identity, error: errorData(error) });
            if (active && !signal.aborted && ['WORKER_HOOK_FAILED', 'WORKER_CHECKPOINT_FAILED'].includes(error.code)) { fatal ??= error; controller.abort(error); }
            throw error;
          }
        }
      });
      const result = await coordinator.run({ resume, signal });
      signal.throwIfAborted();
      await this.#save({ status: 'completed', result, error: null });
      return clone(result);
    } catch (caught) {
      const error = fatal ?? caught;
      try { await this.#save({ status: !fatal && signal.aborted ? 'interrupted' : 'failed', result: null, error: errorData(error) }); }
      catch (persistenceError) {
        this.#record = { ...this.#record, status: 'failed', result: null, error: errorData(persistenceError) };
        throw failure('SESSION_PERSISTENCE_FAILED', 'Execution ended but its session state could not be persisted', new AggregateError([error, persistenceError]));
      }
      throw error;
    } finally { active = false; }
  }
  close() {
    if (this.#closing) return this.#closing;
    if (this.#closed) return Promise.resolve();
    this.#closing = Promise.resolve().then(async () => {
      this.cancel('Harness session is closing');
      const errors = [];
      try {
        await Promise.allSettled([this.#active, ...this.#edits]);
        const settled = await Promise.allSettled([this.#runtime, this.#mcp, this.#skills, this.#summary].filter(Boolean).map(service => service.close()));
        for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
        await this.#queue;
      } finally {
        this.#unsubscribe(); this.#unsubscribeMemory?.(); this.#closed = true;
        this.#emit('session.state', { state: this.getState() }); this.#listeners.clear();
        try { this.#lease?.release(); } catch (error) { errors.push(error); }
        if (this.#databaseSessionKey) databaseOwners.get(this.#database)?.delete(this.#databaseSessionKey);
        if (this.#databaseOwned) try { this.#database.close(); } catch (error) { errors.push(error); }
        if (this.#directoryKey) directories.delete(this.#directoryKey);
      }
      if (this.#storageFailure) errors.push(this.#storageFailure);
      if (errors.length) throw new AggregateError(errors, 'Session resources could not all close cleanly');
    });
    return this.#closing;
  }
}

export async function createHarness(options = {}) {
  object(options, 'Harness options');
  const { directory, onEvent, tools, intools = {}, maxConcurrency = 3, maxRounds = 20 } = options;
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  if (tools !== undefined && !Array.isArray(tools) && typeof tools !== 'function') throw new TypeError('tools must be an array or factory');
  for (const [key, value] of Object.entries({ maxConcurrency, maxRounds })) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
  if (intools !== false) object(intools, 'intools');
  if (directory !== undefined && (intools?.store || intools?.memoryFile)) throw new Error('directory owns memory persistence; omit intools.store and intools.memoryFile');
  const reason = roleConfiguration(options.reason, options.model, 'reason');
  const worker = roleConfiguration(options.worker, options.model, 'worker');
  // Validate adapters before creating directories or writing initial state.
  if (!reason.callback) createPiReason({ ...reason.client, ...reason.options });
  if (!worker.callback) createPiWorker({ ...worker.client, ...worker.options });
  if (options.database !== undefined && ![true, false].includes(options.database) && !(options.database instanceof HarnessDatabase)) object(options.database, 'database');
  if (options.contextSummary !== undefined && ![true, false].includes(options.contextSummary)) object(options.contextSummary, 'contextSummary');
  for (const name of ['mcp', 'skills']) if (options[name] !== undefined && options[name] !== false) object(options[name], name);
  let directoryKey, metadataFile, runtime, database, databaseOwned = false, databaseSessionKey, lease, summary, mcp, skills;
  try {
    let board, canonical;
    if (directory !== undefined) {
      const path = resolve(text(directory, 'directory'));
      await mkdir(path, { recursive: true });
      canonical = await realpath(path);
      directoryKey = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (directories.has(directoryKey)) { directoryKey = undefined; throw failure('SESSION_BUSY', 'This session directory already has a live SDK owner'); }
      directories.add(directoryKey);
    }
    const databaseSetting = options.database ?? Boolean(canonical);
    if (databaseSetting) {
      if (intools?.store || intools?.memoryFile) throw new Error('database owns memory persistence; omit intools.store and intools.memoryFile');
      if (databaseSetting instanceof HarnessDatabase) database = databaseSetting;
      else {
        if (databaseSetting === true && !canonical) throw new TypeError('database: true requires directory or an explicit database.filePath');
        database = await HarnessDatabase.open(databaseSetting === true ? { filePath: join(canonical, 'harness.sqlite') } : databaseSetting);
        databaseOwned = true;
      }
    }
    let persisted, legacyMemory, store, record, recordRevision;
    if (database) {
      let legacyBoard;
      let sessionId = options.sessionId;
      if (sessionId === undefined && canonical) {
        const sessions = database.listSessions({ limit: 2 });
        if (sessions.length > 1) throw new TypeError('Specify sessionId when the database contains multiple sessions');
        if (!sessions.length) legacyBoard = await readRecord(join(canonical, 'blackboard.json'));
        sessionId = sessions[0]?.sessionId ?? legacyBoard?.sessionId;
      }
      sessionId = text(sessionId ?? `session_${randomUUID()}`, 'sessionId');
      persisted = database.loadSession(sessionId);
      if (!persisted?.blackboard && canonical && !legacyBoard) legacyBoard = await readRecord(join(canonical, 'blackboard.json'));
      let migrated = !persisted?.blackboard && legacyBoard;
      const goal = text(options.goal ?? persisted?.goal ?? (migrated ? legacyBoard.goal : undefined), 'goal');
      if (migrated && legacyBoard.sessionId !== sessionId) throw failure('SESSION_IDENTITY_MISMATCH', 'Legacy directory belongs to another session');
      database.ensureSession({ sessionId, goal });
      const owners = databaseOwners.get(database) ?? new Set();
      if (owners.has(sessionId)) throw failure('SESSION_BUSY', 'This database session already has a live SDK owner');
      owners.add(sessionId); databaseOwners.set(database, owners); databaseSessionKey = sessionId;
      lease = database.acquireSession(sessionId);
      // A previous process can commit between discovery and lease acquisition.
      // Build every document from the view obtained after ownership is secured.
      persisted = database.loadSession(sessionId);
      migrated = !persisted?.blackboard && legacyBoard;
      const savedBoard = persisted?.blackboard ?? (migrated ? legacyBoard : undefined);
      if (savedBoard && (savedBoard.sessionId !== sessionId || savedBoard.goal !== goal)) throw failure('SESSION_IDENTITY_MISMATCH', 'Persisted blackboard identity does not match');
      const persist = snapshot => database.saveBlackboard(sessionId, snapshot);
      board = savedBoard ? Blackboard.fromSnapshot({ snapshot: savedBoard, persist }) : new Blackboard({ sessionId, goal, persist });
      legacyMemory = migrated ? await readRecord(join(canonical, 'memory.json')) : undefined;
      const savedMemory = persisted?.memory ?? legacyMemory;
      if (savedMemory && savedMemory.sessionId !== sessionId) throw failure('SESSION_IDENTITY_MISMATCH', 'Persisted memory belongs to another session');
      if (intools !== false) store = savedMemory ? MemoryStore.fromSnapshot({ snapshot: savedMemory, persist: value => database.saveMemory(sessionId, value) }) : new MemoryStore({ sessionId, persist: value => database.saveMemory(sessionId, value) });
      const savedRecord = persisted?.record ?? (migrated ? await readRecord(join(canonical, 'session.json')) : undefined);
      record = restoredRecord(savedRecord, board.snapshot());
      const legacyMiddleware = migrated ? await readRecord(join(canonical, 'middleware.json')) : undefined;
      if (legacyMiddleware) validateMiddlewareState(legacyMiddleware, sessionId);
      database.transaction(() => {
        database.saveBlackboard(sessionId, board.snapshot());
        if (store) database.saveMemory(sessionId, store.snapshot());
        // Validate and preserve legacy memory even when tools are disabled for this open.
        else if (legacyMemory) database.saveMemory(sessionId, MemoryStore.fromSnapshot({ snapshot: legacyMemory }).snapshot());
        recordRevision = database.saveRecord(sessionId, record, { expectedRevision: persisted?.recordRevision ?? null });
        if (legacyMiddleware) for (const [key, value] of Object.entries(legacyMiddleware.values)) {
          if (database.loadContext(sessionId, key) === undefined) database.saveContext(sessionId, key, value);
        }
      });
    } else if (canonical) {
      const boardFile = join(canonical, 'blackboard.json');
      const existing = await exists(boardFile);
      board = await Blackboard.open({ filePath: boardFile, sessionId: options.sessionId ?? (existing ? undefined : `session_${randomUUID()}`), goal: options.goal });
      metadataFile = join(canonical, 'session.json');
      record = restoredRecord(await readRecord(metadataFile), board.snapshot());
      await writeSnapshot(metadataFile, record);
    } else {
      board = new Blackboard({ sessionId: options.sessionId ?? `session_${randomUUID()}`, goal: options.goal });
      record = restoredRecord(undefined, board.snapshot());
    }
    const id = board.snapshot().sessionId;
    if (intools !== false) runtime = await createInternalTools({ ...intools,
      ...(options.skills ? { skillResource: false, skillScript: false } : {}),
      blackboard: board, sessionId: id,
      ...(store ? { store } : canonical ? { memoryFile: join(canonical, 'memory.json') } : {})
    });
    // The same middleware persistence contract works with SQLite, legacy JSON
    // directories, and an in-memory session. No provider credentials are saved.
    const middlewareFile = canonical && !database ? join(canonical, 'middleware.json') : undefined;
    let middlewareState = middlewareFile ? await readRecord(middlewareFile) ?? { schemaVersion: 1, sessionId: id, values: {} } : { schemaVersion: 1, sessionId: id, values: {} };
    validateMiddlewareState(middlewareState, id);
    let middlewareQueue = Promise.resolve();
    const load = key => database ? database.loadContext(id, key) : clone(middlewareState.values[key]);
    const save = (key, value) => {
      if (database) return database.saveContext(id, key, value);
      const operation = middlewareQueue.then(async () => {
        const next = { ...middlewareState, values: { ...middlewareState.values, [key]: clone(value) } };
        if (middlewareFile) await writeSnapshot(middlewareFile, next);
        middlewareState = next;
      });
      middlewareQueue = operation.catch(() => {}); return operation;
    };
    let dispatchMiddleware;
    if (options.contextSummary !== false) {
      const config = options.contextSummary === true || options.contextSummary === undefined ? {} : options.contextSummary;
      const defaultClient = reason.client ?? worker.client;
      summary = createContextSummaryMiddleware({ ...(defaultClient ? { model: defaultClient } : {}), ...config,
        load: async key => load(`context:${key}`) ?? await config.load?.(key),
        save: async (key, value) => { await config.save?.(key, clone(value)); await save(`context:${key}`, value); },
        onEvent: event => { dispatchMiddleware?.(event); observer(config.onEvent, event); }
      });
    }
    if (options.skills) {
      const config = options.skills;
      skills = await createSkillsMiddleware({ ...config, state: load('skills') ?? config.state,
        persist: async state => { await config.persist?.(clone(state)); await save('skills', state); },
        onEvent: event => { dispatchMiddleware?.(event); observer(config.onEvent, event); }
      });
    }
    if (options.mcp) mcp = await createMcpMiddleware(options.mcp);
    const session = new HarnessSession(constructionKey, { board, runtime, record, metadataFile, directoryKey,
      database, databaseOwned, databaseSessionKey, lease, recordRevision, sequence: persisted?.eventSequence ?? 0,
      setMiddlewareObserver: callback => { dispatchMiddleware = callback; },
      summary, skills, mcp, reason, worker, tools, onEvent, limits: { maxConcurrency, maxRounds } });
    return session;
  } catch (error) {
    await Promise.allSettled([runtime, summary, skills, mcp].filter(Boolean).map(service => service.close()));
    try { lease?.release(); } finally {
      if (databaseSessionKey) databaseOwners.get(database)?.delete(databaseSessionKey);
      if (databaseOwned) database.close(); if (directoryKey) directories.delete(directoryKey);
    }
    throw error;
  }
}
