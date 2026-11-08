(() => {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function validateTeam(team) {
    if (team === undefined || team === null) return;
    if (!object(team)) throw new TypeError('Invalid execution team');
    for (const key of ['roster', 'tasks']) {
      if (team[key] !== undefined && !Array.isArray(team[key])) throw new TypeError('Invalid execution team.' + key);
    }
  }
  function validateTeamWatch(watch) {
    if (watch === undefined || watch === null) return;
    if (!object(watch)) throw new TypeError('Invalid execution teamWatch');
    for (const key of ['history', 'live']) {
      if (watch[key] !== undefined && !object(watch[key])) throw new TypeError('Invalid execution teamWatch.' + key);
    }
    if (object(watch.history) && watch.history.entries !== undefined && !Array.isArray(watch.history.entries)) throw new TypeError('Invalid execution teamWatch.history.entries');
    if (object(watch.live) && watch.live.parts !== undefined && !Array.isArray(watch.live.parts)) throw new TypeError('Invalid execution teamWatch.live.parts');
  }
  function validateExecution(execution) {
    if (execution === undefined || execution === null) return;
    if (!object(execution)) throw new TypeError('Invalid execution state');
    for (const key of ['parts', 'workers', 'activities']) {
      if (execution[key] !== undefined && !Array.isArray(execution[key])) throw new TypeError('Invalid execution ' + key);
    }
    validateTeam(execution.team);
    validateTeamWatch(execution.teamWatch);
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
    if (next.team !== undefined) {
      if (!object(next.team)) { console.warn('[UBOVM] Dropping invalid execution.team payload.'); delete next.team; }
      else {
        const team = { ...next.team };
        for (const key of ['roster', 'tasks']) {
          if (team[key] !== undefined && !Array.isArray(team[key])) {
            console.warn('[UBOVM] Dropping invalid execution.team.' + key + ' payload.');
            team[key] = [];
          }
        }
        next.team = team;
      }
    }
    if (next.teamWatch !== undefined) {
      if (!object(next.teamWatch)) { console.warn('[UBOVM] Dropping invalid execution.teamWatch payload.'); delete next.teamWatch; }
      else {
        const watch = { ...next.teamWatch };
        for (const key of ['history', 'live']) {
          if (watch[key] !== undefined && !object(watch[key])) {
            console.warn('[UBOVM] Dropping invalid execution.teamWatch.' + key + ' payload.');
            delete watch[key];
          }
        }
        if (object(watch.history) && watch.history.entries !== undefined && !Array.isArray(watch.history.entries)) {
          console.warn('[UBOVM] Dropping invalid execution.teamWatch.history.entries payload.');
          watch.history = { ...watch.history, entries: [] };
        }
        if (object(watch.live) && watch.live.parts !== undefined && !Array.isArray(watch.live.parts)) {
          console.warn('[UBOVM] Dropping invalid execution.teamWatch.live.parts payload.');
          watch.live = { ...watch.live, parts: [] };
        }
        next.teamWatch = watch;
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
    let fullRevision = 0, executionRevision = 0, executionSequence = 0, versioned = false;
    const revision = message => Number.isSafeInteger(message.viewRevision) && message.viewRevision > 0 ? message.viewRevision : 0;
    return {
      checkpoint() { return { fullRevision, executionRevision, executionSequence, versioned }; },
      restore(checkpoint) {
        fullRevision = checkpoint.fullRevision; executionRevision = checkpoint.executionRevision;
        executionSequence = checkpoint.executionSequence ?? 0;
        if (typeof checkpoint.versioned === 'boolean') versioned = checkpoint.versioned;
      },
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
        const normalized = normalizeExecution(message.execution);
        validateExecution(normalized);
        // Heavy projections (board/graph/agenda/memory/log history) are omitted
        // from most live ticks: the host deletes each unchanged projection
        // independently, so a tick that changes only ONE revision can carry e.g.
        // a new board while omitting unchanged memory (or the reverse). Absence
        // means "unchanged", never "empty": keep the last projection for this
        // conversation instead of blanking the board/summary/domain ledger for
        // one frame (the visible "header jumps / card flickers" symptom). A
        // genuinely empty projection is sent as an explicit empty value.
        const preserved = normalized && object(current.execution) ? { ...current.execution } : undefined;
        const execution = message.partialExecution === true && preserved
          ? { ...preserved, ...normalized }
          : normalized;
        if (preserved) {
          for (const key of ['blackboard', 'graph', 'agenda', 'memory', 'logHistory']) {
            if (key in execution || !(key in preserved)) continue;
            execution[key] = preserved[key];
          }
        }
        if (next) executionRevision = next;
        if (sequence) executionSequence = sequence;
        const nextState = { ...current, execution, busy: message.busy };
        if (typeof message.recovering === 'boolean') nextState.recovering = message.recovering;
        return nextState;
      },
      full(message, current) {
        if (typeof message.conversation?.id !== 'string' || !message.conversation.id) return null;
        const next = revision(message);
        // Legacy host messages carry no revision and therefore no ordering
        // information. Apply them until the host proves it sends versioned
        // snapshots; after that a legacy snapshot cannot override versioned
        // state and is dropped. This keeps old fixtures/queued messages
        // working without weakening the watermark for the real host path.
        if (next ? next <= fullRevision : versioned) return null;
        let normalized;
        try {
          normalized = normalizeFull(message);
          validateFull(normalized);
        } catch (error) {
          if (next) { versioned = true; fullRevision = next; } else fullRevision += 1;
          console.warn('[UBOVM] Dropping unrecoverable full state payload.', error);
          return current || null;
        }
        if (next) { versioned = true; fullRevision = next; }
        // Full state also carries history, approvals and context. Retain these
        // updates even if a newer execution delta arrived first.
        if (current?.conversation?.id === normalized.conversation.id && next && next < executionRevision) {
          return { ...normalized, execution: current.execution, busy: current.busy };
        }
        // A session update (for example deleting a note) can publish a full
        // state whose execution snapshot no longer carries memory, even though
        // the last execution tick did. Keep the notebook's Agent records
        // instead of letting the full snapshot wipe them.
        if (current?.conversation?.id === normalized.conversation.id
          && normalized.execution && !('memory' in normalized.execution)
          && current.execution && 'memory' in current.execution) {
          normalized.execution = { ...normalized.execution, memory: current.execution.memory };
        }
        // A full session snapshot may be published from a light execution
        // projection that omits heavy fields. Treat omitted board/graph/agenda
        // like memory: keep the last complete projection instead of blanking the
        // blackboard for one frame (the visible "nodes blink" symptom).
        if (current?.conversation?.id === normalized.conversation.id && normalized.execution && current.execution) {
          const preserved = ['blackboard', 'graph', 'agenda', 'logHistory', 'parts', 'workers', 'activities',
            'result', 'error', 'streamText', 'phase', 'usage', 'contextUsage', 'team', 'teamWatch', 'workerViewError'];
          const merged = {};
          const statusChanged = normalized.execution.status !== current.execution.status;
          for (const key of preserved) {
            if (key in normalized.execution || !(key in current.execution)) continue;
            // A stale execution payload describes the previous run. Once the
            // status changes, its error and team projection must not keep the
            // failure surface or the Team popover alive.
            if (statusChanged && ['error', 'team', 'teamWatch', 'workerViewError'].includes(key)) continue;
            merged[key] = current.execution[key];
          }
          if (Object.keys(merged).length) normalized.execution = { ...normalized.execution, ...merged };
        }
        if (next) executionRevision = next;
        return normalized;
      }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createStateOrder };
  else window.createStateOrder = createStateOrder;
})();
