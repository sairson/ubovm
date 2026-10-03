import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWindowRendering } from '../window-rendering.mjs';

function harness({ visible = true, keepAliveMs = 20000 } = {}) {
  const app = Object.assign(new EventEmitter(), { isReady: () => false });
  const powerMonitor = new EventEmitter(), timers = new Map(), loops = new Map(), warnings = [];
  let next = 0, paints = 0, clock = 0;
  installWindowRendering({
    app, powerMonitor, keepAliveMs, now: () => clock,
    schedule: fn => { timers.set(++next, fn); return next; },
    cancel: id => timers.delete(id),
    interval: fn => { loops.set(++next, fn); return next; },
    clearLoop: id => loops.delete(id),
    log: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, invalidate: () => paints++ });
  const win = Object.assign(new EventEmitter(), {
    id: 1, visible, destroyed: false, minimized: false, webContents: contents,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
  });
  app.emit('browser-window-created', {}, win);
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  const tickKeepAlive = () => { for (const fn of [...loops.values()]) fn(); };
  return { app, powerMonitor, win, contents, timers, loops, warnings, flush, tickKeepAlive,
    paints: () => paints, setClock: value => { clock = value; } };
}

test('restoration and wake repaint immediately and on delayed surface restoration, without navigation', () => {
  const f = harness();
  assert.equal(f.powerMonitor.listenerCount('resume'), 0);
  f.app.emit('ready');
  assert.equal(f.loops.size, 1);
  for (const event of ['show', 'restore', 'focus', 'responsive']) f.win.emit(event);
  assert.equal(f.paints(), 4); assert.equal(f.timers.size, 2); assert.equal(f.loops.size, 1);
  f.flush(); assert.equal(f.paints(), 6);
  f.win.visible = false; f.powerMonitor.emit('resume'); f.flush(); assert.equal(f.paints(), 6); assert.equal(f.loops.size, 0);
  f.win.visible = true; f.powerMonitor.emit('unlock-screen'); f.flush(); assert.equal(f.paints(), 9); assert.equal(f.loops.size, 1);
  f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' }); f.flush(); assert.equal(f.paints(), 12);
  f.contents.emit('render-process-gone', {}, { reason: 'oom' }); assert.equal(f.warnings.length, 2);
  f.win.emit('focus'); f.win.destroyed = true; f.win.emit('closed');
  assert.equal(f.timers.size, 0); assert.equal(f.loops.size, 0); assert.equal(f.win.listenerCount('focus'), 0);
  f.powerMonitor.emit('resume'); assert.equal(f.paints(), 13);
  f.app.emit('quit'); assert.equal(f.powerMonitor.listenerCount('resume'), 0);
});

test('idle windows keep the compositor alive and wake on first input without navigation', () => {
  const f = harness({ keepAliveMs: 1000 });
  f.app.emit('ready');
  assert.equal(f.paints(), 0); assert.equal(f.loops.size, 1);
  f.tickKeepAlive(); assert.equal(f.paints(), 1);
  f.contents.emit('before-input-event'); assert.equal(f.paints(), 1);
  f.setClock(1000); f.contents.emit('before-input-event');
  assert.equal(f.paints(), 2); assert.equal(f.timers.size, 2);
  f.flush(); assert.equal(f.paints(), 4);
  f.win.minimized = true; f.win.emit('minimize');
  assert.equal(f.loops.size, 0); f.tickKeepAlive(); assert.equal(f.paints(), 4);
  f.win.minimized = false; f.win.emit('restore'); f.flush();
  assert.equal(f.paints(), 7); assert.equal(f.loops.size, 1);
  f.win.visible = false; f.win.emit('hide');
  assert.equal(f.loops.size, 0); f.tickKeepAlive(); assert.equal(f.paints(), 7);
});

test('quit before ready removes wake hooks', () => {
  const app = Object.assign(new EventEmitter(), { isReady: () => false }), powerMonitor = new EventEmitter();
  const dispose = installWindowRendering({ app, powerMonitor });
  dispose(); app.emit('ready'); assert.equal(powerMonitor.listenerCount('resume'), 0);
});
