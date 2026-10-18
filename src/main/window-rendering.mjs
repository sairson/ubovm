// Recover the compositor surface without navigating or restarting task hosts.
export function installWindowRendering({
  app, powerMonitor, log = console, schedule = setTimeout, cancel = clearTimeout,
  interval = setInterval, clearLoop = clearInterval, now = Date.now, keepAliveMs = 20000,
  idleNudgeMs = 30000, hiddenNudgeMs = 5000, nudgeDelayMs = 300, nudgeGuardMs = 2000,
}) {
  const windows = new Map();
  let stopped = false;
  const delayMs = Object.freeze([0, 250, 1000]);
  function attach(window) {
    const contents = window.webContents;
    const timers = new Set();
    const nudges = new Set();
    let keepAlive, lastPaint = 0, lastBlur = now(), hiddenSince = 0, lastNudge = Number.NEGATIVE_INFINITY;
    const live = () => !stopped && !window.isDestroyed() && !contents.isDestroyed();
    const clearTimers = () => {
      for (const timer of timers) cancel(timer);
      timers.clear();
    };
    const clearNudges = () => {
      for (const timer of nudges) cancel(timer);
      nudges.clear();
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
    // invalidate() only asks for the committed frame again. When Chromium or
    // DirectComposition has dropped the native surface, the window stays a
    // uniform background until a real resize rebuilds it. Match the manual
    // "resize the window" workaround with the smallest possible geometry change.
    const rebuildSurface = () => {
      if (!surfaceReady() || window.isFullScreen()) return false;
      if (now() - lastNudge < nudgeGuardMs) return false;
      lastNudge = now();
      try {
        if (window.isMaximized()) {
          window.unmaximize();
          window.maximize();
        } else {
          const bounds = window.getBounds();
          window.setBounds({ ...bounds, width: bounds.width + 1 });
          window.setBounds(bounds);
        }
        log.info?.('[UBOVM] Rebuilt the window compositor surface.', { windowId: window.id });
        return true;
      } catch (error) {
        log.warn('[UBOVM] Window compositor surface rebuild failed.', error);
        return false;
      }
    };
    const scheduleRebuild = (delay = nudgeDelayMs) => {
      if (!surfaceReady()) return;
      const timer = schedule(() => {
        nudges.delete(timer);
        rebuildSurface();
      }, delay);
      timer?.unref?.();
      nudges.add(timer);
    };
    const startKeepAlive = () => {
      if (!surfaceReady() || keepAlive !== undefined) return;
      keepAlive = interval(() => { repaint(); }, keepAliveMs);
      keepAlive?.unref?.();
    };
    const recover = ({ native = false } = {}) => {
      if (!live()) return;
      clearTimers();
      if (!surfaceReady()) {
        stopKeepAlive();
        clearNudges();
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
      if (native) scheduleRebuild();
    };
    const pause = () => { clearTimers(); clearNudges(); stopKeepAlive(); };
    const onInput = (event, input) => {
      // Keep a keyboard escape hatch for a surface that is already blank; the
      // command palette and menus are also unpainted in that state.
      if (input?.type === 'keyDown' && input.control && input.alt && !input.meta
        && String(input.key).toLowerCase() === 'r') {
        event?.preventDefault?.();
        rebuildSurface();
        return;
      }
      if (!surfaceReady() || now() - lastPaint < keepAliveMs) return;
      recover();
    };
    const gone = (_event, details) => log.error('[UBOVM] Renderer exited.', { windowId: window.id, ...details });
    // An unresponsive renderer can drop its committed surface. A repaint alone
    // cannot reconnect a lost swap chain, so rebuild it after the repaint burst.
    const unresponsive = () => {
      log.warn('[UBOVM] Window renderer unresponsive.', { windowId: window.id });
      recover();
      scheduleRebuild();
    };
    const show = () => {
      const background = hiddenSince && now() - hiddenSince >= hiddenNudgeMs;
      hiddenSince = 0;
      recover();
      if (background) scheduleRebuild();
    };
    const restore = show;
    const focus = () => {
      const idle = now() - lastBlur >= idleNudgeMs;
      recover();
      if (idle) scheduleRebuild();
    };
    const blur = () => { lastBlur = now(); };
    const hide = () => {
      hiddenSince = now();
      pause();
    };
    const resized = () => recover();
    const responsive = () => recover();
    const dispose = () => {
      pause();
      window.removeListener('show', show);
      window.removeListener('restore', restore);
      window.removeListener('focus', focus);
      window.removeListener('blur', blur);
      window.removeListener('hide', hide);
      window.removeListener('minimize', hide);
      window.removeListener('resized', resized);
      window.removeListener('responsive', responsive);
      window.removeListener('unresponsive', unresponsive);
      window.removeListener('closed', dispose);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('before-input-event', onInput);
      windows.delete(window);
    };
    const loaded = () => recover();
    windows.set(window, { recover, dispose });
    window.on('show', show);
    window.on('restore', restore);
    window.on('focus', focus);
    window.on('blur', blur);
    window.on('hide', hide);
    window.on('minimize', hide);
    window.on('resized', resized);
    window.on('responsive', responsive);
    window.on('unresponsive', unresponsive);
    contents.on('did-finish-load', loaded);
    contents.on('render-process-gone', gone);
    contents.on('before-input-event', onInput);
    window.once('closed', dispose);
    startKeepAlive();
  }
  const created = (_event, window) => { if (!stopped) attach(window); };
  const resume = () => { for (const { recover } of windows.values()) recover({ native: true }); };
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
    windows.clear();
    app.removeListener('quit', dispose);
  };
  app.once('quit', dispose);
  return dispose;
}
