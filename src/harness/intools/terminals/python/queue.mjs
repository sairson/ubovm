import { abortError } from '../../shared/common.mjs';

// Avoid starting one Node + sandbox runtime process per waiting Worker. The
// native lease still serializes Windows across IDE processes after admission.
export function createPythonQueue(capacity = process.platform === 'win32' ? 1 : 4, maxPending = 64) {
  const pending = [];
  let active = 0;
  function drain() {
    while (active < capacity && pending.length) {
      const entry = pending.shift(); entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted) { entry.reject(abortError(entry.signal)); continue; }
      active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  }
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (pending.length >= maxPending) return Promise.reject(Object.assign(new Error('Python execution queue is full; retry after a running call finishes'), { code: 'PYTHON_QUEUE_FULL' }));
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, cancel() {
          const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1);
          signal.removeEventListener('abort', entry.cancel); reject(abortError(signal));
        } };
        pending.push(entry); signal?.addEventListener('abort', entry.cancel, { once: true }); drain();
      });
    }
  };
}

export const pythonQueue = createPythonQueue();
