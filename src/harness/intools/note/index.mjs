import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { assertSession, checkAbort, required, toolResult } from '../shared/store/memory-store.mjs';
import { withActionHelp, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { NOTE_CATALOG } from '../shared/tool-catalogs.mjs';

const MAX_CONTENT = 16 * 1024;
const string = Type.String();
const optionalString = Type.Optional(string);
const stringsSchema = Type.Array(string);
const optionalStrings = Type.Optional(stringsSchema);
const objectSchema = Type.Record(Type.String(), Type.Unknown());
const enumSchema = values => Type.Union(values.map(value => Type.Literal(value)));
const noteTypes = ['note', 'asset', 'vulnerability', 'flag', 'scope'];
const subtypeSchema = Type.String({ description: 'A 2-64 character lowercase snake_case identifier starting with a letter, e.g. http_endpoint, source_file, sql_injection. Spaces, hyphens and camelCase are normalized.' });
const assetKeys = ['type', 'locator', 'content', 'method', 'operation', 'protocol', 'details', 'evidence', 'tool_call_ids'];
const vulnerabilityLists = ['preconditions', 'effects', 'constraints', 'evidence', 'chain_hints', 'related_note_ids', 'tool_call_ids'];
const vulnerabilityKeys = ['type', 'title', 'target', 'vector', 'status', 'severity', 'details', ...vulnerabilityLists];
const flagStatuses = ['found', 'verified', 'submitted', 'accepted', 'rejected'];
const flagKeys = ['value', 'target', 'challenge', 'source', 'status', 'verification', 'evidence', 'tool_call_ids', 'details'];
const scopeKeys = ['targets', 'out_of_scope', 'rules', 'authorization', 'evidence', 'tool_call_ids', 'details'];
const assetSchema = Type.Object({ type: subtypeSchema, locator: string, content: optionalString, method: optionalString, operation: optionalString, protocol: optionalString, details: Type.Optional(objectSchema), evidence: optionalStrings, tool_call_ids: optionalStrings }, { additionalProperties: false });
const vulnerabilitySchema = Type.Object({ type: subtypeSchema, title: string, target: string, vector: optionalString, status: Type.Optional(enumSchema(['candidate', 'verified', 'exploitable'])), severity: Type.Optional(enumSchema(['unknown', 'info', 'low', 'medium', 'high', 'critical'])), details: Type.Optional(objectSchema), ...Object.fromEntries(vulnerabilityLists.map(key => [key, ['effects', 'evidence'].includes(key) ? stringsSchema : optionalStrings])) }, { additionalProperties: false });
const flagSchema = Type.Object({
  value: Type.String({ description: 'The flag string exactly as observed; never guess or fabricate one.' }),
  target: string,
  challenge: optionalString,
  source: optionalString,
  status: Type.Optional(enumSchema(flagStatuses)),
  verification: optionalString,
  evidence: optionalStrings,
  tool_call_ids: optionalStrings,
  details: Type.Optional(objectSchema)
}, { additionalProperties: false });
const scopeSchema = Type.Object({
  targets: stringsSchema,
  out_of_scope: optionalStrings,
  rules: optionalString,
  authorization: optionalString,
  evidence: optionalStrings,
  tool_call_ids: optionalStrings,
  details: Type.Optional(objectSchema)
}, { additionalProperties: false });
const parameters = Type.Object(withActionHelp({
  note_type: Type.Optional({ ...enumSchema(noteTypes), description: 'Record category. On write, omit to infer from asset/vulnerability/flag/scope, otherwise defaults to note. On list, omit for all categories. fact and intent belong in promotion_kind, not note_type.' }), asset_type: Type.Optional(subtypeSchema), vulnerability_type: Type.Optional(subtypeSchema),
  asset: Type.Optional(Type.Union([assetSchema, Type.String({ description: 'Compatibility: JSON-encoded asset object' })])), vulnerability: Type.Optional(vulnerabilitySchema),
  flag: Type.Optional(Type.Union([flagSchema, Type.String({ description: 'Compatibility: JSON-encoded flag object' })])),
  scope: Type.Optional(Type.Union([scopeSchema, Type.String({ description: 'Compatibility: JSON-encoded engagement scope object' })])),
  type: Type.Optional(subtypeSchema), locator: optionalString, method: optionalString, operation: optionalString, protocol: optionalString, details: Type.Optional(objectSchema),
  content: optionalString, query: optionalString, limit: Type.Optional(Type.Integer()), offset: Type.Optional(Type.Integer()), note_id: optionalString, delete_reason: optionalString,
  promotion_kind: optionalString, outcome: optionalString, statement: optionalString, evidence: optionalStrings, failed_checks: optionalStrings, limitations: optionalStrings, description: optionalString, hint: optionalString, tool_call_ids: optionalStrings
}), { additionalProperties: false });

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function text(value, label, maxBytes = MAX_CONTENT) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const result = value.trim();
  if (Buffer.byteLength(result) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return result;
}
function textList(values, label, maxItems = 64, maxBytes = MAX_CONTENT) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  return [...new Set(values.map(value => text(value, label, maxBytes)).filter(Boolean))];
}
function subtype(value, label) {
  value = required(text(value, label), label)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/gu, '_').toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(value)) throw new Error(`${label} must be 2-64 lowercase snake_case characters`);
  return value;
}
function details(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('details must be an object');
  return structuredClone(value);
}
function bounded(value, label) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTENT) throw new Error(`${label} exceeds ${MAX_CONTENT} bytes`);
  return value;
}
const fingerprint = values => `sha256:${createHash('sha256').update(values.join('\0')).digest('hex')}`;
const mergeList = (left, right) => [...new Set([...left, ...right])];

function parseInput(input) {
  if (typeof input === 'string') {
    let raw = input.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u, '$1').replace(/^,\s*(?=\{)/u, '');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (initial) {
      while (raw.endsWith('}}')) {
        raw = raw.slice(0, -1);
        try { parsed = JSON.parse(raw); break; } catch { /* Strict whole-object repair only. */ }
      }
      if (!parsed) throw initial;
    }
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
    input = parsed;
  }
  fields(input, Object.keys(parameters.properties), 'note');
  const value = structuredClone(input);
  const action = required(value.action, 'action').toLowerCase();
  if (!['write', 'list', 'get', 'promote', 'delete'].includes(action)) throw new Error('action must be write, list, get, promote, or delete');
  // Known fields from sibling operations are ignored; unknown fields still fail.
  const normalized = { action };
  if (action === 'write' || action === 'list') {
    normalized.note_type = text(value.note_type, 'note_type').toLowerCase();
    if (['note-knowledge', 'note_knowledge'].includes(normalized.note_type)) normalized.note_type = 'note';
    if (normalized.note_type && !noteTypes.includes(normalized.note_type)) throw new Error(`Invalid note_type ${JSON.stringify(normalized.note_type)}: expected note, asset, vulnerability, flag, or scope. Use asset.type/vulnerability.type for subtypes, flag/scope objects for engagement records, and promotion_kind for fact/intent.`);
  }
  if (['get', 'promote', 'delete'].includes(action)) normalized.note_id = required(value.note_id, 'note_id');
  if (action === 'delete') normalized.delete_reason = required(text(value.delete_reason, 'delete_reason', 1024), 'delete_reason');
  if (action === 'list') {
    normalized.query = text(value.query, 'query', 1024).toLowerCase();
    normalized.asset_type = value.asset_type ? subtype(value.asset_type, 'asset_type') : '';
    normalized.vulnerability_type = value.vulnerability_type ? subtype(value.vulnerability_type, 'vulnerability_type') : '';
    normalized.note_type ||= normalized.asset_type ? 'asset' : normalized.vulnerability_type ? 'vulnerability' : '';
    normalized.limit = value.limit === undefined || value.limit === 0 ? 20 : value.limit;
    normalized.offset = value.offset ?? 0;
    if (!Number.isSafeInteger(normalized.limit) || normalized.limit < 1 || normalized.limit > 200 || !Number.isSafeInteger(normalized.offset) || normalized.offset < 0) throw new Error('list requires limit 1-200 and nonnegative offset');
  }
  if (action === 'write' || action === 'promote') {
    normalized.promotion_kind = text(value.promotion_kind, 'promotion_kind').toLowerCase();
    if (action === 'promote' && !normalized.promotion_kind) throw new Error('promotion_kind is required');
    if (normalized.promotion_kind && !['fact', 'intent'].includes(normalized.promotion_kind)) throw new Error('promotion_kind must be fact or intent');
    if (normalized.promotion_kind === 'fact') {
      normalized.outcome = text(value.outcome, 'outcome').toLowerCase() || 'confirmed';
      if (!['confirmed', 'negative', 'partial', 'blocked'].includes(normalized.outcome)) throw new Error('Invalid fact outcome');
      normalized.statement = text(value.statement, 'statement');
      for (const key of ['evidence', 'failed_checks', 'limitations']) normalized[key] = textList(value[key], key);
      normalized.tool_call_ids = textList(value.tool_call_ids, 'tool_call_ids', 16, 128);
    } else if (normalized.promotion_kind === 'intent') {
      normalized.description = required(text(value.description, 'description', 4096).replace(/\s+/gu, ' '), 'description');
      // hint belongs exclusively to user guidance; machine values are discarded.
    }
  }
  if (action === 'write') {
    if (!normalized.note_type) {
      const typed = [
        ['asset', value.asset !== undefined || Boolean(value.asset_type)],
        ['vulnerability', value.vulnerability !== undefined || Boolean(value.vulnerability_type)],
        ['flag', value.flag !== undefined],
        ['scope', value.scope !== undefined]
      ].filter(([, present]) => present).map(([kind]) => kind);
      if (typed.length > 1) throw new Error('Specify note_type when asset, vulnerability, flag and scope are combined');
      normalized.note_type = typed[0] ?? 'note';
    }
    normalized.content = text(value.content, 'content');
    if (normalized.note_type === 'asset') {
      let asset = value.asset;
      if (typeof asset === 'string') asset = JSON.parse(asset);
      asset ??= {};
      fields(asset, assetKeys, 'asset');
      asset = { ...asset };
      for (const key of ['locator', 'method', 'operation', 'protocol']) asset[key] ||= value[key];
      asset.type ||= value.type || value.asset_type;
      normalized.content ||= text(asset.content, 'asset.content');
      normalized.asset = {
        type: subtype(asset.type, 'asset.type'), locator: required(text(asset.locator, 'asset.locator'), 'asset.locator'),
        method: text(asset.method, 'asset.method').toUpperCase(), operation: text(asset.operation, 'asset.operation'), protocol: text(asset.protocol, 'asset.protocol').toLowerCase(),
        details: { ...details(value.details), ...details(asset.details) },
        evidence: textList([...textList(asset.evidence, 'asset.evidence'), ...(!normalized.promotion_kind ? textList(value.evidence, 'evidence') : [])], 'asset.evidence'),
        tool_call_ids: textList([...textList(asset.tool_call_ids, 'asset.tool_call_ids', 32, 128), ...(!normalized.promotion_kind ? textList(value.tool_call_ids, 'tool_call_ids', 32, 128) : [])], 'asset.tool_call_ids', 32, 128)
      };
      normalized.content ||= [normalized.asset.type, normalized.asset.method, normalized.asset.locator, normalized.asset.operation].filter(Boolean).join(' ');
      bounded(normalized.asset, 'asset');
    } else if (normalized.note_type === 'vulnerability') {
      const v = value.vulnerability; fields(v, vulnerabilityKeys, 'vulnerability');
      normalized.vulnerability = { type: subtype(v.type, 'vulnerability.type'), title: required(text(v.title, 'vulnerability.title'), 'vulnerability.title'), target: required(text(v.target, 'vulnerability.target'), 'vulnerability.target'), vector: text(v.vector, 'vulnerability.vector'), status: text(v.status, 'vulnerability.status').toLowerCase() || 'candidate', severity: text(v.severity, 'vulnerability.severity').toLowerCase() || 'unknown', details: details(v.details) };
      const out = normalized.vulnerability;
      if (!['candidate', 'verified', 'exploitable'].includes(out.status) || !['unknown', 'info', 'low', 'medium', 'high', 'critical'].includes(out.severity)) throw new Error('Invalid vulnerability status or severity');
      for (const key of vulnerabilityLists) out[key] = textList(v[key], `vulnerability.${key}`, key === 'tool_call_ids' ? 32 : 64, key.endsWith('_ids') ? 128 : MAX_CONTENT);
      if (!out.effects.length || !out.evidence.length) throw new Error('vulnerability.effects and vulnerability.evidence require at least one item');
      normalized.content ||= out.title;
      bounded(out, 'vulnerability');
    } else if (normalized.note_type === 'flag') {
      let flag = value.flag;
      if (typeof flag === 'string') flag = JSON.parse(flag);
      if (!flag) throw new Error('flag payload is required when note_type is flag');
      fields(flag, flagKeys, 'flag');
      const status = text(flag.status, 'flag.status').toLowerCase() || 'found';
      if (!flagStatuses.includes(status)) throw new Error('flag.status must be found, verified, submitted, accepted, or rejected');
      const payload = {
        value: required(text(flag.value, 'flag.value', 4096), 'flag.value'),
        target: required(text(flag.target, 'flag.target', 2048), 'flag.target'),
        challenge: text(flag.challenge, 'flag.challenge', 2048),
        source: text(flag.source, 'flag.source', 2048),
        status,
        verification: text(flag.verification, 'flag.verification', 8192),
        evidence: textList(flag.evidence, 'flag.evidence'),
        tool_call_ids: textList(flag.tool_call_ids, 'flag.tool_call_ids', 32, 128),
        details: details(flag.details)
      };
      if (payload.value.includes('\n') || payload.value.includes('\r')) throw new Error('flag.value must not contain line breaks');
      // A flag is not confirmed merely because it looks plausible. Verified or
      // later states require the actual checker result and its evidence.
      if (status !== 'found' && !payload.verification) throw new Error(`flag.verification (the checker or challenge result) is required for status ${status}`);
      if (status !== 'found' && !payload.evidence.length && !payload.tool_call_ids.length) throw new Error(`flag.evidence or flag.tool_call_ids is required for status ${status}`);
      normalized.flag = payload;
      normalized.content ||= `FLAG ${payload.target}: ${payload.value}`;
      bounded(payload, 'flag');
    } else if (normalized.note_type === 'scope') {
      let scope = value.scope;
      if (typeof scope === 'string') scope = JSON.parse(scope);
      if (!scope) throw new Error('scope payload is required when note_type is scope');
      fields(scope, scopeKeys, 'scope');
      const targets = textList(scope.targets, 'scope.targets', 64, 512);
      if (!targets.length) throw new Error('scope.targets requires at least one authorized target');
      const payload = {
        targets,
        out_of_scope: textList(scope.out_of_scope, 'scope.out_of_scope', 64, 512),
        rules: text(scope.rules, 'scope.rules', 8192),
        authorization: text(scope.authorization, 'scope.authorization', 4096),
        evidence: textList(scope.evidence, 'scope.evidence'),
        tool_call_ids: textList(scope.tool_call_ids, 'scope.tool_call_ids', 32, 128),
        details: details(scope.details)
      };
      normalized.scope = payload;
      normalized.content ||= 'Authorized scope: ' + targets.join(', ') + (payload.out_of_scope.length ? '; out of scope: ' + payload.out_of_scope.join(', ') : '');
      bounded(payload, 'scope');
    } else required(normalized.content, 'content');
    text(normalized.content, 'content');
  }
  return normalized;
}

function publicNote(state, source) {
  if (!source) return undefined;
  const note = structuredClone(source);
  const promotions = state.promotions.filter(entry => entry.note_id === note.id).map(({ spec, ...entry }) => entry);
  if (promotions.length) note.promotions = promotions;
  return note;
}
function mergePayload(existing, incoming, kind) {
  const next = { ...existing, ...incoming, details: { ...existing.details, ...incoming.details } };
  const listKeys = kind === 'asset' ? ['evidence', 'tool_call_ids']
    : kind === 'vulnerability' ? vulnerabilityLists
    : kind === 'flag' ? ['evidence', 'tool_call_ids']
    : ['targets', 'out_of_scope', 'evidence', 'tool_call_ids'];
  for (const key of listKeys) next[key] = mergeList(existing[key] ?? [], incoming[key] ?? []);
  if (kind === 'vulnerability') {
    for (const [key, ranks] of [['status', ['candidate', 'verified', 'exploitable']], ['severity', ['unknown', 'info', 'low', 'medium', 'high', 'critical']]]) if (ranks.indexOf(existing[key]) > ranks.indexOf(incoming[key])) next[key] = existing[key];
  } else if (kind === 'flag') {
    const ranks = ['found', 'verified', 'submitted', 'accepted', 'rejected'];
    next.status = ranks.indexOf(existing.status) > ranks.indexOf(incoming.status) ? existing.status : incoming.status;
    next.verification = incoming.verification || existing.verification;
    next.challenge = incoming.challenge || existing.challenge;
    next.source = incoming.source || existing.source;
  } else if (kind === 'scope') {
    next.rules = incoming.rules || existing.rules;
    next.authorization = incoming.authorization || existing.authorization;
  }
  return bounded(next, kind);
}
function sameIntent(left, right) {
  const normalize = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let a = normalize(left), b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Array.from(a).length > Array.from(b).length) [a, b] = [b, a];
  return Array.from(a).length >= 6 && Array.from(a).length / Array.from(b).length >= 0.72 && b.includes(a);
}
function equivalentNode(blackboard, kind, spec) {
  return blackboard.snapshot().nodes.find(node => {
    if (kind === 'intent') return node.intent && sameIntent(node.intent.description, spec.description);
    if (!node.fact || node.kind === 'root') return false;
    try { const a = JSON.parse(node.fact.content), b = JSON.parse(spec.content); return a.outcome === b.outcome && typeof a.statement === 'string' && a.statement.toLowerCase() === b.statement.toLowerCase(); } catch { return false; }
  });
}

/** A session notebook with an independently durable promotion journal. */
export function createNoteTool({ store, sessionId, workerId = 'worker', blackboard, canPromote = true, evidenceProvider } = {}) {
  assertSession(store, sessionId); sessionId = store.sessionId; workerId = required(workerId, 'workerId');
  if (blackboard && blackboard.snapshot().sessionId !== sessionId) throw new Error('Blackboard belongs to another session');
  if (evidenceProvider !== undefined && typeof evidenceProvider !== 'function') throw new TypeError('evidenceProvider must be a function');

  async function verifyEvidence(ids, sourceWorkerId, warnings, { requireSuccess = false } = {}) {
    const verified = [];
    for (const id of ids) {
      const call = await evidenceProvider?.({ toolCallId: id, sessionId, workerId: sourceWorkerId });
      if (!call) { warnings.push(`Unavailable evidence tool call ${JSON.stringify(id)} was omitted from provenance.`); continue; }
      const callSession = call.sessionId ?? call.session_id, callWorker = call.workerId ?? call.worker_id;
      if (callSession !== sessionId || callWorker !== sourceWorkerId || !(call.status === 'completed' || /^completed_/u.test(call.status ?? ''))) throw new Error(`Tool call ${id} is not a completed call owned by ${sourceWorkerId} in this session`);
      if (requireSuccess && (call.isError === true || call.is_error === true || /^completed_(?:error|failed|failure)$/u.test(call.status))) throw new Error(`Tool call ${id} failed and cannot support fact evidence; describe the failure in failed_checks instead`);
      if ((call.toolCallId ?? call.tool_call_id ?? call.id ?? id) !== id) throw new Error(`Evidence provider returned another tool call for ${id}`);
      verified.push(id);
    }
    return verified;
  }

  function parentFor(note) {
    if (blackboard.node(note.worker_id)) return note.worker_id;
    const registration = store.snapshot(['workers']).workers.find(item => item.worker_id === note.worker_id);
    if (registration && blackboard.node(registration.root_worker_id)) return registration.root_worker_id;
    throw new Error(`Source Worker node ${note.worker_id} was not found; register its root Worker before promotion`);
  }

  async function applyPromotion(entry) {
    let node = blackboard.node(entry.node_id);
    if (!node) {
      try { node = await (entry.kind === 'fact' ? blackboard.createFact({ id: entry.node_id, ...entry.spec }) : blackboard.createIntent({ id: entry.node_id, ...entry.spec })); }
      catch (error) { node = blackboard.node(entry.node_id); if (!node) throw error; }
    }
    // A matching ID must be a compatible node, never an unrelated collision.
    const compatible = entry.kind === 'fact' ? node.fact?.content === entry.spec.content || equivalentNode({ snapshot: () => ({ nodes: [node] }) }, 'fact', entry.spec) : node.intent && sameIntent(node.intent.description, entry.spec.description);
    if (!compatible) throw new Error(`Promotion node ${entry.node_id} conflicts with its journal`);
    await blackboard.mergeProvenance(entry.node_id, entry.spec.provenance);
    return store.commit(state => {
      const journal = state.promotions.find(item => item.note_id === entry.note_id && item.kind === entry.kind);
      const note = state.notes.find(item => item.id === entry.note_id);
      if (!journal || !note) throw new Error('Promotion source or journal disappeared');
      if (journal.status !== 'completed') {
        const now = new Date().toISOString();
        journal.status = 'completed'; journal.updated_at = now; journal.promoted_at = now;
        note.promotion_kind = entry.kind; note.promotion_node_id = entry.node_id; note.promotion_status = 'completed'; note.promoted_at = now;
      }
      return publicNote(state, note);
    });
  }

  async function promote(request, warnings, signal) {
    if (!canPromote) throw new Error('Specialist agents cannot promote notes; ask the owning Worker to validate and promote');
    if (!blackboard) throw new Error('blackboard is required for promotion');
    if (request.promotion_kind === 'fact' && (!request.statement || !request.evidence.length)) throw Object.assign(new Error('Fact promotion requires a nonempty statement and at least one concrete evidence item'), { code: 'INCOMPLETE_FACT_PROMOTION' });
    return store.serial('promotions', async () => {
      checkAbort(signal);
      const snapshot = store.snapshot(['notes', 'promotions']);
      const note = snapshot.notes.find(item => item.id === request.note_id);
      if (!note) throw new Error(`Note ${request.note_id} was not found in this session`);
      const reserved = snapshot.promotions.find(item => item.note_id === note.id && item.kind === request.promotion_kind);
      if (reserved) return applyPromotion(reserved);
      const ids = await verifyEvidence(request.tool_call_ids ?? [], note.worker_id, warnings, { requireSuccess: true });
      const provenance = { sourceType: 'note', noteIds: [note.id], workerIds: [note.worker_id], toolCallIds: ids };
      const spec = { parentIds: [parentFor(note)], provenance };
      if (request.promotion_kind === 'fact') spec.content = JSON.stringify({
        version: 1,
        outcome: request.outcome,
        statement: request.statement,
        evidence: request.evidence.map(observation => ({ observation })),
        failedChecks: request.failed_checks,
        limitations: request.limitations
      });
      else spec.description = request.description;
      const id = equivalentNode(blackboard, request.promotion_kind, spec)?.id ?? `note-knowledge-${note.id}-${request.promotion_kind}`;
      const entry = await store.commit(state => {
        checkAbort(signal);
        if (!state.notes.some(item => item.id === note.id)) throw new Error('Promotion source was deleted');
        const now = new Date().toISOString();
        const journal = { note_id: note.id, session_id: sessionId, kind: request.promotion_kind, node_id: id, status: 'pending', spec, created_at: now, updated_at: now };
        state.promotions.push(journal);
        const source = state.notes.find(item => item.id === note.id);
        source.promotion_kind = journal.kind; source.promotion_node_id = id; source.promotion_status = 'pending';
        return journal;
      });
      checkAbort(signal);
      return applyPromotion(entry);
    });
  }

  const tool = {
    name: 'note', label: 'Session notebook', parameters,
    description: NOTE_CATALOG.description,
    async execute(_toolCallId, input, signal) {
      checkAbort(signal);
      const request = parseInput(input), warnings = [];
      if (request.promotion_kind && !canPromote) throw new Error('Specialist agents cannot promote notes; ask the owning Worker to validate and promote');
      await store.flush(); checkAbort(signal);
      let result;
      if (request.action === 'write') {
        const kind = request.note_type;
        const payload = request[kind];
        if (payload) {
          payload.tool_call_ids = await verifyEvidence(payload.tool_call_ids, workerId, warnings);
          if (kind === 'vulnerability') {
            const ids = new Set(store.snapshot(['notes']).notes.map(note => note.id));
            payload.related_note_ids = payload.related_note_ids.filter(id => { if (ids.has(id)) return true; warnings.push(`Unavailable related note ${JSON.stringify(id)} was omitted.`); return false; });
          }
        }
        result = await store.commit(state => {
          checkAbort(signal);
          const fp = kind === 'asset' ? fingerprint([payload.type, payload.locator, payload.method, payload.operation, payload.protocol])
            : kind === 'vulnerability' ? fingerprint([payload.type, payload.target, payload.vector])
            : kind === 'flag' ? fingerprint([payload.target, payload.value])
            : kind === 'scope' ? fingerprint([...payload.targets].sort())
            : '';
          const existing = fp && state.notes.find(note => note.note_type === kind && note[`${kind}_fingerprint`] === fp);
          const now = new Date().toISOString();
          if (existing) {
            existing[kind] = mergePayload(existing[kind], payload, kind);
            existing.content = request.content || existing.content; existing.seen_count++; existing.last_seen_at = now;
            existing.contributor_worker_ids = mergeList(existing.contributor_worker_ids ?? [existing.worker_id], [workerId]);
            return { status: 'already_known', count: 1, note: publicNote(state, existing) };
          }
          const note = { id: `note-${randomUUID()}`, session_id: sessionId, worker_id: workerId, content: request.content, note_type: kind, seen_count: 1, last_seen_at: now, created_at: now };
          if (payload) { note[kind] = payload; if (payload.type !== undefined) note[`${kind}_type`] = payload.type; note[`${kind}_fingerprint`] = fp; note.contributor_worker_ids = [workerId]; }
          state.notes.push(note);
          return { status: 'saved', count: 1, note: publicNote(state, note) };
        });
        if (request.promotion_kind && result.status !== 'already_known') {
          try { result = { status: 'promoted', count: 1, note: await promote({ ...request, note_id: result.note.id }, warnings, signal) }; }
          catch (error) {
            checkAbort(signal);
            const state = store.snapshot(['notes', 'promotions']);
            result = { status: error.code === 'INCOMPLETE_FACT_PROMOTION' ? 'saved_promotion_skipped' : 'saved_promotion_pending', count: 1, note: publicNote(state, state.notes.find(note => note.id === result.note.id)), error: error.message };
          }
        }
      } else if (request.action === 'list') {
        const state = store.snapshot(['notes', 'promotions']);
        const notes = state.notes.filter(note => (!request.note_type || note.note_type === request.note_type) && (!request.asset_type || note.asset_type === request.asset_type) && (!request.vulnerability_type || note.vulnerability_type === request.vulnerability_type) && (!request.query || [note.content, JSON.stringify(note.asset ?? {}), JSON.stringify(note.vulnerability ?? {}), JSON.stringify(note.flag ?? {}), JSON.stringify(note.scope ?? {})].join(' ').toLowerCase().includes(request.query))).reverse();
        const page = notes.slice(request.offset, request.offset + request.limit).map(note => publicNote(state, note));
        result = { status: 'ok', count: page.length, total: notes.length, offset: request.offset,
          next_offset: request.offset + page.length < notes.length ? request.offset + page.length : null, notes: page };
      } else if (request.action === 'get') {
        const state = store.snapshot(['notes', 'promotions']); const note = state.notes.find(note => note.id === request.note_id);
        result = note ? { status: 'ok', count: 1, note: publicNote(state, note) } : { status: 'not_found', count: 0, error: `Note ${request.note_id} was not found in this session` };
      } else if (request.action === 'delete') {
        result = await store.commit(state => {
          checkAbort(signal);
          const note = state.notes.find(note => note.id === request.note_id);
          if (!note) return { status: 'not_found', count: 0, error: `Note ${request.note_id} was not found in this session` };
          if (!canPromote && note.worker_id !== workerId) throw new Error('Specialist agents may delete only notes they created');
          if (state.promotions.some(entry => entry.note_id === note.id)) throw new Error('Promoted notes and notes with pending promotions cannot be deleted');
          state.notes = state.notes.filter(item => item.id !== note.id);
          state.audit.push({ type: 'note.deleted', note_id: note.id, note_type: note.note_type, source_worker: note.worker_id, deleted_by: workerId, reason: request.delete_reason, created_at: new Date().toISOString() });
          return { status: 'deleted', count: 1, note };
        });
      } else {
        try { result = { status: 'promoted', count: 1, note: await promote(request, warnings, signal) }; }
        catch (error) { if (error.code !== 'INCOMPLETE_FACT_PROMOTION') throw error; result = { status: 'promotion_rejected', count: 0, error: error.message }; }
      }
      if (warnings.length) result.warnings = warnings;
      return toolResult(result);
    },
    async recoverPromotions() {
      if (!blackboard) { if (store.snapshot(['promotions']).promotions.length) throw new Error('blackboard is required to recover promotions'); return []; }
      return store.serial('promotions', async () => {
        await store.flush();
        const recovered = [];
        for (const entry of store.snapshot(['promotions']).promotions) { await applyPromotion(entry); recovered.push(entry.node_id); }
        return recovered;
      });
    }
  };
  const disclosed = withProgressiveDisclosure(tool, NOTE_CATALOG);
  // Preserve host helpers used outside model tool calls.
  disclosed.recoverPromotions = (...args) => tool.recoverPromotions(...args);
  // Compact engagement ledger injected into every Worker model boundary so a
  // resumed or long-running Worker does not lose scope/flag state.
  disclosed.summary = () => {
    const notes = store.snapshot(['notes']).notes;
    const flags = notes.filter(note => note.note_type === 'flag').slice(-12).map(note => ({
      target: note.flag?.target, challenge: note.flag?.challenge, status: note.flag?.status,
      value: note.flag?.value, verification: note.flag?.verification || undefined
    }));
    const scope = notes.filter(note => note.note_type === 'scope').slice(-1)[0]?.scope;
    if (!flags.length && !scope) return '';
    return '# Security engagement ledger\n' + JSON.stringify({
      ...(scope ? { scope: { targets: scope.targets, out_of_scope: scope.out_of_scope, authorization: scope.authorization || undefined } } : {}),
      flags
    });
  };
  return disclosed;
}

export async function recoverPromotions(options) { return createNoteTool(options).recoverPromotions(); }
