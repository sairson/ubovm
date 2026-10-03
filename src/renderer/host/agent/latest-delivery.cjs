'use strict';
const { createLoopCheckpoint } = require('./agent-backend.cjs').backendModule('loop-checkpoint.cjs');

/** One in-flight delivery plus one replaceable pending state per component.
 * Jobs read their state when sent. Clearing releases callers without waiting
 * for a disposed bridge, and its late completion cannot touch the new queue.
 */
function createLatestDelivery(onError = () => {}, { timeoutMs = 5000, maxInFlight = 4, maxRetries = 2 } = {}) {
  if (typeof onError !== 'function') throw new TypeError('Invalid delivery observer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid delivery timeout');
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new TypeError('Invalid delivery capacity');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new TypeError('Invalid delivery retries');
  let active, transports = new Set();
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Observers cannot stall delivery. */ }
  };
  function retryJob(cycle, job) {
    if (active !== cycle || cycle.next || cycle.retries >= maxRetries) return false;
    cycle.retries += 1;
    cycle.next = job;
    cycle.waiting = true;
    const delay = Math.min(1000, 100 * 2 ** (cycle.retries - 1));
    cycle.retryTimer = setTimeout(() => {
      cycle.retryTimer = undefined;
      cycle.waiting = false;
      if (active === cycle) drain(cycle);
    }, delay);
    return true;
  }
  function drain(cycle) {
    if (cycle.waiting) return;
    while (active === cycle && cycle.next) {
      if (transports.size >= maxInFlight) return;
      const pause = cycle.checkpoint();
      if (pause) {
        cycle.waiting = true;
        void pause.then(() => { cycle.waiting = false; drain(cycle); }); return;
      }
      const job = cycle.next; cycle.next = undefined;
      // Reserve before invoking bridge code: it can synchronously hide the
      // view and publish again on the same transport.
      const slots = transports, ticket = {};
      slots.add(ticket);
      const release = () => {
        slots.delete(ticket);
        if (slots === transports && active && !active.waiting) drain(active);
      };
      let result;
      try { result = job(); } catch (error) {
        slots.delete(ticket);
        if (active === cycle) {
          report(error);
          if (retryJob(cycle, job)) return;
        }
        else { if (active) drain(active); return; }
        continue;
      }
      if (active !== cycle) {
        Promise.resolve(result).then(release, release);
        return;
      }
      // Promise assimilation also contains throwing `then` accessors. Never
      // inspect a foreign thenable outside the rejection boundary.
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        cycle.waiting = true;
        const delivered = Promise.resolve(result).then(value => {
          if (value === false) throw new Error('Component state message was not delivered');
        }).finally(release);
        Promise.race([delivered, new Promise((resolve, reject) => {
          cycle.releaseDelay = resolve;
          cycle.timer = setTimeout(() => reject(new Error('Component state delivery timed out')), timeoutMs);
        })]).then(() => {
          if (active === cycle) cycle.retries = 0;
        }).catch(error => {
          if (active !== cycle) return;
          report(error);
          if (retryJob(cycle, job)) return;
        }).then(() => {
          clearTimeout(cycle.timer); cycle.timer = undefined; cycle.releaseDelay = undefined;
          if (cycle.retryTimer) return;
          cycle.waiting = false;
          if (active === cycle) drain(cycle);
        });
        return;
      }
      slots.delete(ticket);
      if (result === false) {
        report(new Error('Component state message was not delivered'));
        if (retryJob(cycle, job)) return;
      } else if (active === cycle) cycle.retries = 0;
    }
    if (active === cycle) { active = undefined; cycle.resolve(); }
  }
  return {
    publish(job) {
      if (typeof job !== 'function') throw new TypeError('Invalid delivery job');
      if (active) {
        active.next = job;
        active.retries = 0;
        clearTimeout(active.retryTimer); active.retryTimer = undefined;
        return active.done;
      }
      const cycle = { next: job, retries: 0, checkpoint: createLoopCheckpoint() };
      cycle.done = new Promise(resolve => { cycle.resolve = resolve; });
      active = cycle; drain(cycle);
      return cycle.done;
    },
    clear({ resetTransport = true } = {}) {
      const previous = active; active = undefined;
      if (resetTransport) transports = new Set();
      if (previous) {
        clearTimeout(previous.timer); clearTimeout(previous.retryTimer);
        previous.releaseDelay?.(); previous.next = undefined; previous.resolve();
      }
    }
  };
}

module.exports = { createLatestDelivery };
