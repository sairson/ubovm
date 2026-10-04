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
  function validateFull(message) {
    if (!object(message.conversation) || message.mode !== undefined && !['assist', 'goal'].includes(message.mode)) throw new TypeError('Invalid conversation state');
    if (message.conversation.title !== undefined && typeof message.conversation.title !== 'string') throw new TypeError('Invalid conversation title');
    for (const key of ['messages', 'relatedConversations', 'conversationIds', 'toolApprovals', 'inputQueue', 'assistEvidence']) {
      if (message[key] !== undefined && !Array.isArray(message[key])) throw new TypeError('Invalid state ' + key);
    }
    for (const key of ['context', 'goal', 'provider', 'ssh']) {
      if (message[key] !== undefined && message[key] !== null && !object(message[key])) throw new TypeError('Invalid state ' + key);
    }
    validateExecution(message.execution);
  }
  function createStateOrder() {
    let fullRevision = 0, executionRevision = 0;
    const revision = message => Number.isSafeInteger(message.viewRevision) && message.viewRevision > 0 ? message.viewRevision : 0;
    return {
      checkpoint() { return { fullRevision, executionRevision }; },
      restore(checkpoint) { fullRevision = checkpoint.fullRevision; executionRevision = checkpoint.executionRevision; },
      execution(message, current) {
        if (!current || message.conversationId !== current.conversation?.id) return null;
        const next = revision(message);
        if (next ? next <= executionRevision : executionRevision > 0) return null;
        validateExecution(message.execution);
        executionRevision = next;
        const nextState = { ...current, execution: message.execution, busy: message.busy };
        if (typeof message.recovering === 'boolean') nextState.recovering = message.recovering;
        return nextState;
      },
      full(message, current) {
        if (typeof message.conversation?.id !== 'string' || !message.conversation.id) return null;
        const next = revision(message);
        if (next ? next <= fullRevision : fullRevision > 0) return null;
        validateFull(message);
        fullRevision = next;
        // Full state also carries history, approvals and context. Retain these
        // updates even if a newer execution delta arrived first.
        if (current?.conversation?.id === message.conversation.id && next < executionRevision) {
          return { ...message, execution: current.execution, busy: current.busy };
        }
        executionRevision = next;
        return message;
      }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createStateOrder };
  else window.createStateOrder = createStateOrder;
})();
