import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlankSurfaceWatchdog, measureUnpaintedRatio, UNPAINTED_CHANNEL, DEFAULT_UNPAINTED_RATIO } from '../paint-probe.mjs';

const image = (width, height, fill) => {
  const bitmap = Buffer.alloc(width * height * 4, 0);
  if (typeof fill === 'number') bitmap.fill(fill);
  return {
    getSize: () => ({ width, height }),
    getBitmap: () => bitmap
  };
};

test('an unpainted surface is a large exact-gray area, not a lightly gray one', () => {
  const W = 400, H = 300;
  assert.equal(measureUnpaintedRatio(Buffer.alloc(W * H * 4, UNPAINTED_CHANNEL), W, H), 1, 'a fully unpainted frame reads as gray');
  assert.equal(measureUnpaintedRatio(Buffer.alloc(W * H * 4, 255), W, H), 0, 'white surfaces never read as unpainted');
  assert.equal(measureUnpaintedRatio(Buffer.alloc(W * H * 4, 0), W, H), 0, 'black surfaces never read as unpainted');
  // An anti-aliased/hairline pattern is not mistaken for the flat missing surface.
  const textured = Buffer.alloc(W * H * 4);
  for (let index = 0; index < textured.length; index += 4) {
    const value = (index / 4) % 2 ? UNPAINTED_CHANNEL : 80;
    textured[index] = value; textured[index + 1] = value; textured[index + 2] = value;
  }
  assert.ok(measureUnpaintedRatio(textured, W, H) < DEFAULT_UNPAINTED_RATIO, 'alternating pixels stay below the threshold');
  // Half the frame unpainted: below the default ratio, so a partially covered
  // surface (a preview image with gray) cannot reload the window on its own.
  const half = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H / 2; y++) half.fill(UNPAINTED_CHANNEL, y * W * 4, (y + 1) * W * 4, 0);
  const halfRatio = measureUnpaintedRatio(half, W, H, { margin: 0, stride: 1 });
  assert.ok(Math.abs(halfRatio - 0.5) < 0.02, 'half-painted frames are measurable: ' + halfRatio);
  assert.ok(halfRatio >= DEFAULT_UNPAINTED_RATIO, 'a flat gray half-frame is still detected');
  assert.equal(measureUnpaintedRatio(Buffer.alloc(4), W, H), 0, 'short buffers are rejected');
  assert.equal(measureUnpaintedRatio(null, W, H), 0, 'missing buffers are rejected');
});

function harness(overrides = {}) {
  let clock = 0, next = 0, captures = 0, repaints = 0, rebuilds = 0, reloads = 0;
  const loops = new Map();
  const warnings = [], infos = [], errors = [];
  let blank = true;
  const watch = createBlankSurfaceWatchdog({
    capture: () => { captures += 1; return image(400, 300, blank ? UNPAINTED_CHANNEL : 255); },
    repaint: () => { repaints += 1; },
    rebuild: () => { rebuilds += 1; overrides.afterRebuild?.(); },
    reload: () => { reloads += 1; },
    visible: () => true,
    loading: () => false,
    log: {
      warn: (...args) => warnings.push(args),
      info: (...args) => infos.push(args),
      error: (...args) => errors.push(args)
    },
    now: () => clock,
    interval: fn => { loops.set(++next, fn); return next; },
    clearLoop: id => loops.delete(id),
    settleMs: 1,
    ...overrides
  });
  return {
    watch, loops, warnings, infos, errors,
    advance(ms) { clock += ms; },
    setBlank(value) { blank = value; },
    counts: () => ({ captures, repaints, rebuilds, reloads }),
    async tick() { for (const fn of [...loops.values()]) fn(); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
}

test('three blank samples rebuild the surface and reload only when it stays blank', async () => {
  const h = harness({ samples: 3, startDelayMs: 0, cooldownMs: 0 });
  h.watch.start();
  h.advance(1);
  await h.tick();
  assert.deepEqual(h.counts(), { captures: 1, repaints: 0, rebuilds: 0, reloads: 0 }, 'one blank sample is not enough');
  await h.tick();
  assert.equal(h.counts().captures, 2);
  await h.tick();
  // Third sample confirms the blank frame, then the settle probe still reads blank.
  assert.equal(h.counts().repaints, 1, 'a confirmed blank frame repaints first');
  assert.equal(h.counts().rebuilds, 1, 'and rebuilds the native surface');
  assert.equal(h.counts().reloads, 1, 'the window is reloaded when the surface stays blank');
  assert.ok(h.warnings.some(args => String(args[0]).includes('not painted')));
});

test('a repainted surface stops the ladder before reloading the window', async () => {
  let h;
  // The geometry nudge heals the surface before the settle probe runs.
  h = harness({ samples: 2, startDelayMs: 0, cooldownMs: 0, afterRebuild: () => h.setBlank(false) });
  h.watch.start();
  h.advance(1);
  await h.tick();
  await h.tick();
  assert.deepEqual(h.counts(), { captures: 3, repaints: 1, rebuilds: 1, reloads: 0 });
  assert.ok(h.infos.some(args => String(args[0]).includes('repainted')));
});

test('a normally painted window is never touched', async () => {
  const h = harness({ samples: 2, startDelayMs: 0, cooldownMs: 0 });
  h.setBlank(false);
  h.watch.start();
  h.advance(1);
  for (let round = 0; round < 5; round++) await h.tick();
  assert.equal(h.counts().captures, 5);
  assert.deepEqual([h.counts().repaints, h.counts().rebuilds, h.counts().reloads], [0, 0, 0]);
});

test('probing waits for the startup delay and respects the cooldown after an attempt', async () => {
  const h = harness({ samples: 1, startDelayMs: 10000, cooldownMs: 60000 });
  h.watch.start();
  h.advance(5000);
  await h.tick();
  assert.equal(h.counts().captures, 0, 'no capture before the window had time to paint');
  h.advance(6000);
  await h.tick();
  assert.equal(h.counts().repaints, 1, 'the first confirmation recovers');
  h.advance(30000);
  await h.tick();
  assert.equal(h.counts().repaints, 1, 'the cooldown keeps a recovery from looping');
});

test('the reload budget is finite and reported', async () => {
  const h = harness({ samples: 1, startDelayMs: 0, cooldownMs: 0, maxReloads: 2 });
  h.watch.start();
  h.advance(1);
  await h.tick();
  await h.tick();
  assert.equal(h.counts().reloads, 2);
  await h.tick();
  assert.equal(h.counts().reloads, 2, 'no reload loops past the budget');
  assert.ok(h.errors.some(args => String(args[0]).includes('manually')));
});

test('hidden or loading windows are not sampled, and pause stops the probe loop', async () => {
  let visible = true, loading = false;
  const h = harness({ samples: 1, startDelayMs: 0, cooldownMs: 0, visible: () => visible, loading: () => loading });
  h.watch.start();
  h.advance(1);
  visible = false;
  await h.tick();
  assert.equal(h.counts().captures, 0, 'a hidden window is never captured');
  visible = true; loading = true;
  await h.tick();
  assert.equal(h.counts().captures, 0, 'a loading window is never captured');
  loading = false;
  h.watch.pause();
  assert.equal(h.loops.size, 0, 'pause stops the sampling loop');
  await h.tick();
  assert.equal(h.counts().captures, 0);
  h.watch.start();
  assert.equal(h.loops.size, 1, 'start re-arms the probe');
});

test('the probe reports its ratio when debug logging is on', async () => {
  const h = harness({ samples: 1, startDelayMs: 0, cooldownMs: 0, debug: true });
  h.watch.start();
  h.advance(1);
  await h.tick();
  assert.ok(h.infos.some(args => String(args[0]).includes('Paint probe')), 'debug builds explain the measurement');
});
