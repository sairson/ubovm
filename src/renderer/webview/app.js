(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
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
  let renderedPageKey = '';
  let firstContentPaint = false;
  let busy = false;
  let showingConversation = false;
  let composingPrompt = false;
  let lastCriteria = '';
  let lastNotes = '';
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
  let latestFrame = 0;
  function refreshLatest() {
    if (latestFrame) return;
    latestFrame = requestAnimationFrame(() => {
      latestFrame = 0;
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
  let renderPending = false;
  let draftTimer = 0;
  let inputFrame = 0;
  let workerPanelWidth = 440;
  let goalWorkerWidth = 300;
  let goalPanelLayout;
  const statusLabels = { idle: '尚未执行', starting: '正在准备', running: '执行中', completed: '已完成', interrupted: '已停止', failed: '执行失败', pending: '待执行', queued: '排队中', waiting: '等待协作结果' };
  const phaseLabels = { chat: '正在回复', reason: 'Reason 正在规划', plan: '制定计划', execute: '执行工具', replan: '检查进展', conclude: '整理结论', done: '已完成' };
  const executionState = () => hostState?.execution || {};
  const statusText = value => statusLabels[value] || value || '尚未执行';
  const phaseText = value => phaseLabels[value] || value || '';
  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }
  function sectionUnchanged(key, value) {
    const serialized = JSON.stringify(value);
    if (sectionViews.get(key) === serialized) return true;
    sectionViews.set(key, serialized);
    return false;
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

  // Drafts are separate from host-owned data, so repeated state updates never
  // replace an in-progress edit. Each conversation has its own draft fields.
  try {
    const saved = vscode.getState();
    goalPanelLayout = saved?.goalPanelLayout;
    if (Number.isFinite(saved?.goalWorkerWidth) && saved.goalWorkerWidth >= 240 && saved.goalWorkerWidth <= 800) goalWorkerWidth = saved.goalWorkerWidth;
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
    if (!currentSessionId) return;
    draftFor().touchedAt = Date.now();
    const entries = [...drafts.entries()].filter(([id]) => id).sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(-100);
    try { vscode.setState({ ...vscode.getState(), drafts: Object.fromEntries(entries), workerPanelWidth, goalWorkerWidth, goalPanelLayout }); } catch { /* Keep the live draft if persistence is temporarily unavailable. */ }
  }
  function scheduleDraftPersistence() {
    draftFor().touchedAt = Date.now();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDrafts, 180);
  }
  function scheduleInput() {
    if (!inputFrame) inputFrame = requestAnimationFrame(() => { inputFrame = 0; updateInput(); });
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
  function request(action, payload = {}, onSuccess, onError, timeoutMs = 120000) {
    if (!currentSessionId && action !== 'setTheme') return;
    if ((action === 'setMode' || action === 'newChat') && navigationPending()) return;
    const requestId = 'ui-' + Date.now().toString(36) + '-' + (++requestCounter);
    const sessionId = currentSessionId;
    const timer = setTimeout(() => {
      if (!pending.delete(requestId)) return;
      const error = new Error('等待操作结果超时。操作可能仍在执行，请先确认状态再重试。');
      showError(window.UBOVMErrors.normalize(error, action), sessionId); updateControls(); onError?.(error);
    }, timeoutMs);
    pending.set(requestId, { action, sessionId, criterionId: payload.criterionId, onSuccess, onError, timer });
    showError('');
    updateControls();
    try { vscode.postMessage({ ...payload, action, sessionId, requestId }); }
    catch { clearTimeout(timer); pending.delete(requestId); showError(window.UBOVMErrors.normalize('操作未能发送，请重试。', action), sessionId); updateControls(); onError?.(new Error('操作未能发送，请重试。')); return; }
    return requestId;
  }
  function renderRequest(action, payload) {
    return new Promise((resolve, reject) => {
      const id = request(action, payload, resolve, reject, 10000);
      if (!id) reject(new Error('当前会话尚未准备完成。'));
    });
  }
  const messageActions = {
    onCopy: text => renderRequest('copyText', { text }),
    onOpenLink: (href, options = {}) => renderRequest('openMessageLink', { href, ...(Number.isSafeInteger(options.rootIndex) ? { rootIndex: options.rootIndex } : {}) }).catch(error => { showError(error.message); return false; }),
    onPreviewHtml: (source, button) => window.UBOVMHtmlPreview.open(source, { returnFocus: button || document.activeElement, onCopy: text => renderRequest('copyText', { text }) })
  };
  const workerPanel = window.createWorkerPanel(messageActions, { initialWidth: workerPanelWidth, onWidthChange: width => { workerPanelWidth = width; persistDrafts(); } });
  window.createOverviewSplit({ initialWidth: goalWorkerWidth, initialLayout: goalPanelLayout, onWidthChange: width => { goalWorkerWidth = width; persistDrafts(); }, onLayoutChange: value => { goalPanelLayout = value; persistDrafts(); } });
  function updateInput() {
    if (hostState?.mode !== 'goal') resizeInput(input, Math.max(64, Math.min(220, Math.floor(window.innerHeight * .28))));
    updateSubmit(submit, input);
    updateComposer();
  }
  function updateComposer() {
    const sending = hasPending('prompt');
    const selectedMode = draftFor().approvalMode ?? (hostState?.requireToolApproval === false ? 'auto' : 'manual');
    for (const option of approvalMode.elements) option.checked = option.value === selectedMode;
    approvalMode.disabled = busy || sending || navigationPending();
    form.dataset.state = busy ? 'running' : sending ? 'sending' : 'idle';
    input.placeholder = busy ? '先写下后续问题，执行结束后发送…' : '描述任务，或提出一个问题…';
    const status = byId('composer-status');
    if (status) setText(status, hostState?.recovering ? '正在恢复执行记录 · 可以先写草稿' : hasPending('cancelRun') ? '正在停止…' : busy ? '执行中 · 可以继续写草稿' : sending ? '正在发送…' : '');
    const shortcut = byId('prompt-shortcut');
    if (shortcut) shortcut.hidden = busy || sending;
    const count = byId('prompt-count');
    if (count) {
      count.hidden = input.value.length < 7200;
      setText(count, input.value.length.toLocaleString() + ' / 8,000');
      count.dataset.limit = String(input.value.length >= 8000);
    }
  }
  function contextPending() { return hasPending('attachFile') || hasPending('clearFileContext'); }
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
    button.dataset.running = String(busy);
    button.setAttribute('aria-label', busy ? '停止执行' : '发送任务');
    button.title = busy ? '停止当前执行' : '发送（Enter）';
    button.querySelector('path').setAttribute('d', busy ? 'M6 6h12v12H6Z' : 'M12 19V5m-6 6 6-6 6 6');
    button.disabled = !currentSessionId || hostState?.recovering || navigationPending() || (busy ? hasPending('cancelRun') : configurationMissing() || hasPending('prompt') || hasPending('runGoal') || hasPending('resumeRun') || contextPending() || !field.value.trim() || field.value.length > field.maxLength);
  }
  function updateControls() {
    const unavailable = !currentSessionId || navigationPending();
    const promptPending = hasPending('prompt');
    input.disabled = unavailable;
    byId('new-chat').disabled = unavailable || hasPending();
    byId('new-goal').disabled = unavailable || hasPending();
    byId('navigation-loading').hidden = !navigationPending();
    document.body.dataset.navigating = String(navigationPending());
    byId('main-content').setAttribute('aria-busy', String(!hostState || navigationPending()));
    for (const id of ['new-chat', 'new-goal']) byId(id).setAttribute('aria-busy', String(navigationPending()));
    byId('attach-file').disabled = unavailable || busy || promptPending || contextPending();
    if (byId('remove-context')) byId('remove-context').disabled = unavailable || busy || promptPending || contextPending();
    document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = unavailable || busy || promptPending; });
    const saving = hasPending('saveGoal');
    objectiveInput.disabled = unavailable || busy || saving;
    factsInput.disabled = unavailable || busy || saving;
    criteriaInput.disabled = unavailable || busy || saving;
    byId('goal-save').disabled = unavailable || workspaceMissing() || busy || saving || hasPending('toggleGoalCriterion') || !objectiveInput.value.trim();
    byId('goal-workspace-required').hidden = !workspaceMissing();
    byId('goal-save').textContent = saving ? '正在保存…' : '保存目标';
    byId('goal-cancel').disabled = unavailable || saving;
    byId('goal-edit').disabled = unavailable || busy || saving || hasPending('toggleGoalCriterion');
    const runPending = hostState?.recovering || hasPending('runGoal') || hasPending('resumeRun') || promptPending;
    const canResume = executionState().canResume === true;
    byId('goal-run').hidden = busy || canResume;
    byId('goal-run').disabled = unavailable || configurationMissing() || runPending || saving || !hostState?.goal || executionState().status === 'completed';
    setText(byId('goal-run'), executionState().status === 'completed' ? '已完成' : runPending ? '正在准备…' : ['failed', 'interrupted'].includes(executionState().status) ? '重新执行' : '开始执行');
    byId('goal-stop').hidden = !busy;
    byId('goal-stop').disabled = unavailable || hasPending('cancelRun');
    byId('goal-stop').textContent = hasPending('cancelRun') ? '正在停止…' : '停止执行';
    byId('goal-resume').hidden = busy || !canResume;
    byId('goal-resume').disabled = unavailable || configurationMissing() || runPending;
    setText(byId('goal-resume'), hasPending('resumeRun') ? '正在恢复…' : executionState().status === 'completed' ? '恢复结果' : '继续执行');
    byId('assist-resume').hidden = busy || !canResume;
    byId('assist-resume').disabled = unavailable || configurationMissing() || runPending;
    const savingNote = hasPending('addGoalNote');
    noteInput.disabled = unavailable || savingNote;
    byId('goal-add-note').disabled = unavailable || !hostState?.goal || savingNote || !noteInput.value.trim();
    byId('goal-add-note').textContent = savingNote ? '正在保存…' : '保存笔记';
    byId('note-new').disabled = unavailable || !hostState?.goal;
    setText(byId('note-new'), noteInput.value ? '继续草稿' : '＋ 新建笔记');
    setText(byId('note-length'), noteInput.value.length.toLocaleString() + ' / 2,000');
    setText(byId('note-draft-status'), savingNote ? '正在保存到当前目标…' : busy ? '任务执行中也可保存笔记，关闭后保留草稿。' : '关闭后保留草稿');
    byId('criteria-list').querySelectorAll('input').forEach(checkbox => {
      checkbox.disabled = unavailable || busy || saving || hasPending('toggleGoalCriterion', checkbox.dataset.criterionId);
    });
    updateInput();
  }
  function showConversation(hasMessages) {
    if (showingConversation === hasMessages) return;
    const hadFocus = document.activeElement === input;
    showingConversation = hasMessages;
    byId('empty-state').hidden = hasMessages;
    conversation.hidden = !hasMessages;
    byId('compose-dock').hidden = !hasMessages;
    byId(hasMessages ? 'composer-chat-slot' : 'composer-home-slot').appendChild(form);
    if (hadFocus) input.focus({ preventScroll: true });
    updateInput();
  }
  function sameParts(left, right) {
    if (left === right) return true;
    if (!Array.isArray(left) || !Array.isArray(right)) return !left?.length && !right?.length;
    return left.length === right.length && left.every((part, index) => ['id', 'type', 'text', 'name', 'status', 'args', 'output', 'startedAt', 'endedAt', 'truncated', 'source', 'workerId', 'fallback', 'beforeTokens', 'afterTokens'].every(key => part[key] === right[index]?.[key]));
  }
  function renderApprovals(view) {
    view.approvals ??= new Map();
    const records = hostState?.toolApprovals || [];
    const ids = new Set(records.map(record => record.id));
    let changed = false;
    for (const [id, card] of view.approvals) if (!ids.has(id)) { card.element.remove(); view.approvals.delete(id); changed = true; }
    for (const record of records) {
      let card = view.approvals.get(record.id);
      if (!card) {
        const element = document.createElement('article'); element.className = 'approval-card';
        const title = document.createElement('strong'); title.textContent = record.toolName;
        const status = document.createElement('span'); status.className = 'approval-status'; status.setAttribute('role', 'status');
        const header = document.createElement('div'); header.className = 'approval-header'; header.append(title, status);
        const worker = document.createElement('p'); worker.className = 'approval-worker'; worker.textContent = '执行者：' + record.workerId;
        const details = document.createElement('details'); details.open = true;
        const summary = document.createElement('summary'); summary.textContent = '调用参数';
        const args = document.createElement('pre'); args.textContent = record.args; args.tabIndex = 0;
        details.append(summary, args);
        const actions = document.createElement('div'); actions.className = 'approval-actions';
        const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = '允许执行'; approve.className = 'approval-allow';
        const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = '拒绝';
        actions.append(deny, approve);
        const hint = document.createElement('span'); hint.textContent = '仅授权本次调用'; actions.prepend(hint);
        element.append(header, worker, details, actions); messages.append(element);
        card = { element, status, actions, approve, deny, state: '', sending: false };
        view.approvals.set(record.id, card);
        for (const [button, decision] of [[approve, 'approve'], [deny, 'deny']]) button.addEventListener('click', () => {
          if (card.state !== 'pending' || card.sending) return;
          card.sending = true; approve.disabled = deny.disabled = true;
          request('toolApproval', { approvalId: record.id, decision }, () => { card.sending = false; }, () => {
            card.sending = false; approve.disabled = deny.disabled = card.state !== 'pending';
          });
        });
        changed = true;
      }
      if (card.state !== record.status) {
        card.state = record.status; card.element.dataset.status = record.status;
        card.status.textContent = ({ pending: '等待你的批准', approved: '已允许', denied: '已拒绝', cancelled: '已取消' })[record.status] || '已失效';
        card.actions.hidden = record.status !== 'pending';
        card.approve.disabled = card.deny.disabled = card.sending || record.status !== 'pending';
        changed = true;
      }
    }
    return changed;
  }
  function renderMessages(items) {
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
    const liveParts = !represented && (busy || ['failed', 'interrupted'].includes(execution.status) || execution.canResume) ? executionParts : [];
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
      container.replaceChildren();
      view = { sessionId: currentSessionId, entries: [], stream: null, busy: undefined };
      messageViews.set(container, view);
    }
    let changed = view.busy !== busy || view.entries.length !== safeMessages.length;
    const createMessage = (role, text, parts, streaming = false) => {
      const article = document.createElement('article');
      article.className = 'message ' + role + (streaming ? ' streaming-message' : '');
      if (streaming) article.dataset.streaming = 'true';
      const heading = document.createElement('div');
      heading.className = 'message-heading';
      heading.textContent = role === 'user' ? '你' : 'UBOVM';
      const body = document.createElement('div');
      body.className = 'message-text';
      window.UBOVMMessage.update(body, text, { ...messageActions, role, parts, streaming });
      article.append(heading, body);
      return { article, heading, body, role, text, parts };
    };
    // Keep published history in place while only the transient reply grows.
    // Reading selections, focus, and scroll anchors survive token updates.
    for (const [index, item] of historyChanged ? safeMessages.entries() : []) {
      let entry = view.entries[index];
      const publishedIds = new Set((item.parts || []).map(part => part.id));
      const promoted = item.role === 'assistant' && view.stream && (publishedIds.size && view.stream.parts?.some(part => publishedIds.has(part.id)) || !publishedIds.size && view.stream.text === item.text);
      if (promoted) {
        entry?.article.remove();
        entry = view.stream; view.stream = null;
        entry.article.classList.remove('streaming-message'); entry.article.removeAttribute('data-streaming');
        window.UBOVMMessage.update(entry.body, item.text, { ...messageActions, role: item.role, parts: item.parts, streaming: false });
        entry.text = item.text; entry.parts = item.parts;
        view.entries[index] = entry;
        changed = true;
      } else if (!entry) {
        entry = createMessage(item.role, item.text, item.parts);
        view.entries.push(entry);
        if (entry.article.parentElement !== container) container.insertBefore(entry.article, view.stream?.article || null);
        changed = true;
      } else if (entry.role !== item.role || entry.text !== item.text || !sameParts(entry.parts, item.parts)) {
        entry.article.className = 'message ' + item.role;
        setText(entry.heading, item.role === 'user' ? '你' : 'UBOVM');
        window.UBOVMMessage.update(entry.body, item.text, { ...messageActions, role: item.role, parts: item.parts, streaming: false });
        entry.role = item.role; entry.text = item.text; entry.parts = item.parts;
        changed = true;
      }
    }
    while (view.entries.length > safeMessages.length) view.entries.pop().article.remove();
    if (hasLive) {
      if (!view.stream) {
        view.stream = createMessage('assistant', streamText, liveParts, busy);
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
      view.stream.article.remove(); view.stream = null;
      changed = true;
    }
    changed = renderApprovals(view) || changed;
    view.busy = busy;
    view.source = items; view.history = safeMessages; view.firstPartId = firstPartId; view.represented = represented;
    showConversation(safeMessages.length > 0 || hasLive || busy || Boolean(execution.error) || execution.canResume === true || execution.workers?.length > 0);
    refreshLatest();
    if (!changed) return;
    cancelScroll();
    if (shouldScroll) {
      const sessionId = currentSessionId;
      const expectedTop = scroller.scrollTop;
      pendingScroll = { scroller, sessionId, frame: requestAnimationFrame(() => {
        pendingScroll = undefined;
        if (sessionId !== currentSessionId || hostState?.mode === 'goal' || scroller.scrollTop < expectedTop - 1) return;
        scroller.scrollTop = scroller.scrollHeight;
        position.top = scroller.scrollTop; position.following = true;
      }) };
    }
  }
  function renderMode() {
    const goalMode = hostState?.mode === 'goal';
    document.body.dataset.mode = goalMode ? 'goal' : 'assist';
    document.title = goalMode ? 'UBOVM · 探索工作台' : 'UBOVM · 协助';
    byId('assist-mode').hidden = goalMode;
    byId('goal-mode').hidden = !goalMode;
    byId('goal-identity').hidden = !goalMode;
    byId('goal-header-actions').hidden = !goalMode;
    byId('goal-view-switcher').hidden = !goalMode;
    if (!goalMode) byId('goal-view-switcher').open = false;
    byId('new-goal').hidden = !goalMode;
    byId('new-chat').hidden = goalMode;
    byId('review-code-changes').hidden = goalMode;
    byId('assist-notes-toggle').hidden = goalMode;
    renderModuleActions();
    updateInput();
  }
  function renderModuleActions() {
    const goalMode = hostState?.mode === 'goal';
    const editing = workspaceMissing() || !hostState?.goal || draftFor().goalEditing && !busy;
    const view = goalMode && !editing ? draftFor().view : '';
    byId('goal-edit').hidden = view !== 'overview';
    byId('new-goal').hidden = !goalMode || Boolean(view && view !== 'overview');
    byId('goal-board-actions').hidden = view !== 'board';
    byId('goal-notes-actions').hidden = goalMode ? view !== 'notes' : draftFor().view !== 'notes';
    byId('note-new').hidden = !goalMode;
  }
  function renderGoalView() {
    renderModuleActions();
    const selected = draftFor().view;
    const label = { overview: '概览', board: '黑板', workers: 'Worker', notes: '笔记' }[selected];
    setText(byId('goal-current-view'), label);
    const currentIcon = byId('goal-current-icon');
    if (currentIcon.dataset.view !== selected) {
      currentIcon.replaceChildren(byId('goal-tab-' + selected).querySelector('svg').cloneNode(true));
      currentIcon.dataset.view = selected;
    }
    byId('goal-view-switcher').querySelector('summary').setAttribute('aria-label', '当前页面：' + label + '，切换页面');
    byId('goal-workspace').dataset.view = selected;
    for (const view of goalViews) {
      const active = view === selected;
      const tab = byId('goal-tab-' + view);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      byId('goal-' + view).hidden = !active;
    }
  }
  function setGoalView(view) {
    if (!goalViews.includes(view) || draftFor().view === view) return;
    const scroller = byId('goal-panels');
    goalViewScroll.set(currentSessionId + ':' + draftFor().view, { top: scroller.scrollTop, following: scrollPositions.get(scroller).following });
    if (goalViewScroll.size > 400) goalViewScroll.delete(goalViewScroll.keys().next().value);
    cancelScroll();
    if (view !== 'notes') closeNoteEditor();
    draftFor().view = view;
    persistDrafts();
    // A route change must synchronize the outer mode and workspace as well as
    // the tab. Partial execution renders can otherwise retain a hidden ancestor.
    scroller.scrollTop = 0;
    renderState();
    cancelScroll();
    const saved = goalViewScroll.get(currentSessionId + ':' + view);
    scroller.scrollTop = saved?.top ?? 0;
    scrollPositions.set(scroller, { top: scroller.scrollTop, following: saved?.following ?? true });
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
    const serialized = JSON.stringify(criteria);
    if (serialized === lastCriteria) return;
    lastCriteria = serialized;
    const focusedId = document.activeElement?.dataset.criterionId;
    const list = document.createDocumentFragment();
    const board = document.createDocumentFragment();
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
      const card = document.createElement('article');
      card.className = 'board-item';
      card.dataset.done = String(criterion.done === true);
      const status = document.createElement('span');
      status.textContent = criterion.done ? '已确认' : '待确认';
      const body = document.createElement('p');
      body.textContent = criterion.text;
      card.append(status, body);
      board.appendChild(card);
    }
    byId('criteria-list').replaceChildren(list);
    byId('goal-board-criteria').replaceChildren(board);
    byId('criteria-empty').hidden = criteria.length > 0;
    byId('goal-board-empty').hidden = criteria.length > 0;
    if (focusedId) [...byId('criteria-list').querySelectorAll('input')].find(item => item.dataset.criterionId === focusedId)?.focus({ preventScroll: true });
  }
  function renderNotes(notes) {
    const serialized = JSON.stringify(notes);
    if (serialized === lastNotes) return;
    lastNotes = serialized;
    const fragment = document.createDocumentFragment();
    for (const note of [...notes].reverse()) fragment.appendChild(noteRow(note, 'user'));
    byId('goal-notes-list').replaceChildren(fragment);
    filterNotes();
  }
  function noteRow(note, source) {
    const text = typeof note.content === 'string' ? note.content : typeof note.text === 'string' ? note.text : '';
    const key = source + ':' + (note.id ?? JSON.stringify([note.created_at ?? note.createdAt, text]));
    const article = document.createElement('article'); article.className = 'goal-note';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'note-select'; button.setAttribute('aria-pressed', 'false');
    const time = document.createElement('time'), timestamp = new Date(note.created_at ?? note.createdAt);
    if (!Number.isNaN(timestamp.getTime())) {
      time.dateTime = timestamp.toISOString();
      time.textContent = timestamp.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    const preview = document.createElement('p'); preview.textContent = text.length > 240 ? text.slice(0, 240) + '…' : text;
    button.append(preview, time); article.append(button);
    noteEntries.set(article, { key, text, searchText: text.toLocaleLowerCase(), source, date: time.textContent });
    button.addEventListener('click', () => {
      selectedNoteKey = key; renderNoteReader(article);
      byId('goal-notes').dataset.reading = 'true';
      byId('note-reader-body').focus({ preventScroll: true });
    });
    return article;
  }
  function renderNoteReader(article) {
    const entry = article && noteEntries.get(article);
    for (const row of document.querySelectorAll('.note-select')) row.setAttribute('aria-pressed', String(noteEntries.get(row.parentElement)?.key === entry?.key));
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
    try {
      window.UBOVMMessage.update(body, entry?.text ?? '', { ...messageActions, role: 'assistant', streaming: false });
    } catch (error) {
      console.warn('Note formatting failed; showing original text.', error);
      window.UBOVMMessage.update(body, entry?.text ?? '', { role: 'user' });
      setText(byId('note-reader-meta'), '格式加载失败，已显示笔记原文');
    }
    body.hidden = !entry;
    renderedNoteKey = key;
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
    for (const button of document.querySelectorAll('[data-note-source]')) button.setAttribute('aria-pressed', String(button.dataset.noteSource === noteSource));
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
  function renderActivities(container, activities) {
    const visible = activities.slice(-8);
    if (sectionUnchanged(container.id, visible)) return;
    const fragment = document.createDocumentFragment();
    for (const item of visible.reverse()) {
      if (!item || typeof item.label !== 'string') continue;
      const row = document.createElement('div');
      row.className = 'activity-row';
      const text = document.createElement('p');
      text.textContent = item.label + (item.status ? ' · ' + statusText(item.status) : '');
      const time = document.createElement('time');
      const timestamp = new Date(item.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        time.dateTime = timestamp.toISOString();
        time.textContent = timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      row.append(text, time);
      fragment.appendChild(row);
    }
    container.replaceChildren(fragment);
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
  function renderBlackboard(snapshot) {
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    if (sectionUnchanged('blackboard', [snapshot?.sessionId, snapshot?.revision, snapshot?.goal, nodes])) return;
    byId('blackboard-empty').hidden = nodes.length > 0;
    byId('blackboard-nodes').hidden = nodes.length === 0;
    blackboardGraph ??= window.createBlackboardGraph(byId('blackboard-nodes'), { factText, statusText, actionsContainer: byId('goal-board-actions'),
      onDetail: hostState?.nativeBlackboardSidebar ? (detail, reveal) => vscode.postMessage({ action: 'blackboardDetail', sessionId: currentSessionId, detail, reveal }) : undefined });
    blackboardGraph.update(snapshot);
    byId('blackboard-revision').textContent = Number.isInteger(snapshot?.revision) ? '修订 ' + snapshot.revision : '等待执行';
  }
  function renderAgentNotes(memory) {
    const source = memory?.notes;
    const notes = (Array.isArray(source) ? source : source && typeof source === 'object' ? Object.values(source) : []).filter(note => note && (typeof note.content === 'string' || typeof note.text === 'string'));
    if (sectionUnchanged('agent-notes', notes.slice(-50))) return;
    const fragment = document.createDocumentFragment();
    for (const note of notes.slice(-50).reverse()) fragment.appendChild(noteRow(note, 'agent'));
    byId('agent-notes-list').replaceChildren(fragment);
    filterNotes();
  }
  function renderExecution() {
    const execution = executionState();
    const explorationRuns = Array.isArray(execution.explorationRuns) ? execution.explorationRuns.filter(run => run.busy === true) : [];
    byId('exploration-runs').hidden = explorationRuns.length === 0;
    if (!explorationRuns.length) byId('exploration-runs').open = false;
    setText(byId('exploration-run-count'), explorationRuns.length + ' 运行中');
    if (!sectionUnchanged('exploration-runs', explorationRuns)) {
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
        status.textContent = statusText(run.status) + (phase ? ' · ' + phase : '') + ` · Worker ${run.activeWorkers || 0} 运行中 / ${run.workerCount || 0} 个`;
        row.append(open, status);
        if (run.error) { const error = document.createElement('p'); error.className = 'execution-error'; error.textContent = run.error; row.append(error); }
        fragment.append(row);
      }
      byId('exploration-run-list').replaceChildren(fragment);
    }
    const status = execution.status || (busy ? 'running' : 'idle');
    const phase = phaseText(execution.phase);
    const error = typeof execution.error === 'string' ? execution.error : typeof execution.error?.message === 'string' ? execution.error.message : '';
    const label = statusText(status) + (phase && busy ? ' · ' + phase : '');
    setText(byId('goal-run-status'), label);
    byId('goal-run-status').dataset.status = status;
    setText(byId('busy-status'), label);
    // The active inline step already explains the wait; do not add a second
    // spinner and generic execution label below the same conversation.
    const inlineBusy = (execution.parts || []).some(part => ['tool', 'thinking', 'summary'].includes(part.type) && part.status === 'running');
    byId('busy-status').hidden = !busy || inlineBusy;
    const goalMode = hostState?.mode === 'goal';
    const selected = draftFor().view;
    const headerStatus = byId('header-execution-status');
    headerStatus.hidden = !goalMode || !busy || byId('goal-workspace').hidden;
    const headerLabel = selected === 'board' ? '正在推进目标，黑板将在有新结果时更新…' : selected === 'notes' ? '执行中，新的工作笔记会自动出现…' : label;
    setText(headerStatus, headerLabel);
    headerStatus.title = headerLabel;
    byId('goal-run-status').hidden = busy;
    setText(byId('execution-phase'), label);
    const captions = {
      idle: '点击“开始执行”，由 Reason 规划并派发 Worker。',
      starting: '正在加载会话、模型与工具。',
      running: 'Reason 与 Worker 正在推进目标。你可以切换会话，执行会继续。',
      completed: execution.canResume ? '执行已完成，结果尚未显示。点击“恢复结果”补齐回复。' : '本轮执行已完成。结论与证据保存在共享黑板中，可追加指令继续。',
      interrupted: execution.canResume ? '执行已停止，检查点已保存。点击“继续执行”恢复。' : '执行已停止。',
      failed: execution.canResume ? '执行失败。修复错误后，可从已有检查点继续。' : '执行失败，请检查错误后重试。'
    };
    setText(byId('execution-caption'), captions[status] || '');
    for (const id of ['execution-error', 'assist-execution-error']) {
      setText(byId(id), error ? window.UBOVMErrors.text(error) : '');
      byId(id).hidden = !error;
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
    byId('execution-integrations').hidden = !integrationText;
    const workers = Array.isArray(execution.workers) ? execution.workers : [];
    workerPanel.update({ sessionId: currentSessionId, workers, goalMode, error: execution.workerViewError?.message });
    const activities = Array.isArray(execution.activities) ? execution.activities : [];
    const toolParts = (execution.parts || []).filter(part => ['tool', 'summary'].includes(part.type));
    const names = new Set(toolParts.map(part => part.name));
    const remainingActivities = activities.filter(item => !names.has(item.label));
    if (goalMode && selected === 'overview' && !byId('goal-output-content').parentElement.closest('[hidden]')) {
      goalExecutionLog ??= window.createGoalExecutionLog(byId('goal-output-content'), { actions: messageActions, statusText, openWorker: (id, button) => workerPanel.show(id, button) });
      const count = goalExecutionLog.update(currentSessionId, execution);
      byId('goal-output-content').hidden = !count;
      byId('goal-output-empty').hidden = count > 0;
      setText(byId('goal-output-empty'), busy ? '正在启动，执行日志将在事件产生后显示。' : '执行后，Reason Agent 思考、Worker 派发和工具调用会按顺序显示在这里。');
      setText(byId('goal-output-title'), '思考与调度日志');
      setText(byId('goal-output-status'), label + ' · ' + count + ' 条记录');
    }
    if (!goalMode) renderActivities(byId('assist-activities'), remainingActivities);
    byId('assist-execution').hidden = !remainingActivities.length && !error && !execution.canResume;
    if (goalMode && selected === 'board') renderBlackboard(execution.blackboard);
    if (selected === 'notes') renderAgentNotes(execution.memory);
  }
  function renderGoal() {
    const goalMode = hostState?.mode === 'goal';
    byId('goal-notes').setAttribute('aria-labelledby', goalMode ? 'goal-tab-notes' : 'assist-notes-toggle');
    byId('goal-notes').setAttribute('role', goalMode ? 'tabpanel' : 'region');
    byId('goal-notes').querySelector('.notebook-filters').hidden = !goalMode;
    if (!goalMode) {
      const showingNotes = draftFor().view === 'notes';
      byId('assist-mode').hidden = showingNotes;
      byId('goal-mode').hidden = !showingNotes;
      byId('goal-mode').setAttribute('aria-label', '协助笔记');
      byId('goal-setup').hidden = true;
      byId('goal-workspace').hidden = !showingNotes;
      setText(byId('assist-notes-toggle'), showingNotes ? '返回对话' : '笔记');
      byId('assist-notes-toggle').setAttribute('aria-expanded', String(showingNotes));
      renderGoalView();
      if (showingNotes) renderNotes([]);
      return;
    }
    byId('goal-mode').setAttribute('aria-label', '探索模式');
    const goal = hostState?.goal;
    const editing = workspaceMissing() || !goal || (draftFor().goalEditing && !busy);
    renderModuleActions();
    byId('goal-header-actions').hidden = editing;
    byId('goal-view-switcher').hidden = editing;
    if (editing) byId('goal-view-switcher').open = false;
    byId('goal-identity').dataset.hasGoal = String(Boolean(goal));
    byId('goal-objective').hidden = !goal;
    byId('goal-intro').hidden = Boolean(goal);
    byId('goal-editor').hidden = !editing;
    byId('goal-setup').hidden = !editing;
    byId('goal-editor-title').textContent = goal ? '编辑目标' : '定义你的目标';
    byId('goal-cancel').hidden = !goal || workspaceMissing();
    byId('goal-workspace').hidden = editing;
    renderGoalView();
    if (goal) {
      const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
      const notes = Array.isArray(goal.notes) ? goal.notes : [];
      setText(byId('goal-objective'), goal.objective);
      byId('goal-objective').title = goal.objective;
      setText(byId('goal-facts-detail'), goal.initialFacts || '');
      byId('goal-initial-facts').hidden = !goal.initialFacts;
      setText(byId('goal-board-objective'), goal.objective);
      setText(byId('goal-progress'), criteria.filter(item => item.done).length + ' / ' + criteria.length);
      byId('goal-completion').max = Math.max(1, criteria.length);
      byId('goal-completion').value = criteria.filter(item => item.done).length;
      byId('goal-completion').hidden = criteria.length === 0;
      setText(byId('goal-note-count'), String(notes.length));
      setText(byId('goal-nav-notes'), String(notes.length));
      setText(byId('goal-provider-label'), hostState.provider?.label || '未连接模型');
      if (['overview', 'board'].includes(draftFor().view)) renderCriteria(criteria);
      if (draftFor().view === 'notes') renderNotes(notes);
    }
  }
  function sendPrompt() {
    const field = input;
    const draftKey = 'assist';
    const text = field.value.trim();
    if (configurationMissing() || hostState?.mode === 'goal' || !text || field.value.length > field.maxLength || busy || navigationPending() || hasPending('prompt') || hasPending('runGoal') || hasPending('resumeRun') || composingPrompt || contextPending()) return;
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
  function resumeRun() {
    if (!configurationMissing() && !busy && executionState().canResume === true && !hasPending('resumeRun') && !navigationPending()) request('resumeRun');
  }
  approvalMode.addEventListener('change', event => {
    const value = event.target.value;
    if (approvalMode.disabled || !['auto', 'manual'].includes(value)) return;
    draftFor().approvalMode = value;
    persistDrafts();
  });
  form.addEventListener('submit', event => { event.preventDefault(); if (busy) cancelRun(); else sendPrompt(); });
  input.addEventListener('compositionstart', () => { composingPrompt = true; });
  input.addEventListener('compositionend', () => { composingPrompt = false; });
  input.addEventListener('blur', () => { composingPrompt = false; });
  input.addEventListener('input', () => { draftFor().assist = input.value; scheduleDraftPersistence(); scheduleInput(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendPrompt(); }
  });
  byId('new-chat').addEventListener('click', () => {
    if (!hasPending()) request('newChat');
  });
  byId('new-goal').addEventListener('click', () => {
    if (!hasPending()) request('newChat');
  });
  byId('goal-run').addEventListener('click', () => {
    if (hostState?.goal && !busy && !hasPending('runGoal') && !navigationPending()) request('runGoal');
  });
  byId('goal-stop').addEventListener('click', cancelRun);
  byId('goal-resume').addEventListener('click', resumeRun);
  byId('assist-resume').addEventListener('click', resumeRun);
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
    byId('goal-edit').focus();
  });
  byId('goal-editor').addEventListener('submit', event => {
    event.preventDefault();
    if (workspaceMissing()) { showError('请先在会话顶部选择工作空间，再保存目标。'); return; }
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
  noteInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !byId('goal-add-note').disabled) {
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
  let fullRenderPending = false;
  function scheduleRender(executionOnly = false) {
    if (executionOnly !== true) fullRenderPending = true;
    renderPending = true;
    if (renderFrame || document.hidden || byId('settings-dialog').open) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (document.hidden || byId('settings-dialog').open) return;
      renderPending = false;
      const full = fullRenderPending; fullRenderPending = false;
      if (full) renderState();
      else {
        messages.setAttribute('aria-busy', String(busy));
        if (hostState.mode !== 'goal') renderMessages(Array.isArray(hostState.messages) ? hostState.messages : []);
        renderGoal(); renderExecution(); updateControls();
      }
    });
  }
  function renderState() {
    const state = hostState;
    if (!state) return;
    byId('page-loading').hidden = true;
    document.body.dataset.loading = 'false';
    byId('main-content').setAttribute('aria-busy', String(navigationPending()));
    clearTimeout(initialLoadTimer);
    renderMode();
    byId('busy-status').hidden = !busy;
    messages.setAttribute('aria-busy', String(busy));
    if (state.mode !== 'goal') renderMessages(Array.isArray(state.messages) ? state.messages : []);
    setText(byId('conversation-title'), state.conversation.title || '新对话');
    byId('conversation-title').title = state.conversation.title || '新对话';
    if (state.context) {
      if (typeof state.context.workspace === 'string') {
        const workspacePath = state.context.workspace;
        const configured = state.context.workspaceConfigured !== false && Boolean(workspacePath);
        const workspaceLabel = configured ? workspacePath : '选择工作空间';
        const workspaceButton = byId('workspace-name').closest('button');
        setText(byId('workspace-name'), workspaceLabel);
        workspaceButton.title = configured ? workspacePath + '\n点击切换当前会话的工作空间' : '为当前会话选择工作文件夹';
        workspaceButton.setAttribute('aria-label', configured ? '切换工作空间：' + workspacePath : '选择当前会话的工作空间');
        workspaceButton.dataset.configured = String(configured);
        setText(byId('goal-workspace-name'), configured ? workspaceLabel : '尚未选择工作空间');
        byId('goal-workspace-name').title = configured ? workspacePath : '';
      }
    }
    const file = typeof state.context?.file === 'string' ? state.context.file : '';
    const selection = state.context?.fileSource === 'selection' ? state.context.selectionLabel || '' : '';
    const source = selection ? '已添加选中代码' : state.context?.fileSource === 'active' ? '当前文件' : '已添加文件';
    const contextLabel = file ? file.split(/[\\/]/).pop() + (selection ? ' · ' + selection : '') : '';
    setText(byId('context-label'), contextLabel);
    setText(byId('context-caption'), '项目上下文');
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
      setText(byId('connection-note'), configurationMissing() ? '请先完成模型和 SSH 连接配置，再运行 IDE 任务' : '准备好，开始你的下一步');
    }
    renderGoal();
    renderExecution();
    updateControls();
    // Animate navigation once, never on token streaming or background updates.
    if (!firstContentPaint) {
      firstContentPaint = true;
      requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({ action: 'contentReady' })));
    }
    const pageKey = `${currentSessionId}:${state.mode}:${draftFor().view}`;
    if (renderedPageKey !== pageKey) {
      renderedPageKey = pageKey;
      const surface = byId(state.mode === 'goal' ? 'goal-mode' : 'assist-mode');
      surface.getAnimations().filter(animation => animation.id === 'page-enter').forEach(animation => animation.cancel());
      if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const animation = surface.animate([{ transform: 'translateY(3px)' }, { transform: 'none' }],
          { duration: 200, easing: 'cubic-bezier(.22,1,.36,1)' });
        animation.id = 'page-enter';
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
  window.addEventListener('pagehide', () => { if (draftTimer) persistDrafts(); });
  window.addEventListener('blur', () => { if (draftTimer) persistDrafts(); });
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-background', document.hidden);
    if (document.hidden) {
      if (draftTimer) persistDrafts();
      cancelScroll();
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    } else if (renderPending) scheduleRender();
  });
  window.addEventListener('ubovm-settings-visibility', event => {
    document.body.classList.toggle('settings-visible', event.detail?.open === true);
    if (!event.detail?.open && hostState) scheduleRender();
  });
  window.addEventListener('ubovm-overview-visibility', () => {
    if (!hostState) return;
    if (!document.hidden && !byId('settings-dialog').open) renderExecution();
    else scheduleRender(true);
  });
  window.addEventListener('message', event => {
    const state = event.data;
    if (state?.type === 'selectBlackboardNode') {
      if (state.sessionId === currentSessionId) blackboardGraph?.select(state.id);
      return;
    }
    if (state?.type === 'closeBlackboardDetails') { blackboardGraph?.closeDetail(); return; }
    if (state?.type === 'themeState') return;
    if (state?.type === 'focusInput') {
      if (state.sessionId && state.sessionId !== currentSessionId) return;
      requestAnimationFrame(() => (hostState?.mode === 'goal' ? (byId('goal-setup').hidden ? byId('goal-view-switcher').querySelector('summary') : objectiveInput) : input).focus());
      return;
    }
    if (state?.type === 'uiResult') {
      const operation = pending.get(state.requestId);
      if (!operation) return;
      clearTimeout(operation.timer);
      pending.delete(state.requestId);
      if (state.ok) operation.onSuccess?.();
      else {
        const failure = window.UBOVMErrors.normalize(state.failure || state.error || '操作失败，请重试。你的草稿仍然保留。', operation.action);
        const message = window.UBOVMErrors.text(failure);
        operation.onError?.(new Error(message));
        showError(failure, operation.action === 'setMode' ? currentSessionId : operation.sessionId);
      }
      updateControls();
      return;
    }
    if (state?.type === 'executionState') {
      if (!hostState || state.conversationId !== currentSessionId) return;
      hostState = { ...hostState, execution: state.execution, busy: state.busy };
      busy = Boolean(state.busy || state.execution?.busy || ['starting', 'running'].includes(state.execution?.status));
      scheduleRender(true);
      return;
    }
    if (!state || state.type !== 'state') return;
    const sessionId = typeof state.conversation?.id === 'string' ? state.conversation.id : '';
    if (!sessionId) return;
    const changedSession = sessionId !== currentSessionId;
    if (changedSession && draftTimer) persistDrafts();
    if (changedSession) closeNoteEditor();
    hostState = state;
    currentSessionId = sessionId;
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
      lastCriteria = ''; lastNotes = ''; forceScroll = true;
      restoreFields();
      byId('goal-setup').scrollTop = 0;
      byId('goal-panels').scrollTop = 0;
      showError(errors.get(sessionId) || '');
    }
    busy = Boolean(state.busy || state.execution?.busy || ['starting', 'running'].includes(state.execution?.status));
    scheduleRender();
  });
  let initialLoadTimer;
  function watchInitialLoad() {
    clearTimeout(initialLoadTimer);
    initialLoadTimer = setTimeout(() => {
      if (hostState) return;
      setText(byId('page-loading-label'), '会话仍在加载，请稍候或重新载入。');
      byId('page-retry').hidden = false;
    }, 10000);
  }
  byId('page-retry').addEventListener('click', () => {
    if (hostState) return;
    byId('page-retry').hidden = true;
    setText(byId('page-loading-label'), '正在重新加载会话与工作区…');
    watchInitialLoad();
    vscode.postMessage({ action: 'ready' });
  });
  watchInitialLoad();
  updateControls();
  vscode.postMessage({ action: 'ready' });
})();
