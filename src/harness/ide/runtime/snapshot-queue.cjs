'use strict';
const { createLoopCheckpoint } = require('./loop-checkpoint.cjs');
const { serializeError } = require('./errors.cjs');

// One snapshot in flight globally; pending sessions retain IDs, never copies of
// their growing timelines. Set ordering prevents a noisy session starving others.
function createSnapshotQueue({ read, send, onError = () => {}, delay = 0, timeoutMs = 5000, maxInFlight = 4 }) {
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647) throw new TypeError('Invalid snapshot delay');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid snapshot timeout');
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new TypeError('Invalid snapshot capacity');
  if (typeof read !== 'function' || typeof send !== 'function' || typeof onError !== 'function') throw new TypeError('Invalid snapshot callbacks');
  const pending = new Set();
  const transports = new Set();
  let sending, timer, checkpoint, closed = false;
  function scheduleDrain() {
    if (closed || sending || timer !== undefined || !pending.size || transports.size >= maxInFlight) return;
    if (!delay) { drain(); return; }
    timer = setTimeout(() => { timer = undefined; drain(); }, delay);
  }
  function drain() {
    if (closed || sending || !pending.size) return;
    const id = pending.values().next().value;
    if (transports.size >= maxInFlight) return;
    pending.delete(id); const ticket = sending = { id, valid: true };
    function finish(error, failed = false) {
      if (ticket.done) return;
      ticket.done = true;
      clearTimeout(ticket.timer);
      if (failed && !closed && ticket.valid) {
        ticket.valid = false;
        // Rejections may contain undefined, false or throwing properties.
        // Failure is a separate flag, never the truthiness of its reason.
        const safe = serializeError(error);
        const failure = Object.assign(new Error(safe.message), safe);
        try { Promise.resolve(onError(failure, id)).catch(() => {}); } catch {}
      }
      if (sending === ticket) sending = undefined;
      if (!pending.size) checkpoint = undefined;
      scheduleDrain();
    }
    ticket.cancel = () => { ticket.valid = false; finish(); };
    checkpoint ??= createLoopCheckpoint();
    function publish() {
      if (closed || !ticket.valid) { finish(); return; }
      let transport;
      const delivered = (error, failed = false) => {
        transports.delete(transport);
        finish(error, failed);
        // An expired/cancelled logical ticket may already have finished.
        scheduleDrain();
      };
      try {
        const value = read(id);
        if (closed || !ticket.valid) { finish(); return; }
        transport = {}; transports.add(transport);
        ticket.timer = setTimeout(() => {
          ticket.expired = true;
          finish(Object.assign(new Error('Agent snapshot delivery timed out'), { code: 'SNAPSHOT_TIMEOUT' }), true);
        }, timeoutMs);
        const result = send(value, () => !closed && ticket.valid && !ticket.expired);
        Promise.resolve(result).then(value => {
          if (value === false) delivered(Object.assign(new Error('Agent snapshot was not delivered'), { code: 'SNAPSHOT_NOT_DELIVERED' }), true);
          else delivered();
        }, error => delivered(error, true));
      } catch (error) { delivered(error, true); }
    }
    // One queued entry and one completion pair replace the race/async/finally
    // chain. Timers and cancellation settle the same idempotent ticket.
    const currentCheckpoint = checkpoint;
    queueMicrotask(() => {
      if (closed || !ticket.valid) { finish(); return; }
      try {
        const pause = delay ? undefined : currentCheckpoint();
        if (pause) pause.then(publish, error => finish(error, true)); else publish();
      } catch (error) { finish(error, true); }
    });
  }
  return {
    schedule(id) { if (!closed && id) { pending.add(id); scheduleDrain(); } },
    forget(id) { pending.delete(id); if (sending?.id === id) sending.cancel(); },
    close() {
      closed = true; clearTimeout(timer); timer = undefined; pending.clear();
      sending?.cancel();
    }
  };
}
module.exports = { createSnapshotQueue };
