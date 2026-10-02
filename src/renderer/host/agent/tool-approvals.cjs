'use strict';
const { randomUUID } = require('node:crypto');

function createToolApprovals({ onChange = () => {}, maxPending = 128, maxArgumentChars = 65536 } = {}) {
  for (const value of [maxPending, maxArgumentChars]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid approval limit');
  }
  let disposed = false;
  let pending = 0, preparing = 0;
  const entries = new Map();
  const notify = () => { try { Promise.resolve(onChange()).catch(() => {}); } catch {} };
  async function request(details) {
    if (disposed) return false;
    const { signal, conversationId, workerId, toolCallId, toolName } = details;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid approval signal');
    if (signal?.aborted) return false;
    for (const value of [conversationId, workerId, toolCallId, toolName]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 1024)) throw new TypeError('Invalid approval identity');
    }
    if (pending + preparing >= maxPending) throw Object.assign(new Error('Too many pending tool approvals'), { code: 'APPROVAL_BUSY' });
    let args;
    preparing++;
    try {
      args = JSON.stringify(details.args ?? {}, null, 2);
      if (typeof args !== 'string' || args.length > maxArgumentChars) {
        throw Object.assign(new Error('Tool approval arguments exceed the display limit'), { code: 'APPROVAL_TOO_LARGE' });
      }
    } finally { preparing--; }
    // Serialization can invoke getters/toJSON that cancel, dispose or reenter.
    if (disposed || signal?.aborted) return false;
    const id = randomUUID();
    const record = { id, conversationId, workerId, toolCallId, toolName, args, status: 'pending' };
    return new Promise(resolve => {
      const cancel = () => finish('cancelled');
      const finish = status => {
        if (record.status !== 'pending') return;
        record.status = disposed || signal?.aborted ? 'cancelled' : status;
        pending--;
        signal?.removeEventListener('abort', cancel);
        entries.get(id).finish = undefined;
        resolve(record.status === 'approved');
        // Bound completed UI records without evicting unresolved approvals.
        const completed = [...entries].filter(([, entry]) => entry.record.status !== 'pending');
        for (const [key] of completed.slice(0, Math.max(0, completed.length - 100))) entries.delete(key);
        notify();
      };
      entries.set(id, { record, finish });
      pending++;
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else notify();
    });
  }
  return {
    request,
    snapshot(conversationId) { return [...entries.values()].filter(entry => entry.record.conversationId === conversationId).map(entry => ({ ...entry.record })); },
    respond({ id, conversationId, decision }) {
      const entry = entries.get(id);
      if (disposed || !entry?.finish || entry.record.conversationId !== conversationId || !['approve', 'deny'].includes(decision)) return false;
      entry.finish(decision === 'approve' ? 'approved' : 'denied');
      return true;
    },
    dispose() { disposed = true; for (const entry of [...entries.values()]) entry.finish?.('cancelled'); entries.clear(); }
  };
}
module.exports = { createToolApprovals };
