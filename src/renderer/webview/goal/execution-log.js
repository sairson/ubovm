(() => {
  'use strict';
  // 探索模式「思考与调度日志」v8.
  // - Each Reason review is ONE round: every persisted reason-conclusion part
  //   closes a round, and the trailing review (no conclusion yet) stays live.
  //   Runs without conclusion markers keep the old one-round-per-run shape.
  // - Reason thinking collapses into ONE DSH-style line per review: the line keeps
  //   changing while streaming and never auto-opens. Clicking it expands the full
  //   Markdown in place; the header action toggles every round's reasoning body.
  // - Non-thinking output (text/tool/summary/result) keeps rendering through the
  //   shared assist message renderer (UBOVMMessage.update). Scheduling metadata
  //   (activities, worker lifecycle) stays as compact secondary rows.
  const tr = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const element = (tag, cls, text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  const equal = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && right.every((value, index) => Object.is(value, left[index]));
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
  const pageSize = 120;
  const maxRounds = 20;
  const maxEntries = 6000;
  // Reason thinking is rendered as the compact reasoning line (not in the
  // assist-style block); everything else keeps the shared message renderer.
  const contentTypes = new Set(['text', 'tool', 'summary']);
  // Reason's own management calls are scheduling metadata, not task evidence.
  // They merge into one expandable line per round instead of stacking as cards.
  const REASON_TOOL_NAMES = new Set([
    'list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'wait_worker_sleep',
    'exploration_graph', 'exploration_todo', 'submit_decision'
  ]);
  const PROTOCOL_PLACEHOLDER = '[规划协议内容已折叠]';
  const REASONING_LIMIT = 160;
  // Dispatch activities read as three families: planning, task dispatch, and
  // retrieval. Compact metadata rows color the timeline dot by family.
  const PLAN_LABELS = new Set(['Reason', 'todo']);
  const DISPATCH_LABELS = new Set(['spawn_worker', 'manage_workers', 'cancel_workers', 'wait_workers', 'stop_worker', 'start_worker', 'prompt_worker']);
  const SEARCH_PREFIXES = ['search_', 'inspect_', 'read_', 'list_', 'get_', 'scan_', 'inventory_', 'analyze_', 'navigate_'];
  const SEARCH_LABELS = new Set(['web_search', 'fetch_web_content']);
  const activityKind = label => PLAN_LABELS.has(label) ? 'plan'
    : DISPATCH_LABELS.has(label) ? 'dispatch'
      : (SEARCH_LABELS.has(label) || (typeof label === 'string' && SEARCH_PREFIXES.some(prefix => label.startsWith(prefix)))) ? 'search'
        : '';
  const WORKER_STATUS = Object.freeze({
    created: '已派发', pending: '排队中', queued: '排队中', running: '运行中', starting: '运行中',
    waiting: '等待中', completed: '已完成', failed: '失败', interrupted: '已停止', cancelled: '已停止'
  });
  const FINAL_WORKER_STATUS = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
  // Glyphs such as ⌕ fall back to unrelated Latin letters on some Windows font
  // stacks; the dispatch log draws the three activity families as inline SVG.
  const ACTIVITY_ICON_PATHS = Object.freeze({
    plan: ['M8 2.4l1.7 3.9 3.9 1.7-3.9 1.7L8 13.6l-1.7-3.9L2.4 8l3.9-1.7z'],
    dispatch: ['M3 8h9.4', 'M9.2 4.4L12.8 8l-3.6 3.6'],
    search: ['M7.1 3.1a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M10.1 10.1l3 3']
  });
  const ACTIVITY_ICON_NS = 'http://www.w3.org/2000/svg';
  function activityIcon(kind) {
    const svg = document.createElementNS(ACTIVITY_ICON_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ACTIVITY_ICON_PATHS[kind] || []) {
      const path = document.createElementNS(ACTIVITY_ICON_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  const ACTIVE_PART_STATUS = ['running', 'streaming'];
  const ACTIVE_WORKER_STATUS = ['running', 'starting', 'waiting', 'queued', 'pending', 'created'];

  function durationText(start, end) {
    if (!Number.isFinite(start) || start <= 0) return '';
    if (!Number.isFinite(end) || end < start) return '';
    const seconds = Math.max(0, (end - start) / 1000);
    return seconds < 60 ? (seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + 's'
      : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  }
  function errorText(value) {
    if (typeof value === 'string') return value;
    return value && typeof value === 'object' ? String(value.message ?? '') : '';
  }
  function workerError(worker) { return errorText(worker?.error).trim(); }
  function workerResult(worker) {
    if (typeof worker?.result !== 'string') return '';
    return worker.result.trim().slice(0, 240);
  }
  // One signature per rendered content part: cheap scalar facts only, so a tick
  // never serializes historical tool output just to detect changes.
  function partSignature(part) {
    if (!part) return null;
    const text = part.type === 'text' || part.type === 'thinking' || part.type === 'summary'
      ? (typeof part.text === 'string' ? part.text : '')
      : '';
    return [part.id, part.type, part.name, part.status, part.source, text,
      typeof part.output === 'string' ? part.output.length : -1,
      Number.isFinite(Number(part.startedAt)) ? Number(part.startedAt) : -1,
      Number.isFinite(Number(part.endedAt)) ? Number(part.endedAt) : -1,
      part.truncated === true ? 1 : 0, part.background === true ? 1 : 0];
  }
  function visibleContentParts(execution) {
    const parts = window.UBOVMTimeline?.visibleTimelineParts?.(execution?.parts || []) || [];
    return parts.filter(part => part && part.source !== 'worker' && contentTypes.has(part.type));
  }
  function reasoningPartsOf(execution) {
    const parts = window.UBOVMTimeline?.visibleTimelineParts?.(execution?.parts || []) || [];
    return parts.filter(part => part && part.type === 'thinking' && part.source !== 'worker');
  }
  // Plan protocols and fenced payloads are machine noise in a one-line preview.
  function foldProtocols(value) {
    let text = String(value ?? '');
    text = text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g, (match, body) => {
      if (/"intents"|"decision"|"plan"|"steps"|"actions"\s*:/i.test(body) || /^\s*[[{]/.test(body)) return PROTOCOL_PLACEHOLDER;
      return match;
    });
    text = text.replace(/(^|\n)[ \t]*\{(?:[^\n]*"(?:intents|decision|plan|steps|actions)"\s*:)[^\n]*(?=\n|$)/g, (match, lead) => lead + PROTOCOL_PLACEHOLDER);
    return text.replace(/\n{3,}/g, '\n\n');
  }
  // The collapsed line shows the newest meaningful reasoning line: Markdown and
  // protocol fragments stripped, whitespace collapsed and clamped with an ellipsis.
  function reasoningPreview(value) {
    const stripped = foldProtocols(value)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/[*_~|]/g, '');
    const lines = stripped.split('\n').map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line && line !== PROTOCOL_PLACEHOLDER);
    let line = lines.length ? lines[lines.length - 1] : '';
    if (!line) line = '';
    if (line.length > REASONING_LIMIT) line = line.slice(0, REASONING_LIMIT - 1).trimEnd() + '…';
    return line;
  }
  function reasoningText(parts) {
    return foldProtocols(parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n\n')).trim();
  }
  function toolNamesOf(execution) {
    const names = new Set();
    try {
      window.UBOVMTimeline.eachToolPart({ execution }, part => { if (part.type === 'tool' && part.name) names.add(part.name); });
    } catch { /* Metadata dedupe is best effort. */ }
    return names;
  }
  function firstPartStart(execution) {
    for (const part of execution?.parts || []) {
      const value = timestamp(part?.startedAt);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  }
  function roundStartedAt(execution) {
    const started = timestamp(execution?.startedAt);
    if (Number.isFinite(started)) return started;
    return firstPartStart(execution) ?? Date.now();
  }
  // One Reason review ends with exactly one reason-conclusion text part. The log
  // counts each review as its own round ("reason 每思考一次 = 一轮"): conclusions
  // partition a run into chronological rounds, and the trailing segment is the
  // review currently thinking (no conclusion yet). Runs written before
  // conclusions were persisted keep the previous one-round-per-run behavior.
  function reviewCutsOf(execution) {
    const cuts = [];
    for (const part of execution?.parts || []) {
      if (!part || part.type !== 'text' || part.source !== 'reason') continue;
      if (typeof part.id !== 'string' || !part.id.startsWith('reason-conclusion:')) continue;
      const at = timestamp(part.startedAt);
      if (Number.isFinite(at)) cuts.push(at);
    }
    return cuts.sort((left, right) => left - right);
  }
  function reviewIndexOf(time, cuts) {
    if (!Array.isArray(cuts) || !cuts.length) return 0;
    const at = timestamp(time);
    if (!Number.isFinite(at)) return 0;
    let index = 0;
    for (const cut of cuts) {
      if (cut < at) index += 1;
      else break;
    }
    return index;
  }
  function executionStatus(execution) {
    return typeof execution?.status === 'string' && execution.status ? execution.status : 'running';
  }
  function wasActive(execution) {
    const status = executionStatus(execution);
    return status === 'running' || status === 'starting';
  }
  // Archive freezes the last seen snapshot. A leftover running part/worker from a
  // finished round is shown as interrupted instead of a ghost "running" state.
  function freezeExecution(execution) {
    const active = wasActive(execution);
    const status = active ? 'interrupted' : executionStatus(execution);
    const parts = (execution?.parts || []).map(part => {
      if (!part || typeof part !== 'object') return part;
      const copy = { ...part };
      // An archived round is final: leftover running records were interrupted by
      // the new run, whether the last snapshot still said "running" or not.
      if (ACTIVE_PART_STATUS.includes(copy.status)) copy.status = 'interrupted';
      return copy;
    });
    const workers = (execution?.workers || []).map(worker => {
      if (!worker || typeof worker !== 'object') return worker;
      const copy = { ...worker };
      if (ACTIVE_WORKER_STATUS.includes(copy.status)) copy.status = 'interrupted';
      return copy;
    });
    return {
      status, busy: false, parts, workers,
      activities: Array.isArray(execution?.activities) ? execution.activities.slice() : [],
      streamText: typeof execution?.streamText === 'string' ? execution.streamText : '',
      result: execution?.result, startedAt: execution?.startedAt, finishedAt: execution?.finishedAt
    };
  }
  function looksLikeNewRun(previous, execution) {
    if (!previous) return false;
    const status = executionStatus(execution);
    const previousStatus = executionStatus(previous);
    const parts = Array.isArray(execution?.parts) ? execution.parts : [];
    const previousParts = Array.isArray(previous?.parts) ? previous.parts : [];
    if (!['running', 'starting'].includes(status)) return false;
    if (parts.length > 0) return false;
    if (previousParts.length > 0) return true;
    return !['running', 'starting', 'idle', ''].includes(previousStatus);
  }
  const roundHeaderText = round => tr('第 {0} 轮', round.number);

  window.createGoalExecutionLog = (container, { actions, statusText, openWorker }) => {
    const rows = new Map(), roundHeaders = new Map(), activityDividers = new Map(), taskCards = new Map();
    // Rounds the reader folded away stay folded across streaming ticks and
    // paging; they are cleared when the log switches session or evicts a round.
    const collapsedRounds = new Set();
    const expandedRounds = new Set();
    // Long runs read better with only the live round open: when the log holds
    // more than a handful of rounds, non-current rounds default to their folded
    // one-line summary until the reader opens one or asks for all of them.
    const COMPACT_ROUND_THRESHOLD = 6;
    let compactRounds = false;
    // The log opens with every round expanded; the header action can fold the
    // older rounds into index lines on demand for very long runs.
    let roundsCollapsedAll = false;
    // Long runs stay fully expanded by default: thinking and conclusions must
    // never disappear just because a run is long. The header action can fold the
    // older rounds into index lines on demand; explicit per-round choices win.
    let density = 'expanded'; // expanded | folded
    let rounds = [], current = null, session = '', latestExecution;
    // The last runId painted; used to tell a genuinely new run (which legitimately
    // starts with few records) from a light/partial tick that dropped most rows.
    let paintedRunId = '';
    // Display segments (one per Reason review) derived from `rounds` on every
    // render; `rounds` itself still tracks runs for accumulation/archiving.
    let segments = [];
    // Segment ordinals are allocated once and survive run eviction, exactly like
    // the previous one-number-per-run counters: the oldest surviving round can
    // legitimately read "第 3 轮".
    let segmentNumber = 0;
    let start = null, firstId, follow = true, lastTop = 0, lastHeight = 0, total = 0, followFrame = 0;
    let roundNumber = 0, fallbackCounter = 0, pendingNew = 0;
    // Live thinking durations keep counting even when the model is silent between
    // chunks; only the small duration labels are touched, never the whole log.
    const liveDurations = new Set();
    let liveDurationTimer = 0;
    function stopLiveDurations() {
      if (liveDurationTimer) { clearInterval(liveDurationTimer); liveDurationTimer = 0; }
    }
    function startLiveDurations() {
      if (liveDurationTimer || !liveDurations.size) return;
      liveDurationTimer = setInterval(() => {
        if (document.hidden) return;
        for (const view of liveDurations) {
          if (!view.durationStart || !view.duration.isConnected) { liveDurations.delete(view); continue; }
          setRaw(view.duration, durationText(view.durationStart, Date.now()));
        }
        if (!liveDurations.size) stopLiveDurations();
      }, 1000);
    }
    // The pager is a footer of the scrolling area: it stays visible while the
    // log itself scrolls and never pushes the first round down.
    const pager = element('div', 'goal-log-pager'); pager.hidden = true;
    const earlier = element('button', '', tr('较早日志')), newer = element('button', '', tr('较新日志')), latest = element('button', '', tr('最新日志')), range = element('span', '');
    for (const button of [earlier, newer, latest]) button.type = 'button';
    range.setAttribute('role', 'status'); pager.append(earlier, range, newer, latest); container.after(pager);
    // Log-local tools: they only narrow what is already rendered. The durable
    // execution state, record count and paging remain untouched.
    const tools = element('div', 'goal-log-tools');
    const filter = element('select', 'goal-log-filter');
    filter.setAttribute('aria-label', '筛选日志');
    for (const [value, label] of [['all', '全部记录'], ['current', '只看当前轮'], ['anomaly', '只看异常'], ['reasoning', '思考'], ['schedule', '调度'], ['tool', '工具'], ['worker', '任务']]) {
      const option = element('option', '', tr(label)); option.value = value; filter.append(option);
    }
    const search = element('input', 'goal-log-search');
    search.type = 'search'; search.placeholder = tr('搜索日志'); search.setAttribute('aria-label', tr('搜索日志'));
    const jump = element('select', 'goal-log-jump');
    jump.setAttribute('aria-label', tr('跳到轮次'));
    const copy = element('button', 'goal-log-copy', tr('复制'));
    copy.type = 'button'; copy.setAttribute('aria-label', tr('复制当前日志')); copy.title = tr('复制当前可见日志');
    const matchInfo = element('span', 'goal-log-match');
    matchInfo.setAttribute('role', 'status');
    const filterEmpty = element('div', 'goal-log-filter-empty');
    const filterEmptyText = element('span', '', tr('没有匹配的日志记录。'));
    const clearFilter = element('button', 'goal-log-clear-filter', tr('清除筛选'));
    clearFilter.type = 'button';
    filterEmpty.append(filterEmptyText, clearFilter);
    filterEmpty.hidden = true;
    tools.append(filter, search, jump, copy, matchInfo, filterEmpty);
    container.before(tools);
    tools.hidden = true;
    let filterMode = 'all', searchQuery = '', jumpSignature = '', filteredTotal = 0;
    function filterActive() { return filterMode !== 'all' || Boolean(searchQuery); }
    function entrySearchText(entry) {
      return [
        entry.part?.name, entry.part?.args, entry.part?.output, entry.part?.error, entry.part?.text,
        entry.worker?.name, entry.worker?.description, entry.worker?.result, entry.worker?.error,
        entry.activity?.label, entry.label, entry.text, entry.status,
        ...(Array.isArray(entry.tools) ? entry.tools.flatMap(tool => [tool?.name, tool?.args, tool?.output, tool?.error]) : [])
      ].filter(value => typeof value === 'string' && value).join(' ').toLowerCase();
    }
    function entryMatchesFilter(entry) {
      const kind = entry.kind || '';
      if (filterMode === 'reasoning' && kind !== 'reasoning') return false;
      if (filterMode === 'schedule' && !['toolLine', 'activity'].includes(kind)) return false;
      if (filterMode === 'tool' && kind !== 'tool') return false;
      if (filterMode === 'worker' && kind !== 'worker') return false;
      if (filterMode === 'current' && entry.round !== segments[segments.length - 1]) return false;
      if (filterMode === 'anomaly') {
        const status = entry.part?.status ?? entry.worker?.status ?? entry.status ?? '';
        const failedTools = Array.isArray(entry.tools) && entry.tools.some(tool => ['failed', 'interrupted'].includes(tool?.status));
        if (!failedTools && !['failed', 'interrupted'].includes(status)) return false;
      }
      if (searchQuery && !entrySearchText(entry).includes(searchQuery)) return false;
      return true;
    }
    // Filtering happens on entries, not DOM rows: search/filter covers the whole
    // bounded log (ages across pages), then the pager pages over the matches.
    function refreshFilter() {
      start = null;
      firstId = undefined;
      if (latestExecution) update(session, latestExecution);
      else updateMatchInfo();
    }
    function updateMatchInfo() {
      const active = filterActive();
      if (!active) { setText(matchInfo, ''); setHidden(matchInfo, true); filterEmpty.hidden = true; return; }
      setText(matchInfo, tr('显示 {0} 条', filteredTotal));
      setHidden(matchInfo, false);
      filterEmpty.hidden = filteredTotal > 0 || total === 0;
    }
    function clearFilters() {
      filterMode = 'all'; searchQuery = '';
      filter.value = 'all'; search.value = '';
      refreshFilter();
    }
    function updateJump() {
      const signature = segments.map(segment => `${segment.key}:${segment.number}`).join('|');
      if (signature === jumpSignature) return;
      jumpSignature = signature;
      const first = element('option', '', tr('跳到轮次')); first.value = '';
      jump.replaceChildren(first);
      for (const segment of segments) {
        const option = element('option', '', roundHeaderText(segment)); option.value = segment.key;
        jump.append(option);
      }
      jump.hidden = segments.length < 2;
    }
    filter.addEventListener('change', () => { filterMode = filter.value; refreshFilter(); });
    search.addEventListener('input', () => { searchQuery = search.value.trim().toLowerCase(); refreshFilter(); });
    search.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !search.value) return;
      event.preventDefault();
      clearFilters();
      search.focus({ preventScroll: true });
    });
    clearFilter.addEventListener('click', () => { clearFilters(); search.focus({ preventScroll: true }); });
    jump.addEventListener('change', () => {
      const key = jump.value;
      if (!key) return;
      const header = roundHeaders.get(key);
      if (!header) return;
      follow = false;
      cancelFollowFrame();
      markFollow();
      header.root.scrollIntoView({ block: 'start' });
      jump.value = '';
    });
    copy.addEventListener('click', () => {
      const text = [...container.querySelectorAll('.goal-log-round-heading, .goal-log-entry')]
        .filter(node => !node.hidden)
        .map(node => node.innerText || node.textContent || '')
        .join('\n')
        .trim();
      if (!text || typeof actions?.onCopy !== 'function') return;
      Promise.resolve(actions.onCopy(text)).then(() => {
        setRaw(copy, tr('已复制'));
        setTimeout(() => { if (copy.isConnected) setRaw(copy, tr('复制')); }, 1500);
      }).catch(() => {});
    });
    const reasonToggle = document.getElementById('goal-log-reason-toggle');
    const roundsToggle = document.getElementById('goal-log-rounds-toggle');
    const bottomButton = document.getElementById('goal-log-bottom');
    // While the reader is scrolled away from the live edge, the bottom action
    // reports how much new output arrived instead of only saying "回到底部".
    function syncBottomLabel() {
      if (!bottomButton) return;
      const pending = pendingNew > 0 && !follow;
      const label = pending ? '↓ ' + tr('{0} 条新记录', pendingNew) : tr('↓ 回到底部');
      setRaw(bottomButton, label);
      if (bottomButton.title !== (pending ? tr('新记录已到达，滚动到最新输出') : tr('滚动到日志底部，继续跟随新输出'))) {
        bottomButton.title = pending ? tr('新记录已到达，滚动到最新输出') : tr('滚动到日志底部，继续跟随新输出');
      }
      setData(bottomButton, 'pending', pending ? 'true' : 'false');
    }

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
    function scheduleFollow() {
      cancelFollowFrame();
      if (!stickFollow()) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        stickFollow();
      });
    }
    container.addEventListener('scroll', () => {
      // Collapsing a round (or an eviction) shrinks the content and clamps
      // scrollTop. That is not the reader scrolling up, so follow is preserved.
      const height = container.scrollHeight;
      if (height < lastHeight - 1) {
        lastHeight = height;
        lastTop = container.scrollTop;
        markFollow();
        measureRoundOffsets();
        return;
      }
      lastHeight = height;
      if (container.scrollTop < lastTop - 1) {
        follow = false;
        cancelFollowFrame();
        pinLatestPage();
      } else if (container.scrollTop > lastTop + 1 && nearBottom()) {
        follow = true;
        pendingNew = 0;
        if (start !== null && start >= Math.max(0, total - pageSize)) start = null;
        syncBottomLabel();
      }
      lastTop = container.scrollTop;
      markFollow();
      updateActiveRound();
    }, { passive: true });
    function markFollow() {
      const value = follow && start === null ? 'true' : 'false';
      if (container.dataset.following !== value) container.dataset.following = value;
    }
    // Selecting text is a reading gesture: stop auto-follow until the reader
    // returns to the bottom, instead of letting the next tick move the selection.
    function selectionInLog() {
      const selection = typeof getSelection === 'function' ? getSelection() : null;
      if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
      const node = selection.getRangeAt(0).commonAncestorContainer;
      return container.contains(node.nodeType === 1 ? node : node.parentNode);
    }
    function onSelectionChange() {
      if (!container.isConnected || !selectionInLog()) return;
      if (!follow) return;
      follow = false;
      cancelFollowFrame();
      markFollow();
      syncBottomLabel();
    }
    document.addEventListener('selectionchange', onSelectionChange);
    function releaseRow(row) {
      if (row.reason) liveDurations.delete(row.reason);
      if (!liveDurations.size) stopLiveDurations();
      window.UBOVMMessage.release?.(row.body);
      row.root.remove();
    }
    function removeRoundHeader(key) {
      const header = roundHeaders.get(key);
      if (!header) return;
      header.root.remove();
      roundHeaders.delete(key);
    }
    function reset() {
      cancelFollowFrame();
      liveDurations.clear();
      stopLiveDurations();
      for (const row of rows.values()) releaseRow(row);
      rows.clear();
      for (const header of roundHeaders.values()) header.root.remove();
      roundHeaders.clear();
      for (const divider of activityDividers.values()) divider.remove();
      activityDividers.clear();
      for (const card of taskCards.values()) card.root.remove();
      taskCards.clear();
      container.replaceChildren(); latestExecution = undefined; firstId = undefined; start = null; session = '';
      rounds = []; current = null; roundNumber = 0; fallbackCounter = 0; segments = []; segmentNumber = 0;
      compactRounds = false; roundsCollapsedAll = false; density = 'expanded';
      collapsedRounds.clear(); expandedRounds.clear();
      follow = true; lastTop = 0; lastHeight = 0; total = 0; pager.hidden = true;
      pendingNew = 0; roundOffsets = []; roundGeometryDirty = true;
      filterMode = 'all'; searchQuery = ''; jumpSignature = '';
      filter.value = 'all'; search.value = '';
      jump.replaceChildren(); jump.hidden = true;
      tools.hidden = true; setText(matchInfo, ''); setHidden(matchInfo, true); filterEmpty.hidden = true;
      updateReasonToggle();
      updateRoundsToggle();
      markFollow();
      syncBottomLabel();
    }
    function page(offset) {
      follow = false;
      start = Math.max(0, (start ?? Math.max(0, filteredTotal - pageSize)) + offset);
      firstId = undefined;
      roundGeometryDirty = true;
      update(session, latestExecution);
      container.scrollTop = 0;
      lastTop = container.scrollTop;
      markFollow();
    }
    earlier.addEventListener('click', () => page(-pageSize)); newer.addEventListener('click', () => page(pageSize));
    function showLatest() {
      start = null; follow = true; firstId = undefined; pendingNew = 0; roundGeometryDirty = true;
      if (latestExecution) update(session, latestExecution);
      scheduleFollow();
      syncBottomLabel();
    }
    latest.addEventListener('click', () => showLatest());

    // ---- Round accumulation -------------------------------------------------
    function evictRound(round) {
      if (!round || round === current) return false;
      const index = rounds.indexOf(round);
      if (index < 0) return false;
      rounds.splice(index, 1);
      collapsedRounds.delete(round.key);
      for (const key of [...expandedRounds]) if (key === round.key || key.startsWith(round.key + '#')) expandedRounds.delete(key);
      removeRoundHeader(round.key);
      roundGeometryDirty = true;
      return true;
    }
    function createRound(execution, runId) {
      const round = {
        key: runId || ('round:' + (++fallbackCounter)),
        runId, number: ++roundNumber, live: true,
        startedAt: roundStartedAt(execution), snapshot: execution,
        status: executionStatus(execution), frozen: null, entries: []
      };
      rounds.push(round);
      current = round;
      roundGeometryDirty = true;
      while (rounds.length > maxRounds) {
        if (!evictRound(rounds[0])) break;
      }
      return round;
    }
    function archiveRound(round) {
      if (!round) return;
      round.frozen = freezeExecution(round.snapshot);
      round.live = false;
      round.status = round.frozen.status;
      current = null;
    }
    function seedHistory(records) {
      if (!Array.isArray(records) || !records.length) return false;
      let added = false;
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const key = typeof record.runId === 'string' ? record.runId : '';
        if (!key || rounds.some(round => round.key === key)) continue;
        const startedAt = Number.isFinite(Number(record.startedAt)) ? Number(record.startedAt) : Date.now();
        let frozen;
        try { frozen = freezeExecution(record); }
        catch { continue; }
        rounds.push({
          key, runId: key, number: 0, live: false, startedAt,
          snapshot: record, status: record.status || 'interrupted', frozen, entries: []
        });
        added = true;
      }
      if (added) {
        rounds.sort((left, right) => left.startedAt - right.startedAt);
        rounds.forEach((round, index) => { round.number = index + 1; });
        roundNumber = rounds.length;
        roundGeometryDirty = true;
      }
      return added;
    }
    function ensureRound(execution) {
      const explicit = typeof execution?.runId === 'string' ? execution.runId
        : typeof execution?.timelineRun === 'string' ? execution.timelineRun : '';
      if (!current) { createRound(execution, explicit); return; }
      if (explicit && current.runId && explicit !== current.runId) {
        archiveRound(current);
        createRound(execution, explicit);
        return;
      }
      if (explicit && !current.runId) current.runId = explicit;
      if (!explicit && !current.runId && looksLikeNewRun(current.snapshot, execution)) {
        archiveRound(current);
        createRound(execution, '');
        return;
      }
      current.snapshot = execution;
      current.status = executionStatus(execution);
    }
    function dataOf(round) {
      return round.frozen || round.snapshot;
    }

    // ---- Entry construction (paging units across all rounds) ----------------
    // `round` is a display segment: one Reason review inside a run. Its `run`
    // carries the snapshot; `cuts` are the reason-conclusion timestamps that
    // partition the run, so every segment renders only its own review's parts,
    // management calls, workers and activities.
    function roundEntries(round) {
      const run = round.run || round;
      const data = dataOf(run);
      const cuts = Array.isArray(round.cuts) ? round.cuts : reviewCutsOf(data);
      const review = Number.isInteger(round.review) ? round.review : 0;
      const lastReview = review === cuts.length;
      const inReview = value => reviewIndexOf(value, cuts) === review;
      const parts = visibleContentParts(data).filter(part => inReview(timestamp(part.startedAt)));
      const entries = [];
      let seq = 0;
      const reasoningParts = reasoningPartsOf(data).filter(part => inReview(timestamp(part.startedAt)));
      // Thinking keeps its chronological position for the whole review. It is
      // never re-pinned to the bottom: a row that starts at the top of the round
      // must not jump there when the review concludes, and a reader who scrolled
      // up must not have the thinking line moved underneath the viewport.
      if (reasoningParts.length) {
        const firstStart = reasoningParts.map(part => timestamp(part.startedAt)).find(Number.isFinite);
        entries.push({
          id: 'reason:' + round.key, kind: 'reasoning', round, parts: reasoningParts,
          time: firstStart ?? round.startedAt, seq: seq++
        });
      }
      // Reason's own management calls (list_workers, wait_worker_sleep, graph,
      // worker control) are scheduling, not task output. Merge them into one
      // compact expandable line so they no longer pile up as standalone cards
      // ahead of the prose; task tool cards keep their own rows.
      const reasonTools = parts.filter(part => part.type === 'tool' && REASON_TOOL_NAMES.has(part.name));
      const contentParts = reasonTools.length ? parts.filter(part => !(part.type === 'tool' && REASON_TOOL_NAMES.has(part.name))) : parts;
      if (reasonTools.length) {
        const firstStart = reasonTools.map(part => timestamp(part.startedAt)).find(Number.isFinite);
        entries.push({
          id: 'tools:' + round.key, kind: 'toolLine', round, tools: reasonTools,
          time: firstStart ?? round.startedAt, seq: seq++
        });
      }
      // v5: one chronological row per non-thinking content part.
      for (const part of contentParts) {
        entries.push({
          id: 'part:' + part.id, kind: part.type, round, part,
          source: part.source || '', time: timestamp(part.startedAt) ?? round.startedAt, seq: seq++
        });
      }
      const hasTextPart = contentParts.some(part => part.type === 'text');
      const streamText = lastReview && typeof data.streamText === 'string' ? data.streamText : '';
      const resultText = lastReview && typeof data.result?.summary === 'string' ? data.result.summary.trim() : '';
      const resultRepresented = Boolean(resultText) && parts.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim() === resultText);
      if (!hasTextPart && streamText) {
        entries.push({
          id: 'stream:' + round.key, kind: 'text', round, synthetic: true, text: streamText,
          source: '', time: Number.MAX_SAFE_INTEGER - 1000, seq: seq++
        });
      }
      if (resultText && !resultRepresented) {
        entries.push({
          id: 'result:' + round.key, kind: 'text', round, synthetic: true, text: resultText,
          source: '', time: Number.MAX_SAFE_INTEGER, seq: seq++
        });
      }
      const workers = Array.isArray(data.workers) ? data.workers : [];
      const reviewWorkers = [];
      for (const worker of workers) {
        if (!worker || typeof worker !== 'object') continue;
        // createdAt is the dispatch event inside the review, so the review that
        // owns it is reviewIndexOf(createdAt). Historical records may only carry
        // startedAt (which lands after the decision): fall back to the preceding
        // review, matching "the most recent Reason decision dispatched it".
        const createdAt = timestamp(worker.createdAt);
        const startedAt = timestamp(worker.startedAt ?? worker.finishedAt);
        let owner;
        if (Number.isFinite(createdAt)) owner = reviewIndexOf(createdAt, cuts);
        else if (Number.isFinite(startedAt)) owner = Math.max(0, cuts.filter(cut => cut <= startedAt).length - 1);
        else owner = 0;
        if (owner !== review) continue;
        reviewWorkers.push(worker);
      }
      // Workers are not timeline rows: the round owns one dedicated task card so
      // dispatch management never interrupts thinking or conclusions.
      round.workers = reviewWorkers.sort((left, right) =>
        (timestamp(left.createdAt ?? left.startedAt) ?? 0) - (timestamp(right.createdAt ?? right.startedAt) ?? 0));
      // A historical round may contain only dispatched tasks (for example a run
      // interrupted before any thinking/text was persisted). Keep it in paging so
      // its task card and header are not silently dropped; the marker never
      // renders as a row.
      if (!entries.length && reviewWorkers.length) {
        entries.push({ id: 'tasks:' + round.key, kind: 'tasksOnly', round, time: round.startedAt ?? Date.now(), seq: seq++ });
      }
      const toolNames = toolNamesOf(data);
      (Array.isArray(data.activities) ? data.activities : []).forEach((activity, index) => {
        if (!activity || typeof activity.label !== 'string') return;
        if (activity.label === 'skill.loaded' && activity.status === 'completed') return;
        if (toolNames.has(activity.label)) return;
        const at = timestamp(activity.timestamp);
        if (Number.isFinite(at) && !inReview(at)) return;
        entries.push({
          id: 'activity:' + round.key + ':' + (activity.key || index), kind: 'activity', round, activity,
          label: activity.label === 'Reason' ? '调度' : window.UBOVMTimeline.displayActivityLabel(activity.label),
          status: activity.status,
          time: at ?? round.startedAt, seq: seq++,
          activityKind: activityKind(activity.label)
        });
      });
      entries.sort((a, b) => {
        const left = Number.isFinite(a.time) ? a.time : Infinity;
        const right = Number.isFinite(b.time) ? b.time : Infinity;
        return left === right ? a.seq - b.seq : left - right;
      });
      return entries;
    }
    function segmentFor(run, cuts, review) {
      const data = dataOf(run);
      const lastReview = review === cuts.length;
      const live = Boolean(run.live && lastReview);
      const status = live ? executionStatus(data) : (run.live ? 'completed' : (run.status || executionStatus(data)));
      const cutStart = review > 0 ? cuts[review - 1] : undefined;
      // Runs without persisted Reason conclusions (legacy timelines, synthetic
      // fixtures) keep their historical round key and one-round-per-run shape.
      const key = cuts.length ? run.key + '#r' + review : run.key;
      const segment = {
        key, number: 0, run, runId: run.runId, review, cuts, live, status,
        startedAt: cutStart ?? roundStartedAt(data), finishedAt: undefined,
        snapshot: run.snapshot, frozen: run.frozen, entries: []
      };
      segment.entries = roundEntries(segment);
      const first = firstPartStart(data) ?? roundStartedAt(data);
      // Synthetic pinned/result rows use MAX_SAFE_INTEGER sentinels for ordering;
      // never let them decide the round's wall-clock start.
      const times = segment.entries
        .map(entry => entry.time)
        .filter(value => Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER - 10_000);
      const minEntry = times.length ? Math.min(...times) : undefined;
      // A round starts at its review window: the previous Reason decision for
      // later reviews, the run's first part for the opening review. Stale rows
      // (e.g. a worker created by an earlier run) must not drag the header back
      // to a previous run's clock and inflate its duration.
      segment.startedAt = cutStart ?? (minEntry !== undefined ? Math.max(first, minEntry) : first);
      segment.finishedAt = review < cuts.length ? cuts[review] : undefined;
      return segment;
    }
    function allEntries() {
      for (;;) {
        const nextSegments = [];
        let entries = [];
        for (const run of rounds) {
          const data = dataOf(run);
          const cuts = reviewCutsOf(data);
          run.segmentNumbers ??= new Map();
          for (let review = 0; review <= cuts.length; review += 1) {
            const segment = segmentFor(run, cuts, review);
            if (!segment.entries.length) continue;
            if (!run.segmentNumbers.has(review)) {
              segmentNumber += 1;
              run.segmentNumbers.set(review, segmentNumber);
            }
            segment.number = run.segmentNumbers.get(review);
            nextSegments.push(segment);
            entries.push(...segment.entries);
          }
        }
        segments = nextSegments;
        compactRounds = nextSegments.length > COMPACT_ROUND_THRESHOLD;
        // A short run has no density choice; the next long run starts expanded.
        if (!compactRounds) density = 'expanded';
        if (entries.length <= maxEntries || rounds.length <= 1) return entries;
        if (!evictRound(rounds[0])) return entries;
      }
    }

    // ---- Rows ---------------------------------------------------------------
    function createRow() {
      const root = element('article', 'goal-log-entry');
      const heading = element('header', 'goal-log-heading');
      const time = element('time', 'goal-log-time');
      const icon = element('span', 'goal-log-row-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.hidden = true;
      const label = element('strong', '');
      const state = element('span', 'goal-log-state');
      heading.append(time, icon, label, state);
      const body = element('div', 'goal-log-body');
      root.append(heading, body);
      return {
        root, heading, time, icon, label, state, body, kind: '',
        blockSignature: undefined, contentRound: undefined,
        workerKey: undefined, workerLocale: undefined, workerLine: undefined,
        reason: undefined
      };
    }
    function setRowTime(row, entry) {
      setRaw(row.time, Number.isFinite(entry.time) ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
      const title = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleString('zh-CN') : '此记录未提供时间';
      if (row.time.title !== title) row.time.title = title;
    }
    function clearContentBody(row) {
      if (!row.contentRound) return;
      // Release the message view when the block moves to another row/page.
      window.UBOVMMessage.release?.(row.body);
      row.body.replaceChildren();
      row.body.className = 'goal-log-body';
      row.blockSignature = undefined;
      row.contentRound = undefined;
    }
    function resetRowForKind(row, kind) {
      if (row.kind === 'content') clearContentBody(row);
      else if (row.kind === 'reasoning' && row.reason) {
        window.UBOVMMarkdown?.release?.(row.reason.markdown);
        row.reason = undefined;
        row.body.replaceChildren();
      } else if (row.kind) { window.UBOVMMessage.release?.(row.body); row.body.replaceChildren(); row.toolLine = undefined; row.toolLineKey = undefined; }
      row.kind = kind;
      setData(row.root, 'kind', kind);
    }

    // ---- Per-part chronological rows (text / tool / summary) --------------
    function renderPartRow(row, entry, execution, now) {
      const round = entry.round;
      const data = dataOf(round);
      const part = entry.part || {
        id: entry.id, type: 'text', text: typeof entry.text === 'string' ? entry.text : '',
        status: entry.synthetic && round.live ? 'streaming' : 'completed',
        startedAt: entry.time
      };
      const streaming = round.live && part.type === 'text' && ['streaming', 'running'].includes(part.status);
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      setData(row.root, 'round', round.number);
      setData(row.root, 'source', part.source || '');
      setData(row.root, 'status', part.status || '');
      // Reason conclusions are the narrative anchors of a round; mark them so the
      // stylesheet can set them apart from ordinary streamed prose.
      setData(row.root, 'conclusion', typeof part.id === 'string' && part.id.startsWith('reason-conclusion:') ? 'true' : 'false');
      setData(row.root, 'logId', entry.id);
      setAttribute(row.root, 'data-round-key', round.key);
      // Cheap change signature: one update per changed row, never a rebuild.
      const key = [
        part.id, part.type, part.name, part.status, part.source || '',
        typeof part.text === 'string' ? part.text : '',
        typeof part.output === 'string' ? part.output.length : -1,
        typeof part.args === 'string' ? part.args.length : -1,
        Number.isFinite(Number(part.startedAt)) ? Number(part.startedAt) : -1,
        Number.isFinite(Number(part.endedAt)) ? Number(part.endedAt) : -1,
        streaming ? '1' : '0', locale
      ];
      if (equal(row.partKey, key)) return;
      row.partKey = key;
      // Standalone tool cards have no `.tool-group` caption; keep a hidden
      // "tool call" caption for log search/legacy transcript text.
      if (part.type === 'tool') {
        if (!row.toolCaption) {
          row.toolCaption = element('span', 'goal-log-tool-caption', tr('工具调用'));
          row.toolCaption.hidden = true;
          row.toolCaption.setAttribute('aria-hidden', 'true');
          row.root.append(row.toolCaption);
        }
        setRaw(row.toolCaption, tr('工具调用'));
      } else if (row.toolCaption) {
        row.toolCaption.remove();
        row.toolCaption = undefined;
      }
      row.body.classList.add('goal-log-body', 'goal-log-row-content', 'message-text');
      try {
        window.UBOVMMessage.update(row.body, '', {
          ...actions, role: 'assistant', parts: [part], streaming, toolGrouping: false
        });
      } catch { /* A failed render keeps the previous row visible. */ }
    }
    // ---- Merged scheduling line for Reason's own tool calls ------------------
    function renderToolLineRow(row, entry) {
      const round = entry.round;
      const active = entry.tools.some(part => ['running', 'streaming'].includes(part.status));
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      setData(row.root, 'round', round.number);
      setData(row.root, 'status', active ? 'running' : 'completed');
      setData(row.root, 'source', 'reason');
      setData(row.root, 'logId', entry.id);
      setAttribute(row.root, 'data-round-key', round.key);
      const key = entry.tools.map(part => [part.id, part.name, part.status,
        typeof part.output === 'string' ? part.output.length : -1,
        typeof part.args === 'string' ? part.args.length : -1].join(':')).join('|') + '|' + locale;
      if (row.toolLineKey === key) return;
      row.toolLineKey = key;
      if (!row.toolLine) {
        const details = element('details', 'goal-log-toolline');
        const summary = element('summary', 'goal-log-toolline-summary');
        const icon = element('span', 'goal-log-toolline-icon', '⇢');
        icon.setAttribute('aria-hidden', 'true');
        const title = element('span', 'goal-log-toolline-title', tr('调度调用'));
        const names = element('span', 'goal-log-toolline-names');
        const state = element('span', 'goal-log-toolline-state');
        const body = element('div', 'goal-log-toolline-body');
        summary.append(icon, title, names, state);
        details.append(summary, body);
        row.body.replaceChildren(details);
        row.toolLine = { details, summary, title, names, state, body };
      }
      const names = [...new Set(entry.tools.map(part => window.UBOVMTimeline?.toolDisplayName?.(part.name) || part.name))];
      setRaw(row.toolLine.names, names.slice(0, 3).join(' · ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
      setRaw(row.toolLine.state, active ? tr('运行中') : tr('{0} 次', entry.tools.length));
      row.toolLine.body.className = 'goal-log-toolline-body goal-log-tool-cards message-timeline';
      try {
        window.UBOVMMessage.update(row.toolLine.body, '', {
          ...actions, role: 'assistant', parts: entry.tools, streaming: active, toolGrouping: false
        });
      } catch { /* Keep the previous cards if a render fails. */ }
    }
    // ---- DSH-style reasoning line -----------------------------------------
    function ensureReasoningRow(row) {
      if (row.reason) return row.reason;
      row.body.className = 'goal-log-body goal-log-reasoning-wrap';
      const details = element('details', 'goal-log-reasoning');
      const summary = element('summary', 'goal-log-reasoning-summary');
      const icon = element('span', 'goal-log-reasoning-icon', '✦');
      icon.setAttribute('aria-hidden', 'true');
      const line = element('span', 'goal-log-reasoning-line');
      const meta = element('span', 'goal-log-reasoning-meta');
      const stateLabel = element('span', 'goal-log-reasoning-state');
      const duration = element('span', 'goal-log-reasoning-duration');
      meta.append(stateLabel, duration);
      const chevron = element('span', 'thinking-chevron', '›');
      chevron.setAttribute('aria-hidden', 'true');
      summary.append(icon, line, meta, chevron);
      setAttribute(summary, 'aria-label', tr('推理过程'));
      const body = element('div', 'goal-log-reasoning-body');
      const markdown = element('div', 'goal-log-reasoning-markdown');
      body.append(markdown);
      details.append(summary, body);
      row.body.replaceChildren(details);
      const sr = element('span', 'goal-log-reasoning-sr');
      sr.hidden = true;
      sr.setAttribute('aria-hidden', 'true');
      row.root.append(sr);
      const view = { details, summary, icon, line, meta, stateLabel, duration, body, markdown, sr, renderedText: null, renderedStreaming: undefined, pinned: false };
      details.addEventListener('toggle', () => {
        // Expanding/collapsing no longer changes a sticky status row; only the
        // expand-all action and the rendered body state need updating.
        if (!details.open) {
          // Force a fresh full render on the next open (a coalesced toggle must
          // not leave the expanded body showing stale streamed text).
          view.renderedText = null;
          view.renderedStreaming = undefined;
          updateReasonToggle();
          return;
        }
        renderReasoningBody(row);
        updateReasonToggle();
        // Opening the live row should reveal the newest reasoning instead of
        // growing below the viewport edge.
        if (follow) scheduleFollow();
      });
      // Native details does not close on Escape; keyboard readers expect it.
      details.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !details.open) return;
        event.preventDefault();
        details.open = false;
        summary.focus({ preventScroll: true });
      });
      row.reason = view;
      return view;
    }
    function renderReasoningBody(row) {
      const view = row.reason;
      if (!view || !view.details.open) return;
      const text = row.reasonText ?? '';
      const streaming = row.reasonStreaming === true;
      if (view.renderedText === text && view.renderedStreaming === streaming) return;
      const body = view.body;
      const visible = body.isConnected && !body.closest('[hidden]');
      const top = visible ? body.scrollTop : 0;
      const atEnd = visible && body.scrollHeight - body.clientHeight - top <= 3;
      try {
        window.UBOVMMarkdown?.update(view.markdown, text, { ...actions, streaming });
      } catch {
        view.markdown.textContent = text;
      }
      view.renderedText = text;
      view.renderedStreaming = streaming;
      if (visible) body.scrollTop = atEnd ? body.scrollHeight : top;
    }
    function renderReasoningRow(row, entry, now) {
      const view = ensureReasoningRow(row);
      const parts = entry.parts;
      const running = parts.some(part => ['running', 'streaming'].includes(part.status));
      const starts = parts.map(part => timestamp(part.startedAt)).filter(Number.isFinite);
      const ends = parts.map(part => timestamp(part.endedAt)).filter(Number.isFinite);
      const start = starts.length ? Math.min(...starts) : entry.time;
      const end = running ? now : (ends.length ? Math.max(...ends) : start);
      const text = reasoningText(parts);
      row.reasonText = text;
      row.reasonStreaming = running;
      const preview = reasoningPreview(text);
      if (preview) row.reasonPreview = preview;
      // A protocol-only fragment can momentarily produce an empty preview; keep
      // the previous meaningful line instead of flashing a blank pinned row.
      const line = preview || (running ? row.reasonPreview || tr('正在思考…') : tr('规划协议内容已折叠'));
      setRaw(view.line, line);
      setRaw(view.stateLabel, tr(running ? '思考中' : '已思考'));
      setRaw(view.duration, durationText(start, end));
      view.durationStart = running ? start : 0;
      if (running) { liveDurations.add(view); startLiveDurations(); }
      else { liveDurations.delete(view); if (!liveDurations.size) stopLiveDurations(); }
      setRaw(view.sr, text);
      setData(row.root, 'status', running ? 'running' : 'completed');
      // Thinking is a stable chronological row: no live pin, no status-bar pin.
      setData(row.root, 'pinned', 'false');
      setData(view.summary, 'status', running ? 'running' : 'completed');
      setAttribute(row.root, 'data-round-key', entry.round.key);
      setData(row.root, 'round', entry.round.number);
      if (view.details.open) renderReasoningBody(row);
      else { view.renderedText = null; view.renderedStreaming = undefined; }
    }

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
      const result = element('p', 'goal-log-worker-result');
      const error = element('p', 'execution-error goal-log-worker-error');
      const parent = element('small', 'goal-log-worker-parent');
      row.body.replaceChildren(line, description, result, error, parent);
      row.workerLine = { button, chip, duration, description, result, error, parent };
      return row;
    }
    function workerDisplayStatus(worker) {
      const status = worker.status || 'created';
      // The log is not a progress meter: a dispatched Worker shows only "已派发"
      // while it runs/waits, then updates once to its final state. Live status
      // and progress stay in the Worker detail panel.
      return FINAL_WORKER_STATUS.has(status) ? status : 'created';
    }
    function renderWorkerRow(row, entry, execution, now) {
      const worker = entry.worker;
      const round = entry.round;
      const status = workerDisplayStatus(worker);
      const final = FINAL_WORKER_STATUS.has(status);
      const duration = final
        ? durationText(timestamp(worker.createdAt ?? worker.startedAt), timestamp(worker.finishedAt))
        : '';
      const resultText = final ? workerResult(worker) : '';
      const error = final ? workerError(worker) : '';
      const key = [worker.id, worker.name, worker.description, worker.parentId, status, worker.finishedAt, resultText, error].join('\u0001');
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      setRaw(row.label, tr('分派任务'));
      setRaw(row.state, tr(final ? (WORKER_STATUS[status] || status) : '已派发'));
      setRowTime(row, entry);
      setHidden(row.icon, true);
      setData(row.root, 'status', status);
      setData(row.root, 'final', final ? 'true' : 'false');
      setData(row.root, 'round', round.number);
      setAttribute(row.root, 'data-round-key', round.key);
      setAttribute(row.root, 'data-worker', worker.id || '');
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
      setRaw(line.result, resultText ? tr('结果') + '：' + resultText : '');
      setHidden(line.result, !resultText);
      setRaw(line.error, error);
      setHidden(line.error, !error);
      setText(line.parent, worker.parentId ? tr('来自上级任务') : '');
      setHidden(line.parent, !worker.parentId);
    }
    function renderActivityRow(row, entry, round) {
      setRowTime(row, entry);
      setHidden(row.icon, false);
      const iconKind = entry.activityKind || '';
      if (row.iconKind !== iconKind) {
        if (ACTIVITY_ICON_PATHS[iconKind]) row.icon.replaceChildren(activityIcon(iconKind));
        else setRaw(row.icon, '·');
        row.iconKind = iconKind;
      }
      setRaw(row.label, tr(entry.label));
      setRaw(row.state, entry.status ? tr(statusText(entry.status)) : '');
      setData(row.root, 'status', entry.status || '');
      setData(row.root, 'activity', entry.activityKind || '');
      setData(row.root, 'round', round.number);
      setAttribute(row.root, 'data-round-key', round.key);
    }
    function renderRow(row, entry, execution, now) {
      const kind = entry.kind;
      if (row.kind !== kind) resetRowForKind(row, kind);
      setData(row.root, 'logId', entry.id);
      // Search runs against the source record, not only the collapsed DOM: tool
      // names/args/outputs and worker descriptions stay findable while folded.
      row.searchText = [
        entry.part?.name, entry.part?.args, entry.part?.output, entry.part?.error, entry.part?.text,
        entry.worker?.name, entry.worker?.description, entry.worker?.result, entry.worker?.error,
        entry.activity?.label, entry.label, entry.text, entry.status,
        ...(Array.isArray(entry.tools) ? entry.tools.flatMap(tool => [tool?.name, tool?.args, tool?.output, tool?.error]) : [])
      ].filter(value => typeof value === 'string' && value).join(' ').toLowerCase();
      if (kind === 'reasoning') renderReasoningRow(row, entry, now);
      else if (kind === 'toolLine') renderToolLineRow(row, entry);
      else if (kind === 'worker') renderWorkerRow(row, entry, execution, now);
      else if (kind === 'activity') renderActivityRow(row, entry, entry.round);
      else renderPartRow(row, entry, execution, now);
    }

    // ---- Round headers ------------------------------------------------------
    // Each round header is the round's section control: it stays at the top of
    // the scroll area while the round's rows pass underneath, and clicking it
    // folds the whole round into one summary line.
    let roundOffsets = [];
    let roundGeometryDirty = true;
    let measureFrame = 0, measureObserver = null;
    function scheduleMeasureRoundOffsets() {
      if (measureFrame) return;
      measureFrame = requestAnimationFrame(() => { measureFrame = 0; measureRoundOffsets(); });
    }
    // Only the round the reader is currently inside keeps its header sticky;
    // otherwise every previous header would pile up at the top edge and never
    // release because all sections share one scroll container. Positions are
    // measured from a forced static layout (sticky offsets are paint-only), so
    // scroll handling stays number-only.
    function updateActiveRound() {
      if (!roundOffsets.length) return;
      const edge = container.scrollTop + 8;
      let active = null;
      for (const item of roundOffsets) if (item.header.root.isConnected && item.top <= edge) active = item.header;
      for (const item of roundOffsets) setData(item.header.root, 'sticky', item.header === active ? 'true' : 'false');
    }
    function measureRoundOffsets() {
      // A hidden goal page reports every rect at 0; defer until it is painted
      // again (the ResizeObserver below re-runs the measurement).
      const containerRect = container.getBoundingClientRect();
      if (!container.getClientRects().length || containerRect.height < 2) {
        roundOffsets = [];
        return false;
      }
      const base = containerRect.top;
      const scroll = container.scrollTop;
      for (const header of roundHeaders.values()) setData(header.root, 'sticky', 'false');
      roundOffsets = [...roundHeaders.values()].map(header => ({
        header,
        top: header.root.getBoundingClientRect().top - base + scroll
      }));
      updateActiveRound();
      roundGeometryDirty = false;
      return true;
    }
    if (typeof ResizeObserver === 'function') {
      measureObserver = new ResizeObserver(() => scheduleMeasureRoundOffsets());
      measureObserver.observe(container);
    }
    function roundEndAt(round) {
      if (Number.isFinite(round?.finishedAt)) return round.finishedAt;
      const data = dataOf(round);
      const values = [timestamp(data.finishedAt)];
      for (const part of data.parts || []) values.push(timestamp(part?.endedAt));
      for (const worker of data.workers || []) values.push(timestamp(worker?.finishedAt));
      const valid = values.filter(Number.isFinite);
      return valid.length ? Math.max(...valid) : undefined;
    }
    function roundSummary(round) {
      const entries = Array.isArray(round.entries) ? round.entries : [];
      const workers = Array.isArray(round.workers) ? round.workers.length : 0;
      const tools = entries.filter(entry => entry.kind === 'tool' || entry.kind === 'toolLine').length;
      const parts = [tr('{0} 条记录', entries.length)];
      if (workers) parts.push(tr('{0} 个任务', workers));
      if (tools) parts.push(tr('{0} 个工具', tools));
      return parts.join(' · ');
    }
    // The round header should answer "what did this review decide?" without
    // making the reader scan the rows. Decision-bearing tool arguments are the
    // authoritative source (submit_decision intents/wait/complete, TODO
    // directions, worker dispatch); missing or truncated args simply omit chips.
    function toolArgs(part) {
      const raw = part?.args;
      if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return undefined;
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
      } catch { return undefined; }
    }
    function roundDecisionText(round) {
      const entries = Array.isArray(round.entries) ? round.entries : [];
      let intents = 0, directions = 0, wait = false, complete = false, tools = 0, failures = 0;
      const countDecision = part => {
        const args = toolArgs(part);
        if (!args) return;
        if (Array.isArray(args.intents)) intents += args.intents.length;
        if (args.complete === true) complete = true;
        if (args.wait === true) wait = true;
      };
      for (const entry of entries) {
        if (entry.kind === 'toolLine') {
          for (const part of entry.tools || []) {
            tools += 1;
            if (part.name === 'submit_decision') countDecision(part);
            if (part.name === 'exploration_todo') {
              const args = toolArgs(part);
              if (Array.isArray(args?.items)) directions += args.items.length;
            }
          }
          continue;
        }
        if (entry.kind === 'tool') {
          tools += 1;
          const part = entry.part;
          if (part && ['failed', 'interrupted'].includes(part.status)) failures += 1;
          continue;
        }
        if (entry.kind === 'worker') continue;
        const part = entry.part;
        if (part && ['failed', 'interrupted'].includes(part.status)) failures += 1;
      }
      const workers = Array.isArray(round.workers) ? round.workers : [];
      const workerFailures = workers.filter(worker => ['failed', 'interrupted'].includes(worker?.status)).length;
      const chips = [];
      if (complete) chips.push(tr('提交完成'));
      else if (wait) chips.push(tr('等待'));
      if (intents) chips.push(tr('{0} 个意图', intents));
      if (directions) chips.push(tr('{0} 个方向', directions));
      if (workers.length) chips.push(tr('{0} 个任务', workers.length));
      if (tools) chips.push(tr('{0} 个工具', tools));
      const anomalies = failures + workerFailures;
      if (anomalies) chips.push(tr('{0} 个异常', anomalies));
      return chips.join(' · ');
    }
    // Rounds are reading sections, not foldable accordions. The header stays
    // sticky for orientation, but its rows are always visible: thinking and
    // conclusions must never disappear behind a fold.
    function roundCollapsed() {
      return false;
    }
    function applyCollapsed(round) {
      const header = roundHeaders.get(round.key);
      if (header) {
        setData(header.root, 'collapsed', 'false');
        header.root.removeAttribute('aria-expanded');
        header.root.removeAttribute('title');
        setHidden(header.meta, true);
      }
      for (const [key, row] of rows) {
        if (!key.startsWith(round.key + '|')) continue;
        if (row.root.hidden) row.root.hidden = false;
      }
      const divider = activityDividers.get(round.key);
      if (divider) divider.hidden = false;
      const taskCard = taskCards.get(round.key);
      if (taskCard) taskCard.root.hidden = false;
    }
    function toggleRound(round) {
      if (!round) return;
      const expanding = roundCollapsed(round);
      if (expanding) {
        collapsedRounds.delete(round.key);
        expandedRounds.add(round.key);
      } else {
        expandedRounds.delete(round.key);
        collapsedRounds.add(round.key);
      }
      // Opening an older round means the reader is browsing history; do not let
      // the next live tick drag the viewport back to the bottom.
      if (expanding && !round.live) {
        follow = false;
        cancelFollowFrame();
      }
      applyCollapsed(round);
      updateReasonToggle();
      updateRoundsToggle();
      measureRoundOffsets();
      markFollow();
      syncBottomLabel();
      if (follow) scheduleFollow();
    }
    // Clicking or pressing Enter/Space on the header folds or unfolds the round.
    function bindRoundHeader(root, round) {
      root.addEventListener('click', () => toggleRound(round));
      root.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleRound(round);
      });
    }
    function roundHeaderFor(round) {
      let header = roundHeaders.get(round.key);
      if (!header) {
        const root = element('div', 'goal-log-round-heading');
        const title = element('span', 'goal-log-round-title');
        const time = element('time', 'goal-log-round-time');
        const duration = element('span', 'goal-log-round-duration');
        const decision = element('span', 'goal-log-round-decision');
        const meta = element('span', 'goal-log-round-meta');
        const status = element('span', 'goal-log-round-status');
        meta.hidden = true;
        decision.hidden = true;
        root.append(title, time, duration, decision, meta, status);
        header = { root, title, time, duration, decision, meta, status };
        roundHeaders.set(round.key, header);
      }
      setText(header.title, roundHeaderText(round));
      setRaw(header.time, new Date(round.startedAt).toLocaleTimeString('zh-CN', { hour12: false }));
      const status = round.status || dataOf(round).status || 'running';
      setRaw(header.status, tr(statusText(status)));
      setData(header.status, 'status', status);
      const active = Boolean(round.live) && ['running', 'starting'].includes(status);
      const end = active ? Date.now() : roundEndAt(round);
      const duration = durationText(round.startedAt, Number.isFinite(end) ? Math.max(end, round.startedAt) : end);
      setRaw(header.duration, duration);
      setHidden(header.duration, !duration);
      const decisionText = roundDecisionText(round);
      setRaw(header.decision, decisionText);
      setHidden(header.decision, !decisionText);
      setData(header.root, 'status', status);
      setData(header.root, 'round', round.number);
      setAttribute(header.root, 'data-round-key', round.key);
      applyCollapsed(round);
      return header.root;
    }

    // ---- Header expand/collapse all reasoning bodies -----------------------
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
    // Round-level expand-all is only offered once the log is dense enough to have
    // folded older rounds; the current round always stays readable.
    function updateRoundsToggle() {
      // Round folding was removed: thinking and conclusions must stay visible.
      // Keep the legacy header node hidden so older bundles/tests cannot expose it.
      if (roundsToggle) setHidden(roundsToggle, true);
    }
    function toggleAllRounds() {
      const anyCollapsed = segments.some(round => roundCollapsed(round));
      density = anyCollapsed ? 'expanded' : 'folded';
      roundsCollapsedAll = density === 'folded';
      expandedRounds.clear();
      collapsedRounds.clear();
      for (const round of segments) applyCollapsed(round);
      updateReasonToggle();
      updateRoundsToggle();
      measureRoundOffsets();
      markFollow();
      syncBottomLabel();
      if (follow) scheduleFollow();
    }
    function toggleAllReasoning() {
      const list = reasoningRows();
      if (!list.length) return;
      const expand = list.some(row => !row.reason.details.open);
      for (const row of list) {
        const view = row.reason;
        if (view.details.open === expand) continue;
        view.details.open = expand;
        if (expand) renderReasoningBody(row);
      }
      updateReasonToggle();
    }
    reasonToggle?.addEventListener('click', toggleAllReasoning);
    // Round headers are not interactive: no fold/unfold affordance.
    // Keep the header label in sync with manual details toggles.
    container.addEventListener('toggle', event => {
      if (event.target?.classList?.contains('goal-log-reasoning')) updateReasonToggle();
    }, true);

    // ---- Activity group divider --------------------------------------------
    // Thinking, conclusions and summaries must read as one continuous story.
    // Tool calls, Worker management and activity rows move below a divider at the
    // end of the round instead of being spliced into the middle of the narrative.
    function activityDividerFor(round, count) {
      let divider = activityDividers.get(round.key);
      if (!divider) {
        divider = element('div', 'goal-log-activity-divider');
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-label', tr('调度与执行'));
        activityDividers.set(round.key, divider);
      }
      divider.dataset.roundKey = round.key;
      setText(divider, tr('调度与执行 · {0} 条', count));
      return divider;
    }

    // ---- Dispatched-task card ------------------------------------------------
    // Workers get one management card per round instead of timeline rows: the
    // card shows which tasks exist and their final state; live status stays in the
    // Worker detail panel. Expanding it reveals descriptions/results/errors.
    function workerCardLabel(worker) {
      // Historical workers can be saved without a display name; the description
      // is a far better label than the internal Worker id.
      const name = typeof worker?.name === 'string' ? worker.name.trim() : '';
      if (name) return name;
      const description = typeof worker?.description === 'string' ? worker.description.trim() : '';
      if (description) return description.length > 48 ? description.slice(0, 47) + '…' : description;
      return worker?.id || '';
    }
    function renderTaskCard(round) {
      const workers = Array.isArray(round.workers) ? round.workers : [];
      let card = taskCards.get(round.key);
      if (!workers.length) {
        if (card) { card.root.remove(); taskCards.delete(round.key); }
        return null;
      }
      if (!card) {
        const root = element('details', 'goal-log-task-card');
        const summary = element('summary', 'goal-log-task-summary');
        const title = element('span', 'goal-log-task-title', tr('分派任务'));
        const names = element('span', 'goal-log-task-names');
        const state = element('span', 'goal-log-task-state');
        const chevron = element('span', 'goal-log-task-chevron', '›');
        chevron.setAttribute('aria-hidden', 'true');
        summary.append(title, names, state, chevron);
        const body = element('div', 'goal-log-task-body');
        root.append(summary, body);
        card = { root, title, names, state, body, signature: '' };
        taskCards.set(round.key, card);
      }
      card.root.dataset.roundKey = round.key;
      const finalCount = workers.filter(worker => FINAL_WORKER_STATUS.has(worker.status)).length;
      const labels = workers.map(workerCardLabel).filter(Boolean);
      setText(card.names, labels.slice(0, 3).join('、') + (labels.length > 3 ? ` +${labels.length - 3}` : ''));
      setText(card.state, finalCount ? tr('{0}/{1} 完成', finalCount, workers.length) : tr('{0} 个', workers.length));
      const signature = workers.map(worker => [
        worker.id, worker.name, worker.description, worker.parentId, worker.status,
        worker.finishedAt, worker.result, worker.error
      ].join('\u0001')).join('|');
      if (signature !== card.signature) {
        card.signature = signature;
        card.body.replaceChildren(...workers.map(worker => {
          const status = workerDisplayStatus(worker);
          const final = FINAL_WORKER_STATUS.has(status);
          const item = element('div', 'goal-log-task');
          item.dataset.workerId = worker.id || '';
          const head = element('div', 'goal-log-task-head');
          const button = element('button', 'goal-log-task-name', workerCardLabel(worker));
          button.type = 'button';
          button.title = tr('查看任务执行记录');
          button.setAttribute('aria-label', tr('查看任务执行记录') + '：' + workerCardLabel(worker));
          button.addEventListener('click', () => openWorker(worker.id, button));
          const chip = element('span', 'goal-log-task-status', tr(WORKER_STATUS[status] || status));
          setData(chip, 'status', status);
          const duration = element('span', 'goal-log-task-duration', final
            ? durationText(timestamp(worker.createdAt ?? worker.startedAt), timestamp(worker.finishedAt)) : '');
          head.append(button, chip, duration);
          item.append(head);
          if (worker.description) item.append(element('p', 'goal-log-task-description', worker.description));
          const result = final ? workerResult(worker) : '';
          if (result) item.append(element('p', 'goal-log-task-result', tr('结果') + '：' + result));
          const error = final ? workerError(worker) : '';
          if (error) item.append(element('p', 'execution-error goal-log-task-error', error));
          if (worker.parentId) item.append(element('small', 'goal-log-task-parent', tr('来自上级任务')));
          return item;
        }));
      }
      card.root.hidden = false;
      return card.root;
    }

    function update(sessionId, execution) {
      if (session !== sessionId) { reset(); session = sessionId; paintedRunId = ''; }
      seedHistory(execution?.logHistory);
      latestExecution = execution;
      ensureRound(execution);
      const entries = allEntries();
      const previousTotal = total;
      const status = executionStatus(execution);
      const runId = typeof execution?.runId === 'string' ? execution.runId : '';
      const sameRun = Boolean(runId) && runId === paintedRunId;
      if (runId) paintedRunId = runId;
      // A partial/light execution tick can omit the arrays that produce entries.
      // Never blank an already populated overview for one frame while the run is
      // still active; the next complete tick repaints normally.
      if (!entries.length && total > 0 && ['starting', 'running'].includes(status)) return total;
      // Same guard for a tick that still yields one or two rows but drops the
      // bulk of an already painted round (the "only one thinking line, empty log,
      // 47 records" flash): keep the last complete picture until a tick carries
      // the timeline again. Small legitimate replacements (paging fixtures, live
      // row edits) still repaint.
      if (sameRun && ['starting', 'running'].includes(status) && entries.length <= 2
        && total - entries.length > 10) return total;
      total = entries.length;
      const matched = filterActive() ? entries.filter(entryMatchesFilter) : entries;
      filteredTotal = matched.length;
      // Rows that arrived while the reader is away from the live edge are
      // reported on the bottom action so following up is a single click.
      if (!follow && total > previousTotal) pendingNew += total - previousTotal;
      if (follow) pendingNew = 0;
      // Keep an older page stable as live records arrive; evict its DOM on paging.
      if (firstId && start !== null) { const index = matched.findIndex(entry => entry.id === firstId); if (index >= 0) start = index; }
      const offset = start === null ? Math.max(0, matched.length - pageSize) : Math.min(start, Math.max(0, matched.length - 1));
      const visibleEntries = matched.slice(offset, offset + pageSize);
      firstId = visibleEntries[0]?.id;
      pager.hidden = matched.length <= pageSize;
      earlier.disabled = offset === 0; newer.disabled = offset + pageSize >= matched.length;
      range.textContent = tr(`${matched.length ? offset + 1 : 0}–${Math.min(matched.length, offset + pageSize)} / ${matched.length} 条`)
        + (filterActive() ? tr('（筛选）') : '');
      latest.disabled = start === null;
      const now = Date.now();
      // Round headers group the chronological rows; rows themselves stay a single
      // flat timeline sorted by event time (reasoning / text / tool / activity / worker).
      const groups = [];
      for (const entry of visibleEntries) {
        const last = groups.at(-1);
        if (!last || last.round !== entry.round) groups.push({ round: entry.round, entries: [] });
        groups[groups.length - 1].entries.push(entry);
      }
      const kept = new Set(), usedHeaders = new Set(), usedDividers = new Set(), usedTaskCards = new Set(), sequence = [];
      for (const group of groups) {
        usedHeaders.add(group.round.key);
        sequence.push({ header: roundHeaderFor(group.round) });
        const narrative = [], activity = [];
        for (const entry of group.entries) {
          if (entry.kind === 'tasksOnly') continue;
          if (['toolLine', 'tool', 'worker', 'activity'].includes(entry.kind)) activity.push(entry);
          else narrative.push(entry);
        }
        const appendRow = entry => {
          const rowKey = group.round.key + '|' + entry.id;
          kept.add(rowKey);
          let row = rows.get(rowKey);
          if (!row) { row = createRow(); rows.set(rowKey, row); }
          // One malformed row must never take down the whole overview page.
          try { renderRow(row, entry, execution, now); }
          catch (error) { console.warn('[UBOVM] Goal log row render failed', error); }
          sequence.push({ row });
        };
        for (const entry of narrative) appendRow(entry);
        const taskCard = renderTaskCard(group.round);
        if (taskCard) {
          usedTaskCards.add(group.round.key);
          sequence.push({ taskCard });
        }
        if (activity.length) {
          usedDividers.add(group.round.key);
          sequence.push({ divider: activityDividerFor(group.round, activity.length) });
          for (const entry of activity) appendRow(entry);
        }
      }
      // Place nodes in order without detaching unchanged rows unnecessarily.
      let anchor = container.firstChild;
      for (const item of sequence) {
        const node = item.header || item.taskCard || item.divider || item.row.root;
        if (node === anchor) { anchor = anchor.nextSibling; continue; }
        container.insertBefore(node, anchor);
      }
      for (const [key, row] of rows) if (!kept.has(key)) { releaseRow(row); rows.delete(key); }
      for (const key of [...roundHeaders.keys()]) if (!usedHeaders.has(key)) removeRoundHeader(key);
      for (const [key, divider] of activityDividers) {
        if (usedDividers.has(key) && divider.isConnected) continue;
        divider.remove();
        activityDividers.delete(key);
      }
      for (const [key, card] of taskCards) {
        if (usedTaskCards.has(key) && card.root.isConnected) continue;
        card.root.remove();
        taskCards.delete(key);
      }
      // Re-apply folded rounds after new rows took part in the layout.
      for (const round of segments) applyCollapsed(round);
      setHidden(tools, !entries.length);
      updateJump();
      updateMatchInfo();
      if (roundGeometryDirty) measureRoundOffsets();
      updateReasonToggle();
      updateRoundsToggle();
      if (follow && start === null) scheduleFollow();
      markFollow();
      syncBottomLabel();
      return entries.length;
    }
    return {
      update,
      reset,
      showLatest,
      alignFollow: scheduleFollow,
      dispose() {
        cancelFollowFrame();
        reset();
        document.removeEventListener('selectionchange', onSelectionChange);
        if (measureFrame) { cancelAnimationFrame(measureFrame); measureFrame = 0; }
        measureObserver?.disconnect?.();
        pager.remove();
        tools.remove();
        reasonToggle?.removeEventListener?.('click', toggleAllReasoning);
      }
    };
  };
})();
