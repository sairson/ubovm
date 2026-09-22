'use strict';

/** Coalesce streamed execution updates without retaining full conversation snapshots. */
function createExecutionPublisher({ currentId, canPublish, readExecution, postMessage, onError = () => {}, delay = 75 }) {
  let timer, pending = false, sending = false, disposed = false;

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    pending = false;
  }

  function schedule(id) {
    if (disposed || id !== currentId() || !canPublish()) return;
    pending = true;
    if (!timer && !sending) timer = setTimeout(flush, delay);
  }

  function flush() {
    timer = undefined;
    if (disposed || !pending || !canPublish()) { pending = false; return; }
    pending = false;
    const conversationId = currentId();
    sending = true;
    // Read at publication time so rapid updates always collapse to the latest
    // state. Only one post may be in flight on a slow extension-host bridge.
    Promise.resolve().then(() => {
      if (disposed || !canPublish() || conversationId !== currentId()) return;
      const execution = readExecution();
      return postMessage({ type: 'executionState', conversationId, execution, busy: execution.busy });
    }).catch(onError).finally(() => {
      sending = false;
      if (pending) schedule(currentId());
    });
  }

  return { schedule, clear, dispose() { disposed = true; clear(); } };
}

module.exports = { createExecutionPublisher };
