(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  let sessionId = '', sequence = 0, revealRevision, workers = [];
  let renderFrame = 0, renderGeneration = 0, latestState, suspended = false, actionEpoch = 0;
  const renderBlocked = () => suspended || document.hidden;
  function cancelFrame() { ++renderGeneration; if (renderFrame) cancelAnimationFrame(renderFrame); renderFrame = 0; }
  const pending = new Map();
  function cancelRequests() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('任务页面已切换，操作已取消。')); }
    pending.clear();
  }
  window.addEventListener('pagehide', () => {
    suspended = true; actionEpoch++; resetCopy(); cancelRequests(); cancelFrame();
  });
  window.addEventListener('pageshow', () => {
    if (!suspended) return;
    suspended = false; scheduleLatest();
    vscode.postMessage({ action: 'ready' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { actionEpoch++; resetCopy(); cancelRequests(); cancelFrame(); }
    else if (!suspended) scheduleLatest();
  });
  function request(action, payload) {
    if (renderBlocked()) return Promise.reject(new Error('任务页面已暂停，请恢复页面后重试。'));
    if (pending.size >= 32) return Promise.reject(new Error('待处理操作过多，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const requestId = `worker-${++sequence}`;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('操作超时，请重试。')); }, 10000);
      const entry = { resolve, reject, timer };
      pending.set(requestId, entry);
      const failed = error => {
        if (pending.get(requestId) !== entry) return;
        clearTimeout(timer); pending.delete(requestId);
        // Foreign bridges can reject with null or throwing error getters.
        // Keep consumers on a readable Error path after releasing the request.
        reject(new Error(window.UBOVMErrors?.text(error) || '操作发送失败，请重试。'));
      };
      try {
        Promise.resolve(vscode.postMessage({ action, ...payload, sessionId, requestId })).then(value => {
          if (value === false) failed(new Error('操作发送失败，请重试。'));
        }, failed);
      } catch (error) { failed(error); }
    });
  }
  const actionStatus = document.createElement('p'); actionStatus.className = 'worker-action-status'; actionStatus.hidden = true; actionStatus.setAttribute('role', 'status');
  function notify(text) { actionStatus.textContent = text; actionStatus.hidden = !text; }
  const actions = {
    onInterruptCommand: commandId => request('interruptCommand', { commandId }),
    onBackgroundCommand: commandId => request('backgroundCommand', { commandId }),
    onCopy: text => request('copyText', { text }),
    onOpenLink: (href, options = {}) => {
      const origin = sessionId, worker = panel.selected, epoch = actionEpoch;
      return request('openMessageLink', { href, rootIndex: options.rootIndex }).catch(error => {
        if (epoch === actionEpoch && !renderBlocked() && origin === sessionId && worker === panel.selected) notify(error.message);
        return false;
      });
    },
    onPreviewHtml: (source, button) => {
      try { window.UBOVMHtmlPreview.open(source, { returnFocus: button, onCopy: text => request('copyText', { text }) }); }
      catch (error) { notify(error?.message || 'HTML 预览失败，请检查源码后重试。'); }
    }
  };
  const panel = window.createWorkerPanel(actions, { standalone: true });
  const element = document.getElementById('worker-panel'), picker = document.getElementById('worker-picker');
  const renderError = document.createElement('div'); renderError.className = 'worker-render-status'; renderError.hidden = true;
  const renderMessage = document.createElement('span'); renderMessage.setAttribute('role', 'alert'); renderMessage.textContent = 'Worker 视图显示失败，工作记录已保留。';
  const renderRetry = document.createElement('button'); renderRetry.type = 'button'; renderRetry.className = 'worker-copy-log'; renderRetry.textContent = '重新显示 Worker 视图';
  renderError.append(renderMessage, renderRetry); element.before(renderError);
  let failedRender;
  renderRetry.addEventListener('click', () => {
    const data = latestState ?? failedRender?.data;
    if (!data || renderBlocked()) return;
    const reveal = data === failedRender?.data && failedRender.reveal;
    cancelFrame(); latestState = undefined;
    renderSafely(data, reveal);
  });
  const toolbar = document.createElement('div'); toolbar.className = 'worker-native-toolbar';
  const search = document.createElement('input'); search.type = 'search'; search.className = 'worker-search'; search.placeholder = '查找任务名称'; search.setAttribute('aria-label', search.placeholder);
  const count = document.createElement('span'); count.className = 'worker-search-result'; count.setAttribute('role', 'status');
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'worker-copy-log'; copy.textContent = '复制日志';
  let copyTask;
  function resetCopy() { copyTask = undefined; copy.disabled = false; }
  toolbar.append(search, count, copy);
  element.querySelector('.worker-panel-header').after(toolbar, actionStatus);
  function filterWorkers() {
    const query = search.value.trim().toLocaleLowerCase();
    const matching = workers.filter(worker => [worker.id, worker.name, worker.description].some(value => String(value || '').toLocaleLowerCase().includes(query)));
    const ids = new Set(matching.map(worker => worker.id));
    // Keep the current selection readable while narrowing the other choices.
    for (const option of picker.options) option.hidden = !ids.has(option.value) && option.value !== panel.selected;
    count.textContent = query ? `${matching.length} 个匹配` : `${workers.length} 个`;
    return matching;
  }
  search.addEventListener('input', filterWorkers);
  let composingSearch = false;
  search.addEventListener('compositionstart', () => { composingSearch = true; });
  search.addEventListener('compositionend', () => { composingSearch = false; filterWorkers(); });
  search.addEventListener('blur', () => { composingSearch = false; });
  search.addEventListener('keydown', event => {
    if (composingSearch || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); const match = filterWorkers()[0]; if (match) { panel.show(match.id); selectWorker(); } }
    if (event.key === 'Escape') { event.preventDefault(); search.value = ''; filterWorkers(); picker.focus(); }
  });
  function selectWorker() { actionEpoch++; resetCopy(); notify(''); filterWorkers(); vscode.postMessage({ action: 'selectWorker', sessionId, workerId: panel.selected }); }
  copy.addEventListener('click', async () => {
    const worker = workers.find(worker => worker.id === panel.selected); if (!worker) return;
    const task = {}; copyTask = task;
    copy.disabled = true;
    try {
    const lines = [worker.name || worker.id, worker.description || ''];
    for (const part of Array.isArray(worker.parts) ? worker.parts : []) {
      if (!part) continue;
      if (part.type === 'tool') lines.push(`[${part.name || '工具'} · ${part.status || ''}]`, typeof part.args === 'string' ? part.args : JSON.stringify(part.args || {}), part.output || '');
      else if (part.text) lines.push(part.text);
    }
    if (worker.result) lines.push(worker.result);
    else if (!worker.parts?.length && worker.streamText) lines.push(worker.streamText);
    if (worker.error) lines.push(typeof worker.error === 'string' ? worker.error : worker.error.message || '');
      await request('copyText', { text: lines.filter(Boolean).join('\n\n') });
      if (copyTask === task) notify('日志已复制');
    } catch (error) { if (copyTask === task) notify(error.message); }
    finally { if (copyTask === task) resetCopy(); }
  });
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'uiResult') {
      const entry = pending.get(data.requestId);
      if (entry) { clearTimeout(entry.timer); pending.delete(data.requestId); data.ok ? entry.resolve() : entry.reject(new Error(data.error)); }
      return;
    }
    if (data?.type !== 'workers') return;
    if (typeof data.sessionId !== 'string' || !Array.isArray(data.workers)) return;
    // Navigation is immediate: invalidate old requests before their replies can
    // affect a new session. Only incremental output waits for the next frame.
    if (data.sessionId !== sessionId || data.revealRevision !== revealRevision) {
      if (data.sessionId !== sessionId) { actionEpoch++; resetCopy(); cancelRequests(); }
      cancelFrame(); latestState = data;
      if (renderBlocked()) { element.inert = true; return; }
      latestState = undefined;
      renderSafely(data); return;
    }
    latestState = data;
    scheduleLatest();
  });
  function scheduleLatest() {
    if (!latestState || renderBlocked()) return;
    if (!renderFrame) {
      const generation = renderGeneration;
      renderFrame = requestAnimationFrame(() => {
        if (generation !== renderGeneration) return;
        renderFrame = 0;
        if (renderBlocked()) return;
        const snapshot = latestState; latestState = undefined;
        renderSafely(snapshot);
      });
    }
  }
  function renderSafely(data, forceReveal = false) {
    if (!data) return;
    const retryReveal = failedRender?.data.sessionId === data.sessionId && failedRender?.data.revealRevision === data.revealRevision && failedRender?.reveal;
    const reveal = forceReveal || retryReveal || sessionId !== data.sessionId || revealRevision !== data.revealRevision;
    try {
      renderState(data, reveal);
      failedRender = undefined; renderError.hidden = true; element.inert = element.hidden;
    } catch {
      failedRender = { data, reveal }; renderError.hidden = false;
      // Retain readable output, but do not execute actions against a stale view.
      element.inert = true;
      const empty = document.getElementById('worker-empty');
      empty.hidden = true; empty.setAttribute('aria-busy', 'false');
    }
  }
  function renderState(data, forceReveal = false) {
    const changedSession = sessionId !== data.sessionId;
    const reveal = forceReveal || changedSession || revealRevision !== data.revealRevision;
    if (changedSession) { resetCopy(); cancelRequests(); window.UBOVMHtmlPreview.close({ restoreFocus: false }); search.value = ''; notify(''); }
    sessionId = data.sessionId; revealRevision = data.revealRevision;
    workers = [...new Map((Array.isArray(data.workers) ? data.workers : []).filter(worker => worker && typeof worker.id === 'string').map(worker => [worker.id, worker])).values()];
    const previousWorker = panel.selected;
    panel.update({ ...data, workers });
    const empty = document.getElementById('worker-empty');
    empty.hidden = workers.length > 0;
    empty.textContent = '当前会话暂无任务执行记录。'; empty.setAttribute('aria-busy', 'false');
    const error = document.getElementById('worker-error');
    error.textContent = data.error ? '工作记录保存或读取失败：' + data.error : ''; error.hidden = !data.error;
    const id = reveal && workers.some(worker => worker.id === data.selected) ? data.selected : workers.some(worker => worker.id === panel.selected) ? panel.selected : workers[0]?.id;
    if (id && id !== panel.selected) panel.show(id);
    if (previousWorker !== panel.selected) { actionEpoch++; resetCopy(); notify(''); }
    filterWorkers();
  }
  picker.addEventListener('change', selectWorker);
  document.querySelector('.worker-parent').addEventListener('click', selectWorker);
  vscode.postMessage({ action: 'ready' });
})();
