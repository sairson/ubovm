import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { methodFamily } from './fingerprint.mjs';
import { LearningValidationError } from './validation.mjs';

const APPLICATION_ID = 0x55424c4b;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = Symbol('LearningLibrary');

/** Immutable reusable methods; SQLite transactions serialize writers across processes. */
export class LearningLibrary {
  #db;
  #maximum;
  #closed = false;
  constructor(token, db, maximum) {
    if (token !== key) throw new TypeError('Use LearningLibrary.open');
    this.#db = db; this.#maximum = maximum;
  }
  static async open({ filePath, maxLessons = 512 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('library filePath is required');
    if (!Number.isSafeInteger(maxLessons) || maxLessons < 1 || maxLessons > 10000) throw new RangeError('Invalid library capacity');
    if (filePath !== ':memory:') { filePath = resolve(filePath); await mkdir(dirname(filePath), { recursive: true }); }
    const db = new DatabaseSync(filePath, { timeout: 5000 });
    try {
      db.exec('PRAGMA busy_timeout=5000;');
      db.exec('BEGIN IMMEDIATE');
      try {
        const app = db.prepare('PRAGMA application_id').get().application_id;
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (app !== APPLICATION_ID && (app !== 0 || version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())) throw new Error('File is not a learning library');
        if (version > 5) throw new Error('Unsupported learning library version');
        if (version === 0) {
          db.exec(`CREATE TABLE lessons (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
            CREATE TABLE feedback (lesson_id TEXT NOT NULL REFERENCES lessons(id), source_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')), PRIMARY KEY(lesson_id, source_id)) STRICT;
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
        }
        if (version < 2) db.exec(`CREATE TABLE learning_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT; PRAGMA user_version=2;`);
        if (version < 3) db.exec(`ALTER TABLE feedback ADD COLUMN assessment_id TEXT NOT NULL DEFAULT 'legacy'; PRAGMA user_version=3;`);
        if (version < 4) {
          db.exec(`ALTER TABLE lessons ADD COLUMN family_id TEXT NOT NULL DEFAULT '';
            ALTER TABLE lessons ADD COLUMN parent_id TEXT;
            ALTER TABLE feedback ADD COLUMN fingerprint TEXT;
            ALTER TABLE feedback ADD COLUMN context_id TEXT;
            CREATE TABLE evidence_claims (family_id TEXT NOT NULL, fingerprint TEXT NOT NULL, lesson_id TEXT NOT NULL REFERENCES lessons(id), PRIMARY KEY(family_id, fingerprint)) STRICT;
            PRAGMA user_version=4;`);
          const update = db.prepare('UPDATE lessons SET family_id=? WHERE id=?');
          for (const row of db.prepare('SELECT id, payload FROM lessons').all()) update.run(methodFamily(JSON.parse(row.payload)), row.id);
        }
        if (version < 5) {
          db.exec(`ALTER TABLE feedback ADD COLUMN credit_valid INTEGER NOT NULL DEFAULT 0 CHECK(credit_valid IN (0, 1));
            CREATE TABLE global_evidence_claims (fingerprint TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id)) STRICT;
            INSERT OR IGNORE INTO global_evidence_claims SELECT fingerprint, MIN(lesson_id) FROM evidence_claims GROUP BY fingerprint;
            CREATE INDEX lessons_family ON lessons(family_id, created_at);
            CREATE INDEX feedback_assessments ON feedback(lesson_id, outcome, assessment_id, context_id, credit_valid);
            PRAGMA user_version=5;`);
          const used = new Set();
          for (const row of db.prepare('SELECT payload FROM lessons').all()) {
            for (const ref of JSON.parse(row.payload).source?.evidence ?? []) if (ref.learningFingerprint) used.add(ref.learningFingerprint);
          }
          const validate = db.prepare('UPDATE feedback SET credit_valid=1 WHERE lesson_id=? AND source_id=?');
          for (const row of db.prepare("SELECT * FROM feedback WHERE outcome='success' AND fingerprint IS NOT NULL ORDER BY rowid").all()) {
            if (!used.has(row.fingerprint)) { validate.run(row.lesson_id, row.source_id); used.add(row.fingerprint); }
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      return new LearningLibrary(key, db, maxLessons);
    } catch (error) { db.close(); throw error; }
  }
  #open() { if (this.#closed) throw new Error('Learning library is closed'); }
  #transaction(callback) {
    this.#open(); this.#db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  list({ title, trigger } = {}) {
    this.#open();
    if ((title === undefined) !== (trigger === undefined) || (title !== undefined &&
        (typeof title !== 'string' || !title.trim() || typeof trigger !== 'string' || !trigger.trim()))) throw new TypeError('Invalid method family query');
    const familyId = title === undefined ? null : methodFamily({ title, trigger });
    return this.#db.prepare(`SELECT l.*, COUNT(DISTINCT CASE WHEN f.outcome='success' AND f.credit_valid=1 THEN f.assessment_id END) AS successes,
      COUNT(DISTINCT CASE WHEN f.outcome='success' AND f.credit_valid=1 THEN f.context_id END) AS independent_sessions,
      COUNT(DISTINCT CASE WHEN f.outcome='failure' THEN f.assessment_id END) AS failures,
      (SELECT COUNT(DISTINCT ff.assessment_id) FROM feedback ff JOIN lessons ll ON ll.id=ff.lesson_id WHERE ll.family_id=l.family_id AND ff.outcome='failure') AS family_failures
      FROM lessons l LEFT JOIN feedback f ON f.lesson_id=l.id
      WHERE (? IS NULL OR l.family_id=?)
      GROUP BY l.id ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`).all(familyId, familyId, this.#maximum).map(row => ({
      ...JSON.parse(row.payload), id: row.id, familyId: row.family_id, parentId: row.parent_id,
      updatedAt: row.created_at, successes: row.successes, failures: row.failures,
      independentSessions: row.independent_sessions, familyFailures: row.family_failures,
      needsValidation: Boolean(row.parent_id) && (row.successes < 2 || row.independent_sessions < 2 || row.failures > 0),
      status: row.failures ? 'needs-review' : row.successes >= 2 && row.independent_sessions >= 2 ? 'practiced' : 'candidate', scope: 'library'
    }));
  }
  registerSource({ filePath, sessionId, reflection = false, enabled = true }) {
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || typeof sessionId !== 'string' || !sessionId.trim() ||
        typeof reflection !== 'boolean' || typeof enabled !== 'boolean') throw new TypeError('Invalid learning source');
    const source = { filePath: resolve(filePath), sessionId, reflection, enabled };
    const id = hash([source.filePath, sessionId]);
    this.#transaction(() => this.#db.prepare('INSERT INTO learning_sources VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload').run(id, JSON.stringify(source)));
  }
  sources() {
    this.#open();
    return this.#db.prepare('SELECT payload FROM learning_sources ORDER BY id').all().map(row => JSON.parse(row.payload));
  }
  publish(lesson, sessionId) {
    // Export only the curated procedure and provenance, never transcripts or tool outputs.
    if (!lesson || !['title', 'trigger', 'workerId'].every(name => typeof lesson[name] === 'string' && lesson[name].trim()) ||
        !Array.isArray(lesson.steps) || !lesson.steps.length || lesson.steps.some(step => typeof step !== 'string' || !step.trim()) ||
        !Array.isArray(lesson.evidence) || !lesson.evidence.length || typeof sessionId !== 'string' || !sessionId) throw new TypeError('Invalid published lesson');
    const method = { title: lesson.title, trigger: lesson.trigger, steps: lesson.steps };
    if (Buffer.byteLength(JSON.stringify(method)) > 32768) throw new RangeError('Published lesson is too large');
    const id = hash(method);
    const familyId = methodFamily(method);
    const revisionEvidence = [...lesson.evidence, ...(lesson.failureEvidence ?? [])];
    return this.#transaction(() => {
      if (!this.#db.prepare('SELECT id FROM lessons WHERE id=?').get(id)) {
        if (this.#db.prepare('SELECT COUNT(*) AS total FROM lessons').get().total >= this.#maximum) throw new LearningValidationError('Shared knowledge capacity reached', 'KNOWLEDGE_CAPACITY');
        const parent = this.#db.prepare('SELECT id FROM lessons WHERE family_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(familyId);
        if (parent && !revisionEvidence.some(ref => /^[a-f0-9]{64}$/u.test(ref.learningFingerprint ?? '') &&
            !this.#db.prepare('SELECT 1 FROM evidence_claims WHERE family_id=? AND fingerprint=?').get(familyId, ref.learningFingerprint))) {
          throw new LearningValidationError('Method revision requires a new host-recorded observation, not reused publication or feedback evidence', 'KNOWLEDGE_REVISION_NO_NOVEL_EVIDENCE');
        }
        const payload = { ...method, source: { sessionId, workerId: lesson.workerId, evidence: lesson.evidence,
          ...(lesson.failureEvidence?.length ? { failureEvidence: lesson.failureEvidence } : {}) } };
        this.#db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?)').run(id, JSON.stringify(payload), new Date().toISOString(), familyId, parent?.id ?? null);
      }
      // Every publication's source is excluded, including duplicate publications
      // from other sessions. Claims also survive method revision.
      const claim = this.#db.prepare('INSERT OR IGNORE INTO evidence_claims VALUES (?, ?, ?)');
      const globalClaim = this.#db.prepare('INSERT OR IGNORE INTO global_evidence_claims VALUES (?, ?)');
      for (const ref of revisionEvidence) {
        if (/^[a-f0-9]{64}$/u.test(ref.learningFingerprint ?? '')) {
          claim.run(familyId, ref.learningFingerprint, id); globalClaim.run(ref.learningFingerprint, id);
        }
        if (/^[a-f0-9]{64}$/u.test(ref.learningRequestFingerprint ?? '')) {
          claim.run(familyId, `request:${ref.learningRequestFingerprint}`, id); globalClaim.run(`request:${ref.learningRequestFingerprint}`, id);
        }
      }
      return { id, scope: 'library' };
    });
  }
  feedback(id, { sessionId, workerId, records, outcome }) {
    if (!['success', 'failure'].includes(outcome) || !Array.isArray(records) || !records.length || records.length > 16 ||
        typeof sessionId !== 'string' || !sessionId || typeof workerId !== 'string' || !workerId ||
        records.some(record => !record || record.sessionId !== sessionId || record.workerId !== workerId || record.status !== 'completed' ||
          typeof record.toolCallId !== 'string' || !record.toolCallId.trim() || typeof record.isError !== 'boolean') ||
        (outcome === 'success' ? records.some(record => record.isError !== false) : !records.some(record => record.isError === true))) throw new Error('Feedback outcome must match actual execution evidence');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT payload, family_id FROM lessons WHERE id=?').get(id);
      if (!row) throw new Error('Shared lesson not found');
      const origin = JSON.parse(row.payload).source;
      // Each call can support one assessment per method. Reordered/replayed batches add no confidence.
      const insert = this.#db.prepare('INSERT OR IGNORE INTO feedback VALUES (?, ?, ?, ?, ?, ?, ?)');
      const claim = this.#db.prepare('INSERT OR IGNORE INTO evidence_claims VALUES (?, ?, ?)');
      const globalClaim = this.#db.prepare('INSERT OR IGNORE INTO global_evidence_claims VALUES (?, ?)');
      let recorded = false;
      for (const record of records) {
        // A failed batch must not label its successful calls as failures.
        if (outcome === 'failure' && !record.isError) continue;
        // Publication evidence establishes provenance, never independent practice.
        if (outcome === 'success' && origin?.sessionId === sessionId && origin.workerId === workerId &&
            origin.evidence.some(ref => ref.toolCallId === record.toolCallId)) continue;
        const source = hash([sessionId, workerId, record.toolCallId]);
        const old = this.#db.prepare('SELECT outcome FROM feedback WHERE lesson_id=? AND source_id=?').get(id, source);
        if (old && old.outcome !== outcome) throw new Error('Conflicting feedback for the same evidence');
        if (old) continue;
        // Foreign tools cannot assess this procedure; successful observations
        // without a host novelty fingerprint never raise confidence.
        const tools = new Set(origin?.evidence?.map(ref => ref.tool).filter(Boolean));
        if (!tools.size || !tools.has(record.toolName)) throw new Error('Feedback tool does not match method evidence');
        if (outcome === 'success') {
          if (!/^[a-f0-9]{64}$/u.test(record.learningFingerprint ?? '') ||
              !/^[a-f0-9]{64}$/u.test(record.learningRequestFingerprint ?? '')) continue;
          const requestKey = `request:${record.learningRequestFingerprint}`;
          const exists = this.#db.prepare('SELECT 1 FROM evidence_claims WHERE family_id=? AND fingerprint IN (?, ?)');
          if (exists.get(row.family_id, record.learningFingerprint, requestKey)) continue;
          if (this.#db.prepare('SELECT 1 FROM global_evidence_claims WHERE fingerprint IN (?, ?)').get(record.learningFingerprint, requestKey)) continue;
          claim.run(row.family_id, record.learningFingerprint, id);
          claim.run(row.family_id, requestKey, id);
          globalClaim.run(record.learningFingerprint, id); globalClaim.run(requestKey, id);
        }
        const assessment = hash([sessionId, workerId, record.attemptId || 'unknown-attempt']);
        recorded = Boolean(insert.run(id, source, outcome, assessment, record.learningFingerprint ?? null, hash(sessionId), Number(outcome === 'success')).changes) || recorded;
      }
      return { id, outcome, recorded };
    });
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
