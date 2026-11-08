(() => {
  'use strict';
  const vscode = window.UBOVMRuntime?.api ?? acquireVsCodeApi();
  const t = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? (args.length ? String(value).replace(/\{(\d+)\}/g, (match, index) => args[index] == null ? match : String(args[index])) : value);
  // Compact token counts for the composer's context meter (12.3K / 128K).
  const tokenCount = value => value >= 1000000 ? (value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M'
    : value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(value);
  // Persisted per-conversation total; totalTokens already sums input and output.
  const conversationTotal = usage => {
    if (!usage) return 0;
    if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
    return (Number.isFinite(usage.input) ? usage.input : 0) + (Number.isFinite(usage.output) ? usage.output : 0);
  };
  const userTextIds = new Set(['conversation-title', 'goal-objective', 'workspace-name', 'context-label', 'goal-selection-label']);
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const QUEUE_LIMIT = 20;
  const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;
  const isImageFile = file => Boolean(file && (IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_NAME.test(file.name || ''))));
  const isImageUri = value => {
    try { const uri = new URL(value); return uri.protocol === 'file:' && IMAGE_NAME.test(decodeURIComponent(uri.pathname)); }
    catch { return false; }
  };
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
  const connection = window.createConnectionMonitor({ interval: 5000, timeout: 30000, send: value => vscode.postMessage(value), onChange: (status, previous) => {
    connectionStatus = status;
    // Transport conditions are advisory. No probe deadline discards an in-flight
    // operation, clears the draft or freezes the composer: each operation keeps
    // its own deadline and result, and a recovery re-syncs authoritative state.
    if (status === 'unresponsive' || status === 'backend-disconnected' || status === 'backend-stalled') scheduleRender();
    else {
      // Soft reconnect ticks only need the connection strip; avoid relayout storms.
      scheduleRender(true);
    }
    if (status === 'connected' && ['unresponsive', 'backend-disconnected', 'backend-stalled', 'reconnecting'].includes(previous)) requestReadyResync();
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
  byId('connection-restart').addEventListener('click', () => { void restartBackend(); });
  function renderConnectionStatus() {
    // Backend flaps and a slow IDE bridge are advisory states: they never clear
    // pending operations or freeze stop/resume. Only a silent bridge pauses new
    // sends, because they cannot be delivered until the host answers again.
    const offline = ['unresponsive', 'backend-disconnected', 'backend-stalled'].includes(connectionStatus);
    byId('connection-warning').hidden = !offline;
    // Manual backend recovery stays available whenever the banner is visible; it
    // is the supported exit from a backend that is stalled rather than crashed.
    const restart = byId('connection-restart');
    if (restart) {
      const restarting = hasPending('restartBackend');
      setProperty(restart, 'hidden', !offline);
      setProperty(restart, 'disabled', restarting);
      setText(restart, restarting ? '正在重启…' : '重启 Agent');
    }
    const canResume = executionState().canResume === true;
    setText(byId('connection-warning-text'), connectionStatus === 'unresponsive'
      ? 'IDE 响应变慢，正在等待恢复。已发送操作的结果尚未确认，草稿已保留；恢复后会自动同步状态。'
      : connectionStatus === 'backend-stalled'
        ? 'Agent 后端响应变慢，连接仍保持中，任务未中断。请稍候；若长时间无进展再检查后继续。'
      : canResume
        ? 'Agent 后端已断开，运行中的任务可能已中断。连接恢复后请点击“继续执行”从检查点恢复，请勿重复提交。'
        : 'Agent 后端已断开，运行中的任务可能已中断。请检查执行错误，再手动重新发起或恢复任务。');
    if (!offline) return;
    if (busy && connectionStatus === 'backend-stalled') {
      for (const id of ['busy-status', 'header-execution-status', 'goal-run-status', 'execution-phase']) setText(byId(id), '响应变慢 · 任务仍在进行');
    } else if (busy) {
      const label = connectionStatus === 'unresponsive' ? '响应变慢 · 状态待确认' : '连接中断 · 任务状态待确认';
      for (const id of ['busy-status', 'header-execution-status', 'goal-run-status', 'execution-phase']) setText(byId(id), label);
    }
    // A backend flap never freezes actions. A silent bridge cannot deliver a new
    // send, so only sending is paused until the next probe answer.
    if (connectionStatus === 'unresponsive') for (const id of ['submit-prompt', 'goal-run', 'goal-resume', 'assist-resume', 'goal-stop']) byId(id).disabled = true;
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
  // Recent sends are page-local history (never host state or model context);
  // long pastes are folded into the draft until the user expands or removes them.
  let promptHistory = [];
  let historyCursor = -1;
  let historyScratch = '';
  let pasteSequence = 0;
  const PASTE_CHIP_MIN = 3000;
  const pending = new Map();
  const errors = new Map();
  const goalViews = ['overview', 'agenda', 'board', 'workers', 'notes'];
  let currentSessionId = '';
  let hostState = null;
  let approvalModeConfirming = false;
  const stateOrder = window.createStateOrder();
  let renderedPageKey = '';
  let pageAnimation, pendingViewRestore;
  let routePending = false, routePaintReady = false;
  let routeCoverTimer = 0;
  const ROUTE_COVER_DELAY_MS = 140;
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
    clearTimeout(routeCoverTimer);
    routeCoverTimer = 0;
    if (kind === 'view' && firstContentPaint) {
      // Most exploration page switches finish in well under one frame budget.
      // Do not flash a full-surface spinner for those; only reveal the cover
      // when the paint is genuinely slow. The content fade/slide still runs
      // after commit via animateCurrentPage().
      loader.hidden = true;
      routeCoverTimer = setTimeout(() => {
        routeCoverTimer = 0;
        if (!routePending || !hostState) return;
        loader.hidden = false;
        renderNavigationFeedback();
      }, ROUTE_COVER_DELAY_MS);
    } else {
      loader.hidden = !firstContentPaint;
    }
    document.body.dataset.switching = 'true';
    renderNavigationFeedback();
    armRouteWatchdog();
  }
  function finishPageTransition() {
    clearRouteWatchdog();
    clearTimeout(routeCoverTimer);
    routeCoverTimer = 0;
    routePending = false; routePaintReady = false;
    const loader = byId('route-loading');
    loader.hidden = true;
    delete loader.dataset.kind;
    document.body.dataset.switching = 'false';
    renderNavigationFeedback();
    try { repairPrimarySurface(); } catch { /* The next paint still repairs it. */ }
  }
  // The transition cover is the only full-surface mask. A dropped paint must not
  // leave it (a blank canvas) on screen until the user resizes the window.
  let routeWatchdog = 0;
  function clearRouteWatchdog() { clearTimeout(routeWatchdog); routeWatchdog = 0; }
  function armRouteWatchdog() {
    clearRouteWatchdog();
    routeWatchdog = setTimeout(() => {
      routeWatchdog = 0;
      if (!routePending || !hostState) return;
      // Hidden/occluded windows legitimately cannot paint. Keep watching instead
      // of leaving the transition armed forever when the window returns.
      if (pageHidden()) { armRouteWatchdog(); return; }
      // A route paint never committed: re-arm a full paint before surfacing recovery.
      fullRenderPending = true;
      renderPending = true;
      scheduleRender();
      routeWatchdog = setTimeout(() => {
        routeWatchdog = 0;
        if (!routePending || !hostState) return;
        if (pageHidden()) { armRouteWatchdog(); return; }
        // A failed or dropped paint must not leave the full-surface loader (or a
        // blank canvas) in place indefinitely.
        finishPageTransition();
        scheduleRender();
        window.UBOVMRuntime?.fail('页面切换未完成。请同步最新状态或重新加载页面。');
      }, 4000);
    }, 8000);
  }
  function resumeRouteTransition() {
    if (!routePending) return;
    armRouteWatchdog();
    scheduleRender();
  }
  function renderNavigationFeedback() {
    const navigating = navigationPending() || routePending;
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
  // The Agent notebook lives in the execution memory projection, which the host
  // may omit on a tick whose memory revision did not change ("unchanged", not
  // "empty"). Remember the last non-empty list so a light tick cannot blank the
  // notebook for one frame while an exploration is running.
  let lastAgentNotes = { session: '', notes: [] };
  let lastCriteriaSource, lastNotesSource;
  let noteSource = 'all';
  let selectedNoteKey = '', renderedNoteKey = '', renderedNoteIdentity = '';
let editingNote = null;
  let savedNoteToReveal;
  const noteEntries = new WeakMap();
  let forceScroll = false;
  let requestCounter = 0;
  const messageViews = new Map();
  const sectionViews = new Map();
  const inputSizes = new WeakMap();
  const scrollPositions = new WeakMap();
  const goalViewScroll = new Map();
  // Long histories paint only the newest turns synchronously so the page skeleton
  // can clear in one frame; the rest of the published history streams in above on
  // later frames under a small synchronous time budget. Short conversations keep
  // the single full paint so fixtures and reader order do not change.
  const HISTORY_PROGRESSIVE_MIN = 24;     // histories longer than this paint progressively
  const HISTORY_SYNC_COUNT = 3;           // newest messages painted on the first frame
  const HISTORY_FRAME_BUDGET_MS = 6;      // synchronous DOM work allowed per backfill frame
  const HISTORY_MAX_MOUNTED = 600;        // cap live DOM; older pages load on demand
  const HISTORY_PAGE_SIZE = 600;
  const HISTORY_OUTLINE_INTERVAL_MS = 250; // coalesced outline rebuild interval during fill
  let historyFillFrame = 0;
  let historyOutlineAt = 0;
  let historyInteractionTimer = 0;
  // Progressive backfill grows the scroll range above/below the reader. While the
  // reader is dragging the scrollbar or wheeling, that growth lands mid-gesture and
  // makes the thumb jump, so defer the fill until the interaction settles.
  let interactingUntil = 0;
  const noteInteraction = () => { interactingUntil = performance.now() + 200; };
  let historyLoadingEl = null;
  let pendingThreadTeardown;
  function cancelHistoryFill() {
    if (historyFillFrame) { cancelAnimationFrame(historyFillFrame); historyFillFrame = 0; }
    if (historyInteractionTimer) { clearTimeout(historyInteractionTimer); historyInteractionTimer = 0; }
  }
  // The indicator explains the top gap while older history is still streaming in.
  // It lives inside #messages (role=log) so the announcement is polite; removing it
  // when the fill completes is compensated by the caller's scroll anchoring.
  function setHistoryLoading(active, more = false, count = 0) {
    if (!active) {
      if (historyLoadingEl) { historyLoadingEl.remove(); historyLoadingEl = null; }
      return;
    }
    if (!historyLoadingEl || !historyLoadingEl.isConnected) {
      historyLoadingEl = document.createElement('div');
      historyLoadingEl.className = 'history-loading';
      historyLoadingEl.setAttribute('role', 'status');
      historyLoadingEl.setAttribute('aria-live', 'polite');
      historyLoadingEl.setAttribute('aria-atomic', 'true');
    }
    historyLoadingEl.replaceChildren();
    if (more) {
      const text = document.createElement('span');
      text.textContent = t('已加载最近 {0} 条记录，更早的记录仍保留在会话中。', String(count));
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.textContent = t('载入更早的记录');
      button.addEventListener('click', () => {
        button.disabled = true;
        const view = messageViews.get(messages);
        if (!view) return;
        view.capped = false;
        view.historyLimit = (view.historyLimit ?? HISTORY_MAX_MOUNTED) + HISTORY_PAGE_SIZE;
        setHistoryLoading(true); scheduleHistoryFill();
      }, { once: true });
      historyLoadingEl.append(text, button);
    } else {
      historyLoadingEl.textContent = t('正在载入较早的记录…');
    }
    if (messages.firstChild !== historyLoadingEl) messages.insertBefore(historyLoadingEl, messages.firstChild);
    historyLoadingEl.hidden = false;
  }
  // The first progressive paint mounts cheap shells: the first visible part only.
  // Remaining parts are appended one at a time on later frames so one frame never has
  // to lay out every tool card of the newest turns at once (the ~50 ms first-paint
  // long task). Until a shell finishes hydrating it shows a small inline hint.
  function createHydratingHint() {
    const hint = document.createElement('div');
    hint.className = 'message-hydrating';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = t('正在载入工具记录…');
    return hint;
  }
  function queueHistoryHydration(view, entry, parts) {
    entry.pendingParts = parts;
    entry.hydrated = 1;
    entry.hint = createHydratingHint();
    entry.article.dataset.hydrating = 'true';
    entry.article.appendChild(entry.hint);
    view.hydration ??= [];
    view.hydration.push(entry);
  }
  function finishHistoryHydration(entry) {
    entry.hint?.remove();
    entry.hint = undefined;
    entry.pendingParts = undefined;
    entry.hydrated = 1;
    entry.article.removeAttribute('data-hydrating');
  }
  // Drop queued hydration for entries that were replaced or removed by a full
  // history reconcile; their parts are rendered synchronously by that reconcile.
  function clearHistoryHydration(view) {
    for (const entry of view.hydration || []) {
      if (entry.pendingParts) finishHistoryHydration(entry);
    }
    view.hydration = [];
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
    for (const container of pending.containers) {
      // The conversation container is shared across sessions. A deferred
      // teardown must never clear a newer view that has already remounted in
      // the same node; doing so produces a perfectly-sized white surface.
      if (messageViews.has(container)) continue;
      try { container.replaceChildren(); } catch { /* Independent teardown. */ }
    }
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
      for (const container of pendingThreadTeardown.containers) {
        if (messageViews.has(container)) continue;
        try { container.replaceChildren(); } catch { /* Independent teardown. */ }
      }
    }
    pendingThreadTeardown = { views, containers };
    // Without a painted route mask the old thread would flash; release immediately.
    if (!firstContentPaint || !routePending) flushThreadTeardown();
  }
  let latestFrame = 0;
  // Hysteresis: show only once the reader is clearly away from the bottom, hide
  // only when essentially there. Streamed height changes otherwise flap the
  // "back to latest" button around the threshold while the reader follows.
  let latestVisible = false;
  function refreshLatest() {
    if (latestFrame || visualSuspended()) return;
    latestFrame = requestAnimationFrame(() => {
      latestFrame = 0;
      if (visualSuspended()) return;
      const enabled = hostState?.mode !== 'goal' && showingConversation;
      const delta = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
      latestVisible = enabled && delta > (latestVisible ? 120 : 200);
      byId('conversation-latest').hidden = !latestVisible;
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
  function cancelScroll() { /* Bottom pinning is synchronous; no queued frames to clear. */ }
  for (const scroller of [conversation, byId('goal-panels')]) {
    scrollPositions.set(scroller, { top: 0, following: true });
    scroller.addEventListener('scroll', () => {
      const position = scrollPositions.get(scroller);
      if (scroller.scrollTop < position.top - 1) position.following = false;
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2) position.following = true;
      position.top = scroller.scrollTop;
      if (scroller === conversation) refreshLatest();
    }, { passive: true });
  }
  // A wheel or scrollbar drag must finish before older history is inserted above
  // the reader; otherwise the thumb jumps and every fill batch forces another
  // full layout mid-gesture. Programmatic pin scroll events are intentionally not
  // treated as interaction.
  conversation.addEventListener('wheel', noteInteraction, { passive: true });
  conversation.addEventListener('pointerdown', noteInteraction, { passive: true });

  let conversationOutline;
  function renderConversationOutline() {
    if (!hostState || hostState.mode === 'goal') return;
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
    if (Array.isArray(saved?.promptHistory)) {
      promptHistory = saved.promptHistory.filter(item => typeof item === 'string' && item.trim()).map(item => item.slice(0, 8000)).slice(0, 20);
    }
    if (saved && saved.drafts && typeof saved.drafts === 'object') {
      for (const [id, value] of Object.entries(saved.drafts).slice(-100)) {
        if (!value || typeof value !== 'object') continue;
        drafts.set(id, {
          assist: typeof value.assist === 'string' ? value.assist.slice(0, 8000) : '',
          // Full approval is never restored from a previous page load: it must be
          // re-confirmed through the composer dialog.
          approvalMode: ['auto', 'manual'].includes(value.approvalMode) ? value.approvalMode : undefined,
          goalPrompt: typeof value.goalPrompt === 'string' ? value.goalPrompt.slice(0, 8000) : '',
          note: typeof value.note === 'string' ? value.note.slice(0, 2000) : '',
          goalDraft: value.goalDraft && typeof value.goalDraft.objective === 'string' && typeof value.goalDraft.criteria === 'string'
            ? { objective: value.goalDraft.objective.slice(0, 4000), initialFacts: typeof value.goalDraft.initialFacts === 'string' ? value.goalDraft.initialFacts.slice(0, 8000) : '', criteria: value.goalDraft.criteria.slice(0, 6020) } : null,
          goalEditing: value.goalEditing === true,
          view: goalViews.includes(value.view) ? value.view : 'overview',
          pastes: normalizePastes(value.pastes),
          touchedAt: Number(value.touchedAt) || 0
        });
      }
    }
  } catch { /* An unavailable draft cache must not prevent the UI opening. */ }
  function draftFor(id = currentSessionId) {
    if (!drafts.has(id)) drafts.set(id, { assist: '', goalPrompt: '', note: '', goalDraft: null, goalEditing: false, view: 'overview', pastes: [], touchedAt: Date.now() });
    const draft = drafts.get(id);
    if (!Array.isArray(draft.pastes)) draft.pastes = [];
    return draft;
  }
  // Long pastes are independent strings: restore them defensively and enforce the
  // same 8,000-character composer budget so a stale page state cannot overflow it.
  function normalizePastes(value) {
    if (!Array.isArray(value)) return [];
    const chips = [];
    let used = 0;
    for (const entry of value.slice(0, 12)) {
      if (!entry || typeof entry.text !== 'string' || !entry.text) continue;
      const text = entry.text.slice(0, 8000 - used);
      if (!text) break;
      chips.push({ id: typeof entry.id === 'string' && entry.id ? entry.id : 'paste-restored-' + chips.length, text });
      used += text.length;
    }
    return chips;
  }
  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (currentSessionId) draftFor().touchedAt = Date.now();
    const entries = [...drafts.entries()].filter(([id]) => id).sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(-100);
    try { vscode.setState({ drafts: Object.fromEntries(entries), workerPanelWidth, promptHistory }); return true; }
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
  function rememberPrompt(text) {
    const value = String(text || '').slice(0, 8000).trim();
    if (!value) return;
    promptHistory = [value, ...promptHistory.filter(item => item !== value)].slice(0, 20);
  }
  function applyHistoryValue(value) {
    input.value = value;
    draftFor().assist = value;
    scheduleDraftPersistence();
    scheduleInput();
    try { input.setSelectionRange(value.length, value.length); } catch { /* selection is best effort */ }
  }
  // ↑/↓ recall like a shell: recall starts only in an empty composer, and any real
  // edit exits it. The draft typed before recall is restored on the way back.
  function navigateHistory(direction) {
    if (!promptHistory.length) return false;
    if (direction < 0) {
      if (input.value !== '' && historyCursor < 0) return false;
      if (historyCursor < 0) historyScratch = input.value;
      if (historyCursor >= promptHistory.length - 1) return true;
      historyCursor += 1;
      applyHistoryValue(promptHistory[historyCursor]);
      return true;
    }
    if (historyCursor < 0) return false;
    historyCursor -= 1;
    applyHistoryValue(historyCursor >= 0 ? promptHistory[historyCursor] : historyScratch);
    return true;
  }
  function resetHistoryRecall() { historyCursor = -1; historyScratch = ''; }
  // The composer sends folded long pastes before the typed text, matching the
  // order in which they were added. Both count against the 8,000-character limit.
  function composerPromptText() {
    const chips = draftFor().pastes || [];
    return [chips.map(chip => chip.text).join('\n\n'), input.value].filter(part => part.trim()).join('\n\n');
  }
  function composerLength() {
    return (draftFor().pastes || []).reduce((total, chip) => total + chip.text.length, 0) + input.value.length;
  }
  function hasComposerText() { return Boolean(input.value.trim()) || (draftFor().pastes || []).length > 0; }
  function renderPastes() {
    const container = byId('composer-pastes');
    if (!container) return;
    const chips = draftFor().pastes || [];
    const key = chips.map(chip => chip.id + ':' + chip.text.length).join('|');
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    container.replaceChildren();
    container.hidden = !chips.length;
    for (const chip of chips) {
      const wrap = document.createElement('span'); wrap.className = 'composer-paste';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'composer-paste-open';
      open.dataset.pasteExpand = chip.id; open.title = t('展开到输入框');
      const preview = document.createElement('span');
      const flattened = chip.text.replace(/\s+/g, ' ').trim();
      preview.textContent = (flattened.slice(0, 26) || t('已粘贴文本')) + (flattened.length > 26 ? '…' : '');
      const count = document.createElement('small'); count.textContent = chip.text.length.toLocaleString() + ' ' + t('字');
      open.append(preview, count);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'composer-paste-remove';
      remove.dataset.pasteRemove = chip.id; remove.title = t('删除这段粘贴'); remove.setAttribute('aria-label', t('删除粘贴的文本'));
      remove.textContent = '×';
      wrap.append(open, remove);
      container.append(wrap);
    }
  }
  function addPasteChip(text) {
    const draft = draftFor();
    const room = 8000 - draft.pastes.reduce((total, chip) => total + chip.text.length, 0) - input.value.length;
    if (room <= 0) { showError('内容已达到 8,000 字符上限。'); return; }
    const bounded = text.length > room ? text.slice(0, room) : text;
    draft.pastes.push({ id: 'paste-' + Date.now().toString(36) + '-' + (++pasteSequence), text: bounded });
    if (bounded.length < text.length) showError('粘贴内容超过 8,000 字符上限，已截断到剩余空间。');
    renderPastes(); scheduleDraftPersistence(); updateInput();
  }
  function removePasteChip(id) {
    const draft = draftFor();
    const index = draft.pastes.findIndex(chip => chip.id === id);
    if (index < 0) return;
    draft.pastes.splice(index, 1);
    renderPastes(); scheduleDraftPersistence(); updateInput();
    input.focus({ preventScroll: true });
  }
  function expandPasteChip(id) {
    const draft = draftFor();
    const index = draft.pastes.findIndex(chip => chip.id === id);
    if (index < 0) return;
    const chip = draft.pastes[index];
    const room = 8000 - input.value.length;
    if (room <= 0) { showError('输入框已达到 8,000 字符上限。'); return; }
    const joined = input.value && !input.value.endsWith('\n') ? input.value + '\n' : input.value;
    const text = (joined + chip.text).slice(0, 8000);
    input.value = text;
    draft.assist = text;
    draft.pastes.splice(index, 1);
    renderPastes(); scheduleDraftPersistence(); updateInput(); input.focus();
    if (chip.text.length > room) showError('部分内容超过 8,000 字符上限，未展开的部分请重新粘贴。');
  }
  let turnStartedAt = 0, elapsedTicker = 0;
  function startElapsedTicker() {
    if (elapsedTicker) return;
    elapsedTicker = setInterval(() => {
      if (!busy || suspended || document.hidden) return;
      updateComposer();
    }, 1000);
  }
  function stopElapsedTicker() {
    if (!elapsedTicker) return;
    clearInterval(elapsedTicker); elapsedTicker = 0;
  }
  // Background tabs do not need a once-per-second repaint. Resume from the
  // wall-clock start when the page becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopElapsedTicker();
    else if (busy) startElapsedTicker();
  });
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
  let lastErrorDetail = '';
  function showError(message, sessionId = currentSessionId) {
    if (message) errors.set(sessionId, message); else errors.delete(sessionId);
    const value = errors.get(currentSessionId);
    const failure = window.UBOVMErrors.normalize(value);
    byId('ui-error-title').textContent = window.UBOVMErrors.title(failure);
    byId('ui-error').dataset.cancelled = String(failure.cancelled);
    byId('ui-error').setAttribute('role', failure.cancelled ? 'status' : 'alert');
    byId('ui-error').setAttribute('aria-live', failure.cancelled ? 'polite' : 'assertive');
    byId('ui-error-message').textContent = value ? failure.message : '';
    const hint = value ? failure.hint : '';
    byId('ui-error-hint').textContent = hint || '';
    byId('ui-error-hint').hidden = !hint;
    lastErrorDetail = value ? [failure.message, hint, failure.code ? '错误代码：' + failure.code : '', failure.detail].filter(Boolean).join('\n') : '';
    byId('ui-error-detail').textContent = '错误代码：' + failure.code + (failure.detail ? '\n' + failure.detail : '');
    byId('ui-error-details').hidden = !failure.detail && failure.code === 'OPERATION_FAILED';
    byId('ui-error-copy').hidden = !lastErrorDetail;
    byId('ui-error-details').open = false;
    byId('ui-error').hidden = !value;
  }
  byId('ui-error-dismiss').addEventListener('click', () => showError(''));
  byId('ui-error-copy').addEventListener('click', () => {
    if (!lastErrorDetail) return;
    messageActions.onCopy(lastErrorDetail).then(() => {
      byId('ui-error-copy').textContent = '已复制';
      setTimeout(() => { byId('ui-error-copy').textContent = '复制详情'; }, 1500);
    }).catch(error => showError(error.message));
  });
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
    // A restart is exactly what a silent page may still be able to deliver: the
    // probe may fail while the extension host is alive and only the backend is
    // stuck, so this action bypasses the "cannot deliver" guard.
    if (connectionStatus === 'unresponsive' && action !== 'restartBackend') {
      completeCallback(onError, new Error('IDE 暂未响应，操作未发送。恢复后会自动同步状态，请稍后重试。'), currentSessionId);
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
  byId('open-projects')?.addEventListener('click', () => projectSwitcher.open());
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
  // Keep the fixed background-task dock above the composer. The composer grows
  // with the textarea, image chips and queued prompts, so a static offset would
  // let the dock cover the input area.
  const composeDock = byId('compose-dock');
  const syncComposeDockOffset = () => {
    if (!composeDock) return;
    const box = composeDock.getBoundingClientRect();
    if (!box.height) return;
    const offset = Math.max(0, Math.round(window.innerHeight - box.top));
    document.documentElement.style.setProperty('--compose-dock-offset', offset + 'px');
  };
  if (composeDock && typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(syncComposeDockOffset);
    observer.observe(composeDock);
    observer.observe(byId('composer-stack'));
    window.addEventListener('resize', syncComposeDockOffset);
    syncComposeDockOffset();
  }
  const workerPanel = window.createWorkerPanel(messageActions, { openNative: id => { if (!hostState?.nativeWorkerPanel) return false; if (!hasPending('openWorker')) void renderRequest('openWorker', { workerId: id }).catch(() => {}); return true; }, initialWidth: workerPanelWidth, onWidthChange: width => { workerPanelWidth = width; persistDrafts(); } });
  const teamPanel = window.createTeamPanel({
    onSelectMember: name => {
      // A teammate name opens that member's conversation; the Lead row returns
      // to the main conversation (null).
      if (name) openTeamMember(name);
      else closeTeamMember({ restoreFocus: false });
    }
  });
  const teamMemberView = window.createTeamMemberView({
    actions: messageActions,
    onClose: () => clearTeamWatchMember(),
    onRetry: name => { if (teamMemberView.isOpen) requestTeamMember(name); },
    isBlocked: () => teamPanel.isOpen
  });
  // The member view is driven by `execution.teamWatch`, which the host projects
  // from the selected teammate's transcript. Opening asks for the watch and
  // shows the loading surface immediately; closing always clears it so the host
  // stops projecting that member.
  function requestTeamMember(name) {
    return request('watchTeamMember', { name }, undefined, failure => {
      if (teamMemberView.isOpen && teamMemberView.name === name) {
        teamMemberView.fail(failure?.message || '读取该成员的会话失败，请重试。');
      }
    }, 8000);
  }
  function openTeamMember(name) {
    const member = typeof name === 'string' ? name.trim() : '';
    if (!member) return;
    teamMemberView.open(member);
    requestTeamMember(member);
  }
  function closeTeamMember({ restoreFocus = true } = {}) {
    if (!teamMemberView.isOpen) return;
    teamMemberView.close({ restoreFocus });
  }
  // Best-effort clear, idempotent: the host ignores clears when no member is
  // selected. A failure never reopens the view or blocks navigation.
  function clearTeamWatchMember() {
    if (!currentSessionId) return;
    request('watchTeamMember', { name: null }, undefined, () => {}, 5000);
  }
  // Registered before the pagehide cleanup below so the clear still reaches the
  // host while the bridge is open; the host drops it if the session is gone.
  window.addEventListener('pagehide', () => {
    if (teamMemberView.isOpen) closeTeamMember({ restoreFocus: false });
  });
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
  // Exploration chat is a native right-sidebar view (Copilot-style tab). This
  // header button toggles it: the first click reveals the chat tab, a second
  // click collapses the right sidebar. The pressed state mirrors the host's live
  // sidebar visibility so manual tab switches stay in sync. The visible label
  // stays "对话" so the header never reflows between states.
  function renderGoalChatToggle() {
    const toggle = byId('goal-chat-toggle');
    const open = hostState?.goalChatOpen === true;
    setProperty(toggle.dataset, 'open', String(open));
    setAttribute(toggle, 'aria-pressed', String(open));
    setAttribute(toggle, 'aria-label', open ? '收起探索对话' : '打开探索对话');
    setAttribute(toggle, 'title', open ? '收起探索对话' : '打开探索对话');
  }
  byId('goal-chat-toggle').addEventListener('click', () => {
    request('openGoalChat', {}, () => {}, failure => showError(failure?.message || '打开探索对话失败，请重试。'));
  });
  function updateInput() {
    if (hostState?.mode !== 'goal') resizeInput(input, Math.max(64, Math.min(220, Math.floor(window.innerHeight * .28))));
    updateSubmit(submit, input);
    updateComposer();
  }
  function approvalModeValue() {
    return draftFor().approvalMode ?? (hostState?.requireToolApproval === false ? 'auto' : 'manual');
  }
  function reflectApprovalMode() {
    const selected = approvalModeValue();
    for (const option of approvalMode.elements) setProperty(option, 'checked', option.value === selected);
  }
  // Full mode drops the workspace boundary and the per-call approval gate. Keep
  // the previous choice applied until the user confirms what that means; a
  // cancelled dialog must leave both the draft and the radio group untouched.
  async function confirmFullApprovalMode() {
    if (approvalModeConfirming) return;
    approvalModeConfirming = true;
    let confirmed = false;
    try {
      confirmed = await modalDialog.confirm({
        title: '进入完全模式？',
        message: '完全模式会取消工作区边界与工具审批：工具可以直接读写任意路径（含凭据目录），并立即执行，不再逐条询问。',
        detail: '只应在确认目标、范围和后果后使用。进入后可在输入框工具栏切回「人工」或「自动」。',
        confirmLabel: '进入完全模式',
        cancelLabel: '保持当前模式',
        danger: true
      }) === true;
    } catch { confirmed = false; }
    finally {
      approvalModeConfirming = false;
      if (confirmed) { draftFor().approvalMode = 'full'; persistDrafts(); }
      reflectApprovalMode();
      renderInputQueue();
    }
  }
  function updateComposer() {
    const sending = hasPending('prompt');
    const queued = hostState?.inputQueue?.length > 0;
    const liveSteer = busy && executionState().canSteer === true && !queued && !hostState?.queuePaused;
    if (busy) { if (!turnStartedAt) turnStartedAt = Date.now(); startElapsedTicker(); }
    else if (turnStartedAt) { turnStartedAt = 0; stopElapsedTicker(); }
    const elapsed = busy && turnStartedAt ? Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000)) : 0;
    reflectApprovalMode();
    setProperty(approvalMode, 'disabled', busy || sending || navigationPending());
    setProperty(form.dataset, 'state', busy ? 'running' : sending ? 'sending' : 'idle');
    setProperty(form.dataset, 'steer', String(liveSteer));
    setProperty(input, 'placeholder', busy
      ? (liveSteer ? '补充说明将立刻调整当前任务…' : '补充说明或下一条消息，发送后排队…')
      : '提问、规划，或描述你想完成的改动…');
    const status = byId('composer-status');
    if (status) setText(status, hostState?.recovering ? '正在恢复执行记录 · 可以先写草稿' : hasPending('cancelRun') ? '正在停止…' : busy ? (liveSteer ? '执行中 · Enter 立刻引导' : '执行中 · Enter 排队') : sending ? '正在发送…' : '');
    // Running time lives in its own element: the composer state label stays the
    // stable, exact text other controls and tests rely on.
    const elapsedEl = byId('composer-elapsed');
    if (elapsedEl) {
      setProperty(elapsedEl, 'hidden', !busy);
      if (busy) {
        const elapsedText = elapsed >= 3600
          ? t('已用 {0} 时 {1} 分', Math.floor(elapsed / 3600), Math.floor((elapsed % 3600) / 60))
          : elapsed >= 60 ? t('已用 {0} 分 {1} 秒', Math.floor(elapsed / 60), elapsed % 60)
            : t('已用 {0} 秒', elapsed);
        setText(elapsedEl, elapsedText);
      }
    }
    const historyEl = byId('composer-history');
    if (historyEl) {
      const recalling = historyCursor >= 0;
      setProperty(historyEl, 'hidden', !recalling);
      if (recalling) setText(historyEl, t('历史 {0}/{1}', historyCursor + 1, promptHistory.length) + ' · ' + t('Esc 还原草稿'));
    }
    const meter = byId('context-usage');
    if (meter) {
      const { used, limit } = executionState().contextUsage ?? {};
      const usedTokens = Number.isSafeInteger(used) && used >= 0 ? used : 0;
      const hasLimit = Number.isSafeInteger(limit) && limit > 0;
      const usedLabel = usedTokens === 0 ? '0K' : tokenCount(usedTokens);
      const totalTokens = conversationTotal(hostState?.conversationUsage);
      const totalLabel = totalTokens === 0 ? '0K' : tokenCount(totalTokens);
      // Nothing measured yet (new session or first turn before usage arrives):
      // a "0K / Σ 0K" chip is noise, not information.
      const noUsage = usedTokens === 0 && totalTokens === 0;
      const percent = hasLimit ? Math.min(100, Math.max(0, Math.round((usedTokens / limit) * 100))) : 0;
      setProperty(meter, 'hidden', noUsage);
      const fill = byId('context-usage-fill');
      if (fill) { fill.style.width = percent + '%'; setProperty(fill.dataset, 'level', percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'); }
      setText(byId('context-usage-value'), usedLabel);
      setText(byId('context-usage-total'), 'Σ ' + totalLabel);
      const detail = t('上下文用量估算') + '：' + (hasLimit ? usedLabel + ' / ' + tokenCount(limit) + ' tokens · ' + percent + '%' : usedLabel + ' tokens')
        + ' · ' + t('本会话累计') + '：' + totalLabel + ' tokens';
      setProperty(meter, 'title', detail);
      setProperty(meter, 'aria-label', detail);
    }
    const shortcut = byId('prompt-shortcut');
    if (shortcut) setProperty(shortcut, 'hidden', busy || sending);
    const count = byId('prompt-count');
    if (count) {
      const length = composerLength();
      setProperty(count, 'hidden', length < 7200);
      setText(count, length.toLocaleString() + ' / 8,000');
      setProperty(count.dataset, 'limit', String(length >= 8000));
    }
  }
  let readingDrop = false, dropReadTask;
  function invalidateDropRead() { dropReadTask = undefined; readingDrop = false; clearDrop(); }
  function contextPending() { return readingDrop || hasPending('attachFile') || hasPending('attachImage') || hasPending('attachImagePath') || hasPending('removeImage') || hasPending('clearFileContext'); }
  const fileDrag = transfer => [...(transfer?.types || [])].some(type => ['files', 'text/uri-list', 'resourceurls'].includes(type.toLowerCase()));
  let dragDepth = 0, pageDragDepth = 0;
  const clearPageDrop = () => { pageDragDepth = 0; document.body.classList.remove('file-drag-over'); };
  const clearDrop = () => { dragDepth = 0; form.classList.remove('file-drag-over'); clearPageDrop(); };
  form.addEventListener('dragenter', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); dragDepth++; form.classList.add('file-drag-over');
  });
  form.addEventListener('dragleave', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.stopPropagation(); if (--dragDepth <= 0) clearDrop();
  });
  async function imagePayload(file) {
    if (!file || (file.type && !IMAGE_TYPES.has(file.type))) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片。');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 4 MiB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { name: file.name || 'image', mimeType: file.type || undefined, data: btoa(binary) };
  }
  function attachImageFile(file, sessionId = currentSessionId) {
    return imagePayload(file).then(image => new Promise((resolve, reject) => {
      const id = request('attachImage', { image }, resolve, reject, 30000);
      if (!id) reject(new Error('当前会话尚未准备完成。'));
    })).catch(error => {
      if (sessionId === currentSessionId) showError(window.UBOVMErrors.normalize(error, 'attachImage'), sessionId);
      throw error;
    });
  }
  async function attachImageFiles(files, sessionId = currentSessionId) {
    for (const file of files) {
      if (sessionId !== currentSessionId || visualSuspended()) return;
      await attachImageFile(file, sessionId).catch(() => {});
    }
  }
  form.addEventListener('dragover', event => {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    const imageDrag = [...(event.dataTransfer.items ?? [])].some(item => item.type?.startsWith('image/'));
    event.dataTransfer.dropEffect = imageDrag || !byId('attach-file').disabled ? 'copy' : 'none';
  });
  async function dropFiles(event) {
    if (!fileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); clearDrop();
    const sessionId = currentSessionId;
    if (visualSuspended() || readingDrop) return;
    // Capture availability before readingDrop marks the composer as pending;
    // that pending state itself disables the attach button.
    const attachEnabled = !byId('attach-file').disabled;
    const task = dropReadTask = {}, epoch = viewEpoch;
    readingDrop = true; updateControls();
    try {
      const files = [...event.dataTransfer.files];
      // webkitGetAsEntry() throws for synthetic/unsupported items instead of
      // returning null; fall back to a regular file drop in that case.
      let directory = false;
      try { directory = [...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory); } catch { /* Not inspectable here. */ }
      if (directory) throw new Error('请拖入文件，暂不支持文件夹。');
      const imageFiles = files.filter(isImageFile);
      if (imageFiles.length) {
        readingDrop = false;
        await attachImageFiles(imageFiles, sessionId);
        return;
      }
      if (!attachEnabled) return;
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
        if (Array.isArray(uris) && uris.length === 1 && typeof uris[0] === 'string' && isImageUri(uris[0])) {
          readingDrop = false;
          request('attachImagePath', { uri: uris[0] }, () => { if (epoch === viewEpoch && sessionId === currentSessionId) input.focus({ preventScroll: true }); });
          return;
        }
        if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string' || !uris[0].startsWith('file:')) throw new Error('请拖入一个本地文本文件。');
        attachment = { uri: uris[0] };
      }
      if (dropReadTask !== task || epoch !== viewEpoch || sessionId !== currentSessionId) return;
      readingDrop = false;
      request('attachFile', { attachment }, () => { if (epoch === viewEpoch && sessionId === currentSessionId && !visualSuspended()) input.focus({ preventScroll: true }); });
    } catch (error) { if (dropReadTask === task) showError(error instanceof TypeError ? '无法读取文件，请使用 UTF-8 文本文件。' : error.message, sessionId); }
    finally { if (dropReadTask === task) { dropReadTask = undefined; readingDrop = false; updateControls(); } }
  }
  form.addEventListener('drop', event => { void dropFiles(event); });
  // A file can be dropped anywhere in the page. The composer handlers stop
  // propagation, so this fallback only sees drags that started outside it; the
  // full-surface overlay confirms the drop without stealing pointer events.
  window.addEventListener('dragenter', event => {
    if (event.defaultPrevented || !fileDrag(event.dataTransfer)) return;
    event.preventDefault(); pageDragDepth++; document.body.classList.add('file-drag-over');
  });
  window.addEventListener('dragover', event => {
    if (event.defaultPrevented || !fileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const imageDrag = [...(event.dataTransfer.items ?? [])].some(item => item.type?.startsWith('image/'));
    event.dataTransfer.dropEffect = imageDrag || !byId('attach-file').disabled ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', event => {
    if (event.defaultPrevented || !fileDrag(event.dataTransfer)) return;
    if (!event.relatedTarget) { clearPageDrop(); return; }
    if (--pageDragDepth <= 0) clearPageDrop();
  });
  window.addEventListener('drop', event => {
    if (event.defaultPrevented || !fileDrag(event.dataTransfer)) { clearPageDrop(); return; }
    void dropFiles(event).finally(clearPageDrop);
  });
  window.addEventListener('dragend', clearDrop);
  function resizeInput(field, maximum) {
    // Chromium's field-sizing gives the textarea native content sizing, which
    // avoids a forced style/layout read on every keystroke. Keep the measured
    // fallback for engines without support.
    if (CSS.supports?.('field-sizing', 'content')) {
      if (field.style.height) field.style.removeProperty('height');
      inputSizes.delete(field);
      return;
    }
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
  // Only the model blocks conversation. SSH is optional and only gates remote
  // tools (the harness filters those out when no host is configured).
  function configurationMissing() { return hostState?.provider?.configured === false; }
  function updateSubmit(button, field) {
    setProperty(button.dataset, 'running', String(busy));
    const stop = busy && !hasComposerText();
    const liveSteer = busy && executionState().canSteer === true && !(hostState?.inputQueue?.length) && !hostState?.queuePaused;
    // A full queue keeps the send control enabled so the click explains why the
    // draft stays put; the host request itself is never sent by sendPrompt().
    const queueFull = queueAtLimit();
    setProperty(button.dataset, 'actionMode', stop ? 'stop' : busy ? (liveSteer ? 'steer' : 'queue') : 'send');
    setAttribute(button, 'aria-label', stop ? '停止执行' : queueFull ? '队列已满' : busy ? (liveSteer ? '引导当前任务' : '加入队列') : '发送任务');
    setProperty(button, 'title', stop ? '停止当前执行' : queueFull ? '队列已满，先继续发送或移除一条' : busy ? (liveSteer ? '立刻引导当前任务（Enter）' : '加入队列（Enter）') : '发送（Enter）');
    setAttribute(button.querySelector('path'), 'd', stop ? 'M6 6h12v12H6Z' : 'M12 19V5m-6 6 6-6 6 6');
    setProperty(button, 'disabled', connectionStatus === 'unresponsive' || !currentSessionId || hostState?.recovering || navigationPending() || hasPending('rewindInput') || hasPending('cancelRun') || (stop ? hasPending('prompt') : configurationMissing() || hasPending('runGoal') || hasPending('resumeRun') || contextPending() || (!hasComposerText() && !(hostState?.pendingImages?.length)) || composerLength() > field.maxLength));
  }
  // The composer model picker keeps native <select> semantics (keyboard,
  // type-ahead, form value) while presenting the DSH chip look. Chromium's
  // customizable select lets the trigger carry the provider mark and the popup
  // carry per-model metadata; older engines keep the plain option list.
  const supportsCustomSelect = (() => {
    try { return CSS.supports('appearance', 'base-select'); } catch { return false; }
  })();
  const modelIconCache = new Map();
  function modelPickerIcon(providerId) {
    const key = String(providerId || '');
    let icon = modelIconCache.get(key);
    if (!icon) {
      let library = {};
      try { library = typeof UBOVM_PROVIDER_ICONS === 'object' && UBOVM_PROVIDER_ICONS ? UBOVM_PROVIDER_ICONS : {}; } catch { library = {}; }
      // Brand marks ship with inline style attributes; CSP style-src has no
      // unsafe-inline, so strip them before the SVG enters this document.
      const markup = String(library[key] || '').replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');
      let svg;
      if (markup) {
        try {
          svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
          if (svg?.nodeName?.toLowerCase() !== 'svg') svg = null;
        } catch { svg = null; }
      }
      if (!svg) {
        // Neutral spark for custom/unknown providers.
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const shape = document.createElementNS(svg.namespaceURI, 'path');
        shape.setAttribute('d', 'M12 3.2c.55 3.7 2.6 5.75 6.3 6.3-3.7.55-5.75 2.6-6.3 6.3-.55-3.7-2.6-5.75-6.3-6.3 3.7-.55 5.75-2.6 6.3-6.3Z');
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', 'currentColor');
        shape.setAttribute('stroke-width', '1.7');
        shape.setAttribute('stroke-linejoin', 'round');
        svg.append(shape);
      }
      svg.querySelectorAll('title').forEach(node => node.remove());
      // The sanitized markup above already dropped inline styles; keep the DOM
      // side clean as well so no stray style attribute can trip the CSP.
      svg.removeAttribute('style');
      svg.querySelectorAll('[style]').forEach(node => node.removeAttribute('style'));
      svg.setAttribute('class', 'model-provider-icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      modelIconCache.set(key, svg);
      icon = svg;
    }
    return icon.cloneNode(true);
  }
  function fillModelPicker(select, choices, providerId, defaultModel) {
    const nodes = [];
    if (supportsCustomSelect) {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.append(modelPickerIcon(providerId));
      trigger.append(document.createElement('selectedcontent'));
      nodes.push(trigger);
    }
    for (const id of choices) {
      const option = document.createElement('option');
      option.value = id;
      if (supportsCustomSelect) {
        const name = document.createElement('span');
        name.className = 'model-option-name';
        name.textContent = id;
        option.append(name);
        if (id === defaultModel) {
          const tag = document.createElement('span');
          tag.className = 'model-option-tag';
          tag.textContent = t('默认');
          option.append(tag);
        }
      } else {
        option.textContent = id;
      }
      nodes.push(option);
    }
    select.replaceChildren(...nodes);
  }
  function updateControls() {
    renderInputQueue();
    renderPendingImages();
    document.querySelectorAll('.message-rewind').forEach(button => {
      setProperty(button, 'disabled', rewindControlsBlocked());
    });
    const unavailable = !currentSessionId || navigationPending();
    const waiting = [...pending.values()].find(item => item.sessionId === currentSessionId && !['setMode', 'newChat'].includes(item.action));
    const waitingLabels = { openWorker: '正在打开日志', openMessageLink: '正在打开链接', attachFile: '正在添加文件', attachImage: '正在添加图片', attachImagePath: '正在添加图片', removeImage: '正在移除图片', selectWorkspace: '正在打开工作区', saveGoal: '正在保存目标', addGoalNote: '正在保存笔记', prompt: '正在发送', cancelRun: '正在停止', runGoal: '正在准备执行', resumeRun: '正在恢复执行', copyText: '正在复制', steerInput: '正在发送引导', removeInput: '正在更新队列', resumeInputs: '正在继续队列' };
    setProperty(byId('operation-loading'), 'hidden', !waiting);
    setText(byId('operation-loading'), waiting ? (waitingLabels[waiting.action] || '正在处理操作') + '，请稍候…' : '');
    const openingWorker = hasPending('openWorker');
    document.querySelectorAll('.worker-card, .goal-log-worker').forEach(button => {
      if (button.disabled !== openingWorker) button.disabled = openingWorker;
      if (button.getAttribute('aria-busy') !== String(openingWorker)) button.setAttribute('aria-busy', String(openingWorker));
    });
    const promptPending = hasPending('prompt');
    setProperty(input, 'disabled', unavailable);
    renderNavigationFeedback();
    setProperty(byId('attach-file'), 'disabled', unavailable || busy || promptPending || contextPending());
    const selectedModel = hostState?.modelSelection?.selected || '';
    const defaultModel = hostState?.modelSelection?.defaultModel || '';
    const imageUnsupported = hostState?.modelSelection?.imageInput === false && (!selectedModel || selectedModel === defaultModel);
    setProperty(byId('attach-image'), 'disabled', unavailable || promptPending || contextPending() || imageUnsupported);
    setProperty(byId('attach-image'), 'title', imageUnsupported ? '当前模型不支持图片输入' : '添加图片');
    setProperty(byId('image-input'), 'disabled', unavailable || promptPending || contextPending() || imageUnsupported);
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
    const savingNote = hasPending('addGoalNote') || hasPending('editNote') || hasPending('editAgentNote');
    setProperty(noteInput, 'disabled', unavailable || savingNote);
    setProperty(byId('goal-add-note'), 'disabled', unavailable || !(hostState?.goal || hostState?.mode === 'assist') || savingNote || !noteInput.value.trim());
    setProperty(byId('goal-add-note'), 'textContent', savingNote ? '正在保存…' : editingNote ? '保存修改' : '保存笔记');
    setProperty(byId('note-new'), 'disabled', unavailable || !(hostState?.goal || hostState?.mode === 'assist'));
    setText(byId('note-new'), noteInput.value && !editingNote ? '继续草稿' : '＋ 新建笔记');
    setText(byId('note-length'), noteInput.value.length.toLocaleString() + ' / 2,000');
    setText(byId('note-draft-status'), savingNote ? (hostState?.mode === 'assist' ? '正在保存到当前会话…' : '正在保存到当前目标…') : editingNote ? '修改会立即保存到这条笔记。' : busy ? '任务执行中也可保存笔记，关闭后保留草稿。' : '关闭后保留草稿');
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
    // A hidden/visible transition can be interrupted while the composer is
    // being moved between its two slots. Do not trust the boolean alone: a
    // stale mount can leave a correctly-sized page with an empty surface.
    const expectedSlot = byId(hasMessages ? 'composer-chat-slot' : 'composer-home-slot');
    const mounted = byId('composer-stack').parentElement === expectedSlot;
    const alreadyPainted = showingConversation === hasMessages &&
      conversation.hidden === !hasMessages &&
      byId('empty-state').hidden === hasMessages &&
      byId('compose-dock').hidden === !hasMessages && mounted;
    if (alreadyPainted) return;
    const hadFocus = document.activeElement === input;
    showingConversation = hasMessages;
    byId('empty-state').hidden = hasMessages;
    conversation.hidden = !hasMessages;
    byId('compose-dock').hidden = !hasMessages;
    byId(hasMessages ? 'composer-chat-slot' : 'composer-home-slot').appendChild(byId('composer-stack'));
    if (hadFocus) input.focus({ preventScroll: true });
    updateInput();
  }
  // The host projection rebuilds the image payload for every snapshot, so an
  // identity check would treat an unchanged image as a change and re-render the
  // whole card. Compare only the fields the figure renders.
  function sameToolImage(left, right) {
    if (left === right) return true;
    const a = left && typeof left === 'object' ? left : null;
    const b = right && typeof right === 'object' ? right : null;
    if (!a || !b) return !a && !b;
    return a.mimeType === b.mimeType && a.data === b.data
      && a.width === b.width && a.height === b.height && a.bytes === b.bytes;
  }
  function sameParts(left, right) {
    if (left === right) return true;
    if (!Array.isArray(left) || !Array.isArray(right)) return !left?.length && !right?.length;
    return left.length === right.length && left.every((part, index) => {
      const other = right[index];
      if (!other) return false;
      return ['id', 'type', 'text', 'name', 'status', 'executionState', 'commandId', 'interruptRequested', 'background', 'args', 'output', 'startedAt', 'endedAt', 'truncated', 'source', 'workerId', 'fallback', 'beforeTokens', 'afterTokens']
        .every(key => part[key] === other[key])
        // Summary telemetry is an object, so a body/tool kind change must not be
        // treated as an unchanged part.
        && JSON.stringify(part.kinds) === JSON.stringify(other.kinds)
        // Inlined tool images and the omission notice are projected objects; an
        // unchanged payload must not force a re-render, a changed one must.
        && sameToolImage(part.image, other.image)
        && (part.imageOmitted === true) === (other.imageOmitted === true);
    });
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
  function questionOptionId(recordId, index) { return 'question-' + recordId + '-option-' + index; }
  function createQuestionCard(record) {
    const element = document.createElement('article');
    element.className = 'approval-card question-card';
    element.dataset.kind = 'question'; element.dataset.status = 'pending';
    const icon = document.createElement('span'); icon.className = 'approval-icon'; icon.textContent = '?'; icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong'); title.textContent = t('向用户提问');
    const target = document.createElement('span'); target.className = 'approval-target';
    target.textContent = String(record.question || '').split(/\r?\n/, 1)[0]; target.title = record.question || '';
    const status = document.createElement('span'); status.className = 'approval-status'; status.setAttribute('role', 'status'); status.textContent = t('等待回答');
    const chevron = document.createElement('span'); chevron.className = 'approval-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
    const header = document.createElement('summary'); header.className = 'approval-header'; header.append(icon, title, target, status, chevron);
    const disclosure = document.createElement('details'); disclosure.className = 'approval-request'; disclosure.open = true;
    const content = document.createElement('div'); content.className = 'approval-content';
    const question = document.createElement('p'); question.className = 'approval-description question-text'; question.textContent = record.question || '';
    content.append(question);
    if (record.workerId) { const worker = document.createElement('p'); worker.className = 'approval-worker'; worker.textContent = t('来自并行任务'); content.append(worker); }
    const options = Array.isArray(record.options) ? record.options : [];
    const multiple = record.multiple === true;
    const fieldset = document.createElement('fieldset'); fieldset.className = 'question-options';
    const legend = document.createElement('legend'); legend.className = 'question-legend'; legend.textContent = t(multiple ? '请选择（可多选）' : '请选择一项');
    const inputs = [];
    fieldset.append(legend);
    for (const [index, option] of options.entries()) {
      const item = document.createElement('label'); item.className = 'question-option';
      const input = document.createElement('input'); input.type = multiple ? 'checkbox' : 'radio';
      input.name = 'question-' + record.id; input.value = option.label; input.id = questionOptionId(record.id, index);
      const body = document.createElement('span'); body.className = 'question-option-body';
      const label = document.createElement('span'); label.className = 'question-option-label'; label.textContent = option.label;
      body.append(label);
      if (option.description) { const description = document.createElement('span'); description.className = 'question-option-desc'; description.textContent = option.description; body.append(description); }
      item.append(input, body); fieldset.append(item); inputs.push(input);
    }
    content.append(fieldset);
    let custom;
    if (record.allowCustom !== false) {
      const wrapper = document.createElement('label'); wrapper.className = 'question-custom';
      const caption = document.createElement('span'); caption.className = 'question-custom-label'; caption.textContent = t('补充回答（可选）');
      custom = document.createElement('textarea'); custom.className = 'question-custom-input'; custom.rows = 2;
      custom.placeholder = t('也可以直接填写你的回答');
      custom.setAttribute('aria-label', t('补充回答（可选）'));
      wrapper.append(caption, custom); content.append(wrapper);
    }
    disclosure.append(header, content);
    const feedback = document.createElement('p'); feedback.className = 'approval-feedback'; feedback.hidden = true; feedback.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const hint = document.createElement('span'); hint.className = 'approval-scope'; hint.textContent = t('提交后本轮继续');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'approval-deny question-cancel'; cancel.textContent = t('跳过');
    const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'approval-allow question-submit'; submit.textContent = t('提交回答');
    actions.append(hint, cancel, submit);
    element.append(disclosure, feedback, actions);
    messages.append(element);
    const card = { element, disclosure, status, feedback, actions, cancel, submit, inputs, custom, sending: false };
    const setEnabled = enabled => {
      for (const input of inputs) input.disabled = !enabled;
      if (custom) custom.disabled = !enabled;
      cancel.disabled = submit.disabled = !enabled;
      element.toggleAttribute('aria-busy', !enabled && card.sending);
    };
    const send = (payload, pendingText) => {
      if (card.sending) return;
      card.sending = true; setEnabled(false);
      feedback.hidden = true; status.textContent = pendingText;
      request('answerQuestion', { questionId: record.id, ...payload }, () => {
        card.sending = false;
        element.removeAttribute('aria-busy');
        if (card.state === 'pending') status.textContent = t('已提交，等待同步');
      }, () => {
        card.sending = false; element.removeAttribute('aria-busy'); setEnabled(true);
        status.textContent = t('等待回答'); feedback.textContent = t('提交未完成，请重试。'); feedback.hidden = false;
      });
    };
    const collect = () => {
      const selected = inputs.filter(input => input.checked).map(input => input.value);
      const note = custom ? custom.value.trim() : '';
      return { selected, custom: note };
    };
    submit.addEventListener('click', () => {
      const { selected, custom: note } = collect();
      if (!selected.length && !note) { feedback.textContent = t('请选择至少一个选项，或填写一条回答。'); feedback.hidden = false; return; }
      send({ selected, custom: note }, t('正在提交…'));
    });
    cancel.addEventListener('click', () => send({ cancelled: true }, t('正在跳过…')));
    card.state = 'pending';
    card.markTerminal = () => { card.state = 'settled'; setEnabled(false); disclosure.open = false; actions.hidden = true; };
    return card;
  }
  function renderQuestions(view) {
    view.questions ??= new Map();
    const questions = Array.isArray(hostState?.humanQuestions) ? hostState.humanQuestions : [];
    const records = questions.filter(record => record.status === 'pending');
    const completed = new Set(questions.filter(record => ['answered', 'cancelled'].includes(record.status)).map(record => record.id));
    let changed = false;
    // An omitted record is not a decision: keep unresolved cards until the host
    // confirms a terminal status, mirroring tool approvals.
    for (const [id, card] of view.questions) if (completed.has(id)) {
      if (!card.sending) { card.element.remove(); view.questions.delete(id); changed = true; }
      else { card.markTerminal?.(); changed = true; }
    }
    for (const record of records) {
      if (view.questions.has(record.id)) continue;
      view.questions.set(record.id, createQuestionCard(record));
      changed = true;
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
  function sameImages(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((image, index) => image.id === b[index]?.id && image.uri === b[index]?.uri && image.name === b[index]?.name);
  }
  function setMessageImages(entry, images) {
    const list = Array.isArray(images) ? images.filter(image => image && typeof image.uri === 'string' && image.uri) : [];
    entry.images = list;
    if (!list.length) { entry.imagesElement?.remove(); entry.imagesElement = undefined; return; }
    if (!entry.imagesElement) {
      entry.imagesElement = document.createElement('div');
      entry.imagesElement.className = 'message-images';
      entry.article.insertBefore(entry.imagesElement, entry.body);
    }
    entry.imagesElement.replaceChildren(...list.map(image => {
      const figure = document.createElement('figure'); figure.className = 'message-image';
      const preview = document.createElement('img');
      preview.src = image.uri; preview.alt = image.name || '图片'; preview.title = image.name || '图片';
      preview.loading = 'lazy'; preview.decoding = 'async';
      const caption = document.createElement('figcaption'); caption.textContent = image.name || '图片';
      figure.append(preview, caption);
      return figure;
    }));
  }
  // Completed assistant replies get a quiet copy action; it stays hidden until
  // the message is hovered or focused, so the reading surface stays calm.
  function addMessageCopy(entry) {
    if (entry?.copy && !entry.copy.isConnected) entry.copy = undefined;
    if (!entry || entry.copy || entry.role !== 'assistant' || typeof entry.text !== 'string' || !entry.text.trim()) return;
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'message-copy';
    copy.title = t('复制回复'); copy.setAttribute('aria-label', t('复制回复'));
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
    copy.addEventListener('click', () => {
      const text = entry.text;
      if (typeof text !== 'string' || !text.trim()) return;
      try {
        Promise.resolve(messageActions.onCopy(text)).then(() => {
          copy.classList.add('is-copied');
          copy.title = t('已复制'); copy.setAttribute('aria-label', t('已复制'));
          clearTimeout(copy.feedbackTimer);
          copy.feedbackTimer = setTimeout(() => {
            copy.classList.remove('is-copied');
            copy.title = t('复制回复'); copy.setAttribute('aria-label', t('复制回复'));
          }, 1400);
        }).catch(() => {});
      } catch { /* callback failure is surfaced by the view */ }
    });
    entry.copy = copy;
    entry.heading.append(copy);
  }
  function createMessageEntry(role, text, parts, streaming = false, images = []) {
    const article = document.createElement('article');
    article.className = 'message ' + role + (streaming ? ' streaming-message' : '');
    if (streaming) article.dataset.streaming = 'true';
    const heading = document.createElement('div');
    heading.className = 'message-heading';
    heading.textContent = role === 'user' ? '你' : 'UBOVM';
    const body = document.createElement('div');
    body.className = 'message-text';
    window.UBOVMMessage.update(body, text, { ...messageActions, role, parts, streaming, preserveBody: !streaming });
    const entry = { article, heading, body, role, text, parts, images: [] };
    article.append(heading, body);
    if (!streaming) addMessageCopy(entry);
    setMessageImages(entry, images);
    return entry;
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
  function mountHistoryEntry(item, view, progressive = false) {
    const parts = item.role === 'assistant' ? visibleTimelineParts(item.parts) : item.parts;
    const hydrate = progressive && Array.isArray(parts) && parts.length > 1;
    const entry = createMessageEntry(item.role, item.text, hydrate ? parts.slice(0, 1) : parts, false, item.images);
    entry.key = messageHistoryKey(item);
    decorateHistoryEntry(entry, item);
    if (entry.role === 'assistant' && typeof entry.messageId === 'string' && entry.messageId.startsWith('assist:')) {
      entry.changes = document.createElement('section');
      entry.article.appendChild(entry.changes);
      const turnId = entry.messageId.slice(7);
      window.UBOVMCodeChanges.update(entry.changes, hostState?.codeChanges?.[turnId], {
        turnId, busy, usage: item.usage, onAction: (action, payload) => new Promise((resolve, reject) => {
          if (!entry.changes.isConnected || view.sessionId !== currentSessionId) { reject(new Error('会话已切换，请返回原会话操作。')); return; }
          if (!request(action, payload, resolve, reject)) reject(new Error('操作未发送，请稍后重试。'));
        })
      });
    }
    if (hydrate) queueHistoryHydration(view, entry, parts);
    return entry;
  }
  function flashHistoryBatch(entries) {
    if (reducedMotion.matches) return;
    for (const entry of entries) {
      entry.article.classList.add('history-enter');
      // The class is one-shot: drop it after the fade so it can never revive on a
      // later retained-node reconcile.
      entry.article.addEventListener('animationend', () => {
        entry.article.classList.remove('history-enter');
      }, { once: true });
    }
  }
  function scheduleHistoryFill() {
    if (historyFillFrame || pageHidden()) return;
    const wait = interactingUntil - performance.now();
    if (wait > 0) {
      if (!historyInteractionTimer) historyInteractionTimer = setTimeout(() => {
        historyInteractionTimer = 0;
        scheduleHistoryFill();
      }, Math.min(250, wait + 20));
      return;
    }
    historyFillFrame = requestAnimationFrame(runHistoryFillFrame);
  }
  // Advance exactly one visible shell by one part per frame. The expensive part of
  // the old first paint was the browser laying out several tool cards in the same
  // frame; adding one card per frame keeps every frame short (measured: one part per
  // frame never crosses the long-task threshold). Shells are advanced round-robin so
  // the newest turns fill in order and none is left stranded.
  function hydrateHistoryFrame(view) {
    const queue = view.hydration;
    if (!queue?.length) return false;
    while (queue.length) {
      const entry = queue.shift();
      if (!entry.article.isConnected) { finishHistoryHydration(entry); continue; }
      const parts = entry.pendingParts;
      if (!parts || entry.hydrated >= parts.length) { finishHistoryHydration(entry); continue; }
      entry.hydrated++;
      const prefix = parts.slice(0, entry.hydrated);
      window.UBOVMMessage.update(entry.body, entry.text, { ...messageActions, role: entry.role, parts: prefix, streaming: false, preserveBody: true });
      entry.parts = prefix;
      if (entry.hydrated < parts.length) queue.push(entry);
      else finishHistoryHydration(entry);
      return true;
    }
    return false;
  }
  // Frame scheduler for the progressive history: visible-shell hydration first, then
  // time-budgeted backfill of older messages. Always makes progress (>=1 part and/or
  // >=1 message) and stops once both queues are empty. Replaces the fixed
  // HISTORY_BATCH=8 batches whose tool-rich Markdown caused ~56 ms long tasks.
  function runHistoryFillFrame() {
    historyFillFrame = 0;
    if (pageHidden() || hostState?.mode === 'goal') return;
    const view = messageViews.get(messages);
    if (!view || view.sessionId !== currentSessionId) return;
    if (view.capped && !view.hydration?.length) return;
    const fillPending = view.historyStart > 0 && Array.isArray(view.history);
    if (!fillPending && !view.hydration?.length) return;
    const started = performance.now();
    const hydrated = hydrateHistoryFrame(view);
    const scroller = conversation;
    const position = scrollPositions.get(scroller);
    // Hydration grows the visible newest messages downwards. A following reader must
    // be re-pinned before the fill's own "near the bottom" test, otherwise the grown
    // hint/parts would make the fill think the reader scrolled away and stop following.
    if (hydrated && position.following) {
      scroller.scrollTop = scroller.scrollHeight;
      position.top = scroller.scrollTop;
    }
    let complete = false;
    if (fillPending) {
      // Use the scroll tracker's following bit instead of probing scrollHeight
      // twice before every insertion. At large DOM sizes each read forces a full
      // list layout; the tracker already detects the <2px bottom state.
      let following = position.following;
      const previousHeight = following ? 0 : scroller.scrollHeight;
      const previousTop = following ? 0 : scroller.scrollTop;
      const fillStarted = performance.now();
      const fillBudget = Math.max(1, HISTORY_FRAME_BUDGET_MS - (fillStarted - started));
      const added = [];
      let cursor = view.historyStart;
      const limit = view.historyLimit ?? HISTORY_MAX_MOUNTED;
      while (cursor > 0 && view.entries.length + added.length < limit) {
        // The budget only bounds JS work if it is checked before the next mount;
        // always mounting one more entry can turn a 6 ms budget into a long task.
        if (added.length && performance.now() - fillStarted >= fillBudget) break;
        const item = view.history[cursor - 1];
        const heavy = (typeof item.text === 'string' && item.text.length > 40000)
          || (item.parts || []).some(part => (typeof part.output === 'string' && part.output.length > 40000)
            || (typeof part.text === 'string' && part.text.length > 40000));
        added.push(mountHistoryEntry(item, view, heavy));
        cursor--;
      }
      const anchor = view.entries[0]?.article || view.stream?.article || null;
      const fragment = document.createDocumentFragment();
      for (let index = added.length - 1; index >= 0; index--) fragment.appendChild(added[index].article);
      messages.insertBefore(fragment, anchor);
      added.reverse();
      flashHistoryBatch(added);
      view.entries = added.concat(view.entries);
      view.historyStart = cursor;
      complete = cursor === 0;
      view.capped = !complete && view.entries.length >= limit;
      // The indicator sits above every entry, so its removal is part of the inserted
      // height delta that keeps a reader who scrolled up visually anchored.
      if (complete) setHistoryLoading(false);
      else if (view.capped) setHistoryLoading(true, true, view.entries.length);
      else setHistoryLoading(true);
      if (!following) {
        // Probe only after the insertion; this is the single geometry read the
        // anchor correction genuinely needs.
        scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
        position.top = scroller.scrollTop;
      } else {
        scroller.scrollTop = scroller.scrollHeight;
        position.top = scroller.scrollTop;
        position.following = true;
      }
      // The outline is expensive to rebuild per batch; coalesce it while the fill runs
      // and always do one final identical rebuild when all entries are mounted.
      const now = performance.now();
      if (complete || now - historyOutlineAt >= HISTORY_OUTLINE_INTERVAL_MS) {
        historyOutlineAt = now;
        try { renderConversationOutline(); } catch { /* Outline can catch up on the next full paint. */ }
      }
    } else if (hydrated && position.following) {
      // Hydration grows the newest messages; a following reader stays pinned.
      scroller.scrollTop = scroller.scrollHeight;
      position.top = scroller.scrollTop;
    }
    // While older history is still filling the latest button cannot be visible
    // for a following reader; defer its layout read until the fill settles.
    if (!view.historyStart && !view.hydration?.length) refreshLatest();
    if ((view.historyStart > 0 && !view.capped) || view.hydration?.length) scheduleHistoryFill();
  }
  let pendingImageKey = '';
  function renderPendingImages() {
    const container = byId('composer-images');
    if (!container) return;
    const images = Array.isArray(hostState?.pendingImages) ? hostState.pendingImages : [];
    const key = JSON.stringify(images.map(image => [image.id, image.uri]));
    if (key === pendingImageKey) return;
    pendingImageKey = key;
    container.replaceChildren();
    container.hidden = !images.length;
    for (const image of images) {
      const figure = document.createElement('figure'); figure.className = 'composer-image';
      const preview = document.createElement('img');
      preview.src = image.uri || ''; preview.alt = image.name || '待发送图片'; preview.loading = 'lazy'; preview.decoding = 'async';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'composer-image-remove'; remove.dataset.imageId = image.id;
      remove.title = '移除图片'; remove.setAttribute('aria-label', '移除图片 ' + (image.name || ''));
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      const caption = document.createElement('figcaption'); caption.textContent = image.name || '图片';
      figure.append(preview, remove, caption);
      container.append(figure);
    }
  }
  // Full state resends the whole history array even when only execution metadata
  // changed. A cheap structural fingerprint lets a long conversation keep its
  // already-mounted DOM instead of reconciling every message on each state tick.
  function historySignature(items) {
    const rows = [];
    for (const item of items) {
      const parts = item.parts || [];
      rows.push([item.role, item.id || '', typeof item.text === 'string' ? item.text.length : 0, item.steeringStatus || '',
        item.images?.length || 0, parts.length,
        parts.map(part => [part.id, part.type, part.status, typeof part.text === 'string' ? part.text.length : 0,
          typeof part.output === 'string' ? part.output.length : 0,
          part.image ? 1 : 0, typeof part.image?.data === 'string' ? part.image.data.length : 0,
          part.imageOmitted === true ? 1 : 0].join(':')).join('|')].join('\u0001'));
    }
    return rows.join('\u0002');
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
    const shouldScroll = forceScroll || !showingConversation || position.following;
    forceScroll = false;
    if (view?.sessionId !== currentSessionId) {
      cancelHistoryFill();
      historyOutlineAt = 0;
      setHistoryLoading(false);
      container.replaceChildren();
      view = { sessionId: currentSessionId, entries: [], stream: null, busy: undefined, historyStart: 0, hydration: [], historyLimit: HISTORY_MAX_MOUNTED, capped: false };
      messageViews.set(container, view);
    }
    // Long histories mount only the newest messages on the first frame so the page
    // skeleton can clear before the expensive Markdown/tool-card work. Short
    // conversations keep the full synchronous paint. Same-session history edits
    // keep the full reconcile.
    const progressive = historyChanged && view.entries.length === 0 && safeMessages.length > HISTORY_PROGRESSIVE_MIN;
    const paintStart = progressive ? safeMessages.length - HISTORY_SYNC_COUNT : 0;
    const signature = historyChanged ? historySignature(safeMessages) : view.signature;
    const historyStable = historyChanged && view.signature === signature
      && view.entries.length + view.historyStart === safeMessages.length;
    let changed = view.busy !== busy || view.entries.length !== safeMessages.length - paintStart;
    // Keep published history in place while only the transient reply grows.
    // Reading selections, focus, and scroll anchors survive token updates.
    if (historyChanged && !historyStable) {
      cancelHistoryFill();
      // A full reconcile renders every part synchronously, so queued incremental
      // hydration would re-render an already-complete body: drop it first.
      clearHistoryHydration(view);
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
          addMessageCopy(entry);
          changed = true;
        } else if (!entry) {
          // Progressive first paint mounts cheap shells (first visible part) and
          // hydrates the remaining parts on later frames; everything else keeps the
          // single synchronous mount.
          entry = progressive ? mountHistoryEntry(item, view, true) : createMessageEntry(item.role, item.text, parts, false, item.images);
          changed = true;
        } else if (entry.role !== item.role || entry.text !== item.text || !sameParts(entry.parts, parts) || !sameImages(entry.images, item.images)) {
          entry.article.className = 'message ' + item.role;
          setText(entry.heading, item.role === 'user' ? '你' : 'UBOVM');
          entry.steeringStatus = undefined;
          window.UBOVMMessage.update(entry.body, item.text, { ...messageActions, role: item.role, parts, streaming: false, preserveBody: true });
          setMessageImages(entry, item.images);
          entry.role = item.role; entry.text = item.text; entry.parts = parts;
          addMessageCopy(entry);
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
      view.signature = signature;
      if (paintStart > 0) setHistoryLoading(true);
      else setHistoryLoading(false);
      if (paintStart > 0 || view.hydration.length) scheduleHistoryFill();
    } else if (historyStable) {
      // Same messages, only execution metadata changed: do not rescan or
      // re-serialize parts. Keep the published array for the next identity check.
      view.source = items;
      if ((view.historyStart > 0 || view.hydration?.length) && !pageHidden() && hostState?.mode !== 'goal') scheduleHistoryFill();
    } else if ((view.historyStart > 0 || view.hydration?.length) && !pageHidden() && hostState?.mode !== 'goal') {
      // A hidden/aborted paint cancels the pending fill frame; resume it on the next
      // committed render instead of leaving older history permanently missing.
      scheduleHistoryFill();
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
      if (!busy) addMessageCopy(view.stream);
    } else if (view.stream) {
      window.UBOVMMessage.release(view.stream.body);
      view.stream.article.remove(); view.stream = null;
      changed = true;
    }
    // Turn snapshots are supplied by the host, never inferred from model prose.
    const usageSig = window.UBOVMCodeChanges?.usageSignature?.(execution.usage) || '';
    const turnUsage = (turnId, messageUsage) => messageUsage ?? (execution.runId === turnId ? execution.usage : undefined);
    const updateChanges = (root, turnId, messageUsage) => window.UBOVMCodeChanges.update(root, hostState?.codeChanges?.[turnId], {
      turnId, busy, usage: turnUsage(turnId, messageUsage), onAction: (action, payload) => new Promise((resolve, reject) => {
        if (!root.isConnected || view.sessionId !== currentSessionId) { reject(new Error('会话已切换，请返回原会话操作。')); return; }
        if (!request(action, payload, resolve, reject)) reject(new Error('操作未发送，请稍后重试。'));
      })
    });
    // Execution-only snapshots retain host-owned history and file summaries.
    // Avoid serializing every completed turn's file list for each new token.
    // Busy changes still refresh undo availability; failed renders never cache.
    // Usage object identity churns on every publish; compare a stable fingerprint
    // and refresh only the live turn when that alone changes.
    const historyOffset = view.historyStart || 0;
    const refreshAllCards = historyChanged || view.busy !== busy || view.codeChanges !== hostState?.codeChanges;
    const usageOnly = !refreshAllCards && view.usageSignature !== usageSig;
    if (refreshAllCards) {
      for (const [index, entry] of view.entries.entries()) {
        const message = safeMessages[historyOffset + index];
        const id = entry.messageId || message?.id;
        if (entry.role !== 'assistant' || !id?.startsWith('assist:')) continue;
        if (!entry.changes) { entry.changes = document.createElement('section'); entry.article.appendChild(entry.changes); changed = true; }
        changed = updateChanges(entry.changes, id.slice(7), message?.usage) || changed;
      }
      view.codeChanges = hostState?.codeChanges;
      view.usageSignature = usageSig;
    } else if (usageOnly && execution.runId) {
      const liveId = 'assist:' + execution.runId;
      let liveIndex = -1;
      for (let index = 0; index < view.entries.length; index++) {
        const id = view.entries[index].messageId || safeMessages[historyOffset + index]?.id;
        if (id === liveId) { liveIndex = index; break; }
      }
      if (liveIndex >= 0 && view.entries[liveIndex].changes) {
        changed = updateChanges(view.entries[liveIndex].changes, execution.runId, safeMessages[historyOffset + liveIndex]?.usage) || changed;
      } else if (view.changeSummary) changed = updateChanges(view.changeSummary, execution.runId) || changed;
      view.usageSignature = usageSig;
    }
    const unfinishedChanges = !busy && execution.runId && (hostState?.codeChanges?.[execution.runId] || usageSig)
      && !safeMessages.some(item => item.id === 'assist:' + execution.runId);
    if (unfinishedChanges) {
      if (!view.changeSummary) { view.changeSummary = document.createElement('section'); container.appendChild(view.changeSummary); changed = true; }
      changed = updateChanges(view.changeSummary, execution.runId) || changed;
    } else if (view.changeSummary) { view.changeSummary.remove(); view.changeSummary = undefined; changed = true; }
    changed = renderApprovals(view) || changed;
    changed = renderQuestions(view) || changed;
    view.busy = busy;
    view.source = items; view.history = safeMessages; view.firstPartId = firstPartId; view.represented = represented;
    showConversation(safeMessages.length > 0 || hasLive || busy || Boolean(execution.error) || execution.canResume === true || execution.workers?.length > 0 || view.approvals.size > 0 || view.questions.size > 0);
    refreshLatest();
    if (!changed) return;
    cancelScroll();
    if (shouldScroll) {
      // Pin in the same task that mutated the DOM. Deferring to requestAnimationFrame
      // left one painted frame at the previous scrollHeight, so streamed growth made
      // the scrollbar thumb bounce up and back down on every update.
      scroller.scrollTop = scroller.scrollHeight;
      position.top = scroller.scrollTop;
      position.following = true;
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
    // The "对话" button reveals the native right-sidebar view; it is only
    // meaningful in goal mode with a saved goal (renderGoal hides it otherwise).
    byId('goal-chat-toggle').hidden = !goalMode;
    renderGoalChatToggle();
    if (!goalMode) { byId('goal-view-switcher').open = false; byId('goal-header-more').open = false; }
    byId('open-browser').hidden = goalMode;
    byId('validate-code-changes').hidden = goalMode;
    byId('review-code-changes').hidden = goalMode;
    byId('assist-notes-toggle').hidden = goalMode;
    // Secondary assist actions share one overflow menu; the goal header keeps its
    // own menu, so the assist one must not linger over the exploration workspace.
    byId('assist-more').hidden = goalMode;
    if (goalMode) byId('assist-more').open = false;
    // The Team panel belongs to the assist Lead conversation; a mode switch must
    // not leave a stale popover or a watched teammate floating over the goal
    // workspace.
    if (goalMode) { teamPanel.close(); closeTeamMember({ restoreFocus: false }); }
    renderModuleActions();
    updateInput();
  }
  // Route/session transitions can leave the primary surface hidden in two ways:
  // a stale expanded worker-panel class after the panel closed, or a render that
  // committed before the mode sections were revealed. Repair only the invariant;
  // never force a specific page the user did not choose.
  function repairPrimarySurface({ repaint = false } = {}) {
    let repaired = false;
    const shell = document.querySelector('.shell');
    if (shell?.classList.contains('worker-panel-expanded')) {
      const panel = byId('worker-panel');
      const panelVisible = panel && !panel.hidden && getComputedStyle(panel).display !== 'none';
      if (!panelVisible) { shell.classList.remove('worker-panel-expanded'); repaired = true; }
    }
    if (!hostState) return repaired;
    if (byId('assist-mode').hidden && byId('goal-mode').hidden) { renderMode(); repaired = true; }
    if (repaired && repaint) scheduleRender();
    return repaired;
  }
  function renderModuleActions() {
    const goalMode = hostState?.mode === 'goal';
    const editing = workspaceMissing() || !hostState?.goal || draftFor().goalEditing && !busy;
    const view = goalMode && !editing ? draftFor().view : '';
    setProperty(byId('goal-edit'), 'hidden', view !== 'overview');
    setProperty(byId('goal-board-actions'), 'hidden', view !== 'board');
    setProperty(byId('goal-notes-actions'), 'hidden', goalMode ? view !== 'notes' : draftFor().view !== 'notes');
    setProperty(byId('note-new'), 'hidden', false);
  }
  function renderGoalView() {
    renderModuleActions();
    const selected = draftFor().view;
    const label = { overview: '概览', agenda: '议程', board: '黑板', workers: '任务', notes: '笔记' }[selected];
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
    if (view === 'workers') {
      // The operator has now seen the failed/interrupted intents in Tasks; do not
      // keep repeating the same overview warning for this exact failure set.
      acknowledgedFailedWarnings.set(currentSessionId, failedWarningSignature(goalSignalData()));
      goalSignalsKey = '';
    }
    persistDrafts();
    // A route change must synchronize the outer mode and workspace as well as
    // the tab. Partial execution renders can otherwise retain a hidden ancestor.
    pendingViewRestore = { sessionId: currentSessionId, view };
    // Rapid clicks during an in-flight transition must not start competing
    // transitions: the pending full paint already renders whatever view is
    // selected when it runs, so this click only needs to become the latest
    // intent. Starting another transition per click would re-arm the mask and
    // cancellation path and can leave the page on an older intent.
    if (routePending) { scheduleRender(); return; }
    beginPageTransition('正在打开' + ({ overview: '思考日志', agenda: '议程', board: '黑板', workers: '任务', notes: '笔记' }[view]) + '…',
      view === 'board' ? 'route' : 'view');
    scheduleRender();
  }
  function restoreFields() {
    const draft = draftFor();
    input.value = draft.assist;
    renderPastes();
    resetHistoryRecall();
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
    const visible = Array.isArray(notes) ? notes : [];
    const serialized = JSON.stringify(visible);
    if (serialized === lastNotes) { lastNotesSource = notes; return; }
    lastNotesSource = undefined;
    lastNotes = '';
    renderNoteList(byId('goal-notes-list'), [...visible].reverse(), 'user');
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
    return { id: typeof note.id === 'string' ? note.id : '', text, createdAt, key: source + ':' + (note.id ?? JSON.stringify([createdAt, text])) };
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
    noteEntries.set(article, { key, id: entry.id, text, createdAt, searchText: text.toLocaleLowerCase(), source, date: time.textContent });
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
    byId('note-edit').hidden = !entry?.id;
    byId('note-edit').disabled = !entry?.id;
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
    editingNote = null;
    persistDrafts();
  }
  function filterNotes() {
    const query = byId('notes-search').value.trim().toLocaleLowerCase();
    // Assist mode has no source filter controls; always show both user and
    // Agent notes there instead of inheriting a stale goal-mode filter.
    const effectiveSource = hostState?.mode === 'goal' ? noteSource : 'all';
    let total = 0, shown = 0;
    for (const [source, listId, sectionId] of [['user', 'goal-notes-list', 'user-notes-section'], ['agent', 'agent-notes-list', 'agent-notes-section']]) {
      const entries = [...byId(listId).children];
      let visible = 0;
      for (const entry of entries) {
        entry.hidden = (effectiveSource !== 'all' && effectiveSource !== source) || !noteEntries.get(entry).searchText.includes(query);
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
  function renderAgenda(agenda) {
    const items = Array.isArray(agenda?.items) ? agenda.items : [];
    renderSection('agenda', [items, agenda?.counts], () => {
      const list = byId('goal-agenda-list');
      const empty = items.length === 0;
      byId('goal-agenda-empty').hidden = !empty;
      list.hidden = empty;
      const counts = agenda?.counts || {};
      const openCount = (counts.planned || 0) + (counts.active || 0) + (counts.blocked || 0);
      setText(byId('goal-agenda-summary'), empty ? '还没有探索议程' : `${counts.planned || 0} 待查 · ${counts.active || 0} 在查 · ${counts.blocked || 0} 受阻 · ${counts.done || 0} 已确认`);
      setText(byId('goal-nav-agenda'), String(openCount));
      const groups = [
        { key: 'active', label: '进行中', filter: item => item.status === 'active' },
        { key: 'planned', label: '待查', filter: item => item.status === 'planned' },
        { key: 'blocked', label: '受阻 / 建议换方法', filter: item => item.status === 'blocked' },
        { key: 'done', label: '最近确认', filter: item => item.status === 'done' },
        { key: 'dropped', label: '最近放弃', filter: item => item.status === 'dropped' }
      ];
      list.replaceChildren(...groups.flatMap(group => {
        const rows = items.filter(group.filter);
        if (!rows.length) return [];
        const section = document.createElement('section');
        section.className = 'goal-agenda-group';
        section.dataset.group = group.key;
        const heading = document.createElement('h3');
        heading.className = 'goal-agenda-group-heading';
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(rows.length);
        heading.append(group.label, count);
        section.append(heading, ...rows.map(item => {
          const row = document.createElement('article');
          row.className = 'goal-agenda-row';
          row.dataset.status = item.status;
          row.dataset.kind = item.kind || 'intent';
          const chip = document.createElement('span');
          chip.className = 'goal-agenda-chip';
          chip.textContent = item.kind === 'suggestion' ? '建议' : ({ planned: '待查', active: '在查', blocked: '受阻', done: '已确认', dropped: '已放弃' }[item.status] || item.status);
          const main = document.createElement('div');
          main.className = 'goal-agenda-main';
          const title = document.createElement('p');
          title.className = 'goal-agenda-title';
          title.textContent = item.title;
          const meta = document.createElement('div');
          meta.className = 'goal-agenda-meta';
          const kind = ({ intent: '意图', direction: '方向', suggestion: '建议' })[item.kind] || '条目';
          // The node/evidence alias is already shown on the right edge; do not
          // repeat it in the subtitle.
          const bits = [kind];
          if (item.method) bits.push('方法：' + item.method);
          if (item.acceptance) bits.push('验收：' + item.acceptance);
          bits.forEach((bit, index) => {
            if (index) { const sep = document.createElement('span'); sep.className = 'goal-agenda-sep'; sep.textContent = '·'; meta.append(sep); }
            const span = document.createElement('span');
            span.textContent = bit;
            meta.append(span);
          });
          if (item.blocker) {
            const blocker = document.createElement('span');
            blocker.className = 'goal-agenda-blocker';
            blocker.textContent = '· ' + item.blocker;
            meta.append(blocker);
          }
          main.append(title, meta);
          const steps = Array.isArray(item.planSteps) ? item.planSteps : [];
          if (steps.length) {
            const stepList = document.createElement('div');
            stepList.className = 'goal-agenda-steps';
            steps.forEach((step, index) => {
              const span = document.createElement('span');
              span.className = 'goal-agenda-step';
              span.textContent = (index === 0 && item.status === 'active' ? '▸ ' : '') + step;
              if (index === 0 && item.status === 'active') span.dataset.current = 'true';
              stepList.append(span);
            });
            main.append(stepList);
          }
          const key = document.createElement('span');
          key.className = 'goal-agenda-key';
          key.textContent = item.evidenceRef || item.ref || '';
          key.hidden = !key.textContent;
          if (key.textContent) {
            key.title = '关联证据：' + key.textContent;
            key.setAttribute('aria-label', '关联证据：' + key.textContent);
          }
          row.append(chip, main, key);
          return row;
        }));
        return [section];
      }));
    });
  }
  function renderGraphStatus(graph) {
    const badge = byId('goal-graph-status');
    if (!graph || !Number.isInteger(graph.nodes) || graph.nodes <= 0) { badge.hidden = true; badge.textContent = ''; return; }
    const detail = graph.truncated ? '截断' : graph.detail === 'full' ? '完整' : graph.detail === 'summary' ? '摘要' : '仅拓扑';
    badge.hidden = false;
    setText(badge, `图${detail} · ${graph.nodes} 节点`);
    setAttribute(badge, 'title', graph.truncated
      ? `图已按长程预算截断：仅展示可行动分支与最近节点（列出 ${graph.listedNodes ?? '?'} / ${graph.nodes}）；完整图仍可用 exploration_graph 查询`
      : `图完整度：${detail}；${graph.nodes} 个节点、${graph.edges} 条边、${graph.omittedFacts || 0} 个事实正文按需读取`);
    if (badge.dataset.detail !== graph.detail) badge.dataset.detail = graph.detail;
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
  let blackboardGraph, goalExecutionLog, lastBoardSnapshot, lastBoardConversation;
  // A restored or older exploration can be opened before the backend has loaded
  // its checkpoint; the host then publishes an execution snapshot without a
  // board. Ask for one authoritative read per session instead of leaving a
  // silently empty blackboard where manual refresh may race the restore again.
  let missingBoardRequest = { session: '', at: 0, pending: false };
  function boardExecutionFailure() {
    const error = hostState?.execution?.error;
    if (!error) return '';
    const message = typeof error === 'string' ? error : error.message;
    return typeof message === 'string' ? message : '';
  }
  function requestMissingBoard(snapshot, nodes) {
    if (nodes.length) { missingBoardRequest.pending = false; return; }
    // A published board (even an empty one) is authoritative; only a completely
    // absent projection means the host has nothing to paint yet.
    if (snapshot) { missingBoardRequest.pending = false; return; }
    // A previous board for the same conversation is authoritative until the next
    // publication; do not turn a transient light projection into a request loop.
    if (lastBoardSnapshot && lastBoardConversation === hostState?.conversation?.id) return;
    if (!hostState?.goal || workspaceMissing()) return;
    const execution = hostState?.execution || {};
    // Only a session that already produced work can have a blackboard. A fresh
    // run that has not emitted a single part/worker yet is not a missed board.
    const hasRun = Boolean(boardExecutionFailure())
      || ['completed', 'failed', 'interrupted'].includes(execution.status)
      || (execution.status === 'running' && Boolean(execution.parts?.length || execution.activities?.length || execution.workers?.length));
    if (!hasRun) return;
    const now = Date.now();
    if (missingBoardRequest.session === currentSessionId && now - missingBoardRequest.at < 3000) return;
    missingBoardRequest = { session: currentSessionId, at: now, pending: true };
    vscode.postMessage({ action: 'refreshBlackboard', sessionId: currentSessionId });
  }
  function renderBlackboard(snapshot, completion) {
    // A light/partial state may omit the board for one publication. Keep the
    // last complete board for the same conversation instead of clearing the
    // graph and making nodes blink.
    if (snapshot) { lastBoardSnapshot = snapshot; lastBoardConversation = hostState?.conversation?.id; }
    else if (lastBoardConversation === hostState?.conversation?.id) snapshot = lastBoardSnapshot;
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const evidenceIds = completion?.complete === true && Array.isArray(completion.evidenceIds) ? completion.evidenceIds : [];
    requestMissingBoard(snapshot, nodes);
    const failure = boardExecutionFailure();
    const hint = byId('blackboard-empty-hint');
    if (hint) {
      const next = failure
        ? t('黑板读取失败：{0} 点击刷新重试；若仍无内容，请重新打开会话。', failure.slice(0, 240))
        : missingBoardRequest.pending && nodes.length === 0
          ? t('正在重新读取黑板记录…')
          : t('如果长时间没有内容，点击刷新重新读取。');
      if (hint.textContent !== next) hint.textContent = next;
    }
    renderSection('blackboard', [snapshot?.sessionId, snapshot?.revision, snapshot?.rootId, snapshot?.goal, nodes, evidenceIds], () => {
      byId('blackboard-empty').hidden = nodes.length > 0;
      byId('blackboard-nodes').hidden = nodes.length === 0;
      blackboardGraph ??= window.createBlackboardGraph(byId('blackboard-nodes'), { factText, statusText, actionsContainer: byId('goal-board-actions'), onRefresh: refreshBlackboardUi,
        onDetail: hostState?.nativeBlackboardSidebar ? (detail, reveal) => vscode.postMessage({ action: 'blackboardDetail', sessionId: currentSessionId, detail, reveal }) : undefined });
      blackboardGraph.update(evidenceIds.length && snapshot ? { ...snapshot, completionEvidenceIds: evidenceIds } : snapshot);
      byId('blackboard-revision').textContent = Number.isInteger(snapshot?.revision) ? '修订 ' + snapshot.revision : '等待执行';
    });
  }
  function renderAgentNotes(memory) {
    const session = String(hostState?.conversation?.id ?? '');
    if (lastAgentNotes.session !== session) lastAgentNotes = { session, notes: [] };
    // An omitted memory projection means the host had nothing new to send; keep
    // the last rendered notebook instead of treating absence as an empty list.
    if (!memory && lastAgentNotes.notes.length) return;
    const source = memory?.notes;
    const hidden = new Set(Array.isArray(hostState?.deletedAgentNotes) ? hostState.deletedAgentNotes : []);
    const edits = new Map((Array.isArray(hostState?.editedAgentNotes) ? hostState.editedAgentNotes : []).map(item => [item.id, item.text]));
    const notes = (Array.isArray(source) ? source : source && typeof source === 'object' ? Object.values(source) : [])
      .filter(note => note && (typeof note.content === 'string' || typeof note.text === 'string') && !(typeof note.id === 'string' && hidden.has(note.id)))
      .map(note => {
        const edited = typeof note.id === 'string' ? edits.get(note.id) : undefined;
        if (edited === undefined) return note;
        return typeof note.content === 'string' ? { ...note, content: edited } : { ...note, text: edited };
      });
    lastAgentNotes.notes = memory ? notes : lastAgentNotes.notes;
    renderSection('agent-notes', notes, () => {
      renderNoteList(byId('agent-notes-list'), [...notes].reverse(), 'agent');
      filterNotes();
    });
  }
  function renderExecution() {
    const execution = executionState();
    const shell = document.querySelector('.shell');
    if (shell && backgroundTasks.element.parentElement !== shell) shell.append(backgroundTasks.element);
    backgroundTasks.update(hostState, ['unresponsive', 'backend-disconnected'].includes(connectionStatus));
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
      mcp: Array.isArray(middleware.mcp) ? mcpIntegration(middleware.mcp) : undefined,
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
      let count = 0;
      // The log is one panel of the overview: a render bug there must never blank
      // the whole goal workspace or prevent the rest of the page from painting.
      try { count = goalExecutionLog.update(currentSessionId, execution); }
      catch (error) { console.warn('[UBOVM] Goal execution log update failed', error); }
      setProperty(byId('goal-output-content'), 'hidden', !count);
      setProperty(byId('goal-log-bottom'), 'disabled', !count);
      setProperty(byId('goal-output-empty'), 'hidden', count > 0);
      setText(byId('goal-output-empty'), busy ? '正在启动，执行日志将在事件产生后显示。' : '执行后，规划、任务派发和工具调用会按顺序显示在这里。');
      setText(byId('goal-output-title'), '思考与调度日志');
      setText(byId('goal-output-status'), label);
      setAttribute(byId('goal-output-status'), 'data-phase', status);
      setText(byId('goal-output-count'), count ? count + ' 条记录' : '');
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
  // Team panel is a read-only projection of the Lead conversation's roster and
  // shared task board; it is only available in assist mode.
  function renderTeam() {
    teamPanel.update(hostState?.mode === 'assist' ? executionState().team : undefined);
  }
  // Teammate conversation view: a live projection of `execution.teamWatch`.
  // Updates are incremental and a closed view ignores execution ticks entirely.
  function renderTeamMember() {
    teamMemberView.update(hostState?.mode === 'assist' ? executionState().teamWatch : undefined, currentSessionId);
  }
  function relativeAge(timestamp) {
    const ms = Math.max(0, Date.now() - timestamp);
    if (ms < 60_000) return t('{0} 秒前', Math.max(1, Math.floor(ms / 1000)));
    if (ms < 3_600_000) return t('{0} 分钟前', Math.floor(ms / 60_000));
    return t('{0} 小时前', Math.floor(ms / 3_600_000));
  }
  function goalSignalData() {
    const execution = hostState?.execution ?? {};
    const executionBoard = execution.blackboard;
    const board = executionBoard ?? (lastBoardConversation === hostState?.conversation?.id ? lastBoardSnapshot : undefined);
    const nodes = Array.isArray(board?.nodes) ? board.nodes.filter(Boolean) : [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const intentStatus = node => node?.intent?.status ?? node?.status ?? 'pending';
    const missingParent = node => (Array.isArray(node.parentIds) ? node.parentIds : []).some(id => !byId.has(id));
    const intents = nodes.filter(node => node.kind === 'intent');
    const facts = nodes.filter(node => node.kind === 'fact');
    const runningIntents = intents.filter(node => ['running', 'dispatched', 'claimed'].includes(intentStatus(node)));
    const pendingIntents = intents.filter(node => ['pending', 'ready', 'blocked'].includes(intentStatus(node)));
    const ready = pendingIntents.filter(node => intentStatus(node) === 'ready' || (intentStatus(node) === 'pending' && !missingParent(node)));
    const blocked = pendingIntents.filter(node => intentStatus(node) === 'blocked' || missingParent(node));
    const failed = intents.filter(node => ['failed', 'interrupted'].includes(intentStatus(node)));
    const issues = [];
    const seen = new Set();
    for (const node of nodes) {
      if (!node.id || seen.has(node.id)) issues.push('存在重复或缺失的节点 ID');
      seen.add(node.id);
      if (missingParent(node)) issues.push(`节点 ${node.id} 引用了不存在的父节点`);
      if (node.kind === 'intent' && intentStatus(node) === 'completed' && (!node.resultId || !byId.has(node.resultId))) issues.push(`已完成意图 ${node.id} 缺少结果事实`);
      if (node.kind === 'fact' && node.producerId && !byId.has(node.producerId)) issues.push(`事实 ${node.id} 的来源意图不存在`);
    }
    const times = [];
    const collect = value => { if (Number.isFinite(value)) times.push(value); };
    for (const part of Array.isArray(execution.parts) ? execution.parts : []) { collect(part?.startedAt); collect(part?.endedAt); }
    for (const worker of Array.isArray(execution.workers) ? execution.workers : []) { collect(worker?.createdAt); collect(worker?.startedAt); collect(worker?.finishedAt); }
    const activeWorkers = (Array.isArray(execution.workers) ? execution.workers : []).filter(worker => ['running', 'starting', 'provisioning'].includes(worker?.status)).length;
    return {
      nodes, facts, intents, failed,
      running: runningIntents.length + activeWorkers,
      ready: ready.length,
      blocked: blocked.length,
      issues: [...new Set(issues)],
      last: times.length ? Math.max(...times) : 0,
      busy: Boolean(execution.busy || hostState?.busy)
    };
  }
  function goalSummaryText(data) {
    const goal = hostState?.goal ?? {};
    const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
    const lines = [
      '探索摘要',
      '目标：' + (goal.objective || '未命名目标'),
      `事实 ${data.facts.length} · 意图 ${data.intents.length} · 运行 ${data.running} · 可开始 ${data.ready} · 阻塞 ${data.blocked} · 图异常 ${data.issues.length}`,
      '验收：' + criteria.filter(item => item.done).length + ' / ' + criteria.length,
      '最近活动：' + (data.last ? relativeAge(data.last) : '无')
    ];
    const interval = hostState?.execution?.autonomy?.reviewIntervalMs;
    if (Number.isFinite(interval)) lines.push('自动巡视：' + (interval > 0 ? Math.round(interval / 1000) + ' 秒/次' : '关闭'));
    const lastReview = hostState?.execution?.autonomy?.lastReviewAt;
    if (Number.isFinite(lastReview)) lines.push('上次自动巡视：' + relativeAge(lastReview));
    if (data.issues.length) lines.push('图校验：' + data.issues.slice(0, 8).join('；'));
    const recent = data.facts.slice(-5).map(node => {
      const content = String(node.fact?.content || node.fact?.statement || '').replace(/\s+/g, ' ').slice(0, 160);
      return '- ' + (content || node.id);
    });
    if (recent.length) lines.push('最近事实：', ...recent);
    return lines.join('\n');
  }
  let goalSignalsKey = '';
  let goalSignalTicker = 0;
  // Viewing the Tasks page acknowledges the current set of failed/interrupted
  // intents. A new failure produces a new signature and raises the warning again.
  const acknowledgedFailedWarnings = new Map();
  const failedWarningSignature = data => (Array.isArray(data?.failed) ? data.failed : [])
    .map(node => `${node?.id ?? ''}:${node?.intent?.status ?? node?.status ?? ''}:${node?.attempts?.at(-1)?.id ?? node?.attempts?.at(-1)?.startedAt ?? ''}`).sort().join('|');
  function syncGoalSignalTicker() {
    const active = hostState?.mode === 'goal' && Boolean(hostState?.execution?.busy || hostState?.busy);
    if (active && !goalSignalTicker) {
      goalSignalTicker = setInterval(() => {
        if (!pageHidden() && hostState?.mode === 'goal' && Boolean(hostState?.execution?.busy || hostState?.busy)) {
          goalSignalsKey = '';
          renderGoalSignals();
        }
      }, 30_000);
    } else if (!active && goalSignalTicker) {
      clearInterval(goalSignalTicker);
      goalSignalTicker = 0;
    }
  }
  function renderGoalSignals() {
    const strip = byId('goal-signals');
    if (!strip) return;
    const execution = hostState?.execution ?? {};
    const key = [
      hostState?.execution?.autonomy?.reviewIntervalMs,
      hostState?.execution?.autonomy?.lastReviewAt,
      hostState?.conversation?.id,
      hostState?.goal?.objective,
      execution.blackboard?.revision ?? (lastBoardConversation === hostState?.conversation?.id ? lastBoardSnapshot?.revision : undefined),
      Array.isArray(execution.blackboard?.nodes) ? execution.blackboard.nodes.length : (lastBoardConversation === hostState?.conversation?.id && Array.isArray(lastBoardSnapshot?.nodes) ? lastBoardSnapshot.nodes.length : 0),
      Array.isArray(execution.parts) ? execution.parts.length : 0,
      (Array.isArray(execution.workers) ? execution.workers : []).map(worker => [worker?.id, worker?.status, worker?.finishedAt].join(':')).join(','),
      Boolean(execution.busy || hostState?.busy)
    ].join('|');
    if (key === goalSignalsKey) return;
    goalSignalsKey = key;
    const data = goalSignalData();
    const board = execution.blackboard ?? (lastBoardConversation === hostState?.conversation?.id ? lastBoardSnapshot : undefined);
    const visible = Boolean(hostState?.goal) && (data.nodes.length > 0 || Boolean(board));
    setProperty(strip, 'hidden', !visible);
    const warning = byId('goal-signal-warning');
    if (!visible) { setProperty(warning, 'hidden', true); return; }
    setText(byId('goal-signal-facts'), String(data.facts.length));
    setText(byId('goal-signal-intents'), String(data.intents.length));
    setText(byId('goal-signal-running'), String(data.running));
    setText(byId('goal-signal-ready'), String(data.ready));
    setText(byId('goal-signal-blocked'), String(data.blocked));
    setText(byId('goal-signal-issues'), String(data.issues.length));
    setProperty(byId('goal-signal-blocked-wrap'), 'hidden', data.blocked === 0);
    setProperty(byId('goal-signal-issues-wrap'), 'hidden', data.issues.length === 0);
    const autonomy = hostState?.execution?.autonomy?.reviewIntervalMs;
    const autonomyEl = byId('goal-signal-autonomy');
    setProperty(autonomyEl, 'hidden', !Number.isFinite(autonomy));
    if (Number.isFinite(autonomy)) {
      setText(autonomyEl, autonomy > 0 ? t('自动巡视 {0}', autonomy >= 60000 ? Math.round(autonomy / 60000) + 'm' : Math.round(autonomy / 1000) + 's') : t('自动巡视关闭'));
      const lastReview = hostState?.execution?.autonomy?.lastReviewAt;
      setProperty(autonomyEl, 'title', autonomy > 0
        ? t('运行中每 {0} 秒自动唤醒 Reason 复盘；可在 系统配置 → 规划设置 调整，修改在下一次执行生效。', Math.round(autonomy / 1000)) + (Number.isFinite(lastReview) ? ' ' + t('上次自动巡视：{0}', relativeAge(lastReview)) : '')
        : t('自动巡视已关闭；仅完成/失败等执行事件会触发 Reason。'));
      setProperty(autonomyEl, 'aria-label', t('打开自动巡视设置'));
    }
    const last = byId('goal-signal-last');
    setText(last, data.last ? t('最近活动 {0}', relativeAge(data.last)) : '尚无活动');
    setProperty(last, 'title', data.last ? new Date(data.last).toLocaleString() : '');
    const warnings = [];
    if (data.busy && data.last && Date.now() - data.last > 10 * 60_000) warnings.push(t('已超过 {0} 分钟没有新活动，可能卡在长时间工具或等待确认。', Math.floor((Date.now() - data.last) / 60_000)));
    if (data.busy && autonomy === 0 && data.last && Date.now() - data.last > 5 * 60_000) warnings.push(t('自动巡视已关闭；长时间无进展时建议暂停后继续，或在规划设置中开启周期复盘。'));
    if (data.busy && data.failed.length) {
      const signature = failedWarningSignature(data);
      if (acknowledgedFailedWarnings.get(currentSessionId) !== signature) warnings.push(t('有 {0} 个失败/中断的意图，可在任务页查看。', data.failed.length));
    } else if (!data.failed.length) acknowledgedFailedWarnings.delete(currentSessionId);
    if (data.issues.length) warnings.push(t('图谱校验发现 {0} 项异常：{1}', data.issues.length, data.issues.slice(0, 2).join('；')));
    setProperty(warning, 'hidden', warnings.length === 0);
    setText(warning, warnings.join(' '));
  }
  /* Domain inventory ledger. `domain_inventory` is the exploration pipeline's
     coverage authority and is shipped inside execution.memory; the overview
     surfaces it so the operator can read the seed scope, every discovered host
     and how far testing has progressed without opening a tool card. */
  const DOMAIN_STATUS_LABELS = { pending: '待测', in_progress: '进行中', tested: '已测', skipped: '跳过', out_of_scope: '范围外' };
  const DOMAIN_STATUS_ORDER = ['in_progress', 'pending', 'tested', 'skipped', 'out_of_scope'];
  const DOMAIN_KIND_LABELS = { apex: '主域', subdomain: '子域', alias: '别名', ip_host: 'IP 主机' };
  const DOMAIN_DISCOVERY_LABELS = { seed: '种子', enum: '枚举', cert: '证书', dns: 'DNS', redirect: '跳转', manual: '手工' };
  const DOMAIN_ROW_LIMIT = 200;
  const DOMAIN_SEED_LIMIT = 6;
  let domainInventoryKey = '';
  let domainPanelSession = '';
  let domainPanelInitialized = false;
  function domainCoverageCounts(domains) {
    const counts = { pending: 0, in_progress: 0, tested: 0, skipped: 0, out_of_scope: 0 };
    for (const item of domains) if (counts[item?.test_status] !== undefined) counts[item.test_status] += 1;
    return counts;
  }
  function domainChip(label, count, status) {
    const chip = document.createElement('span');
    chip.className = 'goal-domain-chip';
    if (status) chip.dataset.status = status;
    chip.textContent = t(label) + ' ' + count;
    return chip;
  }
  function domainSeedChip(host) {
    const chip = document.createElement('span');
    chip.className = 'goal-domain-seed';
    chip.textContent = host;
    chip.title = host;
    return chip;
  }
  function renderDomainInventory() {
    const panel = byId('goal-domain-panel');
    if (!panel) return;
    const sessionKey = String(hostState?.conversation?.id ?? '');
    if (panel.dataset.session !== sessionKey) {
      panel.dataset.session = sessionKey;
      domainPanelSession = sessionKey;
      domainPanelInitialized = false;
      domainInventoryKey = '';
    }
    const inventory = hostState?.execution?.memory?.domainInventory;
    const seedRoots = Array.isArray(inventory?.seedRoots) ? inventory.seedRoots.filter(root => typeof root === 'string' && root) : [];
    const domains = Array.isArray(inventory?.domains)
      ? inventory.domains.filter(item => item && typeof item.hostname === 'string' && item.hostname)
      : [];
    const visible = seedRoots.length > 0 || domains.length > 0;
    setProperty(panel, 'hidden', !visible);
    if (!visible) {
      domainInventoryKey = '';
      panel.open = false;
      const list = byId('goal-domain-list');
      if (list?.childNodes.length) list.replaceChildren();
      return;
    }
    const key = [sessionKey, inventory?.revision ?? '', seedRoots.length, domains.length].join('|');
    if (key === domainInventoryKey) return;
    domainInventoryKey = key;
    const counts = domainCoverageCounts(domains);
    const closed = counts.tested + counts.skipped + counts.out_of_scope;
    const incomplete = counts.pending + counts.in_progress;
    const rate = domains.length ? closed / domains.length : 0;
    const percent = Math.round(rate * 100);
    setText(byId('goal-domain-scope'), seedRoots.length
      ? t('{0} 个种子域 · {1} 个主机', seedRoots.length, domains.length)
      : t('尚未登记种子域'));
    const coverage = byId('goal-domain-coverage');
    setProperty(coverage, 'hidden', domains.length === 0);
    setProperty(coverage.dataset, 'complete', String(domains.length > 0 && incomplete === 0));
    setText(coverage, t('已覆盖 {0}/{1}', closed, domains.length));
    setAttribute(coverage, 'title', t('覆盖率 {0}%', percent));
    const countsEl = byId('goal-domain-counts');
    countsEl.replaceChildren(...DOMAIN_STATUS_ORDER
      .filter(status => counts[status] > 0 && status !== 'skipped')
      .map(status => domainChip(DOMAIN_STATUS_LABELS[status], counts[status], status)));
    const seeds = byId('goal-domain-seeds');
    const seedItems = seedRoots.slice(0, DOMAIN_SEED_LIMIT).map(domainSeedChip);
    if (seedRoots.length > DOMAIN_SEED_LIMIT) {
      const more = domainSeedChip('+' + (seedRoots.length - DOMAIN_SEED_LIMIT));
      more.dataset.more = 'true';
      more.title = seedRoots.slice(DOMAIN_SEED_LIMIT).join(', ');
      seedItems.push(more);
    }
    seeds.replaceChildren(...seedItems);
    setProperty(byId('goal-domain-progress'), 'value', rate);
    setText(byId('goal-domain-meter-label'), t('覆盖率 {0}%', percent) + (incomplete ? ' · ' + t('未完成 {0} 个', incomplete) : ''));
    const table = byId('goal-domain-table');
    const empty = byId('goal-domain-empty');
    setProperty(table, 'hidden', domains.length === 0);
    setProperty(empty, 'hidden', domains.length !== 0);
    setText(empty, t('种子范围已登记，等待发现更多主机。'));
    const fragment = document.createDocumentFragment();
    const sorted = [...domains].sort((left, right) => {
      const order = DOMAIN_STATUS_ORDER.indexOf(left.test_status) - DOMAIN_STATUS_ORDER.indexOf(right.test_status);
      return order !== 0 ? order : String(left.hostname).localeCompare(String(right.hostname));
    });
    for (const item of sorted.slice(0, DOMAIN_ROW_LIMIT)) {
      const row = document.createElement('tr');
      row.dataset.host = item.hostname;
      const hostCell = document.createElement('td');
      const host = document.createElement('span');
      host.className = 'goal-domain-host';
      host.textContent = item.hostname;
      hostCell.append(host);
      if (item.parent && item.parent !== item.hostname) {
        const parent = document.createElement('small');
        parent.className = 'goal-domain-parent';
        parent.textContent = '← ' + item.parent;
        hostCell.append(parent);
      }
      const kindCell = document.createElement('td');
      kindCell.className = 'goal-domain-kind';
      kindCell.textContent = t(DOMAIN_KIND_LABELS[item.kind] ?? item.kind ?? '');
      const discoveryCell = document.createElement('td');
      discoveryCell.className = 'goal-domain-discovery';
      discoveryCell.textContent = t(DOMAIN_DISCOVERY_LABELS[item.discovery] ?? item.discovery ?? '');
      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      status.className = 'goal-domain-state';
      status.dataset.status = item.test_status ?? '';
      status.textContent = t(DOMAIN_STATUS_LABELS[item.test_status] ?? item.test_status ?? '');
      if (item.skip_reason) status.title = item.skip_reason;
      statusCell.append(status);
      const evidenceCell = document.createElement('td');
      evidenceCell.className = 'goal-domain-evidence';
      const evidence = [];
      if (Array.isArray(item.relations) && item.relations.length) evidence.push(t('关系 {0}', item.relations.length));
      if (Array.isArray(item.evidence) && item.evidence.length) evidence.push(t('证据 {0}', item.evidence.length));
      if (Array.isArray(item.finding_ids) && item.finding_ids.length) evidence.push(t('发现 {0}', item.finding_ids.length));
      if (Array.isArray(item.linked_note_ids) && item.linked_note_ids.length) evidence.push(t('笔记 {0}', item.linked_note_ids.length));
      evidenceCell.textContent = evidence.join(' · ') || '—';
      row.append(hostCell, kindCell, discoveryCell, statusCell, evidenceCell);
      fragment.append(row);
    }
    byId('goal-domain-list').replaceChildren(fragment);
    const incompleteHosts = sorted.filter(item => item.test_status === 'pending' || item.test_status === 'in_progress').map(item => item.hostname);
    const parts = [t('种子域及其子域自动计入范围；别名/IP 主机按登记状态计入覆盖。')];
    if (incompleteHosts.length) {
      const shown = incompleteHosts.slice(0, 8).join('、');
      parts.push(t('待测 {0} 个：{1}', incompleteHosts.length, shown + (incompleteHosts.length > 8 ? ' ' + t('等') : '')));
    } else if (domains.length) {
      parts.push(t('所有主机已完成或已关闭测试。'));
    }
    if (domains.length > DOMAIN_ROW_LIMIT) parts.push(t('仅显示前 {0} 个主机（共 {1}）。', DOMAIN_ROW_LIMIT, domains.length));
    setText(byId('goal-domain-caption'), parts.join(' '));
    if (!domainPanelInitialized) {
      domainPanelInitialized = true;
      panel.open = domains.length <= 12;
    }
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
      const menuNotes = byId('menu-assist-notes-label');
      if (menuNotes) setText(menuNotes, showingNotes ? '返回对话' : '笔记');
      setAttribute(byId('menu-assist-notes'), 'aria-label', showingNotes ? '返回对话' : '打开笔记');
      renderGoalView();
      if (showingNotes) renderNotes(hostState?.notes ?? []);
      if (goalSignalTicker) { clearInterval(goalSignalTicker); goalSignalTicker = 0; }
      return;
    }
    setAttribute(byId('goal-mode'), 'aria-label', '探索模式');
    const goal = hostState?.goal;
    const editing = workspaceMissing() || !goal || (draftFor().goalEditing && !busy);
    // The sidebar tab only makes sense once this conversation has a goal.
    setProperty(byId('goal-chat-toggle'), 'hidden', !goal);
    renderGoalChatToggle();
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
      if (!editing) { renderAgenda(hostState?.agenda); renderGraphStatus(hostState?.graph); }
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
      renderGoalSignals();
      renderDomainInventory();
      syncGoalSignalTicker();
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
  // One compact row: status counts as pills, a slim progress bar, then a single
  // ordered list. Kept tight so the board, the parallel-task strip and the
  // composer all fit; worker-owned rows link back to their worker panel.
  // Show which MCP servers actually registered, so a failed server is not just a
  // missing tool with no explanation.
  function mcpIntegration(servers) {
    const loaded = servers.filter(server => server.connected === true).length;
    const failed = servers.filter(server => server.connected !== true && server.enabled !== false).map(server => server.name);
    return `${loaded} / ${servers.length} 个服务已加载${failed.length ? `（${failed.join('、')} 未连接）` : ''}`;
  }
  const TODO_ORDER = ['in_progress', 'pending', 'completed'];  const TODO_STATUSES = new Set(TODO_ORDER);
  const TODO_LABELS = { in_progress: '进行中', pending: '待做', completed: '已完成' };
  const todoFold = new Map();
  let todoFoldSession = '';
  let todoList, todoRows = new Map();
  function renderAssistTodos() {
    const panel = byId('assist-todos');
    const goalMode = hostState?.mode === 'goal';
    const raw = hostState?.execution?.memory?.todos;
    const workers = Array.isArray(hostState?.execution?.workers) ? hostState.execution.workers : [];
    // Spawned workers get the same name the parallel-task strip shows; the main
    // agent owns everything else and stays unlabelled.
    const ownerOf = id => {
      if (typeof id !== 'string' || !id) return undefined;
      const worker = workers.find(item => item.id === id);
      if (!worker) return undefined;
      return { id, label: String(worker.name || worker.description || '').trim() || id.split('/').pop().slice(0, 12) };
    };
    const runActive = Boolean(hostState?.busy || hostState?.execution?.busy);
    const items = (Array.isArray(raw) ? raw : []).flatMap(item => {
      if (!item || typeof item.content !== 'string' || !item.content.trim()) return [];
      const status = TODO_STATUSES.has(item.status) ? item.status : 'pending';
      // A run can end while the model forgot to close its current todo. Nothing
      // is executing after the turn settles, so show it as pending instead of a
      // stale "in progress" pill; the durable board keeps the agent's status for
      // its next turn.
      return [{ id: String(item.id ?? ''), content: item.content, owner: ownerOf(item.worker_id),
        status: runActive || status !== 'in_progress' ? status : 'pending' }];
    });
    if (goalMode || !items.length) { panel.hidden = true; return; }
    // The user's fold choice belongs to the conversation, not to the DOM node.
    // Collapsed by default: the header row alone already carries the counts and
    // progress, and the list is one click away.
    if (todoFoldSession !== currentSessionId) {
      todoFoldSession = currentSessionId;
      panel.open = todoFold.get(currentSessionId) ?? false;
    }
    panel.hidden = false;
    const counts = TODO_ORDER.map(status => [status, items.filter(item => item.status === status).length]);
    const done = counts.find(([status]) => status === 'completed')[1];
    panel.style.setProperty('--assist-todos-progress', Math.round(done / items.length * 100) + '%');
    panel.style.setProperty('--assist-todos-fill', String(done / items.length));
    const countHost = byId('assist-todos-count');
    const countsKey = counts.map(([status, size]) => status + ':' + size).join(',');
    if (countHost.dataset.key !== countsKey) {
      countHost.dataset.key = countsKey;
      countHost.replaceChildren(...counts.filter(([, size]) => size > 0).map(([status, size]) => {
        const pill = document.createElement('span');
        pill.className = 'assist-todos-pill';
        pill.dataset.status = status;
        pill.append(Object.assign(document.createElement('span'), { textContent: TODO_LABELS[status] }),
          Object.assign(document.createElement('span'), { className: 'assist-todos-pill-count', textContent: String(size) }));
        return pill;
      }));
    }
    const ordered = [...items].sort((left, right) => TODO_ORDER.indexOf(left.status) - TODO_ORDER.indexOf(right.status));
    const body = byId('assist-todos-groups');
    const key = JSON.stringify(ordered.map(item => [item.id, item.status, item.content, item.owner?.id]));
    if (body.dataset.key === key) return;
    body.dataset.key = key;
    if (!todoList) { todoList = document.createElement('ul'); todoList.className = 'assist-todos-list'; }
    if (todoList.parentElement !== body) body.replaceChildren(todoList);
    const ids = new Set(ordered.map(item => item.id));
    for (const [id, row] of todoRows) if (!ids.has(id)) { row.element.remove(); todoRows.delete(id); }
    for (const [index, item] of ordered.entries()) {
      let row = todoRows.get(item.id);
      if (!row) {
        const rowElement = document.createElement('li');
        rowElement.className = 'assist-todos-item';
        const label = Object.assign(document.createElement('span'), { className: 'assist-todos-text' });
        rowElement.append(label);
        row = { element: rowElement, label, owner: undefined, ownerId: '' };
        todoRows.set(item.id, row);
      }
      row.element.dataset.status = item.status;
      if (item.status === 'in_progress') row.element.setAttribute('aria-current', 'true');
      else row.element.removeAttribute('aria-current');
      if (row.label.textContent !== item.content) row.label.textContent = item.content;
      if (row.ownerId !== (item.owner?.id || '')) {
        row.owner?.remove(); row.owner = undefined; row.ownerId = item.owner?.id || '';
        if (item.owner) {
          const owner = document.createElement('button');
          owner.type = 'button';
          owner.className = 'assist-todos-owner';
          owner.textContent = item.owner.label;
          owner.title = '打开此任务对应的并行任务记录';
          owner.addEventListener('click', () => workerPanel.show(item.owner.id, owner));
          row.owner = owner;
        }
      }
      if (row.owner && row.owner.parentElement !== row.element) row.element.append(row.owner);
      if (row.owner && row.owner.textContent !== item.owner.label) row.owner.textContent = item.owner.label;
      const desired = todoList.children[index];
      if (row.element !== desired) todoList.insertBefore(row.element, desired || null);
    }
  }
  byId('assist-todos').addEventListener('toggle', () => {
    if (todoFoldSession) todoFold.set(todoFoldSession, byId('assist-todos').open);
  });
  // The only user-facing way to end a live backend: it keeps the execution
  // checkpoint and reports back, so a stuck model/tool step is recoverable
  // without restarting the IDE and without any automatic task replay.
  async function restartBackend() {
    if (hasPending('restartBackend')) return;
    let confirmed = true;
    try {
      confirmed = await modalDialog.confirm({
        title: '重新启动 Agent 后端？',
        message: '正在运行的 Agent 任务会停止，但执行记录检查点保留；重启后可点击“继续执行”恢复。',
        detail: '用于后端长时间无响应或状态异常。若只是响应变慢，请先等待或检查连接。',
        confirmLabel: '重新启动',
        cancelLabel: '取消',
        danger: true
      }) === true;
    } catch { confirmed = false; }
    if (!confirmed) return;
    request('restartBackend', {}, () => {}, failure => showError('重启 Agent 后端失败：' + (failure?.message || '请稍后重试。')), 30000);
  }
  function sendPrompt() {
    const field = input;
    const draftKey = 'assist';
    const draft = draftFor();
    const chips = (draft.pastes || []).map(chip => ({ ...chip }));
    const text = composerPromptText().trim();
    const totalLength = composerLength();
    const hasImages = (hostState?.pendingImages?.length ?? 0) > 0;
    // A prompt may still be in flight while the next draft is typed; the host
    // serializes prompts and keeps FIFO order, so a new send is allowed at once.
    // Image-only resubmits wait for the acknowledgment that clears the attached
    // images, otherwise the same image would be sent twice.
    if (hasPending('prompt') && !text) return;
    if (!currentSessionId || configurationMissing() || hostState?.mode === 'goal' || (!text && !hasImages) || totalLength > field.maxLength || navigationPending() || hasPending('rewindInput') || hasPending('cancelRun') || hasPending('runGoal') || hasPending('resumeRun') || composingPrompt || contextPending()) return;
    // The host rejects an enqueue beyond 20 queued inputs. Say so before the
    // optimistic clear and keep the draft and attachments exactly as typed.
    if (queueAtLimit()) { showError('输入队列最多保留 20 条消息，请先继续发送或移除一条。'); return; }
    const sessionId = currentSessionId;
    const submitted = { text: field.value, pastes: chips };
    rememberPrompt(text);
    // Optimistic send: clear the composer and its draft before the round-trip,
    // so agent start-up (context capture, restore, queue write) never blocks
    // typing, Enter, or the next message. A failed request restores the text.
    field.value = '';
    const cleared = draftFor(sessionId);
    cleared[draftKey] = '';
    cleared.pastes = [];
    renderPastes();
    resetHistoryRecall();
    forceScroll = true;
    updateInput();
    persistDrafts();
    if (document.activeElement === submit) input.focus({ preventScroll: true });
    request('prompt', { text, approvalMode: approvalMode.querySelector('input:checked').value }, undefined, () => {
      // Failure (including a timeout): bring the unacknowledged text and folded
      // pastes back, below anything typed since then, so no draft is lost.
      const current = draftFor(sessionId);
      current[draftKey] = current[draftKey] ? submitted.text + '\n\n' + current[draftKey] : submitted.text;
      current.pastes = [...submitted.pastes, ...(current.pastes || [])];
      if (currentSessionId === sessionId) { field.value = current[draftKey]; renderPastes(); updateInput(); }
      persistDrafts();
    });
  }
  byId('composer-model').addEventListener('change', event => {
    const modelId = event.currentTarget.value;
    if (!currentSessionId || !hostState?.modelSelection?.models?.includes(modelId)) return;
    request('setModel', { modelId }, () => {});
  });
  function cancelRun() {
    if (busy && !hasPending('cancelRun') && !navigationPending()) request('cancelRun', {}, () => {
      // The submit button morphs from stop back to send; return typing focus to
      // the composer once the stop request is acknowledged.
      if (document.activeElement === submit) input.focus({ preventScroll: true });
    });
  }
  function restoreInput(action, payload, text, options = {}) {
    if (queueControlsBlocked() || (action === 'rewindInput' && rewindControlsBlocked())) return;
    const sessionId = currentSessionId;
    request(action, payload, () => {
      const draft = draftFor(sessionId);
      // Preserve text typed while the host was stopping the agent.
      draft.assist = draft.assist ? text + '\n\n' + draft.assist : text;
      // A recalled input keeps the approval snapshot captured when it was
      // queued. The host restores its images and context by itself.
      const recalled = options.approvalMode;
      if (['auto', 'manual', 'full'].includes(recalled)) draft.approvalMode = recalled;
      if (currentSessionId === sessionId) { input.value = draft.assist; updateInput(); reflectApprovalMode(); input.focus(); }
      persistDrafts();
    });
  }
  let inputQueueKey = '';
  let inputQueueSession = '';
  function queueControlsBlocked() {
    // Brief probe resync, slow IDE responses and backend recovery must not freeze
    // queue/input controls; only an undeliverable bridge pauses new sends.
    return !currentSessionId || hostState?.recovering || connectionStatus === 'unresponsive'
      || navigationPending() || ['cancelRun', 'rewindInput', 'removeInput', 'steerInput', 'resumeInputs'].some(action => hasPending(action));
  }
  function rewindControlsBlocked() {
    return queueControlsBlocked() || ['prompt', 'runGoal', 'resumeRun'].some(action => hasPending(action));
  }
  function queueActionAllowed(button, sessionId) {
    return button.isConnected && !button.disabled && sessionId === currentSessionId && !queueControlsBlocked();
  }
  let queuePreview;
  function queuePreviewChars(item) {
    return Array.from(typeof item?.text === 'string' ? item.text : '').length;
  }
  function queueContextLabel(context) {
    if (!context || typeof context.label !== 'string' || !context.label) return '';
    const kind = ['selection', 'file', 'active'].includes(context.kind) ? context.kind : 'active';
    const prefix = kind === 'selection' ? t('选中') : kind === 'file' ? t('附件') : '';
    return prefix ? prefix + ' ' + context.label : context.label;
  }
  function queueContextTitle(context) {
    if (!context?.label) return '';
    const range = typeof context.range === 'string' ? context.range.trim() : '';
    return t('入队时的上下文：{0}', String(context.label) + (range ? ' · ' + range : ''));
  }
  function queueApprovalLabel(mode) { return mode === 'auto' ? '自动' : mode === 'full' ? '完全' : '人工'; }
  function queueModelLabel(modelId) {
    const value = String(modelId || '');
    const tail = value.split('/').pop() || value;
    return tail.length > 18 ? tail.slice(0, 17) + '…' : tail;
  }
  // Metadata snapshot published with each queued input. Absent fields simply
  // hide their chip; the approval/model chips only appear when they differ from
  // the composer, because a matching snapshot needs no explanation.
  function queueItemChips(item, { busy: busyNow = false, preview = false } = {}) {
    const chips = [];
    const imageCount = Number.isFinite(item?.imageCount) ? item.imageCount : 0;
    if (imageCount > 0) {
      chips.push({ key: 'images', text: t('图片 ×{0}', imageCount), title: t('入队时附带 {0} 张图片', imageCount) });
    }
    const context = item?.context && typeof item.context === 'object' ? item.context : null;
    if (context?.label) {
      chips.push({
        key: 'context', kind: ['selection', 'file', 'active'].includes(context.kind) ? context.kind : 'active',
        text: queueContextLabel(context), title: queueContextTitle(context)
      });
    }
    const approval = item?.approvalMode;
    if (['auto', 'manual', 'full'].includes(approval) && (preview || approval !== approvalModeValue())) {
      chips.push({ key: 'approval', tone: 'approval', text: t(queueApprovalLabel(approval)), title: t('入队时的执行方式；发出时沿用入队快照') });
    }
    const modelId = typeof item?.modelId === 'string' ? item.modelId.trim() : '';
    if (modelId && (preview || modelId !== (hostState?.modelSelection?.selected || ''))) {
      chips.push({ key: 'model', text: queueModelLabel(modelId), title: t('入队时模型：{0}', modelId) });
    }
    // An image input cannot steer the live turn: it will be sent next round.
    if (!preview && busyNow && imageCount > 0) {
      chips.push({ key: 'next-turn', tone: 'hint', text: t('下一轮'), title: t('带图片的输入会在下一轮发送，不能引导当前任务') });
    }
    return chips;
  }
  function queueChipNode(chip, className = 'input-queue-chip') {
    const node = document.createElement('span'); node.className = className; node.dataset.chip = chip.key;
    if (chip.kind) node.dataset.kind = chip.kind;
    if (chip.tone) node.dataset.tone = chip.tone;
    setText(node, chip.text);
    if (chip.title) setAttribute(node, 'title', chip.title);
    return node;
  }
  function renderQueuePreview(item, index) {
    if (!queuePreview) return;
    setText(queuePreview.body, item.text);
    const prefix = document.createElement('span'); prefix.className = 'queue-preview-prefix';
    setText(prefix, t('第 {0} 条 · {1} 字符', index + 1, queuePreviewChars(item)));
    const nodes = [prefix];
    for (const chip of queueItemChips(item, { preview: true })) nodes.push(queueChipNode(chip, 'queue-preview-chip'));
    queuePreview.meta.replaceChildren(...nodes);
    queuePreview.text = item.text;
  }
  function openQueuePreview(item, index, trigger) {
    if (!queuePreview) {
      const dialog = document.createElement('dialog'); dialog.id = 'queue-preview'; dialog.setAttribute('aria-labelledby', 'queue-preview-title');
      const header = document.createElement('div'); header.className = 'queue-preview-heading';
      const title = document.createElement('h2'); title.id = 'queue-preview-title'; setText(title, '待发送输入');
      const controls = document.createElement('div'); controls.className = 'queue-preview-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'queue-preview-copy';
      copy.setAttribute('aria-label', '复制完整输入'); setText(copy, '复制');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'queue-preview-close'; setText(close, '关闭'); close.setAttribute('aria-label', '关闭输入预览');
      const meta = document.createElement('p'); meta.className = 'queue-preview-meta';
      const body = document.createElement('div'); body.className = 'queue-preview-content'; body.tabIndex = 0; body.setAttribute('role', 'region'); body.setAttribute('aria-label', '完整输入内容');
      controls.append(copy, close); header.append(title, controls); dialog.append(header, meta, body); document.body.appendChild(dialog);
      queuePreview = { dialog, meta, body, copy, text: '', copyTimer: 0 };
      copy.onclick = () => {
        if (!queuePreview.text) return;
        request('copyText', { text: queuePreview.text }, () => {
          setText(copy, '已复制');
          clearTimeout(queuePreview.copyTimer);
          queuePreview.copyTimer = setTimeout(() => setText(copy, '复制'), 1500);
        }, error => showError(error?.message || '复制失败，请重试'));
      };
      close.onclick = () => dialog.close();
      dialog.addEventListener('close', () => {
        // A queued close event may arrive after another preview was opened.
        if (dialog.open) return;
        clearTimeout(queuePreview.copyTimer);
        setText(copy, '复制');
        body.textContent = ''; meta.replaceChildren(); queuePreview.text = '';
        if (queuePreview.sessionId !== currentSessionId) return;
        const target = queuePreview.trigger?.isConnected ? queuePreview.trigger : input;
        target.focus({ preventScroll: true });
      });
      window.addEventListener('pagehide', () => { if (dialog.open) dialog.close(); });
    }
    Object.assign(queuePreview, { sessionId: currentSessionId, inputId: item.id, trigger });
    renderQueuePreview(item, index);
    queuePreview.body.scrollTop = 0;
    if (!queuePreview.dialog.open) queuePreview.dialog.showModal();
    queuePreview.body.focus({ preventScroll: true });
  }
  const queueRowViews = new WeakMap();
  const queueRowHighlightTimers = new WeakMap();
  function createQueueRowView() {
    const row = document.createElement('div'); row.className = 'input-queue-row'; row.setAttribute('role', 'listitem'); row.tabIndex = -1;
    const order = document.createElement('span'); order.className = 'input-queue-order'; order.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'input-queue-body';
    const text = document.createElement('button'); text.type = 'button'; text.className = 'input-queue-text'; text.dataset.queueAction = 'preview'; text.setAttribute('aria-haspopup', 'dialog');
    const meta = document.createElement('div'); meta.className = 'input-queue-meta'; meta.hidden = true;
    body.append(text, meta);
    const actions = document.createElement('div'); actions.className = 'input-queue-actions';
    const pill = document.createElement('span'); pill.className = 'input-queue-delivery'; pill.hidden = true;
    const steer = document.createElement('button'); steer.type = 'button'; steer.className = 'input-queue-steer'; steer.dataset.queueAction = 'steer'; steer.setAttribute('aria-label', '引导当前任务');
    const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.queueAction = 'edit';
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z"/></svg>';
    const remove = document.createElement('button'); remove.className = 'input-queue-remove'; remove.type = 'button'; remove.dataset.queueAction = 'remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    actions.append(pill, steer, edit, remove);
    row.append(order, body, actions);
    const view = { row, order, text, meta, actions, pill, steer, edit, remove };
    queueRowViews.set(row, view);
    return view;
  }
  function queueRowView(row) {
    let view = queueRowViews.get(row);
    if (!view) {
      view = {
        row, order: row.querySelector('.input-queue-order'), text: row.querySelector('.input-queue-text'), meta: row.querySelector('.input-queue-meta'),
        actions: row.querySelector('.input-queue-actions'), pill: row.querySelector('.input-queue-delivery'),
        steer: row.querySelector('.input-queue-steer'), edit: row.querySelector('[data-queue-action="edit"]'), remove: row.querySelector('.input-queue-remove')
      };
      queueRowViews.set(row, view);
    }
    return view;
  }
  function markQueueRowNew(row) {
    if (!row) return;
    row.classList.remove('input-queue-row-new');
    void row.offsetWidth;
    row.classList.add('input-queue-row-new');
    clearTimeout(queueRowHighlightTimers.get(row));
    queueRowHighlightTimers.set(row, setTimeout(() => {
      queueRowHighlightTimers.delete(row);
      row.classList.remove('input-queue-row-new');
    }, 1400));
  }
  function createQueueHeading() {
    const heading = document.createElement('div'); heading.className = 'input-queue-heading';
    const label = document.createElement('strong');
    const labelText = document.createElement('span'); labelText.className = 'input-queue-label'; setText(labelText, '待发送');
    const count = document.createElement('span'); count.className = 'input-queue-count';
    label.append(labelText, count);
    // The status text is the only live region: it changes when the queue render
    // changes, never on every streaming tick.
    const status = document.createElement('span'); status.className = 'input-queue-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'input-queue-resume'; setText(resume, '继续发送队列');
    heading.append(label, status, resume);
    return { heading, count, status, resume };
  }
  function renderInputQueue() {
    const container = byId('input-queue');
    if (!container) return;
    const allItems = hostState?.inputQueue ?? [];
    // An item marked `sending` has already been dispatched to the agent; it is
    // kept durably so a crash can recover it, but while the launch is in flight
    // it must not look like normal queued work the user is waiting on. If the
    // launch fails, queuePaused turns it back into a visible "delivery uncertain"
    // row requiring review.
    const items = hostState?.queuePaused ? allItems : allItems.filter(item => item.delivery !== 'sending');
    const execution = executionState();
    const paused = hostState?.queuePaused || ['interrupted', 'failed'].includes(execution.status);
    const canSteer = busy && execution.canSteer === true;
    const unresolved = allItems.some(item => item.delivery);
    const sending = allItems.some(item => item.delivery === 'sending');
    const controlsBlocked = queueControlsBlocked();
    const stopping = hasPending('cancelRun') || hasPending('rewindInput');
    const approvalNow = approvalModeValue();
    const selectedModel = hostState?.modelSelection?.selected || '';
    const key = JSON.stringify([currentSessionId, allItems, items, paused, busy, canSteer, execution.runId, controlsBlocked, stopping,
      approvalNow, selectedModel, hasPending('removeInput'), hasPending('resumeInputs'), hasPending('steerInput')]);
    if (key === inputQueueKey) return;
    if (queuePreview?.dialog.open) {
      const index = items.findIndex(item => item.id === queuePreview.inputId);
      if (queuePreview.sessionId !== currentSessionId || index < 0) queuePreview.dialog.close();
      else renderQueuePreview(items[index], index);
    }
    const sameSession = inputQueueSession === currentSessionId;
    const previousList = sameSession ? container.querySelector('.input-queue-list') : null;
    const previousScroll = previousList?.scrollTop ?? 0;
    const previousIds = new Set(previousList ? [...previousList.children].map(row => row.dataset.inputId) : []);
    const wasHidden = container.hidden;
    const wasAtBottom = !previousList || previousList.scrollHeight - previousList.scrollTop - previousList.clientHeight <= 8;
    const focused = sameSession && container.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('.input-queue-row')?.dataset.inputId;
    const focusedAction = focused?.dataset.queueAction ?? focused?.closest('.input-queue-row')?.dataset.focusAction;
    const focusedIndex = focusedId ? [...container.querySelectorAll('.input-queue-row')].findIndex(row => row.dataset.inputId === focusedId) : -1;
    inputQueueKey = key; inputQueueSession = currentSessionId;
    if (!sameSession || !items.length) container.replaceChildren();
    container.hidden = !items.length;
    if (!items.length) { if (focused) input.focus({ preventScroll: true }); return; }
    let heading = container.querySelector('.input-queue-heading');
    let list = container.querySelector('.input-queue-list');
    if (!heading || !list) {
      if (!heading) heading = createQueueHeading().heading;
      if (!list) { list = document.createElement('div'); list.className = 'input-queue-list'; list.setAttribute('role', 'list'); }
      container.replaceChildren(heading, list);
    }
    const count = heading.querySelector('.input-queue-count');
    const status = heading.querySelector('.input-queue-status');
    const resume = heading.querySelector('.input-queue-resume');
    const interrupted = ['interrupted', 'failed'].includes(execution.status);
    setProperty(container.dataset, 'paused', String(Boolean(paused)));
    setProperty(container.dataset, 'unresolved', String(Boolean(unresolved)));
    setProperty(container.dataset, 'sending', String(Boolean(sending)));
    setText(count, items.length >= 15 ? `${items.length} / ${QUEUE_LIMIT}` : String(items.length));
    setAttribute(count, 'aria-label', `${items.length} 条待发送输入`);
    if (items.length >= 15) setAttribute(count, 'title', t('队列最多 {0} 条', QUEUE_LIMIT)); else count.removeAttribute('title');
    setText(status, stopping ? '正在停止，请稍候'
      : sending ? '正在发送…'
      : unresolved ? '请核实引导送达状态'
      : paused ? (interrupted ? '已暂停 · 上一轮已停止或失败，请核实后继续' : '已暂停')
      : canSteer ? '可立刻调整当前任务'
      : busy ? '当前结束后按顺序执行'
      : '等待继续');
    setProperty(resume, 'hidden', !(paused || !busy));
    resume.disabled = busy || unresolved || controlsBlocked;
    const resumeSession = currentSessionId;
    resume.onclick = () => { if (queueActionAllowed(resume, resumeSession)) request('resumeInputs'); };
    const retainedRows = new Map([...list.children].map(row => [row.dataset.inputId, row]));
    const rows = [];
    for (const [index, item] of items.entries()) {
      const actionSession = currentSessionId;
      const existing = retainedRows.get(item.id);
      const view = existing ? queueRowView(existing) : createQueueRowView();
      const row = view.row;
      row.dataset.inputId = item.id;
      row.dataset.delivery = item.delivery || 'queued';
      setText(view.order, String(index + 1));
      setText(view.text, item.text);
      setAttribute(view.text, 'title', '查看完整输入');
      setAttribute(view.text, 'aria-label', t('查看第 {0} 条完整输入', index + 1));
      const previewSession = currentSessionId;
      view.text.onclick = () => { if (previewSession === currentSessionId && row.isConnected) openQueuePreview(item, index, view.text); };
      const chips = queueItemChips(item, { busy });
      if (chips.length) { view.meta.replaceChildren(...chips.map(chip => queueChipNode(chip))); setProperty(view.meta, 'hidden', false); }
      else { view.meta.replaceChildren(); setProperty(view.meta, 'hidden', true); }
      const delivery = typeof item.delivery === 'string' ? item.delivery : '';
      if (delivery) {
        setText(view.pill, delivery === 'sending' ? (hasPending('steerInput') ? '发送中…' : '发送中') : '送达待确认');
        setAttribute(view.pill, 'title', '输入及附件已保留，请核实执行结果；取回编辑或删除后可继续队列');
        setProperty(view.pill.dataset, 'delivery', delivery);
      } else { setText(view.pill, ''); delete view.pill.dataset.delivery; }
      setProperty(view.pill, 'hidden', !delivery);
      const imageCount = Number.isFinite(item.imageCount) ? item.imageCount : 0;
      setText(view.steer, '引导');
      // The title explains why the control is (un)available. Pausing only stops
      // automatic drain: manual steering can still be accepted while a run is
      // live, so the paused wording is reserved for the disabled case.
      setAttribute(view.steer, 'title', delivery ? '输入及附件已保留，请核实执行结果；取回编辑或删除后可继续队列'
        : imageCount > 0 ? '带图片的输入会在下一轮发送，不能引导当前任务'
        : !canSteer ? (paused ? '队列已暂停，继续后可发送' : '等待当前任务就绪后可立刻调整')
        : '立刻调整当前任务；当前模型回复和工具批次结束后生效，沿用当前审批设置');
      view.steer.disabled = !canSteer || Boolean(delivery) || controlsBlocked || imageCount > 0;
      const runId = execution.runId;
      view.steer.onclick = () => { if (queueActionAllowed(view.steer, actionSession) && executionState().runId === runId && executionState().canSteer) request('steerInput', { inputId: item.id, runId }); };
      setAttribute(view.edit, 'title', '取回编辑'); setAttribute(view.edit, 'aria-label', '取回编辑');
      view.edit.disabled = controlsBlocked;
      view.edit.onclick = () => { if (queueActionAllowed(view.edit, actionSession)) restoreInput('removeInput', { inputId: item.id }, item.text, { approvalMode: item.approvalMode }); };
      setAttribute(view.remove, 'title', '删除待发送输入'); setAttribute(view.remove, 'aria-label', '删除');
      view.remove.disabled = controlsBlocked;
      view.remove.onclick = () => { if (queueActionAllowed(view.remove, actionSession)) request('removeInput', { inputId: item.id }); };
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
    // A newly added row is only revealed automatically when the reader was at
    // the end (or the queue was hidden). Otherwise their reading position stays.
    const addedRows = rows.filter(row => !previousIds.has(row.dataset.inputId));
    const revealNewest = addedRows.length > 0 && ((sameSession && wasAtBottom) || wasHidden);
    list.scrollTop = revealNewest ? list.scrollHeight : previousScroll;
    if (revealNewest) {
      markQueueRowNew(addedRows[addedRows.length - 1]);
      // The first paint can run while the loading surface still hides the
      // composer, so measure again once the page is actually visible.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (list.isConnected) list.scrollTop = list.scrollHeight;
      }));
    }
    if (focusedId) {
      const row = [...list.children].find(row => row.dataset.inputId === focusedId) ?? list.children[Math.min(focusedIndex, list.children.length - 1)];
      if (row && focusedAction) row.dataset.focusAction = focusedAction;
      const button = row && [...row.querySelectorAll('button')].find(button => button.dataset.queueAction === focusedAction && !button.disabled);
      (button ?? row)?.focus({ preventScroll: true });
    } else if (focused?.classList.contains('input-queue-resume')) resume.focus({ preventScroll: true });
  }
  // Arrow keys walk the queue rows from any control inside the queue; Tab order
  // is untouched, so actions stay reachable in DOM order.
  function queueRowPreviewButtons() {
    const list = byId('input-queue')?.querySelector('.input-queue-list');
    if (!list) return [];
    return [...list.querySelectorAll('.input-queue-row')].map(row => row.querySelector('.input-queue-text')).filter(Boolean);
  }
  byId('input-queue')?.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const container = byId('input-queue');
    if (!container?.contains(document.activeElement)) return;
    const buttons = queueRowPreviewButtons();
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    const row = document.activeElement.closest?.('.input-queue-row');
    const index = current >= 0 ? current : row ? buttons.findIndex(button => button.closest('.input-queue-row') === row) : -1;
    const target = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1)
      : Math.max(0, index - 1);
    event.preventDefault();
    buttons[target].focus({ preventScroll: true });
    buttons[target].closest('.input-queue-row')?.scrollIntoView({ block: 'nearest' });
  });
  function queueAtLimit() {
    return hostState?.mode === 'assist' && (hostState?.inputQueue?.length ?? 0) >= QUEUE_LIMIT;
  }
  function resumeRun() {
    if (!configurationMissing() && !busy && executionState().canResume === true && !hasPending('resumeRun') && !navigationPending()) request('resumeRun');
  }
  approvalMode.addEventListener('change', event => {
    const value = event.target.value;
    if (approvalMode.disabled || !['auto', 'manual', 'full'].includes(value)) return;
    if (value === 'full') {
      // Revert the radio immediately; full mode applies only after the
      // confirmation dialog resolves true.
      reflectApprovalMode();
      void confirmFullApprovalMode();
      return;
    }
    draftFor().approvalMode = value;
    persistDrafts();
    // Rows whose queued approval snapshot matches the composer need no chip.
    renderInputQueue();
  });
  form.addEventListener('submit', event => { event.preventDefault(); if (busy && !hasComposerText()) cancelRun(); else sendPrompt(); });
  input.addEventListener('compositionstart', () => { composingPrompt = true; });
  input.addEventListener('compositionend', () => { composingPrompt = false; });
  input.addEventListener('blur', () => { composingPrompt = false; });
  input.addEventListener('input', () => {
    resetHistoryRecall();
    draftFor().assist = input.value;
    scheduleDraftPersistence();
    scheduleInput();
  });
  input.addEventListener('keydown', event => {
    // Escape leaves history recall and restores the draft typed before recall.
    if (event.key === 'Escape' && historyCursor >= 0 && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      const scratch = historyScratch;
      resetHistoryRecall();
      applyHistoryValue(scratch);
      return;
    }
    // ↑ starts recall only from an empty composer; while recalling, both arrows
    // walk the recent list and any real edit (input event above) exits recall.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.ctrlKey && !event.metaKey
      && !event.shiftKey && !composingPrompt && !event.isComposing && event.keyCode !== 229
      && navigateHistory(event.key === 'ArrowUp' ? -1 : 1)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !composingPrompt && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendPrompt(); }
  });
  // Overflow menus close on item selection, outside click and Escape. Keyboard
  // users get the same behavior as native menus: Arrow keys move between items,
  // Home/End jump to the edges, and focus returns to the trigger on close.
  function wireOverflowMenu(details, menuSelector) {
    const summary = details.querySelector(':scope > summary');
    const menu = details.querySelector(menuSelector);
    const items = () => [...menu.querySelectorAll('button[role="menuitem"]')].filter(item => !item.hidden && !item.disabled && item.getClientRects().length);
    const focusFirst = () => { const first = items()[0]; if (first) first.focus({ preventScroll: true }); };
    summary.addEventListener('click', event => {
      if (event.detail !== 0) return;
      requestAnimationFrame(() => { if (details.open) focusFirst(); });
    });
    summary.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' || details.open) return;
      event.preventDefault(); details.open = true;
      requestAnimationFrame(focusFirst);
    });
    details.addEventListener('keydown', event => {
      if (!details.open) return;
      if (event.key === 'Escape') {
        event.preventDefault(); details.open = false;
        summary.focus({ preventScroll: true });
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const list = items();
      if (!list.length) return;
      const index = list.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      event.preventDefault();
      list[next].focus({ preventScroll: true });
    });
    menu.addEventListener('click', event => {
      if (!event.target.closest('button')) return;
      const restore = details.contains(document.activeElement) || document.activeElement === document.body;
      details.open = false;
      if (restore) summary.focus({ preventScroll: true });
    });
    return () => { details.open = false; };
  }
  const assistMore = byId('assist-more');
  const closeAssistMore = wireOverflowMenu(assistMore, '.topbar-more-menu');
  document.addEventListener('click', event => { if (!assistMore.contains(event.target)) closeAssistMore(); });
  const goalHeaderMore = byId('goal-header-more');
  const closeGoalHeaderMore = wireOverflowMenu(goalHeaderMore, '.goal-header-more-menu');
  document.addEventListener('pointerdown', event => {
    if (!goalHeaderMore.contains(event.target)) closeGoalHeaderMore();
  });
  byId('goal-run').addEventListener('click', () => {
    if (hostState?.goal && !busy && !hasPending('runGoal') && !navigationPending()) request('runGoal');
  });
  byId('goal-stop').addEventListener('click', cancelRun);
  byId('goal-resume').addEventListener('click', resumeRun);
  byId('assist-resume').addEventListener('click', resumeRun);
  const copyGoalSignal = (button, text) => {
    Promise.resolve(messageActions.onCopy(text)).then(() => {
      const original = button.textContent;
      button.textContent = t('已复制');
      setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1200);
    }).catch(() => {});
  };
  byId('goal-signals-copy').addEventListener('click', () => {
    copyGoalSignal(byId('goal-signals-copy'), goalSummaryText(goalSignalData()));
  });
  byId('goal-signals-export').addEventListener('click', () => {
    const button = byId('goal-signals-export');
    if (button.disabled) return;
    button.disabled = true;
    // Export is a host file-save operation: never serialize a multi-MB graph
    // through the clipboard or back into the webview.
    vscode.postMessage({ action: 'exportGoalGraph', sessionId: currentSessionId });
    setTimeout(() => { if (button.isConnected) button.disabled = false; }, 1200);
  });
  function refreshBlackboardUi() {
    // Escape hatch for a failed/partial graph paint: recreate the renderer from
    // the last state, then ask the host for an authoritative snapshot. The host
    // also drops its delivered-projection memo, so the blackboard is re-sent
    // even when the backend revision did not change.
    try {
      try { blackboardGraph?.dispose(); } catch { /* Recreated below. */ }
      blackboardGraph = undefined;
      sectionViews.delete('blackboard');
      renderBlackboard(hostState?.execution?.blackboard, hostState?.execution?.result);
    } catch (error) {
      console.warn('[UBOVM] Blackboard refresh failed', error);
    }
    vscode.postMessage({ action: 'refreshBlackboard', sessionId: currentSessionId });
  }
  byId('blackboard-empty-refresh').addEventListener('click', refreshBlackboardUi);
  byId('goal-signal-autonomy').addEventListener('click', () => {
    if (byId('goal-signal-autonomy').hidden) return;
    vscode.postMessage({ action: 'openSettings', section: 'reason', sessionId: currentSessionId });
  });
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
  function toggleAssistNotes() {
    setGoalView(draftFor().view === 'notes' ? 'overview' : 'notes');
  }
  byId('assist-notes-toggle').addEventListener('click', toggleAssistNotes);
  byId('menu-assist-notes').addEventListener('click', () => {
    closeAssistMore();
    toggleAssistNotes();
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
    } else if (button.dataset.action === 'revealWorkspace') {
      if (!currentSessionId || workspaceMissing() || hasPending('revealWorkspace')) return;
      request('revealWorkspace');
    } else if (button.dataset.action === 'attachFile') {
      if (busy || contextPending() || !currentSessionId) return;
      const sessionId = currentSessionId;
      request('attachFile', {}, () => { if (sessionId === currentSessionId) input.focus({ preventScroll: true }); });
    } else if (button.dataset.action === 'pickImage') {
      if (hasPending('prompt') || contextPending() || !currentSessionId) return;
      byId('image-input').click();
    } else vscode.postMessage({ action: button.dataset.action, sessionId: currentSessionId });
  }));
  byId('image-input').addEventListener('change', event => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length) void attachImageFiles(files);
  });
  byId('composer-images').addEventListener('click', event => {
    const button = event.target.closest('[data-image-id]');
    if (!button || !currentSessionId || hasPending('removeImage')) return;
    // The remove button disappears with its chip; return typing focus to the
    // composer after the host confirms the removal.
    const restoreFocus = document.activeElement === button;
    request('removeImage', { imageId: button.dataset.imageId }, () => { if (restoreFocus) input.focus({ preventScroll: true }); });
  });
  byId('composer-pastes').addEventListener('click', event => {
    const expand = event.target.closest('[data-paste-expand]');
    if (expand) { expandPasteChip(expand.dataset.pasteExpand); return; }
    const remove = event.target.closest('[data-paste-remove]');
    if (remove) removePasteChip(remove.dataset.pasteRemove);
  });
  input.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.kind === 'file' && (IMAGE_TYPES.has(item.type) || !item.type))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      void attachImageFiles(files);
      return;
    }
    // Very long clipboard text folds into a chip instead of stretching the
    // composer; the full text is still what gets sent.
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.length <= PASTE_CHIP_MIN) return;
    event.preventDefault();
    addPasteChip(text);
  });
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
  byId('goal-view-switcher').querySelector('summary').addEventListener('click', event => {
    if (event.detail !== 0) return;
    requestAnimationFrame(() => {
      if (byId('goal-view-switcher').open) byId('goal-tab-' + draftFor().view).focus({ preventScroll: true });
    });
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
  noteInput.addEventListener('input', () => { if (!editingNote) { draftFor().note = noteInput.value; scheduleDraftPersistence(); } updateControls(); });
  byId('note-new').addEventListener('click', () => {
    editingNote = null;
    setText(byId('note-editor-title'), '新建笔记');
    byId('goal-note-form').setAttribute('aria-label', '添加笔记');
    noteInput.value = draftFor().note || '';
    byId('note-editor-error').hidden = true;
    byId('note-editor').showModal(); noteInput.focus();
    updateControls();
  });
  byId('note-close').addEventListener('click', closeNoteEditor);
  byId('note-editor').addEventListener('cancel', event => { event.preventDefault(); closeNoteEditor(); });
  byId('note-back').addEventListener('click', () => {
    byId('goal-notes').dataset.reading = 'false';
    document.querySelector('.note-select[aria-pressed="true"]')?.focus({ preventScroll: true });
  });
  byId('note-copy').addEventListener('click', () => {
    const selected = [...byId('goal-notes-list').children, ...byId('agent-notes-list').children].find(row => noteEntries.get(row)?.key === selectedNoteKey);
    if (!selected) return;
    const button = byId('note-copy'), original = button.dataset.copyLabel || button.textContent;
    button.dataset.copyLabel = original;
    messageActions.onCopy(noteEntries.get(selected).text).then(() => {
      if (!button.isConnected) return;
      button.textContent = t('已复制');
      clearTimeout(button.feedbackTimer);
      button.feedbackTimer = setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1200);
    }).catch(error => showError(error.message));
  });
  byId('note-edit').addEventListener('click', () => {
    const selected = [...byId('goal-notes-list').children, ...byId('agent-notes-list').children].find(row => noteEntries.get(row)?.key === selectedNoteKey);
    const entry = selected && noteEntries.get(selected);
    if (!entry?.id) return;
    editingNote = { key: entry.key, id: entry.id, source: entry.source, text: entry.text };
    setText(byId('note-editor-title'), '修改笔记');
    byId('goal-note-form').setAttribute('aria-label', '修改笔记');
    noteInput.value = entry.text;
    byId('note-editor-error').hidden = true;
    byId('note-editor').showModal(); noteInput.focus();
    noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);
    updateControls();
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
    const editing = editingNote;
    const action = editing ? (editing.source === 'user' ? 'editNote' : 'editAgentNote') : 'addGoalNote';
    if (!text || noteInput.value.length > noteInput.maxLength || navigationPending() || !(hostState?.goal || hostState?.mode === 'assist') || hasPending(action)) return;
    const submitted = noteInput.value;
    const sessionId = currentSessionId;
    byId('note-editor-error').hidden = true;
    if (editing) {
      const editedKey = editing.key;
      request(action, { noteId: editing.id, text }, () => {
        if (sessionId !== currentSessionId) return;
        closeNoteEditor();
        selectedNoteKey = editedKey;
        byId('goal-notes').dataset.reading = 'true';
        requestAnimationFrame(() => {
          const row = [...byId('goal-notes-list').children, ...byId('agent-notes-list').children].find(item => noteEntries.get(item)?.key === editedKey);
          if (row) renderNoteReader(row); else filterNotes();
        });
      }, error => {
        if (sessionId !== currentSessionId) return;
        setText(byId('note-editor-error'), error.message); byId('note-editor-error').hidden = false;
      });
      return;
    }
    request(action, { text }, () => {
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
    if (!hostState) return;
    const failures = [];
    const tasks = [
      () => { if (hostState.mode !== 'goal') renderMessages(Array.isArray(hostState.messages) ? hostState.messages : []); },
      () => deliveryView.update(hostState.execution?.memory?.delivery, currentSessionId, hostState.execution?.memory?.domainInventory),
      renderAssistTodos,
      ...(executionOnly ? [] : [renderConversationOutline, renderAssistEvidence]),
      ...(executionOnly && hostState.mode !== 'goal' ? [] : [renderGoal]),
      renderExecution,
      renderTeam,
      renderTeamMember,
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
            else if (contentReadyPending && !acknowledgement.cancelled && !pageHidden() && isCurrentPaint(commit)) {
              // A stalled bridge already burned the full 5s clock; surface the
              // recovery panel immediately instead of retrying into another
              // silent 5s wait. Other failures get one delayed retry first.
              if (paintError?.code === 'PAINT_DELIVERY_TIMEOUT' || contentReadyRetried) {
                window.UBOVMRuntime?.fail('页面加载状态同步超时。请同步最新状态或重新加载页面。');
              } else {
                contentReadyRetried = true;
                contentReadyRetryTimer = setTimeout(() => {
                  contentReadyRetryTimer = 0;
                  if (contentReadyPending && isCurrentPaint(commit)) queueContentReady();
                }, 400);
              }
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
  // Compositor keep-alive. When the window is occluded for a long time without
  // any focus/visibility event, Chromium can discard the webview's own composited
  // surface: the DOM is intact but no new frame is produced, so the page looks
  // blank until a resize forces one. While the page is visible and idle, emit a
  // harmless frame on an interval so the surface heals without a geometry change.
  const keepAlive = { last: Date.now(), intervalMs: 5000, idleMs: 15000, probe: undefined, on: false };
  function keepAliveMark() { keepAlive.last = Date.now(); }
  function keepAliveNudge() {
    if (!keepAlive.probe) {
      const probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.dataset.role = 'keep-alive';
      // Off-screen and effectively transparent: forces a frame without touching layout.
      probe.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;pointer-events:none;opacity:0;';
      document.body.append(probe);
      keepAlive.probe = probe;
    }
    keepAlive.on = !keepAlive.on;
    keepAlive.probe.style.opacity = keepAlive.on ? '0.01' : '0';
  }
  setInterval(() => {
    if (document.hidden || suspended || visualSuspended()) return;
    repairPrimarySurface({ repaint: true });
    if (Date.now() - keepAlive.last < keepAlive.idleMs) return;
    keepAlive.last = Date.now();
    keepAliveNudge();
  }, 5000);
  // Returning focus to the webview after an idle gap repaints the page, so a
  // discarded surface recovers on the first click even without an OS focus event.
  let focusRepaintAt = 0;
  window.addEventListener('focus', () => {
    const now = Date.now(), idle = now - keepAlive.last >= 5000;
    keepAlive.last = now;
    if (!idle || document.hidden || suspended || visualSuspended() || now - focusRepaintAt < 1000) return;
    focusRepaintAt = now;
    cancelVisualFrames();
    resumeVisuals();
    repairPrimarySurface({ repaint: true });
  });
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(type, () => { keepAliveMark(); }, { capture: true, passive: true });
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
      !['completed', 'failed', 'interrupted'].includes(hostState?.execution?.status);
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
    // Track the in-flight paint. Without assigning renderFrame, the dedup guard
    // above never fires and cancelVisualFrames/beginPageTransition cannot cancel
    // the pending frame: bursted snapshots each paint a full page (stutter).
    const frame = renderFrame = requestAnimationFrame(() => {
      // A cancelled frame may still be delivered by the browser during a
      // resize/visibility transition. Previously this stale callback returned
      // while leaving renderFrame truthy, permanently blocking the next paint.
      // Treat it as a dropped frame and schedule a fresh commit instead.
      if (renderFrame === frame) renderFrame = 0;
      if (generation !== renderGeneration) {
        renderPending = true;
        if (!pageHidden() && !renderFrame) scheduleRender(executionOnly === true);
        return;
      }
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
  let goalPageHeal = { view: '', at: 0 };
  // Route/view switches only hide and show static panel containers. If a paint
  // or a competing update leaves the selected page's list/detail root empty
  // while the host state still carries content (for example an incremental
  // renderer released its rows but its memo was not invalidated), rebuild that
  // page once instead of leaving a permanently blank component.
  function emptyActiveGoalPage() {
    if (!hostState || hostState.mode !== 'goal' || !hostState.goal || workspaceMissing()) return '';
    if (draftFor().goalEditing && !busy) return '';
    const view = draftFor().view;
    const execution = executionState();
    if (view === 'agenda') {
      return Array.isArray(hostState.agenda?.items) && hostState.agenda.items.length && !byId('goal-agenda-list').children.length ? view : '';
    }
    if (view === 'board') {
      const snapshot = execution.blackboard ?? (lastBoardConversation === hostState?.conversation?.id ? lastBoardSnapshot : undefined);
      const expected = Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0;
      // The graph container always holds its toolbar once created, so check the
      // painted node buttons: a component that exists but produced no node means
      // the page is blank and must be rebuilt from the host projection.
      const painted = byId('blackboard-nodes').querySelectorAll('.graph-node, .graph-frontier').length;
      return expected > 0 && painted === 0 ? view : '';
    }
    if (view === 'notes') {
      return Array.isArray(hostState.goal.notes) && hostState.goal.notes.length && !byId('goal-notes-list').children.length ? view : '';
    }
    if (view === 'overview') {
      const hasLog = Boolean(execution.parts?.length || execution.activities?.length || execution.workers?.length || execution.result?.summary || execution.streamText || execution.logHistory?.length);
      return hasLog && !byId('goal-output-content').children.length ? view : '';
    }
    return '';
  }
  function reconcileActiveGoalPage() {
    const view = emptyActiveGoalPage();
    if (!view) return;
    const now = performance.now();
    // Throttle only repeats of the same page; switching to another blank page
    // must heal immediately or rapid navigation leaves it empty behind the mask.
    if (goalPageHeal.view === view && now - goalPageHeal.at < 500) return;
    goalPageHeal = { view, at: now };
    sectionViews.clear();
    lastNotes = ''; lastNotesSource = undefined;
    lastCriteria = ''; lastCriteriaSource = undefined;
    try { blackboardGraph?.dispose(); } catch { /* Recreate from the next paint. */ }
    blackboardGraph = undefined;
    try { goalExecutionLog?.dispose?.(); } catch { /* The panel rebuilds from the next paint. */ }
    goalExecutionLog = undefined;
    renderPending = true; fullRenderPending = true;
    scheduleRender();
  }
  function renderSafely(full) {
    keepAliveMark();
    const state = hostState, epoch = viewEpoch, generation = renderGeneration;
    const focusedBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    let succeeded = false;
    try {
      if (full) renderState();
      else {
        setAttribute(messages, 'aria-busy', String(busy));
        renderLiveComponents(true);
      }
      // Moving/rebuilding live rows can detach the focused control and leave
      // focus on <body>; restore it when the same control is still usable.
      if (focusedBefore?.isConnected && document.activeElement === document.body && !focusedBefore.closest('[hidden]')) {
        try { focusedBefore.focus({ preventScroll: true }); } catch { /* The control may have become inert. */ }
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
          repairPrimarySurface();
          if (window.UBOVMi18n?.locale === 'en') window.UBOVMi18n.apply(document.body);
          try { reconcileActiveGoalPage(); } catch { /* Self-heal must never fail the paint. */ }
        }
      }
    }
  }
  // Floating affordance for an agent-driven browser page the user cannot see.
  // The browser editor is never pulled forward automatically; this pill announces
  // the activity and its data-action=browser click opens the page.
  function renderBrowserAgentPeek(state) {
    const peek = byId('browser-agent-peek');
    if (!peek) return;
    const activity = state.browserAgent;
    peek.hidden = !activity;
    if (!activity) return;
    let where = '';
    try { where = new URL(activity.url).host || ''; } catch { where = ''; }
    setText(byId('browser-agent-peek-title'), t('Agent 正在操作浏览器'));
    setText(byId('browser-agent-peek-url'), where || activity.title || t('点击查看页面'));
    setText(byId('browser-agent-peek-open'), t('查看'));
    setProperty(peek, 'title', t('Agent 正在操作浏览器，点击查看页面'));
    setAttribute(peek, 'aria-label', t('Agent 正在操作浏览器，点击查看页面'));
  }

  function renderState() {
    const failures = [];
    for (const render of [renderChrome, renderLiveComponents]) {
      try { render(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }
  let pluginSlotsKey = '';
  function renderPluginSlots(state) {
    const slots = state?.plugins?.slots;
    const key = JSON.stringify(slots || null);
    if (key === pluginSlotsKey) return;
    pluginSlotsKey = key;
    const targets = {
      'topbar.actions': 'plugin-slot-topbar',
      'composer.toolbar': 'plugin-slot-composer',
      'welcome.shortcuts': 'plugin-slot-welcome',
      'status.item': 'plugin-slot-status'
    };
    for (const [slot, elementId] of Object.entries(targets)) {
      const host = byId(elementId);
      if (!host) continue;
      const items = Array.isArray(slots?.[slot]) ? slots[slot] : [];
      host.replaceChildren(...items.map(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plugin-action';
        button.textContent = item.label || item.id || '插件';
        button.title = item.title || item.label || '';
        button.addEventListener('click', () => {
          if (button.disabled) return;
          // Slot actions are host round-trips; disable briefly so a double click
          // cannot run the same plugin command twice.
          button.disabled = true;
          vscode.postMessage({
            action: 'pluginAction', sessionId: currentSessionId,
            pluginId: item.pluginId, slot, contributionId: item.id
          });
          setTimeout(() => { if (button.isConnected) button.disabled = false; }, 700);
        });
        return button;
      }));
      host.hidden = items.length === 0;
    }
  }

  function renderChrome() {
    const state = hostState;
    if (!state) return;
    renderNavigationFeedback();
    renderBrowserAgentPeek(state);
    renderPluginSlots(state);
    renderMode();
    byId('busy-status').hidden = !busy;
    setAttribute(messages, 'aria-busy', String(busy));
    const conversationTitle = state.conversation.title || '新对话';
    const displayedTitle = conversationTitle === '新对话' || conversationTitle === '新探索' ? t(conversationTitle) : conversationTitle;
    setText(byId('conversation-title'), displayedTitle);
    setProperty(byId('conversation-title'), 'title', displayedTitle);
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
        button.textContent = t(item.mode === 'goal' ? '目标：' : '来源聊天：') + item.title;
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
        const workspaceLabel = configured ? workspacePath : t(inProject ? '选择项目目录' : '选择工作空间');
        const workspaceButton = byId('workspace-name').closest('button');
        setText(byId('workspace-name'), workspaceLabel);
        workspaceButton.title = configured
          ? workspacePath + (inProject ? '\n' + t('点击切换当前项目的目录') : '\n' + t('点击切换当前会话的工作空间'))
          : (inProject ? t('为当前项目选择工作文件夹') : t('为当前会话选择工作文件夹'));
        workspaceButton.setAttribute('aria-label', configured
          ? (inProject ? t('切换项目目录：') : t('切换工作空间：')) + workspacePath
          : (inProject ? t('选择当前项目的目录') : t('选择当前会话的工作空间')));
        workspaceButton.dataset.configured = String(configured);
        const revealWorkspaceButton = byId('reveal-workspace');
        if (revealWorkspaceButton) revealWorkspaceButton.hidden = !configured;
        const goalRevealWorkspaceButton = byId('goal-more-reveal');
        if (goalRevealWorkspaceButton) goalRevealWorkspaceButton.hidden = !configured;
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
    const modelPicker = byId('composer-model');
    const choices = Array.isArray(state.modelSelection?.models) ? state.modelSelection.models : [];
    const selected = choices.includes(state.modelSelection?.selected) ? state.modelSelection.selected : choices[0];
    const defaultModel = state.modelSelection?.defaultModel || '';
    const providerId = state.modelSelection?.provider || state.provider?.provider || '';
    const pickerVisible = choices.length >= 2 && state.mode === 'assist';
    if (state.provider) {
      const providerLabel = state.provider.label || '未连接模型';
      setText(byId('provider-label'), pickerVisible ? '模型配置' : providerLabel);
      byId('provider-label').title = pickerVisible
        ? `打开模型配置\n服务商：${state.provider.provider || '已连接'}\n默认模型：${state.provider.defaultModel || providerLabel}`
        : state.provider.error || `当前模型：${providerLabel}\n打开模型配置`;
      // Show which Linux server this conversation's remote commands will use.
      const remote = state.ssh?.active?.label;
      const remoteNote = remote ? ` · 远程 ${remote}${state.ssh.active.scope === 'session' ? '（本会话）' : ''}` : '';
      setText(byId('connection-note'), configurationMissing() ? '先完成模型配置，就可以开始；远程连接可选' : '模型已就绪，直接输入即可' + remoteNote);
    }
    const key = JSON.stringify([choices, providerId, defaultModel]);
    if (modelPicker.dataset.choices !== key) {
      modelPicker.dataset.choices = key;
      fillModelPicker(modelPicker, choices, providerId, defaultModel);
    }
    modelPicker.hidden = !pickerVisible;
    modelPicker.title = pickerVisible
      ? `选择本轮对话使用的模型（继承 ${state.provider?.provider || '当前配置'}）` 
      : '选择本轮对话使用的模型';
    if (selected && modelPicker.value !== selected) modelPicker.value = selected;
  }
  function animateCurrentPage() {
    const state = hostState;
    if (!state) return;
    // Animate only after the target is committed and all loading masks are gone.
    const pageKey = `${currentSessionId}:${state.mode}:${draftFor().view}:${byId('goal-setup').hidden}`;
    if (renderedPageKey !== pageKey) {
      const previous = renderedPageKey;
      renderedPageKey = pageKey;
      cancelPageAnimation();
      const panel = byId('goal-' + draftFor().view);
      const panelVisible = state.mode === 'goal' ? byId('goal-setup').hidden : draftFor().view === 'notes';
      const surface = panelVisible && panel && !panel.hidden ? panel : byId(state.mode === 'goal' ? 'goal-mode' : 'assist-mode');
      if (!document.hidden && !reducedMotion.matches && !surface.hidden) {
        // Same-mode page switches move horizontally in the tab order; session
        // and mode changes still enter vertically. This keeps motion directional
        // without making fast switches feel like a full route reload.
        let dx = 0;
        if (state.mode === 'goal' && previous.startsWith(currentSessionId + ':goal:')) {
          const from = previous.split(':')[2], to = draftFor().view;
          const fromIndex = goalViews.indexOf(from), toIndex = goalViews.indexOf(to);
          // Board keeps the original vertical entry: the graph can be dragged
          // immediately after switching, so avoid a horizontal transform while
          // pointer coordinates are being captured.
          if (from !== 'board' && to !== 'board' && fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
            dx = toIndex > fromIndex ? 8 : -8;
          }
        }
        const animation = pageAnimation = surface.animate(dx
          ? [{ transform: `translateX(${dx}px)` }, { transform: 'translate(0, 0)' }]
          : [{ transform: 'translateY(8px)' }, { transform: 'translateY(0)' }],
        { duration: dx ? 200 : 240, easing: 'cubic-bezier(.22,1,.36,1)' });
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
    resumeRouteTransition();
    requestReadyResync();
  });
  window.addEventListener('blur', () => { if (draftTimer) persistDrafts(); });
  window.addEventListener('focus', () => resumeRouteTransition());
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-background', document.hidden);
    if (document.hidden) {
      if (draftTimer) persistDrafts();
      cancelVisualFrames();
    } else {
      resumeVisuals();
      resumeRouteTransition();
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
    catch (error) {
      // An exception before paint must not consume the host revision forever.
      // The next resync may resend exactly the same snapshot.
      stateOrder.restore(checkpoint);
      try { stateOrder.discard(event.data); } catch { /* Keep recovery path independent. */ }
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
    keepAliveMark();
    let state = event.data;
    if (projectSwitcher.handleMessage(state)) return;
    if (state?.type?.startsWith?.('openConversation') || state?.type === 'showUbomAlert' || state?.type === 'closeUbomModal') {
      void handleHostDialog(state);
      return;
    }
    if (state?.type === 'locale') { window.UBOVMi18n?.applyHostLocale?.(state.locale); return; }
    if (state?.type === 'windowFocused') {
      // OS focus restore must force a full paint: resumeVisuals() alone only
      // recommits live components, so a surface the compositor discarded while
      // the window was occluded stays blank until a resize proves it stale.
      if (!document.hidden) { cancelVisualFrames(); resumeVisuals(); }
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
      lastNotesSource = undefined;
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
      cleanup(() => teamPanel.close());
      cleanup(() => closeTeamMember({ restoreFocus: false }));
      cleanup(() => modalDialog.close());
      cleanup(() => { byId('goal-header-more').open = false; });
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
      // A board cached for the previous conversation must not stand in for the
      // next one (and must not suppress the missing-board checkpoint request).
      lastBoardSnapshot = undefined; lastBoardConversation = undefined;
      missingBoardRequest = { session: '', at: 0, pending: false };
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
  // Renderer liveness heartbeat. The workbench silently keeps an unpainted iframe
  // when this renderer dies or stops receiving frames, so the host must be able to
  // tell "timers still run" from "frames still arrive": requestAnimationFrame
  // callbacks stop when the compositor surface is dropped or the renderer freezes,
  // while timers keep running. Sampling one frame every two seconds costs almost
  // nothing while idle. A dead or frozen page cannot post at all; the host treats
  // that silence the same way (see host/ui/webview-liveness.cjs).
  let lastFrameAt = performance.now(), frameSampleArmed = false, frameSampleTimer = 0;
  function sampleFrame() {
    if (frameSampleArmed || frameSampleTimer) return;
    frameSampleArmed = true;
    const afterFrame = () => {
      frameSampleArmed = false;
      lastFrameAt = performance.now();
      frameSampleTimer = setTimeout(() => { frameSampleTimer = 0; sampleFrame(); }, 2000);
    };
    try { requestAnimationFrame(afterFrame); }
    catch { frameSampleArmed = false; frameSampleTimer = setTimeout(() => { frameSampleTimer = 0; sampleFrame(); }, 5000); }
  }
  function sendLiveness() {
    if (pageHidden()) return;
    const stalled = performance.now() - lastFrameAt > 6000;
    try { vscode.postMessage({ action: 'viewAlive', stalled }); } catch { /* Host may be closing. */ }
  }
  sampleFrame();
  setInterval(sendLiveness, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Frames stop while hidden by design; do not report that period as a stall.
    lastFrameAt = performance.now();
    sampleFrame();
    sendLiveness();
  });
  window.addEventListener('pageshow', () => {
    lastFrameAt = performance.now();
    sampleFrame();
    sendLiveness();
  });
  updateControls();
  requestInitialState();
})();
