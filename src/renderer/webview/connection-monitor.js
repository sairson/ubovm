(() => {
  window.createConnectionMonitor = ({ send, onChange, interval = 5000, timeout = 20000 }) => {
    for (const [name, value] of Object.entries({ interval, timeout })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid heartbeat ' + name);
    }
    if (timeout <= interval) throw new TypeError('Heartbeat timeout must exceed interval');
    let sequence = 0, pending, timer, disposed = false, suspended = false, status = 'connecting', lastTick = Date.now();
    let wasHidden = document.hidden;
    const prefix = Math.random().toString(36).slice(2) + ':';
    function change(next) {
      if (status === next) return;
      const previous = status; status = next;
      try { Promise.resolve(onChange(next, previous)).catch(() => {}); } catch { /* UI observers cannot stop connection recovery. */ }
    }
    function startClock() {
      if (!disposed && !suspended && !document.hidden && timer === undefined) timer = setInterval(tick, interval);
    }
    function probe() {
      if (disposed || suspended || document.hidden) return;
      if (!pending) {
        pending = { id: prefix + (++sequence), sent: Date.now() };
        const request = pending;
        const failed = () => {
          if (disposed || suspended || pending !== request) return;
          pending = undefined; change('disconnected');
        };
        try { Promise.resolve(send({ action: 'connectionProbe', probeId: request.id })).then(result => { if (result === false) failed(); }, failed); }
        catch { failed(); }
      }
    }
    function tick() {
      // Clearing the interval cannot revoke a callback already queued by the
      // browser. A stale tick must not notify observers after teardown.
      if (disposed || suspended) return;
      const now = Date.now();
      if (now - lastTick > Math.min(timeout, interval * 2) || now < lastTick) {
        pending = undefined;
        // Sleep or a delayed local event loop cannot prove remote failure. A fresh
        // pong must trigger full state resync even if we were still connected.
        if (!document.hidden && !suspended) change('reconnecting');
      }
      lastTick = now;
      if (document.hidden) { pending = undefined; return; }
      if (pending && now - pending.sent >= timeout) { pending = undefined; change('disconnected'); }
      probe();
    }
    function receive(event) {
      const message = event.data;
      if (disposed || message?.type !== 'connectionStatus' || !pending || message.probeId !== pending.id) return;
      if (!['idle', 'connected', 'disconnected', 'closed'].includes(message.backend?.status)) return;
      pending = undefined;
      change(['disconnected', 'closed'].includes(message.backend.status) ? 'backend-disconnected' : 'connected');
    }
    function visible() {
      // Duplicate lifecycle notifications must not discard the current probe
      // or keep moving its deadline forward while the peer is unresponsive.
      if (disposed || wasHidden === document.hidden) return;
      wasHidden = document.hidden;
      pending = undefined; lastTick = Date.now();
      if (document.hidden) { clearInterval(timer); timer = undefined; return; }
      if (disposed || suspended) return;
      // A hidden page may have missed backend changes; require a fresh acknowledgement.
      change('reconnecting'); startClock(); probe();
    }
    function suspend() { suspended = true; clearInterval(timer); timer = undefined; pending = undefined; }
    function resume() {
      if (disposed || !suspended) return;
      suspended = false; wasHidden = document.hidden; lastTick = Date.now();
      // Require fresh confirmation and trigger the consumer's state resync.
      change('reconnecting');
      startClock(); probe();
    }
    function dispose() { disposed = true; suspend(); window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); }
    window.addEventListener('message', receive);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    startClock();
    // Consumers finish initializing before the first asynchronous heartbeat.
    queueMicrotask(probe);
    return { probe, dispose };
  };
})();
