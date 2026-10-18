'use strict';
const { randomUUID } = require('node:crypto');

const LIMITS = Object.freeze({ maxQuestion: 2000, maxOptions: 8, maxLabel: 120, maxDescription: 400, maxCustom: 4000 });

const cancelledAnswer = () => ({ selected: [], custom: '', cancelled: true });

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`Invalid question ${name}`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new TypeError(`Question ${name} exceeds the display limit`);
  return trimmed;
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || !options.length || options.length > LIMITS.maxOptions) throw new TypeError('Invalid question options');
  const seen = new Set();
  return options.map(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new TypeError('Invalid question option');
    const label = text(option.label, 'option label', LIMITS.maxLabel);
    if (seen.has(label)) throw new TypeError('Duplicated question option label');
    seen.add(label);
    const description = option.description === undefined || option.description === null || option.description === ''
      ? undefined : text(option.description, 'option description', LIMITS.maxDescription);
    return { label, ...(description === undefined ? {} : { description }) };
  });
}

/**
 * Host-owned queue of pending questions asked by the agent. Mirrors the tool
 * approval service: a request resolves with the human's selection, a custom
 * answer, or a cancellation, and never trusts the UI beyond the offered labels.
 */
function createHumanQuestions({ onChange = () => {}, maxPending = 64 } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('Invalid question limit');
  let disposed = false;
  let pending = 0, preparing = 0;
  const entries = new Map();
  const notify = () => { try { Promise.resolve(onChange()).catch(() => {}); } catch {} };
  async function request(details) {
    if (disposed) return cancelledAnswer();
    const { signal, conversationId, workerId, toolCallId } = details ?? {};
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid question signal');
    if (signal?.aborted) return cancelledAnswer();
    for (const value of [conversationId, workerId, toolCallId]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 1024)) throw new TypeError('Invalid question identity');
    }
    if (pending + preparing >= maxPending) throw Object.assign(new Error('Too many pending questions'), { code: 'QUESTION_BUSY' });
    let question, options;
    preparing++;
    try {
      question = text(details?.question, 'text', LIMITS.maxQuestion);
      options = normalizeOptions(details?.options);
    } finally { preparing--; }
    // Validation can reenter through getters; re-check after it settles.
    if (disposed || signal?.aborted) return cancelledAnswer();
    const id = randomUUID();
    const record = {
      id, conversationId, workerId, toolCallId, question, options,
      multiple: details?.multiple === true,
      allowCustom: details?.allowCustom !== false,
      status: 'pending', createdAt: new Date().toISOString()
    };
    return new Promise(resolve => {
      const cancel = () => finish('cancelled', cancelledAnswer());
      const finish = (status, answer) => {
        if (record.status !== 'pending') return;
        record.status = disposed || signal?.aborted ? 'cancelled' : status;
        record.answer = answer;
        pending--;
        signal?.removeEventListener('abort', cancel);
        entries.get(id).finish = undefined;
        resolve(record.status === 'cancelled' ? cancelledAnswer() : answer);
        // Bound completed UI records without evicting unresolved questions.
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
    snapshot(conversationId) {
      return [...entries.values()].filter(entry => entry.record.conversationId === conversationId)
        .map(entry => ({
          ...entry.record,
          options: entry.record.options.map(option => ({ ...option })),
          ...(entry.record.answer ? { answer: { ...entry.record.answer, selected: [...entry.record.answer.selected] } } : {})
        }));
    },
    respond({ id, conversationId, selected, custom, cancelled } = {}) {
      const entry = entries.get(id);
      if (disposed || !entry?.finish || entry.record.conversationId !== conversationId) return false;
      if (cancelled === true) { entry.finish('cancelled', cancelledAnswer()); return true; }
      const offered = new Set(entry.record.options.map(option => option.label));
      const chosen = Array.isArray(selected) ? [...new Set(selected.filter(label => typeof label === 'string' && offered.has(label)))] : [];
      const note = typeof custom === 'string' ? custom.trim().slice(0, LIMITS.maxCustom) : '';
      const picked = entry.record.multiple ? chosen : chosen.slice(0, 1);
      if (!picked.length && !note) return false;
      entry.finish('answered', { selected: picked, custom: note, cancelled: false });
      return true;
    },
    dispose() { disposed = true; for (const entry of [...entries.values()]) entry.finish?.('cancelled', cancelledAnswer()); entries.clear(); }
  };
}
module.exports = { createHumanQuestions, HUMAN_QUESTION_LIMITS: LIMITS };
