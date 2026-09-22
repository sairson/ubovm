import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

const constructionKey = Symbol('HarnessDatabase');
const applicationId = 0x55424f48;
const schemaVersion = 1;
const machine = hostname();
const fail = (code, message) => Object.assign(new Error(message), { code });
const isoNow = () => new Date().toISOString();
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value.trim();
}
function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function encoded(value) {
  const seen = new Set();
  const inspect = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Database values must contain finite, acyclic JSON data');
    seen.add(item);
    for (const entry of Object.values(item)) inspect(entry);
    seen.delete(item);
  };
  inspect(value);
  return JSON.stringify(value);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function info(row) {
  if (!row) return undefined;
  return { sessionId: row.session_id, goal: row.goal, createdAt: row.created_at, updatedAt: row.updated_at,
    eventSequence: row.event_sequence, ...(row.status === undefined ? {} : { status: row.status ?? 'idle' }) };
}

/** Durable state for many sessions. Each writable session requires its own live lease. */
export class HarnessDatabase {
  #db;
  #closed = false;
  #leases = new Map();
  #depth = 0;
  #savepoint = 0;
  #leaseDurationMs;
  #filePath;

  constructor(key, db, filePath, leaseDurationMs) {
    if (key !== constructionKey) throw new TypeError('Use await HarnessDatabase.open(options)');
    this.#db = db; this.#filePath = filePath; this.#leaseDurationMs = leaseDurationMs;
  }

  static async open({ filePath, busyTimeoutMs = 5000, leaseDurationMs = 60000 } = {}) {
    filePath = text(filePath, 'filePath');
    integer(busyTimeoutMs, 'busyTimeoutMs', 0, 60000);
    integer(leaseDurationMs, 'leaseDurationMs', 3000, 3600000);
    if (filePath !== ':memory:') { filePath = resolve(filePath); await mkdir(dirname(filePath), { recursive: true }); }
    const db = new DatabaseSync(filePath, { timeout: busyTimeoutMs, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      const app = db.prepare('PRAGMA application_id').get().application_id;
      if (app !== 0 && app !== applicationId) throw fail('DATABASE_IDENTITY_MISMATCH', 'The file belongs to another application');
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
      db.exec('BEGIN IMMEDIATE');
      try {
        const currentApp = db.prepare('PRAGMA application_id').get().application_id;
        if (currentApp !== 0 && currentApp !== applicationId) throw fail('DATABASE_IDENTITY_MISMATCH', 'The file belongs to another application');
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version > schemaVersion) throw fail('DATABASE_VERSION_UNSUPPORTED', `Database schema ${version} is newer than supported schema ${schemaVersion}`);
        if (version === 0) {
          db.exec(`
            CREATE TABLE harness_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
            CREATE TABLE harness_sessions (
              session_id TEXT PRIMARY KEY, goal TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0)
            ) STRICT;
            CREATE TABLE harness_documents (
              session_id TEXT NOT NULL REFERENCES harness_sessions(session_id) ON DELETE CASCADE,
              kind TEXT NOT NULL CHECK(kind IN ('blackboard', 'memory', 'record')),
              revision INTEGER NOT NULL CHECK(revision >= 0), payload TEXT NOT NULL CHECK(json_valid(payload)), updated_at TEXT NOT NULL,
              PRIMARY KEY(session_id, kind)
            ) STRICT;
            CREATE TABLE harness_context (
              session_id TEXT NOT NULL REFERENCES harness_sessions(session_id) ON DELETE CASCADE,
              key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), payload TEXT NOT NULL CHECK(json_valid(payload)), updated_at TEXT NOT NULL,
              PRIMARY KEY(session_id, key)
            ) STRICT;
            CREATE TABLE harness_events (
              session_id TEXT NOT NULL REFERENCES harness_sessions(session_id) ON DELETE CASCADE,
              sequence INTEGER NOT NULL CHECK(sequence > 0), type TEXT NOT NULL, timestamp TEXT NOT NULL,
              payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(session_id, sequence)
            ) STRICT;
            CREATE TABLE harness_leases (
              session_id TEXT PRIMARY KEY REFERENCES harness_sessions(session_id) ON DELETE CASCADE,
              token TEXT NOT NULL UNIQUE, owner_pid INTEGER NOT NULL, owner_host TEXT NOT NULL,
              expires_at INTEGER NOT NULL, acquired_at TEXT NOT NULL
            ) STRICT;
            CREATE INDEX harness_sessions_updated ON harness_sessions(updated_at DESC, session_id);
          `);
          db.prepare('INSERT INTO harness_migrations(version, applied_at) VALUES (?, ?)').run(schemaVersion, isoNow());
          db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=${schemaVersion};`);
        } else {
          if (currentApp !== applicationId || db.prepare('SELECT MAX(version) AS version FROM harness_migrations').get().version !== version) throw fail('DATABASE_IDENTITY_MISMATCH', 'Database migration metadata does not match the harness schema');
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return new HarnessDatabase(constructionKey, db, filePath, leaseDurationMs);
    } catch (error) { db.close(); throw error; }
  }

  get filePath() { return this.#filePath; }
  get schemaVersion() { return schemaVersion; }
  #open() { if (this.#closed) throw fail('DATABASE_CLOSED', 'Harness database is closed'); }
  #session(sessionId) {
    const row = this.#db.prepare('SELECT * FROM harness_sessions WHERE session_id=?').get(sessionId);
    if (!row) throw fail('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`);
    return row;
  }
  #owned(sessionId) {
    this.#session(sessionId);
    const local = this.#leases.get(sessionId);
    if (!local || local.lost) throw fail('SESSION_LEASE_REQUIRED', `Acquire a session lease before writing ${sessionId}`);
    const row = this.#db.prepare('SELECT token, expires_at FROM harness_leases WHERE session_id=?').get(sessionId);
    if (row?.token !== local.token) {
      local.lost = true; clearInterval(local.timer);
      throw fail('SESSION_LEASE_LOST', `Session ownership changed: ${sessionId}`);
    }
    // Under the write transaction an unchanged token can safely renew after an event-loop pause.
    if (row.expires_at <= Date.now()) this.#db.prepare('UPDATE harness_leases SET expires_at=? WHERE session_id=? AND token=?').run(Date.now() + this.#leaseDurationMs, sessionId, local.token);
  }
  #touch(sessionId) { this.#db.prepare('UPDATE harness_sessions SET updated_at=? WHERE session_id=?').run(isoNow(), sessionId); }

  /** The callback must be synchronous. Nested writes use savepoints and roll back together. */
  transaction(callback) {
    return this.#transaction(callback, 'IMMEDIATE');
  }
  #transaction(callback, mode) {
    this.#open();
    if (typeof callback !== 'function') throw new TypeError('transaction requires a synchronous callback');
    const nested = this.#depth > 0, point = `harness_sp_${++this.#savepoint}`;
    this.#db.exec(nested ? `SAVEPOINT ${point}` : `BEGIN ${mode}`);
    this.#depth++;
    try {
      const result = callback(this);
      if (result?.then) { Promise.resolve(result).catch(() => {}); throw new TypeError('Database transaction callbacks must be synchronous'); }
      this.#db.exec(nested ? `RELEASE SAVEPOINT ${point}` : 'COMMIT');
      return result;
    } catch (error) {
      this.#db.exec(nested ? `ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}` : 'ROLLBACK');
      throw error;
    } finally { this.#depth--; }
  }

  ensureSession({ sessionId, goal } = {}) {
    sessionId = text(sessionId, 'sessionId'); goal = text(goal, 'goal');
    return this.transaction(() => {
      const row = this.#db.prepare('SELECT * FROM harness_sessions WHERE session_id=?').get(sessionId);
      if (row) {
        if (row.goal !== goal) throw fail('SESSION_IDENTITY_MISMATCH', 'Session goal does not match the database');
        return info(row);
      }
      const timestamp = isoNow();
      this.#db.prepare('INSERT INTO harness_sessions(session_id,goal,created_at,updated_at) VALUES (?,?,?,?)').run(sessionId, goal, timestamp, timestamp);
      return info(this.#session(sessionId));
    });
  }

  loadSession(sessionId) {
    this.#open(); sessionId = text(sessionId, 'sessionId');
    // A read transaction gives a single view even while a different session host commits.
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM harness_sessions WHERE session_id=?').get(sessionId);
      if (!row) return undefined;
      const result = { ...info(row), recordRevision: null };
      for (const document of this.#db.prepare('SELECT kind,revision,payload FROM harness_documents WHERE session_id=?').all(sessionId)) {
        result[document.kind] = JSON.parse(document.payload);
        if (document.kind === 'record') result.recordRevision = document.revision;
      }
      return result;
    }, 'DEFERRED');
  }

  #snapshot(sessionId, snapshot, kind) {
    sessionId = text(sessionId, 'sessionId');
    const payload = encoded(snapshot);
    if (snapshot?.schemaVersion !== 1 || snapshot.sessionId !== sessionId) throw fail('SESSION_IDENTITY_MISMATCH', `${kind} snapshot schema or session does not match`);
    const revision = integer(snapshot.revision, `${kind}.revision`);
    return this.transaction(() => {
      this.#owned(sessionId);
      if (kind === 'blackboard' && this.#session(sessionId).goal !== snapshot.goal) throw fail('SESSION_IDENTITY_MISMATCH', 'Blackboard goal does not match the session');
      const old = this.#db.prepare('SELECT revision,payload FROM harness_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
      if (old && old.revision === revision && old.payload === payload) return revision;
      if (old && revision !== old.revision + 1) throw fail('STALE_REVISION', `${kind} revision ${revision} cannot replace revision ${old.revision}`);
      this.#db.prepare('INSERT INTO harness_documents(session_id,kind,revision,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id,kind) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at').run(sessionId, kind, revision, payload, isoNow());
      this.#touch(sessionId);
      return revision;
    });
  }
  saveBlackboard(sessionId, snapshot) { return this.#snapshot(sessionId, snapshot, 'blackboard'); }
  saveMemory(sessionId, snapshot) { return this.#snapshot(sessionId, snapshot, 'memory'); }

  saveRecord(sessionId, record, { expectedRevision } = {}) {
    sessionId = text(sessionId, 'sessionId'); const payload = encoded(record);
    if (record?.sessionId !== sessionId || record.schemaVersion !== 1) throw fail('SESSION_IDENTITY_MISMATCH', 'Record schema or session does not match');
    if (expectedRevision !== undefined && expectedRevision !== null) integer(expectedRevision, 'expectedRevision');
    return this.transaction(() => {
      this.#owned(sessionId);
      if (record.goal !== this.#session(sessionId).goal) throw fail('SESSION_IDENTITY_MISMATCH', 'Record goal does not match the session');
      const old = this.#db.prepare("SELECT revision,payload FROM harness_documents WHERE session_id=? AND kind='record'").get(sessionId);
      if (expectedRevision !== undefined && expectedRevision !== (old?.revision ?? null)) throw fail('STALE_REVISION', 'Record revision changed');
      if (old?.payload === payload) return old.revision;
      const revision = old ? integer(old.revision + 1, 'record.revision') : 0;
      this.#db.prepare("INSERT INTO harness_documents(session_id,kind,revision,payload,updated_at) VALUES (?,'record',?,?,?) ON CONFLICT(session_id,kind) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at").run(sessionId, revision, payload, isoNow());
      this.#touch(sessionId); return revision;
    });
  }

  saveContext(sessionId, key, value, { expectedRevision } = {}) {
    sessionId = text(sessionId, 'sessionId'); key = text(key, 'key'); const payload = encoded(value);
    if (expectedRevision !== undefined && expectedRevision !== null) integer(expectedRevision, 'expectedRevision');
    return this.transaction(() => {
      this.#owned(sessionId);
      const old = this.#db.prepare('SELECT revision,payload FROM harness_context WHERE session_id=? AND key=?').get(sessionId, key);
      if (expectedRevision !== undefined && expectedRevision !== (old?.revision ?? null)) throw fail('STALE_REVISION', 'Context revision changed');
      if (old?.payload === payload) return old.revision;
      const revision = old ? integer(old.revision + 1, 'context.revision') : 0;
      this.#db.prepare('INSERT INTO harness_context(session_id,key,revision,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id,key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at').run(sessionId, key, revision, payload, isoNow());
      this.#touch(sessionId); return revision;
    });
  }
  loadContext(sessionId, key) {
    this.#open(); sessionId = text(sessionId, 'sessionId'); key = text(key, 'key');
    const row = this.#db.prepare('SELECT payload FROM harness_context WHERE session_id=? AND key=?').get(sessionId, key);
    return row ? JSON.parse(row.payload) : undefined;
  }
  contextState(sessionId, key) {
    this.#open(); sessionId = text(sessionId, 'sessionId'); key = text(key, 'key');
    const row = this.#db.prepare('SELECT revision,payload,updated_at FROM harness_context WHERE session_id=? AND key=?').get(sessionId, key);
    return row ? { value: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at } : undefined;
  }

  appendEvent(sessionId, event) {
    sessionId = text(sessionId, 'sessionId');
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object');
    const type = text(event.type, 'event.type');
    if (event.sessionId !== undefined && event.sessionId !== sessionId) throw fail('SESSION_IDENTITY_MISMATCH', 'Event belongs to another session');
    return this.transaction(() => {
      this.#owned(sessionId);
      const sequence = integer(this.#session(sessionId).event_sequence + 1, 'event.sequence', 1);
      const timestamp = event.timestamp === undefined ? isoNow() : event.timestamp;
      if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new TypeError('event.timestamp must be an ISO date');
      const saved = { ...event, type, sessionId, sequence, timestamp };
      const payload = encoded(saved);
      this.#db.prepare('INSERT INTO harness_events(session_id,sequence,type,timestamp,payload) VALUES (?,?,?,?,?)').run(sessionId, sequence, type, timestamp, payload);
      this.#db.prepare('UPDATE harness_sessions SET event_sequence=?,updated_at=? WHERE session_id=?').run(sequence, isoNow(), sessionId);
      return JSON.parse(payload);
    });
  }
  events(sessionId, { afterSequence = 0, limit = 100 } = {}) {
    this.#open(); sessionId = text(sessionId, 'sessionId'); integer(afterSequence, 'afterSequence'); integer(limit, 'limit', 1, 1000);
    return this.#db.prepare('SELECT payload FROM harness_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId, afterSequence, limit).map(row => JSON.parse(row.payload));
  }
  listSessions({ limit = 100, offset = 0 } = {}) {
    this.#open(); integer(limit, 'limit', 1, 1000); integer(offset, 'offset');
    return this.#db.prepare("SELECT s.*, json_extract(d.payload,'$.status') AS status FROM harness_sessions s LEFT JOIN harness_documents d ON d.session_id=s.session_id AND d.kind='record' ORDER BY s.updated_at DESC,s.session_id LIMIT ? OFFSET ?").all(limit, offset).map(info);
  }

  acquireSession(sessionId) {
    this.#open(); sessionId = text(sessionId, 'sessionId');
    if (this.#depth) throw new Error('Acquire session leases outside a transaction');
    const existing = this.#leases.get(sessionId);
    if (existing && !existing.lost) { this.renewSession(sessionId, existing.token); return existing.handle; }
    const token = randomUUID();
    this.transaction(() => {
      this.#session(sessionId);
      const old = this.#db.prepare('SELECT * FROM harness_leases WHERE session_id=?').get(sessionId);
      // A live process on this machine keeps ownership even if its event loop was paused.
      if (old && (old.owner_host === machine ? alive(old.owner_pid) : old.expires_at > Date.now())) throw fail('SESSION_LOCKED', `Session already has an active host: ${sessionId}`);
      this.#db.prepare('INSERT INTO harness_leases(session_id,token,owner_pid,owner_host,expires_at,acquired_at) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET token=excluded.token,owner_pid=excluded.owner_pid,owner_host=excluded.owner_host,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at').run(sessionId, token, process.pid, machine, Date.now() + this.#leaseDurationMs, isoNow());
    });
    const local = { token, lost: false };
    local.handle = Object.freeze({ sessionId, token, renew: () => this.renewSession(sessionId, token), release: () => this.releaseSession(sessionId, token) });
    local.timer = setInterval(() => {
      try { this.renewSession(sessionId, token); }
      catch (error) { if (error.code === 'SESSION_LEASE_LOST' || error.code === 'DATABASE_CLOSED') { local.lost = true; clearInterval(local.timer); } }
    }, Math.floor(this.#leaseDurationMs / 3));
    local.timer.unref(); this.#leases.set(sessionId, local);
    return local.handle;
  }
  renewSession(sessionId, token = this.#leases.get(sessionId)?.token) {
    this.#open(); sessionId = text(sessionId, 'sessionId');
    const local = this.#leases.get(sessionId);
    if (!local || local.lost || token !== local.token) throw fail('SESSION_LEASE_LOST', `Session lease is no longer owned: ${sessionId}`);
    return this.transaction(() => {
      const row = this.#db.prepare('SELECT token,owner_host,owner_pid,expires_at FROM harness_leases WHERE session_id=?').get(sessionId);
      if (row?.token !== token || row.owner_host !== machine || row.owner_pid !== process.pid) {
        local.lost = true; clearInterval(local.timer);
        throw fail('SESSION_LEASE_LOST', `Session lease was replaced: ${sessionId}`);
      }
      // An overdue heartbeat can renew only its unchanged token; expired foreign hosts are fenced.
      const expiresAt = Date.now() + this.#leaseDurationMs;
      this.#db.prepare('UPDATE harness_leases SET expires_at=? WHERE session_id=? AND token=?').run(expiresAt, sessionId, token);
      return { sessionId, expiresAt };
    });
  }
  releaseSession(sessionId, token = this.#leases.get(sessionId)?.token) {
    this.#open(); sessionId = text(sessionId, 'sessionId');
    if (this.#depth) throw new Error('Release session leases outside a transaction');
    const local = this.#leases.get(sessionId);
    if (!local || local.token !== token) return false;
    const removed = this.transaction(() => this.#db.prepare('DELETE FROM harness_leases WHERE session_id=? AND token=?').run(sessionId, token).changes > 0);
    clearInterval(local.timer); this.#leases.delete(sessionId);
    return removed;
  }

  close() {
    if (this.#closed) return;
    if (this.#depth) throw new Error('Cannot close a database inside a transaction');
    const errors = [];
    for (const [sessionId, local] of this.#leases) {
      try { this.releaseSession(sessionId, local.token); }
      catch (error) { clearInterval(local.timer); errors.push(error); }
    }
    this.#leases.clear(); this.#db.close(); this.#closed = true;
    if (errors.length) throw new AggregateError(errors, 'Database closed but some session leases could not be released');
  }
}
