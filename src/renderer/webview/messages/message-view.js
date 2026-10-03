(() => {
  'use strict';
  const views = new WeakMap(), active = new Set();
  let clock, suspended = false;
  function syncClock() {
    const paused = suspended || document.hidden || document.getElementById('settings-dialog')?.open;
    if (paused || !active.size) { clearInterval(clock); clock = undefined; }
    else if (!clock) clock = setInterval(tick, 1000);
  }
  const resume = () => { suspended = false; tick(); syncClock(); };
  window.addEventListener('pagehide', () => { suspended = true; syncClock(); });
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => { tick(); syncClock(); });
  window.addEventListener('ubovm-settings-visibility', () => { tick(); syncClock(); });
  const labels = { running: '运行中', completed: '完成', failed: '失败', interrupted: '已停止' };
  const executionLabels = { queued: '排队中', starting: '准备中', running: '运行中', stopping: '正在停止' };
  const tools = { delivery_workflow: '交付闭环', search_workspace: '搜索项目代码', inventory_workspace_dependencies: '盘点工作区依赖', scan_workspace_secrets: '扫描疑似密钥', analyze_workspace_call_chain: '分析代码调用链', navigate_workspace_code: '代码符号导航', get_workspace_diagnostics: '读取代码诊断', validate_workspace_changes: '验证代码修改', recover_workspace_changes: '恢复代码修改状态', read_workspace_code: '读取待编辑代码', edit_workspace_file: '编辑代码', list_workspace_changes: '查看代码更改', wait_workers: '等待协作结果', spawn_worker: '启动协作任务', read_worker_evidence: '查看协作记录', read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令', run_python: '运行 Python 沙箱', manage_python_environment: '管理 Python 依赖', run_linux_ssh_command: '运行命令', upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', fetch_web_content: '读取网页', web_search: '搜索网页', load_skill: '加载技能', read_skills_resource: '读取技能资源', run_local_skill_script: '执行技能脚本', note: '更新笔记', todo: '更新任务', browser_action: '浏览器操作', read_context_evidence: '读取上下文证据' };
  const kinds = { delivery_workflow: 'memory', search_workspace: 'search', inventory_workspace_dependencies: 'search', scan_workspace_secrets: 'search', analyze_workspace_call_chain: 'search', navigate_workspace_code: 'search', get_workspace_diagnostics: 'search', validate_workspace_changes: 'tool', recover_workspace_changes: 'file', read_workspace_code: 'file', edit_workspace_file: 'file', list_workspace_changes: 'folder', read_workspace_file: 'file', list_workspace_files: 'folder', run_local_shell_command: 'terminal', run_python: 'terminal', manage_python_environment: 'terminal', run_linux_ssh_command: 'terminal', upload_sftp: 'file', deploy_remote_service: 'terminal', fetch_web_content: 'browser', web_search: 'search', load_skill: 'skill', read_skills_resource: 'skill', run_local_skill_script: 'terminal', note: 'memory', todo: 'memory', browser_action: 'browser', read_context_evidence: 'search' };
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
    if (!['running', 'streaming'].includes(view.part.status) && (!Number.isFinite(end) || end < start)) { setText(view.time, ''); return; }
    const seconds = Math.max(0, ((Number.isFinite(end) && end >= start ? end : Date.now()) - start) / 1000);
    setText(view.time, seconds < 60 ? (seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + 's' : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's');
  }
  function tick() {
    // A callback already queued before suspension can still arrive after the
    // interval is cleared. Do not touch hidden DOM in that case.
    if (suspended || document.hidden || document.getElementById('settings-dialog')?.open) return;
    for (const view of active) {
      if (!view.element.isConnected || !['running', 'streaming'].includes(view.part.status)) active.delete(view);
      else if (!view.element.closest('[hidden]') && !view.element.parentElement?.closest('details:not([open])')) {
        try { duration(view); }
        catch { active.delete(view); window.UBOVMRuntime?.fail('部分执行状态显示失败，请同步最新状态。'); }
      }
    }
    if (!active.size) { clearInterval(clock); clock = undefined; }
  }
  function trackDuration(view) {
    duration(view);
    if (['running', 'streaming'].includes(view.part.status)) active.add(view);
    else active.delete(view);
    syncClock();
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
    const output = view.output, previous = view.renderedOutput ?? '';
    if (previous === value) return;
    const visible = view.element.open && view.element.isConnected && !document.hidden && !view.element.closest('[hidden]');
    const top = visible ? output.scrollTop : 0;
    const follow = visible && output.scrollHeight - output.clientHeight - top <= 3;
    if (output.firstChild?.nodeType === Node.TEXT_NODE && value.startsWith(previous)) output.firstChild.appendData(value.slice(previous.length));
    else output.textContent = value;
    view.renderedOutput = value;
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
    const stop = node('button', 'tool-action tool-stop', '中断命令'); stop.type = 'button'; stop.hidden = true;
    stop.title = '中断此命令并保留输出，Agent 可继续处理结果';
    const chevron = node('span', 'tool-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    const live = node('span', 'tool-live-preview'); live.hidden = true;
    live.setAttribute('aria-hidden', 'true');
    const aside = node('button', 'tool-action tool-aside', '放在一边'); aside.type = 'button'; aside.hidden = true;
    summary.append(icon, main, details, aside, stop, chevron, live);
    const body = node('div', 'tool-card-body'), meta = node('div', 'tool-detail-name');
    const input = node('pre', 'tool-parameters'), output = node('pre', 'tool-output');
    output.tabIndex = input.tabIndex = 0; output.setAttribute('aria-label', '工具输出'); input.setAttribute('aria-label', '工具参数');
    const actions = node('div', 'tool-result-toolbar'), info = node('span', 'tool-result-info');
    const copy = node('button', 'tool-action', '复制输出'), preview = node('button', 'tool-action', '预览 HTML'), open = node('button', 'tool-action', '打开文件');
    copy.type = preview.type = open.type = 'button';
    const latest = node('button', 'tool-action', '回到最新'); latest.type = 'button'; latest.hidden = true;
    latest.title = '滚动到日志底部，继续跟随新输出';
    actions.append(node('span', 'tool-result-label', '输出'), info, open, preview, latest, copy);
    const args = node('details', 'tool-arguments'); args.append(node('summary', '', '参数'), meta, input);
    const notice = node('p', 'tool-truncation', '显示内容已截断。');
    body.append(output, actions, args, notice);
    element.append(summary, body);
    const view = { element, icon, iconPath, title, path, status, time, meta, input, output, info, copy, preview, open, stop, aside, notice, live, latest, part: {}, options: {} };
    latest.addEventListener('click', () => {
      if (view.released || !element.isConnected || !element.open) return;
      output.scrollTop = output.scrollHeight;
    });
    aside.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (view.released || aside.disabled || view.part.status !== 'running' || !view.part.commandId) return;
      aside.disabled = true;
      try { if (await view.options.onBackgroundCommand?.(view.part.commandId) === false) throw new Error('Command finished'); }
      catch { if (!view.released) { aside.disabled = false; aside.textContent = '重试放在一边'; } }
    });
    stop.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (view.released || stop.disabled || view.part.status !== 'running' || !view.part.commandId || !view.options.onInterruptCommand) return;
      const commandId = view.part.commandId;
      view.stopPending = commandId; stop.disabled = true; stop.textContent = '正在中断…';
      try { await view.options.onInterruptCommand(commandId); }
      catch {
        if (!view.released && view.part.commandId === commandId && view.part.status === 'running') {
          view.stopPending = undefined; stop.disabled = false; stop.textContent = '重试中断';
          stop.title = '中断请求未确认，请重试或使用停止执行';
        }
      }
    });
    element.addEventListener('toggle', () => {
      if (view.released) return;
      try { if (element.open) renderToolBody(view); else renderLivePreview(view); }
      catch {
        // A failed deferred render can be retried with the same state snapshot.
        view.dirty = true;
        if (element.open) {
          output.textContent = view.part.output || '';
          view.renderedOutput = output.textContent;
        }
      }
    });
    copy.addEventListener('click', async () => {
      if (view.released || !view.options.onCopy || copy.disabled) return;
      clearTimeout(view.copyReset);
      copy.disabled = true;
      try { if (await view.options.onCopy(view.part.output || '') === false) throw new Error('Copy failed'); if (!view.released) copy.textContent = '已复制'; }
      catch { if (!view.released) copy.textContent = '复制失败'; }
      finally { if (!view.released) { copy.disabled = false; view.copyReset = setTimeout(() => { copy.textContent = '复制输出'; }, 1400); } }
    });
    preview.addEventListener('click', () => { if (!view.released) view.options.onPreviewHtml?.(view.part.output || '', preview); });
    open.addEventListener('click', async () => {
      if (view.released || open.disabled || !view.target || !view.options.onOpenLink) return;
      clearTimeout(view.openReset); open.textContent = '打开文件';
      open.disabled = true;
      try { if (await view.options.onOpenLink(view.target.href, { rootIndex: view.target.rootIndex }) === false) throw new Error('File open failed'); }
      catch { if (!view.released) { open.textContent = '打开失败'; view.openReset = setTimeout(() => { open.textContent = '打开文件'; }, 1400); } }
      finally { if (!view.released) open.disabled = false; }
    });
    return view;
  }
  function updateTool(view, part, options) {
    view.options = options;
    const asideHidden = part.status !== 'running' || !part.commandId || part.background === true || !options.onBackgroundCommand;
    if (view.aside.hidden !== asideHidden) view.aside.hidden = asideHidden;
    const stopHidden = part.status !== 'running' || !part.commandId || !options.onInterruptCommand;
    const stopDisabled = part.interruptRequested === true || view.stopPending === part.commandId;
    if (view.stop.hidden !== stopHidden) view.stop.hidden = stopHidden;
    if (view.stop.disabled !== stopDisabled) view.stop.disabled = stopDisabled;
    if (part.interruptRequested || view.stopPending === part.commandId && part.commandId) setText(view.stop, '正在中断…');
    else if (view.part.commandId !== part.commandId) { view.stopPending = undefined; setText(view.stop, '中断命令'); }
    if (view.element.isConnected && !active.has(view) && ['running', 'streaming'].includes(view.part.status)) trackDuration(view);
    // Outputs can be large. Compare the rendered fields without copying and
    // serializing every completed tool on each incoming text token.
    const keys = ['id', 'name', 'status', 'args', 'output', 'startedAt', 'endedAt', 'truncated', 'outputTail', 'commandId', 'interruptRequested', 'executionState', 'background'];
    if (!view.dirty && keys.every(key => part[key] === view.part[key])) return renderToolBody(view);
    const argumentsChanged = view.dirty || part.name !== view.part.name || part.args !== view.part.args;
    const streaming = ['run_linux_ssh_command', 'run_local_skill_script', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service'].includes(part.name);
    view.dirty = true;
    view.part = { ...part };
    view.streaming = streaming;
    view.bodyDirty = true;
    const status = labels[part.status] ? part.status : 'completed';
    if (view.element.dataset.status !== status) view.element.dataset.status = status;
    const executionState = status === 'running' && executionLabels[part.executionState] ? part.executionState : '';
    if (view.element.dataset.executionState !== executionState) view.element.dataset.executionState = executionState;
    const receiving = String(streaming && status === 'running' && !['queued', 'starting', 'stopping'].includes(executionState));
    if (view.element.dataset.streaming !== receiving) view.element.dataset.streaming = receiving;
    setText(view.title, tools[part.name] || (part.name?.startsWith('mcp_') ? 'MCP 工具' : part.name || '工具调用'));
    if (argumentsChanged) {
      const input = parameters(part), kind = kinds[part.name] || (part.name?.startsWith('mcp_') ? 'mcp' : 'tool');
      view.icon.dataset.kind = kind; view.iconPath.setAttribute('d', icons[kind]);
      setText(view.path, hint(part, input)); view.path.title = view.path.textContent;
      view.title.title = tools[part.name] || part.name || '工具调用';
      view.target = fileTarget(part, input);
    }
    setText(view.status, status === 'running' && part.background ? '后台运行' : executionLabels[executionState] || labels[status]);
    renderLivePreview(view);
    renderToolBody(view);
    trackDuration(view);
    view.dirty = false;
    return true;
  }
  function renderLivePreview(view) {
    // Expanded cards already show the full log. Defer the hidden summary tail
    // until folding, and reuse it for status/timing updates with equal output.
    if (view.released || view.element.open) return;
    const part = view.part, streaming = view.streaming;
    const status = labels[part.status] ? part.status : 'completed';
    if (view.liveOutput === part.output && view.liveStatus === status && view.liveStreaming === streaming) return;
    // A bounded tail provides live feedback without materializing the folded
    // log. Never scan an entire command output for each incoming chunk.
    const showLive = streaming && ['running', 'failed'].includes(status) && Boolean(part.output);
    if (showLive) {
      const tail = part.output.slice(-1200).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
      const lines = tail.trimEnd().split('\n').slice(-2).join('\n').slice(-400);
      setText(view.live, lines);
    }
    if (view.live.hidden === showLive) view.live.hidden = !showLive;
    if (!showLive && view.live.textContent) view.live.textContent = '';
    view.liveOutput = part.output; view.liveStatus = status; view.liveStreaming = streaming;
  }
  function renderToolBody(view) {
    // Keep only the latest snapshot while folded; no hidden log DOM or scans.
    if (view.released || !view.bodyDirty || !view.element.open) return false;
    const part = view.part, streaming = view.streaming;
    const status = labels[part.status] ? part.status : 'completed';
    setText(view.meta, part.name || '工具');
    const args = part.args || '{}';
    // Large command payloads stay constant while logs grow. Cache only after
    // the write succeeds so a failed DOM update remains retryable.
    if (view.renderedArgs !== args) {
      setText(view.input, args);
      view.renderedArgs = args;
    }
    const waiting = { queued: '正在等待同一会话的前一条命令结束，可单独中断此排队命令。', starting: '正在准备命令执行…', stopping: '正在停止命令并清理进程…' };
    setOutput(view, part.output || (status === 'running' ? waiting[part.executionState] || (streaming ? '正在执行，等待输出…' : '等待工具返回…') : status === 'interrupted' ? '调用已停止，执行状态请以已有记录为准。' : '无文本输出。'));
    const output = part.output || '', previousOutput = view.lineOutput || '';
    const appended = output.startsWith(previousOutput);
    const tail = appended ? output.slice(previousOutput.length) : output;
    let newlines = appended ? view.newlines || 0 : 0;
    // Count without allocating one array entry per line in large shell logs.
    for (let index = tail.indexOf('\n'); index !== -1; index = tail.indexOf('\n', index + 1)) newlines++;
    view.newlines = newlines;
    view.lineOutput = output;
    const lines = output ? view.newlines + (output.endsWith('\n') ? 0 : 1) : 0;
    setText(view.info, (status === 'running' ? executionLabels[part.executionState] || '接收中' : '') + (lines ? (status === 'running' ? ' · ' : '') + lines + ' 行' : ''));
    const previewHidden = !part.output || !htmlSource(part.output);
    if (view.open.hidden !== !view.target) view.open.hidden = !view.target;
    if (view.copy.hidden !== !part.output) view.copy.hidden = !part.output;
    if (view.latest.hidden !== !part.output) view.latest.hidden = !part.output;
    if (view.preview.hidden !== previewHidden) view.preview.hidden = previewHidden;
    if (view.notice.hidden !== !part.truncated) view.notice.hidden = !part.truncated;
    setText(view.notice, part.outputTail ? '仅显示最新输出，较早内容已截断。' : '显示内容已截断。');
    view.bodyDirty = false;
    return true;
  }
  function renderThinking(view) {
    // Defer parsing while manually collapsed and retain Markdown nodes while streaming.
    if (view.released || !view.element.open) return false;
    const body = view.body;
    const visible = view.element.isConnected && !document.hidden && !document.getElementById('settings-dialog')?.open && !view.element.closest('[hidden]');
    const top = visible ? body.scrollTop : 0;
    const follow = view.rendered && visible && body.scrollHeight - body.clientHeight - top <= 3;
    const changed = markdown(view.content, view.displayText ?? view.part.text ?? '', { ...view.options, streaming: view.part.type !== 'summary' && ['running', 'streaming'].includes(view.part.status) });
    if (view.content.classList.contains('render-plain-fallback')) view.content.classList.remove('render-plain-fallback');
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
    element.addEventListener('toggle', () => {
      if (view.released || !element.open) return;
      try { renderThinking(view); }
      catch {
        view.dirty = true;
        content.textContent = view.displayText ?? view.part.text ?? '';
        content.classList.add('render-plain-fallback');
      }
    });
    return view;
  }
  function updateThinking(view, part, options) {
    const actionsChanged = ['onCopy', 'onOpenLink', 'onPreviewHtml'].some(key => view.options[key] !== options[key]);
    view.options = options;
    if (view.element.isConnected && !active.has(view) && ['running', 'streaming'].includes(view.part.status)) trackDuration(view);
    const keys = ['id', 'text', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated'];
    if (!view.dirty && !actionsChanged && keys.every(key => part[key] === view.part[key])) return false;
    view.dirty = true;
    view.part = { ...part };
    const status = part.status === 'streaming' ? 'running' : ['running', 'interrupted'].includes(part.status) ? part.status : 'completed';
    const source = ['reason', 'worker'].includes(part.source) ? part.source : 'assistant';
    if (view.element.dataset.status !== status) view.element.dataset.status = status;
    if (view.element.dataset.source !== source) view.element.dataset.source = source;
    setText(view.title, status === 'running' ? '思考中' : status === 'interrupted' ? '思考已停止' : '已思考');
    setText(view.source, source === 'reason' ? 'Reason' : source === 'worker' ? 'Worker' : '');
    const title = source === 'worker' && part.workerId ? 'Worker · ' + part.workerId : view.source.textContent;
    if (view.source.title !== title) view.source.title = title;
    if (view.notice.hidden !== !part.truncated) view.notice.hidden = !part.truncated;
    trackDuration(view);
    renderThinking(view);
    view.dirty = false;
    return true;
  }
  function updateSummary(view, part, options) {
    const actionsChanged = ['onCopy', 'onOpenLink', 'onPreviewHtml'].some(key => view.options[key] !== options[key]);
    view.options = options;
    if (view.element.isConnected && !active.has(view) && ['running', 'streaming'].includes(view.part.status)) trackDuration(view);
    const keys = ['id', 'text', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated', 'fallback', 'beforeTokens', 'afterTokens'];
    if (!view.dirty && !actionsChanged && keys.every(key => part[key] === view.part[key])) return false;
    view.dirty = true;
    view.part = { ...part };
    const status = ['running', 'failed', 'interrupted'].includes(part.status) ? part.status : 'completed';
    if (view.element.dataset.status !== status) view.element.dataset.status = status;
    setText(view.title, { running: '正在整理上下文', completed: '上下文摘要', failed: '摘要未完成', interrupted: '摘要已停止' }[status]);
    setText(view.source, part.source === 'reason' ? 'Reason' : part.source === 'worker' ? 'Worker' : '');
    const title = part.workerId || view.source.textContent;
    if (view.source.title !== title) view.source.title = title;
    view.displayText = part.text || { running: '正在整理较早的对话与工具记录，完成后会在此显示摘要。', completed: '本次上下文整理已完成。', failed: '上下文整理未完成，请查看本轮执行错误。', interrupted: '上下文整理已停止。' }[status];
    if (part.fallback) view.displayText = '本次使用原文摘录，未生成完整摘要。\n\n' + view.displayText;
    const hasMetrics = [part.beforeTokens, part.afterTokens].every(value => Number.isSafeInteger(value) && value >= 0);
    if (view.metrics.hidden !== !hasMetrics) view.metrics.hidden = !hasMetrics;
    setText(view.metrics, hasMetrics ? `上下文用量估算：${part.beforeTokens.toLocaleString('en-US')} → ${part.afterTokens.toLocaleString('en-US')} tokens` : '');
    if (view.notice.hidden !== !part.truncated) view.notice.hidden = !part.truncated;
    setText(view.notice, '摘要较长，此处仅显示已保留的部分。');
    trackDuration(view); renderThinking(view);
    view.dirty = false;
    return true;
  }
  function markdown(element, text, options) {
    if (window.UBOVMMarkdown) return window.UBOVMMarkdown.update(element, text, options);
    if (element.textContent === text) return false;
    element.textContent = text; return true;
  }
  function renderMaintenance(item) {
    if (item.released || !item.element.open || !item.pending) return false;
    const snapshot = item.pending;
    const changed = update(item.content, '', { ...snapshot.options, parts: snapshot.entries, streaming: false, maintenanceNested: true });
    setText(item.title, item.label);
    // Retain failed snapshots so reopening retries an interrupted render.
    if (item.pending === snapshot) item.pending = undefined;
    return changed;
  }
  function update(element, text, options = {}) {
    let parts = Array.isArray(options.parts) ? options.parts.filter(part => part && typeof part.id === 'string' && ['text', 'tool', 'thinking', 'summary'].includes(part.type)) : [];
    // Older snapshots can retain auxiliary cards but omit the answer's text
    // part. Keep their saved body visible without repeating modern timelines
    // or introducing a synthetic answer while the model is still streaming.
    if (options.streaming !== true && parts.length && typeof text === 'string' && text.trim()) {
      const texts = parts.filter(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim()).map(part => part.text);
      // The stored message body is authoritative for published replies. A
      // partial timeline may contain an introduction but omit its final answer.
      // Ignore display-limit notices when checking an already retained body.
      const body = text.replace(/\n(?:\n\[回复超出显示上限；完整输出保存在本地执行记录中。\]|\[内容已截断\])$/, '').trim();
      const represented = options.preserveBody !== true || texts.some(value => value.includes(body))
        || ['', '\n', '\n\n'].some(separator => texts.join(separator).includes(body));
      if (!texts.length || options.preserveBody === true && !represented) {
        const last = parts.at(-1);
        if (last?.type === 'text' && typeof last.text === 'string' && last.text.trim() && text.startsWith(last.text)) {
          parts = [...parts.slice(0, -1), { ...last, text, status: 'completed' }];
        } else {
          let id = 'history-answer';
          while (parts.some(part => part.id === id)) id += ':';
          parts = [...parts, { id, type: 'text', text, status: 'completed' }];
        }
      }
    }
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
      release(element);
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
    const toolBatches = new Map();
    const remaining = new Set(view.parts.keys());
    const remainingGroups = new Set(view.groups.keys());
    for (const part of parts) {
      remaining.delete(part.id);
      let item = view.parts.get(part.id);
      if (!item || item.type !== part.type) {
        if (item) { releaseItem(item); item.element.remove(); }
        if (part.type === 'maintenance') {
          const details = node('details', 'maintenance-group'), title = node('summary', 'maintenance-toggle'), content = node('div', 'maintenance-content');
          details.append(title, content); item = { element: details, title, content };
          const maintenance = item;
          details.addEventListener('toggle', () => {
            if (maintenance.released || !details.open) return;
            try { renderMaintenance(maintenance); tick(); }
            catch { setText(maintenance.title, '后台步骤显示失败，收起后展开重试'); }
          });
        } else item = part.type === 'tool' ? createTool() : ['thinking', 'summary'].includes(part.type) ? createThinking(part.type) : { element: node('div', 'response-text') };
        item.type = part.type; view.parts.set(part.id, item); changed = true;
      }
      if (part.type === 'tool') {
        if (!group) {
          group = view.groups.get(part.id);
          if (!group) {
            group = node('div', 'tool-group');
            const toggle = node('button', 'tool-group-toggle'); toggle.type = 'button'; toggle.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            group.append(toggle);
            const batch = group;
            toggle.addEventListener('click', () => {
              batch.dataset.expanded = String(batch.dataset.expanded !== 'true');
              refreshToolBatch(batch, batch.toolItems || []);
            });
            view.groups.set(part.id, group);
          }
          remainingGroups.delete(part.id);
          const next = previous ? previous.nextSibling : element.firstChild;
          if (group !== next) { element.insertBefore(group, next); changed = true; }
          previous = group; previousTool = null;
        }
        if (!toolBatches.has(group)) toolBatches.set(group, []);
        toolBatches.get(group).push(item);
        const next = previousTool ? previousTool.nextSibling : group.firstChild.nextSibling;
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
        item.label = label + (count ? ` · ${count} 次上下文整理` : '') + ' · 查看详情';
        setText(item.title, item.label);
        const status = failed ? 'failed' : running ? 'running' : 'completed';
        if (item.element.dataset.status !== status) item.element.dataset.status = status;
        // Folded groups keep the latest data without walking their nested
        // timelines or creating hidden Markdown and tool-card DOM per token.
        item.pending = { entries: part.entries, options };
        changed = renderMaintenance(item) || changed;
      } else if (part.type === 'tool') changed = updateTool(item, part, options) || changed;
      else if (part.type === 'thinking') changed = updateThinking(item, part, options) || changed;
      else if (part.type === 'summary') changed = updateSummary(item, part, options) || changed;
      else changed = markdown(item.element, typeof part.text === 'string' ? part.text : '', { ...options, streaming: options.streaming === true && part.status === 'streaming' }) || changed;
    }
    for (const id of remaining) { const item = view.parts.get(id); releaseItem(item); item.element.remove(); view.parts.delete(id); changed = true; }
    for (const id of remainingGroups) { view.groups.get(id).remove(); view.groups.delete(id); changed = true; }
    for (const [batch, items] of toolBatches) refreshToolBatch(batch, items);
    return changed;
  }
  function refreshToolBatch(batch, items) {
    batch.toolItems = items;
    const compact = items.length >= 4, expanded = batch.dataset.expanded === 'true';
    if (batch.dataset.compact !== String(compact)) batch.dataset.compact = String(compact);
    const toggle = batch.firstChild;
    if (toggle.hidden !== !compact) toggle.hidden = !compact;
    let hidden = 0, running = 0, failed = 0;
    items.forEach((item, index) => {
      const status = item.part.status;
      if (['running', 'streaming'].includes(status)) running++;
      if (status === 'failed') failed++;
      // Preserve open logs and actionable results, even when new calls arrive.
      const fold = compact && !expanded && index < items.length - 3 && status === 'completed' && !item.element.open;
      if (item.element.hidden !== fold) item.element.hidden = fold;
      if (fold) hidden++;
    });
    setText(toggle, `${items.length} 个工具调用${running ? ` · ${running} 个运行中` : ''}${failed ? ` · ${failed} 个失败` : ''} · ${expanded ? '收起历史' : hidden ? `展开 ${hidden} 条历史` : '查看全部'}`);
    if (toggle.getAttribute('aria-expanded') !== String(expanded)) toggle.setAttribute('aria-expanded', String(expanded));
    if (batch.dataset.failures !== String(failed > 0)) batch.dataset.failures = String(failed > 0);
  }
  function releaseItem(item) {
    item.released = true;
    item.pending = undefined;
    active.delete(item); clearTimeout(item.copyReset); clearTimeout(item.openReset);
    let failure;
    try { window.UBOVMMarkdown?.release?.(item.element); } catch (error) { failure = error; }
    try { if (item.content) release(item.content); } catch (error) { failure ??= error; }
    if (!active.size) { clearInterval(clock); clock = undefined; }
    if (failure) throw failure;
  }
  function release(element) {
    const view = views.get(element);
    // Retire ownership before dependency callbacks; a single cleanup fault
    // cannot keep later cards, action handlers and duration timers alive.
    views.delete(element);
    let failure;
    try { window.UBOVMMarkdown?.release?.(element); } catch (error) { failure = error; }
    try { if (view?.content) window.UBOVMMarkdown?.release?.(view.content); } catch (error) { failure ??= error; }
    if (view?.parts) {
      const items = [...view.parts.values()]; view.parts.clear();
      for (const item of items) { try { releaseItem(item); } catch (error) { failure ??= error; } }
    }
    if (!active.size) { clearInterval(clock); clock = undefined; }
    if (failure) throw failure;
  }
  window.UBOVMMessage = Object.freeze({ update, release });
})();
