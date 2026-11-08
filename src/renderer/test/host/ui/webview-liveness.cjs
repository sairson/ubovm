'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewLiveness, STAGES } = require('../../../host/ui/webview-liveness.cjs');

// Deterministic clock so the staged policy can be exercised without timers.
function harness(options = {}) {
  let now = 0;
  const stages = [];
  const giveUps = [];
  const liveness = createWebviewLiveness({
    now: () => now,
    onStage: (stage, detail) => stages.push({ stage, detail }),
    onGiveUp: detail => giveUps.push(detail),
    ...options
  });
  return {
    liveness,
    stages,
    giveUps,
    advance(ms) { now += ms; return now; },
    at(ms) { now = ms; return now; }
  };
}

test('a silent page walks the staged recovery ladder and then gives up', () => {
  const h = harness();
  h.liveness.reset();
  assert.equal(h.liveness.tick(), undefined, 'nothing happens before the silence threshold');
  h.advance(14999);
  assert.equal(h.liveness.tick(), undefined);
  h.advance(1);
  assert.equal(h.liveness.tick(), 'softReload', 'silence reaches the first stage');
  assert.deepEqual(h.stages.map(s => s.stage), ['softReload']);
  // A stage is not repeated before the promotion window, whatever the streak.
  h.advance(7999);
  assert.equal(h.liveness.tick(), undefined);
  h.advance(1);
  assert.equal(h.liveness.tick(), 'nudgeLayout');
  h.advance(8000);
  assert.equal(h.liveness.tick(), 'rebuildPanel');
  h.advance(8000);
  assert.equal(h.liveness.tick(), undefined, 'the ladder is exhausted');
  assert.equal(h.giveUps.length, 1, 'the user is told exactly once');
  h.advance(60000);
  assert.equal(h.liveness.tick(), undefined);
  assert.equal(h.giveUps.length, 1);
});

test('regular heartbeats never trigger recovery', () => {
  const h = harness();
  h.liveness.reset();
  for (let beat = 0; beat < 40; beat++) {
    h.advance(5000);
    h.liveness.message({ stalled: false });
    assert.equal(h.liveness.tick(), undefined, 'beat ' + beat);
  }
  assert.deepEqual(h.stages, []);
  assert.deepEqual(h.giveUps, []);
});

test('a page that reports missing frames recovers even while it still posts', () => {
  const h = harness();
  h.liveness.reset();
  let fired = false;
  for (let beat = 0; beat < 6 && !fired; beat++) {
    h.advance(5000);
    h.liveness.message({ stalled: true });
    fired = h.liveness.tick() === 'softReload';
  }
  assert.equal(fired, true, 'stalled frames alone reach the first stage');
  assert.deepEqual(h.stages.map(s => s.stage), ['softReload']);
  // A single healthy frame report clears the stall streak: the next stall has to
  // grow from zero again instead of reusing the old duration.
  h.liveness.message({ stalled: false });
  assert.equal(h.liveness.state().stalled, 0);
  h.advance(5000);
  h.liveness.message({ stalled: true });
  h.advance(5000);
  h.liveness.message({ stalled: true });
  assert.ok(h.liveness.state().stalled < 12000, 'the new stall is measured from its own start');
});

test('hidden panels are not probed and do not accumulate failure', () => {
  const h = harness();
  h.liveness.reset();
  h.liveness.pause();
  h.advance(120000);
  assert.equal(h.liveness.tick(), undefined, 'a hidden panel legitimately paints nothing');
  h.liveness.resume();
  h.advance(14999);
  assert.equal(h.liveness.tick(), undefined, 'resuming restarts the silence window');
  h.advance(1);
  assert.equal(h.liveness.tick(), 'softReload');
});

test('a healed page clears the ladder so a later stall starts cheap again', () => {
  const h = harness();
  h.liveness.reset();
  h.advance(15000);
  assert.equal(h.liveness.tick(), 'softReload');
  // The page comes back and keeps beating for longer than the stable window.
  for (let beat = 0; beat < 6; beat++) {
    h.advance(5000);
    h.liveness.message({ stalled: false });
    h.liveness.tick();
  }
  assert.equal(h.liveness.state().attempt, 0, 'a stable page resets the ladder');
  h.advance(15000);
  assert.equal(h.liveness.tick(), 'softReload', 'the next stall restarts from the first stage');
  assert.deepEqual(h.stages.map(s => s.stage), ['softReload', 'softReload']);
});

test('reset re-arms the policy after the ladder was exhausted', () => {
  const h = harness();
  h.liveness.reset();
  for (let n = 0; n < STAGES.length; n++) {
    h.advance(15000);
    h.liveness.tick();
  }
  h.advance(15000);
  h.liveness.tick();
  assert.equal(h.giveUps.length, 1);
  h.liveness.reset();
  h.advance(15000);
  assert.equal(h.liveness.tick(), 'softReload', 'a rebuilt panel gets a fresh ladder');
});
