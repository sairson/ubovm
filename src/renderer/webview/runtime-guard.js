(() => {
  'use strict';
  // Runs in its own script before every application dependency. A syntax error
  // in a later script must not disable the only recovery surface.
  const panel = document.getElementById('runtime-recovery');
  const label = document.getElementById('runtime-recovery-message');
  const reloadButton = document.getElementById('runtime-reload');
  let api, painted = false, pendingSince = null, started = Date.now(), disposed = false, reloadSince = null, generation = 0;
  let wasHidden = document.hidden;
  let lastTick = started;
  const sends = new Map();
  function fail(message = '页面显示遇到问题。可以同步最新状态，或重新加载页面。') {
    if (disposed) return;
    label.textContent = message;
    panel.hidden = false;
    // Remove only transition masks, never close dialogs or change task state.
    document.body.dataset.switching = 'false';
    const mask = document.getElementById('route-loading');
    if (mask) mask.hidden = true;
  }
  function send(action) {
    const request = {}, origin = generation;
    sends.set(action, request);
    const failed = () => {
      if (disposed || origin !== generation || sends.get(action) !== request) return;
      if (action === 'reloadConversation') { reloadSince = null; reloadButton.disabled = false; }
      fail('页面连接不可用，请通过命令“重新加载对话页面”恢复。');
    };
    try {
      if (!api) throw new Error('Bridge unavailable');
      Promise.resolve(api.postMessage({ action })).then(result => { if (result === false) failed(); }, failed);
    } catch { failed(); }
  }
  try { api = acquireVsCodeApi(); }
  catch { fail('页面连接初始化失败，请重新加载对话页面。'); }
  const guard = window.UBOVMRuntime = {
    api, fail,
    pending() { if (pendingSince === null) pendingSince = Date.now(); },
    painted() { painted = true; pendingSince = null; sends.delete('ready'); panel.hidden = true; },
    cancel() { pendingSince = null; },
  };
  document.getElementById('runtime-resync').addEventListener('click', () => {
    window.dispatchEvent(new Event('ubovm-runtime-retry'));
    send('ready');
  });
  reloadButton.addEventListener('click', () => {
    if (reloadSince !== null) return;
    // Let the running app flush its drafts before replacing only the webview.
    // dispatchEvent does not throw listener errors back to its caller. An
    // explicit synchronous save contract must confirm before reload is sent.
    let saved = true;
    try { if (typeof guard.saveDrafts === 'function') saved = guard.saveDrafts() === true; }
    catch { saved = false; }
    if (!saved || !window.dispatchEvent(new Event('ubovm-runtime-save', { cancelable: true }))) {
      fail('草稿暂时无法保存。请先复制草稿，或在存储恢复后重新加载页面。');
      return;
    }
    reloadSince = Date.now(); reloadButton.disabled = true;
    send('reloadConversation');
  });
  const error = () => fail();
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', error);
  function tick() {
    if (disposed || document.hidden) return;
    const now = Date.now();
    // Wall-clock correction must not leave recovery waiting for the old time.
    if (now < lastTick) {
      started = now;
      if (pendingSince !== null) pendingSince = now;
      if (reloadSince !== null) reloadSince = now;
    }
    lastTick = now;
    if (reloadSince !== null && now - reloadSince >= 15000) {
      reloadSince = null; reloadButton.disabled = false;
      fail('页面重新加载未完成。请检查连接，或通过 IDE 命令重新加载对话页面。');
    }
    if (!painted && now - started >= 15000) fail('页面未能完成加载，请同步状态或重新加载页面。');
    else if (pendingSince !== null && now - pendingSince >= 15000) fail('页面更新未能完成。草稿仍在当前页面，请同步状态或重新加载页面。');
  }
  let timer;
  function stopClock() { clearInterval(timer); timer = undefined; }
  function startClock() {
    if (!disposed && !document.hidden && timer === undefined) timer = setInterval(tick, 5000);
  }
  startClock();
  document.addEventListener('visibilitychange', () => {
    if (wasHidden === document.hidden) return;
    wasHidden = document.hidden;
    // Time spent asleep or hidden is not evidence of a rendering failure.
    started = Date.now(); if (pendingSince !== null) pendingSince = started;
    if (reloadSince !== null) reloadSince = started;
    if (document.hidden) stopClock(); else startClock();
  });
  window.addEventListener('pagehide', () => { disposed = true; generation++; sends.clear(); stopClock(); guard.cancel(); });
  window.addEventListener('pageshow', () => {
    if (!disposed) return;
    disposed = false; wasHidden = document.hidden; started = Date.now();
    if (reloadSince !== null) reloadSince = started;
    startClock();
  });
})();
