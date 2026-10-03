const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

test('connection probes resume after page restoration and explicit disposal remains terminal', async () => {
  const window = new EventTarget(), document = new EventTarget(); document.hidden = false;
  const timers = new Set(), sent = [], states = [];
  const sandbox = { window, document, Date, Math, queueMicrotask,
    setInterval(fn) { const timer = { fn }; timers.add(timer); return timer; }, clearInterval(timer) { timers.delete(timer); } };
  runInNewContext(readFileSync(require.resolve('../../../webview/connection-monitor.js'), 'utf8'), sandbox);
  const monitor = window.createConnectionMonitor({ send: message => sent.push(message), onChange: state => states.push(state) });
  await Promise.resolve();
  const acknowledge = () => {
    const event = new Event('message'); event.data = { type: 'connectionStatus', probeId: sent.at(-1).probeId, backend: { status: 'connected' } };
    window.dispatchEvent(event);
  };
  acknowledge(); assert.deepEqual(states, ['connected']);
  for (let index = 0; index < 20; index++) {
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(timers.size, 0);
    const count = sent.length; monitor.probe(); assert.equal(sent.length, count);
    window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('pageshow'));
    assert.equal(timers.size, 1); assert.equal(sent.length, count + 1);
    assert.equal(states.at(-1), 'reconnecting'); acknowledge();
    assert.equal(states.at(-1), 'connected');
  }
  monitor.dispose(); monitor.dispose();
  window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange'));
  const count = sent.length; monitor.probe();
  assert.equal(timers.size, 0); assert.equal(sent.length, count);
});


test('hidden connection clocks pause and late send failures cannot overwrite a restored connection', async () => {
  const window = new EventTarget(), document = new EventTarget(); document.hidden = false;
  const timers = new Set(), sent = [], rejected = [], states = [];
  runInNewContext(readFileSync(require.resolve('../../../webview/connection-monitor.js'), 'utf8'), { window, document, Date, Math, queueMicrotask,
    setInterval(fn) { const timer = { fn }; timers.add(timer); return timer; }, clearInterval(timer) { timers.delete(timer); } });
  const monitor = window.createConnectionMonitor({ send(message) { sent.push(message); return new Promise((_, reject) => rejected.push(reject)); },
    onChange(state) { states.push(state); return Promise.reject(new Error('observer failure')); } });
  await Promise.resolve();
  try {
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(timers.size, 0);
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); assert.equal(timers.size, 1);
    const event = new Event('message'); event.data = { type: 'connectionStatus', probeId: sent.at(-1).probeId, backend: { status: 'connected' } }; window.dispatchEvent(event);
    rejected[0](new Error('old bridge failure')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.at(-1), 'connected');
    monitor.probe(); rejected.at(-1)(new Error('current bridge failure')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.at(-1), 'reconnecting', 'one send failure soft-reconnects during UI churn');
    await new Promise(resolve => setImmediate(resolve));
    rejected.at(-1)(new Error('follow-up bridge failure')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.at(-1), 'disconnected', 'two consecutive send failures disconnect');
    monitor.dispose(); document.dispatchEvent(new Event('visibilitychange')); assert.equal(timers.size, 0);
  } finally { monitor.dispose(); }
});
