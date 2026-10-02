'use strict';

/** Coalesce streamed execution updates without retaining full conversation snapshots. */
function createExecutionPublisher({ currentId, canPublish, readExecution, postMessage, onError = () => {}, delay = 75 }) {
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647) throw new TypeError('Invalid publication delay');
  for (const callback of [currentId, canPublish, readExecution, postMessage, onError]) {
    if (typeof callback !== 'function') throw new TypeError('Invalid publication callback');
  }
  let timer, pending = false, sending, disposed = false, fullState;
  let revision = 0;
  let publicationDelay = delay;
  let retries = 0;
  let transports = new Set();
  const maxTransports = 4;
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Reporting cannot break publication. */ }
  };

  function clear({ resetTransport = false } = {}) {
    ++revision;
    clearTimeout(timer);
    timer = undefined;
    pending = false;
    fullState = undefined;
    publicationDelay = delay;
    retries = 0;
    // The old bridge may never acknowledge disposal. Its completion must not
    // hold or reset the publication slot belonging to the next view.
    sending = undefined;
    // Hiding the same view does not cancel physical sends. Only a replaced
    // bridge gets fresh capacity; visibility churn must retain the hard bound.
    if (resetTransport) transports = new Set();
  }

  function schedule(id, retry = false) {
    try {
      if (disposed || id !== currentId() || !canPublish()) return;
      if (!retry) retries = 0;
      pending = true;
      if (!timer && !sending && transports.size < maxTransports) timer = setTimeout(flush, retry ? Math.max(publicationDelay, 250 * 2 ** (retries - 1)) : publicationDelay);
    } catch (error) { report(error); }
  }

  function flush() {
    timer = undefined;
    if (disposed || !pending) return;
    if (transports.size >= maxTransports) return;
    pending = false;
    const publicationRevision = revision;
    const ticket = sending = {};
    let retry = false, timeout, attempted = false;
    // Read at publication time so rapid updates always collapse to the latest
    // state. Only one post may be in flight on a slow extension-host bridge.
    Promise.resolve().then(() => {
      if (disposed || publicationRevision !== revision || !canPublish()) return;
      const conversationId = currentId();
      const execution = readExecution();
      const full = fullState?.conversation?.id === conversationId ? fullState : undefined;
      // Large active timelines need fewer full IPC copies. Keep only the latest
      // pending state, with a bounded delay; never truncate persisted history.
      const records = (execution.parts?.length || 0) + (execution.activities?.length || 0) + (execution.workers?.length || 0);
      publicationDelay = execution.busy ? Math.max(delay, Math.min(500, Math.ceil(records / 10))) : delay;
      if (disposed || publicationRevision !== revision || conversationId !== currentId()) return;
      // Only snapshots are retried: never replay user commands or tool effects.
      attempted = true;
      const slots = transports, transport = {};
      slots.add(transport);
      // A timeout releases the logical publication slot, not the underlying
      // bridge promise. Bound both so sustained updates cannot leak sends.
      const delivered = Promise.resolve().then(() => {
        if (disposed || publicationRevision !== revision) return;
        return postMessage(full ? { ...full, execution, busy: execution.busy }
          : { type: 'executionState', conversationId, execution, busy: execution.busy });
      }).finally(() => {
        slots.delete(transport);
        if (!disposed && slots === transports && pending && !sending) schedule(currentId());
      });
      return Promise.race([
        delivered.then(value => {
          if (value === false) throw new Error('IDE state message was not delivered');
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('IDE state delivery timed out')), 5000); })
      ]).then(() => {
        if (sending === ticket && publicationRevision === revision) {
          retries = 0;
          if (fullState === full) fullState = undefined;
        }
      });
    }).catch(error => {
      if (!disposed && publicationRevision === revision) {
        report(error);
        if (attempted && retries < 3) { retries++; retry = true; pending = true; }
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (sending !== ticket) return;
      sending = undefined;
      if (pending && !disposed) {
        try { schedule(currentId(), retry); } catch (error) { report(error); }
      }
    });
  }

  return { schedule, publishFull(state) {
    if (disposed) return;
    try {
      // An old conversation's async projection may finish after selection.
      // Reject it before it can displace the current pending full snapshot.
      if (!state?.conversation || state.conversation.id !== currentId()) return;
      fullState = state;
      schedule(state.conversation.id);
    } catch (error) { report(error); }
  }, clear, dispose() { disposed = true; clear(); } };
}

module.exports = { createExecutionPublisher };
