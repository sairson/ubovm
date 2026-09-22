(() => {
  'use strict';
  const views = new WeakMap(), active = new Set();
  let clock;
  const labels = { running: '运行中', completed: '完成', failed: '失败', interrupted: '已停止' };
  const tools = { search_workspace: '搜索项目代码', get_workspace_diagnostics: '读取代码诊断', validate_workspace_changes: '验证代码修改', recover_workspace_changes: '恢复代码修改状态', read_workspace_code: '读取待编辑代码', edit_workspace_file: '编辑代码', list_workspace_changes: '查看代码更改', wait_workers: '等待协作结果', spawn_worker: '启动协作任务', read_worker_evidence: '查看协作记录', read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令', run_linux_ssh_command: '运行命令', upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', fetch_web_content: '读取网页', web_search: '搜索网页', load_skill: '加载技能', read_skills_resource: '读取技能资源', run_local_skill_script: '执行技能脚本', note: '更新笔记', todo: '更新任务', browser_action: '浏览器操作', read_context_evidence: '读取上下文证据' };
  const kinds = { search_workspace: 'search', get_workspace_diagnostics: 'search', validate_workspace_changes: 'tool', recover_workspace_changes: 'file', read_workspace_code: 'file', edit_workspace_file: 'file', list_workspace_changes: 'folder', read_workspace_file: 'file', list_workspace_files: 'folder', run_local_shell_command: 'terminal', run_linux_ssh_command: 'terminal', upload_sftp: 'file', deploy_remote_service: 'terminal', fetch_web_content: 'browser', web_search: 'search', load_skill: 'skill', read_skills_resource: 'skill', run_local_skill_script: 'terminal', note: 'memory', todo: 'memory', browser_action: 'browser', read_context_evidence: 'search' };
  const icons = {
    file: 'M9 3H5v18h14V9L13 3H9m4 0v6h6M8 13h8M8 17h6',
    folder: 'M3 6h7l2 2h9v12H3V6Z',
    terminal: 'm5 7 5 5-5 5m8 0h6',
    browser: 'M3 5h18v15H3V5Zm0 5h18M7 7.5h.01M10 7.5h.01',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 6 6',
    skill: 'm12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z',
    memory: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
    mcp: 'm5 8 4-4 11 11-4 4L5 8Zm0 0L2 11l4 4m10 4-3 3M11 6l3-3 7 7-3 3',
    tool: 'm8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18',
  };
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function duration(view) {
    const start = Number(view.part.startedAt), end = Number(view.part.endedAt);
    if (!Number.isFinite(start) || start <= 0) { setText(view.time, ''); return; }
    if (view.part.status !== 'running' && (!Number.isFinite(end) || end < start)) { setText(view.time, ''); return; }
    const seconds = Math.max(0, ((Number.isFinite(end) && end >= start ? end : Date.now()) - start) / 1000);
    setText(view.time, seconds < 60 ? (seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + 's' : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's');
  }
  function tick() {
    for (const view of active) {
      if (!view.element.isConnected || view.part.status !== 'running') active.delete(view);
      else if (!document.hidden && !document.body.classList.contains('settings-visible') && !view.element.closest('[hidden]')) duration(view);
    }
    if (!active.size) { clearInterval(clock); clock = undefined; }
  }
  function trackDuration(view) {
    duration(view);
    if (view.part.status === 'running') { active.add(view); if (!clock) clock = setInterval(tick, 1000); }
    else active.delete(view);
  }
  function parameters(part) {
    try { const value = JSON.parse(part.args || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; } // Truncated parameters remain visible as plain text.
  }
  function hint(part, input) {
    for (const key of ['path', 'url', 'query', 'command', 'name', 'skill', 'action']) if (typeof input[key] === 'string' && input[key]) return input[key].replace(/\s+/g, ' ').slice(0, 160);
    return part.name?.startsWith('mcp_') ? part.name.slice(4) : '';
  }
  function fileTarget(part, input) {
    if (!['read_workspace_file', 'read_workspace_code'].includes(part.name) || typeof input.path !== 'string' || !input.path.trim()) return null;
    const rootIndex = input.root === undefined ? 0 : input.root;
    if (!Number.isSafeInteger(rootIndex) || rootIndex < 0) return null;
    // Tool arguments are literal paths, unlike Markdown URLs. Protect URL
    // metacharacters before the host splits a fragment and decodes the path.
    const href = input.path.replace(/[%#?]/g, character => encodeURIComponent(character));
    return { href, rootIndex };
  }
  function setOutput(view, value) {
    const output = view.output, previous = output.textContent;
    if (previous === value) return;
    const visible = view.element.open && view.element.isConnected && !document.hidden && !view.element.closest('[hidden]');
    const top = visible ? output.scrollTop : 0;
    const follow = visible && output.scrollHeight - output.clientHeight - top <= 3;
    if (output.firstChild?.nodeType === Node.TEXT_NODE && value.startsWith(previous)) output.firstChild.appendData(value.slice(previous.length));
    else output.textContent = value;
    if (visible) output.scrollTop = follow ? output.scrollHeight : top;
  }
  function htmlSource(value) { return /^\s*(?:<!doctype\s+html|<(?:html|head|body|main|section|article|div|style|h[1-6]|p)(?:\s|>))/i.test(value); }
  function createTool() {
    const element = node('details', 'tool-card');
    const summary = node('summary', 'tool-card-summary');
    const icon = node('span', 'tool-kind-icon'); icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.append(iconPath); icon.append(svg);
    const indicator = node('span', 'tool-indicator'); indicator.setAttribute('aria-hidden', 'true');
    icon.append(indicator);
    const title = node('span', 'tool-title'), path = node('span', 'tool-path'), status = node('span', 'tool-status-label'), time = node('span', 'tool-time');
    const main = node('span', 'tool-summary-main'); main.append(title, path);
    const state = node('span', 'tool-status'); state.append(status);
    const details = node('span', 'tool-card-meta'); details.append(state, time);
    const chevron = node('span', 'tool-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    summary.append(icon, main, details, chevron);
    const body = node('div', 'tool-card-body'), meta = node('div', 'tool-detail-name');
    const input = node('pre', 'tool-parameters'), output = node('pre', 'tool-output');
    output.tabIndex = input.tabIndex = 0; output.setAttribute('aria-label', '工具输出'); input.setAttribute('aria-label', '工具参数');
    const actions = node('div', 'tool-result-toolbar'), info = node('span', 'tool-result-info');
    const copy = node('button', 'tool-action', '复制输出'), preview = node('button', 'tool-action', '预览 HTML'), open = node('button', 'tool-action', '打开文件');
    copy.type = preview.type = open.type = 'button';
    actions.append(node('span', 'tool-result-label', '输出'), info, open, preview, copy);
    const args = node('details', 'tool-arguments'); args.append(node('summary', '', '参数'), meta, input);
    const notice = node('p', 'tool-truncation', '显示内容已截断。');
    body.append(actions, output, args, notice);
    element.append(summary, body);
    const view = { element, icon, iconPath, title, path, status, time, meta, input, output, info, copy, preview, open, notice, part: {}, options: {} };
    copy.addEventListener('click', async () => {
      if (!view.options.onCopy) return;
      clearTimeout(view.copyReset);
      copy.disabled = true;
      try { await view.options.onCopy(view.part.output || ''); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败'; }
      finally { copy.disabled = false; view.copyReset = setTimeout(() => { copy.textContent = '复制输出'; }, 1400); }
    });
    preview.addEventListener('click', () => view.options.onPreviewHtml?.(view.part.output || '', preview));
    open.addEventListener('click', async () => {
      if (!view.target || !view.options.onOpenLink) return;
      clearTimeout(view.openReset); open.textContent = '打开文件';
      open.disabled = true;
      try { if (await view.options.onOpenLink(view.target.href, { rootIndex: view.target.rootIndex }) === false) throw new Error('File open failed'); }
      catch { open.textContent = '打开失败'; view.openReset = setTimeout(() => { open.textContent = '打开文件'; }, 1400); }
      finally { open.disabled = false; }
    });
    return view;
  }
  function updateTool(view, part, options) {
    view.options = options;
    // Outputs can be large. Compare the rendered fields without copying and
    // serializing every completed tool on each incoming text token.
    const keys = ['id', 'name', 'status', 'args', 'output', 'startedAt', 'endedAt', 'truncated'];
    if (keys.every(key => part[key] === view.part[key])) return false;
    const argumentsChanged = part.name !== view.part.name || part.args !== view.part.args;
    view.part = { ...part };
    const status = labels[part.status] ? part.status : 'completed';
    view.element.dataset.status = status;
    setText(view.title, tools[part.name] || (part.name?.startsWith('mcp_') ? 'MCP 工具' : part.name || '工具调用'));
    if (argumentsChanged) {
      const input = parameters(part), kind = kinds[part.name] || (part.name?.startsWith('mcp_') ? 'mcp' : 'tool');
      view.icon.dataset.kind = kind; view.iconPath.setAttribute('d', icons[kind]);
      setText(view.path, hint(part, input)); view.path.title = view.path.textContent;
      view.title.title = tools[part.name] || part.name || '工具调用';
      view.target = fileTarget(part, input);
    }
    setText(view.status, labels[status]);
    setText(view.meta, part.name || '工具');
    setText(view.input, part.args || '{}');
    setOutput(view, part.output || (status === 'running' ? '等待工具返回…' : status === 'interrupted' ? '调用已停止，执行状态请以已有记录为准。' : '无文本输出。'));
    const lines = part.output ? part.output.split('\n').length - (part.output.endsWith('\n') ? 1 : 0) : 0;
    setText(view.info, (status === 'running' ? '接收中' : '') + (lines ? (status === 'running' ? ' · ' : '') + lines + ' 行' : ''));
    view.open.hidden = !view.target;
    view.copy.hidden = !part.output;
    view.preview.hidden = !part.output || !htmlSource(part.output);
    view.notice.hidden = !part.truncated;
    trackDuration(view);
    return true;
  }
  function renderThinking(view) {
    // Defer parsing while manually collapsed and retain Markdown nodes while streaming.
    if (!view.element.open) return false;
    const body = view.body;
    const visible = view.element.isConnected && !document.hidden && !document.body.classList.contains('settings-visible') && !view.element.closest('[hidden]');
    const top = visible ? body.scrollTop : 0;
    const follow = view.rendered && visible && body.scrollHeight - body.clientHeight - top <= 3;
    const changed = markdown(view.content, view.displayText ?? view.part.text ?? '', { ...view.options, streaming: view.part.type !== 'summary' && view.part.status === 'running' });
    if (visible && changed) body.scrollTop = follow ? body.scrollHeight : top;
    view.rendered = true;
    return changed;
  }
  function createThinking(kind = 'thinking') {
    const element = node('details', 'thinking-card' + (kind === 'summary' ? ' summary-card' : '')), summary = node('summary', 'thinking-summary');
    element.open = kind === 'thinking';
    const indicator = node('span', 'thinking-indicator'); indicator.setAttribute('aria-hidden', 'true');
    const title = node('span', 'thinking-title'), source = node('span', 'thinking-source'), time = node('span', 'thinking-time');
    const chevron = node('span', 'thinking-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    summary.append(indicator, title, source, time, chevron);
    const body = node('div', 'thinking-body'), content = node('div', 'thinking-content');
    body.tabIndex = 0; body.setAttribute('aria-label', kind === 'summary' ? '上下文摘要' : '思考内容');
    const metrics = node('p', 'summary-metrics'); metrics.hidden = true;
    const notice = node('p', 'thinking-truncation', '思考内容较长，此处显示已保留的部分。');
    if (kind === 'summary') body.append(metrics);
    body.append(content, notice); element.append(summary, body);
    const view = { element, title, source, time, body, content, metrics, notice, part: {}, options: {}, rendered: false };
    element.addEventListener('toggle', () => { if (element.open) renderThinking(view); });
    return view;
  }
  function updateThinking(view, part, options) {
    view.options = options;
    const keys = ['id', 'text', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated'];
    if (keys.every(key => part[key] === view.part[key])) return false;
    view.part = { ...part };
    const status = ['running', 'interrupted'].includes(part.status) ? part.status : 'completed';
    const source = ['reason', 'worker'].includes(part.source) ? part.source : 'assistant';
    view.element.dataset.status = status; view.element.dataset.source = source;
    setText(view.title, status === 'running' ? '思考中' : status === 'interrupted' ? '思考已停止' : '已思考');
    setText(view.source, source === 'reason' ? 'Reason' : source === 'worker' ? 'Worker' : '');
    view.source.title = source === 'worker' && part.workerId ? 'Worker · ' + part.workerId : view.source.textContent;
    view.notice.hidden = !part.truncated;
    trackDuration(view);
    renderThinking(view);
    return true;
  }
  function updateSummary(view, part, options) {
    view.options = options;
    const keys = ['id', 'text', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated', 'fallback', 'beforeTokens', 'afterTokens'];
    if (keys.every(key => part[key] === view.part[key])) return false;
    view.part = { ...part };
    const status = ['running', 'failed', 'interrupted'].includes(part.status) ? part.status : 'completed';
    view.element.dataset.status = status;
    setText(view.title, { running: '正在整理上下文', completed: '上下文摘要', failed: '摘要未完成', interrupted: '摘要已停止' }[status]);
    setText(view.source, part.source === 'reason' ? 'Reason' : part.source === 'worker' ? 'Worker' : '');
    view.source.title = part.workerId || view.source.textContent;
    view.displayText = part.text || { running: '正在整理较早的对话与工具记录，完成后会在此显示摘要。', completed: '本次上下文整理已完成。', failed: '上下文整理未完成，请查看本轮执行错误。', interrupted: '上下文整理已停止。' }[status];
    if (part.fallback) view.displayText = '本次使用原文摘录，未生成完整摘要。\n\n' + view.displayText;
    const hasMetrics = [part.beforeTokens, part.afterTokens].every(value => Number.isSafeInteger(value) && value >= 0);
    view.metrics.hidden = !hasMetrics;
    setText(view.metrics, hasMetrics ? `上下文用量估算：${part.beforeTokens.toLocaleString('en-US')} → ${part.afterTokens.toLocaleString('en-US')} tokens` : '');
    view.notice.hidden = !part.truncated; setText(view.notice, '摘要较长，此处仅显示已保留的部分。');
    trackDuration(view); renderThinking(view);
    return true;
  }
  function markdown(element, text, options) {
    if (window.UBOVMMarkdown) return window.UBOVMMarkdown.update(element, text, options);
    if (element.textContent === text) return false;
    element.textContent = text; return true;
  }
  function update(element, text, options = {}) {
    let parts = Array.isArray(options.parts) ? options.parts.filter(part => part && typeof part.id === 'string' && ['text', 'tool', 'thinking', 'summary'].includes(part.type)) : [];
    const tail = parts.at(-1);
    const writing = tail?.type === 'text' && tail.status === 'streaming' && Boolean(tail.text);
    const showCursor = options.streaming === true && (parts.length ? writing : Boolean(text));
    if (!options.maintenanceNested) {
      const grouped = [];
      const maintenance = part => part.type === 'summary' || part.type === 'tool' && part.name === 'wait_workers';
      for (let index = 0; index < parts.length;) {
        if (!maintenance(parts[index])) { grouped.push(parts[index++]); continue; }
        let end = index + 1;
        while (end < parts.length && maintenance(parts[end])) end++;
        const entries = parts.slice(index, end);
        grouped.push(entries.length > 1 ? { id: 'maintenance:' + entries[0].id, type: 'maintenance', entries } : entries[0]);
        index = end;
      }
      parts = grouped;
    }
    let view = views.get(element);
    const mode = options.role === 'user' ? 'plain' : parts.length ? 'parts' : 'markdown';
    if (!view || view.mode !== mode || mode === 'markdown' && view.content.parentNode !== element) {
      if (view?.parts) for (const item of view.parts.values()) active.delete(item);
      element.replaceChildren();
      view = { mode, parts: new Map(), groups: new Map() }; views.set(element, view);
      if (mode === 'markdown') { view.content = node('div', 'response-text'); element.appendChild(view.content); }
    }
    element.classList.toggle('message-timeline', mode === 'parts');
    element.classList.toggle('message-prose', mode !== 'plain');
    element.classList.toggle('response-streaming', showCursor);
    if (mode === 'plain') { if (element.textContent === text) return false; element.textContent = text; return true; }
    if (mode === 'markdown') return markdown(view.content, text, options);
    let changed = false, previous = null, group = null, previousTool = null;
    const remaining = new Set(view.parts.keys());
    const remainingGroups = new Set(view.groups.keys());
    for (const part of parts) {
      remaining.delete(part.id);
      let item = view.parts.get(part.id);
      if (!item || item.type !== part.type) {
        if (item) { active.delete(item); item.element.remove(); }
        if (part.type === 'maintenance') {
          const details = node('details', 'maintenance-group'), title = node('summary', 'maintenance-toggle'), content = node('div', 'maintenance-content');
          details.append(title, content); item = { element: details, title, content };
        } else item = part.type === 'tool' ? createTool() : ['thinking', 'summary'].includes(part.type) ? createThinking(part.type) : { element: node('div', 'response-text') };
        item.type = part.type; view.parts.set(part.id, item); changed = true;
      }
      if (part.type === 'tool') {
        if (!group) {
          group = view.groups.get(part.id);
          if (!group) { group = node('div', 'tool-group'); view.groups.set(part.id, group); }
          remainingGroups.delete(part.id);
          const next = previous ? previous.nextSibling : element.firstChild;
          if (group !== next) { element.insertBefore(group, next); changed = true; }
          previous = group; previousTool = null;
        }
        const next = previousTool ? previousTool.nextSibling : group.firstChild;
        if (item.element !== next) { group.insertBefore(item.element, next); changed = true; }
        previousTool = item.element;
      } else {
        group = null;
        const next = previous ? previous.nextSibling : element.firstChild;
        if (item.element !== next) { element.insertBefore(item.element, next); changed = true; }
        previous = item.element;
      }
      if (part.type === 'maintenance') {
        const running = part.entries.findLast(entry => entry.status === 'running');
        const failed = part.entries.some(entry => entry.status === 'failed');
        const interrupted = part.entries.some(entry => entry.status === 'interrupted');
        const count = part.entries.filter(entry => entry.type === 'summary').length;
        const label = failed ? '后台步骤失败，请展开查看' : interrupted ? '后台步骤已停止' : running?.type === 'summary' ? '正在整理上下文' : running ? '正在等待协作结果' : '后台步骤已完成';
        setText(item.title, label + (count ? ` · ${count} 次上下文整理` : '') + ' · 查看详情');
        item.element.dataset.status = failed ? 'failed' : running ? 'running' : 'completed';
        changed = update(item.content, '', { ...options, parts: part.entries, streaming: false, maintenanceNested: true }) || changed;
      } else if (part.type === 'tool') changed = updateTool(item, part, options) || changed;
      else if (part.type === 'thinking') changed = updateThinking(item, part, options) || changed;
      else if (part.type === 'summary') changed = updateSummary(item, part, options) || changed;
      else changed = markdown(item.element, typeof part.text === 'string' ? part.text : '', { ...options, streaming: options.streaming === true && part.status === 'streaming' }) || changed;
    }
    for (const id of remaining) { const item = view.parts.get(id); active.delete(item); item.element.remove(); view.parts.delete(id); changed = true; }
    for (const id of remainingGroups) { view.groups.get(id).remove(); view.groups.delete(id); changed = true; }
    return changed;
  }
  window.UBOVMMessage = Object.freeze({ update });
})();
