(() => {
  'use strict';
  const active = new Set(['pending', 'queued', 'running', 'waiting']);
  const labels = { pending: '待执行', queued: '排队中', running: '执行中', waiting: '等待子任务', completed: '已完成', failed: '失败', interrupted: '已停止' };
  const shortLabels = { ...labels, running: '执行', queued: '排队', pending: '排队', waiting: '等待', completed: '完成', interrupted: '停止' };
  const toolLabels = { delivery_workflow: '交付闭环', read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令', run_python: '运行 Python 沙箱', manage_python_environment: '管理 Python 依赖', run_linux_ssh_command: '运行命令', upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', web_search: '搜索网页', fetch_web_content: '读取网页', load_skill: '加载技能', spawn_worker: '分派并行任务', wait_workers: '等待并行任务', list_workers: '检查协作进展', cancel_workers: '中断并行任务', manage_workers: '调度并行任务' };
  const t = value => window.UBOVMi18n?.t(value) ?? value;
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = t(text); return element; };
  const setText = (element, value) => { const text = t(value); if (element.textContent !== text) element.textContent = text; };
  const setAttribute = (element, name, value) => {
    value = String(name === 'title' || name === 'aria-label' || name === 'placeholder' ? t(value) : value);
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const setHidden = (element, hidden) => { if (element.hidden !== hidden) element.hidden = hidden; };
  function previewText(value) {
    let text = '', space = false;
    // A card needs at most 150 characters, not a normalized copy of a full log.
    for (const character of String(value)) {
      if (/\s/.test(character)) { if (!space) text += ' '; space = true; }
      else { if (text.length + character.length > 150) break; text += character; space = false; }
      if (text.length >= 150) break;
    }
    return text;
  }
  const visible = element => !element.closest('[hidden]');
  window.createWorkerPanel = function createWorkerPanel(actions, { initialWidth = 440, onWidthChange, openNative, standalone = false } = {}) {
    const roster = document.getElementById('collaboration-workers'), cards = document.getElementById('collaboration-worker-list');
    const shell = document.querySelector('.shell'), main = document.getElementById('main-content');
    const goalDirectory = document.getElementById('goal-workers-list'), search = document.getElementById('goal-workers-search'), filter = document.getElementById('goal-workers-filter');
    let goalMode = false;
    const panel = node('aside', 'worker-panel'); panel.id = 'worker-panel'; panel.hidden = true; panel.setAttribute('aria-label', '任务工作详情');
    const resize = node('div', 'worker-resize-handle'); resize.tabIndex = 0; resize.setAttribute('role', 'separator');
    resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('aria-label', '调整任务面板宽度'); resize.setAttribute('aria-controls', panel.id);
    resize.title = '拖动调整宽度 · 左右键微调 · 双击恢复默认';
    const header = node('header', 'worker-panel-header');
    const expand = node('button', 'worker-expand', '占据主空间'); expand.type = 'button'; expand.setAttribute('aria-controls', panel.id); expand.setAttribute('aria-pressed', 'false');
    const close = node('button', 'worker-close', '← 主对话'); close.type = 'button'; close.setAttribute('aria-label', '关闭 Worker 详情'); close.title = '返回主对话（Esc），任务继续运行';
    const options = node('details', 'worker-options'), optionsToggle = node('summary', 'worker-options-toggle', '···');
    optionsToggle.setAttribute('aria-label', '任务视图选项'); optionsToggle.title = '任务视图选项';
    const optionsMenu = node('div', 'worker-options-menu'); optionsMenu.append(expand); options.append(optionsToggle, optionsMenu);
    const pickerLabel = node('label', 'worker-picker-label', '切换任务'), picker = node('select', 'worker-picker');
    picker.id = 'worker-picker'; pickerLabel.htmlFor = picker.id;
    const controls = node('div', 'worker-panel-controls'); controls.append(pickerLabel, picker);
    header.append(close, controls, options);
    const follow = node('button', 'worker-follow', '跟随最新'); follow.type = 'button';
    follow.setAttribute('aria-pressed', 'true'); follow.title = '自动滚动到最新日志；向上阅读会暂停跟随';
    if (standalone) header.append(follow);
    const heading = node('div', 'worker-detail-heading'), name = node('h3'), status = node('span', 'worker-status'), timer = node('span', 'worker-duration');
    heading.append(name, status, timer);
    const task = node('p', 'worker-task'), parent = node('button', 'worker-parent'); parent.type = 'button';
    const error = node('p', 'worker-detail-error'); error.setAttribute('role', 'status');
    const scroller = node('div', 'worker-detail-scroll'); scroller.tabIndex = 0; scroller.setAttribute('aria-label', '任务执行记录');
    const taskLabel = node('div', 'worker-section-label', '任务');
    const summary = node('div', 'worker-detail-summary'); summary.append(heading, parent, taskLabel, task, error);
    const content = node('div', 'worker-detail-content');
    const renderStatus = node('div', 'worker-render-status'); renderStatus.hidden = true;
    const renderMessage = node('span', '', '日志显示失败，请重试。'); renderMessage.setAttribute('role', 'alert');
    const retry = node('button', 'worker-copy-log', '重新显示日志'); retry.type = 'button';
    retry.addEventListener('click', () => renderDetail());
    renderStatus.append(renderMessage, retry);
    scroller.append(summary, content); panel.append(resize, header, renderStatus, scroller); shell.append(panel);
    if (standalone) { resize.hidden = true; close.hidden = true; options.hidden = true; }
    let sessionId = '', workers = [], selected = '', returnFocus, lastTop = 0, expanded = false;
    let workersById = new Map(), workerNames = new Map();
    const pickerOptions = new Map();
    let preferredWidth = Number.isFinite(initialWidth) && initialWidth >= 280 && initialWidth <= 800 ? initialWidth : 440, drag;
    const positions = new Map();
    const views = new Map(), lists = new Map([cards].filter(Boolean).map(container => [container, new Map()]));
    function releaseView(id) {
      const view = views.get(id);
      if (!view) return;
      positions.delete(id); positions.set(id, { top: view.top, follow: view.follow });
      while (positions.size > 32) positions.delete(positions.keys().next().value);
      window.UBOVMMessage.release?.(view.element);
      view.element.remove(); views.delete(id);
    }
    function trimInactiveViews() {
      let bytes = 0, nodes = 0;
      // Inspect only on navigation, never on every streamed token.
      for (const [id, view] of [...views].reverse()) {
        if (id === selected && !panel.hidden) continue;
        const size = view.element.textContent.length * 2, count = 1 + view.element.querySelectorAll('*').length;
        if (bytes + size > 2 * 1024 * 1024 || nodes + count > 3000) releaseView(id);
        else { bytes += size; nodes += count; }
      }
    }
    if (goalDirectory) lists.set(goalDirectory, new Map());
    search?.addEventListener('input', renderRoster); filter?.addEventListener('change', renderRoster);
    const current = () => workersById.get(selected);
    const displayName = worker => workerNames.get(worker.id) || worker.name || '任务';
    const issue = worker => worker.status === 'failed' || worker.status === 'interrupted';
    const errorText = worker => typeof worker.error === 'string' ? worker.error : worker.error?.message || '';
    const finalResult = worker => worker.status === 'completed' && typeof worker.result === 'string' && worker.result.trim() ? worker.result : '';
    const elapsedText = worker => {
      const start = worker.startedAt ?? worker.createdAt;
      const end = worker.finishedAt ?? (active.has(worker.status) ? Date.now() : undefined);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
      const seconds = Math.max(0, Math.floor((end - start) / 1000));
      return (worker.startedAt == null && active.has(worker.status) ? '已等待 ' : '') + (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
    };
    cards?.addEventListener('wheel', event => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = cards.scrollWidth - cards.clientWidth;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? cards.clientWidth : 1);
      const next = Math.max(0, Math.min(max, cards.scrollLeft + delta));
      if (max > 0 && next !== cards.scrollLeft) { event.preventDefault(); cards.scrollLeft = next; }
    }, { passive: false });
    const bounds = () => ({ min: Math.min(300, window.innerWidth), max: window.innerWidth >= 1100 ? Math.min(800, window.innerWidth - 420) : Math.min(800, window.innerWidth) });
    let topbarBottom = 0, resizeFrame = 0, pendingResizeWidth;
    function measureTopbar() {
      topbarBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
      return topbarBottom;
    }
    function layout({ remeasureTop = true } = {}) {
      if (standalone) return;
      const { min, max } = bounds(), width = Math.round(Math.max(min, Math.min(max, preferredWidth)));
      shell.style.setProperty('--worker-panel-width', width + 'px');
      if (remeasureTop || !topbarBottom) measureTopbar();
      shell.style.setProperty('--worker-panel-top', topbarBottom + 'px');
      resize.setAttribute('aria-valuemin', String(min)); resize.setAttribute('aria-valuemax', String(max)); resize.setAttribute('aria-valuenow', String(width)); resize.setAttribute('aria-valuetext', `${width} 像素`);
      shell.classList.toggle('worker-panel-expanded', expanded && !panel.hidden);
      resize.hidden = expanded;
      expand.setAttribute('aria-pressed', String(expanded)); setText(expand, expanded ? '恢复侧栏' : '占据主空间');
      main.inert = !panel.hidden && (expanded || window.innerWidth < 1100);
    }
    function setWidth(width, persist = false, options) {
      const { min, max } = bounds(); preferredWidth = Math.round(Math.max(min, Math.min(max, width))); layout(options);
      if (persist) onWidthChange?.(preferredWidth);
    }
    function scheduleResizeWidth(width) {
      pendingResizeWidth = width;
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const next = pendingResizeWidth; pendingResizeWidth = undefined;
        if (next != null) setWidth(next, false, { remeasureTop: false });
      });
    }
    function endDrag(cancel = false) {
      if (!drag) return;
      const saved = drag; drag = undefined; shell.classList.remove('worker-panel-resizing');
      if (resizeFrame) { cancelAnimationFrame(resizeFrame); resizeFrame = 0; pendingResizeWidth = undefined; }
      if (cancel) { preferredWidth = saved.preferred; layout(); } else onWidthChange?.(preferredWidth);
      if (resize.hasPointerCapture(saved.id)) resize.releasePointerCapture(saved.id);
    }
    resize.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); resize.focus();
      measureTopbar();
      drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width, preferred: preferredWidth };
      resize.setPointerCapture(event.pointerId); shell.classList.add('worker-panel-resizing');
    });
    resize.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) scheduleResizeWidth(drag.width + drag.x - event.clientX); });
    resize.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) endDrag(); });
    resize.addEventListener('pointercancel', () => endDrag(true));
    resize.addEventListener('lostpointercapture', () => endDrag());
    resize.addEventListener('dblclick', () => setWidth(440, true));
    resize.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); endDrag(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const { min, max } = bounds();
      setWidth(event.key === 'Home' ? min : event.key === 'End' ? max : panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 48 : 16), true);
    });
    function dismiss(focus = true) {
      options.open = false;
      endDrag(true);
      panel.inert = true; panel.hidden = true; expanded = false; shell.classList.remove('worker-panel-open'); layout();
      trimInactiveViews();
      for (const list of lists.values()) for (const view of list.values()) view.button.setAttribute('aria-expanded', 'false');
      if (focus) {
        if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
        else if (roster && !roster.hidden) cards.focus();
      }
    }
    function rememberScroll() { const view = views.get(selected); if (view) view.top = scroller.scrollTop; }
    function updateFollow() {
      const following = views.get(selected)?.follow !== false;
      follow.setAttribute('aria-pressed', String(following));
      setText(follow, following ? '跟随最新' : '回到最新');
    }
    follow.addEventListener('click', () => {
      const view = views.get(selected); if (!view) return;
      view.follow = !view.follow;
      if (view.follow) { scroller.scrollTop = scroller.scrollHeight; lastTop = scroller.scrollTop; rememberScroll(); }
      updateFollow();
    });
    function show(id, button) {
      if (!workersById.has(id)) return;
      if (openNative?.(id)) return;
      options.open = false;
      rememberScroll();
      const changed = selected !== id; selected = id;
      if (button) returnFocus = button;
      const wasHidden = panel.hidden; panel.inert = false; panel.hidden = false; shell.classList.add('worker-panel-open'); layout();
      renderDetail(changed || wasHidden);
      for (const list of lists.values()) for (const [key, view] of list) view.button.setAttribute('aria-expanded', String(key === selected));
      if (wasHidden) close.focus();
    }
    close.addEventListener('click', () => dismiss());
    expand.addEventListener('click', () => {
      endDrag(true);
      const top = scroller.scrollTop, view = views.get(selected);
      expanded = !expanded; layout();
      options.open = false; optionsToggle.focus();
      scroller.scrollTop = view?.follow ? scroller.scrollHeight : top;
      lastTop = scroller.scrollTop; rememberScroll();
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && options.open) { event.preventDefault(); options.open = false; optionsToggle.focus(); return; }
      if (!standalone && event.key === 'Escape' && !panel.hidden && !document.querySelector('.html-preview:not([hidden])')) { event.preventDefault(); dismiss(); }
    });
    document.addEventListener('pointerdown', event => { if (options.open && !options.contains(event.target)) options.open = false; });
    options.addEventListener('focusout', event => { if (!options.contains(event.relatedTarget)) options.open = false; });
    window.addEventListener('resize', layout);
    picker.addEventListener('change', () => show(picker.value));
    parent.addEventListener('click', () => { if (current()?.parentId) show(current().parentId); });
    scroller.addEventListener('scroll', () => {
      const view = views.get(selected);
      if (view) { if (scroller.scrollTop < lastTop - 1) view.follow = false; else if (scroller.scrollTop > lastTop + 1 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24) view.follow = true; view.top = scroller.scrollTop; }
      lastTop = scroller.scrollTop;
      updateFollow();
    }, { passive: true });
    function updateDuration() {
      const worker = current();
      if (!panel.hidden && worker) setText(timer, elapsedText(worker));
      for (const [container, list] of lists) if (visible(container)) for (const view of list.values()) if (!view.button.hidden) setText(view.elapsed, elapsedText(view.worker));
    }
    const tick = () => { if (!document.hidden && !document.getElementById('settings-dialog')?.open) updateDuration(); };
    let clock, suspended = false;
    function syncClock() {
      const needed = !suspended && !document.hidden && !document.getElementById('settings-dialog')?.open && workers.some(worker => active.has(worker.status));
      if (!needed) { clearInterval(clock); clock = undefined; }
      else if (clock === undefined) { tick(); clock = setInterval(tick, 1000); }
    }
    window.addEventListener('pagehide', () => { suspended = true; syncClock(); });
    window.addEventListener('pageshow', () => { suspended = false; syncClock(); });
    document.addEventListener('visibilitychange', syncClock);
    window.addEventListener('ubovm-settings-visibility', syncClock);
    function renderDetail(switched = false) {
      try {
        renderDetailContent(switched);
        renderStatus.hidden = true;
      } catch {
        // Keep the current snapshot and selection. A retry or later update can
        // recover without closing the panel or starting an automatic error loop.
        renderStatus.hidden = false;
      }
    }
    function renderDetailContent(switched = false) {
      const worker = current();
      if (!worker || panel.hidden) return;
      setText(name, displayName(worker));
      const rank = Number.isSafeInteger(worker.priority) && worker.priority > 0 ? ` · P${worker.priority}` : '';
      setText(status, (labels[worker.status] || worker.status || '待执行') + rank); status.dataset.status = worker.status;
      setText(task, worker.description || '');
      const ancestor = workersById.get(worker.parentId);
      parent.hidden = !ancestor; if (ancestor) setText(parent, '来自 ' + displayName(ancestor) + ' ↗');
      setText(error, errorText(worker)); error.hidden = !error.textContent;
      let view = views.get(selected);
      if (!view) { view = { element: node('div', 'worker-transcript message-text'), top: 0, follow: true, ...positions.get(selected) }; views.set(selected, view); }
      // Keep recent expansion/scroll state without retaining every visited log.
      views.delete(selected); views.set(selected, view);
      while (views.size > 8) releaseView(views.keys().next().value);
      if (view.element.parentElement !== content) content.replaceChildren(view.element);
      const parts = window.UBOVMTimeline.visibleTimelineParts(Array.isArray(worker.parts) ? worker.parts : []);
      const result = finalResult(worker);
      const fallback = result || worker.streamText || worker.result || (parts.length ? '' : worker.status === 'queued' || worker.status === 'pending' ? '任务已派发，等待开始。' : worker.status === 'waiting' ? '正在等待子任务返回结果。' : worker.status === 'interrupted' ? '执行已停止，已有工作记录保留在此。' : worker.status === 'failed' ? '执行失败，请查看错误信息。' : worker.status === 'completed' ? '任务已结束，当前没有更多执行记录。' : '正在执行，输出将在此实时显示。');
      const top = switched ? view.top : scroller.scrollTop;
      const changed = window.UBOVMMessage.update(view.element, fallback, { ...actions, role: 'assistant', parts, streaming: worker.status === 'running', preserveBody: Boolean(result) });
      if (switched) trimInactiveViews();
      picker.value = selected; updateDuration();
      if (switched || changed) {
        scroller.scrollTop = view.follow ? scroller.scrollHeight : top;
        lastTop = scroller.scrollTop;
      }
      updateFollow();
    }
    function renderList(container, values) {
      const cache = lists.get(container), kept = new Set(values.map(worker => worker.id)); let previous;
      // Remove obsolete rows first so retained focused rows need not move.
      for (const [id, view] of cache) if (!kept.has(id)) { view.button.remove(); cache.delete(id); }
      for (const worker of values) {
        let view = cache.get(worker.id);
        if (!view) {
          const button = node('button', 'worker-card'); button.type = 'button'; button.dataset.workerId = worker.id; button.setAttribute('aria-controls', panel.id);
          const row = node('span', 'worker-card-heading'), label = node('strong'), rank = node('span', 'worker-priority'), state = node('span', 'worker-status'), description = node('span', 'worker-card-task'), preview = node('span', 'worker-card-preview');
          const footer = node('span', 'worker-card-footer'), elapsed = node('span', 'worker-duration'), created = node('span', 'worker-card-created');
          row.append(label, rank, state);
          footer.append(preview, elapsed); button.append(row, description, footer, created);
          button.addEventListener('click', () => show(worker.id, button));
          view = { button, label, rank, state, description, preview, elapsed, created }; cache.set(worker.id, view);
        }
        view.worker = worker;
        setText(view.label, displayName(worker)); setText(view.state, (container === cards ? shortLabels : labels)[worker.status] || worker.status || '待执行'); setAttribute(view.state, 'data-status', worker.status);
        const priority = Number.isSafeInteger(worker.priority) && worker.priority > 0 ? `P${worker.priority}` : '';
        if (view.rank) { setText(view.rank, priority); setHidden(view.rank, !priority); }
        setAttribute(view.button, 'data-priority', String(Number.isSafeInteger(worker.priority) ? worker.priority : 0));
        setText(view.description, worker.description || '');
        const last = [...(worker.parts || [])].reverse().find(part => part && !(part.type === 'tool' && part.background === true));
        const latest = last?.type === 'tool' ? `${toolLabels[last.name] || (last.name?.startsWith('mcp_') ? '调用 MCP 工具' : '调用工具')}${last.status === 'failed' ? '失败' : last.status === 'running' ? '…' : last.status === 'interrupted' ? '已停止' : last.status === 'completed' ? '完成' : ''}` : last?.type === 'thinking' ? (last.status === 'streaming' || last.status === 'running' ? '正在思考…' : '已完成思考') : last?.type === 'summary' ? (last.status === 'running' ? '正在整理上下文…' : '上下文摘要已更新') : last?.text;
        const fallback = worker.status === 'queued' || worker.status === 'pending' ? '等待并发名额' : worker.status === 'waiting' ? '等待子任务返回' : worker.status === 'running' ? '等待实时输出…' : '点击查看工作记录';
        const previewSource = errorText(worker) || finalResult(worker) || latest || worker.streamText || worker.result || fallback;
        if (view.previewSource !== previewSource) { setText(view.preview, previewText(previewSource)); view.previewSource = previewSource; }
        setText(view.elapsed, elapsedText(worker));
        setHidden(view.created, true);
        if (!view.createdText || view.createdAt !== worker.createdAt) {
          const createdAt = typeof worker.createdAt === 'number' ? worker.createdAt : Date.parse(worker.createdAt);
          setText(view.created, Number.isFinite(createdAt) ? '创建于 ' + new Date(createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : '创建时间未记录');
          view.createdAt = worker.createdAt; view.createdText = true;
        }
        setAttribute(view.button, 'aria-expanded', !panel.hidden && worker.id === selected);
        setAttribute(view.button, 'title', `${displayName(worker)} · ${labels[worker.status] || worker.status}${priority ? ' · ' + priority : ''}\n${worker.description || ''}\n${view.preview.textContent}`);
        setAttribute(view.button, 'aria-label', `${displayName(worker)}，${labels[worker.status] || worker.status}${priority ? '，' + priority : ''}，查看任务记录`);
        setAttribute(view.button, 'data-depth', worker.depth > 1 ? 'nested' : 'root');
        setAttribute(view.button, 'data-status', worker.status);
        const next = previous ? previous.nextSibling : container.firstChild;
        if (view.button !== next) container.insertBefore(view.button, next); previous = view.button;
      }
    }
    function renderRoster() {
      const counts = new Map(); for (const worker of workers) counts.set(worker.status, (counts.get(worker.status) || 0) + 1);
      const count = status => counts.get(status) || 0;
      const issues = count('failed') + count('interrupted');
      setText(document.getElementById('worker-count'), String(workers.length));
      const summary = [[count('running'), '执行'], [count('queued') + count('pending'), '排队'], [count('waiting'), '等待'], [count('completed'), '完成'], [issues, '异常']].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ');
      const swarmStatus = document.getElementById('worker-swarm-status');
      setText(swarmStatus, summary || '暂无任务'); setAttribute(swarmStatus, 'title', summary);
      setAttribute(document.getElementById('worker-count').parentElement, 'title', summary);
      if (!goalMode && cards && visible(cards)) renderList(cards, workers);
      if (goalDirectory && goalMode && visible(goalDirectory)) {
        const query = search.value.trim().toLowerCase();
        const visible = workers.filter(worker => (!query || [worker.id, worker.name, worker.description].some(value => String(value || '').toLowerCase().includes(query))) &&
          (filter.value === 'all' || filter.value === 'active' && active.has(worker.status) || filter.value === 'completed' && worker.status === 'completed' || filter.value === 'issues' && issue(worker)));
        renderList(goalDirectory, visible);
        setText(document.getElementById('goal-workers-summary'), `${workers.length} 个任务${summary ? ' · ' + summary : ''}`);
        const empty = document.getElementById('goal-workers-empty'); setHidden(empty, visible.length > 0);
        setText(empty, workers.length ? '没有匹配的任务，试试其他关键词或状态。' : '开始执行目标后，分派的任务将显示在这里。');
      }
    }
    return {
      show,
      dismiss,
      get selected() { return selected; },
      get open() { return !panel.hidden; },
      update(input) {
        if (sessionId !== input.sessionId) {
          dismiss(false); selected = ''; sessionId = input.sessionId;
          for (const id of views.keys()) releaseView(id);
          positions.clear();
          content.replaceChildren();
          pickerOptions.clear(); picker.replaceChildren();
          if (cards) cards.scrollLeft = 0;
          if (search) search.value = ''; if (filter) filter.value = 'all';
          for (const [container, cache] of lists) { cache.clear(); container.replaceChildren(); }
        }
        workersById = new Map((Array.isArray(input.workers) ? input.workers : []).filter(worker => worker && typeof worker.id === 'string').map(worker => [worker.id, worker]));
        workers = [...workersById.values()];
        workerNames = new Map(workers.map((worker, index) => [worker.id, worker.name || '任务 ' + (index + 1)]));
        syncClock();
        goalMode = Boolean(input.goalMode);
        setText(close, goalMode ? '← 返回目标' : '← 主对话'); close.title = goalMode ? '返回目标工作区（Esc），任务继续运行' : '返回主对话（Esc），任务继续运行';
        const directoryError = document.getElementById('goal-workers-error');
        if (directoryError) { directoryError.hidden = !input.error; setText(directoryError, input.error ? '工作记录保存或读取失败：' + input.error : ''); }
        const visible = new Set(workers.map(worker => worker.id));
        for (const id of views.keys()) if (!visible.has(id)) releaseView(id);
        for (const id of positions.keys()) if (!visible.has(id)) positions.delete(id);
        if (selected && !visible.has(selected)) { dismiss(false); selected = ''; }
        if (!standalone) {
          setHidden(roster, Boolean(input.goalMode || !workers.length && !input.error));
          const saveError = document.getElementById('worker-storage-error'); setText(saveError, input.error ? '工作记录保存或读取失败：' + input.error : ''); setHidden(saveError, !input.error);
          renderRoster();
        }
        for (const [id, option] of pickerOptions) if (!workersById.has(id)) { option.remove(); pickerOptions.delete(id); }
        let previous;
        for (const worker of workers) {
          let option = pickerOptions.get(worker.id);
          if (!option) { option = node('option'); option.value = worker.id; pickerOptions.set(worker.id, option); }
          setText(option, `${displayName(worker)} · ${labels[worker.status] || worker.status}${Number.isSafeInteger(worker.priority) && worker.priority > 0 ? ' · P' + worker.priority : ''}`);
          const next = previous ? previous.nextSibling : picker.firstChild;
          if (option !== next) picker.insertBefore(option, next);
          previous = option;
        }
        // Closed side panel: keep roster and picker current, skip transcript DOM work.
        if (panel.hidden) return;
        renderDetail();
      }
    };
  };
})();
