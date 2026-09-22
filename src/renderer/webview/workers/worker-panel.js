(() => {
  'use strict';
  const active = new Set(['pending', 'queued', 'running', 'waiting']);
  const labels = { pending: '待执行', queued: '排队中', running: '执行中', waiting: '等待子任务', completed: '已完成', failed: '失败', interrupted: '已停止' };
  const shortLabels = { ...labels, running: '执行', queued: '排队', pending: '排队', waiting: '等待', completed: '完成', interrupted: '停止' };
  const toolLabels = { read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令', run_linux_ssh_command: '运行命令', upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', web_search: '搜索网页', fetch_web_content: '读取网页', load_skill: '加载技能', spawn_worker: '派发子任务', wait_workers: '等待子任务', list_workers: '检查协作进展' };
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const visible = element => !element.closest('[hidden]');
  window.createWorkerPanel = function createWorkerPanel(actions, { initialWidth = 440, onWidthChange } = {}) {
    const roster = document.getElementById('collaboration-workers'), cards = document.getElementById('collaboration-worker-list');
    const goalCards = document.getElementById('worker-list'), shell = document.querySelector('.shell'), main = document.getElementById('main-content');
    const goalDirectory = document.getElementById('goal-workers-list'), search = document.getElementById('goal-workers-search'), filter = document.getElementById('goal-workers-filter');
    let goalMode = false;
    const panel = node('aside', 'worker-panel'); panel.id = 'worker-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Worker 工作详情');
    const resize = node('div', 'worker-resize-handle'); resize.tabIndex = 0; resize.setAttribute('role', 'separator');
    resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('aria-label', '调整 Worker 面板宽度'); resize.setAttribute('aria-controls', panel.id);
    resize.title = '拖动调整宽度 · 左右键微调 · 双击恢复默认';
    const header = node('header', 'worker-panel-header');
    const expand = node('button', 'worker-expand', '占据主空间'); expand.type = 'button'; expand.setAttribute('aria-controls', panel.id); expand.setAttribute('aria-pressed', 'false');
    const close = node('button', 'worker-close', '← 主对话'); close.type = 'button'; close.setAttribute('aria-label', '关闭 Worker 详情'); close.title = '返回主对话（Esc），Worker 继续运行';
    const options = node('details', 'worker-options'), optionsToggle = node('summary', 'worker-options-toggle', '···');
    optionsToggle.setAttribute('aria-label', 'Worker 视图选项'); optionsToggle.title = 'Worker 视图选项';
    const optionsMenu = node('div', 'worker-options-menu'); optionsMenu.append(expand); options.append(optionsToggle, optionsMenu);
    const pickerLabel = node('label', 'worker-picker-label', '切换 Worker'), picker = node('select', 'worker-picker');
    picker.id = 'worker-picker'; pickerLabel.htmlFor = picker.id;
    const controls = node('div', 'worker-panel-controls'); controls.append(pickerLabel, picker);
    header.append(close, controls, options);
    const heading = node('div', 'worker-detail-heading'), name = node('h3'), status = node('span', 'worker-status'), timer = node('span', 'worker-duration');
    heading.append(name, status, timer);
    const task = node('p', 'worker-task'), parent = node('button', 'worker-parent'); parent.type = 'button';
    const error = node('p', 'worker-detail-error'); error.setAttribute('role', 'status');
    const scroller = node('div', 'worker-detail-scroll'); scroller.tabIndex = 0; scroller.setAttribute('aria-label', 'Worker 执行记录');
    const taskLabel = node('div', 'worker-section-label', '任务');
    const summary = node('div', 'worker-detail-summary'); summary.append(heading, parent, taskLabel, task, error);
    const content = node('div', 'worker-detail-content');
    scroller.append(summary, content); panel.append(resize, header, scroller); shell.append(panel);
    let sessionId = '', workers = [], selected = '', returnFocus, lastTop = 0, expanded = false;
    let preferredWidth = Number.isFinite(initialWidth) && initialWidth >= 280 && initialWidth <= 800 ? initialWidth : 440, drag;
    const views = new Map(), lists = new Map([[cards, new Map()], [goalCards, new Map()]]);
    if (goalDirectory) lists.set(goalDirectory, new Map());
    search?.addEventListener('input', renderRoster); filter?.addEventListener('change', renderRoster);
    const current = () => workers.find(worker => worker.id === selected);
    const displayName = worker => worker.name || 'Worker ' + (workers.findIndex(item => item.id === worker.id) + 1);
    const issue = worker => worker.status === 'failed' || worker.status === 'interrupted';
    const errorText = worker => typeof worker.error === 'string' ? worker.error : worker.error?.message || '';
    const elapsedText = worker => {
      const start = worker.startedAt ?? worker.createdAt;
      const end = worker.finishedAt ?? (active.has(worker.status) ? Date.now() : undefined);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
      const seconds = Math.max(0, Math.floor((end - start) / 1000));
      return (worker.startedAt == null && active.has(worker.status) ? '已等待 ' : '') + (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
    };
    cards.addEventListener('wheel', event => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = cards.scrollWidth - cards.clientWidth;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? cards.clientWidth : 1);
      const next = Math.max(0, Math.min(max, cards.scrollLeft + delta));
      if (max > 0 && next !== cards.scrollLeft) { event.preventDefault(); cards.scrollLeft = next; }
    }, { passive: false });
    const bounds = () => ({ min: Math.min(300, window.innerWidth), max: window.innerWidth >= 1100 ? Math.min(800, window.innerWidth - 420) : Math.min(800, window.innerWidth) });
    function layout() {
      const { min, max } = bounds(), width = Math.round(Math.max(min, Math.min(max, preferredWidth)));
      shell.style.setProperty('--worker-panel-width', width + 'px');
      shell.style.setProperty('--worker-panel-top', document.querySelector('.topbar').getBoundingClientRect().bottom + 'px');
      resize.setAttribute('aria-valuemin', String(min)); resize.setAttribute('aria-valuemax', String(max)); resize.setAttribute('aria-valuenow', String(width)); resize.setAttribute('aria-valuetext', `${width} 像素`);
      shell.classList.toggle('worker-panel-expanded', expanded && !panel.hidden);
      resize.hidden = expanded;
      expand.setAttribute('aria-pressed', String(expanded)); setText(expand, expanded ? '恢复侧栏' : '占据主空间');
      main.inert = !panel.hidden && (expanded || window.innerWidth < 1100);
    }
    function setWidth(width, persist = false) {
      const { min, max } = bounds(); preferredWidth = Math.round(Math.max(min, Math.min(max, width))); layout();
      if (persist) onWidthChange?.(preferredWidth);
    }
    function endDrag(cancel = false) {
      if (!drag) return;
      const saved = drag; drag = undefined; shell.classList.remove('worker-panel-resizing');
      if (cancel) { preferredWidth = saved.preferred; layout(); } else onWidthChange?.(preferredWidth);
      if (resize.hasPointerCapture(saved.id)) resize.releasePointerCapture(saved.id);
    }
    resize.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); resize.focus();
      drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width, preferred: preferredWidth };
      resize.setPointerCapture(event.pointerId); shell.classList.add('worker-panel-resizing');
    });
    resize.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) setWidth(drag.width + drag.x - event.clientX); });
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
      for (const list of lists.values()) for (const view of list.values()) view.button.setAttribute('aria-expanded', 'false');
      if (focus) {
        if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
        else if (!roster.hidden) cards.focus();
      }
    }
    function rememberScroll() { const view = views.get(selected); if (view) view.top = scroller.scrollTop; }
    function show(id, button) {
      if (!workers.some(worker => worker.id === id)) return;
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
      if (event.key === 'Escape' && !panel.hidden && !document.querySelector('.html-preview:not([hidden])')) { event.preventDefault(); dismiss(); }
    });
    document.addEventListener('pointerdown', event => { if (options.open && !options.contains(event.target)) options.open = false; });
    options.addEventListener('focusout', event => { if (!options.contains(event.relatedTarget)) options.open = false; });
    window.addEventListener('resize', layout);
    picker.addEventListener('change', () => show(picker.value));
    parent.addEventListener('click', () => { if (current()?.parentId) show(current().parentId); });
    scroller.addEventListener('scroll', () => {
      const view = views.get(selected);
      if (view) { if (scroller.scrollTop < lastTop - 1) view.follow = false; else if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24) view.follow = true; view.top = scroller.scrollTop; }
      lastTop = scroller.scrollTop;
    }, { passive: true });
    function updateDuration() {
      const worker = current();
      if (!panel.hidden && worker) setText(timer, elapsedText(worker));
      for (const [container, list] of lists) if (visible(container)) for (const view of list.values()) if (!view.button.hidden) setText(view.elapsed, elapsedText(view.worker));
    }
    const clock = setInterval(() => { if (!document.hidden && !document.getElementById('settings-dialog')?.open) updateDuration(); }, 1000);
    window.addEventListener('pagehide', () => clearInterval(clock), { once: true });
    function renderDetail(switched = false) {
      const worker = current();
      if (!worker || panel.hidden) return;
      setText(name, displayName(worker)); setText(status, labels[worker.status] || worker.status || '待执行'); status.dataset.status = worker.status;
      setText(task, worker.description || '');
      const ancestor = workers.find(item => item.id === worker.parentId);
      parent.hidden = !ancestor; if (ancestor) setText(parent, '来自 ' + displayName(ancestor) + ' ↗');
      setText(error, errorText(worker)); error.hidden = !error.textContent;
      let view = views.get(selected);
      if (!view) { view = { element: node('div', 'worker-transcript message-text'), top: 0, follow: true }; views.set(selected, view); }
      if (view.element.parentElement !== content) content.replaceChildren(view.element);
      const parts = Array.isArray(worker.parts) ? worker.parts : [];
      const fallback = worker.streamText || worker.result || (worker.status === 'queued' || worker.status === 'pending' ? '任务已派发，等待开始。' : worker.status === 'waiting' ? '正在等待子任务返回结果。' : worker.status === 'interrupted' ? '执行已停止，已有工作记录保留在此。' : worker.status === 'failed' ? '执行失败，请查看错误信息。' : worker.status === 'completed' ? '任务已结束，当前没有更多执行记录。' : '正在执行，输出将在此实时显示。');
      const top = switched ? view.top : scroller.scrollTop;
      const changed = window.UBOVMMessage.update(view.element, fallback, { ...actions, role: 'assistant', parts, streaming: worker.status === 'running' });
      picker.value = selected; updateDuration();
      if (switched || changed) {
        scroller.scrollTop = view.follow ? scroller.scrollHeight : top;
        lastTop = scroller.scrollTop;
      }
    }
    function renderList(container, values) {
      const cache = lists.get(container), kept = new Set(); let previous;
      for (const worker of values) {
        kept.add(worker.id); let view = cache.get(worker.id);
        if (!view) {
          const button = node('button', 'worker-card'); button.type = 'button'; button.dataset.workerId = worker.id; button.setAttribute('aria-controls', panel.id);
          const row = node('span', 'worker-card-heading'), label = node('strong'), state = node('span', 'worker-status'), description = node('span', 'worker-card-task'), preview = node('span', 'worker-card-preview');
          const footer = node('span', 'worker-card-footer'), elapsed = node('span', 'worker-duration'), created = node('span', 'worker-card-created');
          row.append(label, state);
          if (container === goalCards) { footer.append(created, elapsed); button.append(row, description, preview, footer); }
          else { footer.append(preview, elapsed); button.append(row, description, footer, created); }
          button.addEventListener('click', () => show(worker.id, button));
          view = { button, label, state, description, preview, elapsed, created }; cache.set(worker.id, view);
        }
        view.worker = worker;
        setText(view.label, displayName(worker)); setText(view.state, (container === cards ? shortLabels : labels)[worker.status] || worker.status || '待执行'); view.state.dataset.status = worker.status;
        setText(view.description, worker.description || '');
        const last = worker.parts?.at(-1);
        const latest = last?.type === 'tool' ? `${toolLabels[last.name] || (last.name?.startsWith('mcp_') ? '调用 MCP 工具' : '调用工具')}${last.status === 'failed' ? '失败' : last.status === 'running' ? '…' : last.status === 'interrupted' ? '已停止' : last.status === 'completed' ? '完成' : ''}` : last?.type === 'thinking' ? (last.status === 'streaming' || last.status === 'running' ? '正在思考…' : '已完成思考') : last?.type === 'summary' ? (last.status === 'running' ? '正在整理上下文…' : '上下文摘要已更新') : last?.text;
        const fallback = worker.status === 'queued' || worker.status === 'pending' ? '等待并发名额' : worker.status === 'waiting' ? '等待子任务返回' : worker.status === 'running' ? '等待实时输出…' : '点击查看工作记录';
        setText(view.preview, String(errorText(worker) || latest || worker.streamText || worker.result || fallback).replace(/\s+/g, ' ').slice(0, 150));
        setText(view.elapsed, elapsedText(worker));
        view.created.hidden = container !== goalCards;
        const createdAt = typeof worker.createdAt === 'number' ? worker.createdAt : Date.parse(worker.createdAt);
        setText(view.created, Number.isFinite(createdAt) ? '创建于 ' + new Date(createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : '创建时间未记录');
        view.button.setAttribute('aria-expanded', String(!panel.hidden && worker.id === selected));
        view.button.title = `${displayName(worker)} · ${labels[worker.status] || worker.status}\n${worker.description || ''}\n${view.preview.textContent}`;
        view.button.setAttribute('aria-label', `${displayName(worker)}，${labels[worker.status] || worker.status}，查看 Worker 会话`);
        view.button.dataset.depth = worker.depth > 1 ? 'nested' : 'root';
        view.button.dataset.status = worker.status;
        const next = previous ? previous.nextSibling : container.firstChild;
        if (view.button !== next) container.insertBefore(view.button, next); previous = view.button;
      }
      for (const [id, view] of cache) if (!kept.has(id)) { view.button.remove(); cache.delete(id); }
    }
    function renderRoster() {
      const issues = workers.filter(issue).length;
      setText(document.getElementById('worker-count'), String(workers.length));
      const count = status => workers.filter(worker => worker.status === status).length;
      const summary = [[count('running'), '执行'], [count('queued') + count('pending'), '排队'], [count('waiting'), '等待'], [count('completed'), '完成'], [issues, '异常']].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ');
      const swarmStatus = document.getElementById('worker-swarm-status');
      setText(swarmStatus, summary || '暂无 Worker'); swarmStatus.title = summary;
      document.getElementById('worker-count').parentElement.title = summary;
      const rank = worker => ({ running: 0, waiting: 1, queued: 2, pending: 2, failed: 3, interrupted: 4, completed: 5 })[worker.status] ?? 6;
      const primary = goalMode ? goalCards : cards;
      if (visible(primary)) renderList(primary, goalMode ? [...workers].sort((a, b) => rank(a) - rank(b)) : workers);
      setText(document.getElementById('goal-overview-worker-count'), workers.length + ' 个');
      const overviewSummary = document.getElementById('goal-overview-worker-summary');
      setText(overviewSummary, summary || '尚未派发 Worker');
      overviewSummary.title = summary || '尚未派发 Worker';
      overviewSummary.dataset.issues = String(issues > 0);
      document.getElementById('goal-overview-workers-empty').hidden = workers.length > 0;
      if (goalDirectory && goalMode && visible(goalDirectory)) {
        const query = search.value.trim().toLowerCase();
        const visible = workers.filter(worker => (!query || [worker.id, worker.name, worker.description].some(value => String(value || '').toLowerCase().includes(query))) &&
          (filter.value === 'all' || filter.value === 'active' && active.has(worker.status) || filter.value === 'completed' && worker.status === 'completed' || filter.value === 'issues' && issue(worker)));
        renderList(goalDirectory, visible);
        setText(document.getElementById('goal-workers-summary'), `${workers.length} 个 Worker${summary ? ' · ' + summary : ''}`);
        const empty = document.getElementById('goal-workers-empty'); empty.hidden = visible.length > 0;
        setText(empty, workers.length ? '没有匹配的 Worker，试试其他关键词或状态。' : '开始执行目标后，派发的 Worker 将显示在这里。');
      }
    }
    return {
      show,
      update(input) {
        if (sessionId !== input.sessionId) {
          dismiss(false); selected = ''; sessionId = input.sessionId; views.clear(); content.replaceChildren();
          cards.scrollLeft = 0;
          if (search) search.value = ''; if (filter) filter.value = 'all';
          for (const [container, cache] of lists) { cache.clear(); container.replaceChildren(); }
        }
        workers = [...new Map((input.workers ?? []).filter(worker => worker && typeof worker.id === 'string').map(worker => [worker.id, worker])).values()];
        goalMode = Boolean(input.goalMode);
        setText(close, goalMode ? '← 返回目标' : '← 主对话'); close.title = goalMode ? '返回目标工作区（Esc），Worker 继续运行' : '返回主对话（Esc），Worker 继续运行';
        const directoryError = document.getElementById('goal-workers-error');
        if (directoryError) { directoryError.hidden = !input.error; setText(directoryError, input.error ? '工作记录保存或读取失败：' + input.error : ''); }
        const visible = new Set(workers.map(worker => worker.id));
        for (const id of views.keys()) if (!visible.has(id)) views.delete(id);
        if (selected && !visible.has(selected)) { dismiss(false); selected = ''; }
        roster.hidden = input.goalMode || !workers.length && !input.error;
        const saveError = document.getElementById('worker-storage-error'); setText(saveError, input.error ? '工作记录保存或读取失败：' + input.error : ''); saveError.hidden = !input.error;
        renderRoster();
        const pickerKey = JSON.stringify(workers.map(worker => [worker.id, displayName(worker), worker.status]));
        if (picker.dataset.key !== pickerKey) {
          picker.replaceChildren(...workers.map(worker => { const option = node('option', '', `${displayName(worker)} · ${labels[worker.status] || worker.status}`); option.value = worker.id; return option; })); picker.dataset.key = pickerKey;
        }
        renderDetail();
      }
    };
  };
})();
