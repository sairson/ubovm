'use strict';
const { randomUUID } = require('node:crypto');

function createToolApprovals({ onChange = () => {} } = {}) {
  let disposed = false;
  const entries = new Map();
  const notify = () => { try { onChange(); } catch {} };
  function request(details) {
    if (disposed || details.signal?.aborted) return Promise.resolve(false);
    const id = randomUUID();
    const record = { id, conversationId: details.conversationId, workerId: details.workerId,
      toolCallId: details.toolCallId, toolName: details.toolName,
      args: JSON.stringify(details.args ?? {}, null, 2), status: 'pending' };
    return new Promise(resolve => {
      const cancel = () => finish('cancelled');
      const finish = status => {
        if (record.status !== 'pending') return;
        record.status = disposed || details.signal?.aborted ? 'cancelled' : status;
        details.signal?.removeEventListener('abort', cancel);
        entries.get(id).finish = undefined;
        resolve(record.status === 'approved');
        // Bound completed UI records without evicting unresolved approvals.
        const completed = [...entries].filter(([, entry]) => entry.record.status !== 'pending');
        for (const [key] of completed.slice(0, Math.max(0, completed.length - 100))) entries.delete(key);
        notify();
      };
      entries.set(id, { record, finish });
      details.signal?.addEventListener('abort', cancel, { once: true });
      if (details.signal?.aborted) cancel(); else notify();
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
