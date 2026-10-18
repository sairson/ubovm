(() => {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function validateExecution(execution) {
    if (execution === undefined || execution === null) return;
    if (!object(execution)) throw new TypeError('Invalid execution state');
    for (const key of ['parts', 'workers', 'activities']) {
      if (execution[key] !== undefined && !Array.isArray(execution[key])) throw new TypeError('Invalid execution ' + key);
    }
  }
  function normalizeExecution(execution) {
    if (execution === undefined || execution === null) return execution;
    if (!object(execution)) { console.warn('[UBOVM] Dropping invalid execution payload; using an empty state.'); return {}; }
    const next = { ...execution };
    for (const key of ['parts', 'workers', 'activities']) {
      if (next[key] !== undefined && !Array.isArray(next[key])) {
        console.warn('[UBOVM] Dropping invalid execution.' + key + ' payload.');
        next[key] = [];
      }
    }
    return next;
  }
  function normalizeFull(message) {
    const next = { ...message, conversation: { ...message.conversation } };
    if (typeof next.conversation.title !== 'string' && next.conversation.title !== undefined) {
      console.warn('[UBOVM] Dropping invalid conversation title.'); delete next.conversation.title;
    }
    for (const key of ['messages', 'relatedConversations', 'conversationIds', 'toolApprovals', 'humanQuestions', 'inputQueue', 'assistEvidence']) {
      if (next[key] !== undefined && !Array.isArray(next[key])) {
        console.warn('[UBOVM] Dropping invalid state.' + key + ' payload.');
        delete next[key];
      }
    }
    for (const key of ['context', 'goal', 'provider', 'ssh']) {
      if (next[key] !== undefined && next[key] !== null && !object(next[key])) {
        console.warn('[UBOVM] Dropping invalid state.' + key + ' payload.');
        delete next[key];
      }
    }
    next.execution = normalizeExecution(next.execution);
    return next;
  }
  function validateFull(message) {
    if (!object(message.conversation) || message.mode !== undefined && !['assist', 'goal'].includes(message.mode)) throw new TypeError('Invalid conversation state');
    if (message.conversation.title !== undefined && typeof message.conversation.title !== 'string') throw new TypeError('Invalid conversation title');
    for (const key of ['messages', 'relatedConversations', 'conversationIds', 'toolApprovals', 'humanQuestions', 'inputQueue', 'assistEvidence']) {
      if (message[key] !== undefined && !Array.isArray(message[key])) throw new TypeError('Invalid state ' + key);
    }
    for (const key of ['context', 'goal', 'provider', 'ssh']) {
      if (message[key] !== undefined && message[key] !== null && !object(message[key])) throw new TypeError('Invalid state ' + key);
    }
    validateExecution(message.execution);
  }
  function createStateOrder() {
    let fullRevision = 0, executionRevision = 0, executionSequence = 0;
    const revision = message => Number.isSafeInteger(message.viewRevision) && message.viewRevision > 0 ? message.viewRevision : 0;
    return {
      checkpoint() { return { fullRevision, executionRevision, executionSequence }; },
      restore(checkpoint) { fullRevision = checkpoint.fullRevision; executionRevision = checkpoint.executionRevision; executionSequence = checkpoint.executionSequence ?? 0; },
      discard(message) {
        if (!message || typeof message !== 'object') return;
        const next = revision(message);
        if (message.type === 'executionState') {
          if (next) executionRevision = Math.max(executionRevision, next);
          else if (Number.isSafeInteger(message.seq) && message.seq > 0) executionSequence = Math.max(executionSequence, message.seq);
          else executionSequence++;
          console.warn('[UBOVM] Dropping an execution update after a render failure.');
        } else if (message.type === 'state') {
          fullRevision = next ? Math.max(fullRevision, next) : fullRevision + 1;
          console.warn('[UBOVM] Dropping a full state after a render failure.');
        }
      },
      execution(message, current) {
        if (!current || message.conversationId !== current.conversation?.id) return null;
        const next = revision(message);
        const sequence = Number.isSafeInteger(message.seq) && message.seq > 0 ? message.seq : 0;
        if (next ? next <= executionRevision : sequence && sequence <= executionSequence) {
          console.warn('[UBOVM] Dropping stale execution update.', { viewRevision: next, seq: sequence });
          return null;
        }
        const execution = normalizeExecution(message.execution);
        validateExecution(execution);
        if (next) executionRevision = next;
        if (sequence) executionSequence = sequence;
        const nextState = { ...current, execution, busy: message.busy };
        if (typeof message.recovering === 'boolean') nextState.recovering = message.recovering;
        return nextState;
      },
      full(message, current) {
        if (typeof message.conversation?.id !== 'string' || !message.conversation.id) return null;
        const next = revision(message);
        if (next ? next <= fullRevision : fullRevision > 0) return null;
        let normalized;
        try {
          normalized = normalizeFull(message);
          validateFull(normalized);
        } catch (error) {
          fullRevision = next || fullRevision + 1;
          console.warn('[UBOVM] Dropping unrecoverable full state payload.', error);
          return current || null;
        }
        fullRevision = next || fullRevision + 1;
        // Full state also carries history, approvals and context. Retain these
        // updates even if a newer execution delta arrived first.
        if (current?.conversation?.id === normalized.conversation.id && next && next < executionRevision) {
          return { ...normalized, execution: current.execution, busy: current.busy };
        }
        if (next) executionRevision = next;
        return normalized;
      }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createStateOrder };
  else window.createStateOrder = createStateOrder;
})();
