'use strict';
const { serializeError } = require('./errors.cjs');

// Bidirectional requests. Cancellation belongs to the request, not the transport.
// Heartbeat soft-stalls before killing: a busy peer that still exchanges RPC
// traffic must not tear down the worker, matching durable Host reconnect semantics.
function createRPC(port, handle, {
  maxPending = 256, maxActive = 256, maxControl = 8,
  onClose = () => {}, onStallChange = () => {},
  heartbeatInterval = 0, heartbeatTimeout = 20000, heartbeatKillTimeout = 120000
} = {}) {
  // Invalid timer values are clamped by Node to 1 ms; reject them before
  // installing listeners instead of creating a hot loop or disabling bounds.
  for (const [name, value] of Object.entries({ maxPending, maxActive, maxControl })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  for (const [name, value] of Object.entries({ heartbeatInterval, heartbeatTimeout, heartbeatKillTimeout })) {
    if (!Number.isSafeInteger(value) || value < (name === 'heartbeatInterval' ? 0 : 1) || value > 2147483647) {
      throw new TypeError(`Invalid ${name}`);
    }
  }
  if (heartbeatInterval && heartbeatTimeout <= heartbeatInterval) throw new TypeError('heartbeatTimeout must exceed heartbeatInterval');
  if (heartbeatInterval && heartbeatKillTimeout < heartbeatTimeout) throw new TypeError('heartbeatKillTimeout must be >= heartbeatTimeout');
  let sequence = 0, lastRequest = 0, closed;
  let heartbeat, probe, lastTick = Date.now(), lastActivity = Date.now(), stalled = false;
  const pending = new Map(), active = new Map();
  const handlers = new Set();
  const controlPending = new Set(), controlActive = new Set();
  const shutdownPending = new Set(), shutdownActive = new Set();
  const reservations = { ordinary: 0, control: 0, shutdown: 0 };
  const isControl = method => method === 'cancel' || method === 'interruptCommand' || method === 'backgroundCommand';
  const errorData = serializeError;
  const errorFrom = data => { const safe = errorData(data); return Object.assign(new Error(safe.message), safe); };
  const protocolError = () => Object.assign(new Error('Invalid agent RPC message'), { code: 'RPC_PROTOCOL_ERROR' });
  const busy = () => Object.assign(new Error('Agent message queue is full; retry after pending requests finish'), { code: 'RPC_BUSY' });
  const stallError = () => Object.assign(new Error('Agent 后端响应变慢，仍在保持连接。任务未中断，请稍候。'), { code: 'AGENT_HEARTBEAT_STALLED' });
  const killError = () => Object.assign(new Error('Agent 后端未响应，连接已中断。请检查后重新发起或恢复任务。'), { code: 'AGENT_HEARTBEAT_TIMEOUT' });
  function setStalled(next) {
    if (stalled === next) return;
    stalled = next;
    try { Promise.resolve(onStallChange(next, next ? stallError() : undefined)).catch(() => {}); }
    catch { /* Stall observers never control the transport. */ }
  }
  function noteActivity() {
    lastActivity = Date.now();
    setStalled(false);
  }
  function send(message) {
    try { port.postMessage(message); return true; }
    catch (error) { close(error); return false; }
  }
  function call(method, args = [], signal) {
    if (closed) return Promise.reject(closed);
    if (typeof method !== 'string' || !method || !Array.isArray(args)) return Promise.reject(protocolError());
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new TypeError('signal must be an AbortSignal'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const control = isControl(method);
    const shutdown = method === 'close';
    const bucket = shutdown ? 'shutdown' : control ? 'control' : 'ordinary';
    const used = shutdown ? shutdownPending.size : control ? controlPending.size : pending.size - controlPending.size - shutdownPending.size;
    if (used + reservations[bucket] >= (shutdown ? 1 : control ? maxControl : maxPending)) return Promise.reject(busy());
    // Payload getters may make nested RPC calls. Clone before assigning an ID
    // so actual sends remain ordered, while reserving capacity during cloning.
    reservations[bucket]++;
    try { args = structuredClone(args); }
    catch (error) { return Promise.reject(error); }
    finally { reservations[bucket]--; }
    if (closed) return Promise.reject(closed);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => send({ type: 'abort', id, error: errorData(signal.reason) });
      const cleanup = () => { signal?.removeEventListener('abort', abort); controlPending.delete(id); shutdownPending.delete(id); };
      if (control) controlPending.add(id);
      if (shutdown) shutdownPending.add(id);
      pending.set(id, { resolve, reject, cleanup });
      try {
        port.postMessage({ type: 'request', id, method, args });
        // A transport can close synchronously while serializing a request.
        // close() already rejected this call; do not attach a leaked listener.
        if (closed || !pending.has(id)) return;
        signal?.addEventListener('abort', abort, { once: true });
        // Structured cloning can invoke payload getters. If one cancelled the
        // signal during postMessage, replay that cancellation after registration.
        if (signal?.aborted) abort();
      } catch (error) { pending.delete(id); cleanup(); reject(error); }
    });
  }
  function receive(message) {
    if (closed || !message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || message.id < 1) return;
    const { type, id } = message;
    // Transport probes never compete with model/tool request capacity.
    if (type === 'ping') { noteActivity(); send({ type: 'pong', id }); return; }
    if (type === 'pong') {
      noteActivity();
      if (probe?.id === id) probe = undefined;
      return;
    }
    // Any non-probe traffic proves the peer's event loop is alive even when a
    // ping is delayed behind a large structured clone or tool burst.
    noteActivity();
    if (type === 'abort') { active.get(id)?.abort(errorFrom(message.error)); return; }
    if (type === 'response') {
      const item = pending.get(id);
      if (!item) return;
      const hasError = Object.hasOwn(message, 'error'), hasValue = Object.hasOwn(message, 'value');
      // An invalid reply is not proof that the remote operation finished.
      // Do not free a slot and allow more effects on an untrusted connection.
      if (hasError === hasValue || hasError && (!message.error || typeof message.error.message !== 'string')) { close(protocolError()); return; }
      pending.delete(id); item.cleanup();
      if (hasError) item.reject(errorFrom(message.error)); else item.resolve(message.value);
      return;
    }
    if (type !== 'request' || active.has(id)) return;
    if (typeof message.method !== 'string' || !message.method || !Array.isArray(message.args)) {
      send({ type: 'response', id, error: errorData(protocolError()) }); return;
    }
    // MessagePort preserves send order. Retired IDs must never execute again;
    // retaining only the high-water mark also bounds replay bookkeeping.
    if (id <= lastRequest) { close(protocolError()); return; }
    lastRequest = id;
    const control = isControl(message.method);
    const shutdown = message.method === 'close';
    if (shutdown ? shutdownActive.size >= 1 : control ? controlActive.size >= maxControl : active.size - controlActive.size - shutdownActive.size >= maxActive) { send({ type: 'response', id, error: errorData(busy()) }); return; }
    if (control) controlActive.add(id);
    if (shutdown) shutdownActive.add(id);
    const controller = new AbortController(); active.set(id, controller);
    // Only admitted operations own asynchronous cleanup barriers. Heartbeats,
    // invalid messages and overload rejections must not grow a promise queue.
    // Register before invoking user code, which may synchronously close us.
    let complete;
    const task = new Promise(resolve => { complete = resolve; });
    handlers.add(task);
    void (async () => {
      try {
        const value = await handle(message.method, message.args, controller.signal);
        if (!closed) {
          // A result that cannot be cloned fails this request, not the transport.
          try { port.postMessage({ type: 'response', id, value }); }
          catch (error) { send({ type: 'response', id, error: errorData(error) }); }
        }
      } catch (error) {
        if (!closed) send({ type: 'response', id, error: errorData(error) });
      } finally {
        active.delete(id); controlActive.delete(id); shutdownActive.delete(id);
        handlers.delete(task); complete();
      }
    })().catch(close);
  }
  // EventEmitter does not observe returned promises. Contain protocol faults
  // instead of leaving an unhandled rejection in the worker or IDE host.
  const listener = message => {
    try { receive(message); } catch (error) { close(error); }
  };
  port.on('message', listener);
  const disconnected = () => close(new Error('Agent message port closed'));
  const invalidMessage = error => close(error);
  port.on('close', disconnected);
  port.on('messageerror', invalidMessage);
  port.on('error', invalidMessage);
  if (heartbeatInterval > 0) {
    heartbeat = setInterval(() => {
      const now = Date.now();
      // Sleep or a stalled host cannot establish that the other side died.
      // Even a stall shorter than the timeout can carry an old probe past its
      // deadline while its pong is waiting in this process's event queue.
      if (now - lastTick > Math.min(heartbeatTimeout, heartbeatInterval * 2) || now < lastTick) probe = undefined;
      lastTick = now;
      if (probe) {
        const probeAge = now - probe.sent;
        const silentFor = now - lastActivity;
        // Peer traffic after the probe was sent proves the worker is alive even
        // when that traffic was not the matching pong (snapshots, tool RPC).
        if (lastActivity >= probe.sent) {
          probe = undefined;
          setStalled(false);
        } else if (probeAge >= heartbeatTimeout) {
          // Kill uses silence since lastActivity so renewing the probe during a
          // soft stall cannot reset the hard deadline.
          if (silentFor >= heartbeatKillTimeout) {
            close(killError());
            return;
          }
          setStalled(true);
          probe = undefined;
        }
      }
      if (!probe) { probe = { id: ++sequence, sent: now }; send({ type: 'ping', id: probe.id }); }
    }, heartbeatInterval);
    heartbeat.unref?.();
  }
  function close(error = new Error('Agent thread closed')) {
    if (closed) return;
    error = errorFrom(error);
    closed = error; port.off('message', listener);
    clearInterval(heartbeat); probe = undefined;
    setStalled(false);
    port.off('close', disconnected); port.off('messageerror', invalidMessage);
    port.off('error', invalidMessage);
    for (const item of pending.values()) { item.cleanup(); item.reject(error); }
    pending.clear();
    for (const controller of active.values()) controller.abort(error);
    active.clear(); controlActive.clear(); shutdownActive.clear();
    try { Promise.resolve(onClose(error)).catch(() => {}); } catch { /* Transport cleanup must always complete. */ }
  }
  // Closing aborts handlers but cannot force them to stop writing files. Keep
  // their completion barrier separate from the closed transport's bookkeeping.
  return {
    call, close,
    isIdle: () => handlers.size === 0,
    drain: () => Promise.allSettled([...handlers]),
    isStalled: () => stalled
  };
}
module.exports = { createRPC };
