'use strict';

// A webview's out-of-process renderer can die or stop producing frames while the
// workbench keeps its iframe element in place. The workbench has no webview crash
// or load handling of its own, so the panel keeps an unpainted (flat gray) surface
// and the extension host is never told: messages are simply queued forever and the
// panel rectangle stays where it was. The page heartbeat is the only liveness
// signal the host has, and only a new panel creates a new renderer, so recovery is
// staged from cheap to decisive:
//
//   1. softReload   re-render the page (new nonce); heals a page that stopped
//                   painting while its renderer still runs.
//   2. nudgeLayout  resize the editor group twice; a geometry change is the
//                   cheapest way to make Chromium re-create a dropped surface.
//   3. rebuildPanel dispose and re-create the panel; the only action that builds
//                   a new out-of-process iframe, so the only one that recovers a
//                   dead renderer.
//
// If none of them helps the user gets an explicit escape (reload the window)
// instead of a silently broken page. Policy lives here and the clock plus the
// actions are injected, which keeps the state machine deterministic in tests.
//
// The caller must:
//   - call message() for every message from the webview (heartbeats included),
//   - call pause() while the panel is hidden and resume() when it is visible,
//   - call tick() on a short interval,
//   - reset() whenever a new page is loaded or the panel is rebuilt.

const STAGES = Object.freeze(['softReload', 'nudgeLayout', 'rebuildPanel']);

function createWebviewLiveness({
  now = Date.now,
  // Silence after a heartbeat is a dead or frozen renderer: five-second beats make
  // long runs of normal silence impossible, while a genuinely blocked render with
  // a huge conversation would still have to stay stuck for this long.
  silentMs = 15000,
  // Frames stopped while messages keep arriving: the renderer runs but receives no
  // BeginFrames, i.e. the compositor surface is gone.
  stalledMs = 12000,
  // Minimum gap between staged attempts, so a single stall can run the whole ladder
  // and never hammers the workbench.
  promoteMs = 8000,
  // A page that keeps beating for this long after an attempt is considered healed;
  // the ladder resets so a later, unrelated stall starts from the cheapest stage.
  stableMs = 25000,
  maxAttempts = STAGES.length,
  onStage = () => {},
  onGiveUp = () => {}
} = {}) {
  let createdAt = 0;
  let lastMessageAt = 0;
  let lastHeartbeatAt = 0;
  let stalledSince = 0;
  let attempt = 0;
  let lastAttemptAt = 0;
  let gaveUp = false;
  let paused = false;

  function reset() {
    createdAt = now();
    lastMessageAt = createdAt;
    lastHeartbeatAt = 0;
    stalledSince = 0;
    attempt = 0;
    lastAttemptAt = 0;
    gaveUp = false;
    paused = false;
  }

  reset();

  return {
    reset,
    pause() {
      if (paused) return;
      paused = true;
      // Hidden panels legitimately stop producing frames; do not carry that state
      // into the next visible period.
      stalledSince = 0;
    },
    resume() {
      if (!paused) return;
      paused = false;
      lastMessageAt = now();
      stalledSince = 0;
    },
    message({ stalled = false } = {}) {
      lastMessageAt = now();
      lastHeartbeatAt = lastMessageAt;
      if (paused) { stalledSince = 0; return; }
      if (!stalled) { stalledSince = 0; return; }
      if (!stalledSince) stalledSince = lastMessageAt;
    },
    tick() {
      if (paused || gaveUp) return undefined;
      const at = now();
      // A page that has been healthy long enough after an attempt clears the ladder.
      if (attempt > 0 && lastAttemptAt && at - lastAttemptAt >= stableMs && at - lastMessageAt < silentMs) {
        attempt = 0;
        lastAttemptAt = 0;
      }
      const silent = at - lastMessageAt;
      const stalled = stalledSince ? at - stalledSince : 0;
      if (silent < silentMs && stalled < stalledMs) return undefined;
      if (attempt >= maxAttempts) {
        gaveUp = true;
        onGiveUp({ silent, stalled, attempts: attempt });
        return undefined;
      }
      if (lastAttemptAt && at - lastAttemptAt < promoteMs) return undefined;
      const stage = STAGES[attempt];
      attempt += 1;
      lastAttemptAt = at;
      onStage(stage, { silent, stalled, attempt });
      return stage;
    },
    state() {
      return {
        attempt,
        gaveUp,
        paused,
        silent: now() - lastMessageAt,
        stalled: stalledSince ? now() - stalledSince : 0,
        sinceLoad: now() - createdAt,
        lastHeartbeatAt
      };
    }
  };
}

module.exports = { createWebviewLiveness, STAGES };
