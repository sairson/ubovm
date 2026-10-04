(() => {
  const element = (tag, cls, text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  const equal = (left, right) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
  const partFields = ['id', 'type', 'text', 'name', 'args', 'output', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated', 'fallback', 'beforeTokens', 'afterTokens'];
  window.createGoalExecutionLog = (container, { actions, statusText, openWorker }) => {
    const pageSize = 120, rows = new Map();
    let session = '', latestExecution, start = null, firstId;
    const pager = element('div', 'goal-log-pager'); pager.hidden = true;
    const earlier = element('button', '', '较早日志'), newer = element('button', '', '较新日志'), latest = element('button', '', '最新日志'), range = element('span', '');
    for (const button of [earlier, newer, latest]) button.type = 'button';
    range.setAttribute('role', 'status'); pager.append(earlier, range, newer, latest); container.before(pager);
    function reset() {
      for (const row of rows.values()) window.UBOVMMessage.release?.(row.body);
      rows.clear(); container.replaceChildren(); latestExecution = undefined; firstId = undefined; start = null; session = ''; pager.hidden = true;
    }
    function page(offset) { start = Math.max(0, (start ?? Math.max(0, total - pageSize)) + offset); firstId = undefined; update(session, latestExecution); container.scrollTop = 0; }
    let total = 0;
    earlier.addEventListener('click', () => page(-pageSize)); newer.addEventListener('click', () => page(pageSize));
    function showLatest() { start = null; firstId = undefined; if (latestExecution) update(session, latestExecution); }
    latest.addEventListener('click', () => { showLatest(); container.scrollTop = container.scrollHeight; });
    function update(sessionId, execution) {
      if (session !== sessionId) { reset(); session = sessionId; }
      if (start === null && firstId && container.scrollHeight - container.scrollTop - container.clientHeight > 80) start = Math.max(0, total - pageSize);
      latestExecution = execution;
      const entries = [], parts = execution.parts || [];
      const inline = window.UBOVMTimeline.visibleTimelineParts(parts);
      const toolNames = new Set();
      window.UBOVMTimeline.eachToolPart({ execution }, part => { if (part.type === 'tool' && part.name) toolNames.add(part.name); });
      for (const part of inline) if (part.source !== 'worker' && ['text', 'thinking', 'tool', 'summary'].includes(part.type)) entries.push({
        id: 'part:' + part.id, time: timestamp(part.startedAt), kind: part.type, part,
        label: part.type === 'thinking' ? '规划 · 思考' : part.type === 'tool' ? '规划 · 工具调用' : part.type === 'summary' ? '上下文摘要' : part.source === 'reason' ? '规划 · 结论' : '规划 · 输出', status: part.status
      });
      for (const worker of execution.workers || []) {
        entries.push({ id: 'worker:' + worker.id, time: timestamp(worker.createdAt ?? worker.startedAt), kind: 'worker', label: '分派任务', worker, status: 'created' });
        if (worker.finishedAt) entries.push({ id: 'worker-end:' + worker.id, time: timestamp(worker.finishedAt), kind: 'worker', label: '任务结束', worker, status: worker.status });
      }
      for (const [index, activity] of (execution.activities || []).entries()) {
        if (activity.label === 'skill.loaded' && activity.status === 'completed') continue;
        if (toolNames.has(activity.label)) continue;
        entries.push({ id: 'activity:' + (activity.key || index), time: timestamp(activity.timestamp), kind: 'activity', label: activity.label === 'Reason' ? '规划 · 调度' : window.UBOVMTimeline.displayActivityLabel(activity.label), status: activity.status });
      }
      if (!parts.some(part => part.type === 'text') && execution.streamText) entries.push({ id: 'stream', kind: 'text', label: '规划 · 输出', text: execution.streamText });
      if (execution.status === 'completed' && execution.result?.summary) entries.push({ id: 'result', kind: 'result', label: '执行总结', text: execution.result.summary, status: 'completed' });
      entries.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
      total = entries.length;
      // Keep an older page stable as live records arrive; evict its DOM on paging.
      if (firstId && start !== null) { const index = entries.findIndex(entry => entry.id === firstId); if (index >= 0) start = index; }
      const offset = start === null ? Math.max(0, total - pageSize) : Math.min(start, Math.max(0, total - 1));
      const visibleEntries = entries.slice(offset, offset + pageSize);
      firstId = visibleEntries[0]?.id;
      pager.hidden = total <= pageSize;
      earlier.disabled = offset === 0; newer.disabled = offset + pageSize >= total;
      range.textContent = `${total ? offset + 1 : 0}–${Math.min(total, offset + pageSize)} / ${total} 条`;
      latest.disabled = start === null;
      const kept = new Set(); let previous;
      for (const entry of visibleEntries) {
        kept.add(entry.id); let row = rows.get(entry.id);
        if (!row) {
          const root = element('article', 'goal-log-entry'), heading = element('header', 'goal-log-heading'), time = element('time', 'goal-log-time'), label = element('strong', ''), state = element('span', 'goal-log-state'), body = element('div', 'goal-log-body');
          heading.append(time, label, state); root.append(heading, body); row = { root, time, label, state, body }; rows.set(entry.id, row);
        }
        // Compare scalar render inputs, not serialized historical tool outputs.
        // Keep heading updates separate so each token does not recreate them.
        const heading = [entry.kind, entry.label, entry.status, entry.time];
        if (!equal(row.heading, heading)) {
          row.root.dataset.kind = entry.kind; row.root.dataset.logId = entry.id;
          row.label.textContent = entry.label; row.state.textContent = entry.status === 'created' ? '已派发' : entry.status ? statusText(entry.status) : '';
          row.root.dataset.status = entry.status || '';
          row.time.textContent = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
          row.time.title = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleString('zh-CN') : '此记录未提供时间';
          row.heading = heading;
        }
        const workerError = typeof entry.worker?.error === 'string' ? entry.worker.error : entry.worker?.error?.message;
        const key = entry.worker ? [entry.worker.id, entry.worker.name, entry.worker.description, entry.worker.parentId, entry.id.startsWith('worker-end:') ? workerError : null]
          : [entry.kind, entry.text, Boolean(execution.busy && entry.kind === 'text'), ...partFields.map(field => entry.part?.[field])];
        if (!equal(row.key, key)) {
          if (entry.worker) {
            const worker = entry.worker, button = element('button', 'goal-log-worker', worker.name || worker.id); button.type = 'button';
            button.addEventListener('click', () => openWorker(worker.id, button));
            row.body.replaceChildren(button, element('p', '', worker.description || ''), element('small', '', worker.parentId ? '来自上级任务' : ''));
            const error = typeof worker.error === 'string' ? worker.error : worker.error?.message;
            if (error && entry.id.startsWith('worker-end:')) row.body.append(element('p', 'execution-error', error));
          } else if (entry.part || entry.text) {
            window.UBOVMMessage.update(row.body, entry.text || '', { ...actions, role: 'assistant', parts: entry.part ? [entry.part] : [], streaming: execution.busy && entry.kind === 'text' });
            if (entry.kind === 'thinking' && row.key === undefined && ['running', 'streaming'].includes(entry.part?.status)) {
              const thinking = row.body.querySelector('details');
              if (thinking && !thinking.open) thinking.open = true;
            }
          }
          row.key = key;
        }
        const next = previous ? previous.nextSibling : container.firstChild;
        if (next !== row.root) container.insertBefore(row.root, next); previous = row.root;
      }
      for (const [id, row] of rows) if (!kept.has(id)) { window.UBOVMMessage.release?.(row.body); row.root.remove(); rows.delete(id); }
      return entries.length;
    }
    return { update, reset, showLatest, dispose() { reset(); pager.remove(); } };
  };
})();
