import { abortError } from '../common.mjs';

// A real queue, rather than a promise chain: cancelled waiters release their
// closures, timer, and AbortSignal listener without waiting for the active job.
// Resident long-running commands may park() to free the slot for the next call.
export class ShellQueue {
  #waiting = new Set(); #active; #closed; #capacity;
  constructor(capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('Invalid shell queue capacity');
    this.#capacity = capacity;
  }
  run(task, { signal, waitSeconds = 120, onQueued } = {}) {
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0 || waitSeconds > 86400) throw new TypeError('Invalid shell queue wait limit');
    signal?.throwIfAborted();
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#active && this.#waiting.size >= this.#capacity) return Promise.reject(Object.assign(new Error('Shell queue is full; wait for a command to finish'), { code: 'SHELL_QUEUE_FULL' }));
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal, queuedAt: performance.now() };
      let timer;
      const remove = error => {
        if (!this.#waiting.delete(item)) return;
        item.cleanup(); reject(error);
      };
      const cancel = () => remove(abortError(signal));
      item.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      item.cancel = remove;
      if (!this.#active) { this.#start(item); return; }
      this.#waiting.add(item);
      timer = setTimeout(() => remove(Object.assign(new Error(`Shell queue wait timed out after ${waitSeconds} seconds; command was not executed`), { code: 'SHELL_QUEUE_TIMEOUT' })), waitSeconds * 1000);
      signal?.addEventListener('abort', cancel, { once: true });
      try { Promise.resolve(onQueued?.()).catch(() => {}); } catch { /* observer */ }
      if (signal?.aborted) cancel();
    });
  }
  #pump() {
    const next = this.#waiting.values().next().value;
    if (next) { this.#waiting.delete(next); this.#start(next); }
  }
  #start(item) {
    item.cleanup();
    this.#active = item;
    const park = () => {
      if (this.#active !== item) return false;
      this.#active = undefined;
      this.#pump();
      return true;
    };
    item.done = Promise.resolve().then(() => {
      item.signal?.throwIfAborted();
      return item.task(Math.max(0, performance.now() - item.queuedAt), { park });
    }).then(item.resolve, item.reject).finally(() => {
      if (this.#active === item) {
        this.#active = undefined;
        this.#pump();
      }
    });
  }
  async close(error = new Error('Shell session is closed')) {
    this.#closed ??= error;
    for (const item of this.#waiting) item.cancel(this.#closed);
    await this.#active?.done;
  }
}
