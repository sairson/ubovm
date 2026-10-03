import { abortError } from '../common.mjs';

// Only for preparation/read-only work. Executing commands must await cleanup
// rather than racing their completion against cancellation.
export function abortableSetup(signal, invoke, disposeLate) {
  if (!signal) return Promise.resolve().then(invoke);
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(abortError(signal)); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return invoke(); }).then(value => {
      if (signal.aborted) {
        if (disposeLate) Promise.resolve().then(() => disposeLate(value)).catch(() => {});
        cancel();
      } else resolve(value);
    }).catch(reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
