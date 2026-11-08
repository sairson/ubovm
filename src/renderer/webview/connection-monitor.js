(() => {
  window.createConnectionMonitor = ({ send, onChange, interval = 5000, timeout = 20000 }) => {
    for (const [name, value] of Object.entries({ interval, timeout })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid heartbeat ' + name);
    }
    if (timeout <= interval) throw new TypeError('Heartbeat timeout must exceed interval');
    let sequence = 0, pending, timer, disposed = false, suspended = false, status = 'connecting', lastTick = Date.now();
    // Last successful bridge acknowledgement. Used to distinguish a local event-loop
    // gap (reply already queued) from sleep/background where state may be stale.
    let lastPong = 0;
    let wasHidden = document.hidden;
    // One missed probe is usually UI/extension-host churn. A miss is evidence of
    // slowness, not proof of death, so the page keeps probing, keeps its pending
    // operations, and only surfaces a sustained silence as a passive banner.
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
    function noteMiss() {
      // One post-show miss (timeout or failed bridge delivery) is usually panel
      // churn; soft-reconnect without counting toward the sustained banner.
      if (Date.now() < graceUntil) {
        graceUntil = 0;
        change('reconnecting');
        return;
      }
      missCount += 1;
      // No timeout kills the page's connection: the probe keeps running, pending
      // operations keep their own deadlines, and a late reply completes recovery.
      // Sustained silence is only reported as a non-blocking "unresponsive" state.
      if (missCount >= 2) change('unresponsive');
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
          noteMiss();
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
        // Clock rollback invalidates in-flight probes. A delayed local event loop
        // (heavy paint) does not — keep the outstanding probe and extend its
        // deadline so a late reply still proves the bridge is alive.
        if (now < lastTick) {
          pending = undefined;
          // Rollback cannot prove remote failure, but state may be stale.
          if (!document.hidden && !suspended) change('reconnecting');
        } else if (pending) {
          pending.sent = now;
          // Keep `connected` while a live probe is outstanding so paint stalls do
          // not flip reconnecting→connected and storm a full ready resync.
        } else if (status === 'connected' && lastPong > lastTick) {
          // The pong was delivered while the page was blocked; the bridge is alive
          // and a ready storm would only deepen the stall.
        } else if (!document.hidden && !suspended) {
          // Sleep without an in-flight probe: require a fresh pong + state resync.
          change('reconnecting');
        }
      }
      lastTick = now;
      if (document.hidden) { pending = undefined; return; }
      if (pending && now - pending.sent >= timeout) {
        pending = undefined;
        noteMiss();
      }
      probe();
    }
    function applyBackend(backend) {
      if (!['idle', 'connected', 'disconnected', 'closed', 'stalled'].includes(backend?.status)) return false;
      missCount = 0;
      lastPong = Date.now();
      if (backend.status === 'stalled') {
        // Transport is slow but the worker is still alive — soft banner only.
        backendMissCount = 0;
        change('backend-stalled');
        return true;
      }
      if (['disconnected', 'closed'].includes(backend.status)) {
        // A worker that is being respawned reports disconnected while recovery is
        // already in flight. Keep the UI in soft-reconnecting for the first few
        // probes; a persistent failure still raises the offline banner so a real
        // outage is not hidden indefinitely.
        if (backend.recovering === true && backend.status === 'disconnected') {
          backendMissCount += 1;
          if (backendMissCount >= 4) change('backend-disconnected');
          else change('reconnecting');
          return true;
        }
        backendMissCount += 1;
        if (backendMissCount >= 2) change('backend-disconnected');
        else change('reconnecting');
        return true;
      }
      backendMissCount = 0;
      change('connected');
      return true;
    }
    function receive(event) {
      const message = event.data;
      if (disposed || message?.type !== 'connectionStatus') return;
      // Host-pushed stall/recover updates are not tied to a probe id.
      if (message.unsolicited === true) {
        applyBackend(message.backend);
        return;
      }
      if (!pending || message.probeId !== pending.id) return;
      pending = undefined;
      applyBackend(message.backend);
    }
    function visible() {
      // Duplicate lifecycle notifications must not discard the current probe
      // or keep moving its deadline forward while the peer is unresponsive.
      if (disposed || wasHidden === document.hidden) return;
      wasHidden = document.hidden;
      pending = undefined; lastTick = Date.now(); missCount = 0; backendMissCount = 0;
      if (document.hidden) { clearInterval(timer); timer = undefined; return; }
      if (disposed || suspended) return;
      // A hidden page may have missed backend changes; probe fresh without
      // flashing a reconnect banner. The page resyncs its own state on visibility,
      // and a failed probe still escalates through noteMiss().
      openGrace();
      startClock(); probe();
    }
    function suspend() { suspended = true; clearInterval(timer); timer = undefined; pending = undefined; }
    function resume() {
      if (disposed || !suspended) return;
      suspended = false; wasHidden = document.hidden; lastTick = Date.now(); missCount = 0; backendMissCount = 0;
      // Require a fresh probe, but keep the last known status while it is in
      // flight. The page requests a full state resync on pageshow independently;
      // this avoids a reconnect flash for a normal hide/show cycle.
      openGrace();
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
