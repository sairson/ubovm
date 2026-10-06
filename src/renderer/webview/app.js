(() => {
  'use strict';
  const vscode = window.UBOVMRuntime?.api ?? acquireVsCodeApi();
  const t = value => window.UBOVMi18n?.t(value) ?? value;
  const userTextIds = new Set(['conversation-title', 'goal-objective', 'workspace-name', 'context-label', 'goal-selection-label']);
  let connectionStatus = 'connecting';
  let readyResyncTimer;
  function requestReadyResync() {
    // pageshow + visibilitychange + probe reconnect can all fire together; one ready is enough.
    if (readyResyncTimer) return;
    readyResyncTimer = setTimeout(() => {
      readyResyncTimer = undefined;
      try { vscode.postMessage({ action: 'ready' }); } catch { /* Bridge may be unavailable during teardown. */ }
    }, 48);
  }
  const connection = window.createConnectionMonitor({ send: value => vscode.postMessage(value), onChange: (status, previous) => {
    connectionStatus = status;
    if (status === 'disconnected') {
      const failure = new Error('连接已中断，已发送操作的结果尚未确认，请恢复连接后检查状态。');
      const interrupted = [...pending.values()];
      pending.clear();
      for (const item of interrupted) { clearTimeout(item.timer); completeCallback(item.onError, failure, item.sessionId); }
      // Hard disconnect must disable submit controls via a full paint.
      scheduleRender();
    } else if (status === 'backend-disconnected' || status === 'backend-stalled') {
      scheduleRender();
    } else {
      // Soft reconnect ticks only need the connection strip; avoid relayout storms.
      scheduleRender(true);
    }
    if (status === 'connected' && ['disconnected', 'backend-disconnected', 'backend-stalled', 'reconnecting'].includes(previous)) requestReadyResync();
  } });
  createSettingsPanel(vscode);
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) {
      const element = document.getElementById(id);
      if (element) elements.set(id, element);
      return element;
    }
    return elements.get(id);
  };
  const input = byId('prompt-input');
  const deliveryView = window.createDeliveryView(byId('delivery-workspace'));
  byId('connection-check').addEventListener('click', () => connection.probe());
  function renderConnectionStatus() {
    const offline = ['disconnected', 'backend-disconnected', 'backend-stalled'].includes(connectionStatus);
    byId('connection-warning').hidden = !offline;
    const canResume = executionState().canResume === true;
    setText(byId('connection-warning-text'), connectionStatus === 'disconnected'
      ? '与 IDE 后端的连接已中断，任务状态未知。草稿已保留，请勿重复提交；连接恢复后将同步状态。'
      : connectionStatus === 'backend-stalled'
        ? 'Agent 后端响应变慢，连接仍保持中，任务未中断。请稍候；若长时间无进展再检查后继续。'
      : canResume
        ? 'Agent 后端已断开，运行中的任务可能已中断。连接恢复后请点击“继续执行”从检查点恢复，请勿重复提交。'
        : 'Agent 后端已断开，运行中的任务可能已中断。请检查执行错误，再手动重新发起或恢复任务。');
    if (!offline) return;
    if (busy && connectionStatus !== 'backend-stalled') {
      for (const id of ['busy-status', 'header-execution-status', 'goal-run-status', 'execution-phase']) setText(byId(id), '连接中断 · 任务状态待确认');
    } else if (busy && connectionStatus === 'backend-stalled') {
      for (const id of ['busy-status', 'header-execution-status', 'goal-run-status', 'execution-phase']) setText(byId(id), '响应变慢 · 任务仍在进行');
    }
    // Hard IDE disconnect freezes actions; stalls and backend flaps still allow explicit resume.
    if (connectionStatus === 'disconnected') for (const id of ['submit-prompt', 'goal-run', 'goal-resume', 'assist-resume', 'goal-stop']) byId(id).disabled = true;
  }
  const form = byId('prompt-form');
  const submit = byId('submit-prompt');
  const approvalMode = byId('tool-approval-mode');
  const messages = byId('messages');
  const conversation = byId('conversation');
  const objectiveInput = byId('goal-objective-input');
  const factsInput = byId('goal-facts-input');
  const criteriaInput = byId('goal-criteria-input');
  const noteInput = byId('goal-note-input');
  const drafts = new Map();
  const pending = new Map();
  const errors = new Map();
  const goalViews = ['overview', 'board', 'workers', 'notes'];
  let currentSessionId = '';
  let hostState = null;
  const stateOrder = window.createStateOrder();
  let renderedPageKey = '';
  let pageAnimation, pendingViewRestore;
  let routePending = false, routePaintReady = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function cancelPageAnimation() { pageAnimation?.cancel(); pageAnimation = undefined; }
  function beginPageTransition(label = '正在切换页面…', kind = 'route') {
    cancelPageAnimation();
    routePending = true; routePaintReady = false;
    // Route changes always need one full paint; arm it before any interleaved
    // execution-only scheduleRender(true) can commit and clear the loader early.
    fullRenderPending = true;
    renderPending = true;
    cancelRenderTimer();
    if (renderFrame) {
      renderGeneration++;
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    // Cancelling a delayed/streaming paint must also clear the runtime pending
    // clock, otherwise route churn can trip the 15s recovery banner without a host fault.
    window.UBOVMRuntime?.cancel();
    setText(byId('route-loading-label'), label);
    const loader = byId('route-loading');
    loader.dataset.kind = kind;
    loader.hidden = !firstContentPaint;
    document.body.dataset.switching = 'true';
    renderNavigationFeedback();
  }
  function finishPageTransition() {
    routePending = false; routePaintReady = false;
    const loader = byId('route-loading');
    loader.hidden = true;
    delete loader.dataset.kind;
    document.body.dataset.switching = 'false';
    renderNavigationFeedback();
  }
  function renderNavigationFeedback() {
    const navigating = navigationPending() || routePending;
    byId('navigation-loading').hidden = !navigating;
    document.body.dataset.navigating = String(navigating);
    byId('main-content').setAttribute('aria-busy', String(!hostState || navigating));
  }
  reducedMotion.addEventListener('change', event => { if (event.matches) cancelPageAnimation(); });
  let firstContentPaint = false, firstPaintAcknowledged = false;
  let suspended = false, viewEpoch = 0, focusFrame = 0, contentReadyFrame = 0, contentReadyPending = false;
  const pageHidden = () => suspended || document.hidden;
  const visualSuspended = () => pageHidden() || byId('settings-dialog').open;
  let busy = false;
  let showingConversation = false;
  let composingPrompt = false;
  let lastCriteria = '';
  let lastNotes = '';
  let lastCriteriaSource, lastNotesSource;
  let noteSource = 'all';
  let selectedNoteKey = '', renderedNoteKey = '', renderedNoteIdentity = '';
  let savedNoteToReveal;
  const noteEntries = new WeakMap();
  let forceScroll = false;
  let requestCounter = 0;
  const messageViews = new Map();
  const sectionViews = new Map();
  const inputSizes = new WeakMap();
  const scrollPositions = new WeakMap();
  const goalViewScroll = new Map();
  let pendingScroll;
  // Long histories paint the newest turns first so loaders can clear before older
  // Markdown work. Prefill runs on later frames without a second full snapshot.
  const HISTORY_TAIL = 14;
  const HISTORY_BATCH = 8;
  let historyFillFrame = 0;
  let pendingThreadTeardown;
  function cancelHistoryFill() {
    if (historyFillFrame) { cancelAnimationFrame(historyFillFrame); historyFillFrame = 0; }
  }
  function releaseMessageView(view) {
    if (!view) return;
    for (const entry of view.entries || []) try { window.UBOVMMessage.release(entry.body); } catch { /* Independent teardown. */ }
    if (view.stream) try { window.UBOVMMessage.release(view.stream.body); } catch { /* Independent teardown. */ }
  }
  function flushThreadTeardown() {
    const pending = pendingThreadTeardown;
    pendingThreadTeardown = undefined;
    if (!pending) return;
    for (const view of pending.views) releaseMessageView(view);
    for (const container of pending.containers) try { container.replaceChildren(); } catch { /* Independent teardown. */ }
  }
  function queueThreadTeardown() {
    const views = [], containers = [];
    for (const [container, view] of messageViews) {
      views.push(view);
      containers.push(container);
    }
    messageViews.clear();
    if (!views.length) return;
    // A faster second switch must not leak the previous deferred teardown.
    if (pendingThreadTeardown) {
      for (const view of pendingThreadTeardown.views) releaseMessageView(view);
      for (const container of pendingThreadTeardown.containers) try { container.replaceChildren(); } catch { /* Independent teardown. */ }
    }
    pendingThreadTeardown = { views, containers };
    // Without a painted route mask the old thread would flash; release immediately.
    if (!firstContentPaint || !routePending) flushThreadTeardown();
  }
  let latestFrame = 0;
  function refreshLatest() {
    if (latestFrame || visualSuspended()) return;
    latestFrame = requestAnimationFrame(() => {
      latestFrame = 0;
      if (visualSuspended()) return;
      byId('conversation-latest').hidden = hostState?.mode === 'goal' || !showingConversation || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 120;
    });
  }
  byId('conversation-latest').addEventListener('click', () => {
    cancelScroll();
    conversation.scrollTop = conversation.scrollHeight;
    const position = scrollPositions.get(conversation);
    position.top = conversation.scrollTop; position.following = true;
    conversation.focus({ preventScroll: true });
    refreshLatest();
  });
  const latestObserver = new ResizeObserver(refreshLatest);
  latestObserver.observe(conversation); latestObserver.observe(messages);
  let renderFrame = 0;
  let renderGeneration = 0;
  let renderPending = false;
  let draftTimer = 0;
  let inputFrame = 0;
  let workerPanelWidth = 440;
  const statusLabels = { idle: '尚未执行', starting: '正在准备', running: '执行中', completed: '已完成', interrupted: '已停止', failed: '执行失败', pending: '待执行', queued: '排队中', waiting: '等待并行任务' };
  const phaseLabels = { chat: '正在回复', reason: '正在规划', plan: '制定计划', execute: '执行工具', replan: '检查进展', conclude: '整理结论', done: '已完成' };
  const executionState = () => hostState?.execution || {};
  const statusText = value => statusLabels[value] || value || '尚未执行';
  const phaseText = value => phaseLabels[value] || value || '';
  function setText(element, value) {
    if (!element) return;
    const source = value == null ? '' : String(value);
    const text = userTextIds.has(element.id) ? source : t(source);
    if (element.textContent !== text) element.textContent = text;
  }
  function setProperty(element, key, value) {
    if (element[key] !== value) element[key] = value;
  }
  function setAttribute(element, key, value) {
    const source = value == null ? '' : String(value);
    const next = !userTextIds.has(element.id) && (key === 'title' || key === 'aria-label' || key === 'placeholder') ? t(source) : source;
    if (element.getAttribute(key) !== next) element.setAttribute(key, next);
  }
  function renderSection(key, value, render) {
    const serialized = JSON.stringify(value);
    if (sectionViews.get(key) === serialized) return;
    // Only completed renders may suppress future updates of the same state.
    // Invalidate the previous state too: a failure may have partially changed DOM.
    sectionViews.delete(key);
    render();
    sectionViews.set(key, serialized);
  }
  function cancelScroll() {
    if (pendingScroll) cancelAnimationFrame(pendingScroll.frame);
    pendingScroll = undefined;
  }
  for (const scroller of [conversation, byId('goal-panels')]) {
    scrollPositions.set(scroller, { top: 0, following: true });
    scroller.addEventListener('scroll', () => {
      const position = scrollPositions.get(scroller);
      if (scroller.scrollTop < position.top - 1) {
        position.following = false;
        if (pendingScroll?.scroller === scroller) cancelScroll();
      }
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2) position.following = true;
      position.top = scroller.scrollTop;
      if (scroller === conversation) refreshLatest();
    }, { passive: true });
  }

  let conversationOutline;
  function renderConversationOutline() {
    if (hostState.mode === 'goal') return;
    if (!conversationOutline) conversationOutline = window.createConversationOutline({ scroller: conversation, beforeNavigate: () => {
      cancelScroll();
      forceScroll = false;
      scrollPositions.get(conversation).following = false;
    }, onError: error => {
      showError(error);
      byId('ui-render-retry').hidden = false;
    } });
    const view = messageViews.get(messages);
    if (view?.sessionId === currentSessionId) conversationOutline.update(view.entries, currentSessionId);
  }

  // Drafts are separate from host-owned data, so repeated state updates never
  // replace an in-progress edit. Each conversation has its own draft fields.
  // Serialized panels from a previous IDE process must not revive UI state.
  try {
    if (document.body.dataset.freshSession === '1') vscode.setState({});
    const saved = document.body.dataset.freshSession === '1' ? undefined : vscode.getState();
    if (Number.isFinite(saved?.workerPanelWidth) && saved.workerPanelWidth >= 280 && saved.workerPanelWidth <= 800) workerPanelWidth = saved.workerPanelWidth;
    if (saved && saved.drafts && typeof saved.drafts === 'object') {
      for (const [id, value] of Object.entries(saved.drafts).slice(-100)) {
        if (!value || typeof value !== 'object') continue;
        drafts.set(id, {
          assist: typeof value.assist === 'string' ? value.assist.slice(0, 8000) : '',
          approvalMode: ['auto', 'manual'].includes(value.approvalMode) ? value.approvalMode : undefined,
          goalPrompt: typeof value.goalPrompt === 'string' ? value.goalPrompt.slice(0, 8000) : '',
          note: typeof value.note === 'string' ? value.note.slice(0, 2000) : '',
          goalDraft: value.goalDraft && typeof value.goalDraft.objective === 'string' && typeof value.goalDraft.criteria === 'string'
            ? { objective: value.goalDraft.objective.slice(0, 4000), initialFacts: typeof value.goalDraft.initialFacts === 'string' ? value.goalDraft.initialFacts.slice(0, 8000) : '', criteria: value.goalDraft.criteria.slice(0, 6020) } : null,
          goalEditing: value.goalEditing === true,
          view: goalViews.includes(value.view) ? value.view : 'overview',
          touchedAt: Number(value.touchedAt) || 0
        });
      }
    }
  } catch { /* An unavailable draft cache must not prevent the UI opening. */ }
  function draftFor(id = currentSessionId) {
    if (!drafts.has(id)) drafts.set(id, { assist: '', goalPrompt: '', note: '', goalDraft: null, goalEditing: false, view: 'overview', touchedAt: Date.now() });
    return drafts.get(id);
  }
  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (!currentSessionId) return true;
    draftFor().touchedAt = Date.now();
    const entries = [...drafts.entries()].filter(([id]) => id).sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(-100);
    try { vscode.setState({ drafts: Object.fromEntries(entries), workerPanelWidth }); return true; }
    catch { return false; /* Keep the live draft if persistence is temporarily unavailable. */ }
  }
  function scheduleDraftPersistence() {
    draftFor().touchedAt = Date.now();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDrafts, 180);
  }
  function scheduleInput() {
    if (!inputFrame && !visualSuspended()) inputFrame = requestAnimationFrame(() => { inputFrame = 0; if (!visualSuspended()) updateInput(); });
  }
  function hasPending(action, criterionId) {
    return [...pending.values()].some(item => item.sessionId === currentSessionId && (!action || item.action === action) && (!criterionId || item.criterionId === criterionId));
  }
  function navigationPending() {
    // Mode changes select another session. Keep the navigation lock until
    // its acknowledgment, even when the new session state arrives first.
    return [...pending.values()].some(item => item.action === 'setMode' || item.action === 'newChat');
  }
  function migrateGoalDraft(state) {
    const legacyId = state.conversation?.legacyDraftId;
    if (state.mode !== 'goal' || !legacyId || drafts.has(currentSessionId) || !drafts.has(legacyId)) return;
    const old = drafts.get(legacyId);
    drafts.set(currentSessionId, {
      assist: '', goalPrompt: '', note: old.note,
      goalDraft: old.goalDraft ? { ...old.goalDraft } : null,
      goalEditing: old.goalEditing, view: old.view, touchedAt: Date.now()
    });
    persistDrafts();
  }
  function showError(message, sessionId = currentSessionId) {
    if (message) errors.set(sessionId, message); else errors.delete(sessionId);
    const value = errors.get(currentSessionId);
    const failure = window.UBOVMErrors.normalize(value);
    byId('ui-error-title').textContent = window.UBOVMErrors.title(failure);
    byId('ui-error').dataset.cancelled = String(failure.cancelled);
    byId('ui-error').setAttribute('role', failure.cancelled ? 'status' : 'alert');
    byId('ui-error').setAttribute('aria-live', failure.cancelled ? 'polite' : 'assertive');
    byId('ui-error-message').textContent = value ? window.UBOVMErrors.text(value) : '';
    byId('ui-error-detail').textContent = '错误代码：' + failure.code + (failure.detail ? '\n' + failure.detail : '');
    byId('ui-error-details').hidden = !failure.detail && failure.code === 'OPERATION_FAILED';
    byId('ui-error-details').open = false;
    byId('ui-error').hidden = !value;
  }
  byId('ui-error-dismiss').addEventListener('click', () => showError(''));
  function completeCallback(callback, value, sessionId) {
    if (typeof callback !== 'function') return;
    const report = error => {
      try {
        showError({ ...window.UBOVMErrors.normalize(error, 'render'), message: '操作结果已收到，但界面更新失败。请重试显示。' }, sessionId);
        if (sessionId === currentSessionId) byId('ui-render-retry').hidden = false;
      } catch { /* The acknowledgement stays settled even if error rendering fails. */ }
    };
    // A callback failure must not retain the request lock or replay its action.
    try { Promise.resolve(callback(value)).catch(report); } catch (error) { report(error); }
  }
  function request(action, payload = {}, onSuccess, onError, timeoutMs = 120000) {
    if (suspended) {
      completeCallback(onError, new Error('页面已暂停，操作未发送。请恢复页面后重试。'), currentSessionId);
      return;
    }
    if (connectionStatus === 'disconnected') {
      completeCallback(onError, new Error('连接尚未恢复，操作未发送。'), currentSessionId);
      return;
    }
    if (!currentSessionId && action !== 'setTheme') return;
    if ((action === 'setMode' || action === 'newChat') && navigationPending()) return;
    const requestId = 'ui-' + Date.now().toString(36) + '-' + (++requestCounter);
    const sessionId = currentSessionId;
    const timer = setTimeout(() => {
      if (!pending.delete(requestId)) return;
      const error = new Error('等待操作结果超时。操作可能仍在执行，请先确认状态再重试。');
      showError(window.UBOVMErrors.normalize(error, action), sessionId); updateControls(); completeCallback(onError, error, sessionId);
    }, timeoutMs);
    pending.set(requestId, { action, sessionId, criterionId: payload.criterionId, onSuccess, onError, timer });
    showError('');
    updateControls();
    const failed = () => {
      // A reply or session teardown may have already settled this operation.
      if (!pending.delete(requestId)) return;
      clearTimeout(timer);
      showError(window.UBOVMErrors.normalize('操作未能发送，请重试。', action), sessionId);
      updateControls(); completeCallback(onError, new Error('操作未能发送，请重试。'), sessionId);
    };
    try {
      Promise.resolve(vscode.postMessage({ ...payload, action, sessionId, requestId })).then(value => {
        if (value === false) failed();
      }, failed);
    } catch { failed(); return; }
    return requestId;
  }
  const modalDialog = window.createModalDialog();
  const projectSwitcher = window.createProjectSwitcher(vscode, {
    request: (action, payload, onSuccess, onError) => request(action, payload, onSuccess, onError),
    getProjects: () => Array.isArray(hostState?.projects) ? hostState.projects : [],
    getWorkspace: () => hostState?.context?.workspace || '',
    modal: modalDialog
  });
  const renderRequests = new Map();
  function renderRequest(action, payload) {
    const key = JSON.stringify([currentSessionId, action, payload]);
    if (renderRequests.has(key)) return renderRequests.get(key);
    const task = new Promise((resolve, reject) => {
      const id = request(action, payload, resolve, reject, action === 'openWorker' ? 120000 : 10000);
      if (!id) reject(new Error('当前会话尚未准备完成。'));
    }).finally(() => { if (renderRequests.get(key) === task) renderRequests.delete(key); });
    renderRequests.set(key, task);
    return task;
  }
  const messageActions = {
    onInterruptCommand: commandId => renderRequest('interruptCommand', { commandId }),
    onBackgroundCommand: commandId => renderRequest('backgroundCommand', { commandId }),
    onCopy: text => renderRequest('copyText', { text }),
    onOpenLink: (href, options = {}) => {
      const origin = currentSessionId;
      return renderRequest('openMessageLink', { href, ...(Number.isSafeInteger(options.rootIndex) ? { rootIndex: options.rootIndex } : {}) }).catch(error => { showError(error.message, origin); return false; });
    },
    onPreviewHtml: (source, button) => {
      try { window.UBOVMHtmlPreview.open(source, { returnFocus: button || document.activeElement, onCopy: text => renderRequest('copyText', { text }) }); }
      catch (error) { showError(error?.message || 'HTML 预览失败，请检查源码后重试。'); }
    }
  };
  const backgroundTasks = window.createBackgroundTasks(messageActions);
  document.querySelector('.shell')?.append(backgroundTasks.element);
  const workerPanel = window.createWorkerPanel(messageActions, { openNative: id => { if (!hostState?.nativeWorkerPanel) return false; if (!hasPending('openWorker')) void renderRequest('openWorker', { workerId: id }).catch(() => {}); return true; }, initialWidth: workerPanelWidth, onWidthChange: width => { workerPanelWidth = width; persistDrafts(); } });
  byId('goal-log-bottom').addEventListener('click', () => {
    // showLatest re-enables follow mode so later stream ticks stay pinned to the end.
    goalExecutionLog?.showLatest();
    const log = byId('goal-output-content');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    if (['auto', 'scroll'].includes(getComputedStyle(log).overflowY)) {
      log.scrollTo({ top: log.scrollHeight, behavior });
    } else {
      // Narrow layouts scroll with the page instead of inside the log panel.
      log.lastElementChild?.scrollIntoView({ block: 'end', behavior });
    }
  });
  function updateInput() {
    if (hostState?.mode !== 'goal') resizeInput(input, Math.max(64, Math.min(220, Math.floor(window.innerHeight * .28))));
    updateSubmit(submit, input);
    updateComposer();
  }
  function updateComposer() {
    const sending = hasPending('prompt');
    const queued = hostState?.inputQueue?.length > 0;
    const liveSteer = busy && executionState().canSteer === true && !queued && !hostState?.queuePaused;
    const selectedMode = draftFor().approvalMode ?? (hostState?.requireToolApproval === false ? 'auto' : 'manual');
    for (const option of approvalMode.elements) setProperty(option, 'checked', option.value === selectedMode);
    setProperty(approvalMode, 'disabled', busy || sending || navigationPending());
    setProperty(form.dataset, 'state', busy ? 'running' : sending ? 'sending' : 'idle');
    setProperty(form.dataset, 'steer', String(liveSteer));
    setProperty(input, 'placeholder', busy
      ? (liveSteer ? '补充说明将立刻调整当前任务…' : '补充说明或下一条消息，发送后排队…')
      : '提问、规划，或描述你想完成的改动…');
    const status = byId('composer-status');
    if (status) setText(status, hostState?.recovering ? '正在恢复执行记录 · 可以先写草稿' : hasPending('cancelRun') ? '正在停止…' : busy ? (liveSteer ? '执行中 · Enter 立刻引导' : '执行中 · Enter 排队') : sending ? '正在发送…' : '');
    const shortcut = byId('prompt-shortcut');
    if (shortcut) setProperty(shortcut, 'hidden', busy || sending);
    const count = byId('prompt-count');
    if (count) {
      setProperty(count, 'hidden', input.value.length < 7200);
      setText(count, input.value.length.toLocaleString() + ' / 8,000');
      setProperty(count.dataset, 'limit', String(input.value.length >= 8000));
    }
  }
  let readingDrop = false, dropReadTask;
  function invalidateDropRead() { dropReadTask = undefined; readingDrop = false; clearDrop(); }
  function contextPending() { return readingDrop || hasPending('attachFile') || hasPending('clearFileContext'); }
  const fileDrag = transfer => [...(transfer?.types || [])].some(type => ['files', 'text/uri-list', 'resourceurls'].includes(type.toLowerCase()));
  let dragDepth = 0;
  const clearDrop = () => { dragDepth = 0; form.classList.remove('file-drag-over'); };
  form.addEventListener('dragenter', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); dragDepth++; form.classList.add('file-drag-over');
  });
  form.addEventListener('dragleave', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.stopPropagation(); if (--dragDepth <= 0) clearDrop();
  });
  form.addEventListener('dragover', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = byId('attach-file').disabled ? 'none' : 'copy';
  });
  form.addEventListener('drop', async event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); clearDrop();
    const sessionId = currentSessionId;
    if (visualSuspended() || byId('attach-file').disabled || readingDrop) return;
    const task = dropReadTask = {}, epoch = viewEpoch;
    readingDrop = true; updateControls();
    try {
      const files = [...event.dataTransfer.files];
      if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory)) throw new Error('请拖入文件，暂不支持文件夹。');
      let attachment;
      if (files.length) {
        if (files.length !== 1) throw new Error('当前一次支持一个文件，请分别拖入；新文件将替换已有附件。');
        const file = files[0];
        const bytes = await file.slice(0, 64000).arrayBuffer();
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: file.size > 64000 });
        if (content.includes('\0')) throw new Error('当前仅支持 UTF-8 文本文件。');
        attachment = { name: file.name, content, truncated: file.size > 64000 };
      } else {
        const resources = event.dataTransfer.getData('ResourceURLs');
        const uris = resources ? JSON.parse(resources) : event.dataTransfer.getData('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
        if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string' || !uris[0].startsWith('file:')) throw new Error('请拖入一个本地文本文件。');
        attachment = { uri: uris[0] };
      }
      if (dropReadTask !== task || epoch !== viewEpoch || sessionId !== currentSessionId) return;
      readingDrop = false;
      request('attachFile', { attachment }, () => { if (epoch === viewEpoch && sessionId === currentSessionId && !visualSuspended()) input.focus({ preventScroll: true }); });
    } catch (error) { if (dropReadTask === task) showError(error instanceof TypeError ? '无法读取文件，请使用 UTF-8 文本文件。' : error.message, sessionId); }
    finally { if (dropReadTask === task) { dropReadTask = undefined; readingDrop = false; updateControls(); } }
  });
  window.addEventListener('dragend', clearDrop);
  function resizeInput(field, maximum) {
    const width = field.clientWidth;
    if (!width) return;
    const previous = inputSizes.get(field);
    if (previous?.value === field.value && previous.width === width && previous.maximum === maximum) return;
    const scrollTop = field.scrollTop;
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, maximum) + 'px';
    field.scrollTop = scrollTop;
    inputSizes.set(field, { value: field.value, width, maximum });
  }
  function workspaceMissing() { return hostState?.context?.workspaceConfigured === false; }
  function configurationMissing() { return hostState?.ssh?.configured === false || hostState?.provider?.configured === false; }
  function updateSubmit(button, field) {
    setProperty(button.dataset, 'running', String(busy));
    const stop = busy && !field.value.trim();
    const liveSteer = busy && executionState().canSteer === true && !(hostState?.inputQueue?.length) && !hostState?.queuePaused;
    setProperty(button.dataset, 'actionMode', stop ? 'stop' : busy ? (liveSteer ? 'steer' : 'queue') : 'send');
    setAttribute(button, 'aria-label', stop ? '停止执行' : busy ? (liveSteer ? '引导当前任务' : '加入队列') : '发送任务');
    setProperty(button, 'title', stop ? '停止当前执行' : busy ? (liveSteer ? '立刻引导当前任务（Enter）' : '加入队列（Enter）') : '发送（Enter）');
    setAttribute(button.querySelector('path'), 'd', stop ? 'M6 6h12v12H6Z' : 'M12 19V5m-6 6 6-6 6 6');
    setProperty(button, 'disabled', connectionStatus === 'disconnected' || !currentSessionId || hostState?.recovering || navigationPending() || hasPending('rewindInput') || hasPending('cancelRun') || (stop ? hasPending('prompt') : configurationMissing() || hasPending('prompt') || hasPending('runGoal') || hasPending('resumeRun') || contextPending() || !field.value.trim() || field.value.length > field.maxLength));
  }
  function updateControls() {
    renderInputQueue();
    document.querySelectorAll('.message-rewind').forEach(button => {
      setProperty(button, 'disabled', rewindControlsBlocked());
    });
    const unavailable = !currentSessionId || navigationPending();
    const waiting = [...pending.values()].find(item => item.sessionId === currentSessionId && !['setMode', 'newChat'].includes(item.action));
    const waitingLabels = { openWorker: '正在打开日志', openMessageLink: '正在打开链接', attachFile: '正在添加文件', selectWorkspace: '正在打开工作区', saveGoal: '正在保存目标', addGoalNote: '正在保存笔记', prompt: '正在发送', cancelRun: '正在停止', runGoal: '正在准备执行', resumeRun: '正在恢复执行', copyText: '正在复制', steerInput: '正在发送引导', removeInput: '正在更新队列', resumeInputs: '正在继续队列' };
    setProperty(byId('operation-loading'), 'hidden', !waiting);
    setText(byId('operation-loading'), waiting ? (waitingLabels[waiting.action] || '正在处理操作') + '，请稍候…' : '');
    const openingWorker = hasPending('openWorker');
    document.querySelectorAll('.worker-card, .goal-log-worker').forEach(button => {
      if (button.disabled !== openingWorker) button.disabled = openingWorker;
      if (button.getAttribute('aria-busy') !== String(openingWorker)) button.setAttribute('aria-busy', String(openingWorker));
    });
    const promptPending = hasPending('prompt');
    setProperty(input, 'disabled', unavailable);
    setProperty(byId('new-create-chat'), 'disabled', unavailable || hasPending());
    setAttribute(byId('new-create').querySelector('summary'), 'aria-disabled', String(unavailable || hasPending()));
    renderNavigationFeedback();
    byId('new-create').querySelector('summary').setAttribute('aria-busy', String(navigationPending()));
    setProperty(byId('attach-file'), 'disabled', unavailable || busy || promptPending || contextPending());
    if (byId('remove-context')) setProperty(byId('remove-context'), 'disabled', unavailable || busy || promptPending || contextPending());
    document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = unavailable || busy || promptPending; });
    const saving = hasPending('saveGoal');
    setProperty(objectiveInput, 'disabled', unavailable || busy || saving);
    setProperty(factsInput, 'disabled', unavailable || busy || saving);
    setProperty(criteriaInput, 'disabled', unavailable || busy || saving);
    setProperty(byId('goal-save'), 'disabled', unavailable || workspaceMissing() || busy || saving || hasPending('toggleGoalCriterion') || !objectiveInput.value.trim());
    setProperty(byId('goal-workspace-required'), 'hidden', !workspaceMissing());
    setProperty(byId('goal-save'), 'textContent', saving ? '正在保存…' : '保存目标');
    setProperty(byId('goal-cancel'), 'disabled', unavailable || saving);
    setProperty(byId('goal-edit'), 'disabled', unavailable || busy || saving || hasPending('toggleGoalCriterion'));
    const runPending = hostState?.recovering || hasPending('runGoal') || hasPending('resumeRun') || promptPending;
    const canResume = executionState().canResume === true;
    setProperty(byId('goal-run'), 'hidden', busy || canResume);
    setProperty(byId('goal-run'), 'disabled', unavailable || configurationMissing() || runPending || saving || !hostState?.goal || executionState().status === 'completed');
    setText(byId('goal-run'), executionState().status === 'completed' ? '已完成' : runPending ? '正在准备…' : ['failed', 'interrupted'].includes(executionState().status) ? '重新执行' : '开始执行');
    setProperty(byId('goal-stop'), 'hidden', !busy);
    setProperty(byId('goal-stop'), 'disabled', unavailable || hasPending('cancelRun'));
    setProperty(byId('goal-stop'), 'textContent', hasPending('cancelRun') ? '正在停止…' : '停止执行');
    setProperty(byId('goal-resume'), 'hidden', busy || !canResume);
    setProperty(byId('goal-resume'), 'disabled', unavailable || configurationMissing() || runPending);
    const resumeLabel = hasPending('resumeRun') ? '正在恢复…' : executionState().status === 'completed' ? '恢复结果' : '继续执行';
    setText(byId('goal-resume'), resumeLabel);
    setProperty(byId('assist-resume'), 'disabled', unavailable || configurationMissing() || runPending);
    setText(byId('assist-resume'), resumeLabel);
    syncAssistResume();
    const savingNote = hasPending('addGoalNote');
    setProperty(noteInput, 'disabled', unavailable || savingNote);
    setProperty(byId('goal-add-note'), 'disabled', unavailable || !hostState?.goal || savingNote || !noteInput.value.trim());
    setProperty(byId('goal-add-note'), 'textContent', savingNote ? '正在保存…' : '保存笔记');
    setProperty(byId('note-new'), 'disabled', unavailable || !hostState?.goal);
    setText(byId('note-new'), noteInput.value ? '继续草稿' : '＋ 新建笔记');
    setText(byId('note-length'), noteInput.value.length.toLocaleString() + ' / 2,000');
    setText(byId('note-draft-status'), savingNote ? '正在保存到当前目标…' : busy ? '任务执行中也可保存笔记，关闭后保留草稿。' : '关闭后保留草稿');
    byId('criteria-list').querySelectorAll('input').forEach(checkbox => {
      checkbox.disabled = unavailable || busy || saving || hasPending('toggleGoalCriterion', checkbox.dataset.criterionId);
    });
    // Execution/control changes do not change the draft's geometry. Input and
    // ResizeObserver events own sizing, avoiding a layout read after DOM writes.
    updateSubmit(submit, input);
    updateComposer();
    renderConnectionStatus();
  }
  function showConversation(hasMessages) {
    if (showingConversation === hasMessages) return;
    const hadFocus = document.activeElement === input;
    showingConversation = hasMessages;
    byId('empty-state').hidden = hasMessages;
    conversation.hidden = !hasMessages;
    byId('compose-dock').hidden = !hasMessages;
    byId(hasMessages ? 'composer-chat-slot' : 'composer-home-slot').appendChild(byId('composer-stack'));
    if (hadFocus) input.focus({ preventScroll: true });
    updateInput();
  }
  function sameParts(left, right) {
    if (left === right) return true;
    if (!Array.isArray(left) || !Array.isArray(right)) return !left?.length && !right?.length;
    return left.length === right.length && left.every((part, index) => ['id', 'type', 'text', 'name', 'status', 'args', 'output', 'startedAt', 'endedAt', 'truncated', 'source', 'workerId', 'fallback', 'beforeTokens', 'afterTokens'].every(key => part[key] === right[index]?.[key]));
  }
  function visibleTimelineParts(parts) {
    return window.UBOVMTimeline.visibleTimelineParts(parts);
  }
  function hasVisibleTimeline(text, parts) {
    return Boolean(typeof text === 'string' && text.trim()) || visibleTimelineParts(parts).length > 0;
  }
  function renderApprovals(view) {
    view.approvals ??= new Map();
    const approvals = hostState?.toolApprovals || [];
    const records = approvals.filter(record => record.status === 'pending');
    const completed = new Set(approvals.filter(record => ['approved', 'denied', 'cancelled'].includes(record.status)).map(record => record.id));
    let changed = false;
    // An omitted record is not a decision. Keep unresolved requests until the
    // host explicitly confirms a terminal status (or the session changes).
    for (const [id, card] of view.approvals) if (completed.has(id)) { card.element.remove(); view.approvals.delete(id); changed = true; }
    for (const record of records) {
      let card = view.approvals.get(record.id);
      if (!card) {
        const element = document.createElement('article'); element.className = 'approval-card';
        let parameters;
        try { parameters = JSON.parse(record.args); } catch {}
        const command = typeof parameters?.command === 'string' ? parameters.command : '';
        const toolTitle = window.UBOVMTimeline?.displayActivityLabel?.(record.toolName) || record.toolName || '调用工具';
        const title = document.createElement('strong'); title.textContent = command ? '运行命令' : toolTitle;
        const icon = document.createElement('span'); icon.className = 'approval-icon'; icon.textContent = command ? '>_' : '◇'; icon.setAttribute('aria-hidden', 'true');
        const status = document.createElement('span'); status.className = 'approval-status'; status.setAttribute('role', 'status');
        const header = document.createElement('summary'); header.className = 'approval-header'; header.append(icon, title, status);
        const target = document.createElement('span'); target.className = 'approval-target'; target.textContent = command ? command.split(/\r?\n/, 1)[0] : toolTitle; target.title = command || toolTitle;
        header.insertBefore(target, status);
        const chevron = document.createElement('span'); chevron.className = 'approval-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true'); header.append(chevron);
        const disclosure = document.createElement('details'); disclosure.className = 'approval-request'; disclosure.open = true;
        const content = document.createElement('div'); content.className = 'approval-content';
        const description = document.createElement('p'); description.className = 'approval-description'; description.textContent = command ? '此命令需要你的确认后才能执行。' : '此工具调用需要你的确认后才能执行。';
        const preview = document.createElement('pre'); preview.className = 'approval-preview'; preview.tabIndex = 0;
        preview.textContent = command || record.args || toolTitle; preview.setAttribute('aria-label', command ? '待执行命令' : '调用参数预览');
        const worker = document.createElement('p'); worker.className = 'approval-worker';
        worker.textContent = record.workerId ? '来自并行任务' : ''; worker.hidden = !record.workerId;
        const details = document.createElement('details'); details.className = 'approval-parameters';
        const summary = document.createElement('summary'); summary.textContent = '查看完整参数';
        const args = document.createElement('pre'); args.textContent = record.args; args.tabIndex = 0;
        details.append(summary, args);
        content.append(description, preview, worker, details); disclosure.append(header, content);
        const actions = document.createElement('div'); actions.className = 'approval-actions';
        const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = '允许一次'; approve.className = 'approval-allow';
        const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = '拒绝'; deny.className = 'approval-deny';
        actions.append(deny, approve);
        const hint = document.createElement('span'); hint.className = 'approval-scope'; hint.textContent = '仅本次调用'; actions.prepend(hint);
        const feedback = document.createElement('p'); feedback.className = 'approval-feedback'; feedback.hidden = true; feedback.setAttribute('role', 'status');
        element.append(disclosure, feedback, actions); messages.append(element);
        card = { element, header, disclosure, feedback, status, actions, approve, deny, state: '', sending: false };
        view.approvals.set(record.id, card);
        for (const [button, decision] of [[approve, 'approve'], [deny, 'deny']]) button.addEventListener('click', () => {
          if (card.state !== 'pending' || card.sending) return;
          card.sending = true; approve.disabled = deny.disabled = true;
          card.feedback.hidden = true; card.element.setAttribute('aria-busy', 'true');
          status.textContent = decision === 'approve' ? '正在允许…' : '正在拒绝…';
          request('toolApproval', { approvalId: record.id, decision }, () => {
            card.sending = false; card.element.removeAttribute('aria-busy');
            if (card.state === 'pending') status.textContent = '已提交，等待同步';
          }, () => {
            card.sending = false; approve.disabled = deny.disabled = card.state !== 'pending';
            card.element.removeAttribute('aria-busy');
            if (card.state === 'pending') {
              status.textContent = '等待确认'; card.feedback.textContent = '提交未完成，请重试。'; card.feedback.hidden = false;
            }
          });
        });
        changed = true;
      }
      if (card.state !== record.status) {
        const restoreFocus = card.actions.contains(document.activeElement);
        card.state = record.status; card.element.dataset.status = record.status;
        card.status.textContent = ({ pending: '等待确认', approved: '已允许', denied: '已拒绝', cancelled: '已取消' })[record.status] || '已失效';
        card.element.removeAttribute('aria-busy'); card.feedback.hidden = true;
        if (record.status !== 'pending') card.disclosure.open = false;
        card.actions.hidden = record.status !== 'pending';
        card.approve.disabled = card.deny.disabled = card.sending || record.status !== 'pending';
        if (restoreFocus && record.status !== 'pending') card.header.focus({ preventScroll: true });
        changed = true;
      }
    }
    return changed;
  }
  function parkResumeNote() {
    const note = byId('assist-resume-note');
    const home = byId('assist-resume-note-home');
    if (note && home && note.parentElement !== home) home.appendChild(note);
    messages.querySelectorAll('.has-resume').forEach(element => element.classList.remove('has-resume'));
  }
  function attachResumeNote(note, article) {
    const body = article.querySelector(':scope > .message-text');
    const next = body?.nextElementSibling;
    if (body && next !== note) article.insertBefore(note, next);
    else if (note.parentElement !== article) article.appendChild(note);
    article.classList.add('has-resume');
  }
  function syncAssistResume() {
    const banner = byId('assist-resume-banner');
    const note = byId('assist-resume-note');
    const execution = executionState();
    const pending = hasPending('resumeRun');
    const show = !busy && execution.canResume === true && hostState?.mode !== 'goal';
    const status = ['completed', 'interrupted', 'failed'].includes(execution.status) ? execution.status : 'interrupted';
    const titles = { completed: '结果待写入对话', interrupted: '任务已中断', failed: '任务未完成' };
    const hints = {
      completed: '本轮已经结束，回复还没有写进对话。用旁边的按钮补齐结果，不必重新发送。',
      interrupted: '检查点已保存。从中断处继续即可，不必再发一遍相同指令。',
      failed: '可从已有检查点继续。先确认错误是否需要调整，再恢复执行。'
    };
    const notes = {
      completed: '回复还没有写进这条对话。从下方输入区补齐结果。',
      interrupted: '执行在这里停下。检查点已保存，从下方输入区继续。',
      failed: '本轮未能完成。可从下方输入区按检查点恢复。'
    };
    const title = titles[status] || '可继续执行';
    const hint = pending ? '正在从检查点恢复…'
      : configurationMissing() ? '先完成模型连接，再从检查点继续。'
      : (hints[status] || '可从检查点继续当前任务。');
    setProperty(banner, 'hidden', !show);
    setProperty(banner.dataset, 'status', show ? status : '');
    setProperty(banner.dataset, 'pending', pending ? 'true' : '');
    setAttribute(banner, 'aria-busy', String(pending));
    setText(byId('assist-resume-title'), title);
    setText(byId('assist-resume-hint'), hint);
    parkResumeNote();
    if (!show) {
      setProperty(note, 'hidden', true);
      setText(note, '');
      return;
    }
    setText(note, pending ? '正在从检查点恢复…' : (notes[status] || title));
    setProperty(note, 'hidden', false);
    const view = messageViews.get(messages);
    const last = [view?.stream, ...[...(view?.entries || [])].reverse()]
      .find(entry => entry?.role === 'assistant' && entry.article && !entry.article.hidden)?.article;
    if (last) attachResumeNote(note, last);
    else if (showingConversation) messages.appendChild(note);
  }
  function createMessageEntry(role, text, parts, streaming = false) {
    const article = document.createElement('article');
    article.className = 'message ' + role + (streaming ? ' streaming-message' : '');
    if (streaming) article.dataset.streaming = 'true';
    const heading = document.createElement('div');
    heading.className = 'message-heading';
    heading.textContent = role === 'user' ? '你' : 'UBOVM';
    const body = document.createElement('div');
    body.className = 'message-text';
    window.UBOVMMessage.update(body, text, { ...messageActions, role, parts, streaming, preserveBody: !streaming });
    article.append(heading, body);
    return { article, heading, body, role, text, parts };
  }
  function messageHistoryKey(item) {
    return typeof item.id === 'string' && item.id ? JSON.stringify([item.role, 'message', item.id])
      : item.parts?.[0]?.id ? JSON.stringify([item.role, 'part', item.parts[0].id]) : undefined;
  }
  function decorateHistoryEntry(entry, item) {
    const hideEmpty = item.role === 'assistant' && !hasVisibleTimeline(item.text, item.parts);
    let changed = false;
    if (entry.article.hidden !== hideEmpty) { entry.article.hidden = hideEmpty; changed = true; }
    const steeringStatus = item.role === 'user' ? item.steeringStatus : undefined;
    entry.article.classList.toggle('steering-message', Boolean(steeringStatus));
    if (steeringStatus) {
      entry.article.dataset.steeringStatus = steeringStatus;
      if (entry.steeringStatus !== steeringStatus) {
        const badge = document.createElement('span'); badge.className = 'message-steering-badge'; badge.textContent = '引导';
        const status = document.createElement('span'); status.className = 'message-steering-status';
        status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
        status.textContent = steeringStatus === 'accepted' ? '已送达' : steeringStatus === 'sending' ? '等待送达确认' : '送达待确认';
        status.title = steeringStatus === 'accepted' ? '已交给当前 Agent，将用于调整后续执行；不表示任务已经完成' : '请核实队列与执行结果，未确认的输入不会自动重发';
        entry.heading.replaceChildren(badge, status); changed = true;
        if (steeringStatus !== 'accepted') {
          const hint = document.createElement('span'); hint.className = 'message-steering-hint';
          hint.textContent = steeringStatus === 'sending' ? '确认送达前不会自动重复发送' : '请核实执行结果，再决定是否重新提交';
          entry.heading.appendChild(hint);
        }
      }
    } else if (entry.article.dataset.steeringStatus) {
      delete entry.article.dataset.steeringStatus;
      entry.heading.textContent = item.role === 'user' ? '你' : 'UBOVM';
      changed = true;
    }
    entry.steeringStatus = steeringStatus;
    if (hostState?.mode === 'assist' && item.role === 'user' && item.id) {
      if (!entry.rewind) {
        entry.rewind = document.createElement('button');
        entry.rewind.className = 'message-rewind'; entry.rewind.type = 'button';
        entry.rewind.setAttribute('aria-label', '回退到此消息');
        entry.rewind.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/></svg>';
        entry.rewind.title = '停止 Agent，移除此消息及后续对话并取回输入；不会撤销文件或外部操作';
        entry.article.appendChild(entry.rewind);
      }
      const button = entry.rewind, sessionId = currentSessionId;
      const rewind = () => {
        if (!button.isConnected || button.disabled || button.onclick !== rewind || sessionId !== currentSessionId || rewindControlsBlocked()) return;
        restoreInput('rewindInput', { messageId: item.id }, item.text);
      };
      button.onclick = rewind;
      button.disabled = rewindControlsBlocked();
    }
    entry.messageId = item.id;
    return changed;
  }
  function scheduleHistoryFill() {
    if (historyFillFrame || pageHidden()) return;
    historyFillFrame = requestAnimationFrame(() => {
      historyFillFrame = 0;
      if (pageHidden() || hostState?.mode === 'goal') return;
      const view = messageViews.get(messages);
      if (!view || view.sessionId !== currentSessionId || !(view.historyStart > 0) || !Array.isArray(view.history)) return;
      const batchEnd = view.historyStart;
      const batchStart = Math.max(0, batchEnd - HISTORY_BATCH);
      const batch = view.history.slice(batchStart, batchEnd);
      const scroller = conversation;
      const position = scrollPositions.get(scroller);
      const previousHeight = scroller.scrollHeight;
      const previousTop = scroller.scrollTop;
      const following = position.following && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
      const fragment = document.createDocumentFragment();
      const prefix = [];
      for (const item of batch) {
        const parts = item.role === 'assistant' ? visibleTimelineParts(item.parts) : item.parts;
        const entry = createMessageEntry(item.role, item.text, parts);
        entry.key = messageHistoryKey(item);
        decorateHistoryEntry(entry, item);
        if (entry.role === 'assistant' && typeof entry.messageId === 'string' && entry.messageId.startsWith('assist:')) {
          entry.changes = document.createElement('section');
          entry.article.appendChild(entry.changes);
          window.UBOVMCodeChanges.update(entry.changes, hostState?.codeChanges?.[entry.messageId.slice(7)], {
            turnId: entry.messageId.slice(7), busy, onAction: (action, payload) => new Promise((resolve, reject) => {
              if (!entry.changes.isConnected || view.sessionId !== currentSessionId) { reject(new Error('会话已切换，请返回原会话操作。')); return; }
              if (!request(action, payload, resolve, reject)) reject(new Error('操作未发送，请稍后重试。'));
            })
          });
        }
        prefix.push(entry);
        fragment.appendChild(entry.article);
      }
      const anchor = view.entries[0]?.article || view.stream?.article || null;
      messages.insertBefore(fragment, anchor);
      view.entries = prefix.concat(view.entries);
      view.historyStart = batchStart;
      if (!following) {
        scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
        position.top = scroller.scrollTop;
      } else {
        scroller.scrollTop = scroller.scrollHeight;
        position.top = scroller.scrollTop;
        position.following = true;
      }
      try { renderConversationOutline(); } catch { /* Outline can catch up on the next full paint. */ }
      refreshLatest();
      if (view.historyStart > 0) scheduleHistoryFill();
    });
  }
  function renderMessages(items) {
    parkResumeNote();
    let view = messageViews.get(messages);
    // Execution-only publications retain the immutable history array; full
    // state publications replace it and reconcile edits and deletions.
    const historyChanged = view?.sessionId !== currentSessionId || view.source !== items;
    const safeMessages = historyChanged ? items.filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string') : view.history;
    const execution = executionState();
    const executionParts = Array.isArray(execution.parts) ? execution.parts : [];
    const firstPartId = executionParts[0]?.id;
    const represented = !historyChanged && view.firstPartId === firstPartId ? view.represented
      : executionParts.length && safeMessages.some(item => item.role === 'assistant' && item.parts?.some(part => part.id === firstPartId));
    const liveParts = visibleTimelineParts(!represented && (busy || ['failed', 'interrupted'].includes(execution.status) || execution.canResume) ? executionParts : []);
    const streamText = !represented && busy && typeof execution.streamText === 'string' ? execution.streamText : '';
    const hasLive = liveParts.length > 0 || Boolean(streamText);
    const container = messages;
    const scroller = conversation;
    const position = scrollPositions.get(scroller);
    if (scroller.scrollTop < position.top - 1) position.following = false;
    const followingPending = pendingScroll?.scroller === scroller && pendingScroll.sessionId === currentSessionId;
    const shouldScroll = forceScroll || !showingConversation ||
      (position.following && (followingPending || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32));
    forceScroll = false;
    if (view?.sessionId !== currentSessionId) {
      cancelHistoryFill();
      container.replaceChildren();
      view = { sessionId: currentSessionId, entries: [], stream: null, busy: undefined, historyStart: 0 };
      messageViews.set(container, view);
    }
    // Fresh session mounts paint the newest turns first so the loader can clear
    // before older Markdown work. Same-session history edits keep full reconcile.
    const progressive = historyChanged && view.entries.length === 0 && safeMessages.length > HISTORY_TAIL;
    const paintStart = progressive ? safeMessages.length - HISTORY_TAIL : 0;
    let changed = view.busy !== busy || view.entries.length !== safeMessages.length - paintStart;
    // Keep published history in place while only the transient reply grows.
    // Reading selections, focus, and scroll anchors survive token updates.
    if (historyChanged) {
      cancelHistoryFill();
      const paintMessages = safeMessages.slice(paintStart);
      const retained = new Map(view.entries.filter(entry => entry.key).map(entry => [entry.key, entry]));
      const used = new Set(), entries = [];
      for (const [index, item] of paintMessages.entries()) {
        const key = messageHistoryKey(item);
        let entry = key ? retained.get(key) : view.entries[index]?.key ? undefined : view.entries[index];
        if (used.has(entry)) entry = undefined;
        const publishedIds = new Set((item.parts || []).map(part => part.id));
        const promoted = !entry && item.role === 'assistant' && view.stream && (publishedIds.size && view.stream.parts?.some(part => publishedIds.has(part.id)) || !publishedIds.size && view.stream.text === item.text);
        const parts = item.role === 'assistant' ? visibleTimelineParts(item.parts) : item.parts;
        if (promoted) {
          entry = view.stream; view.stream = null;
          entry.article.classList.remove('streaming-message'); entry.article.removeAttribute('data-streaming');
          window.UBOVMMessage.update(entry.body, item.text, { ...messageActions, role: item.role, parts, streaming: false, preserveBody: true });
          entry.text = item.text; entry.parts = parts;
          changed = true;
        } else if (!entry) {
          entry = createMessageEntry(item.role, item.text, parts);
          changed = true;
        } else if (entry.role !== item.role || entry.text !== item.text || !sameParts(entry.parts, parts)) {
          entry.article.className = 'message ' + item.role;
          setText(entry.heading, item.role === 'user' ? '你' : 'UBOVM');
          entry.steeringStatus = undefined;
          window.UBOVMMessage.update(entry.body, item.text, { ...messageActions, role: item.role, parts, streaming: false, preserveBody: true });
          entry.role = item.role; entry.text = item.text; entry.parts = parts;
          changed = true;
        }
        if (decorateHistoryEntry(entry, item)) changed = true;
        entry.key = key; used.add(entry); entries.push(entry);
      }
      // Remove expired history first so trimming does not detach retained
      // messages and clear their text selections or focused controls.
      for (const entry of view.entries) if (!used.has(entry)) { window.UBOVMMessage.release(entry.body); entry.article.remove(); changed = true; }
      let previous = null;
      for (const entry of entries) {
        const next = previous ? previous.nextSibling : container.firstChild;
        if (entry.article !== next) { container.insertBefore(entry.article, next); changed = true; }
        previous = entry.article;
      }
      view.entries = entries;
      view.historyStart = paintStart;
      if (paintStart > 0) scheduleHistoryFill();
    }
    if (hasLive) {
      if (!view.stream) {
        view.stream = createMessageEntry('assistant', streamText, liveParts, busy);
        container.appendChild(view.stream.article);
        changed = true;
      } else if (view.stream.text !== streamText || !sameParts(view.stream.parts, liveParts) || view.busy !== busy) {
        window.UBOVMMessage.update(view.stream.body, streamText, { ...messageActions, role: 'assistant', parts: liveParts, streaming: busy });
        view.stream.text = streamText;
        view.stream.parts = liveParts;
        changed = true;
      }
      if (busy) view.stream.article.dataset.streaming = 'true'; else view.stream.article.removeAttribute('data-streaming');
      view.stream.article.classList.toggle('streaming-message', busy);
    } else if (view.stream) {
      window.UBOVMMessage.release(view.stream.body);
      view.stream.article.remove(); view.stream = null;
      changed = true;
    }
    // Turn snapshots are supplied by the host, never inferred from model prose.
    const updateChanges = (root, turnId) => window.UBOVMCodeChanges.update(root, hostState?.codeChanges?.[turnId], {
      turnId, busy, onAction: (action, payload) => new Promise((resolve, reject) => {
        if (!root.isConnected || view.sessionId !== currentSessionId) { reject(new Error('会话已切换，请返回原会话操作。')); return; }
        if (!request(action, payload, resolve, reject)) reject(new Error('操作未发送，请稍后重试。'));
      })
    });
    // Execution-only snapshots retain host-owned history and file summaries.
    // Avoid serializing every completed turn's file list for each new token.
    // Busy changes still refresh undo availability; failed renders never cache.
    if (historyChanged || view.busy !== busy || view.codeChanges !== hostState?.codeChanges) {
      const historyOffset = view.historyStart || 0;
      for (const [index, entry] of view.entries.entries()) {
        const id = entry.messageId || safeMessages[historyOffset + index]?.id;
        if (entry.role !== 'assistant' || !id?.startsWith('assist:')) continue;
        if (!entry.changes) { entry.changes = document.createElement('section'); entry.article.appendChild(entry.changes); changed = true; }
        changed = updateChanges(entry.changes, id.slice(7)) || changed;
      }
      view.codeChanges = hostState?.codeChanges;
    }
    const unfinishedChanges = !busy && execution.runId && hostState?.codeChanges?.[execution.runId]
      && !safeMessages.some(item => item.id === 'assist:' + execution.runId);
    if (unfinishedChanges) {
      if (!view.changeSummary) { view.changeSummary = document.createElement('section'); container.appendChild(view.changeSummary); changed = true; }
      changed = updateChanges(view.changeSummary, execution.runId) || changed;
    } else if (view.changeSummary) { view.changeSummary.remove(); view.changeSummary = undefined; changed = true; }
    changed = renderApprovals(view) || changed;
    view.busy = busy;
    view.source = items; view.history = safeMessages; view.firstPartId = firstPartId; view.represented = represented;
    showConversation(safeMessages.length > 0 || hasLive || busy || Boolean(execution.error) || execution.canResume === true || execution.workers?.length > 0 || view.approvals.size > 0);
    refreshLatest();
    if (!changed) return;
    cancelScroll();
    if (shouldScroll) {
      const sessionId = currentSessionId;
      const expectedTop = scroller.scrollTop;
      pendingScroll = { scroller, sessionId, frame: requestAnimationFrame(() => {
        pendingScroll = undefined;
        if (visualSuspended() || sessionId !== currentSessionId || hostState?.mode === 'goal' || scroller.scrollTop < expectedTop - 1) return;
        scroller.scrollTop = scroller.scrollHeight;
        position.top = scroller.scrollTop; position.following = true;
      }) };
    }
  }
  function renderMode() {
    const goalMode = hostState?.mode === 'goal';
    document.body.dataset.mode = goalMode ? 'goal' : 'assist';
    document.title = t(goalMode ? 'UBOVM · 探索工作台' : 'UBOVM · 协助');
    byId('assist-mode').hidden = goalMode;
    byId('goal-mode').hidden = !goalMode;
    byId('goal-identity').hidden = !goalMode;
    byId('goal-header-actions').hidden = !goalMode;
    byId('goal-view-switcher').hidden = !goalMode;
    byId('goal-header-more').hidden = !goalMode;
    if (!goalMode) { byId('goal-view-switcher').open = false; byId('goal-header-more').open = false; }
    setText(byId('new-create-chat'), goalMode ? '新建探索' : '新建对话');
    byId('new-create-chat').title = goalMode ? '在当前项目中新建探索' : '在当前项目中新建对话';
    byId('open-browser').hidden = goalMode;
    byId('validate-code-changes').hidden = goalMode;
    byId('review-code-changes').hidden = goalMode;
    byId('assist-notes-toggle').hidden = goalMode;
    renderModuleActions();
    updateInput();
  }
  function renderModuleActions() {
    const goalMode = hostState?.mode === 'goal';
    const editing = workspaceMissing() || !hostState?.goal || draftFor().goalEditing && !busy;
    const view = goalMode && !editing ? draftFor().view : '';
    setProperty(byId('goal-edit'), 'hidden', view !== 'overview');
    setProperty(byId('goal-board-actions'), 'hidden', view !== 'board');
    setProperty(byId('goal-notes-actions'), 'hidden', goalMode ? view !== 'notes' : draftFor().view !== 'notes');
    setProperty(byId('note-new'), 'hidden', !goalMode);
  }
  function renderGoalView() {
    renderModuleActions();
    const selected = draftFor().view;
    const label = { overview: '概览', board: '黑板', workers: '任务', notes: '笔记' }[selected];
    setText(byId('goal-current-view'), label);
    const currentIcon = byId('goal-current-icon');
    if (currentIcon.dataset.view !== selected) {
      currentIcon.replaceChildren(byId('goal-tab-' + selected).querySelector('svg').cloneNode(true));
      currentIcon.dataset.view = selected;
    }
    setAttribute(byId('goal-view-switcher').querySelector('summary'), 'aria-label', '当前页面：' + label + '，切换页面');
    setProperty(byId('goal-workspace').dataset, 'view', selected);
    for (const view of goalViews) {
      const active = view === selected;
      const tab = byId('goal-tab-' + view);
      setAttribute(tab, 'aria-selected', String(active));
      setProperty(tab, 'tabIndex', active ? 0 : -1);
      setProperty(byId('goal-' + view), 'hidden', !active);
    }
  }
  function setGoalView(view) {
    if (!goalViews.includes(view) || draftFor().view === view) return;
    const scroller = byId('goal-panels');
    const visibleView = goalViews.find(value => !byId('goal-' + value).hidden);
    if (visibleView) goalViewScroll.set(currentSessionId + ':' + visibleView, { top: scroller.scrollTop, following: scrollPositions.get(scroller).following });
    if (goalViewScroll.size > 400) goalViewScroll.delete(goalViewScroll.keys().next().value);
    cancelScroll();
    if (view !== 'notes') closeNoteEditor();
    // Worker detail can mark #main-content inert or visibility:hidden ("占据主空间").
    // Close it before the route paint so the newly selected page is actually shown.
    try { workerPanel.dismiss(false); } catch { /* Panel teardown must not block navigation. */ }
    draftFor().view = view;
    persistDrafts();
    // A route change must synchronize the outer mode and workspace as well as
    // the tab. Partial execution renders can otherwise retain a hidden ancestor.
    pendingViewRestore = { sessionId: currentSessionId, view };
    beginPageTransition('正在打开' + ({ overview: '思考日志', board: '黑板', workers: '任务', notes: '笔记' }[view]) + '…');
    scheduleRender();
  }
  function restoreFields() {
    const draft = draftFor();
    input.value = draft.assist;
    noteInput.value = draft.note;
    objectiveInput.value = draft.goalDraft ? draft.goalDraft.objective : hostState?.goal?.objective || '';
    factsInput.value = draft.goalDraft ? draft.goalDraft.initialFacts || '' : hostState?.goal?.initialFacts || '';
    criteriaInput.value = draft.goalDraft ? draft.goalDraft.criteria : (hostState?.goal?.criteria || []).map(item => item.text).join('\n');
  }
  function renderCriteria(criteria) {
    if (lastCriteriaSource === criteria) return;
    const serialized = JSON.stringify(criteria);
    if (serialized === lastCriteria) { lastCriteriaSource = criteria; return; }
    lastCriteriaSource = undefined;
    lastCriteria = '';
    const focusedId = document.activeElement?.dataset.criterionId;
    const list = document.createDocumentFragment();
    for (const criterion of criteria) {
      const label = document.createElement('label');
      label.className = 'criterion';
      label.dataset.done = String(criterion.done === true);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = criterion.done === true;
      checkbox.dataset.criterionId = criterion.id;
      checkbox.setAttribute('aria-label', '确认验收：' + criterion.text);
      checkbox.addEventListener('change', () => {
        const done = checkbox.checked;
        checkbox.checked = criterion.done === true;
        if (!hasPending('toggleGoalCriterion', criterion.id)) request('toggleGoalCriterion', { criterionId: criterion.id, done });
      });
      const text = document.createElement('span');
      text.textContent = criterion.text;
      label.append(checkbox, text);
      list.appendChild(label);
    }
    byId('criteria-list').replaceChildren(list);
    byId('criteria-empty').hidden = criteria.length > 0;
    if (focusedId) [...byId('criteria-list').querySelectorAll('input')].find(item => item.dataset.criterionId === focusedId)?.focus({ preventScroll: true });
    lastCriteria = serialized;
    lastCriteriaSource = criteria;
  }
  function renderNotes(notes) {
    if (lastNotesSource === notes) return;
    const serialized = JSON.stringify(notes);
    if (serialized === lastNotes) { lastNotesSource = notes; return; }
    lastNotesSource = undefined;
    lastNotes = '';
    renderNoteList(byId('goal-notes-list'), [...notes].reverse(), 'user');
    filterNotes();
    lastNotes = serialized;
    lastNotesSource = notes;
  }
  function renderNoteList(container, notes, source) {
    const existing = new Map([...container.children].map(row => [noteEntries.get(row)?.key, row]));
    const kept = new Set(); let previous;
    for (const note of notes) {
      const entry = noteDescription(note, source);
      const old = existing.get(entry.key), oldEntry = old && noteEntries.get(old);
      existing.delete(entry.key);
      // Reuse before allocating DOM or formatting dates. A new Agent note
      // should not construct and discard a button for every saved note.
      const row = oldEntry?.text === entry.text && oldEntry?.createdAt === entry.createdAt ? old : noteRow(note, source, entry);
      kept.add(row);
      const next = previous ? previous.nextSibling : container.firstChild;
      if (next !== row) container.insertBefore(row, next);
      previous = row;
    }
    for (const row of [...container.children]) if (!kept.has(row)) row.remove();
  }
  function noteDescription(note, source) {
    const text = typeof note.content === 'string' ? note.content : typeof note.text === 'string' ? note.text : '';
    const createdAt = note.created_at ?? note.createdAt;
    return { text, createdAt, key: source + ':' + (note.id ?? JSON.stringify([createdAt, text])) };
  }
  function noteRow(note, source, entry = noteDescription(note, source)) {
    const { text, key, createdAt } = entry;
    const article = document.createElement('article'); article.className = 'goal-note';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'note-select'; button.setAttribute('aria-pressed', 'false');
    const time = document.createElement('time'), timestamp = new Date(createdAt);
    if (!Number.isNaN(timestamp.getTime())) {
      time.dateTime = timestamp.toISOString();
      time.textContent = timestamp.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    const preview = document.createElement('p'); preview.textContent = text.length > 240 ? text.slice(0, 240) + '…' : text;
    button.append(preview, time); article.append(button);
    noteEntries.set(article, { key, text, createdAt, searchText: text.toLocaleLowerCase(), source, date: time.textContent });
    button.addEventListener('click', () => {
      selectedNoteKey = key; renderNoteReader(article);
      byId('goal-notes').dataset.reading = 'true';
      byId('note-reader-body').focus({ preventScroll: true });
    });
    return article;
  }
  function renderNoteReader(article) {
    const entry = article && noteEntries.get(article);
    for (const row of document.querySelectorAll('.note-select')) setAttribute(row, 'aria-pressed', String(noteEntries.get(row.parentElement)?.key === entry?.key));
    byId('note-copy').disabled = !entry;
    byId('note-reader-placeholder').hidden = Boolean(entry);
    byId('note-reader-body').hidden = !entry;
    const key = entry ? JSON.stringify([entry.key, entry.text]) : '';
    if (renderedNoteKey === key) return;
    byId('note-reader-body').tabIndex = -1;
    setText(byId('note-reader-meta'), entry ? (entry.source === 'user' ? '我的笔记' : 'Agent 记录') + (entry.date ? ' · ' + entry.date : '') : '笔记');
    // Clear through the renderer too: removing its children directly leaves
    // cached Markdown nodes detached and subsequent notes render offscreen.
    const body = byId('note-reader-body');
    const scrollTop = renderedNoteIdentity === entry?.key ? body.scrollTop : 0;
    let formatted = true;
    try {
      window.UBOVMMessage.update(body, entry?.text ?? '', { ...messageActions, role: 'assistant', streaming: false });
    } catch (error) {
      console.warn('Note formatting failed; showing original text.', error);
      window.UBOVMMessage.update(body, entry?.text ?? '', { role: 'user' });
      setText(byId('note-reader-meta'), '格式加载失败，已显示笔记原文');
      formatted = false;
    }
    body.hidden = !entry;
    renderedNoteKey = formatted ? key : undefined;
    renderedNoteIdentity = entry?.key ?? '';
    body.scrollTop = scrollTop;
  }
  function closeNoteEditor() {
    if (byId('note-editor').open) byId('note-editor').close();
    persistDrafts();
  }
  function filterNotes() {
    const query = byId('notes-search').value.trim().toLocaleLowerCase();
    let total = 0, shown = 0;
    for (const [source, listId, sectionId] of [['user', 'goal-notes-list', 'user-notes-section'], ['agent', 'agent-notes-list', 'agent-notes-section']]) {
      const entries = [...byId(listId).children];
      let visible = 0;
      for (const entry of entries) {
        entry.hidden = (noteSource !== 'all' && noteSource !== source) || !noteEntries.get(entry).searchText.includes(query);
        if (!entry.hidden) visible++;
      }
      total += entries.length; shown += visible;
      byId(sectionId).hidden = !visible;
    }
    for (const button of document.querySelectorAll('[data-note-source]')) setAttribute(button, 'aria-pressed', String(button.dataset.noteSource === noteSource));
    setText(byId('notes-total'), total + ' 条记录');
    setText(byId('notes-results'), query ? '找到 ' + shown + ' 条匹配记录' : '');
    byId('notes-results').hidden = !query;
    byId('notes-empty').hidden = shown > 0;
    const agentOnly = hostState?.mode !== 'goal';
    setText(byId('notes-empty-title'), query ? '没有找到匹配的笔记' : agentOnly || noteSource === 'agent' ? 'Agent 暂无记录' : total ? '还没有你的笔记' : '把重要的想法留在这里');
    setText(byId('notes-empty-description'), query ? agentOnly ? '换个关键词试试。' : '换个关键词试试，或切换笔记来源。' : agentOnly || noteSource === 'agent' ? '执行过程中产生的 Agent 笔记会显示在这里。' : '写下第一条笔记，记录这个目标的决定与进展。');
    const visible = [...byId('goal-notes-list').children, ...byId('agent-notes-list').children].filter(row => !row.hidden);
    const saved = savedNoteToReveal?.sessionId === currentSessionId ? visible.find(row => {
      const entry = noteEntries.get(row); return entry?.source === 'user' && entry.text === savedNoteToReveal.text;
    }) : undefined;
    const selected = saved ?? visible.find(row => noteEntries.get(row)?.key === selectedNoteKey) ?? visible[0];
    if (saved) { savedNoteToReveal = undefined; byId('goal-notes').dataset.reading = 'true'; }
    selectedNoteKey = selected ? noteEntries.get(selected).key : '';
    if (!selected) byId('goal-notes').dataset.reading = 'false';
    renderNoteReader(selected);
  }
  const activityViews = new WeakMap();
  const activityTimeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function renderActivities(container, activities) {
    const visible = activities.slice(-8).reverse().map(item => ({
      key: typeof item.key === 'string' ? item.key : '', label: item.label,
      status: typeof item.status === 'string' ? item.status : '',
      timestamp: typeof item.timestamp === 'number' || typeof item.timestamp === 'string' ? item.timestamp : null
    }));
    renderSection(container.id, visible, () => {
      let rows = activityViews.get(container);
      if (!rows) { rows = new Map(); activityViews.set(container, rows); }
      const retained = new Set(), occurrences = new Map();
      let cursor = container.firstChild;
      try {
        for (const item of visible) {
          const base = item.key || JSON.stringify([item.label, item.timestamp]);
          const occurrence = occurrences.get(base) || 0; occurrences.set(base, occurrence + 1);
          const key = JSON.stringify([currentSessionId, base, occurrence]); retained.add(key);
          let row = rows.get(key);
          if (!row) {
            const element = document.createElement('div'); element.className = 'activity-row';
            const text = document.createElement('p'), time = document.createElement('time');
            element.append(text, time); row = { element, text, time }; rows.set(key, row);
          }
          setText(row.text, window.UBOVMTimeline.displayActivityLabel(item.label) + (item.status ? ' · ' + statusText(item.status) : ''));
          if (row.timestamp !== item.timestamp) {
            const timestamp = item.timestamp === null ? new Date(NaN) : new Date(item.timestamp);
            const valid = !Number.isNaN(timestamp.getTime());
            setProperty(row.time, 'dateTime', valid ? timestamp.toISOString() : '');
            setText(row.time, valid ? activityTimeFormat.format(timestamp) : '');
            // Commit after DOM writes so a failed render retries the formatting.
            row.timestamp = item.timestamp;
          }
          if (row.element !== cursor) container.insertBefore(row.element, cursor);
          cursor = row.element.nextSibling;
        }
      } finally {
        // A failed update may leave new rows detached or obsolete rows mounted.
        // Keep only rows actually committed during this attempt, so repeated
        // failures with different snapshots cannot accumulate cached nodes.
        for (const [key, row] of rows) if (!retained.has(key) || row.element.parentElement !== container) {
          row.element.remove(); rows.delete(key);
        }
      }
    });
  }
  function factText(content) {
    if (typeof content !== 'string') return '';
    try {
      const fact = JSON.parse(content);
      if (fact?.version === 1 && typeof fact.statement === 'string' && Array.isArray(fact.evidence)) {
        const evidence = fact.evidence.map(item => item && typeof item.observation === 'string' ? '• ' + item.observation + (item.toolCallId || item.nodeRef ? ' [' + (item.toolCallId || item.nodeRef) + ']' : '') : '').filter(Boolean);
        const limitations = Array.isArray(fact.limitations) ? fact.limitations.filter(item => typeof item === 'string') : [];
        const statuses = { confirmed: '已确认', negative: '已否定', partial: '部分完成', blocked: '受阻' };
        const coverage = Array.isArray(fact.coverage) ? fact.coverage.filter(item => item && typeof item.point === 'string' && typeof item.result === 'string')
          .map(item => `${statuses[item.status] || '待确认'}：${item.point} — ${item.result}`) : [];
        const failed = Array.isArray(fact.failedChecks) ? fact.failedChecks.filter(item => typeof item === 'string') : [];
        const next = Array.isArray(fact.nextSteps) ? fact.nextSteps.filter(item => typeof item === 'string') : [];
        return [fact.statement, ...coverage, ...evidence, ...failed.map(item => '失败检查：' + item),
          ...limitations.map(item => '限制：' + item), ...next.map(item => '待办：' + item)].join('\n');
      }
    } catch { /* Plain facts remain readable without a structured Worker envelope. */ }
    return content;
  }
  let blackboardGraph, goalExecutionLog;
  function renderBlackboard(snapshot, completion) {
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const evidenceIds = completion?.complete === true && Array.isArray(completion.evidenceIds) ? completion.evidenceIds : [];
    renderSection('blackboard', [snapshot?.sessionId, snapshot?.revision, snapshot?.rootId, snapshot?.goal, nodes, evidenceIds], () => {
      byId('blackboard-empty').hidden = nodes.length > 0;
      byId('blackboard-nodes').hidden = nodes.length === 0;
      blackboardGraph ??= window.createBlackboardGraph(byId('blackboard-nodes'), { factText, statusText, actionsContainer: byId('goal-board-actions'),
        onDetail: hostState?.nativeBlackboardSidebar ? (detail, reveal) => vscode.postMessage({ action: 'blackboardDetail', sessionId: currentSessionId, detail, reveal }) : undefined });
      blackboardGraph.update(evidenceIds.length && snapshot ? { ...snapshot, completionEvidenceIds: evidenceIds } : snapshot);
      byId('blackboard-revision').textContent = Number.isInteger(snapshot?.revision) ? '修订 ' + snapshot.revision : '等待执行';
    });
  }
  function renderAgentNotes(memory) {
    const source = memory?.notes;
    const notes = (Array.isArray(source) ? source : source && typeof source === 'object' ? Object.values(source) : []).filter(note => note && (typeof note.content === 'string' || typeof note.text === 'string'));
    renderSection('agent-notes', notes, () => {
      renderNoteList(byId('agent-notes-list'), [...notes].reverse(), 'agent');
      filterNotes();
    });
  }
  function renderExecution() {
    const execution = executionState();
    const shell = document.querySelector('.shell');
    if (shell && backgroundTasks.element.parentElement !== shell) shell.append(backgroundTasks.element);
    backgroundTasks.update(hostState, ['disconnected', 'backend-disconnected'].includes(connectionStatus));
    const explorationRuns = Array.isArray(execution.explorationRuns) ? execution.explorationRuns.filter(run => run.busy === true) : [];
    setProperty(byId('exploration-runs'), 'hidden', explorationRuns.length === 0);
    if (!explorationRuns.length) byId('exploration-runs').open = false;
    setText(byId('exploration-run-count'), explorationRuns.length + ' 运行中');
    renderSection('exploration-runs', explorationRuns, () => {
      const fragment = document.createDocumentFragment();
      for (const run of explorationRuns) {
        const row = document.createElement('div'); row.className = 'exploration-run'; row.setAttribute('role', 'listitem');
        const open = document.createElement('button'); open.type = 'button'; open.className = 'text-button'; open.textContent = run.title;
        open.title = '查看探索：' + run.title;
        open.addEventListener('click', () => {
          byId('exploration-runs').open = false;
          vscode.postMessage({ action: 'openExploration', goalSessionId: run.id });
        });
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        const phase = run.busy ? phaseText(run.phase) : '';
        status.textContent = statusText(run.status) + (phase ? ' · ' + phase : '') + ` · ${run.activeWorkers || 0} 个任务运行中 / 共 ${run.workerCount || 0} 个`;
        row.append(open, status);
        if (run.error) { const error = document.createElement('p'); error.className = 'execution-error'; error.textContent = run.error; row.append(error); }
        fragment.append(row);
      }
      byId('exploration-run-list').replaceChildren(fragment);
    });
    const status = execution.status || (busy ? 'running' : 'idle');
    const phase = phaseText(execution.phase);
    const error = execution.error ? window.UBOVMErrors.text(execution.error) : '';
    const label = statusText(status) + (phase && busy ? ' · ' + phase : '');
    setText(byId('goal-run-status'), label);
    setProperty(byId('goal-run-status').dataset, 'status', status);
    setText(byId('busy-status'), label);
    // The active inline step already explains the wait; do not add a second
    // spinner and generic execution label below the same conversation.
    const inlineBusy = [...(execution.parts || []), ...(execution.workers || []).flatMap(worker => worker.parts || [])]
      .some(part => ['tool', 'thinking', 'summary'].includes(part.type) && part.status === 'running' && part.background !== true);
    setProperty(byId('busy-status'), 'hidden', !busy || inlineBusy);
    const goalMode = hostState?.mode === 'goal';
    const selected = draftFor().view;
    const headerStatus = byId('header-execution-status');
    setProperty(headerStatus, 'hidden', !goalMode || !busy || byId('goal-workspace').hidden);
    const headerLabel = selected === 'board' ? '正在推进目标，探索记录将在有新结果时更新…' : selected === 'notes' ? '执行中，新的工作笔记会自动出现…' : label;
    setText(headerStatus, headerLabel);
    setProperty(headerStatus, 'title', headerLabel);
    setProperty(byId('goal-run-status'), 'hidden', busy);
    setText(byId('execution-phase'), label);
    const captions = {
      idle: '点击“开始执行”，系统会规划步骤并分派并行任务。',
      starting: '正在加载会话、模型与工具。',
      running: '正在推进目标。你可以切换会话，执行会继续。',
      completed: execution.canResume ? '执行已完成，结果尚未显示。点击“恢复结果”补齐回复。' : '本轮执行已完成。结论与证据已保存在探索记录中，可追加指令继续。',
      interrupted: execution.canResume ? '执行已停止，检查点已保存。点击“继续执行”恢复。' : '执行已停止。',
      failed: execution.canResume ? '执行失败。修复错误后，可从已有检查点继续。' : '执行失败，请检查错误后重试。'
    };
    setText(byId('execution-caption'), captions[status] || '');
    for (const id of ['execution-error', 'assist-execution-error']) {
      setText(byId(id), error ? window.UBOVMErrors.text(error) : '');
      setProperty(byId(id), 'hidden', !error);
    }
    const middleware = execution.middleware;
    const integrations = execution.integrations || (middleware && {
      contextSummary: middleware.contextSummary ? '已启用' : '未启用',
      mcp: Array.isArray(middleware.mcp) ? middleware.mcp.filter(server => server.connected).length + ' / ' + middleware.mcp.length + ' 个服务已加载' : undefined,
      skills: Array.isArray(middleware.skills) ? middleware.skills.length + ' 个可用技能' : undefined
    });
    const integrationLabels = { database: '数据库', contextSummary: '上下文摘要', mcp: 'MCP', skills: 'Skills' };
    const integrationText = integrations && typeof integrations === 'object' ? Object.entries(integrationLabels).filter(([key]) => typeof integrations[key] === 'string').map(([key, name]) => name + '：' + integrations[key]).join(' · ') : '';
    setText(byId('execution-integrations'), integrationText);
    setProperty(byId('execution-integrations'), 'hidden', !integrationText);
    const workers = Array.isArray(execution.workers) ? execution.workers : [];
    workerPanel.update({ sessionId: currentSessionId, workers, goalMode, error: execution.workerViewError?.message });
    if (goalMode && selected === 'overview' && !byId('goal-output-content').parentElement.closest('[hidden]')) {
      goalExecutionLog ??= window.createGoalExecutionLog(byId('goal-output-content'), { actions: messageActions, statusText, openWorker: (id, button) => workerPanel.show(id, button) });
      const count = goalExecutionLog.update(currentSessionId, execution);
      setProperty(byId('goal-output-content'), 'hidden', !count);
      setProperty(byId('goal-log-bottom'), 'disabled', !count);
      setProperty(byId('goal-output-empty'), 'hidden', count > 0);
      setText(byId('goal-output-empty'), busy ? '正在启动，执行日志将在事件产生后显示。' : '执行后，规划、任务派发和工具调用会按顺序显示在这里。');
      setText(byId('goal-output-title'), '思考与调度日志');
      setText(byId('goal-output-status'), label + ' · ' + count + ' 条记录');
      setAttribute(byId('goal-output-status'), 'data-phase', status);
      // Empty-state / flex height changes after update; re-align follow once layout settles.
      if (count) goalExecutionLog.alignFollow?.();
    }
    let remainingActivities = [];
    if (!goalMode) {
      remainingActivities = window.UBOVMTimeline.visibleActivities(execution.activities, hostState);
      renderActivities(byId('assist-activities'), remainingActivities);
      setProperty(byId('assist-execution'), 'hidden', !remainingActivities.length && !error);
    } else setProperty(byId('assist-execution'), 'hidden', true);
    if (goalMode && selected === 'board') renderBlackboard(execution.blackboard, execution.result);
    if (selected === 'notes') renderAgentNotes(execution.memory);
  }
  function renderGoal() {
    const goalMode = hostState?.mode === 'goal';
    setAttribute(byId('goal-notes'), 'aria-labelledby', goalMode ? 'goal-tab-notes' : 'assist-notes-toggle');
    setAttribute(byId('goal-notes'), 'role', goalMode ? 'tabpanel' : 'region');
    setProperty(byId('goal-notes').querySelector('.notebook-filters'), 'hidden', !goalMode);
    if (!goalMode) {
      const showingNotes = draftFor().view === 'notes';
      setProperty(byId('assist-mode'), 'hidden', showingNotes);
      setProperty(byId('goal-mode'), 'hidden', !showingNotes);
      setAttribute(byId('goal-mode'), 'aria-label', '协助笔记');
      setProperty(byId('goal-setup'), 'hidden', true);
      setProperty(byId('goal-workspace'), 'hidden', !showingNotes);
      setText(byId('assist-notes-toggle'), showingNotes ? '返回对话' : '笔记');
      setAttribute(byId('assist-notes-toggle'), 'aria-expanded', String(showingNotes));
      renderGoalView();
      if (showingNotes) renderNotes([]);
      return;
    }
    setAttribute(byId('goal-mode'), 'aria-label', '探索模式');
    const goal = hostState?.goal;
    const editing = workspaceMissing() || !goal || (draftFor().goalEditing && !busy);
    renderModuleActions();
    setProperty(byId('goal-header-actions'), 'hidden', editing);
    setProperty(byId('goal-view-switcher'), 'hidden', editing);
    if (editing) byId('goal-view-switcher').open = false;
    setProperty(byId('goal-identity').dataset, 'hasGoal', String(Boolean(goal)));
    setProperty(byId('goal-objective'), 'hidden', !goal);
    setProperty(byId('goal-intro'), 'hidden', Boolean(goal));
    setProperty(byId('goal-editor'), 'hidden', !editing);
    setProperty(byId('goal-setup'), 'hidden', !editing);
    setProperty(byId('goal-editor-title'), 'textContent', goal ? '编辑目标' : '定义你的目标');
    setProperty(byId('goal-cancel'), 'hidden', !goal || workspaceMissing());
    setProperty(byId('goal-workspace'), 'hidden', editing);
    renderGoalView();
    if (goal) {
      const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
      const notes = Array.isArray(goal.notes) ? goal.notes : [];
      setText(byId('goal-objective'), goal.objective);
      setProperty(byId('goal-objective'), 'title', goal.objective);
      setText(byId('goal-progress'), criteria.filter(item => item.done).length + ' / ' + criteria.length);
      setProperty(byId('goal-completion'), 'max', Math.max(1, criteria.length));
      setProperty(byId('goal-completion'), 'value', criteria.filter(item => item.done).length);
      setProperty(byId('goal-completion'), 'hidden', criteria.length === 0);
      setProperty(byId('goal-progress-caption'), 'hidden', criteria.length === 0);
      setText(byId('goal-note-count'), String(notes.length));
      setText(byId('goal-nav-notes'), String(notes.length));
      const sourceEvidence = Array.isArray(goal.sourceEvidence) ? goal.sourceEvidence : [];
      setText(byId('goal-source-evidence-count'), String(sourceEvidence.length));
      setProperty(byId('goal-source-evidence'), 'hidden', sourceEvidence.length === 0);
      setProperty(byId('goal-note-count').closest('.goal-meta'), 'hidden', false);
      const evidencePanel = byId('goal-source-evidence-panel');
      setProperty(evidencePanel, 'hidden', sourceEvidence.length === 0);
      const evidenceList = byId('goal-source-evidence-list');
      const evidenceKey = JSON.stringify(sourceEvidence.map(item => [item.id, item.statement, item.observations]));
      if (evidenceList.dataset.key !== evidenceKey) {
        evidenceList.dataset.key = evidenceKey;
        evidenceList.replaceChildren(...sourceEvidence.map(item => {
          const row = document.createElement('li');
          const title = document.createElement('strong');
          title.textContent = item.statement;
          const meta = document.createElement('small');
          const observations = Array.isArray(item.observations) ? item.observations.filter(Boolean) : [];
          meta.textContent = (observations.length ? observations.map(value => '• ' + value).join('\n') + '\n' : '') + '从对话带入的参考，不能单独证明目标完成';
          row.append(title, meta);
          return row;
        }));
      }
      setText(byId('goal-provider-label'), hostState.provider?.label || '未连接模型');
      if (draftFor().view === 'overview') renderCriteria(criteria);
      if (draftFor().view === 'notes') renderNotes(notes);
    }
  }
  function selectedAssistEvidenceIds() {
    return [...byId('assist-evidence-list').querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')].map(item => item.value);
  }
  function assistEvidenceAttachedIds(goalId) {
    const goal = (hostState?.relatedConversations || []).find(item => item.id === goalId && item.mode === 'goal');
    return new Set(Array.isArray(goal?.sourceEvidenceIds) ? goal.sourceEvidenceIds : []);
  }
  function updateAssistEvidenceActions() {
    const panel = byId('assist-evidence');
    if (panel.hidden) return;
    const goals = (hostState?.relatedConversations || []).filter(item => item.mode === 'goal');
    const selected = selectedAssistEvidenceIds();
    const goalId = byId('assist-evidence-goal').value;
    const attached = assistEvidenceAttachedIds(goalId);
    const pendingSelected = selected.filter(id => !attached.has(id));
    byId('assist-evidence-attach').disabled = !pendingSelected.length || !goalId || !goals.length || navigationPending() || hasPending('attachAssistEvidence');
    byId('assist-evidence-select-pending').disabled = !goals.length || !goalId;
    byId('assist-evidence-clear').disabled = !selectedAssistEvidenceIds().length && ![...byId('assist-evidence-list').querySelectorAll('input[type="checkbox"]:checked')].length;
    const hint = byId('assist-evidence-hint');
    if (!goals.length) {
      hint.hidden = false;
      setText(hint, '尚无关联探索。可先让助手创建关联目标，或从会话栏打开已有探索。');
    } else if (!pendingSelected.length) {
      hint.hidden = false;
      setText(hint, selected.length ? '所选证据已附加到当前探索；可改选目标或勾选未附加项。' : '勾选尚未附加的证据，再注入探索模式。');
    } else {
      hint.hidden = false;
      setText(hint, '将附加 ' + pendingSelected.length + ' 条新证据到所选探索。');
    }
  }
  function renderAssistEvidence() {
    const panel = byId('assist-evidence');
    const goalMode = hostState?.mode === 'goal';
    const evidence = Array.isArray(hostState?.assistEvidence) ? hostState.assistEvidence : [];
    if (goalMode || !evidence.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    setText(byId('assist-evidence-count'), String(evidence.length));
    const selected = new Set(selectedAssistEvidenceIds());
    const goals = (hostState?.relatedConversations || []).filter(item => item.mode === 'goal');
    const select = byId('assist-evidence-goal');
    const previous = select.value;
    const goalKey = JSON.stringify(goals.map(item => [item.id, item.title, item.sourceEvidenceCount || 0, ...(item.sourceEvidenceIds || [])]));
    if (select.dataset.key !== goalKey) {
      select.dataset.key = goalKey;
      select.replaceChildren(...(goals.length
        ? goals.map(item => {
          const option = document.createElement('option');
          option.value = item.id;
          const count = item.sourceEvidenceCount || 0;
          option.textContent = (item.title || '关联探索') + (count ? '（已附 ' + count + '）' : '');
          return option;
        })
        : [Object.assign(document.createElement('option'), { value: '', textContent: '暂无关联探索' })]));
      if (goals.some(item => item.id === previous)) select.value = previous;
    }
    const goalId = select.value;
    const attached = assistEvidenceAttachedIds(goalId);
    const list = byId('assist-evidence-list');
    const key = JSON.stringify([goalId, evidence.map(item => [item.id, item.statement, item.observations?.length || 0, item.attachedGoalIds || []])]);
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...evidence.map(item => {
        const row = document.createElement('label');
        row.className = 'assist-evidence-item';
        row.setAttribute('role', 'listitem');
        const isAttached = attached.has(item.id);
        row.dataset.attached = String(isAttached);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = item.id;
        checkbox.checked = selected.has(item.id) && !isAttached;
        checkbox.disabled = isAttached;
        checkbox.addEventListener('change', updateAssistEvidenceActions);
        const body = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = item.statement;
        if (isAttached) {
          const badge = document.createElement('span');
          badge.className = 'assist-evidence-badge';
          badge.textContent = '已附加';
          title.append(badge);
        }
        const meta = document.createElement('small');
        const observations = Array.isArray(item.observations) ? item.observations.length : 0;
        meta.textContent = observations ? observations + ' 条观察' : '可带到探索的参考';
        body.append(title, meta);
        row.append(checkbox, body);
        return row;
      }));
    }
    updateAssistEvidenceActions();
  }
  function sendPrompt() {
    const field = input;
    const draftKey = 'assist';
    const text = field.value.trim();
    if (configurationMissing() || hostState?.mode === 'goal' || !text || field.value.length > field.maxLength || navigationPending() || hasPending('rewindInput') || hasPending('cancelRun') || hasPending('prompt') || hasPending('runGoal') || hasPending('resumeRun') || composingPrompt || contextPending()) return;
    const sessionId = currentSessionId;
    const submitted = field.value;
    forceScroll = true;
    request('prompt', { text, approvalMode: approvalMode.querySelector('input:checked').value }, () => {
      const draft = draftFor(sessionId);
      if (draft[draftKey] === submitted) draft[draftKey] = '';
      if (currentSessionId === sessionId && field.value === submitted) { field.value = ''; updateInput(); }
      if (currentSessionId === sessionId && document.activeElement === submit) input.focus({ preventScroll: true });
      persistDrafts();
    });
  }
  function cancelRun() {
    if (busy && !hasPending('cancelRun') && !navigationPending()) request('cancelRun');
  }
  function restoreInput(action, payload, text) {
    if (queueControlsBlocked() || (action === 'rewindInput' && rewindControlsBlocked())) return;
    const sessionId = currentSessionId;
    request(action, payload, () => {
      const draft = draftFor(sessionId);
      // Preserve text typed while the host was stopping the agent.
      draft.assist = draft.assist ? text + '\n\n' + draft.assist : text;
      if (currentSessionId === sessionId) { input.value = draft.assist; updateInput(); input.focus(); }
      persistDrafts();
    });
  }
  let inputQueueKey = '';
  let inputQueueSession = '';
  function queueControlsBlocked() {
    // Brief probe resync / soft stalls must not freeze queue/input controls.
    return !currentSessionId || hostState?.recovering || ['disconnected', 'backend-disconnected'].includes(connectionStatus)
      || navigationPending() || ['cancelRun', 'rewindInput', 'removeInput', 'steerInput', 'resumeInputs'].some(action => hasPending(action));
  }
  function rewindControlsBlocked() {
    return queueControlsBlocked() || ['prompt', 'runGoal', 'resumeRun'].some(action => hasPending(action));
  }
  function queueActionAllowed(button, sessionId) {
    return button.isConnected && !button.disabled && sessionId === currentSessionId && !queueControlsBlocked();
  }
  let queuePreview;
  function openQueuePreview(item, index, trigger) {
    if (!queuePreview) {
      const dialog = document.createElement('dialog'); dialog.id = 'queue-preview'; dialog.setAttribute('aria-labelledby', 'queue-preview-title');
      const header = document.createElement('div'); header.className = 'queue-preview-heading';
      const title = document.createElement('h2'); title.id = 'queue-preview-title'; title.textContent = '待发送输入';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'queue-preview-close'; close.textContent = '关闭'; close.setAttribute('aria-label', '关闭输入预览');
      const meta = document.createElement('p'); meta.className = 'queue-preview-meta';
      const body = document.createElement('div'); body.className = 'queue-preview-content'; body.tabIndex = 0; body.setAttribute('role', 'region'); body.setAttribute('aria-label', '完整输入内容');
      header.append(title, close); dialog.append(header, meta, body); document.body.appendChild(dialog);
      queuePreview = { dialog, meta, body };
      close.onclick = () => dialog.close();
      dialog.addEventListener('close', () => {
        // A queued close event may arrive after another preview was opened.
        if (dialog.open) return;
        body.textContent = ''; meta.textContent = '';
        if (queuePreview.sessionId !== currentSessionId) return;
        const target = queuePreview.trigger?.isConnected ? queuePreview.trigger : input;
        target.focus({ preventScroll: true });
      });
      window.addEventListener('pagehide', () => { if (dialog.open) dialog.close(); });
    }
    Object.assign(queuePreview, { sessionId: currentSessionId, inputId: item.id, trigger });
    setText(queuePreview.meta, `第 ${index + 1} 条 · ${Array.from(item.text).length} 字符`);
    setText(queuePreview.body, item.text);
    queuePreview.body.scrollTop = 0;
    if (!queuePreview.dialog.open) queuePreview.dialog.showModal();
    queuePreview.body.focus({ preventScroll: true });
  }
  function renderInputQueue() {
    const container = byId('input-queue');
    if (!container) return;
    const items = hostState?.inputQueue ?? [];
    const paused = hostState?.queuePaused || ['interrupted', 'failed'].includes(executionState().status);
    const execution = executionState();
    const canSteer = busy && execution.canSteer === true;
    const unresolved = items.some(item => item.delivery);
    const controlsBlocked = queueControlsBlocked();
    const stopping = hasPending('cancelRun') || hasPending('rewindInput');
    const key = JSON.stringify([currentSessionId, items, paused, busy, canSteer, execution.runId, controlsBlocked, stopping, hasPending('removeInput'), hasPending('resumeInputs'), hasPending('steerInput')]);
    if (key === inputQueueKey) return;
    if (queuePreview?.dialog.open) {
      const index = items.findIndex(item => item.id === queuePreview.inputId);
      if (queuePreview.sessionId !== currentSessionId || index < 0) queuePreview.dialog.close();
      else {
        setText(queuePreview.body, items[index].text);
        setText(queuePreview.meta, `第 ${index + 1} 条 · ${Array.from(items[index].text).length} 字符`);
      }
    }
    const sameSession = inputQueueSession === currentSessionId;
    const previousScroll = sameSession ? container.querySelector('.input-queue-list')?.scrollTop ?? 0 : 0;
    const focused = sameSession && container.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('.input-queue-row')?.dataset.inputId;
    const focusedAction = focused?.dataset.queueAction ?? focused?.closest('.input-queue-row')?.dataset.focusAction;
    const focusedIndex = focusedId ? [...container.querySelectorAll('.input-queue-row')].findIndex(row => row.dataset.inputId === focusedId) : -1;
    inputQueueKey = key; inputQueueSession = currentSessionId;
    if (!sameSession || !items.length) container.replaceChildren();
    container.hidden = !items.length;
    if (!items.length) { if (focused) input.focus({ preventScroll: true }); return; }
    const heading = document.createElement('div'); heading.className = 'input-queue-heading';
    const label = document.createElement('strong'); label.textContent = '待发送';
    const count = document.createElement('span'); count.className = 'input-queue-count'; count.textContent = String(items.length); count.setAttribute('aria-label', `${items.length} 条待发送输入`); label.appendChild(count);
    const status = document.createElement('span'); status.className = 'input-queue-status'; status.textContent = stopping ? '正在停止，请稍候' : unresolved ? '请核实引导送达状态' : paused ? '已暂停' : canSteer ? '可立刻调整当前任务' : busy ? '当前结束后按顺序执行' : '等待继续';
    heading.append(label, status);
    container.dataset.paused = String(Boolean(paused));
    container.dataset.unresolved = String(Boolean(unresolved));
    const oldHeading = container.querySelector('.input-queue-heading');
    if (oldHeading) oldHeading.replaceWith(heading); else container.appendChild(heading);
    let list = container.querySelector('.input-queue-list');
    if (!list) { list = document.createElement('div'); list.className = 'input-queue-list'; list.setAttribute('role', 'list'); container.appendChild(list); }
    const retainedRows = new Map([...list.children].map(row => [row.dataset.inputId, row]));
    const rows = [];
    for (const [index, item] of items.entries()) {
      const actionSession = currentSessionId;
      const existing = retainedRows.get(item.id);
      const row = existing ?? document.createElement('div'); row.className = 'input-queue-row';
      row.setAttribute('role', 'listitem');
      row.dataset.inputId = item.id; row.tabIndex = -1;
      row.dataset.delivery = item.delivery || 'queued';
      const order = document.createElement('span'); order.className = 'input-queue-order'; order.textContent = String(index + 1); order.setAttribute('aria-hidden', 'true');
      const text = document.createElement('button'); text.type = 'button'; text.className = 'input-queue-text'; text.textContent = item.text;
      text.dataset.queueAction = 'preview';
      const edit = document.createElement('button'); edit.type = 'button'; edit.title = '取回编辑'; edit.setAttribute('aria-label', '取回编辑');
      edit.dataset.queueAction = 'edit';
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z"/></svg>';
      edit.disabled = controlsBlocked; edit.onclick = () => { if (queueActionAllowed(edit, actionSession)) restoreInput('removeInput', { inputId: item.id }, item.text); };
      const remove = document.createElement('button'); remove.className = 'input-queue-remove'; remove.type = 'button'; remove.title = '删除待发送输入'; remove.setAttribute('aria-label', '删除');
      remove.dataset.queueAction = 'remove';
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.disabled = controlsBlocked; remove.onclick = () => { if (queueActionAllowed(remove, actionSession)) request('removeInput', { inputId: item.id }); };
      const steer = document.createElement('button'); steer.type = 'button'; steer.className = 'input-queue-steer'; steer.textContent = item.delivery ? hasPending('steerInput') && item.delivery === 'sending' ? '发送中…' : '送达待确认' : '引导';
      steer.dataset.queueAction = 'steer';
      steer.title = item.delivery ? '输入及附件已保留，请核实执行结果；取回编辑或删除后可继续队列' : canSteer ? '立刻调整当前任务；当前模型回复和工具批次结束后生效，沿用当前审批设置' : '等待当前任务就绪后可立刻调整'; steer.setAttribute('aria-label', '引导当前任务');
      steer.disabled = !canSteer || Boolean(item.delivery) || controlsBlocked;
      const runId = execution.runId;
      steer.onclick = () => { if (queueActionAllowed(steer, actionSession) && executionState().runId === runId && executionState().canSteer) request('steerInput', { inputId: item.id, runId }); };
      const actions = document.createElement('div'); actions.className = 'input-queue-actions';
      actions.append(steer, edit, remove);
      if (existing) {
        setText(row.querySelector('.input-queue-order'), String(index + 1));
        const previousText = row.querySelector('.input-queue-text');
        setText(previousText, item.text);
        row.querySelector('.input-queue-actions').replaceWith(actions);
      } else row.append(order, text, actions);
      const preview = row.querySelector('.input-queue-text');
      preview.title = '查看完整输入'; preview.setAttribute('aria-label', `查看第 ${index + 1} 条完整输入`);
      preview.setAttribute('aria-haspopup', 'dialog');
      const previewSession = currentSessionId;
      preview.onclick = () => { if (previewSession === currentSessionId && row.isConnected) openQueuePreview(item, index, preview); };
      rows.push(row);
    }
    const keep = new Set(rows);
    for (const row of [...list.children]) if (!keep.has(row)) row.remove();
    let previousRow;
    for (const row of rows) {
      const next = previousRow ? previousRow.nextSibling : list.firstChild;
      if (row !== next) list.insertBefore(row, next);
      previousRow = row;
    }
    if (paused || !busy) {
      const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = '继续发送队列';
      resume.className = 'input-queue-resume';
      const actionSession = currentSessionId;
      resume.disabled = busy || unresolved || controlsBlocked; resume.onclick = () => { if (queueActionAllowed(resume, actionSession)) request('resumeInputs'); }; heading.appendChild(resume);
    }
    list.scrollTop = previousScroll;
    if (focusedId) {
      const row = [...list.children].find(row => row.dataset.inputId === focusedId) ?? list.children[Math.min(focusedIndex, list.children.length - 1)];
      if (row && focusedAction) row.dataset.focusAction = focusedAction;
      const button = row && [...row.querySelectorAll('button')].find(button => button.dataset.queueAction === focusedAction && !button.disabled);
      (button ?? row)?.focus({ preventScroll: true });
    } else if (focused?.classList.contains('input-queue-resume')) heading.querySelector('.input-queue-resume')?.focus({ preventScroll: true });
  }
  function resumeRun() {
    if (!configurationMissing() && !busy && executionState().canResume === true && !hasPending('resumeRun') && !navigationPending()) request('resumeRun');
  }
  approvalMode.addEventListener('change', event => {
    const value = event.target.value;
    if (approvalMode.disabled || !['auto', 'manual'].includes(value)) return;
    draftFor().approvalMode = value;
    persistDrafts();
  });
  form.addEventListener('submit', event => { event.preventDefault(); if (busy && !input.value.trim()) cancelRun(); else sendPrompt(); });
  input.addEventListener('compositionstart', () => { composingPrompt = true; });
  input.addEventListener('compositionend', () => { composingPrompt = false; });
  input.addEventListener('blur', () => { composingPrompt = false; });
  input.addEventListener('input', () => { draftFor().assist = input.value; scheduleDraftPersistence(); scheduleInput(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !composingPrompt && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendPrompt(); }
  });
  const newCreate = byId('new-create');
  const goalHeaderMore = byId('goal-header-more');
  const closeNewCreate = () => { newCreate.open = false; };
  const closeGoalHeaderMore = () => { goalHeaderMore.open = false; };
  newCreate.addEventListener('toggle', () => {
    if (newCreate.open && (hasPending() || navigationPending())) closeNewCreate();
    if (newCreate.open) closeGoalHeaderMore();
  });
  newCreate.querySelector('summary').addEventListener('click', event => {
    if (hasPending() || navigationPending()) { event.preventDefault(); closeNewCreate(); }
  });
  goalHeaderMore.addEventListener('toggle', () => {
    if (goalHeaderMore.open) closeNewCreate();
  });
  document.addEventListener('pointerdown', event => {
    if (!newCreate.contains(event.target)) closeNewCreate();
    if (!goalHeaderMore.contains(event.target)) closeGoalHeaderMore();
  });
  newCreate.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNewCreate();
      newCreate.querySelector('summary').focus();
    }
  });
  goalHeaderMore.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGoalHeaderMore();
      goalHeaderMore.querySelector('summary').focus();
    }
  });
  byId('new-create-chat').addEventListener('click', () => {
    closeNewCreate();
    if (!hasPending()) request('newChat');
  });
  goalHeaderMore.querySelector('.goal-header-more-menu').addEventListener('click', event => {
    if (event.target.closest('button')) closeGoalHeaderMore();
  });
  byId('goal-run').addEventListener('click', () => {
    if (hostState?.goal && !busy && !hasPending('runGoal') && !navigationPending()) request('runGoal');
  });
  byId('goal-stop').addEventListener('click', cancelRun);
  byId('goal-resume').addEventListener('click', resumeRun);
  byId('assist-resume').addEventListener('click', resumeRun);
  byId('assist-evidence-goal').addEventListener('change', () => {
    byId('assist-evidence-list').dataset.key = '';
    renderAssistEvidence();
  });
  byId('assist-evidence-select-pending').addEventListener('click', () => {
    const goalId = byId('assist-evidence-goal').value;
    const attached = assistEvidenceAttachedIds(goalId);
    byId('assist-evidence-list').querySelectorAll('input[type="checkbox"]').forEach(item => {
      item.checked = !item.disabled && !attached.has(item.value);
    });
    updateAssistEvidenceActions();
  });
  byId('assist-evidence-clear').addEventListener('click', () => {
    byId('assist-evidence-list').querySelectorAll('input[type="checkbox"]').forEach(item => { item.checked = false; });
    updateAssistEvidenceActions();
  });
  byId('assist-evidence-attach').addEventListener('click', () => {
    if (hostState?.mode !== 'assist' || hasPending('attachAssistEvidence') || navigationPending()) return;
    const goalId = byId('assist-evidence-goal').value;
    const attached = assistEvidenceAttachedIds(goalId);
    const evidenceIds = selectedAssistEvidenceIds().filter(id => !attached.has(id));
    if (!evidenceIds.length || !goalId) return;
    request('attachAssistEvidence', { goalId, evidenceIds }, () => {
      byId('assist-evidence-list').dataset.key = '';
      renderAssistEvidence();
    });
  });
  byId('assist-notes-toggle').addEventListener('click', () => {
    setGoalView(draftFor().view === 'notes' ? 'overview' : 'notes');
  });
  document.addEventListener('click', event => {
    if (!byId('exploration-runs').contains(event.target)) byId('exploration-runs').open = false;
  });
  byId('exploration-runs').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      byId('exploration-runs').open = false;
      byId('exploration-runs').querySelector('summary').focus();
    }
  });

  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.prompt; draftFor().assist = input.value; persistDrafts(); updateInput(); input.focus();
  }));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.action === 'selectWorkspace') {
      if (!busy && !hasPending()) request('selectWorkspace');
    } else if (button.dataset.action === 'attachFile') {
      if (busy || contextPending() || !currentSessionId) return;
      const sessionId = currentSessionId;
      request('attachFile', {}, () => { if (sessionId === currentSessionId) input.focus({ preventScroll: true }); });
    } else vscode.postMessage({ action: button.dataset.action, sessionId: currentSessionId });
  }));
  byId('remove-context')?.addEventListener('click', () => {
    if (busy || contextPending() || !currentSessionId) return;
    const sessionId = currentSessionId;
    request('clearFileContext', {}, () => { if (sessionId === currentSessionId) input.focus({ preventScroll: true }); });
  });
  document.querySelectorAll('[data-goal-view]').forEach(button => button.addEventListener('click', () => {
    setGoalView(button.dataset.goalView);
    byId('goal-view-switcher').open = false;
    byId('goal-view-switcher').querySelector('summary').focus({ preventScroll: true });
  }));
  byId('goal-view-switcher').addEventListener('toggle', () => {
    // Expanded worker detail covers the page menu; close it when the user opens navigation.
    if (byId('goal-view-switcher').open) try { workerPanel.dismiss(false); } catch { /* ignore */ }
  });
  document.addEventListener('pointerdown', event => {
    if (!byId('goal-view-switcher').contains(event.target)) byId('goal-view-switcher').open = false;
  });
  byId('goal-view-switcher').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); byId('goal-view-switcher').open = false;
      byId('goal-view-switcher').querySelector('summary').focus();
    } else if (event.target.tagName === 'SUMMARY' && event.key === 'ArrowDown') {
      event.preventDefault(); byId('goal-view-switcher').open = true;
      byId('goal-tab-' + draftFor().view).focus();
    }
  });
  byId('goal-view-switcher').addEventListener('focusout', event => {
    if (!byId('goal-view-switcher').contains(event.relatedTarget)) byId('goal-view-switcher').open = false;
  });
  byId('goal-tabs').addEventListener('keydown', event => {
    const forward = 'ArrowDown', backward = 'ArrowUp';
    if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = goalViews.indexOf(draftFor().view);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? goalViews.length - 1 : (index + (event.key === forward ? 1 : -1) + goalViews.length) % goalViews.length;
    setGoalView(goalViews[next]);
    byId('goal-tab-' + goalViews[next]).focus();
  });
  function saveGoalDraft() {
    draftFor().goalDraft = { objective: objectiveInput.value, initialFacts: factsInput.value, criteria: criteriaInput.value };
    scheduleDraftPersistence();
    updateControls();
  }
  objectiveInput.addEventListener('input', saveGoalDraft);
  factsInput.addEventListener('input', saveGoalDraft);
  criteriaInput.addEventListener('input', saveGoalDraft);
  byId('goal-edit').addEventListener('click', () => {
    if (busy) return;
    closeGoalHeaderMore();
    draftFor().goalEditing = true;
    restoreFields();
    persistDrafts();
    renderGoal();
    objectiveInput.focus();
  });
  byId('goal-cancel').addEventListener('click', () => {
    if (workspaceMissing()) return;
    draftFor().goalEditing = false;
    persistDrafts();
    renderGoal();
    goalHeaderMore.querySelector('summary').focus();
  });
  byId('goal-editor').addEventListener('submit', event => {
    event.preventDefault();
    if (workspaceMissing()) { showError('请先在项目行或会话顶部选择目录，再保存目标。'); return; }
    if (busy || hasPending('saveGoal') || hasPending('toggleGoalCriterion')) return;
    const objective = objectiveInput.value.trim();
    const lines = criteriaInput.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!objective) { showError('请先写下希望达成的目标。'); objectiveInput.focus(); return; }
    if (lines.length > 20 || lines.some(line => line.length > 300)) { showError('验收标准最多 20 项，每项不能超过 300 字。'); criteriaInput.focus(); return; }
    // Exact text matches retain IDs and confirmation state, including reordering.
    const available = [...(hostState?.goal?.criteria || [])];
    const criteria = lines.map(text => {
      const index = available.findIndex(item => item.text === text);
      return index < 0 ? { text } : { id: available.splice(index, 1)[0].id, text };
    });
    const sessionId = currentSessionId;
    request('saveGoal', { goal: { objective, initialFacts: factsInput.value.trim(), criteria } }, () => {
      const draft = draftFor(sessionId);
      draft.goalDraft = null;
      draft.goalEditing = false;
      persistDrafts();
      if (sessionId === currentSessionId) renderGoal();
    });
  });
  noteInput.addEventListener('input', () => { draftFor().note = noteInput.value; scheduleDraftPersistence(); updateControls(); });
  byId('note-new').addEventListener('click', () => {
    byId('note-editor-error').hidden = true;
    byId('note-editor').showModal(); noteInput.focus();
  });
  byId('note-close').addEventListener('click', closeNoteEditor);
  byId('note-editor').addEventListener('cancel', event => { event.preventDefault(); closeNoteEditor(); });
  byId('note-back').addEventListener('click', () => {
    byId('goal-notes').dataset.reading = 'false';
    document.querySelector('.note-select[aria-pressed="true"]')?.focus({ preventScroll: true });
  });
  byId('note-copy').addEventListener('click', () => {
    const selected = [...byId('goal-notes-list').children, ...byId('agent-notes-list').children].find(row => noteEntries.get(row)?.key === selectedNoteKey);
    if (selected) messageActions.onCopy(noteEntries.get(selected).text).catch(error => showError(error.message));
  });
  byId('notes-search').addEventListener('input', filterNotes);
  byId('notes-search').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || !event.target.value) return;
    event.preventDefault(); event.stopPropagation(); event.target.value = ''; filterNotes();
  });
  for (const button of document.querySelectorAll('[data-note-source]')) button.addEventListener('click', () => { noteSource = button.dataset.noteSource; filterNotes(); });
  let composingNote = false;
  noteInput.addEventListener('compositionstart', () => { composingNote = true; });
  noteInput.addEventListener('compositionend', () => { composingNote = false; });
  noteInput.addEventListener('blur', () => { composingNote = false; });
  noteInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composingNote && !event.isComposing && event.keyCode !== 229 && !byId('goal-add-note').disabled) {
      event.preventDefault(); byId('goal-note-form').requestSubmit();
    }
  });
  byId('goal-note-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = noteInput.value.trim();
    if (!text || noteInput.value.length > noteInput.maxLength || navigationPending() || !hostState?.goal || hasPending('addGoalNote')) return;
    const submitted = noteInput.value;
    const sessionId = currentSessionId;
    byId('note-editor-error').hidden = true;
    request('addGoalNote', { text }, () => {
      const draft = draftFor(sessionId);
      if (draft.note === submitted) draft.note = '';
      if (sessionId === currentSessionId && noteInput.value === submitted) noteInput.value = '';
      persistDrafts();
      if (sessionId === currentSessionId) {
        savedNoteToReveal = { sessionId, text };
        noteSource = 'user'; byId('notes-search').value = '';
        closeNoteEditor(); filterNotes();
      }
    }, error => {
      if (sessionId !== currentSessionId) return;
      setText(byId('note-editor-error'), error.message); byId('note-editor-error').hidden = false;
    });
  });
  // One render per animation frame; background tabs retain only the latest state.
  // Acknowledgements still run immediately so request and draft ownership is exact.
  let fullRenderPending = false, committedRender, paintAcknowledgement;
  let contentReadyRetryTimer = 0, contentReadyRetried = false;
  const isCurrentPaint = commit => commit && commit === committedRender &&
    commit.state === hostState && commit.epoch === viewEpoch && commit.generation === renderGeneration;
  function cancelContentReadyRetry() {
    clearTimeout(contentReadyRetryTimer);
    contentReadyRetryTimer = 0;
  }
  function cancelPaintAcknowledgement() {
    const acknowledgement = paintAcknowledgement;
    paintAcknowledgement = undefined;
    if (acknowledgement) {
      acknowledgement.cancelled = true;
      acknowledgement.cancel?.();
    }
  }
  function deliverPaintSignal(message, acknowledgement) {
    if (acknowledgement.cancelled) throw new Error('Paint delivery cancelled');
    const result = vscode.postMessage(message);
    // The native bridge returns void; only asynchronous bridges need a clock.
    if (!result || typeof result.then !== 'function') return result;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (failed, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        acknowledgement.cancel = undefined;
        if (failed) reject(value); else resolve(value);
      };
      const timer = setTimeout(() => finish(true, Object.assign(new Error('Paint delivery timed out'), { code: 'PAINT_DELIVERY_TIMEOUT' })), 5000);
      acknowledgement.cancel = () => finish(true, new Error('Paint delivery cancelled'));
      // Attach both callbacks even if lifecycle cancellation already happened,
      // so a late rejection is consumed without retaining the render lock.
      Promise.resolve(result).then(value => finish(false, value), error => finish(true, error));
      if (acknowledgement.cancelled) acknowledgement.cancel();
    });
  }
  function renderLiveComponents(executionOnly = false) {
    const failures = [];
    const tasks = [
      () => { if (hostState.mode !== 'goal') renderMessages(Array.isArray(hostState.messages) ? hostState.messages : []); },
      () => deliveryView.update(hostState.execution?.memory?.delivery, currentSessionId, hostState.execution?.memory?.domainInventory),
      ...(executionOnly ? [] : [renderConversationOutline, renderAssistEvidence]),
      ...(executionOnly && hostState.mode !== 'goal' ? [] : [renderGoal]),
      renderExecution,
      updateControls
    ];
    for (const render of tasks) {
      try { render(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }
  function finishInitialPaint() {
    if (!hostState) return;
    if (firstContentPaint) { queueContentReady(); return; }
    byId('page-loading').hidden = true;
    document.body.dataset.loading = 'false';
    clearTimeout(initialLoadTimer);
    firstContentPaint = true;
    contentReadyPending = true;
  }
  function queueContentReady() {
    const commit = committedRender;
    if (!contentReadyPending || contentReadyFrame || paintAcknowledgement || pageHidden() || !isCurrentPaint(commit)) return;
    cancelContentReadyRetry();
    contentReadyFrame = requestAnimationFrame(() => {
      contentReadyFrame = 0;
      if (pageHidden()) return;
      if (!isCurrentPaint(commit)) { queueContentReady(); return; }
      contentReadyFrame = requestAnimationFrame(async () => {
        contentReadyFrame = 0;
        if (pageHidden() || !contentReadyPending) return;
        if (!isCurrentPaint(commit)) { queueContentReady(); return; }
        const acknowledgement = {};
        paintAcknowledgement = acknowledgement;
        let paintError;
        try {
          if (!firstPaintAcknowledged) {
            if (await deliverPaintSignal({ action: 'firstPaint' }, acknowledgement) === false) throw new Error('First paint acknowledgement failed');
            if (paintAcknowledgement !== acknowledgement) return;
            firstPaintAcknowledged = true;
          }
          if (pageHidden() || !isCurrentPaint(commit)) return;
          // The sidebar needs the committed conversation, not execution history
          // or skill provisioning. Those can be slow while the chat is usable.
          if (await deliverPaintSignal({ action: 'contentReady', sessionId: currentSessionId }, acknowledgement) === false) throw new Error('Content acknowledgement failed');
          if (paintAcknowledgement === acknowledgement && isCurrentPaint(commit)) {
            contentReadyPending = false;
            contentReadyRetried = false;
          }
        }
        catch (error) { paintError = error; }
        finally {
          // A render that arrived while the bridge was pending still needs its
          // own two-frame acknowledgement. One delayed retry covers stable-commit
          // bridge timeouts without spinning an animation-frame loop.
          if (paintAcknowledgement === acknowledgement) {
            paintAcknowledgement = undefined;
            if (commit !== committedRender) queueContentReady();
            else if (contentReadyPending && !acknowledgement.cancelled && !pageHidden() && isCurrentPaint(commit) && !contentReadyRetried) {
              contentReadyRetried = true;
              contentReadyRetryTimer = setTimeout(() => {
                contentReadyRetryTimer = 0;
                if (contentReadyPending && isCurrentPaint(commit)) queueContentReady();
              }, 400);
            } else if (contentReadyPending && !acknowledgement.cancelled && !pageHidden() && paintError?.code === 'PAINT_DELIVERY_TIMEOUT') {
              window.UBOVMRuntime?.fail('页面加载状态同步超时。请同步最新状态或重新加载页面。');
            }
          }
        }
      });
    });
  }
  function cancelVisualFrames() {
    committedRender = undefined;
    cancelPaintAcknowledgement();
    cancelContentReadyRetry();
    contentReadyRetried = false;
    cancelHistoryFill();
    flushThreadTeardown();
    // Hidden/idle suspension must force a full paint after restore even when
    // contentReady already completed, otherwise a discarded compositor stays blank.
    if (hostState) { renderPending = true; fullRenderPending = true; contentReadyPending = true; }
    renderGeneration++;
    window.UBOVMRuntime?.cancel();
    cancelRenderTimer(); cancelPageAnimation(); cancelScroll();
    try { finishPageTransition(); } catch { /* Independent recovery controls remain usable. */ }
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; renderPending = true; }
    for (const frame of [inputFrame, latestFrame, focusFrame, contentReadyFrame]) if (frame) cancelAnimationFrame(frame);
    inputFrame = latestFrame = focusFrame = contentReadyFrame = 0;
  }
  function resumeVisuals() {
    if (visualSuspended()) return;
    scheduleRender(true);
    scheduleInput(); refreshLatest(); queueContentReady();
  }
  byId('ui-render-retry').addEventListener('click', () => {
    cancelVisualFrames();
    scheduleRender();
    try { vscode.postMessage({ action: 'ready' }); } catch { window.UBOVMRuntime?.fail(); }
  });
  if (window.UBOVMRuntime) window.UBOVMRuntime.saveDrafts = persistDrafts;
  window.addEventListener('ubovm-runtime-retry', () => { cancelVisualFrames(); scheduleRender(); });
  let renderTimer = 0, renderRestUntil = 0;
  function cancelRenderTimer() { clearTimeout(renderTimer); renderTimer = 0; }
  function scheduleRender(executionOnly = false) {
    // Execution-only ticks keep the last committed paint identity so an in-flight
    // contentReady handshake is not invalidated by every stream token. Route
    // changes call scheduleRender() without executionOnly and arm a full paint.
    if (executionOnly !== true) {
      committedRender = undefined;
      fullRenderPending = true;
    }
    renderPending = true;
    // Expensive streaming paints need an idle interval for input and scrolling.
    // Keep only hostState (the newest snapshot), never queue individual tokens.
    // Navigation, explicit refresh and terminal states bypass the interval.
    const streaming = executionOnly === true && !fullRenderPending && busy &&
      !['completed', 'failed', 'interrupted'].includes(hostState.execution?.status);
    if (!streaming) cancelRenderTimer();
    if (renderFrame || pageHidden()) return;
    window.UBOVMRuntime?.pending();
    const delay = streaming ? renderRestUntil - performance.now() : 0;
    if (delay > 0) {
      if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; scheduleRender(true); }, delay);
      return;
    }
    cancelRenderTimer();
    const generation = renderGeneration;
    renderFrame = requestAnimationFrame(() => {
      if (generation !== renderGeneration) return;
      renderFrame = 0;
      if (pageHidden()) {
        // Suspended paint must not leave the runtime pending clock armed.
        window.UBOVMRuntime?.cancel();
        return;
      }
      // Commit the lightweight loader for one frame before building heavy DOM.
      // Release the previous thread only after that mask is on screen.
      if (routePending && !routePaintReady) {
        routePaintReady = true;
        flushThreadTeardown();
        scheduleRender(executionOnly === true);
        return;
      }
      renderPending = false;
      const full = fullRenderPending; fullRenderPending = false;
      const started = performance.now();
      renderSafely(full);
      const elapsed = performance.now() - started;
      renderRestUntil = performance.now() + (elapsed > 8 ? Math.min(250, elapsed * 3) : 0);
    });
  }
  function renderSafely(full) {
    const state = hostState, epoch = viewEpoch, generation = renderGeneration;
    let succeeded = false;
    try {
      if (full) renderState();
      else {
        setAttribute(messages, 'aria-busy', String(busy));
        renderLiveComponents(true);
      }
      if (pendingViewRestore) {
        const target = pendingViewRestore; pendingViewRestore = undefined;
        if (target.sessionId === currentSessionId && target.view === draftFor().view) {
          cancelScroll();
          const scroller = byId('goal-panels');
          const saved = goalViewScroll.get(currentSessionId + ':' + target.view);
          scroller.scrollTop = saved?.top ?? 0;
          scrollPositions.set(scroller, { top: scroller.scrollTop, following: saved?.following ?? true });
        }
      }
      if (errors.get(currentSessionId)?.action === 'render') showError('');
      byId('ui-render-retry').hidden = true;
      succeeded = true;
    } catch (error) {
      // Route changes and streamed updates share the same recovery boundary.
      // Retry on user action or later data, never in an animation-frame loop.
      renderPending = true; fullRenderPending = true;
      const renderFailure = { ...window.UBOVMErrors.normalize(error, 'render'), message: '页面部分内容显示失败，输入已保留。请重试。' };
      showError(renderFailure);
      byId('ui-render-retry').hidden = false;
      window.UBOVMRuntime?.cancel();
    } finally {
      // An error surface is usable content too; never trap it behind startup.
      let housekeepingFailed = false;
      for (const finish of [finishInitialPaint,
        // Only a full paint (or a failed paint that must not trap the loader)
        // may clear the route transition; execution-only ticks keep it armed.
        () => { if (full || !succeeded) finishPageTransition(); },
        () => { if (succeeded && full) animateCurrentPage(); }, renderConnectionStatus]) {
        try { finish(); }
        catch { housekeepingFailed = true; }
      }
      if (housekeepingFailed) {
        renderPending = true; fullRenderPending = true;
        window.UBOVMRuntime?.cancel();
        window.UBOVMRuntime?.fail('页面更新未能完整结束。草稿已保留，请同步状态或重新加载页面。');
      } else {
        // The commit includes a usable error surface so failures never trap
        // recovery controls, but a newer snapshot cannot inherit an old paint.
        if (state === hostState && epoch === viewEpoch && generation === renderGeneration) {
          committedRender = { state, epoch, generation };
          contentReadyRetried = false;
          queueContentReady();
        }
        if (succeeded) {
          window.UBOVMRuntime?.painted();
          if (window.UBOVMi18n?.locale === 'en') window.UBOVMi18n.apply(document.body);
        }
      }
    }
  }
  function renderState() {
    const failures = [];
    for (const render of [renderChrome, renderLiveComponents]) {
      try { render(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }
  function renderChrome() {
    const state = hostState;
    if (!state) return;
    renderNavigationFeedback();
    renderMode();
    byId('busy-status').hidden = !busy;
    setAttribute(messages, 'aria-busy', String(busy));
    setText(byId('conversation-title'), state.conversation.title || '新对话');
    setProperty(byId('conversation-title'), 'title', state.conversation.title || '新对话');
    let related = byId('related-conversations');
    if (!related) {
      related = document.createElement('div'); related.id = 'related-conversations';
      related.setAttribute('aria-label', '关联会话');
      byId('main-content').prepend(related);
    }
    const relatedItems = state.relatedConversations || [];
    const relatedKey = JSON.stringify([state.conversation.id, relatedItems]);
    if (related.dataset.key !== relatedKey) {
      related.dataset.key = relatedKey;
      related.replaceChildren(...relatedItems.map(item => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = (item.mode === 'goal' ? '目标：' : '来源聊天：') + item.title;
        button.title = button.textContent;
        button.addEventListener('click', () => vscode.postMessage({ action: 'openRelatedConversation', sessionId: state.conversation.id, targetId: item.id }));
        return button;
      }));
    }
    related.hidden = relatedItems.length === 0;
    if (state.context) {
      if (typeof state.context.workspace === 'string') {
        const workspacePath = state.context.workspace;
        const configured = state.context.workspaceConfigured === true;
        const inProject = Boolean(state.context.projectId);
        const workspaceLabel = configured ? workspacePath : (inProject ? '选择项目目录' : '选择工作空间');
        const workspaceButton = byId('workspace-name').closest('button');
        setText(byId('workspace-name'), workspaceLabel);
        workspaceButton.title = configured
          ? workspacePath + (inProject ? '\n点击切换当前项目的目录' : '\n点击切换当前会话的工作空间')
          : (inProject ? '为当前项目选择工作文件夹' : '为当前会话选择工作文件夹');
        workspaceButton.setAttribute('aria-label', configured
          ? (inProject ? '切换项目目录：' : '切换工作空间：') + workspacePath
          : (inProject ? '选择当前项目的目录' : '选择当前会话的工作空间'));
        workspaceButton.dataset.configured = String(configured);
        setText(byId('goal-workspace-name'), configured ? workspaceLabel : (inProject ? '尚未选择项目目录' : '尚未选择工作空间'));
        byId('goal-workspace-name').title = configured ? workspacePath : '';
      }
    }
    const file = typeof state.context?.file === 'string' ? state.context.file : '';
    const selection = state.context?.fileSource === 'selection' ? state.context.selectionLabel || '' : '';
    const source = selection ? '已添加选中代码' : state.context?.fileSource === 'active' ? '当前文件' : '已添加文件';
    const contextLabel = file ? file.split(/[\\/]/).pop() + (selection ? ' · ' + selection : '') : '';
    setText(byId('context-label'), contextLabel);
    const workspaceCaption = state.context?.workspaceConfigured === true
      ? (String(state.context.workspace || '').split(/[\\/]/).filter(Boolean).pop() || '当前工作区')
      : (state.context?.projectId ? '选择项目目录' : '选择工作空间');
    setText(byId('context-caption'), workspaceCaption);
    byId('context-caption').title = state.context?.workspaceConfigured === true && state.context.workspace ? state.context.workspace : workspaceCaption;
    if (byId('composer-file')) {
      byId('composer-file').hidden = !file;
      byId('composer-file').title = file ? source + '：' + file + (selection ? ' · ' + selection + '（添加时的快照）' : '') : '';
      byId('composer-file').dataset.source = file ? selection ? 'selection' : state.context?.fileSource === 'active' ? 'active' : 'attached' : '';
    }
    byId('attach-file').title = file ? '更换文件上下文' : '添加文件上下文';
    const goalSelection = byId('goal-selection-context');
    goalSelection.hidden = state.mode !== 'goal' || !selection;
    setText(byId('goal-selection-label'), contextLabel);
    goalSelection.title = '已添加选中代码：' + file + ' · ' + selection + '（添加时的快照）';
    if (state.provider) {
      setText(byId('provider-label'), state.provider.configured && state.ssh?.configured === false ? '配置 SSH（必需）' : state.provider.label || '未连接模型');
      byId('provider-label').title = state.provider.error || state.ssh?.error || '配置模型与工具';
      setText(byId('connection-note'), configurationMissing() ? '先完成模型和远程连接配置，就可以开始' : '模型已就绪，直接输入即可');
    }
  }
  function animateCurrentPage() {
    const state = hostState;
    if (!state) return;
    // Animate only after the target is committed and all loading masks are gone.
    const pageKey = `${currentSessionId}:${state.mode}:${draftFor().view}:${byId('goal-setup').hidden}`;
    if (renderedPageKey !== pageKey) {
      renderedPageKey = pageKey;
      cancelPageAnimation();
      const panel = byId('goal-' + draftFor().view);
      const panelVisible = state.mode === 'goal' ? byId('goal-setup').hidden : draftFor().view === 'notes';
      const surface = panelVisible && panel && !panel.hidden ? panel : byId(state.mode === 'goal' ? 'goal-mode' : 'assist-mode');
      if (!document.hidden && !reducedMotion.matches && !surface.hidden) {
        const animation = pageAnimation = surface.animate([{ transform: 'translateY(8px)' }, { transform: 'translateY(0)' }],
          { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
        animation.id = 'page-enter';
        animation.finished.then(() => { if (pageAnimation === animation) pageAnimation = undefined; }, () => {});
      }
    }
  }
  window.addEventListener('resize', scheduleInput);
  if (typeof ResizeObserver === 'function') {
    let composerWidth = 0;
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      if (width && width !== composerWidth) { composerWidth = width; scheduleInput(); }
    }).observe(form);
  }
  window.addEventListener('pagehide', () => {
    suspended = true; viewEpoch++; invalidateDropRead();
    const interrupted = [...pending.values()];
    pending.clear(); renderRequests.clear();
    const failure = new Error('页面已暂停，已发送操作的结果尚未确认。请恢复后检查状态，勿重复提交。');
    for (const item of interrupted) {
      clearTimeout(item.timer); completeCallback(item.onError, failure, item.sessionId);
    }
    if (draftTimer) persistDrafts();
    cancelVisualFrames();
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    resumeVisuals();
    requestReadyResync();
  });
  window.addEventListener('blur', () => { if (draftTimer) persistDrafts(); });
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-background', document.hidden);
    if (document.hidden) {
      if (draftTimer) persistDrafts();
      cancelVisualFrames();
    } else {
      resumeVisuals();
      requestReadyResync();
    }
  });
  window.addEventListener('ubovm-locale', () => { if (hostState) scheduleRender(); });
  window.addEventListener('ubovm-settings-visibility', event => {
    if (event.detail?.open) cancelVisualFrames();
    document.body.classList.toggle('settings-visible', event.detail?.open === true);
    if (!event.detail?.open && hostState) scheduleRender();
    if (!event.detail?.open) resumeVisuals();
  });
  window.addEventListener('ubovm-overview-visibility', () => {
    if (!hostState) return;
    scheduleRender(true);
  });
  window.addEventListener('message', event => {
    const checkpoint = stateOrder.checkpoint();
    const previous = { hostState, currentSessionId, busy };
    try { receiveHostMessage(event); }
    catch {
      // An exception before paint must not consume the host revision forever.
      // The next resync may resend exactly the same snapshot.
      stateOrder.restore(checkpoint);
      hostState = previous.hostState; currentSessionId = previous.currentSessionId; busy = previous.busy;
      committedRender = undefined;
      renderPending = true; fullRenderPending = true;
      window.UBOVMRuntime?.fail('页面状态同步遇到问题。草稿已保留，请同步最新状态或重新加载页面。');
      try { finishPageTransition(); } catch { /* Independent recovery controls remain usable. */ }
    }
  });
  async function handleHostDialog(state) {
    if (!state || typeof state.type !== 'string') return false;
    if (modalDialog.handleMessage(state)) return true;
    if (state.type === 'openConversationDelete') {
      const title = typeof state.title === 'string' ? state.title : '会话';
      const label = state.mode === 'goal' ? '探索会话' : '会话';
      const confirmed = await modalDialog.confirm({
        title: `删除${label}`,
        message: `删除${label}“${title}”？`,
        detail: '将删除此会话的消息、草稿和本地执行记录。工作区文件不会被删除。此操作无法撤销。',
        confirmLabel: '删除',
        danger: true
      });
      if (confirmed !== true) return true;
      request('confirmConversationDelete', {
        conversationId: state.conversationId,
        confirmed: true
      }, () => {}, failure => showError(failure?.message || '删除失败，请重试。'));
      return true;
    }
    if (state.type === 'openConversationSearch') {
      const items = Array.isArray(state.items) ? state.items : [];
      const selected = await modalDialog.searchList({
        title: state.mode === 'goal' ? '搜索探索会话' : '搜索协助会话',
        items
      });
      if (selected?.id) {
        request('selectConversationFromSearch', { conversationId: selected.id }, () => {},
          failure => showError(failure?.message || '打开会话失败，请重试。'));
      }
      return true;
    }
    if (state.type === 'showUbomAlert') {
      await modalDialog.confirm({
        title: state.title || '提示',
        message: state.message || '',
        detail: state.detail || '',
        confirmLabel: '知道了',
        hideCancel: true
      });
      return true;
    }
    return false;
  }
  function receiveHostMessage(event) {
    let state = event.data;
    if (projectSwitcher.handleMessage(state)) return;
    if (state?.type?.startsWith?.('openConversation') || state?.type === 'showUbomAlert' || state?.type === 'closeUbomModal') {
      void handleHostDialog(state);
      return;
    }
    if (state?.type === 'locale') { window.UBOVMi18n?.applyHostLocale?.(state.locale); return; }
    if (state?.type === 'windowFocused') {
      if (!document.hidden) resumeVisuals();
      return;
    }
    if (state?.type === 'selectBlackboardNode') {
      if (state.sessionId === currentSessionId) blackboardGraph?.select(state.id);
      return;
    }
    if (state?.type === 'closeBlackboardDetails') { blackboardGraph?.closeDetail(); return; }
    if (state?.type === 'themeState') return;
    if (state?.type === 'focusInput') {
      if (state.sessionId && state.sessionId !== currentSessionId) return;
      const origin = currentSessionId, epoch = viewEpoch;
      if (focusFrame) cancelAnimationFrame(focusFrame);
      if (visualSuspended()) { focusFrame = 0; return; }
      focusFrame = requestAnimationFrame(() => {
        focusFrame = 0;
        if (epoch !== viewEpoch || origin !== currentSessionId || visualSuspended() || window.UBOVMHtmlPreview.isOpen) return;
        (hostState?.mode === 'goal' ? (byId('goal-setup').hidden ? byId('goal-view-switcher').querySelector('summary') : objectiveInput) : input).focus();
      });
      return;
    }
    if (state?.type === 'uiResult') {
      const operation = pending.get(state.requestId);
      if (!operation) return;
      clearTimeout(operation.timer);
      pending.delete(state.requestId);
      if (state.ok) completeCallback(operation.onSuccess, undefined, operation.sessionId);
      else {
        const failure = window.UBOVMErrors.normalize(state.failure || state.error || '操作失败，请重试。你的草稿仍然保留。', operation.action);
        const message = window.UBOVMErrors.text(failure);
        showError(failure, operation.action === 'setMode' ? currentSessionId : operation.sessionId);
        completeCallback(operation.onError, new Error(message), operation.sessionId);
      }
      updateControls();
      return;
    }
    if (state?.type === 'executionState') {
      const updated = stateOrder.execution(state, hostState);
      if (!updated) return;
      hostState = updated;
      busy = Boolean(state.busy || state.execution?.busy || ['starting', 'running'].includes(state.execution?.status));
      scheduleRender(true);
      return;
    }
    if (!state || state.type !== 'state') return;
    state = stateOrder.full(state, hostState);
    if (!state) return;
    const sessionId = typeof state.conversation?.id === 'string' ? state.conversation.id : '';
    if (!sessionId) return;
    const changedSession = sessionId !== currentSessionId;
    if (changedSession && draftTimer) persistDrafts();
    if (changedSession) {
      viewEpoch++; invalidateDropRead();
      // Host locks native chrome on conversation/project switches. Rearm so the
      // next committed paint can unlock it; the first acknowledgement must not
      // be the last one this page ever sends.
      contentReadyPending = true;
      contentReadyRetried = false;
      cancelContentReadyRetry();
      if (firstContentPaint) beginPageTransition('正在加载会话…', 'session');
      const cleanup = operation => { try { operation(); } catch { window.UBOVMRuntime?.fail(); } };
      cleanup(() => window.UBOVMHtmlPreview.close({ restoreFocus: false }));
      cleanup(() => goalExecutionLog?.reset());
      cleanup(() => blackboardGraph?.dispose()); blackboardGraph = undefined;
      // Defer message DOM release until the route loader has painted one frame.
      cancelHistoryFill();
      queueThreadTeardown();
      cleanup(() => conversationOutline?.reset());
      cleanup(closeNoteEditor);
      cleanup(() => projectSwitcher.close());
      cleanup(() => modalDialog.close());
      cleanup(() => { byId('new-create').open = false; byId('goal-header-more').open = false; });
    }
    hostState = state;
    currentSessionId = sessionId;
    projectSwitcher.update(state.projects);
    migrateGoalDraft(state);
    if (Array.isArray(state.conversationIds)) {
      const valid = new Set(state.conversationIds); let removed = false;
      for (const id of drafts.keys()) if (!valid.has(id)) { drafts.delete(id); errors.delete(id); removed = true; }
      if (removed) persistDrafts();
    }
    if (changedSession) {
      byId('goal-view-switcher').open = false;
      noteSource = 'all';
      selectedNoteKey = ''; renderedNoteKey = 'reset'; renderedNoteIdentity = '';
      savedNoteToReveal = undefined;
      byId('goal-notes').dataset.reading = 'false';
      byId('notes-search').value = '';
      cancelScroll();
      sectionViews.clear();
      lastCriteria = ''; lastNotes = ''; lastCriteriaSource = lastNotesSource = undefined; forceScroll = true;
      restoreFields();
      byId('goal-setup').scrollTop = 0;
      byId('goal-panels').scrollTop = 0;
      showError(errors.get(sessionId) || '');
    }
    busy = Boolean(state.busy || state.execution?.busy || ['starting', 'running'].includes(state.execution?.status));
    scheduleRender();
  }
  let initialLoadTimer, initialRequestGeneration = 0;
  function requestInitialState() {
    const generation = ++initialRequestGeneration, epoch = viewEpoch;
    const failed = () => {
      if (hostState || suspended || generation !== initialRequestGeneration || epoch !== viewEpoch) return;
      clearTimeout(initialLoadTimer);
      setText(byId('page-loading-label'), '会话连接暂时不可用，请重新加载。');
      byId('page-retry').hidden = false;
    };
    try { Promise.resolve(vscode.postMessage({ action: 'ready' })).then(result => { if (result === false) failed(); }, failed); }
    catch { failed(); }
  }
  function watchInitialLoad() {
    clearTimeout(initialLoadTimer);
    initialLoadTimer = setTimeout(() => {
      if (hostState) return;
      setText(byId('page-loading-label'), '正在同步会话与工作区…');
      initialLoadTimer = setTimeout(() => {
        if (hostState) return;
        setText(byId('page-loading-label'), '会话仍在加载，请稍候或重新载入。');
        byId('page-retry').hidden = false;
      }, 7500);
    }, 2500);
  }
  byId('page-retry').addEventListener('click', () => {
    if (hostState) return;
    byId('page-retry').hidden = true;
    setText(byId('page-loading-label'), '正在重新加载会话与工作区…');
    watchInitialLoad();
    requestInitialState();
  });
  watchInitialLoad();
  updateControls();
  requestInitialState();
})();
