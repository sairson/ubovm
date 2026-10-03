import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { assertSession, checkAbort, required, toolResult } from '../shared/store/memory-store.mjs';
import { withActionHelp, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { TODO_CATALOG } from '../shared/tool-catalogs.mjs';

const statuses = ['pending', 'in_progress', 'completed'];
const text = value => Array.from(required(value, 'content')).slice(0, 500).join('');
function status(value = '') {
  value = value.trim().toLowerCase();
  if (!value) return 'pending';
  if (['done', 'complete'].includes(value)) return 'completed';
  if (!statuses.includes(value)) throw new Error('Unknown todo status; use pending, in_progress, or completed');
  return value;
}
function list(items, workerId, filter = '') {
  const counts = () => ({ pending: 0, in_progress: 0, completed: 0 });
  const session_counts = counts(), your_counts = counts();
  const filtered = items.filter(item => !filter || item.status === filter).map(item => {
    session_counts[item.status]++;
    if (item.worker_id === workerId) your_counts[item.status]++;
    return { id: item.id, worker_id: item.worker_id, status: item.status, content: item.content, updated_at: item.updated_at, owner: String(item.worker_id === workerId) };
  });
  return { session_counts, your_counts, items: filtered };
}

export function createTodoTool({ store, sessionId, workerId = 'worker' } = {}) {
  assertSession(store, sessionId); workerId = required(workerId, 'workerId');
  const tool = {
    name: 'todo', label: 'Session todo board',
    description: TODO_CATALOG.description,
    parameters: Type.Object(withActionHelp({
      items: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.String()), content: Type.String(), status: Type.Optional(Type.String()) }, { additionalProperties: false }), { maxItems: 100 })),
      todo_id: Type.Optional(Type.String()), content: Type.Optional(Type.String()), status: Type.Optional(Type.String())
    }), { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      checkAbort(signal);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('todo arguments must be an object');
      for (const key of Object.keys(input)) if (!['action', 'items', 'todo_id', 'content', 'status'].includes(key)) throw new Error(`Unknown todo field: ${key}`);
      const action = required(input.action, 'action').toLowerCase();
      if (action === 'list') { await store.flush(); checkAbort(signal); return toolResult(list(store.snapshot(['todos']).todos, workerId, input.status ? status(input.status) : '')); }
      const result = await store.commit(state => {
        checkAbort(signal);
        const now = new Date().toISOString();
        if (action === 'write') {
          if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new Error('todo write requires 1 to 100 items');
          const previous = state.todos.filter(item => item.worker_id === workerId && !item.id.startsWith('plan-'));
          const seen = new Set();
          const items = input.items.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Todo item must be an object');
            for (const key of Object.keys(entry)) if (!['id', 'content', 'status'].includes(key)) throw new Error(`Unknown todo item field: ${key}`);
            const old = previous.find(item => item.id === entry.id);
            const id = old && !seen.has(old.id) ? old.id : `todo-${randomUUID()}`;
            seen.add(id);
            const item = { id, worker_id: workerId, content: text(entry.content), status: status(entry.status), created_at: old?.created_at ?? now, updated_at: now };
            if (old && old.status === item.status && old.content === item.content) item.updated_at = old.updated_at;
            return item;
          });
          state.todos = [...state.todos.filter(item => item.worker_id !== workerId || item.id.startsWith('plan-')), ...items];
        } else if (action === 'update') {
          const id = required(input.todo_id, 'todo_id');
          // plan IDs may repeat across workers: always resolve your own item first.
          const item = state.todos.find(item => item.id === id && item.worker_id === workerId);
          if (!item) throw new Error(state.todos.some(item => item.id === id) ? `${id} belongs to another agent` : `Todo ${id} was not found`);
          if (id.startsWith('plan-')) return { status: 'ignored', todo_id: id, managed_by: 'host', message: 'The host synchronizes this plan item. Continue without retrying.' };
          if (input.content?.trim()) item.content = text(input.content);
          if (input.status?.trim()) item.status = status(input.status);
          item.updated_at = now;
        } else if (action === 'clear_completed') {
          const oldLength = state.todos.length;
          state.todos = state.todos.filter(item => item.worker_id !== workerId || item.status !== 'completed' || item.id.startsWith('plan-'));
          return { status: 'cleared', removed: oldLength - state.todos.length };
        } else throw new Error(`Unknown todo action: ${action}`);
        return list(state.todos, workerId);
      });
      return toolResult(result);
    },
    async syncPlan(owner, items) {
      owner = required(owner || 'worker', 'workerId');
      if (!Array.isArray(items)) throw new TypeError('Plan items must be an array');
      return store.commit(state => {
        const previous = state.todos.filter(item => item.worker_id === owner && item.id.startsWith('plan-'));
        const seen = new Set(); const now = new Date().toISOString();
        const projected = items.flatMap((entry, index) => {
          if (typeof entry.content !== 'string' || !entry.content.trim()) return [];
          const base = `plan-${String(entry.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || `step-${index + 1}`}`;
          let id = base; let suffix = 0;
          while (seen.has(id)) id = `${base}-${++suffix}`;
          seen.add(id);
          let normalized; try { normalized = status(entry.status); } catch { normalized = 'pending'; }
          const content = text(entry.content); const old = previous.find(item => item.id === id);
          return [{ id, worker_id: owner, content, status: normalized, created_at: old?.created_at ?? now, updated_at: old?.content === content && old?.status === normalized ? old.updated_at : now }];
        });
        state.todos = [...state.todos.filter(item => item.worker_id !== owner || !item.id.startsWith('plan-')), ...projected];
      });
    },
    summary(owner = workerId) {
      const items = store.snapshot(['todos']).todos;
      if (!items.length) return '';
      const line = item => `- [${item.status}] (${item.worker_id === owner ? 'you' : item.worker_id}) ${item.content} #${item.id}`;
      const active = items.filter(item => item.status !== 'completed').slice(0, 40).map(line);
      const done = items.filter(item => item.status === 'completed').slice(-8).map(line);
      return ['# Session Todo Board', 'Shared progress memory refreshed at each model boundary. plan- items are host-managed. Reuse completed work and coordinate with other owners.', ...active, ...(done.length ? ['Recently completed:', ...done] : [])].join('\n');
    }
  };
  tool.promptSummary = tool.summary;
  return withProgressiveDisclosure(tool, TODO_CATALOG);
}
