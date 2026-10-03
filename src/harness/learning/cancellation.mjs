/** Observe late failures, but release the abort subscription as soon as either side settles. */
export function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, signal.reason ?? new Error('Learning cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    // Register rejection handling even when the signal was already cancelled.
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) cancel();
  });
}
