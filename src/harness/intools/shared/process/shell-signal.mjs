/** Combine host cancel with tool lifetime, but never kill a host-retained resident. */
export function bindShellSignal(hostSignal, lifetimeSignal, lifecycle) {
  const run = new AbortController();
  const abort = reason => {
    if (!run.signal.aborted) run.abort(reason === undefined ? new Error('Aborted') : reason);
  };
  const onHost = () => abort(hostSignal?.reason);
  const onLife = () => { if (!lifecycle?.resident) abort(lifetimeSignal.reason); };
  if (hostSignal?.aborted) abort(hostSignal.reason);
  else hostSignal?.addEventListener('abort', onHost);
  if (lifetimeSignal.aborted) {
    if (!lifecycle?.resident) abort(lifetimeSignal.reason);
  } else {
    lifetimeSignal.addEventListener('abort', onLife);
  }
  const releaseResident = lifecycle?.subscribe(() => {
    lifetimeSignal.removeEventListener('abort', onLife);
  });
  const release = () => {
    hostSignal?.removeEventListener('abort', onHost);
    lifetimeSignal.removeEventListener('abort', onLife);
    try { releaseResident?.(); } catch { /* ignore */ }
  };
  return { signal: run.signal, release };
}
