// Code OSS focuses an existing window when forwarding a repeated launch.
// Electron focus alone does not reveal a window hidden by our tray lifecycle.
export function installWindowFocusRestore(window) {
  const focus = window.focus;
  window.focus = function (...args) {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (window.isDestroyed()) return;
    if (!window.isVisible()) window.show();
    if (window.isDestroyed()) return;
    return focus.apply(window, args);
  };
}

// The lifecycle hook runs before Code OSS starts renderer/extension-host shutdown.
export function installBackgroundMode({ app, Tray, Menu, nativeImage, dialog, icon, platform = process.platform, log = console }) {
  if (platform !== 'win32') return;
  let tray;
  let lastWindow;
  const windows = new Set();
  let notified = false;
  let sessionEnding = false;
  let closeRequest;
  let lastStatus;
  const originalThrottling = new Map();
  const liveWindows = () => [...windows].filter(window => !window.isDestroyed());
  const isBackground = window => !window.isVisible() || window.isMinimized();

  function cancelCloseRequest() {
    const request = closeRequest;
    // Release before abort: native completion may arrive after a newer prompt.
    closeRequest = undefined;
    request?.controller.abort();
  }

  function updateWindow(window) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (isBackground(window)) {
      if (!originalThrottling.has(window)) {
        originalThrottling.set(window, window.webContents.getBackgroundThrottling());
        window.webContents.setBackgroundThrottling(false);
      }
    } else if (originalThrottling.has(window)) {
      window.webContents.setBackgroundThrottling(originalThrottling.get(window));
      originalThrottling.delete(window);
    }
    updateTray();
  }

  function restore(window) {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (window.isDestroyed() || sessionEnding) return;
    window.show();
    updateWindow(window);
  }

  function show() {
    if (sessionEnding) return;
    const current = liveWindows();
    // A modal close choice belongs to its parent, even if another IDE was used last.
    const preferred = closeRequest?.window ?? lastWindow;
    const target = current.includes(preferred) ? preferred : current.at(-1);
    for (const window of current.filter(isBackground)) restore(window);
    // Focus once, preserving the most recently used IDE window.
    if (target) { restore(target); target.focus(); }
    if (tray && !tray.isDestroyed()) {
      try { tray.removeBalloon(); }
      catch (error) { log.warn('[UBOVM] Cannot dismiss background hint.', error); }
    }
  }

  function notifyBackground() {
    if (notified || sessionEnding || !tray || tray.isDestroyed() || !liveWindows().every(isBackground)) return;
    // At most one quiet hint per process, even if Windows suppresses the balloon.
    notified = true;
    try {
      tray.displayBalloon({ iconType: 'info', title: 'UBOVM 已在后台运行',
        content: '窗口已隐藏，正在执行的任务会继续运行。点击此提示或托盘图标返回；右键选择“退出 IDE”结束应用。',
        noSound: true, respectQuietTime: true });
    } catch (error) {
      log.warn('[UBOVM] Background hint unavailable.', error);
    }
  }

  function hideAll() {
    if (sessionEnding || !ensureTray()) return;
    cancelCloseRequest();
    const owner = tray;
    for (const window of liveWindows()) {
      // hide emits synchronous events that can invalidate the tray or end the session.
      if (sessionEnding || tray !== owner || owner.isDestroyed()) break;
      if (!window.isDestroyed()) { window.hide(); updateWindow(window); }
    }
    notifyBackground();
  }

  function discardTray() {
    const owner = tray;
    tray = undefined;
    lastStatus = undefined;
    try { owner?.destroy(); }
    catch (error) { log.warn('[UBOVM] Cannot dispose system tray.', error); }
  }

  function recoverTray(error) {
    // Invalidate first so restoration events cannot update the broken tray again.
    discardTray();
    log.error('[UBOVM] System tray unavailable; restoring IDE windows.', error);
    show();
  }

  function updateTray() {
    if (sessionEnding || !tray || tray.isDestroyed()) return;
    const owner = tray;
    const currentAction = action => () => {
      if (!sessionEnding && tray === owner && !owner.isDestroyed()) action();
    };
    const current = liveWindows();
    const background = current.filter(isBackground).length;
    const status = current.length && background === current.length ? '后台运行中' : '运行中';
    const detail = `窗口 ${current.length} 个 · 后台 ${background} 个`;
    const key = `${status}:${detail}`;
    if (key === lastStatus) return;
    try {
      owner.setToolTip(`UBOVM IDE · ${status}\n${detail}\n点击返回，右键退出`);
      owner.setContextMenu(Menu.buildFromTemplate([
        { label: `${status} · ${detail}`, enabled: false },
        { type: 'separator' },
        { label: '显示 IDE', enabled: current.length > 0, click: currentAction(show) },
        { label: '后台运行', enabled: current.length > background, click: currentAction(hideAll) },
        { type: 'separator' },
        { label: '退出 IDE', click: currentAction(() => { cancelCloseRequest(); show(); app.quit(); }) }
      ]));
      if (tray === owner) lastStatus = key;
    } catch (error) {
      if (tray === owner) recoverTray(error);
    }
  }

  function ensureTray() {
    if (sessionEnding) return false;
    if (tray && !tray.isDestroyed()) return true;
    try {
      // A preloaded NativeImage avoids handing Windows an absolute icon path.
      const image = icon && typeof icon.isEmpty === 'function' ? icon : nativeImage.createFromPath(icon);
      if (!image || image.isEmpty()) throw new Error('Missing tray icon');
      tray = new Tray(image);
      lastStatus = undefined;
      const owner = tray;
      const showCurrent = () => { if (tray === owner && !owner.isDestroyed()) show(); };
      tray.on('click', showCurrent);
      tray.on('double-click', showCurrent);
      tray.on('balloon-click', showCurrent);
      updateTray();
      return tray === owner && !owner.isDestroyed();
    } catch (error) {
      recoverTray(error);
      return false;
    }
  }

  app.on('browser-window-created', (_event, window) => {
    function register() {
      if (sessionEnding || windows.has(window) || window.isDestroyed()) return;
      windows.add(window);
      installWindowFocusRestore(window);
      lastWindow = window;
      ensureTray();
      updateWindow(window);
    }
    function registerWorkbench() {
      if (sessionEnding || window.isDestroyed() || window.webContents.isDestroyed()) return;
      // Exclude DevTools, dialogs and auxiliary editors from tray state.
      if (/\/(?:workbench|sessions)(?:-dev)?\.html(?:[?#]|$)/.test(window.webContents.getURL())) register();
    }
    window.webContents.on('did-finish-load', registerWorkbench);
    window.on('ready-to-show', registerWorkbench);
    window.on('focus', () => { if (windows.has(window)) lastWindow = window; });
    for (const event of ['show', 'hide', 'minimize', 'restore']) {
      window.on(event, () => {
        // A user can minimize before did-finish-load/ready-to-show is delivered.
        registerWorkbench();
        if (windows.has(window)) updateWindow(window);
      });
    }
    window.on('session-end', () => { sessionEnding = true; cancelCloseRequest(); });
    window.on('ubovm-before-close', async (event, quitRequested) => {
      if (quitRequested || sessionEnding) { cancelCloseRequest(); return; }
      register(); // The lifecycle hook is authoritative even before first load.
      event.preventDefault();
      if (window.isDestroyed()) return;
      if (closeRequest) {
        const pending = closeRequest;
        restore(pending.window);
        if (closeRequest === pending && !pending.window.isDestroyed()) pending.window.focus();
        return;
      }
      const request = { window, controller: new AbortController() };
      closeRequest = request;
      try {
        const { response: choice } = await dialog.showMessageBox(window, {
          type: 'question', title: '关闭 UBOVM IDE', message: '退出 IDE，还是进入后台运行？',
          detail: '退出将关闭所有 IDE 窗口并结束运行中的任务；未保存文件仍会提示保存。后台运行会隐藏当前窗口并保留任务。',
          buttons: ['退出 IDE', '后台运行', '取消'], defaultId: 2, cancelId: 2, noLink: true,
          signal: request.controller.signal
        });
        if (sessionEnding || window.isDestroyed() || closeRequest !== request) return;
        if (choice === 0) { show(); app.quit(); }
        else if (choice === 1 && ensureTray()) {
          window.hide(); updateWindow(window); notifyBackground();
        }
      } catch (error) {
        if (!request.controller.signal.aborted) log.error('[UBOVM] Close choice failed; keeping the window open.', error);
      } finally { if (closeRequest === request) closeRequest = undefined; }
    });
    window.once('closed', () => {
      if (closeRequest?.window === window) cancelCloseRequest();
      windows.delete(window);
      originalThrottling.delete(window);
      if (lastWindow === window) lastWindow = undefined;
      updateTray();
    });
  });
  // Also reveal save prompts when quit originates from the IDE menu or update.
  app.on('before-quit', () => { cancelCloseRequest(); if (!sessionEnding) show(); });
  app.once('quit', () => { sessionEnding = true; cancelCloseRequest(); discardTray(); });
}
