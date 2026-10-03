'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageChannel } = require('node:worker_threads');
const { once } = require('node:events');
const { createRPC } = require('../../../../harness/ide/runtime/thread-rpc.cjs');

test('repeated real-port cancellation and reconnection release listeners and request capacity', { timeout: 15000 }, async () => {
  const { getEventListeners } = require('node:events');
  let completed = 0, cancelled = 0;
  for (let generation = 0; generation < 20; generation++) {
    const { port1, port2 } = new MessageChannel();
    let entered;
    const a = createRPC(port1, () => undefined, { maxPending: 1 });
    const b = createRPC(port2, (method, args, signal) => {
      if (method === 'echo') { completed++; return args[0]; }
      return new Promise((resolve, reject) => {
        const abort = () => { cancelled++; signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        entered();
      });
    }, { maxActive: 1 });
    try {
      for (let cycle = 0; cycle < 50; cycle++) {
        const controller = new AbortController();
        const ready = new Promise(resolve => { entered = resolve; });
        const request = a.call('held', [], controller.signal);
        const result = assert.rejects(request, /soak cancellation/);
        await ready;
        controller.abort(new Error('soak cancellation'));
        await result; await b.drain();
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.equal(await a.call('echo', [cycle]), cycle, 'cancelled request must release its capacity after remote cleanup');
        assert.equal(b.isIdle(), true);
      }
    } finally {
      a.close(); b.close(); await Promise.all([a.drain(), b.drain()]);
      for (const port of [port1, port2]) {
        for (const event of ['message', 'close', 'messageerror', 'error']) assert.equal(port.listenerCount(event), 0);
        port.close();
      }
    }
  }
  assert.equal(completed, 1000); assert.equal(cancelled, 1000);
});

test('heartbeat and rejected message bursts allocate no asynchronous cleanup queue', async () => {
  const { EventEmitter } = require('node:events');
  const { createHook } = require('node:async_hooks');
  const port = new EventEmitter(); let pongs = 0, rejected = 0, invoked = 0, promises = 0, release;
  port.postMessage = message => {
    if (message.type === 'pong') pongs++;
    if (message.error?.code === 'RPC_BUSY') rejected++;
  };
  const rpc = createRPC(port, () => { invoked++; return new Promise(resolve => { release = resolve; }); }, { maxActive: 1 });
  const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promises++; } });
  try {
    hook.enable();
    for (let id = 1; id <= 10000; id++) {
      port.emit('message', { type: 'ping', id });
      port.emit('message', { type: 'response', id, value: null });
      port.emit('message', null);
    }
    hook.disable();
    assert.equal(promises, 0); assert.equal(pongs, 10000); assert.equal(rpc.isIdle(), true);
    port.emit('message', { type: 'request', id: 1, method: 'held', args: [] });
    assert.equal(rpc.isIdle(), false);
    promises = 0; hook.enable();
    for (let id = 2; id <= 10001; id++) port.emit('message', { type: 'request', id, method: 'held', args: [] });
    hook.disable();
    assert.equal(promises, 0); assert.equal(rejected, 10000); assert.equal(invoked, 1);
    rpc.close(); assert.equal(rpc.isIdle(), false);
    release(); await rpc.drain(); assert.equal(rpc.isIdle(), true);
  } finally { hook.disable(); rpc.close(); release?.(); await rpc.drain(); }
});

test('a synchronous protocol getter fault closes the transport without escaping the listener', async () => {
  const { EventEmitter } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  const rpc = createRPC(port, () => assert.fail('invalid message executed'));
  assert.doesNotThrow(() => port.emit('message', { get id() { throw Error('invalid getter'); } }));
  await assert.rejects(rpc.call('work'), /invalid getter/);
  assert.equal(rpc.isIdle(), true);
});

test('reentrant transport close includes the current handler in its cleanup barrier', async () => {
  const { EventEmitter } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  let release, draining, idleAtClose, drained = false;
  const rpc = createRPC(port, () => {
    rpc.close();
    return new Promise(resolve => { release = resolve; });
  }, { onClose: () => {
    idleAtClose = rpc.isIdle();
    draining = rpc.drain().then(() => { drained = true; });
  } });
  port.emit('message', { type: 'request', id: 1, method: 'write', args: [] });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(idleAtClose, false); assert.equal(drained, false); }
  finally { release(); await draining; }
  assert.equal(rpc.isIdle(), true);
});

test('invalid cancellation signals never send work or consume reserved control capacity', async t => {
  const methods = [];
  const { a } = pair(t, method => { methods.push(method); return 'ok'; }, { maxControl: 1 });
  await assert.rejects(a.call('cancel', [], {}), /AbortSignal/);
  await assert.rejects(a.call('close', [], null), /AbortSignal/);
  assert.equal(await a.call('cancel'), 'ok');
  assert.equal(await a.call('close'), 'ok');
  assert.deepEqual(methods, ['cancel', 'close']);
});

test('local scheduler stalls renew the probe; soft stall precedes a hard kill', () => {
  const { EventEmitter } = require('node:events');
  const { runInNewContext } = require('node:vm');
  const { readFileSync } = require('node:fs');
  let now = 0, tick, failure, stalls = [];
  const module = { exports: {} }, sent = [], port = new EventEmitter();
  port.postMessage = message => sent.push(message);
  runInNewContext(readFileSync(require.resolve('../../../../harness/ide/runtime/thread-rpc.cjs'), 'utf8'), {
    module, require: () => require('../../../../harness/ide/runtime/errors.cjs'), AbortController, AbortSignal, Promise,
    Date: { now: () => now }, setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval() {}
  });
  const rpc = module.exports.createRPC(port, () => {}, {
    heartbeatInterval: 10, heartbeatTimeout: 60, heartbeatKillTimeout: 120,
    onClose: error => { failure = error; },
    onStallChange: stalled => stalls.push(stalled)
  });
  try {
    now = 10; tick(); const old = sent.at(-1).id;
    for (now = 20; now <= 50; now += 10) tick();
    now = 80; tick();
    assert.equal(failure, undefined, '30ms local stall must not time out the old 70ms probe');
    assert.notEqual(sent.at(-1).id, old);
    // Answer the current probe so lastActivity advances without relying on a retired id.
    port.emit('message', { type: 'pong', id: sent.at(-1).id });
    assert.equal(rpc.isStalled(), false);
    const aliveAt = now;
    // Silence past heartbeatTimeout soft-stalls without killing.
    while (now < aliveAt + 90) { now += 10; tick(); }
    assert.equal(failure, undefined, 'soft stall must keep the transport open');
    assert.equal(rpc.isStalled(), true);
    assert.equal(stalls.includes(true), true);
    // Silence past heartbeatKillTimeout finally closes.
    while (!failure && now < aliveAt + 400) { now += 10; tick(); }
    assert.equal(failure?.code, 'AGENT_HEARTBEAT_TIMEOUT', 'prolonged silence still kills the peer');
  } finally { rpc.close(); }
});

test('heartbeat soft-stalls before closing a silent live port', async () => {
  const { EventEmitter } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  let failure, stalled;
  const rpc = createRPC(port, () => {}, {
    heartbeatInterval: 10, heartbeatTimeout: 40, heartbeatKillTimeout: 120,
    onClose: error => { failure = error; },
    onStallChange: value => { stalled = value; }
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const pending = rpc.call('stuck');
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(stalled, true, 'first silence window soft-stalls');
    assert.equal(failure, undefined, 'soft stall must not close the transport');
    assert.equal(rpc.isStalled(), true);
    await assert.rejects(pending, { code: 'AGENT_HEARTBEAT_TIMEOUT' });
    assert.equal(failure.code, 'AGENT_HEARTBEAT_TIMEOUT');
  } finally { clearTimeout(keepAlive); rpc.close(); }
});

test('peer RPC traffic clears stall without requiring the matching pong', () => {
  const { EventEmitter } = require('node:events');
  const { runInNewContext } = require('node:vm');
  const { readFileSync } = require('node:fs');
  let now = 0, tick, failure, stalls = [];
  const module = { exports: {} }, port = new EventEmitter();
  port.postMessage = () => {};
  runInNewContext(readFileSync(require.resolve('../../../../harness/ide/runtime/thread-rpc.cjs'), 'utf8'), {
    module, require: () => require('../../../../harness/ide/runtime/errors.cjs'), AbortController, AbortSignal, Promise,
    Date: { now: () => now }, setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval() {}
  });
  const rpc = module.exports.createRPC(port, () => 'ok', {
    heartbeatInterval: 10, heartbeatTimeout: 40, heartbeatKillTimeout: 200,
    onClose: error => { failure = error; },
    onStallChange: stalled => stalls.push(stalled)
  });
  try {
    now = 10; tick();
    for (now = 20; now <= 60; now += 10) tick();
    assert.equal(rpc.isStalled(), true);
    port.emit('message', { type: 'request', id: 1, method: 'snapshot', args: [] });
    assert.equal(rpc.isStalled(), false, 'non-pong traffic proves the peer is alive');
    assert.equal(failure, undefined);
    assert.equal(stalls.at(-1), false);
  } finally { rpc.close(); }
});

test('heartbeat remains responsive even while the request budget is exhausted', async t => {
  const { port1, port2 } = new MessageChannel();
  let release, failed = false;
  const left = createRPC(port1, () => {}, { maxPending: 1, heartbeatInterval: 10, heartbeatTimeout: 80, onClose: () => { failed = true; } });
  const right = createRPC(port2, () => new Promise(resolve => { release = resolve; }), { maxActive: 1 });
  t.after(() => { left.close(); right.close(); port1.close(); port2.close(); });
  const pending = left.call('slow');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(failed, false);
  release('done'); assert.equal(await pending, 'done');
});

test('transport errors reject waiting calls and abort active handlers', async () => {
  const { EventEmitter } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  let signal, release;
  const rpc = createRPC(port, (_method, _args, value) => { signal = value; return new Promise(resolve => { release = resolve; }); });
  const rejected = assert.rejects(rpc.call('pending'), /transport failed/);
  port.emit('message', { type: 'request', id: 1, method: 'work', args: [] });
  port.emit('error', Error('transport failed'));
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(rpc.isIdle(), false);
  release(); await rpc.drain();
  assert.equal(port.listenerCount('message'), 0);
});

test('closing synchronously during send does not leak cancellation listeners', async () => {
  const { EventEmitter, getEventListeners } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => port.emit('close');
  const rpc = createRPC(port, () => {}), controller = new AbortController();
  await assert.rejects(rpc.call('work', [], controller.signal), /port closed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
function pair(t, handler, limits) {
  const { port1, port2 } = new MessageChannel();
  const a = createRPC(port1, () => {}, limits), b = createRPC(port2, handler, limits);
  t.after(() => { a.close(); b.close(); port1.close(); port2.close(); });
  return { a, b, port1, port2 };
}
test('outgoing requests are bounded and capacity returns after completion', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a } = pair(t, () => { entered(); return new Promise(resolve => { release = resolve; }); }, { maxPending: 1 });
  const first = a.call('wait'); await ready;
  await assert.rejects(a.call('overflow'), { code: 'RPC_BUSY' });
  release('ok'); assert.equal(await first, 'ok');
});
test('abort waits for tool cleanup; later replies cannot settle another request', async t => {
  let entered, finish, aborted;
  const ready = new Promise(resolve => { entered = resolve; });
  const sawAbort = new Promise(resolve => { aborted = resolve; });
  const { a } = pair(t, (_method, _args, signal) => new Promise(resolve => {
    signal.addEventListener('abort', aborted, { once: true }); finish = resolve; entered();
  }));
  const controller = new AbortController();
  let settled = false;
  const request = a.call('tool', [], controller.signal).finally(() => { settled = true; });
  await ready; controller.abort(); await sawAbort;
  assert.equal(settled, false, 'edits must finish cleanup before the agent can settle');
  finish('clean'); assert.equal(await request, 'clean');
});
test('uncloneable results reject only that request and the transport stays usable', async t => {
  const { a } = pair(t, method => method === 'bad' ? () => {} : 'ok');
  await assert.rejects(a.call('bad'), /clone/); assert.equal(await a.call('good'), 'ok');
});
test('disconnection rejects pending calls and aborts incoming tools', async t => {
  let entered, aborted;
  const ready = new Promise(resolve => { entered = resolve; });
  const sawAbort = new Promise(resolve => { aborted = resolve; });
  const { a, port1 } = pair(t, (_method, _args, signal) => new Promise(() => {
    signal.addEventListener('abort', aborted, { once: true }); entered();
  }));
  const pending = assert.rejects(a.call('wait'), /closed/); await ready;
  port1.close(); await pending; await sawAbort;
});

test('incoming concurrency rejects excess work before invoking a handler', async t => {
  let entered, release, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a } = pair(t, () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); }, { maxPending: 8, maxActive: 1 });
  const pending = a.call('first'); await ready;
  await assert.rejects(a.call('second'), { code: 'RPC_BUSY' });
  assert.equal(calls, 1); release(); await pending;
});

test('cancel and close retain capacity when both ordinary message budgets are full', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a } = pair(t, method => {
    if (method === 'cancel' || method === 'interruptCommand' || method === 'close') return method;
    entered(); return new Promise(resolve => { release = resolve; });
  }, { maxPending: 1, maxActive: 1 });
  const work = a.call('work'); await ready;
  await assert.rejects(a.call('more'), { code: 'RPC_BUSY' });
  assert.equal(await a.call('cancel'), 'cancel');
  assert.equal(await a.call('interruptCommand'), 'interruptCommand');
  assert.equal(await a.call('close'), 'close');
  release(); await work;
});

test('control capacity is bounded and is reclaimed after a response or clone failure', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a } = pair(t, () => { entered(); return new Promise(resolve => { release = resolve; }); }, { maxControl: 1 });
  await assert.rejects(a.call('cancel', [() => {}]), /clone/);
  const control = a.call('cancel'); await ready;
  await assert.rejects(a.call('cancel'), { code: 'RPC_BUSY' });
  release('stopped'); assert.equal(await control, 'stopped');
});

test('hostile thrown values remain request failures and never close the transport', async t => {
  const failures = [
    { get message() { throw new Error('getter'); }, get code() { throw new Error('getter'); } },
    { message: 'tool failed', code: () => {}, name: { toString() { throw new Error('conversion'); } } },
    new Proxy({}, { get() { throw new Error('proxy'); } }),
    Object.create(null), null, 'plain failure'
  ];
  const { a } = pair(t, method => { if (method === 'ok') return 'alive'; throw failures.shift(); });
  while (failures.length) {
    await assert.rejects(a.call('fail'), error => typeof error.message === 'string');
    assert.equal(await a.call('ok'), 'alive');
  }
});

test('malformed request envelopes get a protocol error rather than hanging', async t => {
  const { a, port1 } = pair(t, () => 'alive');
  const reply = once(port1, 'message');
  port1.postMessage({ type: 'request', id: 9000, method: 'bad', args: {} });
  assert.equal((await reply)[0].error.code, 'RPC_PROTOCOL_ERROR');
  await assert.rejects(a.call('', []), { code: 'RPC_PROTOCOL_ERROR' });
  assert.equal(await a.call('ok'), 'alive');
});

test('malformed responses invalidate the connection instead of releasing capacity for more effects', async t => {
  const { a, port2 } = pair(t, method => method === 'wait' ? new Promise(() => {}) : 'alive', { maxPending: 1 });
  const request = assert.rejects(a.call('wait'), { code: 'RPC_PROTOCOL_ERROR' });
  port2.postMessage({ type: 'response', id: 1 });
  await request;
  await assert.rejects(a.call('ok'), { code: 'RPC_PROTOCOL_ERROR' });
});

test('invalid capacity and heartbeat settings fail before attaching transport listeners', () => {
  const { EventEmitter } = require('node:events');
  for (const settings of [
    { maxPending: NaN }, { maxActive: Infinity }, { maxControl: 0 },
    { maxPending: 1.5 }, { heartbeatInterval: -1 }, { heartbeatInterval: 2147483648 },
    { heartbeatTimeout: NaN }, { heartbeatTimeout: 0 },
    { heartbeatInterval: 10, heartbeatTimeout: 10 },
    { heartbeatInterval: 10, heartbeatTimeout: 20, heartbeatKillTimeout: 10 }
  ]) {
    const port = new EventEmitter(); port.postMessage = () => {};
    assert.throws(() => createRPC(port, () => {}, settings), TypeError);
    assert.deepEqual(port.eventNames(), []);
  }
});

test('protocol failure aborts incoming work and rejects every pending request while retaining cleanup', async () => {
  const { EventEmitter, getEventListeners } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  let release, signal, closed = 0;
  const rpc = createRPC(port, (_method, _args, input) => {
    signal = input; return new Promise(resolve => { release = resolve; });
  }, { onClose: () => { closed++; } });
  const controller = new AbortController();
  const first = assert.rejects(rpc.call('first', [], controller.signal), { code: 'RPC_PROTOCOL_ERROR' });
  const second = assert.rejects(rpc.call('second'), { code: 'RPC_PROTOCOL_ERROR' });
  port.emit('message', { type: 'request', id: 8, method: 'edit', args: [] });
  port.emit('message', { type: 'response', id: 1, value: 'ambiguous', error: { message: 'failed' } });
  await Promise.all([first, second]);
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(closed, 1);
  assert.equal(rpc.isIdle(), false);
  release(); await rpc.drain();
  assert.equal(rpc.isIdle(), true);
});

test('asynchronous disconnect observer failure is contained', async t => {
  const { a } = pair(t, () => {}, { onClose: async () => { throw new Error('observer'); } });
  a.close(); await new Promise(resolve => setImmediate(resolve));
});

test('shutdown has its own bounded slot even when cancellation handlers are stalled', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a } = pair(t, method => {
    if (method === 'close') return 'closed cleanly';
    entered(); return new Promise(resolve => { release = resolve; });
  }, { maxControl: 1 });
  const cancel = a.call('cancel'); await ready;
  await assert.rejects(a.call('cancel'), { code: 'RPC_BUSY' });
  assert.equal(await a.call('close'), 'closed cleanly');
  release(); await cancel;
});

test('falsy close reasons still permanently close the transport', async t => {
  const { a } = pair(t, () => 'should not run');
  a.close(null);
  await assert.rejects(a.call('work'), /Agent operation failed/);
});

test('closing the transport retains a barrier for handlers still cleaning up', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const { a, b } = pair(t, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const rejected = assert.rejects(a.call('edit'), /closed/); await ready;
  b.close(); a.close(); await rejected;
  assert.equal(b.isIdle(), false);
  let drained = false;
  const cleanup = b.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await cleanup;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(b.isIdle(), true);
});

test('cancellation during payload cloning is not lost before listener registration', { timeout: 2000 }, async t => {
  const controller = new AbortController();
  const { a } = pair(t, (_method, _args, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const payload = { get value() { controller.abort(new Error('cancelled while cloning')); return 1; } };
  await assert.rejects(a.call('work', [payload], controller.signal), /cancelled while cloning/);
});

test('retired request IDs cannot replay completed effects', async () => {
  const { EventEmitter } = require('node:events');
  const port = new EventEmitter(); port.postMessage = () => {};
  let writes = 0, failure;
  const rpc = createRPC(port, () => { writes++; }, { onClose: error => { failure = error; } });
  const request = { type: 'request', id: 1, method: 'write', args: [] };
  port.emit('message', request); await rpc.drain();
  port.emit('message', request); await rpc.drain();
  assert.equal(writes, 1);
  assert.equal(failure.code, 'RPC_PROTOCOL_ERROR');
});

test('payload getter reentrancy preserves wire order and cannot exceed reserved capacity', async t => {
  const observed = [];
  const { a } = pair(t, method => { observed.push(method); return method; }, { maxPending: 2 });
  let nested;
  const payload = { get value() { nested = a.call('nested'); return 1; } };
  assert.equal(await a.call('outer', [payload]), 'outer');
  assert.equal(await nested, 'nested');
  assert.deepEqual(observed, ['nested', 'outer']);
  let blocked;
  const { a: limited } = pair(t, () => 'ok', { maxPending: 1 });
  const constrained = { get value() { blocked = assert.rejects(limited.call('nested'), { code: 'RPC_BUSY' }); return 1; } };
  assert.equal(await limited.call('outer', [constrained]), 'ok'); await blocked;
});
