const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture(sendResult) {
  let now = 0, tick;
  const messages = [], changes = [], clocks = new Set(), microtasks = [];
  function target() {
    const listeners = new Map();
    return { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), emit: (key, value) => listeners.get(key)?.(value) };
  }
  const window = target(), document = target();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../webview/connection-monitor.js'), 'utf8'), {
    window, document, Date: { now: () => now }, Math, queueMicrotask: fn => { microtasks.push(fn); },
    setInterval: fn => { tick = fn; const id = {}; clocks.add(id); return id; }, clearInterval: id => clocks.delete(id)
  });
  const monitor = window.createConnectionMonitor({ send: message => { messages.push(message); return sendResult?.(message); }, onChange: status => changes.push(status), interval: 5, timeout: 20 });
  function flush() { while (microtasks.length) microtasks.shift()(); }
  flush();
  return { window, document, monitor, messages, changes, clocks, flush, step(value) { now = value; tick(); },
    reply(id = messages.at(-1).probeId) { window.emit('message', { data: { type: 'connectionStatus', probeId: id, backend: { status: 'connected' } } }); } };
}

test('queued heartbeat callbacks cannot notify or send after suspension or disposal', () => {
  for (const lifecycle of ['suspend', 'dispose']) {
    const f = fixture(); f.reply();
    if (lifecycle === 'suspend') f.window.emit('pagehide'); else f.monitor.dispose();
    const sent = f.messages.length, changed = f.changes.length;
    // The fixture retains the callback even after clearInterval, as a browser
    // task queued before teardown can still arrive after it.
    f.step(1000); f.step(-1000); f.step(2000);
    assert.equal(f.messages.length, sent);
    assert.equal(f.changes.length, changed);
    assert.equal(f.clocks.size, 0);
    if (lifecycle === 'suspend') {
      f.window.emit('pageshow'); assert.equal(f.messages.length, sent + 1);
      f.reply(); assert.equal(f.changes.at(-1), 'connected'); assert.equal(f.clocks.size, 1);
    }
    f.monitor.dispose();
  }
});

test('duplicate visibility notifications preserve the probe deadline and only one heartbeat clock', () => {
  const f = fixture();
  try {
    for (let now = 5; now <= 40; now += 5) {
      for (let i = 0; i < 100; i++) f.document.emit('visibilitychange');
      f.step(now);
    }
    // First timeout soft-fails to reconnecting; the second consecutive miss becomes disconnected.
    assert.equal(f.changes.includes('reconnecting'), true);
    assert.equal(f.changes.at(-1), 'disconnected');
    assert.equal(f.clocks.size, 1);
    f.document.hidden = true; f.document.emit('visibilitychange');
    assert.equal(f.clocks.size, 0);
    f.document.hidden = false; f.document.emit('visibilitychange');
    const count = f.messages.length;
    for (let i = 0; i < 100; i++) { f.document.emit('visibilitychange'); f.window.emit('pageshow'); }
    assert.equal(f.messages.length, count); assert.equal(f.clocks.size, 1);
    f.reply(); assert.equal(f.changes.at(-1), 'connected');
  } finally { f.monitor.dispose(); }
  assert.equal(f.clocks.size, 0);
});

test('backend disconnect requires two consecutive acknowledgements', () => {
  const f = fixture();
  try {
    f.reply();
    assert.equal(f.changes.at(-1), 'connected');
    f.monitor.probe();
    f.window.emit('message', { data: { type: 'connectionStatus', probeId: f.messages.at(-1).probeId, backend: { status: 'disconnected' } } });
    assert.equal(f.changes.at(-1), 'reconnecting');
    f.monitor.probe();
    f.window.emit('message', { data: { type: 'connectionStatus', probeId: f.messages.at(-1).probeId, backend: { status: 'disconnected' } } });
    assert.equal(f.changes.at(-1), 'backend-disconnected');
    f.monitor.probe();
    f.reply();
    assert.equal(f.changes.at(-1), 'connected');
  } finally { f.monitor.dispose(); }
});

test('unsolicited stalled backend updates soft-banner without counting as disconnect', () => {
  const f = fixture();
  try {
    f.reply();
    assert.equal(f.changes.at(-1), 'connected');
    f.window.emit('message', { data: { type: 'connectionStatus', unsolicited: true, backend: { status: 'stalled' } } });
    assert.equal(f.changes.at(-1), 'backend-stalled');
    f.window.emit('message', { data: { type: 'connectionStatus', unsolicited: true, backend: { status: 'connected' } } });
    assert.equal(f.changes.at(-1), 'connected');
    f.monitor.probe();
    f.window.emit('message', { data: { type: 'connectionStatus', probeId: f.messages.at(-1).probeId, backend: { status: 'stalled' } } });
    assert.equal(f.changes.at(-1), 'backend-stalled');
  } finally { f.monitor.dispose(); }
});

test('a single false delivery soft-reconnects; two consecutive failures disconnect', async () => {
  let rejectOld, sends = 0;
  const f = fixture(() => {
    sends += 1;
    if (sends === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return false;
  });
  try {
    // Drop the unresolved first probe, then fail the replacement once.
    f.document.hidden = true; f.document.emit('visibilitychange');
    f.document.hidden = false; f.document.emit('visibilitychange');
    await Promise.resolve();
    assert.equal(f.changes.at(-1), 'reconnecting', 'one false delivery must not flash hard disconnect');
    // Soft miss schedules an immediate follow-up probe; its false delivery hard-disconnects.
    f.flush();
    await Promise.resolve();
    assert.equal(f.changes.at(-1), 'disconnected', 'two consecutive false deliveries disconnect');
    f.monitor.probe(); f.reply();
    rejectOld(new Error('late send failure'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.changes.at(-1), 'connected');
    f.monitor.dispose(); f.monitor.probe(); f.document.emit('visibilitychange');
    assert.equal(f.clocks.size, 0);
  } finally { f.monitor.dispose(); }
});

test('page detects host loss only after consecutive misses and recovers without replaying commands', () => {
  let now = 0, tick, initial; const messages = [], changes = [];
  function target() { const listeners = new Map(); return { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), emit: (key, value) => listeners.get(key)?.(value), listeners }; }
  const window = target(), document = target();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../webview/connection-monitor.js'), 'utf8'), {
    window, document, Date: { now: () => now }, Math, queueMicrotask: fn => { initial = fn; }, setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; }
  });
  const monitor = window.createConnectionMonitor({ send: message => messages.push(message), onChange: status => changes.push(status), interval: 5, timeout: 20 });
  for (const options of [{ interval: 0 }, { interval: NaN }, { interval: 2147483648 }, { timeout: 0 }, { interval: 20, timeout: 20 }]) {
    const listeners = window.listeners.size + document.listeners.size;
    assert.throws(() => window.createConnectionMonitor({ send() {}, onChange() {}, ...options }), /heartbeat|Heartbeat/);
    assert.equal(window.listeners.size + document.listeners.size, listeners);
  }
  initial(); const old = messages.at(-1).probeId;
  for (now = 5; now <= 20; now += 5) tick();
  assert.equal(changes.at(-1), 'reconnecting', 'first timeout is a soft miss');
  for (now = 25; now <= 40; now += 5) tick();
  assert.equal(changes.at(-1), 'disconnected', 'second consecutive timeout disconnects');
  window.emit('message', { data: { type: 'connectionStatus', probeId: old, backend: { status: 'connected' } } });
  assert.equal(changes.at(-1), 'disconnected');
  window.emit('message', { data: { type: 'connectionStatus', probeId: messages.at(-1).probeId, backend: { status: 'disconnected' } } });
  assert.equal(changes.at(-1), 'reconnecting', 'one backend failure soft-reconnects');
  monitor.probe();
  window.emit('message', { data: { type: 'connectionStatus', probeId: messages.at(-1).probeId, backend: { status: 'disconnected' } } });
  assert.equal(changes.at(-1), 'backend-disconnected', 'two consecutive backend failures banner the page');
  monitor.probe();
  window.emit('message', { data: { type: 'connectionStatus', probeId: messages.at(-1).probeId, backend: { status: 'connected' } } });
  assert.equal(changes.at(-1), 'connected');
  document.hidden = true; document.emit('visibilitychange'); now += 1000;
  assert.equal(tick, undefined);
  document.hidden = false; document.emit('visibilitychange');
  assert.equal(changes.at(-1), 'reconnecting', 'sleep/backgrounding must not imply a crash');
  window.emit('message', { data: { type: 'connectionStatus', probeId: messages.at(-1).probeId, backend: { status: 'connected' } } });
  assert.equal(changes.at(-1), 'connected');
  assert(messages.every(message => message.action === 'connectionProbe'));
  const beforeSleep = messages.at(-1).probeId;
  now += 10000; tick();
  assert.equal(changes.at(-1), 'reconnecting', 'sleep without visibility events must trigger state resync');
  const afterSleep = messages.at(-1).probeId;
  assert.notEqual(afterSleep, beforeSleep);
  window.emit('message', { data: { type: 'connectionStatus', probeId: beforeSleep, backend: { status: 'connected' } } });
  assert.equal(changes.at(-1), 'reconnecting', 'pre-sleep replies cannot finish recovery');
  window.emit('message', { data: { type: 'connectionStatus', probeId: afterSleep, backend: { status: 'connected' } } });
  assert.equal(changes.at(-1), 'connected');
  now -= 1000; tick();
  assert.equal(changes.at(-1), 'reconnecting', 'clock rollback also requires a fresh state');
  window.emit('message', { data: { type: 'connectionStatus', probeId: messages.at(-1).probeId, backend: { status: 'connected' } } });
  now += 15; tick();
  assert.equal(changes.at(-1), 'reconnecting', 'short local stalls renew the connection instead of declaring host loss');
  assert(messages.every(message => message.action === 'connectionProbe'), 'recovery never replays tasks');
  window.emit('pagehide'); assert.equal(tick, undefined);
  monitor.dispose(); assert.equal(window.listeners.size, 0); assert.equal(document.listeners.size, 0);
});
