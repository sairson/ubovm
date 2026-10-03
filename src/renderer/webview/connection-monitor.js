(() => {
  window.createConnectionMonitor = ({ send, onChange, interval = 5000, timeout = 20000 }) => {
    for (const [name, value] of Object.entries({ interval, timeout })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid heartbeat ' + name);
    }
    if (timeout <= interval) throw new TypeError('Heartbeat timeout must exceed interval');
    let sequence = 0, pending, timer, disposed = false, suspended = false, status = 'connecting', lastTick = Date.now();
    let wasHidden = document.hidden;
    // One missed probe is usually UI/extension-host churn; require two consecutive
    // failures before declaring hard disconnect so operating the IDE does not flash offline.
    let missCount = 0;
    // Transient agent-runtime flaps (respawn / RPC heartbeat) must not banner the page
    // until confirmed across consecutive acknowledgements.
    let backendMissCount = 0;
    // After show/resume, discard late bridge stalls once without counting toward disconnect.
    let graceUntil = 0;
    const prefix = Math.random().toString(36).slice(2) + ':';
    function change(next) {
      if (status === next) return;
      const previous = status; status = next;
      try { Promise.resolve(onChange(next, previous)).catch(() => {}); } catch { /* UI observers cannot stop connection recovery. */ }
    }
    function startClock() {
      if (!disposed && !suspended && !document.hidden && timer === undefined) timer = setInterval(tick, interval);
    }
    function openGrace() {
      graceUntil = Date.now() + Math.min(timeout, Math.max(interval * 2, 500));
    }
    function noteMiss(fromTimeout = false) {
      // One post-show timeout is usually a discarded probe after panel churn.
      if (fromTimeout && Date.now() < graceUntil) {
        graceUntil = 0;
        change('reconnecting');
        return;
      }
      missCount += 1;
      if (missCount >= 2) change('disconnected');
      else change('reconnecting');
    }
    function probe() {
      if (disposed || suspended || document.hidden) return;
      if (!pending) {
        pending = { id: prefix + (++sequence), sent: Date.now() };
        const request = pending;
        const failed = () => {
          if (disposed || suspended || pending !== request) return;
          pending = undefined;
          noteMiss(false);
          if (!disposed && !suspended && !document.hidden && missCount < 2) queueMicrotask(probe);
        };
        try {
          Promise.resolve(send({ action: 'connectionProbe', probeId: request.id })).then(result => {
            if (result === false) failed();
          }, failed);
        } catch { failed(); }
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
      if (pending && now - pending.sent >= timeout) {
        pending = undefined;
        noteMiss(true);
      }
      probe();
    }
    function receive(event) {
      const message = event.data;
      if (disposed || message?.type !== 'connectionStatus' || !pending || message.probeId !== pending.id) return;
      if (!['idle', 'connected', 'disconnected', 'closed'].includes(message.backend?.status)) return;
      pending = undefined;
      missCount = 0;
      if (['disconnected', 'closed'].includes(message.backend.status)) {
        backendMissCount += 1;
        if (backendMissCount >= 2) change('backend-disconnected');
        else change('reconnecting');
        return;
      }
      backendMissCount = 0;
      change('connected');
    }
    function visible() {
      // Duplicate lifecycle notifications must not discard the current probe
      // or keep moving its deadline forward while the peer is unresponsive.
      if (disposed || wasHidden === document.hidden) return;
      wasHidden = document.hidden;
      pending = undefined; lastTick = Date.now(); missCount = 0; backendMissCount = 0;
      if (document.hidden) { clearInterval(timer); timer = undefined; return; }
      if (disposed || suspended) return;
      // A hidden page may have missed backend changes; require a fresh acknowledgement.
      openGrace();
      change('reconnecting'); startClock(); probe();
    }
    function suspend() { suspended = true; clearInterval(timer); timer = undefined; pending = undefined; }
    function resume() {
      if (disposed || !suspended) return;
      suspended = false; wasHidden = document.hidden; lastTick = Date.now(); missCount = 0; backendMissCount = 0;
      // Require fresh confirmation and trigger the consumer's state resync.
      openGrace();
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
