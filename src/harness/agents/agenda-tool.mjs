import { Type } from 'typebox';
import { EXPLORATION_AGENDA_OWNER, renderAgenda } from '../blackboard/agenda.mjs';

const ACTIONS = new Set(['list', 'write', 'update']);
const STATUSES = ['planned', 'active', 'done', 'dropped'];
const LIMITS = { content: 500, dedupe: 512, method: 500, acceptance: 500, items: 20 };

const clip = (value, max, name) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const text = value.trim();
  if (text.length > max) throw new RangeError(`${name} must contain at most ${max} characters`);
  return text;
};
const status = value => {
  if (value === undefined) return 'planned';
  const normalized = String(value).trim().toLowerCase();
  if (!STATUSES.includes(normalized)) throw new Error(`Agenda status must be one of ${STATUSES.join(', ')}`);
  return normalized;
};
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

/**
 * Reason-only shared agenda tool. Intent status and Worker plan steps are fully
 * projected by the host; this tool only owns Reason's direction items so the
 * shared board never becomes a second, stale source of execution state.
 */
export function createAgendaTool({ store, build, sessionId } = {}) {
  if (!store || typeof store.commit !== 'function' || typeof store.snapshot !== 'function') throw new TypeError('createAgendaTool requires a MemoryStore');
  if (typeof build !== 'function') throw new TypeError('createAgendaTool requires an agenda builder');
  const tool = {
    name: 'exploration_todo', label: 'Shared exploration agenda',
    description: 'Read and update the shared exploration agenda for this goal. The host already projects every intent (planned/active/blocked/done/dropped), Worker plan steps and failed/gap suggestions into the agenda; use this tool to read it and to record your own exploration directions (content, dedupe_key, method, acceptance) so Workers and later reviews do not repeat the same content. write replaces your direction list atomically; update changes one direction by id. Never restate projected intent status here.',
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 16, description: 'list | write | update' }),
      items: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String({ maxLength: 80 })),
        content: Type.String({ minLength: 1, maxLength: LIMITS.content }),
        status: Type.Optional(Type.String({ maxLength: 16 })),
        dedupe_key: Type.Optional(Type.String({ maxLength: LIMITS.dedupe })),
        method: Type.Optional(Type.String({ maxLength: LIMITS.method })),
        acceptance: Type.Optional(Type.String({ maxLength: LIMITS.acceptance }))
      }, { additionalProperties: false }), { maxItems: LIMITS.items })),
      direction_id: Type.Optional(Type.String({ maxLength: 80 })),
      content: Type.Optional(Type.String({ maxLength: LIMITS.content })),
      status: Type.Optional(Type.String({ maxLength: 16 })),
      dedupe_key: Type.Optional(Type.String({ maxLength: LIMITS.dedupe })),
      method: Type.Optional(Type.String({ maxLength: LIMITS.method })),
      acceptance: Type.Optional(Type.String({ maxLength: LIMITS.acceptance }))
    }, { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('exploration_todo arguments must be an object');
      for (const key of Object.keys(input)) if (!['action', 'items', 'direction_id', 'content', 'status', 'dedupe_key', 'method', 'acceptance'].includes(key)) throw new Error(`Unknown exploration_todo field: ${key}`);
      const action = String(input.action ?? '').trim().toLowerCase();
      if (!ACTIONS.has(action)) throw new Error(`Unknown exploration_todo action: ${action || '(empty)'}; use list, write or update`);
      const summarize = () => {
        const agenda = build();
        return {
          counts: agenda.counts,
          open: agenda.open.map(item => ({
            id: item.id, kind: item.kind, status: item.status,
            ...(item.ref ? { ref: item.ref } : {}),
            title: item.title,
            ...(item.dedupeKey ? { dedupe_key: item.dedupeKey } : {}),
            ...(item.method ? { method: item.method } : {}),
            ...(item.acceptance ? { acceptance: item.acceptance } : {}),
            ...(item.currentStep ? { current_step: item.currentStep } : {}),
            ...(item.blocker ? { blocker: item.blocker } : {}),
            ...(item.evidenceRef ? { evidence: item.evidenceRef } : {})
          })),
          recent_done: agenda.items.filter(item => item.status === 'done').slice(-6).map(item => ({ id: item.id, ...(item.ref ? { ref: item.ref } : {}), title: item.title, ...(item.evidenceRef ? { evidence: item.evidenceRef } : {}) })),
          directions: (store.snapshot(['agenda']).agenda ?? []).filter(entry => entry.worker_id === EXPLORATION_AGENDA_OWNER)
        };
      };
      if (action === 'list') {
        await store.flush();
        const snapshot = summarize();
        return result({ ...snapshot, text: renderAgenda(build(), { maxOpen: 30, maxDone: 8 }) });
      }
      const now = new Date().toISOString();
      if (action === 'write') {
        if (!Array.isArray(input.items) || !input.items.length || input.items.length > LIMITS.items) throw new Error(`exploration_todo write requires 1 to ${LIMITS.items} items`);
        const seen = new Set();
        const items = input.items.map((entry, index) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`items[${index}] must be an object`);
          const content = clip(entry.content, LIMITS.content, `items[${index}].content`);
          if (!content) throw new TypeError(`items[${index}].content must be nonempty`);
          const dedupe = clip(entry.dedupe_key, LIMITS.dedupe, `items[${index}].dedupe_key`);
          const supplied = typeof entry.id === 'string' ? entry.id.trim() : '';
          const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(supplied) ? supplied : `agenda-${String(supplied).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72) || cryptoId(index)}`;
          if (seen.has(id)) throw new Error(`Duplicate agenda direction id: ${id}`);
          seen.add(id);
          return {
            id, worker_id: EXPLORATION_AGENDA_OWNER, content, status: status(entry.status),
            ...(dedupe ? { dedupe_key: dedupe } : {}),
            ...(clip(entry.method, LIMITS.method, `items[${index}].method`) ? { method: clip(entry.method, LIMITS.method, `items[${index}].method`) } : {}),
            ...(clip(entry.acceptance, LIMITS.acceptance, `items[${index}].acceptance`) ? { acceptance: clip(entry.acceptance, LIMITS.acceptance, `items[${index}].acceptance`) } : {}),
            created_at: now, updated_at: now
          };
        });
        await store.commit(state => {
          const previous = new Map((state.agenda ?? []).filter(entry => entry.worker_id === EXPLORATION_AGENDA_OWNER).map(entry => [entry.id, entry]));
          state.agenda = [
            ...(state.agenda ?? []).filter(entry => entry.worker_id !== EXPLORATION_AGENDA_OWNER),
            ...items.map(item => ({ ...item, created_at: previous.get(item.id)?.created_at ?? now }))
          ];
        });
        return result(summarize());
      }
      const id = String(input.direction_id ?? '').trim();
      if (!id) throw new Error('exploration_todo update requires direction_id');
      const updated = await store.commit(state => {
        const item = (state.agenda ?? []).find(entry => entry.worker_id === EXPLORATION_AGENDA_OWNER && entry.id === id);
        if (!item) throw new Error(`Agenda direction ${id} was not found; use action=list to read current directions`);
        if (input.content !== undefined) item.content = clip(input.content, LIMITS.content, 'content');
        if (input.status !== undefined) item.status = status(input.status);
        if (input.dedupe_key !== undefined) item.dedupe_key = clip(input.dedupe_key, LIMITS.dedupe, 'dedupe_key');
        if (input.method !== undefined) item.method = clip(input.method, LIMITS.method, 'method');
        if (input.acceptance !== undefined) item.acceptance = clip(input.acceptance, LIMITS.acceptance, 'acceptance');
        item.updated_at = now;
        return item;
      });
      return result({ updated, ...summarize() });
    }
  };
  return tool;
}

function cryptoId(index) {
  return `direction-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}
