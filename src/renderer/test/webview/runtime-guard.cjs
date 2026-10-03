'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  let now = 0, sequence = 0;
  const timers = new Map(), sent = [];
  const window = new EventTarget(), document = new EventTarget();
  document.hidden = false; document.body = { dataset: {} };
  const ids = ['runtime-recovery', 'runtime-recovery-message', 'runtime-resync', 'runtime-reload', 'route-loading'];
  const elements = Object.fromEntries(ids.map(id => [id, Object.assign(new EventTarget(), { hidden: true, disabled: false, textContent: '' })]));
  document.getElementById = id => elements[id];
  const api = { postMessage: value => sent.push(value) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../webview/runtime-guard.js'), 'utf8'), {
    window, document, Event, Date: { now: () => now }, acquireVsCodeApi: () => api,
    setInterval: callback => { timers.set(++sequence, callback); return sequence; }, clearInterval: id => timers.delete(id)
  });
  return { window, document, api, sent, elements, guard: window.UBOVMRuntime, timers,
    click(id) { if (!elements[id].disabled) elements[id].dispatchEvent(new Event('click')); },
    tick(value) { now = value; for (const callback of [...timers.values()]) callback(); } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('successful paint invalidates old sync failure without invalidating the next recovery request', async () => {
  const f = fixture(); const rejects = [];
  f.api.postMessage = () => new Promise((_, reject) => rejects.push(reject));
  f.click('runtime-resync'); f.guard.painted();
  f.click('runtime-resync');
  rejects[0](Error('obsolete sync')); await settle();
  assert.equal(f.elements['runtime-recovery'].hidden, true);
  rejects[1](Error('current sync')); await settle();
  assert.equal(f.elements['runtime-recovery'].hidden, false);
  f.guard.painted();
  f.click('runtime-resync'); f.guard.painted();
  rejects[2](Error('already painted')); await settle();
  assert.equal(f.elements['runtime-recovery'].hidden, true);
});

test('clock rollback cannot strand startup, update or reload recovery deadlines', () => {
  for (const phase of ['startup', 'update', 'reload']) {
    const f = fixture(); f.tick(10000);
    if (phase !== 'startup') f.guard.painted();
    if (phase === 'update') f.guard.pending();
    if (phase === 'reload') f.click('runtime-reload');
    f.tick(-3600000);
    assert.equal(f.elements['runtime-recovery'].hidden, true);
    f.tick(-3585000);
    assert.equal(f.elements['runtime-recovery'].hidden, false, phase);
    if (phase === 'reload') {
      assert.equal(f.elements['runtime-reload'].disabled, false);
      assert.equal(f.sent.length, 1);
    }
  }
});

test('hidden recovery watchdog releases its interval and restores only one clock', () => {
  const f = fixture(); f.guard.painted();
  assert.equal(f.timers.size, 1);
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.timers.size, 0);
  f.document.dispatchEvent(new Event('visibilitychange'));
  f.window.dispatchEvent(new Event('pagehide'));
  f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(f.timers.size, 0, 'restoring a still-hidden page must not start polling');
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  f.document.dispatchEvent(new Event('visibilitychange'));
  f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(f.timers.size, 1);
  f.window.dispatchEvent(new Event('pagehide'));
  f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.timers.size, 0, 'a disposed page must not recreate its interval');
});

test('false and rejected bridge deliveries release reload controls without unhandled rejections', async () => {
  for (const outcome of [false, Promise.reject(Error('not delivered'))]) {
    const f = fixture(); f.api.postMessage = () => outcome;
    f.click('runtime-reload'); await settle();
    assert.equal(f.elements['runtime-reload'].disabled, false);
    assert.match(f.elements['runtime-recovery-message'].textContent, /页面连接不可用/);
  }
});

test('save exceptions prevent reload, rapid retries serialize and unanswered reloads time out', () => {
  const f = fixture();
  f.guard.saveDrafts = () => { throw Error('save fault'); };
  f.click('runtime-reload'); assert.equal(f.sent.length, 0);
  f.guard.saveDrafts = () => true;
  f.click('runtime-reload'); f.click('runtime-reload');
  assert.equal(f.sent.length, 1);
  f.guard.painted(); f.tick(15000);
  assert.equal(f.elements['runtime-reload'].disabled, false);
  assert.match(f.elements['runtime-recovery-message'].textContent, /重新加载未完成/);
});

test('stale send rejections cannot override later sends or a restored page generation', async () => {
  const f = fixture(); let reject;
  f.api.postMessage = () => new Promise((_, fail) => { reject = fail; });
  f.click('runtime-resync');
  f.api.postMessage = () => true; f.click('runtime-resync'); f.guard.painted();
  reject(Error('old send')); await settle();
  assert.equal(f.elements['runtime-recovery'].hidden, true);
  f.api.postMessage = () => new Promise((_, fail) => { reject = fail; });
  f.click('runtime-resync');
  f.window.dispatchEvent(new Event('pagehide')); f.window.dispatchEvent(new Event('pageshow')); f.guard.painted();
  reject(Error('old generation')); await settle();
  assert.equal(f.elements['runtime-recovery'].hidden, true);
  assert.equal(f.timers.size, 1);
});

test('zero-clock render deadlines survive repeated visibility notifications and pause while hidden', () => {
  const f = fixture(); f.guard.painted(); f.guard.pending();
  f.tick(10000); f.document.dispatchEvent(new Event('visibilitychange'));
  f.tick(15000); assert.equal(f.elements['runtime-recovery'].hidden, false);
  f.guard.painted(); f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  f.guard.pending(); f.tick(100000); assert.equal(f.elements['runtime-recovery'].hidden, true);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  f.tick(110000); assert.equal(f.elements['runtime-recovery'].hidden, true);
  f.tick(115000); assert.equal(f.elements['runtime-recovery'].hidden, false);
});

test('reload deadlines exclude hidden time and duplicate visibility cannot postpone timeout', () => {
  const f = fixture(); f.guard.painted(); f.click('runtime-reload');
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  f.tick(100000);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  f.tick(105000);
  assert.equal(f.elements['runtime-reload'].disabled, true);
  assert.equal(f.elements['runtime-recovery'].hidden, true);
  f.document.dispatchEvent(new Event('visibilitychange'));
  f.tick(115000);
  assert.equal(f.elements['runtime-reload'].disabled, false);
  assert.match(f.elements['runtime-recovery-message'].textContent, /重新加载未完成/);
  assert.equal(f.sent.length, 1, 'restoring the page never replays the reload request');
});

test('page restoration starts a fresh visible reload deadline without replaying the request', () => {
  const f = fixture(); f.guard.painted(); f.click('runtime-reload');
  f.window.dispatchEvent(new Event('pagehide')); f.tick(100000);
  f.window.dispatchEvent(new Event('pageshow'));
  f.window.dispatchEvent(new Event('pageshow'));
  f.tick(105000);
  assert.equal(f.elements['runtime-reload'].disabled, true);
  assert.equal(f.elements['runtime-recovery'].hidden, true);
  assert.equal(f.timers.size, 1);
  f.tick(115000);
  assert.equal(f.elements['runtime-reload'].disabled, false);
  assert.equal(f.sent.length, 1);
});
