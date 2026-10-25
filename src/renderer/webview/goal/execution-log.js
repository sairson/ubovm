(() => {
  'use strict';
  // 探索模式「思考与调度日志」. The panel is an IDE-native timeline, not a chat:
  // reasoning is readable without opening every card, worker lifecycle and worker
  // parts are chronological rows, activity rows are compact. Chat rendering
  // (markdown/tool cards) stays shared.
  const tr = value => window.UBOVMi18n?.t(value) ?? value;
  const element = (tag, cls, text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  const equal = (left, right) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const setRaw = (node, value) => { const text = String(value ?? ''); if (node && node.textContent !== text) node.textContent = text; };
  const setAttribute = (node, name, value) => {
    if (!node) return;
    const text = String(value);
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  };
  const setData = (node, name, value) => {
    if (!node) return;
    const text = String(value ?? '');
    if (node.dataset[name] !== text) node.dataset[name] = text;
  };
  const setHidden = (node, hidden) => { if (node && node.hidden !== hidden) node.hidden = hidden; };
  const partFields = ['id', 'type', 'text', 'name', 'args', 'output', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated', 'fallback', 'beforeTokens', 'afterTokens'];
  // Dispatch activities read as three families: planning, task dispatch, and
  // retrieval. The log colors each family's timeline dot so the schedule stays
  // scannable even when many tool labels collapse into "工具调用".
  const PLAN_LABELS = new Set(['Reason', 'todo']);
  const DISPATCH_LABELS = new Set(['spawn_worker', 'manage_workers', 'cancel_workers', 'wait_workers', 'stop_worker', 'start_worker', 'prompt_worker']);
  const SEARCH_PREFIXES = ['search_', 'inspect_', 'read_', 'list_', 'get_', 'scan_', 'inventory_', 'analyze_', 'navigate_'];
  const SEARCH_LABELS = new Set(['web_search', 'fetch_web_content']);
  const activityKind = label => PLAN_LABELS.has(label) ? 'plan'
    : DISPATCH_LABELS.has(label) ? 'dispatch'
      : (SEARCH_LABELS.has(label) || (typeof label === 'string' && SEARCH_PREFIXES.some(prefix => label.startsWith(prefix)))) ? 'search'
        : '';
  const pageSize = 120;
  // Merging consecutive Reason thinking makes the log readable. The bounds keep a
  // single card from growing without limit and keep pathological synthetic logs
  // (thousands of parts) on the legacy row-per-record path so paging stays exact.
  const mergeRawLimit = 240;
  const mergeMaxParts = 4;
  const mergeMaxChars = 800;
  const PROTOCOL_PLACEHOLDER = '[规划协议内容已折叠]';
  const PHASES = Object.freeze({ plan: '规划', dispatch: '派发', execute: '执行', result: '结果' });
  const WORKER_STATUS = Object.freeze({
    created: '已派发', pending: '排队中', queued: '排队中', running: '运行中', starting: '运行中',
    waiting: '等待中', completed: '已完成', failed: '失败', interrupted: '已停止', cancelled: '已停止'
  });
  const REASONING_STATUS = Object.freeze({ running: '思考中', completed: '已思考', interrupted: '思考已停止', failed: '思考已停止' });
  const ACTIVITY_ICONS = Object.freeze({ plan: '✦', dispatch: '⇢', search: '⌕' });

  // Plan protocols (intent/decision JSON) are machine payloads. Fold them into a
  // quiet marker so raw planning JSON never reads as prose.
  function sanitizeReasoning(value) {
    if (typeof value !== 'string' || !value) return '';
    let text = value.replace(/```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g, (match, language, body) => {
      if (/"intents"|"decision"|"plan"|"steps"|"actions"/i.test(body)) return PROTOCOL_PLACEHOLDER;
      return match;
    });
    text = text.replace(/(^|\n)([ \t]*)\{[^\n]*"(?:intents|decision|plan|steps|actions)"[^\n]*(?=\n|$)/g, (match, lead, indent) => lead + indent + PROTOCOL_PLACEHOLDER);
    return text.replace(/\n{3,}/g, '\n\n');
  }
  // Collapsed cards show the opening of the reasoning as plain text: markdown
  // markers removed, whitespace collapsed, bounded so it stays two lines.
  function previewText(value, limit = 260) {
    let text = String(value ?? '');
    text = text.replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/[*_~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > limit) text = text.slice(0, limit).trimEnd() + '…';
    return text;
  }
  function durationText(start, end) {
    if (!Number.isFinite(start) || start <= 0) return '';
    if (!Number.isFinite(end) || end < start) return '';
    const seconds = Math.max(0, (end - start) / 1000);
    return seconds < 60 ? (seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + 's'
      : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  }
  function normalizeReasonStatus(status) {
    if (status === 'running' || status === 'streaming') return 'running';
    if (status === 'failed') return 'failed';
    if (status === 'interrupted') return 'interrupted';
    return 'completed';
  }
  function phaseOf(entry) {
    if (entry.kind === 'result') return 'result';
    if (entry.kind === 'worker') return 'dispatch';
    if (entry.kind === 'reasoning') return 'plan';
    if (entry.kind === 'activity') return entry.activityKind === 'dispatch' ? 'dispatch' : entry.activityKind === 'plan' ? 'plan' : 'execute';
    if (entry.kind === 'thinking' || entry.kind === 'summary') return 'plan';
    if (entry.kind === 'text') return entry.source === 'reason' ? 'plan' : 'execute';
    return 'execute';
  }

  window.createGoalExecutionLog = (container, { actions, statusText, openWorker }) => {
    const rows = new Map(), dividers = new Map();
    let session = '', latestExecution, start = null, firstId;
    let follow = true, lastTop = 0, total = 0, followFrame = 0;
    const pager = element('div', 'goal-log-pager'); pager.hidden = true;
    const earlier = element('button', '', tr('较早日志')), newer = element('button', '', tr('较新日志')), latest = element('button', '', tr('最新日志')), range = element('span', '');
    for (const button of [earlier, newer, latest]) button.type = 'button';
    range.setAttribute('role', 'status'); pager.append(earlier, range, newer, latest); container.before(pager);
    const reasonToggle = document.getElementById('goal-log-reason-toggle');

    function nearBottom(threshold = 32) {
      return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    }
    function pinLatestPage() {
      if (start === null && firstId) start = Math.max(0, total - pageSize);
    }
    function cancelFollowFrame() {
      if (followFrame) { cancelAnimationFrame(followFrame); followFrame = 0; }
    }
    function stickFollow() {
      if (!follow || start !== null) return false;
      container.scrollTop = container.scrollHeight;
      lastTop = container.scrollTop;
      return true;
    }
    // Sibling visibility / flex height settle after the caller finishes this tick.
    // Re-stick on the next frame so growth is not left stranded at scrollTop 0.
    function scheduleFollow() {
      cancelFollowFrame();
      if (!stickFollow()) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        stickFollow();
      });
    }
    container.addEventListener('scroll', () => {
      if (container.scrollTop < lastTop - 1) {
        follow = false;
        cancelFollowFrame();
        pinLatestPage();
      } else if (container.scrollTop > lastTop + 1 && nearBottom()) {
        follow = true;
        if (start !== null && start >= Math.max(0, total - pageSize)) start = null;
      }
      lastTop = container.scrollTop;
      markFollow();
    }, { passive: true });
    function markFollow() {
      const value = follow && start === null ? 'true' : 'false';
      if (container.dataset.following !== value) container.dataset.following = value;
    }
    function releaseRow(row) {
      if (row.reason) window.UBOVMMarkdown?.release?.(row.reason.content);
      window.UBOVMMessage.release?.(row.body);
      row.root.remove();
    }
    function reset() {
      cancelFollowFrame();
      for (const row of rows.values()) releaseRow(row);
      rows.clear();
      for (const divider of dividers.values()) divider.root.remove();
      dividers.clear();
      container.replaceChildren(); latestExecution = undefined; firstId = undefined; start = null; session = '';
      follow = true; lastTop = 0; total = 0; pager.hidden = true;
      updateReasonToggle();
      markFollow();
    }
    function page(offset) {
      follow = false;
      start = Math.max(0, (start ?? Math.max(0, total - pageSize)) + offset);
      firstId = undefined;
      update(session, latestExecution);
      container.scrollTop = 0;
      lastTop = container.scrollTop;
      markFollow();
    }
    earlier.addEventListener('click', () => page(-pageSize)); newer.addEventListener('click', () => page(pageSize));
    function showLatest() {
      start = null; follow = true; firstId = undefined;
      if (latestExecution) update(session, latestExecution);
      scheduleFollow();
    }
    latest.addEventListener('click', () => showLatest());

    function createRow() {
      const root = element('article', 'goal-log-entry');
      const heading = element('header', 'goal-log-heading');
      const time = element('time', 'goal-log-time');
      const icon = element('span', 'goal-log-row-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.hidden = true;
      const label = element('strong');
      const state = element('span', 'goal-log-state');
      heading.append(time, icon, label, state);
      const body = element('div', 'goal-log-body');
      root.append(heading, body);
      return { root, heading, time, icon, label, state, body, kind: '', partKey: undefined, workerKey: undefined, reason: null, activityKind: '' };
    }
    function resetRow(row) {
      if (row.reason) { window.UBOVMMarkdown?.release?.(row.reason.content); row.reason = null; }
      window.UBOVMMessage.release?.(row.body);
      row.body.replaceChildren();
      row.partKey = undefined; row.workerKey = undefined; row.workerLine = undefined;
      row.icon.hidden = true;
      row.kind = '';
    }
    function setRowTime(row, entry) {
      setText(row.time, Number.isFinite(entry.time) ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
      const title = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleString('zh-CN') : '此记录未提供时间';
      if (row.time.title !== title) row.time.title = title;
    }

    // ---- Reasoning cards -------------------------------------------------
    function ensureReasoningCard(row) {
      if (row.reason) return row.reason;
      const details = element('details', 'thinking-card goal-log-reasoning');
      const summary = element('summary', 'thinking-summary goal-log-reasoning-summary');
      const head = element('span', 'goal-log-reasoning-head');
      const icon = element('span', 'goal-log-reasoning-icon thinking-indicator');
      icon.setAttribute('aria-hidden', 'true');
      const title = element('span', 'thinking-title', 'Reason 思考');
      const status = element('span', 'goal-log-reasoning-status');
      const duration = element('span', 'thinking-time goal-log-reasoning-duration');
      const time = element('span', 'goal-log-reasoning-time');
      const chevron = element('span', 'thinking-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
      head.append(icon, title, status, duration, time, chevron);
      const preview = element('span', 'goal-log-reasoning-preview');
      const previewTextNode = element('span', 'goal-log-reasoning-preview-text');
      const more = element('span', 'goal-log-reasoning-more', '展开阅读');
      preview.append(previewTextNode, more);
      summary.append(head, preview);
      const body = element('div', 'thinking-body goal-log-reasoning-body');
      body.tabIndex = 0; body.setAttribute('aria-label', '思考内容');
      const content = element('div', 'thinking-content md-content');
      body.append(content);
      details.append(summary, body);
      const view = {
        details, summary, body, content, title, status, duration, time, previewTextNode, more, row,
        openedByUser: false, collapsedByUser: false,
        renderedText: null, renderedStreaming: undefined, foldStatus: undefined
      };
      // Record the reader's intent synchronously: a native details toggle event is
      // queued as a task and a live state publish can win that race, which would
      // reopen a card the reader just collapsed.
      summary.addEventListener('click', () => {
        if (details.open) { view.collapsedByUser = true; view.openedByUser = false; }
        else { view.openedByUser = true; view.collapsedByUser = false; }
      });
      details.addEventListener('toggle', () => {
        if (details.open) renderReasoningBody(view);
        updateReasonToggle();
      });
      row.body.append(details);
      row.reason = view;
      return view;
    }
    function renderReasoningBody(view) {
      if (!view.details.open) return;
      const text = view.row.reasonText ?? '';
      const streaming = view.row.reasonStreaming === true;
      if (view.renderedText === text && view.renderedStreaming === streaming) return;
      const body = view.body;
      const visible = body.isConnected && !body.closest('[hidden]');
      const top = visible ? body.scrollTop : 0;
      // Keep the reader's inner scroll unless they were already at the end.
      const atEnd = visible && body.scrollHeight - body.clientHeight - top <= 3;
      try {
        window.UBOVMMarkdown?.update(view.content, text, { ...actions, streaming });
      } catch {
        view.content.textContent = text;
      }
      view.renderedText = text;
      view.renderedStreaming = streaming;
      if (visible) body.scrollTop = atEnd ? body.scrollHeight : top;
    }
    function renderReasoningRow(row, entry, execution, now) {
      const view = ensureReasoningCard(row);
      const parts = entry.parts;
      const running = entry.status === 'running';
      const startTime = parts.map(part => timestamp(part.startedAt)).find(Number.isFinite);
      const endTime = running ? now : Math.max(...parts.map(part => timestamp(part.endedAt)).filter(Number.isFinite), startTime ?? 0);
      const text = sanitizeReasoning(entry.rawText);
      row.reasonText = text;
      row.reasonStreaming = running;
      setRowTime(row, entry);
      setData(row.root, 'status', entry.status);
      row.label.textContent = tr('Reason 思考');
      setRaw(row.state, tr(running ? '思考中' : '已思考'));
      setRaw(view.title, tr('Reason 思考'));
      setData(view.status, 'status', entry.status);
      setRaw(view.status, tr(REASONING_STATUS[entry.status] || REASONING_STATUS.completed));
      setRaw(view.duration, durationText(startTime, endTime));
      setRaw(view.time, Number.isFinite(entry.time) ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '');
      setRaw(view.previewTextNode, previewText(text));
      setRaw(view.more, tr('展开阅读'));
      // Streaming reasoning opens by itself; a manual collapse survives later ticks.
      const previous = view.foldStatus;
      view.foldStatus = entry.status;
      let want = view.details.open;
      if (running) want = !view.collapsedByUser;
      else if (view.openedByUser) want = true;
      else if (view.collapsedByUser) want = false;
      else if (previous === 'running' || previous === undefined) want = false;
      if (view.details.open !== want) view.details.open = want;
      if (view.details.open) renderReasoningBody(view);
    }

    // ---- Worker lifecycle ------------------------------------------------
    function ensureWorkerBody(row) {
      // Status transitions reuse the same body: appending again would duplicate
      // the name button, chip and error text inside one lifecycle row.
      if (row.workerLine) return row;
      const line = element('div', 'goal-log-worker-line');
      const button = element('button', 'goal-log-worker'); button.type = 'button';
      const chip = element('span', 'goal-log-worker-status');
      const duration = element('span', 'goal-log-worker-duration');
      line.append(button, chip, duration);
      const description = element('p', 'goal-log-worker-description');
      const parent = element('small', 'goal-log-worker-parent');
      row.body.replaceChildren(line, description, parent);
      row.workerLine = { button, chip, duration, description, parent };
      return row;
    }
    function renderWorkerRow(row, entry, execution, now) {
      const worker = entry.worker;
      const status = worker.status || 'created';
      // Lifecycle duration spans dispatch (createdAt) to settlement, so a queued
      // worker also shows how long the schedule has been waiting.
      const duration = durationText(timestamp(worker.createdAt ?? worker.startedAt), timestamp(worker.finishedAt ?? (status === 'running' || status === 'waiting' ? now : undefined)));
      const key = [worker.id, worker.name, worker.description, worker.parentId, status, worker.finishedAt, duration].join('\u0001');
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      setRowTime(row, entry);
      setHidden(row.icon, true);
      setRaw(row.label, tr('分派任务'));
      setRaw(row.state, tr('已派发'));
      setData(row.root, 'status', status);
      setData(row.root, 'worker', worker.id);
      if (row.workerKey === key && row.workerLine && row.workerLocale === locale) return;
      ensureWorkerBody(row);
      row.workerKey = key;
      row.workerLocale = locale;
      const line = row.workerLine;
      const name = worker.name || worker.id;
      setRaw(line.button, name);
      line.button.title = tr('查看任务执行记录');
      setAttribute(line.button, 'aria-label', tr('查看任务执行记录') + '：' + name);
      line.button.onclick = () => openWorker(worker.id, line.button);
      setText(line.chip, tr(WORKER_STATUS[status] || status));
      setData(line.chip, 'status', status);
      setRaw(line.description, worker.description || '');
      setHidden(line.description, !worker.description);
      setRaw(line.duration, duration);
      setHidden(line.duration, !duration);
      setText(line.parent, worker.parentId ? tr('来自上级任务') : '');
      setHidden(line.parent, !worker.parentId);
    }

    // ---- Compact activity rows ------------------------------------------
    function renderActivityRow(row, entry) {
      setRowTime(row, entry);
      setData(row.root, 'status', entry.status || '');
      setHidden(row.icon, false);
      setRaw(row.icon, ACTIVITY_ICONS[entry.activityKind] || '·');
      setRaw(row.label, tr(entry.label));
      setRaw(row.state, entry.status ? tr(statusText(entry.status)) : '');
    }

    function partStatusLabel(status) {
      if (!status) return '';
      const label = status === 'streaming' ? '输出中' : statusText(status);
      return label === 'streaming' ? '输出中' : tr(label);
    }

    // ---- Shared part rows (text / tool / summary / generic thinking) -----
    function renderPartRow(row, entry, execution, kind) {
      setRowTime(row, entry);
      setHidden(row.icon, true);
      setRaw(row.label, tr(entry.label));
      setRaw(row.state, entry.status === 'created' ? tr('已派发') : partStatusLabel(entry.status));
      const key = [entry.kind, entry.text, Boolean(execution.busy && entry.kind === 'text'), ...partFields.map(field => entry.part?.[field])];
      const fresh = row.partKey === undefined;
      if (equal(row.partKey, key)) return;
      row.partKey = key;
      setData(row.root, 'status', entry.status || '');
      window.UBOVMMessage.update(row.body, entry.text || '', {
        ...actions, role: 'assistant', parts: entry.part ? [entry.part] : [], streaming: execution.busy && entry.kind === 'text'
      });
      if (entry.kind === 'thinking' && fresh && ['running', 'streaming'].includes(entry.part?.status)) {
        const thinking = row.body.querySelector('details');
        if (thinking && !thinking.open) thinking.open = true;
      }
    }

    function renderRow(row, entry, execution, now) {
      const kind = entry.kind;
      if (row.kind !== kind) {
        // A brand-new row has nothing to release; only an actual kind change needs
        // the previous body torn down (release calls stay proportional to removals).
        if (row.kind) resetRow(row);
        row.kind = kind;
        setData(row.root, 'kind', kind);
      }
      setData(row.root, 'logId', entry.id);
      setData(row.root, 'activity', entry.activityKind || '');
      setData(row.root, 'source', entry.source || '');
      setData(row.root, 'worker', entry.worker?.id || '');
      if (kind === 'reasoning') renderReasoningRow(row, entry, execution, now);
      else if (kind === 'worker') renderWorkerRow(row, entry, execution, now);
      else if (kind === 'activity') renderActivityRow(row, entry);
      else renderPartRow(row, entry, execution, kind);
    }

    // ---- Phase dividers --------------------------------------------------
    function dividerFor(run) {
      let view = dividers.get(run.key);
      if (!view) {
        const root = element('div', 'goal-log-phase');
        const label = element('span', 'goal-log-phase-label');
        const count = element('span', 'goal-log-phase-count');
        root.append(label, count);
        view = { root, label, count };
        dividers.set(run.key, view);
      }
      setData(view.root, 'phase', run.phase);
      setText(view.label, tr(PHASES[run.phase]));
      setRaw(view.count, String(run.count));
      return view.root;
    }
    function phaseRuns(entries) {
      if (!entries.length) return [];
      const phases = entries.map(phaseOf);
      if (new Set(phases).size <= 1) return [];
      const runs = [];
      for (let index = 0; index < entries.length; index++) {
        const phase = phases[index];
        const last = runs[runs.length - 1];
        if (!last || last.phase !== phase) runs.push({ phase, start: index, count: 0, key: 'phase:' + entries[index].id });
        runs[runs.length - 1].count++;
      }
      return runs;
    }

    // ---- Header expand/collapse all reasoning ---------------------------
    function reasoningRows() {
      const list = [];
      for (const row of rows.values()) if (row.kind === 'reasoning' && row.reason) list.push(row);
      return list;
    }
    function updateReasonToggle() {
      if (!reasonToggle) return;
      const list = reasoningRows();
      setHidden(reasonToggle, list.length === 0);
      if (!list.length) return;
      const anyCollapsed = list.some(row => !row.reason.details.open);
      setText(reasonToggle, tr(anyCollapsed ? '展开思考' : '收起思考'));
      setAttribute(reasonToggle, 'aria-pressed', String(!anyCollapsed));
      setAttribute(reasonToggle, 'title', tr(anyCollapsed ? '展开全部思考内容，便于快速浏览推理' : '收起全部思考内容，回到紧凑日志'));
    }
    function toggleAllReasoning() {
      const list = reasoningRows();
      if (!list.length) return;
      const expand = list.some(row => !row.reason.details.open);
      for (const row of list) {
        const view = row.reason;
        view.openedByUser = expand;
        view.collapsedByUser = !expand;
        if (view.details.open !== expand) view.details.open = expand;
        if (expand) renderReasoningBody(view);
      }
      updateReasonToggle();
    }
    reasonToggle?.addEventListener('click', toggleAllReasoning);

    // ---- Build entries ---------------------------------------------------
    function buildEntries(execution) {
      const base = [], parts = execution.parts || [];
      const inline = window.UBOVMTimeline.visibleTimelineParts(parts);
      const toolNames = new Set();
      window.UBOVMTimeline.eachToolPart({ execution }, part => { if (part.type === 'tool' && part.name) toolNames.add(part.name); });
      for (const part of inline) {
        if (part.source === 'worker') continue;
        if (!['text', 'thinking', 'tool', 'summary'].includes(part.type)) continue;
        base.push({ kind: 'part', part });
      }
      for (const worker of execution.workers || []) {
        // The log is Reason's narration. Worker thinking/output stays in the
        // worker detail panel; the timeline only records dispatch/lifecycle
        // metadata so updates never appear inside an old dispatch row.
        base.push({ kind: 'worker', worker });
      }
      for (const [index, activity] of (execution.activities || []).entries()) {
        if (activity.label === 'skill.loaded' && activity.status === 'completed') continue;
        if (toolNames.has(activity.label)) continue;
        base.push({ kind: 'activity', activity, index });
      }
      const hasTextPart = inline.some(part => part.type === 'text');
      if (!hasTextPart && execution.streamText) base.push({ kind: 'stream', text: execution.streamText });
      if (execution.status === 'completed' && execution.result?.summary) base.push({ kind: 'result', text: execution.result.summary });
      const allowMerge = base.length <= mergeRawLimit;
      const entries = [];
      for (const item of base) {
        if (item.kind === 'part' && item.part.type === 'thinking' && item.part.source === 'reason') {
          const part = item.part;
          const text = typeof part.text === 'string' ? part.text : '';
          const previous = entries[entries.length - 1];
          if (allowMerge && previous && previous.kind === 'reasoning' && previous.parts.length < mergeMaxParts && previous.rawText.length + text.length <= mergeMaxChars) {
            previous.parts.push(part);
            previous.rawText += (previous.rawText && text ? '\n\n' : '') + text;
          } else {
            entries.push({ id: 'part:' + part.id, time: timestamp(part.startedAt), kind: 'reasoning', parts: [part], rawText: text, source: 'reason' });
          }
          continue;
        }
        if (item.kind === 'part') {
          const part = item.part;
          entries.push({
            id: 'part:' + part.id, time: timestamp(part.startedAt), kind: part.type, part,
            activityKind: part.type === 'tool' ? activityKind(part.name) : '',
            source: part.source || '',
            label: part.type === 'thinking' ? '思考' : part.type === 'tool' ? '工具' : part.type === 'summary' ? (window.UBOVMMessage?.summaryScopeLabel?.(part.kinds) ?? '上下文摘要') : part.source === 'reason' ? '结论' : '输出',
            status: part.status
          });
          continue;
        }
        if (item.kind === 'worker') {
          const worker = item.worker;
          entries.push({ id: 'worker:' + worker.id, time: timestamp(worker.createdAt ?? worker.startedAt), kind: 'worker', worker, status: worker.status || 'created', source: 'worker' });
          continue;
        }
        if (item.kind === 'activity') {
          const activity = item.activity;
          entries.push({
            id: 'activity:' + (activity.key || item.index), time: timestamp(activity.timestamp), kind: 'activity',
            label: activity.label === 'Reason' ? '调度' : window.UBOVMTimeline.displayActivityLabel(activity.label),
            status: activity.status, activityKind: activityKind(activity.label)
          });
          continue;
        }
        if (item.kind === 'stream') { entries.push({ id: 'stream', kind: 'text', label: '规划 · 输出', text: item.text }); continue; }
        entries.push({ id: 'result', kind: 'result', label: '执行总结', text: item.text, status: 'completed' });
      }
      const now = Date.now();
      for (const entry of entries) {
        if (entry.kind !== 'reasoning') continue;
        const statuses = entry.parts.map(part => part.status);
        entry.status = statuses.some(status => status === 'running' || status === 'streaming') ? 'running'
          : statuses.some(status => status === 'failed') ? 'failed'
            : statuses.some(status => status === 'interrupted') ? 'interrupted' : 'completed';
        const ends = entry.parts.map(part => timestamp(part.endedAt)).filter(Number.isFinite);
        entry.time = entry.time ?? timestamp(entry.parts[0]?.startedAt);
        entry.end = statuses.length ? (ends.length ? Math.max(...ends) : timestamp(entry.parts[0]?.startedAt)) : undefined;
        entry.now = now;
        entry.label = 'Reason 思考';
      }
      entries.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
      return entries;
    }

    function update(sessionId, execution) {
      if (session !== sessionId) { reset(); session = sessionId; }
      latestExecution = execution;
      const entries = buildEntries(execution);
      total = entries.length;
      // Keep an older page stable as live records arrive; evict its DOM on paging.
      if (firstId && start !== null) { const index = entries.findIndex(entry => entry.id === firstId); if (index >= 0) start = index; }
      const offset = start === null ? Math.max(0, total - pageSize) : Math.min(start, Math.max(0, total - 1));
      const visibleEntries = entries.slice(offset, offset + pageSize);
      firstId = visibleEntries[0]?.id;
      pager.hidden = total <= pageSize;
      earlier.disabled = offset === 0; newer.disabled = offset + pageSize >= total;
      range.textContent = window.UBOVMi18n?.t(`${total ? offset + 1 : 0}–${Math.min(total, offset + pageSize)} / ${total} 条`) ?? `${total ? offset + 1 : 0}–${Math.min(total, offset + pageSize)} / ${total} 条`;
      latest.disabled = start === null;
      const now = Date.now();
      const kept = new Set(), usedDividers = new Set(), sequence = [];
      for (const entry of visibleEntries) {
        kept.add(entry.id);
        let row = rows.get(entry.id);
        if (!row) { row = createRow(); rows.set(entry.id, row); }
        renderRow(row, entry, execution, now);
      }
      // A single chronological timeline: worker thinking/results and Reason
      // steps interleave by timestamp, so phase bands would reorder the story.
      const runs = [];
      if (runs.length) {
        for (const run of runs) {
          usedDividers.add(run.key);
          sequence.push({ divider: dividerFor(run) });
          for (let index = 0; index < run.count; index++) sequence.push({ row: rows.get(visibleEntries[run.start + index].id) });
        }
      } else {
        for (const entry of visibleEntries) sequence.push({ row: rows.get(entry.id) });
      }
      // Place nodes in order without detaching unchanged rows unnecessarily.
      let anchor = container.firstChild;
      for (const item of sequence) {
        const node = item.divider || item.row.root;
        if (node === anchor) { anchor = anchor.nextSibling; continue; }
        container.insertBefore(node, anchor);
      }
      for (const [id, row] of rows) if (!kept.has(id)) { releaseRow(row); rows.delete(id); }
      for (const [key, divider] of dividers) if (!usedDividers.has(key)) { divider.root.remove(); dividers.delete(key); }
      updateReasonToggle();
      // Stick to the newest content while following; growth alone must not pin an older page.
      if (follow && start === null) scheduleFollow();
      markFollow();
      return entries.length;
    }
    return {
      update, reset, showLatest, alignFollow: scheduleFollow,
      dispose() { cancelFollowFrame(); reset(); pager.remove(); reasonToggle?.removeEventListener?.('click', toggleAllReasoning); }
    };
  };
})();
