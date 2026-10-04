(() => {
  'use strict';
  const node = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = window.UBOVMi18n?.t(text) ?? text;
    return element;
  };
  const tr = value => window.UBOVMi18n?.t(value) ?? value;
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const attribute = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const property = (element, name, value) => { if (element[name] !== value) element[name] = value; };
  const button = (className, label) => { const element = node('button', className, label); element.type = 'button'; return element; };
  const labels = { running: '运行中', completed: '已完成', interrupted: '已停止', failed: '失败' };
  const status = task => tr(task.status === 'running' ? ({ queued: '排队中', starting: '准备中', stopping: '正在停止' }[task.executionState] || '运行中') : labels[task.status] || '状态未知');
  const running = task => task.status === 'running';
  function command(task) {
    try { return JSON.parse(task.args || '{}').command || task.name; } catch { return task.args || task.name; }
  }
  function elapsed(task) {
    if (!Number.isFinite(task.startedAt)) return '';
    const seconds = Math.max(0, Math.floor(((running(task) ? Date.now() : task.endedAt ?? task.startedAt) - task.startedAt) / 1000));
    return seconds < 60 ? seconds + '秒' : Math.floor(seconds / 60) + '分 ' + seconds % 60 + '秒';
  }
  function lastLine(output) {
    return String(output || '').slice(-1000).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n').filter(line => line.trim()).at(-1)?.slice(0, 160) || '';
  }
  window.createBackgroundTasks = function createBackgroundTasks(actions) {
    const element = node('section', 'background-tasks'); element.id = 'background-tasks'; element.hidden = true;
    element.setAttribute('aria-label', '后台任务');
    const header = node('div', 'background-tasks-header');
    const toggle = button('background-tasks-toggle', ''); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'background-tasks-body');
    const indicator = node('span', 'background-task-indicator'); indicator.setAttribute('aria-hidden', 'true');
    const title = node('span', 'background-tasks-title', '后台任务');
    const count = node('span', 'background-tasks-count');
    const chevron = node('span', 'background-tasks-chevron', '⌃'); chevron.setAttribute('aria-hidden', 'true');
    toggle.append(indicator, title, count, chevron);
    const clear = button('background-tasks-clear', '清除已结束'); clear.hidden = true;
    header.append(toggle, clear);
    const peek = node('p', 'background-tasks-peek');
    const body = node('div', 'background-tasks-body'); body.id = 'background-tasks-body'; body.hidden = true;
    const list = node('div', 'background-task-list'); list.setAttribute('aria-label', '后台命令列表');
    const detail = node('section', 'background-task-detail'); detail.hidden = true; detail.setAttribute('aria-label', '任务日志');
    const detailHeader = node('div', 'background-task-detail-header');
    const detailTitle = node('code', 'background-task-detail-command');
    const follow = button('background-task-action', '跟随日志'); follow.setAttribute('aria-pressed', 'true');
    const copy = button('background-task-action', '复制日志');
    const stop = button('background-task-stop', '停止任务');
    detailHeader.append(detailTitle, follow, copy, stop);
    const meta = node('p', 'background-task-detail-meta');
    const output = node('pre', 'background-task-log'); output.tabIndex = 0; output.setAttribute('aria-label', '后台任务输出');
    const notice = node('p', 'background-task-notice'); notice.setAttribute('role', 'status');
    detail.append(detailHeader, meta, output, notice); body.append(list, detail); element.append(header, peek, body);
    let sessionId, tasks = [], selected, expanded = false, following = true, timer, suspended = false, disconnected = false;
    let renderedSelection, renderedOutput, copyRequest = 0, sessionRevision = 0;
    const reading = new Map();
    const rows = new Map(), dismissed = new Set(), stopping = new Set();
    const selectedTask = () => tasks.find(task => task.commandId === selected);
    function setExpanded(value) {
      expanded = value; body.hidden = !value; peek.hidden = value;
      toggle.setAttribute('aria-expanded', String(value));
      if (value && !selected) selected = tasks.find(running)?.commandId || tasks[0]?.commandId;
      render();
      if (value && following) output.scrollTop = output.scrollHeight;
    }
    toggle.addEventListener('click', () => setExpanded(!expanded));
    clear.addEventListener('click', () => {
      for (const task of tasks) if (!running(task)) dismissed.add(task.commandId);
      tasks = tasks.filter(task => !dismissed.has(task.commandId)); render();
    });
    body.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.focus(); }
    });
    follow.addEventListener('click', () => {
      following = !following; follow.setAttribute('aria-pressed', String(following));
      if (following) output.scrollTop = output.scrollHeight;
    });
    output.addEventListener('scroll', () => {
      if (output.scrollHeight - output.clientHeight - output.scrollTop > 8) {
        following = false; follow.setAttribute('aria-pressed', 'false');
      }
      if (renderedSelection) reading.set(renderedSelection, { top: output.scrollTop, following });
    });
    copy.addEventListener('click', async () => {
      const task = selectedTask(), origin = sessionId; if (!task || copy.disabled) return;
      const request = ++copyRequest;
      copy.disabled = true;
      try { if (await actions.onCopy?.(task.output || '') === false) throw new Error(); if (origin === sessionId && selected === task.commandId && request === copyRequest) text(notice, tr('日志已复制')); }
      catch { if (origin === sessionId && selected === task.commandId && request === copyRequest) text(notice, tr('复制失败，请重试')); }
      finally { if (request === copyRequest) copy.disabled = false; }
    });
    stop.addEventListener('click', async () => {
      const task = selectedTask(), origin = sessionRevision;
      if (!task || !running(task) || stop.disabled) return;
      stopping.add(task.commandId); renderDetail();
      try { if (await actions.onInterruptCommand(task.commandId) === false) throw new Error(); }
      catch {
        if (origin === sessionRevision) { stopping.delete(task.commandId); if (selected === task.commandId) text(notice, tr('停止请求未确认，请重试')); renderDetail(); }
      }
    });
    function renderDetail() {
      const task = selectedTask(); property(detail, 'hidden', !task);
      for (const [id, row] of rows) attribute(row.button, 'aria-pressed', String(id === selected));
      if (!task || !expanded) return;
      const switched = renderedSelection !== task.commandId;
      if (switched) {
        if (renderedSelection) reading.set(renderedSelection, { top: output.scrollTop, following });
        renderedSelection = task.commandId;
        following = reading.get(renderedSelection)?.following ?? true;
        follow.setAttribute('aria-pressed', String(following));
      }
      text(detailTitle, command(task)); attribute(detailTitle, 'title', command(task));
      text(meta, (disconnected && running(task) ? tr('连接中断 · 状态待确认') : status(task)) + ' · ' + task.owner + ' · ' + elapsed(task));
      property(stop, 'hidden', !running(task)); property(stop, 'disabled', disconnected || task.interruptRequested === true || stopping.has(task.commandId));
      text(stop, tr(task.interruptRequested || stopping.has(task.commandId) ? '正在停止…' : '停止任务'));
      const value = task.output || (running(task) ? '等待命令输出…' : '无文本输出。');
      if (switched || renderedOutput !== value) {
        const top = switched ? reading.get(renderedSelection)?.top ?? 0 : output.scrollTop, previous = renderedOutput || '';
        if (!switched && output.firstChild?.nodeType === Node.TEXT_NODE && value.startsWith(previous)) output.firstChild.appendData(value.slice(previous.length));
        else text(output, value);
        renderedOutput = value;
        output.scrollTop = following ? output.scrollHeight : top;
      }
      if (switched) output.scrollTop = following ? output.scrollHeight : reading.get(renderedSelection)?.top ?? 0;
    }
    function tick() {
      if (document.hidden || suspended || element.closest('[hidden]') || document.getElementById('settings-dialog')?.open) return;
      for (const task of tasks) { const row = rows.get(task.commandId); if (row) text(row.time, elapsed(task)); }
      const task = selectedTask();
      if (task) text(meta, (disconnected && running(task) ? tr('连接中断 · 状态待确认') : status(task)) + ' · ' + task.owner + ' · ' + elapsed(task));
    }
    function syncClock() {
      const needed = expanded && !element.hidden && !document.hidden && !suspended && !document.getElementById('settings-dialog')?.open && tasks.some(running);
      if (!needed) { clearInterval(timer); timer = undefined; }
      else if (!timer) timer = setInterval(tick, 1000);
    }
    document.addEventListener('visibilitychange', syncClock);
    window.addEventListener('ubovm-settings-visibility', syncClock);
    window.addEventListener('pagehide', () => { suspended = true; syncClock(); });
    window.addEventListener('pageshow', () => { suspended = false; syncClock(); });
    function render() {
      property(element, 'hidden', !tasks.length);
      const active = tasks.filter(running), failed = tasks.filter(task => task.status === 'failed');
      attribute(element, 'data-status', disconnected && active.length ? 'unknown' : active.length ? 'running' : failed.length ? 'failed' : 'completed');
      text(count, disconnected && active.length ? tr('状态待确认') : [active.length ? tr('{0} 运行中', active.length) : tr('{0} 已结束', tasks.length), failed.length ? tr('{0} 失败', failed.length) : ''].filter(Boolean).join(' · '));
      property(clear, 'hidden', !tasks.some(task => !running(task)));
      const lead = active[0] || failed[0] || tasks[0];
      if (!expanded) {
        const tail = lead ? lastLine(lead.output) : '';
        text(peek, lead ? command(lead).replace(/\s+/g, ' ') + (tail ? ' · ' + tail : '') : '');
        attribute(peek, 'title', peek.textContent);
      }
      const ids = new Set(tasks.map(task => task.commandId));
      for (const id of reading.keys()) if (!ids.has(id)) reading.delete(id);
      for (const task of tasks) if (!running(task)) stopping.delete(task.commandId);
      for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
      if (!ids.has(selected)) { selected = tasks.find(running)?.commandId || tasks[0]?.commandId; text(notice, ''); }
      // Folded docks only update the small preview. Render their latest rows
      // and log when opened, keeping hidden work out of streaming updates.
      if (!expanded) { syncClock(); return; }
      let cursor = list.firstChild;
      for (const task of tasks) {
        let row = rows.get(task.commandId);
        if (!row) {
          const rowElement = node('div', 'background-task-row');
          const select = button('background-task-select', '');
          const dot = node('span', 'background-task-indicator'); dot.setAttribute('aria-hidden', 'true');
          const name = node('code', 'background-task-name'), owner = node('span', 'background-task-owner');
          const info = node('span', 'background-task-info');
          const state = node('span', 'background-task-state'), time = node('span', 'background-task-time');
          const main = node('span', 'background-task-main'); main.append(name, owner); info.append(state, time);
          select.append(dot, main, info); rowElement.append(select);
          row = { element: rowElement, button: select, name, owner, state, time }; rows.set(task.commandId, row);
          select.addEventListener('click', () => { if (selected === task.commandId) return; selected = task.commandId; text(notice, ''); renderDetail(); });
        }
        attribute(row.element, 'data-status', disconnected && running(task) ? 'unknown' : task.status);
        text(row.name, command(task).replace(/\s+/g, ' ')); attribute(row.name, 'title', command(task));
        text(row.owner, task.owner); text(row.state, disconnected && running(task) ? '待确认' : status(task)); text(row.time, elapsed(task));
        attribute(row.button, 'aria-label', command(task) + '，' + task.owner + '，' + status(task));
        if (row.element !== cursor) list.insertBefore(row.element, cursor); cursor = row.element.nextSibling;
      }
      renderDetail(); syncClock();
    }
    return { element, update(state, offline = false) {
      const id = state.conversation?.id;
      if (sessionId !== id) {
        // Returning to the same ID must not revive callbacks from a prior visit.
        sessionRevision++;
        sessionId = id; dismissed.clear(); stopping.clear(); reading.clear(); renderedSelection = undefined; renderedOutput = undefined; following = true;
        copyRequest++; copy.disabled = false; follow.setAttribute('aria-pressed', 'true'); selected = undefined;
        rows.forEach(row => row.element.remove()); rows.clear(); tasks = []; text(output, ''); text(notice, ''); setExpanded(false);
      }
      disconnected = offline;
      const found = new Map();
      const collect = (parts, owner) => {
        for (const task of parts || []) if (task.type === 'tool' && task.background === true && task.commandId && !dismissed.has(task.commandId)) found.set(task.commandId, { ...task, owner });
      };
      for (const message of state.messages || []) collect(message.parts, '主 Agent');
      collect(state.execution?.parts, '主 Agent');
      for (const worker of state.execution?.workers || []) collect(worker.parts, worker.title || worker.intent?.description || worker.id || '并行任务');
      // Existing rows stay where the user clicked as tasks finish or new ones
      // arrive. Preserve their identity, focus and list scroll position.
      const order = new Map(tasks.map((task, index) => [task.commandId, index]));
      tasks = [...found.values()].sort((a, b) => (order.get(a.commandId) ?? tasks.length) - (order.get(b.commandId) ?? tasks.length));
      render();
    } };
  };
})();
