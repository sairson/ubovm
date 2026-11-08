// Ground-truth detection for a window that keeps rendering nothing.
//
// The workbench has no webview crash/load handling: when a webview renderer dies
// or loses its compositor surface, the iframe keeps its rectangle and Chromium
// fills the missing surface with the uninitialized shared-memory gray
// (rgb(128,128,128)). The page cannot report that (a dead renderer cannot post and
// a frozen one cannot run timers), so a pixel probe of the committed frame is the
// only reliable signal. It also works while the renderer is hung, when no
// extension-host command can be executed.
//
// Recovery is the same ladder the window compositor already uses: repaint, rebuild
// the native surface with the smallest geometry change, then reload the window as
// the last resort. Probes are cheap (every few seconds, coarse stride) and only run
// while the window is visible and not loading.

export const UNPAINTED_CHANNEL = 128;
// A healthy UBOVM surface never contains a large #808080 area: the palette uses
// near-white and near-black surfaces. The observed failure covers the whole editor
// area, i.e. well over half of the window, so a high threshold keeps image
// previews and other incidental gray surfaces from triggering a reload.
export const DEFAULT_UNPAINTED_RATIO = 0.35;

// Bitmap buffers from Electron's NativeImage are BGRA on Windows/Linux and RGBA on
// macOS; the three color channels are compared separately, so the order only has
// to be consistent within one call.
export function measureUnpaintedRatio(bitmap, width, height, {
  stride = 4,
  margin = 24,
  tolerance = 1,
  channel = UNPAINTED_CHANNEL
} = {}) {
  if (!bitmap || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  if (typeof bitmap.length !== 'number' || bitmap.length < width * height * 4) return 0;
  const edgeX = Math.min(margin, Math.floor(width / 4));
  const edgeY = Math.min(margin, Math.floor(height / 4));
  const fromX = edgeX, toX = width - edgeX, fromY = edgeY, toY = height - edgeY;
  if (toX <= fromX || toY <= fromY) return 0;
  const step = Math.max(1, Math.floor(stride));
  let gray = 0, total = 0;
  for (let y = fromY; y < toY; y += step) {
    const row = y * width * 4;
    for (let x = fromX; x < toX; x += step) {
      const offset = row + x * 4;
      if (Math.abs(bitmap[offset] - channel) <= tolerance
        && Math.abs(bitmap[offset + 1] - channel) <= tolerance
        && Math.abs(bitmap[offset + 2] - channel) <= tolerance) gray += 1;
      total += 1;
    }
  }
  return total ? gray / total : 0;
}

// createBlankSurfaceWatchdog({ capture, repaint, rebuild, reload, ... })
//   capture  () => Promise<NativeImage>|NativeImage  (Electron: contents.capturePage)
//   repaint  () => void            re-request the committed frame
//   rebuild  () => boolean|void    smallest geometry change that rebuilds the surface
//   reload   () => void            last resort: reload the window renderer
// The clock, timers and logger are injected so the state machine is testable.
export function createBlankSurfaceWatchdog({
  capture,
  repaint = () => {},
  rebuild = () => {},
  reload = () => {},
  visible = () => true,
  loading = () => false,
  log = console,
  now = Date.now,
  interval = setInterval,
  clearLoop = clearInterval,
  schedule = setTimeout,
  cancel = clearTimeout,
  probeMs = 3000,
  samples = 3,
  ratio = DEFAULT_UNPAINTED_RATIO,
  cooldownMs = 60000,
  maxReloads = 3,
  probeTimeoutMs = 2500,
  settleMs = 2000,
  startDelayMs = 10000,
  debug = false
} = {}) {
  let loop;
  let probing = false;
  let recovering = false;
  let streak = 0;
  let blanks = 0;
  let reloads = 0;
  let startedAt = 0;
  let lastActionAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const delay = ms => new Promise(resolve => {
    const timer = schedule(resolve, ms);
    timer?.unref?.();
  });
  const withTimeout = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = schedule(() => reject(new Error('timeout')), ms); timer?.unref?.(); })
      ]);
    } finally { if (timer !== undefined) cancel(timer); }
  };

  async function probe() {
    if (disposed || probing || !visible() || loading()) return false;
    if (typeof capture !== 'function') return false;
    probing = true;
    try {
      const image = await withTimeout(Promise.resolve().then(capture), probeTimeoutMs);
      if (!image || typeof image.getSize !== 'function') return false;
      const toBitmap = typeof image.toBitmap === 'function' ? image.toBitmap.bind(image)
        : typeof image.getBitmap === 'function' ? image.getBitmap.bind(image) : undefined;
      if (!toBitmap) return false;
      const { width, height } = image.getSize();
      if (!(width > 200 && height > 200)) return false;
      const measured = measureUnpaintedRatio(toBitmap(), width, height);
      if (debug) log.info?.('[UBOVM] Paint probe.', { ratio: Math.round(measured * 1000) / 1000 });
      return measured >= ratio;
    } catch { return false; }
    finally { probing = false; }
  }

  async function recoverBlank() {
    lastActionAt = now();
    blanks += 1;
    log.warn?.('[UBOVM] Window surface is not painted.', { attempt: blanks, ratio });
    try { repaint(); } catch { /* Independent recovery steps. */ }
    try { rebuild(); } catch { /* Independent recovery steps. */ }
    await delay(settleMs);
    if (!(await probe())) {
      log.info?.('[UBOVM] Window surface repainted after a blank frame.');
      return;
    }
    if (reloads >= maxReloads) {
      log.error?.('[UBOVM] Window surface stayed blank; reload the window manually.');
      return;
    }
    reloads += 1;
    log.warn?.('[UBOVM] Reloading the window to rebuild an unpainted surface.', { reload: reloads });
    try { reload(); } catch (error) { log.error?.('[UBOVM] Window reload failed.', error); }
  }

  async function check() {
    if (disposed || recovering) return;
    if (now() - startedAt < startDelayMs) return;
    if (now() - lastActionAt < cooldownMs) return;
    const blank = await probe();
    streak = blank ? streak + 1 : 0;
    if (streak < samples) return;
    streak = 0;
    recovering = true;
    try { await recoverBlank(); } finally { recovering = false; }
  }

  return {
    start() {
      if (disposed || loop !== undefined) return;
      startedAt = now();
      loop = interval(() => { void check(); }, probeMs);
      loop?.unref?.();
    },
    pause() {
      if (loop === undefined) return;
      clearLoop(loop);
      loop = undefined;
      streak = 0;
    },
    // A freshly loaded window legitimately may not have painted yet, but a reload
    // that did not fix the surface must still count toward the reload budget.
    reset() { streak = 0; startedAt = now(); },
    probe,
    state() { return { running: loop !== undefined, streak, blanks, reloads, probing, recovering }; },
    dispose() { disposed = true; this.pause(); }
  };
}
