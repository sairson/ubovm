import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWindowRendering } from '../window-rendering.mjs';

function harness({ visible = true, keepAliveMs = 20000 } = {}) {
  const app = Object.assign(new EventEmitter(), { isReady: () => false });
  const powerMonitor = new EventEmitter(), timers = new Map(), loops = new Map(), warnings = [], infos = [];
  let next = 0, paints = 0, nudges = 0, transitions = 0, clock = 0;
  installWindowRendering({
    app, powerMonitor, keepAliveMs, now: () => clock,
    schedule: fn => { timers.set(++next, fn); return next; },
    cancel: id => timers.delete(id),
    interval: fn => { loops.set(++next, fn); return next; },
    clearLoop: id => loops.delete(id),
    log: {
      warn: (...args) => warnings.push(args),
      error: (...args) => warnings.push(args),
      info: (...args) => infos.push(args),
    },
  });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, invalidate: () => paints++ });
  const win = Object.assign(new EventEmitter(), {
    id: 1, visible, destroyed: false, minimized: false, maximized: false, fullscreen: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 }, webContents: contents,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    isMaximized() { return this.maximized; }, isFullScreen() { return this.fullscreen; },
    getBounds() { return { ...this.bounds }; },
    setBounds(bounds) { this.bounds = { ...bounds }; nudges++; },
    unmaximize() { this.maximized = false; transitions++; },
    maximize() { this.maximized = true; transitions++; },
  });
  app.emit('browser-window-created', {}, win);
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  const tickKeepAlive = () => { for (const fn of [...loops.values()]) fn(); };
  return { app, powerMonitor, win, contents, timers, loops, warnings, infos, flush, tickKeepAlive,
    paints: () => paints, nudges: () => nudges, transitions: () => transitions, setClock: value => { clock = value; } };
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

test('window resizes and unresponsive renderers repaint the surface', () => {
  const f = harness();
  f.app.emit('ready');
  const before = f.paints();
  f.win.emit('resized');
  assert.equal(f.paints(), before + 1, 'a resize repaints immediately');
  f.flush();
  assert.equal(f.paints(), before + 3, 'a resize also schedules delayed surface repaints');
  const base = f.paints();
  f.win.emit('unresponsive');
  assert.equal(f.paints(), base + 1, 'an unresponsive renderer repaints instead of only logging');
  assert.ok(f.warnings.some(args => String(args[0]).includes('unresponsive')));
  f.flush();
  assert.equal(f.nudges(), 2, 'an unresponsive renderer rebuilds the native surface');
});

test('idle focus, wake and the keyboard escape hatch rebuild a lost native surface', () => {
  const f = harness();
  f.app.emit('ready');
  f.win.emit('focus'); f.flush();
  assert.equal(f.nudges(), 0, 'a normal focus keeps the window geometry');
  f.win.emit('blur');
  f.setClock(60000);
  f.win.emit('focus'); f.flush();
  assert.equal(f.nudges(), 2, 'returning after an idle period resizes the pending surface');
  assert.deepEqual(f.win.bounds, { x: 0, y: 0, width: 800, height: 600 }, 'the nudge restores the exact bounds');
  f.setClock(90000);
  f.powerMonitor.emit('resume'); f.flush();
  assert.equal(f.nudges(), 4, 'wake/resume rebuilds the surface too');
  assert.deepEqual(f.win.bounds, { x: 0, y: 0, width: 800, height: 600 });
  f.setClock(95000);
  let prevented = false;
  f.contents.emit('before-input-event', { preventDefault: () => { prevented = true; } },
    { type: 'keyDown', control: true, alt: true, key: 'r' });
  assert.equal(prevented, true);
  assert.equal(f.nudges(), 6, 'Ctrl+Alt+R forces an immediate rebuild even without an idle gap');
  assert.ok(f.infos.some(args => String(args[0]).includes('Rebuilt')));
});

test('a maximized window rebuilds through the maximize transition without moving bounds', () => {
  const f = harness();
  f.app.emit('ready');
  f.win.maximized = true;
  const bounds = { ...f.win.bounds };
  f.win.emit('blur');
  f.setClock(60000);
  f.win.emit('focus'); f.flush();
  assert.equal(f.transitions(), 2, 'maximized windows unmaximize and maximize instead of resizing');
  assert.equal(f.nudges(), 0);
  assert.deepEqual(f.win.bounds, bounds);
  assert.equal(f.win.maximized, true);
});

test('quit before ready removes wake hooks', () => {
  const app = Object.assign(new EventEmitter(), { isReady: () => false }), powerMonitor = new EventEmitter();
  const dispose = installWindowRendering({ app, powerMonitor });
  dispose(); app.emit('ready'); assert.equal(powerMonitor.listenerCount('resume'), 0);
});
