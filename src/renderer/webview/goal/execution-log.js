(() => {
  const element = (tag, cls, text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  window.createGoalExecutionLog = (container, { actions, statusText, openWorker }) => {
    let session = ''; const rows = new Map();
    return { update(sessionId, execution) {
      if (session !== sessionId) { session = sessionId; rows.clear(); container.replaceChildren(); }
      const entries = [], parts = execution.parts || [];
      for (const part of parts) if (part.source !== 'worker' && ['text', 'thinking', 'tool', 'summary'].includes(part.type)) entries.push({
        id: 'part:' + part.id, time: timestamp(part.startedAt), kind: part.type, part,
        label: part.type === 'thinking' ? 'Reason Agent · 思考' : part.type === 'tool' ? 'Reason Agent · 工具调用' : part.type === 'summary' ? '上下文摘要' : 'Reason Agent · 输出', status: part.status
      });
      for (const worker of execution.workers || []) {
        entries.push({ id: 'worker:' + worker.id, time: timestamp(worker.createdAt ?? worker.startedAt), kind: 'worker', label: '创建 Worker', worker, status: 'created' });
        if (worker.finishedAt) entries.push({ id: 'worker-end:' + worker.id, time: timestamp(worker.finishedAt), kind: 'worker', label: 'Worker 执行结束', worker, status: worker.status });
      }
      for (const [index, activity] of (execution.activities || []).entries()) {
        if (parts.some(part => part.type === 'tool' && part.name === activity.label)) continue;
        entries.push({ id: 'activity:' + (activity.key || index), time: timestamp(activity.timestamp), kind: 'activity', label: activity.label === 'Reason' ? 'Reason Agent · 调度' : activity.label, status: activity.status });
      }
      if (!parts.some(part => part.type === 'text') && execution.streamText) entries.push({ id: 'stream', kind: 'text', label: 'Reason Agent · 输出', text: execution.streamText });
      if (execution.status === 'completed' && execution.result?.summary) entries.push({ id: 'result', kind: 'result', label: '执行总结', text: execution.result.summary, status: 'completed' });
      entries.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
      const kept = new Set(); let previous;
      for (const entry of entries) {
        kept.add(entry.id); let row = rows.get(entry.id);
        if (!row) {
          const root = element('article', 'goal-log-entry'), heading = element('header', 'goal-log-heading'), time = element('time', 'goal-log-time'), label = element('strong', ''), state = element('span', 'goal-log-state'), body = element('div', 'goal-log-body');
          heading.append(time, label, state); root.append(heading, body); row = { root, time, label, state, body }; rows.set(entry.id, row);
        }
        const key = JSON.stringify([entry.worker ? [entry.label, entry.time, entry.worker.id, entry.worker.name, entry.worker.description, entry.worker.parentId, entry.status, entry.id.startsWith('worker-end:') ? entry.worker.error : null] : entry, Boolean(execution.busy && entry.kind === 'text')]);
        if (row.key !== key) {
          row.root.dataset.kind = entry.kind; row.root.dataset.logId = entry.id;
          row.label.textContent = entry.label; row.state.textContent = entry.status === 'created' ? '已派发' : entry.status ? statusText(entry.status) : '';
          row.root.dataset.status = entry.status || '';
          row.time.textContent = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
          row.time.title = Number.isFinite(entry.time) ? new Date(entry.time).toLocaleString('zh-CN') : '此记录未提供时间';
          if (entry.worker) {
            const worker = entry.worker, button = element('button', 'goal-log-worker', worker.name || worker.id); button.type = 'button';
            button.addEventListener('click', () => openWorker(worker.id, button));
            row.body.replaceChildren(button, element('p', '', worker.description || ''), element('small', '', worker.parentId ? '父 Worker：' + worker.parentId : 'Worker ID：' + worker.id));
            const error = typeof worker.error === 'string' ? worker.error : worker.error?.message;
            if (error && entry.id.startsWith('worker-end:')) row.body.append(element('p', 'execution-error', error));
          } else if (entry.part || entry.text) {
            window.UBOVMMessage.update(row.body, entry.text || '', { ...actions, role: 'assistant', parts: entry.part ? [entry.part] : [], streaming: execution.busy && entry.kind === 'text' });
            if (entry.kind === 'thinking' && row.key === undefined) { const thinking = row.body.querySelector('details'); if (thinking) thinking.open = true; }
          }
          row.key = key;
        }
        const next = previous ? previous.nextSibling : container.firstChild;
        if (next !== row.root) container.insertBefore(row.root, next); previous = row.root;
      }
      for (const [id, row] of rows) if (!kept.has(id)) { row.root.remove(); rows.delete(id); }
      return entries.length;
    } };
  };
})();
