import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWindowRendering } from '../window-rendering.mjs';

test('restoration and wake repaint immediately and on delayed surface restoration, without navigation', () => {
  const app = Object.assign(new EventEmitter(), { isReady: () => false });
  const powerMonitor = new EventEmitter(), timers = new Map(), warnings = [];
  let next = 0, paints = 0;
  installWindowRendering({ app, powerMonitor, schedule: fn => { timers.set(++next, fn); return next; },
    cancel: id => timers.delete(id), log: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) } });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, invalidate: () => paints++ });
  const win = Object.assign(new EventEmitter(), { id: 1, visible: true, destroyed: false, webContents: contents,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized: () => false });
  app.emit('browser-window-created', {}, win);
  assert.equal(powerMonitor.listenerCount('resume'), 0);
  app.emit('ready');
  for (const event of ['show', 'restore', 'focus', 'responsive']) win.emit(event);
  assert.equal(paints, 4); assert.equal(timers.size, 2);
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  flush(); assert.equal(paints, 6);
  win.visible = false; powerMonitor.emit('resume'); flush(); assert.equal(paints, 6);
  win.visible = true; powerMonitor.emit('unlock-screen'); flush(); assert.equal(paints, 9);
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' }); flush(); assert.equal(paints, 12);
  contents.emit('render-process-gone', {}, { reason: 'oom' }); assert.equal(warnings.length, 2);
  win.emit('focus'); win.destroyed = true; win.emit('closed');
  assert.equal(timers.size, 0); assert.equal(win.listenerCount('focus'), 0);
  powerMonitor.emit('resume'); assert.equal(paints, 13);
  app.emit('quit'); assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('quit before ready removes wake hooks', () => {
  const app = Object.assign(new EventEmitter(), { isReady: () => false }), powerMonitor = new EventEmitter();
  const dispose = installWindowRendering({ app, powerMonitor });
  dispose(); app.emit('ready'); assert.equal(powerMonitor.listenerCount('resume'), 0);
});
