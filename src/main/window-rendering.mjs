// Recover the compositor surface without navigating or restarting task hosts.
export function installWindowRendering({
  app, powerMonitor, log = console, schedule = setTimeout, cancel = clearTimeout,
  interval = setInterval, clearLoop = clearInterval, now = Date.now, keepAliveMs = 20000,
}) {
  const windows = new Map();
  let stopped = false;
  const delayMs = Object.freeze([0, 250, 1000]);
  function attach(window) {
    const contents = window.webContents;
    const timers = new Set();
    let keepAlive, lastPaint = 0;
    const live = () => !stopped && !window.isDestroyed() && !contents.isDestroyed();
    const clearTimers = () => {
      for (const timer of timers) cancel(timer);
      timers.clear();
    };
    const stopKeepAlive = () => {
      if (keepAlive === undefined) return;
      clearLoop(keepAlive);
      keepAlive = undefined;
    };
    const surfaceReady = () => live() && window.isVisible() && !window.isMinimized();
    const repaint = () => {
      if (!surfaceReady()) return false;
      try {
        contents.invalidate();
        lastPaint = now();
        return true;
      } catch (error) {
        log.warn('[UBOVM] Window repaint failed.', error);
        return false;
      }
    };
    const startKeepAlive = () => {
      if (!surfaceReady() || keepAlive !== undefined) return;
      keepAlive = interval(() => { repaint(); }, keepAliveMs);
      keepAlive?.unref?.();
    };
    const recover = () => {
      if (!live()) return;
      clearTimers();
      if (!surfaceReady()) {
        stopKeepAlive();
        return;
      }
      startKeepAlive();
      // Windows may deliver show/focus before the restored native surface is ready.
      for (const delay of delayMs) {
        if (delay === 0) {
          repaint();
          continue;
        }
        const timer = schedule(() => {
          timers.delete(timer);
          repaint();
        }, delay);
        timer?.unref?.();
        timers.add(timer);
      }
    };
    const pause = () => { clearTimers(); stopKeepAlive(); };
    const onInput = () => {
      if (!surfaceReady() || now() - lastPaint < keepAliveMs) return;
      recover();
    };
    const gone = (_event, details) => log.error('[UBOVM] Renderer exited.', { windowId: window.id, ...details });
    const unresponsive = () => log.warn('[UBOVM] Window renderer unresponsive.', { windowId: window.id });
    const recoverEvents = ['show', 'restore', 'focus', 'responsive'];
    const pauseEvents = ['hide', 'minimize'];
    for (const event of recoverEvents) window.on(event, recover);
    for (const event of pauseEvents) window.on(event, pause);
    window.on('unresponsive', unresponsive);
    contents.on('did-finish-load', recover);
    contents.on('render-process-gone', gone);
    contents.on('before-input-event', onInput);
    const dispose = () => {
      pause();
      for (const event of recoverEvents) window.removeListener(event, recover);
      for (const event of pauseEvents) window.removeListener(event, pause);
      window.removeListener('unresponsive', unresponsive);
      window.removeListener('closed', dispose);
      contents.removeListener('did-finish-load', recover);
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('before-input-event', onInput);
      windows.delete(window);
    };
    windows.set(window, { recover, dispose });
    window.once('closed', dispose);
    startKeepAlive();
  }
  const created = (_event, window) => { if (!stopped) attach(window); };
  const resume = () => { for (const { recover } of windows.values()) recover(); };
  const childGone = (_event, details) => {
    if (details.type === 'GPU') { log.warn('[UBOVM] GPU process exited.', details); resume(); }
  };
  app.on('browser-window-created', created);
  app.on('child-process-gone', childGone);
  // powerMonitor requires app.ready; bootstrap is deliberately earlier.
  const ready = () => { if (!stopped) { powerMonitor.on('resume', resume); powerMonitor.on('unlock-screen', resume); } };
  if (app.isReady()) ready(); else app.once('ready', ready);
  const dispose = () => {
    stopped = true;
    app.removeListener('ready', ready);
    app.removeListener('browser-window-created', created);
    app.removeListener('child-process-gone', childGone);
    powerMonitor.removeListener('resume', resume);
    powerMonitor.removeListener('unlock-screen', resume);
    for (const record of [...windows.values()]) record.dispose();
    app.removeListener('quit', dispose);
  };
  app.once('quit', dispose);
  return dispose;
}
