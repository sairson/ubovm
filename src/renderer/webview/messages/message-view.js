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
  const executionLabels = { queued: '排队中', starting: '准备中', preflight: '检查沙箱', preparing: '准备环境', running: '运行中', cleanup: '清理沙箱', stopping: '正在停止' };
  const tools = { search_workspace: '搜索项目代码', inventory_workspace_dependencies: '盘点工作区依赖', scan_workspace_secrets: '扫描疑似密钥', analyze_workspace_call_chain: '分析代码调用链', navigate_workspace_code: '代码符号导航', get_workspace_diagnostics: '读取代码诊断', validate_workspace_changes: '验证代码修改', recover_workspace_changes: '恢复代码修改状态', read_workspace_code: '读取待编辑代码', edit_workspace_file: '编辑代码', list_workspace_changes: '查看代码更改', wait_workers: '等待并行任务', spawn_worker: '分派并行任务', manage_workers: '调度并行任务', cancel_workers: '中断并行任务', list_workers: '检查协作进展', read_worker_evidence: '查看任务记录', read_workspace_file: '读取文件', read_image: '读取图片', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令', run_python: '运行 Python 沙箱', manage_python_environment: '管理 Python 依赖', run_linux_ssh_command: '运行命令', upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', fetch_web_content: '读取网页', web_search: '搜索网页', load_skill: '加载技能', read_skills_resource: '读取技能资源', run_local_skill_script: '执行技能脚本', note: '更新笔记', todo: '更新任务', browser_action: '浏览器操作', read_context_evidence: '读取上下文证据', install_skill: '安装技能', install_mcp_server: '安装 MCP 服务', browser_connection_status: '检查浏览器状态', domain_inventory: '登记域名资产', learn_capability: '记录能力', inspect_harness: '查看运行预算', manage_harness_project: '管理任务配置', read_worker_result: '读取任务结果', read_workspace_change: '读取代码改动快照', preview_workspace_edits: '预览代码修改', preview_workspace_rename: '预览符号重命名', edit_workspace_files: '批量编辑代码', inspect_workspace_project: '检查项目配置', list_assist_evidence: '查看已记录证据', record_assist_evidence: '记录证据', attach_assist_evidence: '关联证据', list_linked_goals: '查看关联目标', create_linked_goal: '创建关联目标', ask_human: '询问用户', spawn_teammate: '创建团队成员', send_message: '向团队发消息', list_agents: '查看团队成员', wait_agent: '等待团队进展', interrupt_agent: '中断团队成员', team_task_create: '创建任务', team_task_list: '查看任务板', team_task_get: '读取任务', team_task_update: '更新任务', background_commands: '后台任务', stop_worker: '停止 Worker', start_worker: '启动 Worker', prompt_worker: '派发 Worker 提示' };
  const kinds = { search_workspace: 'search', inventory_workspace_dependencies: 'search', scan_workspace_secrets: 'search', analyze_workspace_call_chain: 'search', navigate_workspace_code: 'search', get_workspace_diagnostics: 'search', validate_workspace_changes: 'tool', recover_workspace_changes: 'file', read_workspace_code: 'file', edit_workspace_file: 'file', list_workspace_changes: 'folder', read_workspace_file: 'file', read_image: 'file', list_workspace_files: 'folder', run_local_shell_command: 'terminal', run_python: 'terminal', manage_python_environment: 'terminal', run_linux_ssh_command: 'terminal', upload_sftp: 'file', deploy_remote_service: 'terminal', fetch_web_content: 'browser', web_search: 'search', load_skill: 'skill', read_skills_resource: 'skill', run_local_skill_script: 'terminal', note: 'memory', todo: 'memory', browser_action: 'browser', read_context_evidence: 'search', install_skill: 'skill', install_mcp_server: 'mcp', browser_connection_status: 'browser', domain_inventory: 'memory', learn_capability: 'memory', inspect_harness: 'tool', manage_harness_project: 'tool', read_worker_result: 'tool', read_workspace_change: 'file', preview_workspace_edits: 'file', preview_workspace_rename: 'search', edit_workspace_files: 'file', inspect_workspace_project: 'search', list_assist_evidence: 'memory', record_assist_evidence: 'memory', attach_assist_evidence: 'memory', list_linked_goals: 'memory', create_linked_goal: 'memory', ask_human: 'memory', spawn_teammate: 'team', send_message: 'team', list_agents: 'team', wait_agent: 'team', interrupt_agent: 'team', team_task_create: 'team', team_task_list: 'team', team_task_get: 'team', team_task_update: 'team', background_commands: 'terminal', stop_worker: 'team', start_worker: 'team', prompt_worker: 'team' };
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
    team: 'M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M3 20v-1.5a5.5 5.5 0 0 1 11 0V20M16 4.5a3 3 0 0 1 0 5.5M21 20v-1.5a5 5 0 0 0-3-4.5',
  };
  const tr = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const isFlatToolCard = name => window.UBOVMTimeline?.isFlatToolCard?.(name) === true;
  const toolDiff = part => window.UBOVMTimeline?.toolDiff?.(part) ?? null;
  const diffSummary = diff => window.UBOVMTimeline?.diffSummary?.(diff) ?? '';
  function setDiffStat(element, diff) {
    element.hidden = !diff;
    if (!diff) { if (element.textContent) element.replaceChildren(); return; }
    const signature = `${diff.added}\0${diff.removed}`;
    if (element.dataset.signature === signature) return;
    element.dataset.signature = signature;
    element.replaceChildren();
    if (diff.added) { const value = node('span', 'tool-diff-added', `+${diff.added}`); element.append(value); }
    if (diff.removed) { const value = node('span', 'tool-diff-removed', `−${diff.removed}`); element.append(value); }
    if (!diff.added && !diff.removed) element.textContent = '内容变更';
  }
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = tr(text); return value; };
  const setText = (element, value) => { const text = tr(value); if (element.textContent !== text) element.textContent = text; };
  const setRaw = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  // Tool results may inline one image. The host rebuilds the projected payload
  // for every snapshot, so compare its fields rather than object identity; a
  // changed image must re-render, an identical one must not. A missing payload
  // and an explicit null are the same absence.
  const sameToolImage = (left, right) => {
    if (left === right) return true;
    const a = left && typeof left === 'object' ? left : null;
    const b = right && typeof right === 'object' ? right : null;
    if (!a || !b) return !a && !b;
    return a.mimeType === b.mimeType && a.data === b.data
      && a.width === b.width && a.height === b.height && a.bytes === b.bytes;
  };
  const hasInlineToolImage = image => Boolean(image && typeof image === 'object' && !Array.isArray(image)
    && typeof image.mimeType === 'string' && image.mimeType
    && typeof image.data === 'string' && image.data);
  const imageFormatLabel = mimeType => {
    const match = /^image\/([a-z0-9.+-]+)$/i.exec(String(mimeType ?? ''));
    if (!match) return '';
    const subtype = match[1].toLowerCase();
    return ({ jpeg: 'JPEG', jpg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', bmp: 'BMP', 'svg+xml': 'SVG' })[subtype] || subtype.toUpperCase();
  };
  const imageSizeLabel = bytes => {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  };
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
  function parseSearchOutput(value) {
    if (typeof value !== 'string' || !value || value.length > 512 * 1024) return null;
    try {
      const data = JSON.parse(value);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.mode === 'help') return null;
      if (typeof data.query !== 'string' || !Array.isArray(data.results)) return null;
      if (!['ok', 'no_results', 'unavailable'].includes(data.status)) return null;
      const results = [];
      for (const item of data.results.slice(0, 20)) {
        if (!item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.url !== 'string') continue;
        let url = item.url.trim();
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
          url = parsed.href;
        } catch { continue; }
        results.push({
          title: item.title.trim().slice(0, 300) || url,
          url,
          snippet: typeof item.snippet === 'string' ? item.snippet.trim().slice(0, 800) : '',
        });
      }
      return {
        query: data.query.trim().slice(0, 512),
        status: data.status,
        provider: typeof data.provider === 'string' ? data.provider.slice(0, 80) : '',
        returned: Number.isSafeInteger(data.returned) ? data.returned : results.length,
        results,
        answer: typeof data.answer === 'string' ? data.answer.trim().slice(0, 4000) : '',
        message: typeof data.message === 'string' ? data.message.trim().slice(0, 500) : '',
        fallback: data.fallback_used === true,
        ranking: typeof data.ranking === 'string' ? data.ranking.slice(0, 32) : '',
      };
    } catch { return null; }
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  function searchSummary(search) {
    if (!search) return '';
    if (search.status === 'unavailable') return '搜索服务不可用';
    if (search.status === 'no_results' || !search.results.length) return '无可用结果';
    return `${search.returned || search.results.length} 条结果`;
  }
  const shortId = value => { const text = String(value ?? '').trim(); return text.length > 12 ? text.slice(0, 12) + '…' : text; };
  const TEAM_TOOL_NAMES = new Set(['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
    'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']);
  const isTeamTool = name => TEAM_TOOL_NAMES.has(name);
  // Team results are compact JSON snapshots. Parse only a bounded payload so the
  // collapsed summary never echoes prompt/message bodies or whole task boards.
  function teamOutput(part) {
    const output = part.output;
    if (typeof output !== 'string' || !output || output.length > 8192) return undefined;
    try { return JSON.parse(output); } catch { return undefined; }
  }
  function teamHint(part, input) {
    const name = part.name;
    const output = teamOutput(part);
    const compact = (value, limit) => String(value ?? '').trim().slice(0, limit);
    const target = typeof input.target === 'string' ? input.target : typeof input.name === 'string' ? input.name : '';
    const taskId = typeof input.task_id === 'string' ? input.task_id : typeof input.taskId === 'string' ? input.taskId : '';
    if (name === 'spawn_teammate' || name === 'send_message' || name === 'interrupt_agent') {
      return compact(target || (name === 'spawn_teammate' ? output?.member?.target || output?.member?.name : ''), 64);
    }
    if (name === 'team_task_create' || name === 'team_task_update' || name === 'team_task_get') {
      const task = output && typeof output === 'object' && !Array.isArray(output) ? output : undefined;
      return compact(taskId || task?.id || input.subject || task?.subject || '', 120);
    }
    if (name === 'team_task_list') {
      const tasks = Array.isArray(output?.tasks) ? output.tasks : undefined;
      if (!tasks) return '';
      const ids = tasks.slice(0, 3).map(task => task?.id).filter(Boolean).join(', ');
      return tasks.length > 3 ? ids + '…' : ids;
    }
    if (name === 'list_agents') {
      const members = Array.isArray(output) ? output : Array.isArray(output?.members) ? output.members : undefined;
      if (!members) return '';
      const names = members.slice(0, 4).map(member => member?.target || member?.name).filter(Boolean).join(', ');
      return members.length > 4 ? names + '…' : names;
    }
    if (name === 'wait_agent') {
      if (!output || typeof output !== 'object') return '';
      if (output.noProgress) return '没有可等待的成员';
      return output.timedOut ? '等待超时' : '有新的进展';
    }
    return '';
  }
  function lineRange(input) {
    const start = Number(input.startLine ?? input.start), end = Number(input.endLine ?? input.end);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 1 && end >= start) return `:${start}-${end}`;
    if (Number.isSafeInteger(end) && end > 0) return `:1-${end}`;
    if (Number.isSafeInteger(start) && start > 1) return `:${start}`;
    return '';
  }
  // Inline Python has no path: name its first meaningful source line instead.
  // Blank lines and comments carry no target information.
  function codeHint(value) {
    if (typeof value !== 'string') return '';
    for (const line of value.split(/\r?\n/)) {
      const text = line.replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('#')) continue;
      return text.slice(0, 100);
    }
    return '';
  }
  // Environment cards show the action plus the package set it operates on.
  function pythonEnvironmentHint(input) {
    const parts = [];
    if (typeof input.action === 'string' && input.action.trim()) parts.push(input.action.trim().slice(0, 24));
    if (Array.isArray(input.packages)) {
      const packages = input.packages.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
      if (packages.length) {
        parts.push(tr('{0} 个包', packages.length));
        parts.push(packages.slice(0, 3).join(', ') + (packages.length > 3 ? '…' : ''));
      }
    }
    return parts.join(' · ').slice(0, 160);
  }
  function hint(part, input) {
    if (isTeamTool(part.name)) return teamHint(part, input);
    if (part.name === 'background_commands') {
      const action = ({ list: '列出后台任务', read: '读取输出', stop: '停止任务' })[typeof input.action === 'string' ? input.action : ''] || '';
      const id = typeof input.command_id === 'string' ? shortId(input.command_id.replace(/^#/, '')) : '';
      return [action, id && '#' + id].filter(Boolean).join(' ');
    }
    if (['stop_worker', 'start_worker', 'prompt_worker'].includes(part.name)) {
      const alias = typeof input.worker === 'string' ? input.worker.trim().slice(0, 40) : '';
      const direction = part.name === 'prompt_worker' && typeof input.message === 'string' ? input.message.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      return [alias, direction].filter(Boolean).join(' · ');
    }
    if (part.name === 'web_search') {
      const search = part.output ? parseSearchOutput(part.output) : null;
      const query = (search?.query || (typeof input.query === 'string' ? input.query : '')).replace(/\s+/g, ' ').trim();
      const summary = searchSummary(search);
      if (query && summary) return `${query.slice(0, 120)} · ${summary}`;
      if (query) return query.slice(0, 160);
      if (summary) return summary;
    }
    if (part.name === 'run_python') {
      if (typeof input.script === 'string' && input.script.trim()) return input.script.replace(/\s+/g, ' ').trim().slice(0, 160);
      const code = codeHint(input.code);
      if (code) return code;
    }
    if (part.name === 'manage_python_environment') {
      const environment = pythonEnvironmentHint(input);
      if (environment) return environment;
    }
    let text = '';
    for (const key of ['path', 'url', 'query', 'symbol', 'glob', 'pattern', 'command', 'resource', 'skill', 'name', 'action']) {
      if (typeof input[key] === 'string' && input[key]) { text = input[key].replace(/\s+/g, ' ').slice(0, 160); break; }
    }
    if (!text && ['read_worker_evidence', 'read_worker_result'].includes(part.name)) text = shortId(input.worker_id ?? input.workerId);
    if (!text && part.name === 'read_context_evidence') text = shortId(input.artifactId);
    if (!text && part.name?.startsWith('mcp_')) text = part.name.slice(4);
    // File reads name the exact range they read.
    if (text && ['read_workspace_file', 'read_workspace_code'].includes(part.name)) text += lineRange(input);
    return text;
  }
  // What a read tool returned, as a size only: never the echoed content.
  function readMetric(part) {
    if (part.name === 'web_search') return ''; // the target hint already carries the result count
    if (typeof part.output !== 'string' || !part.output) return part.status === 'running' ? '读取中…' : '';
    const length = part.output.length;
    if (length > 100000) return `${Math.round(length / 1024)} KB`;
    let lines = 1;
    for (let index = part.output.indexOf('\n'); index !== -1; index = part.output.indexOf('\n', index + 1)) lines++;
    return lines > 1 ? `${lines} 行` : `${length} 字符`;
  }
  const readSummary = (part, input) => isTeamTool(part.name)
    ? hint(part, input)
    : [hint(part, input), readMetric(part)].filter(Boolean).join(' · ');
  // Task updates stay flat too: the result returns the whole board, but the
  // board itself is where to read it, so the card only names the action.
  const todoSummary = input => ({
    write: '更新任务板', update: '更新任务状态', clear_completed: '清理已完成任务', list: '查看任务板'
  })[typeof input.action === 'string' ? input.action : ''] || '';
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
  // Structured results for tools whose output is a JSON object the user should be
  // able to inspect without reading a raw JSON dump.
  const STRUCTURED_TOOLS = new Set(['fetch_web_content', 'browser_action', 'browser_connection_status',
    'list_agents', 'team_task_list', 'team_task_get', 'wait_agent', 'list_workers', 'list_assist_evidence']);
  function structuredJson(value) {
    if (typeof value !== 'string' || !value || value.length > 512 * 1024) return null;
    try {
      const data = JSON.parse(value);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch { return null; }
  }
  function scalarText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
  function renderStructuredResult(view, data, source) {
    if (view.renderedStructuredOutput === source) return;
    const root = view.structured;
    root.replaceChildren();
    const head = node('div', 'tool-structured-head');
    const labels = [
      ['status', data.status], ['verification_status', data.verification_status],
      ['content_title', data.content_title], ['message', data.message]
    ].map(([key, value]) => [key, scalarText(value)]).filter(([, value]) => value);
    const title = node('strong', 'tool-structured-title', labels.find(([key]) => key === 'content_title')?.[1] || scalarText(data.status) || '结果');
    head.append(title);
    const meta = [scalarText(data.final_url) || scalarText(data.requested_url), scalarText(data.source_host) || scalarText(data.requested_host), scalarText(data.content_type), data.http_status]
      .filter(value => value !== '' && value !== undefined && value !== null).join(' · ');
    if (meta) head.append(node('span', 'tool-structured-meta', meta));
    root.append(head);
    if (data.content && typeof data.content === 'string') {
      const body = node('pre', 'tool-structured-content', data.content.slice(0, 16000));
      root.append(body);
    }
    if (Array.isArray(data.links) && data.links.length) {
      const list = node('ul', 'tool-structured-links');
      for (const item of data.links.slice(0, 20)) {
        const url = scalarText(item?.url ?? item?.href ?? item);
        const label = scalarText(item?.text ?? item?.title) || url;
        if (!url) continue;
        const row = node('li');
        const link = node('a', 'tool-structured-link', label);
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        row.append(link); list.append(row);
      }
      if (list.childElementCount) root.append(list);
    }
    const fields = node('dl', 'tool-structured-fields');
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (count >= 24) break;
      const text = scalarText(value);
      if (!text || ['content', 'links', 'status', 'verification_status', 'content_title', 'message', 'final_url', 'requested_url', 'source_host', 'requested_host', 'content_type', 'http_status'].includes(key)) continue;
      fields.append(node('dt', '', key), node('dd', '', text.length > 800 ? text.slice(0, 800) + '…' : text));
      count++;
    }
    if (count) root.append(fields);
    const lists = [['results', 'results'], ['tasks', 'tasks'], ['members', 'members'], ['warnings', 'warnings']];
    for (const [key, label] of lists) {
      const values = data[key];
      if (!Array.isArray(values) || !values.length) continue;
      const section = node('section', 'tool-structured-list');
      section.append(node('h4', '', label + ' · ' + values.length));
      const ul = node('ul');
      for (const item of values.slice(0, 24)) {
        const text = scalarText(item) || scalarText(item?.title || item?.subject || item?.name || item?.description || item?.content || item?.member || item?.url);
        if (text) ul.append(node('li', '', text.slice(0, 600)));
      }
      section.append(ul); root.append(section);
    }
    const raw = node('details', 'tool-structured-raw');
    raw.append(node('summary', '', '原始 JSON'), node('pre', '', source.length > 20000 ? source.slice(0, 20000) + '…' : source));
    root.append(raw);
    view.renderedStructuredOutput = source;
  }
  function renderSearchResults(view, search, source) {
    if (view.renderedSearchOutput === source) return;
    const root = view.search;
    root.replaceChildren();
    const head = node('div', 'tool-search-head');
    const status = node('span', 'tool-search-status');
    status.dataset.status = search.status;
    setText(status, search.status === 'ok' ? '已完成' : search.status === 'no_results' ? '无结果' : '不可用');
    const meta = node('span', 'tool-search-meta');
    const bits = [searchSummary(search)];
    if (search.provider && search.provider !== 'none') bits.push(search.provider);
    if (search.fallback) bits.push('已回退');
    if (search.ranking && search.ranking !== 'strict') bits.push(search.ranking === 'soft' ? '宽松匹配' : '直通结果');
    setText(meta, bits.filter(Boolean).join(' · '));
    head.append(status, meta);
    root.append(head);
    if (search.query) {
      const query = node('p', 'tool-search-query');
      setText(query, '查询：' + search.query);
      root.append(query);
    }
    if (search.answer) {
      const answer = node('p', 'tool-search-answer');
      setRaw(answer, search.answer);
      root.append(answer);
    }
    if (search.message && !search.results.length) {
      const message = node('p', 'tool-search-empty');
      setText(message, search.message);
      root.append(message);
    }
    if (search.results.length) {
      const list = node('ol', 'tool-search-list');
      for (const item of search.results) {
        const row = node('li', 'tool-search-item');
        const link = node('a', 'tool-search-link');
        link.href = item.url;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        setRaw(link, item.title);
        const host = node('span', 'tool-search-host');
        setRaw(host, hostOf(item.url));
        row.append(link, host);
        if (item.snippet) {
          const snippet = node('p', 'tool-search-snippet');
          setRaw(snippet, item.snippet);
          row.append(snippet);
        }
        list.append(row);
      }
      root.append(list);
    }
    const note = node('p', 'tool-search-note', '摘要来自公开搜索，未经核验。打开链接前请自行确认来源。');
    root.append(note);
    view.renderedSearchOutput = source;
  }
  // A running tool can only stay expanded when it streams output. Other running
  // cards collapse their disclosure so fast repeated clicks cannot reveal an
  // incomplete body; their stop/aside actions remain available in the summary.
  function toolExpandable(view) {
    return view.flat !== true && (view.part?.status !== 'running' || view.streaming === true);
  }
  function syncToolDisclosure(view) {
    const expandable = toolExpandable(view);
    const expandableValue = String(expandable);
    if (view.element.dataset.expandable !== expandableValue) view.element.dataset.expandable = expandableValue;
    const disabled = String(!expandable && view.flat !== true);
    if (view.summary.getAttribute('aria-disabled') !== disabled) view.summary.setAttribute('aria-disabled', disabled);
    if (!expandable && view.element.open) view.element.open = false;
    const tabIndex = expandable ? 0 : -1;
    if (view.summary.tabIndex !== tabIndex) view.summary.tabIndex = tabIndex;
  }
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
    const diffStat = node('span', 'tool-diff-stat'); diffStat.hidden = true;
    // A tool result that inlined an image shows a compact thumbnail in the
    // collapsed row too, so a screenshot is visible without expanding the card.
    const summaryImage = node('img', 'tool-summary-image');
    summaryImage.loading = 'lazy'; summaryImage.decoding = 'async'; summaryImage.alt = '';
    summaryImage.hidden = true;
    const main = node('span', 'tool-summary-main'); main.append(summaryImage, title, path, diffStat);
    const state = node('span', 'tool-status'); state.append(status);
    const details = node('span', 'tool-card-meta'); details.append(state, time);
    const stop = node('button', 'tool-action tool-stop', '中断命令'); stop.type = 'button'; stop.hidden = true;
    stop.title = '中断此命令并保留输出，Agent 可继续处理结果';
    const chevron = node('span', 'tool-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    const live = node('span', 'tool-live-preview'); live.hidden = true;
    live.setAttribute('aria-hidden', 'true');
    const aside = node('button', 'tool-action tool-aside', '放在一边'); aside.type = 'button'; aside.hidden = true;
    summary.append(icon, main, details, aside, stop, chevron, live);
    summary.setAttribute('aria-label', '工具调用');
    const body = node('div', 'tool-card-body'), meta = node('div', 'tool-detail-name');
    const diff = node('section', 'tool-diff'); diff.hidden = true; diff.setAttribute('aria-label', '代码差异');
    const diffFiles = node('div', 'tool-diff-files'), diffNote = node('p', 'tool-diff-note'); diffNote.hidden = true;
    diff.append(diffFiles, diffNote);
    const search = node('div', 'tool-search'); search.hidden = true; search.setAttribute('aria-label', '搜索结果');
    const structured = node('div', 'tool-structured'); structured.hidden = true; structured.setAttribute('aria-label', '结构化结果');
    const input = node('pre', 'tool-parameters'), output = node('pre', 'tool-output');
    output.tabIndex = input.tabIndex = 0; output.setAttribute('aria-label', '工具输出'); input.setAttribute('aria-label', '工具参数');
    const actions = node('div', 'tool-result-toolbar'), info = node('span', 'tool-result-info');
    const copy = node('button', 'tool-action', '复制输出'), preview = node('button', 'tool-action', '预览 HTML');
    copy.type = preview.type = 'button';
    const latest = node('button', 'tool-action', '回到最新'); latest.type = 'button'; latest.hidden = true;
    latest.title = '滚动到日志底部，继续跟随新输出';
    const label = node('span', 'tool-result-label', '输出');
    actions.append(label, info, preview, latest, copy);
    const args = node('details', 'tool-arguments'); args.append(node('summary', '', '参数'), meta, input);
    const notice = node('p', 'tool-truncation', '显示内容已截断。');
    // Read-only tools keep their card but never echo the returned content.
    const readNote = node('p', 'tool-read-note', '读取类操作不需要回显结果内容，可在「参数」中确认目标，或按需重新读取。');
    readNote.hidden = true;
    // One image per result is inlined. The figure is a single disclosure target:
    // a compact thumbnail until activated, then a larger view. It is built once
    // and only its image/caption are refreshed by renderToolBody.
    const image = node('figure', 'tool-image');
    image.hidden = true;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-expanded', 'false');
    image.setAttribute('aria-label', tr('放大图片'));
    image.tabIndex = 0;
    const imagePreview = node('img', 'tool-image-preview');
    imagePreview.loading = 'lazy';
    imagePreview.decoding = 'async';
    imagePreview.alt = tr('工具返回的图片');
    const imageCaption = node('figcaption', 'tool-image-caption');
    image.append(imagePreview, imageCaption);
    const imageNote = node('p', 'tool-image-note', '部分图片未内联显示。');
    imageNote.hidden = true;
    body.append(diff, search, structured, image, imageNote, output, readNote, actions, args, notice);
    element.append(summary, body);
    const view = { element, summary, chevron, icon, iconPath, title, path, status, time, meta, input, output, search, structured, info, label, copy, preview, stop, aside, notice, readNote, toolbar: actions, flat: false, live, latest, part: {}, options: {}, diff, diffFiles, diffNote, diffStat, diffModel: null, diffKey: '', renderedStructuredOutput: undefined, image, imagePreview, imageCaption, imageNote, renderedImageMime: undefined, renderedImageData: undefined, summaryImage, renderedThumbKey: undefined };
    search.addEventListener('click', event => {
      const link = event.target?.closest?.('a.tool-search-link');
      if (!link || !search.contains(link) || view.released) return;
      event.preventDefault();
      view.options.onOpenLink?.(link.href);
    });
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
    // Flat cards are a single row: no disclosure and no body. Running
    // non-streaming cards are temporarily locked until they finish.
    summary.addEventListener('click', event => { if (!toolExpandable(view)) event.preventDefault(); });
    summary.addEventListener('keydown', event => { if (!toolExpandable(view) && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); });
    element.addEventListener('toggle', () => {
      if (view.released) return;
      if (!toolExpandable(view)) { if (element.open) element.open = false; return; }
      try { if (element.open) renderToolBody(view); else renderLivePreview(view); }
      catch {
        // A failed deferred render can be retried with the same state snapshot.
        view.dirty = true;
        if (element.open) {
          output.textContent = view.part.output || '';
          view.renderedOutput = output.textContent;
          search.hidden = true; output.hidden = false;
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
    // A figure with role="button" keeps the thumbnail keyboard-operable without
    // nesting another interactive element inside the card body.
    const toggleImage = () => {
      if (view.released || image.hidden) return;
      setImageExpanded(view, image.dataset.expanded !== 'true');
    };
    image.addEventListener('click', toggleImage);
    image.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleImage();
    });
    return view;
  }
  function updateTool(view, part, options) {
    view.options = options;
    // A tool that inlines an image must be expandable even when its name is
    // read-only (read_image is otherwise a flat row). An omission notice alone
    // also needs a body to be readable.
    view.flat = isFlatToolCard(part.name) && !part.image && part.imageOmitted !== true;
    const readonly = view.flat ? 'true' : 'false';
    if (view.element.dataset.readonly !== readonly) view.element.dataset.readonly = readonly;
    // Read-only cards stay flat by design. Explain where the result went so the
    // collapsed card does not look like a missing or failed output.
    const flatHint = view.flat ? '读取类操作：结果不回显，完整记录见日志。' : '';
    if (flatHint) { if (view.summary.getAttribute('title') !== flatHint) view.summary.setAttribute('title', flatHint); }
    else if (view.summary.hasAttribute('title')) view.summary.removeAttribute('title');
    if (view.element.dataset.tool !== part.name) view.element.dataset.tool = part.name || '';
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
    const imageUnchanged = sameToolImage(part.image, view.part.image)
      && (part.imageOmitted === true) === (view.part.imageOmitted === true);
    if (!view.dirty && imageUnchanged && keys.every(key => part[key] === view.part[key])) return renderToolBody(view);
    const argumentsChanged = view.dirty || part.name !== view.part.name || part.args !== view.part.args;
    const outputChanged = view.dirty || part.output !== view.part.output || part.status !== view.part.status;
    const streaming = ['run_linux_ssh_command', 'run_local_skill_script', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service'].includes(part.name);
    view.dirty = true;
    view.part = { ...part };
    view.streaming = streaming;
    renderToolSummaryImage(view, part);
    syncToolDisclosure(view);
    view.bodyDirty = true;
    const diffModel = toolDiff(part);
    view.diffModel = diffModel;
    const diffValue = diffModel ? 'true' : 'false';
    if (view.element.dataset.diff !== diffValue) view.element.dataset.diff = diffValue;
    view.diffStat.hidden = !diffModel;
    if (diffModel) setDiffStat(view.diffStat, diffModel);
    const status = labels[part.status] ? part.status : 'completed';
    if (view.element.dataset.status !== status) view.element.dataset.status = status;
    const executionState = status === 'running' && executionLabels[part.executionState] ? part.executionState : '';
    if (view.element.dataset.executionState !== executionState) view.element.dataset.executionState = executionState;
    const receiving = String(streaming && status === 'running' && !['queued', 'starting', 'preflight', 'preparing', 'stopping', 'cleanup'].includes(executionState));
    if (view.element.dataset.streaming !== receiving) view.element.dataset.streaming = receiving;
    const title = tools[part.name] || (part.name?.startsWith('mcp_') ? 'MCP 工具' : part.name || '工具调用');
    setText(view.title, title);
    if (argumentsChanged || (part.name === 'web_search' && outputChanged)) {
      const input = parameters(part), kind = kinds[part.name] || (part.name?.startsWith('mcp_') ? 'mcp' : 'tool');
      if (argumentsChanged) {
        view.icon.dataset.kind = kind; view.iconPath.setAttribute('d', icons[kind]);
        view.title.title = title;
      }
      const targetHint = hint(part, input);
      setText(view.path, targetHint);
      if (view.path.title !== view.path.textContent) view.path.title = view.path.textContent;
    }
    // Flat cards still report what the operation touched, without echoing the
    // returned content. Read cards add the size; task cards name the action.
    if (view.flat) {
      setText(view.path, part.name === 'todo' ? todoSummary(parameters(part)) : readSummary(part, parameters(part)));
      // Only rewrite the tooltip when the text actually changed; otherwise every
      // streamed token would mutate each completed card's attributes.
      if (view.path.title !== view.path.textContent) view.path.title = view.path.textContent;
    }
    const statusText = status === 'running' && part.background ? '后台运行' : executionLabels[executionState] || labels[status];
    setText(view.status, statusText);
    const summaryLabel = [title, view.path.textContent, diffModel ? diffSummary(diffModel) : '', statusText].filter(Boolean).join(' · ');
    if (view.element.firstElementChild.getAttribute('aria-label') !== summaryLabel) view.element.firstElementChild.setAttribute('aria-label', summaryLabel);
    // Flat cards are a single row: no disclosure and no body.
    if (view.flat) {
      if (view.element.open) view.element.open = false;
      if (view.summary.tabIndex !== -1) view.summary.tabIndex = -1;
    }
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
    if (view.flat) {
      if (!view.live.hidden) view.live.hidden = true;
      if (view.live.textContent) view.live.textContent = '';
      view.liveOutput = part.output; view.liveStatus = status; view.liveStreaming = streaming;
      return;
    }
    if (view.liveOutput === part.output && view.liveStatus === status && view.liveStreaming === streaming) return;
    // A bounded tail provides live feedback for any running card with output,
    // including tools that do not stream token-by-token (MCP progress, deploy
    // steps). Failures and stops use the same folded row as successful calls;
    // their error/output detail is shown only in the expanded body.
    const showLive = Boolean(part.output) && status === 'running';
    if (showLive) {
      const tail = part.output.slice(-1200).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
      const lines = tail.trimEnd().split('\n').slice(-2).join('\n').slice(-400);
      setRaw(view.live, lines);
      if (view.live.dataset.status !== status) view.live.dataset.status = status;
    }
    if (view.live.hidden === showLive) view.live.hidden = !showLive;
    if (!showLive && view.live.textContent) view.live.textContent = '';
    view.liveOutput = part.output; view.liveStatus = status; view.liveStreaming = streaming;
  }
  function renderDiff(view, part) {
    const model = toolDiff(part);
    view.diffModel = model;
    view.element.dataset.diff = model ? 'true' : 'false';
    if (!model) {
      view.diff.hidden = true; view.diffStat.hidden = true; view.diffKey = '';
      return null;
    }
    setDiffStat(view.diffStat, model);
    const key = `${part.name || ''}\0${part.output || ''}`;
    if (view.diffKey === key) { view.diff.hidden = false; return model; }
    view.diffKey = key;
    view.diffFiles.replaceChildren();
    let omitted = false;
    for (const entry of model.entries) {
      const file = document.createElement('article'); file.className = 'tool-diff-file';
      const head = document.createElement('div'); head.className = 'tool-diff-file-head';
      const path = document.createElement('code'); path.className = 'tool-diff-path';
      path.textContent = entry.path || '（未知文件）'; path.title = entry.path || '';
      const counts = document.createElement('span'); counts.className = 'tool-diff-counts';
      if (entry.added) { const value = document.createElement('span'); value.className = 'tool-diff-added'; value.textContent = `+${entry.added}`; counts.append(value); }
      if (entry.removed) { const value = document.createElement('span'); value.className = 'tool-diff-removed'; value.textContent = `−${entry.removed}`; counts.append(value); }
      head.append(path, counts);
      const body = document.createElement('div'); body.className = 'tool-diff-body';
      body.setAttribute('role', 'region'); body.setAttribute('aria-label', `${entry.path || '文件'} 差异`);
      const lines = String(entry.patch).replace(/\r\n?/g, '\n').split('\n');
      const shown = lines.slice(0, 600);
      for (const line of shown) {
        const row = document.createElement('div');
        row.className = 'tool-diff-line';
        row.dataset.kind = line.startsWith('@@') ? 'hunk'
          : line.startsWith('+++') || line.startsWith('---') ? 'meta'
            : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
        row.textContent = line || ' ';
        body.append(row);
      }
      if (lines.length > shown.length) {
        const more = document.createElement('p'); more.className = 'tool-diff-more';
        more.textContent = `仅显示前 ${shown.length} 行，完整差异请打开「代码更改」。`;
        body.append(more);
      }
      if (/^\(diff omitted/.test(String(entry.patch).trim())) omitted = true;
      file.append(head, body); view.diffFiles.append(file);
    }
    view.diffNote.hidden = !omitted;
    if (omitted) setRaw(view.diffNote, '差异过大，已显示可用的补丁片段。');
    view.diff.hidden = false;
    return model;
  }
  // Command tools report their real process exit code in the output. Surface it
  // beside the line count once the call has finished.
  const EXIT_CODE_TOOLS = new Set(['run_local_shell_command', 'run_linux_ssh_command', 'run_python', 'manage_python_environment', 'run_local_skill_script']);
  function exitCodeInfo(name, output) {
    if (!EXIT_CODE_TOOLS.has(name) || typeof output !== 'string' || !output) return '';
    const match = /exit_code:\s*(-?\d+)/.exec(output);
    return match ? tr('退出码 {0}', match[1]) : '';
  }
  function setImageExpanded(view, expanded) {
    const figure = view.image, value = String(expanded === true);
    if (figure.dataset.expanded !== value) figure.dataset.expanded = value;
    if (figure.getAttribute('aria-expanded') !== value) figure.setAttribute('aria-expanded', value);
    const label = tr(expanded ? '缩小图片' : '放大图片');
    if (figure.getAttribute('aria-label') !== label) figure.setAttribute('aria-label', label);
  }
  // Only the inlined image is rendered. The data URL is assigned once per image
  // payload so unchanged snapshots never restart the browser's decode work.
  function renderToolImage(view, part) {
    const image = part.image, inline = hasInlineToolImage(image);
    const figure = view.image, note = view.imageNote;
    if (!inline) {
      if (!figure.hidden) figure.hidden = true;
      if (figure.dataset.expanded === 'true') setImageExpanded(view, false);
      view.renderedImageMime = undefined; view.renderedImageData = undefined;
    } else {
      const mimeType = image.mimeType.trim();
      if (view.renderedImageMime !== mimeType || view.renderedImageData !== image.data) {
        view.imagePreview.src = `data:${mimeType};base64,${image.data}`;
        view.renderedImageMime = mimeType; view.renderedImageData = image.data;
      }
      const width = Number(image.width), height = Number(image.height);
      const dimensions = Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 ? `${width}×${height}` : '';
      setRaw(view.imageCaption, [imageFormatLabel(mimeType), dimensions, imageSizeLabel(image.bytes)].filter(Boolean).join(' · '));
      if (view.imageCaption.hidden !== !view.imageCaption.textContent) view.imageCaption.hidden = !view.imageCaption.textContent;
      if (figure.hidden) figure.hidden = false;
    }
    if (note.hidden !== (part.imageOmitted !== true)) note.hidden = part.imageOmitted !== true;
  }
  // Collapsed-row thumbnail: one small preview in the summary keeps a screenshot
  // visible while the card is folded. The pixels are assigned once per payload so
  // identical snapshots never restart the decode work.
  function renderToolSummaryImage(view, part) {
    const image = hasInlineToolImage(part.image) ? part.image : undefined;
    const thumb = view.summaryImage;
    if (!thumb) return;
    if (!image) {
      if (!thumb.hidden) thumb.hidden = true;
      view.renderedThumbKey = undefined;
      return;
    }
    const key = `${image.mimeType}|${image.data.length}|${image.data.slice(0, 24)}|${image.data.slice(-24)}`;
    if (view.renderedThumbKey !== key) {
      thumb.src = `data:${image.mimeType};base64,${image.data}`;
      view.renderedThumbKey = key;
    }
    if (thumb.hidden) thumb.hidden = false;
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
      setRaw(view.input, args);
      view.renderedArgs = args;
    }
    if (view.flat) {
      // Flat tools: keep the operation, target and parameters, but never render
      // the returned content that the agent already consumed.
      if (!view.structured.hidden) view.structured.hidden = true;
      if (!view.search.hidden) { view.search.hidden = true; view.renderedSearchOutput = undefined; view.search.replaceChildren(); }
      if (!view.output.hidden) view.output.hidden = true;
      if (view.renderedOutput) { view.output.textContent = ''; view.renderedOutput = ''; view.lineOutput = ''; view.newlines = 0; }
      if (view.readNote.hidden) view.readNote.hidden = false;
      // A flat card cannot carry an image, but a tool that lost its image may
      // fall back to this branch after being expandable.
      if (!view.image.hidden) view.image.hidden = true;
      if (!view.imageNote.hidden) view.imageNote.hidden = true;
      setText(view.label, ''); setText(view.info, '');
      if (!view.label.hidden) view.label.hidden = true;
      if (!view.info.hidden) view.info.hidden = true;
      setToolbarVisibility(view, part, { preview: true, latest: true });
      view.bodyDirty = false;
      return true;
    }
    renderToolImage(view, part);
    const diffModel = renderDiff(view, part);
    if (diffModel) {
      // The exact patch is more useful than the JSON result body for write/edit
      // calls. Keep the raw output in the copy action, but show the diff card.
      if (!view.readNote.hidden) view.readNote.hidden = true;
      if (!view.structured.hidden) view.structured.hidden = true;
      if (!view.search.hidden) { view.search.hidden = true; view.renderedSearchOutput = undefined; view.search.replaceChildren(); }
      if (!view.output.hidden) view.output.hidden = true;
      if (view.notice.hidden !== true) view.notice.hidden = true;
      if (view.label.hidden) view.label.hidden = false;
      if (view.info.hidden) view.info.hidden = false;
      setText(view.label, '变更');
      setRaw(view.info, diffSummary(diffModel));
      setToolbarVisibility(view, part, { preview: true, latest: true });
      view.bodyDirty = false;
      return true;
    }
    if (!view.diff.hidden) view.diff.hidden = true;
    // The truncation notice is owned by setToolbarVisibility(); don't toggle it
    // here or a growing log rewrites the same attribute twice per update.
    if (!view.readNote.hidden) view.readNote.hidden = true;
    if (view.label.hidden) view.label.hidden = false;
    if (view.info.hidden) view.info.hidden = false;
    if (view.toolbar.hidden) view.toolbar.hidden = false;
    const waiting = { queued: '正在等待同一会话的前一条命令结束，可单独中断此排队命令。', starting: '正在准备命令执行…', preflight: '正在检查沙箱环境…', preparing: '正在准备运行环境…', stopping: '正在停止命令并清理进程…', cleanup: '正在清理沙箱环境…' };
    const search = part.name === 'web_search' && part.output ? parseSearchOutput(part.output) : null;
    const structured = !search && STRUCTURED_TOOLS.has(part.name) && part.output ? structuredJson(part.output) : null;
    const placeholder = status === 'running' ? waiting[part.executionState] || (streaming ? '正在执行，等待输出…' : '等待工具返回…') : status === 'interrupted' ? '调用已停止，执行状态请以已有记录为准。' : '无文本输出。';
    if (search) {
      if (!view.structured.hidden) view.structured.hidden = true;
      renderSearchResults(view, search, part.output);
      if (view.search.hidden) view.search.hidden = false;
      if (!view.output.hidden) view.output.hidden = true;
      setText(view.label, '结果');
      setText(view.info, [searchSummary(search), search.provider && search.provider !== 'none' ? search.provider : ''].filter(Boolean).join(' · '));
    } else if (structured) {
      if (!view.search.hidden) { view.search.hidden = true; view.renderedSearchOutput = undefined; view.search.replaceChildren(); }
      renderStructuredResult(view, structured, part.output);
      if (view.structured.hidden) view.structured.hidden = false;
      if (!view.output.hidden) view.output.hidden = true;
      setText(view.label, '结果');
      setText(view.info, [structured.status, structured.verification_status, structured.message].filter(value => typeof value === 'string' && value).join(' · ').slice(0, 200));
    } else {
      if (!view.structured.hidden) view.structured.hidden = true;
      if (!view.search.hidden) { view.search.hidden = true; view.renderedSearchOutput = undefined; view.search.replaceChildren(); }
      if (view.output.hidden) view.output.hidden = false;
      setText(view.label, '输出');
      setOutput(view, part.output || placeholder);
      const output = part.output || '', previousOutput = view.lineOutput || '';
      const appended = output.startsWith(previousOutput);
      const tail = appended ? output.slice(previousOutput.length) : output;
      let newlines = appended ? view.newlines || 0 : 0;
      // Count without allocating one array entry per line in large shell logs.
      for (let index = tail.indexOf('\n'); index !== -1; index = tail.indexOf('\n', index + 1)) newlines++;
      view.newlines = newlines;
      view.lineOutput = output;
      const lines = output ? view.newlines + (output.endsWith('\n') ? 0 : 1) : 0;
      const received = status === 'running' ? executionLabels[part.executionState] || '接收中' : '';
      const lineInfo = lines ? lines + ' 行' : '';
      const exitInfo = status === 'running' ? '' : exitCodeInfo(part.name, output);
      setText(view.info, [received, lineInfo, exitInfo].filter(Boolean).join(' · '));
    }
    setToolbarVisibility(view, part, { preview: !part.output || !htmlSource(part.output) || Boolean(search), latest: !part.output || Boolean(search) });
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
  // DSH-style reasoning preview: the collapsed thinking row shows the newest
  // meaningful line, stripped of Markdown/protocol payloads and clamped.
  const THINKING_PREVIEW_LIMIT = 160;
  const thinkingPlaceholder = () => '[' + tr('规划协议内容已折叠') + ']';
  function foldThinkingProtocols(value) {
    const placeholder = thinkingPlaceholder();
    let text = String(value ?? '');
    text = text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g, (match, body) => {
      if (/"intents"|"decision"|"plan"|"steps"|"actions"\s*:/i.test(body) || /^\s*[[{]/.test(body)) return placeholder;
      return match;
    });
    text = text.replace(/(^|\n)[ \t]*\{(?:[^\n]*"(?:intents|decision|plan|steps|actions)"\s*:)[^\n]*(?=\n|$)/g, (match, lead) => lead + placeholder);
    return text;
  }
  function thinkingPreview(value) {
    const placeholder = thinkingPlaceholder();
    const stripped = foldThinkingProtocols(value)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/[*_~|]/g, '');
    const lines = stripped.split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line && line !== placeholder && line !== '[内容已截断]');
    let line = lines.length ? lines[lines.length - 1] : '';
    if (line.length > THINKING_PREVIEW_LIMIT) line = line.slice(0, THINKING_PREVIEW_LIMIT - 1).trimEnd() + '…';
    return line;
  }
  function createThinking(kind = 'thinking') {
    const element = node('details', 'thinking-card' + (kind === 'summary' ? ' summary-card' : '')), summary = node('summary', 'thinking-summary');
    // DSH-style: every thinking card starts collapsed; streaming never opens it.
    element.open = false;
    const indicator = node('span', 'thinking-indicator'); indicator.setAttribute('aria-hidden', 'true');
    const title = node('span', 'thinking-title'), source = node('span', 'thinking-source'), time = node('span', 'thinking-time');
    const badge = kind === 'summary' ? node('span', 'summary-badge') : null;
    const preview = kind === 'summary' ? null : node('span', 'thinking-preview');
    const chevron = node('span', 'thinking-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    summary.append(indicator, title, source, ...(preview ? [preview] : []), ...(badge ? [badge] : []), time, chevron);
    const body = node('div', 'thinking-body'), content = node('div', 'thinking-content');
    body.tabIndex = 0; body.setAttribute('aria-label', kind === 'summary' ? '上下文摘要' : '思考内容');
    const metrics = node('p', 'summary-metrics'); metrics.hidden = true;
    const notice = node('p', 'thinking-truncation', '思考内容较长，此处显示已保留的部分。');
    if (kind === 'summary') body.append(metrics);
    body.append(content, notice); element.append(summary, body);
    const view = { element, title, source, badge, preview, time, body, content, metrics, notice, part: {}, options: {}, rendered: false };
    summary.addEventListener('click', () => { view.userGesture = true; });
    summary.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') view.userGesture = true; });
    element.addEventListener('toggle', () => {
      if (!view.syncing && view.userGesture) {
        view.userGesture = false;
        if (element.open) { view.openedByUser = true; view.collapsedByUser = false; }
        else { view.collapsedByUser = true; view.openedByUser = false; }
      } else view.userGesture = false;
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
    setText(view.source, source === 'reason' ? '规划' : source === 'worker' ? '子任务' : '');
    const title = view.source.textContent;
    if (view.source.title !== title) view.source.title = title;
    if (view.notice.hidden !== !part.truncated) view.notice.hidden = !part.truncated;
    // The collapsed row's preview updates on every token; the Markdown body is
    // only parsed while the reader has expanded the card.
    if (view.preview) setRaw(view.preview, thinkingPreview(part.text));
    trackDuration(view);
    renderThinking(view);
    view.dirty = false;
    return true;
  }
  function summaryScopeLabel(kinds) {
    const keys = Object.keys(kinds ?? {});
    if (!keys.length) return '上下文摘要';
    const body = keys.includes('transcript'), tool = keys.some(key => key === 'tool-result' || key === 'tool-arguments');
    if (body && tool || keys.length > 1 && body) return '混合摘要';
    if (tool) return '工具摘要';
    if (body) return '正文摘要';
    return '事实摘要';
  }
  function updateSummary(view, part, options) {
    const actionsChanged = ['onCopy', 'onOpenLink', 'onPreviewHtml'].some(key => view.options[key] !== options[key]);
    view.options = options;
    if (view.element.isConnected && !active.has(view) && ['running', 'streaming'].includes(view.part.status)) trackDuration(view);
    const keys = ['id', 'text', 'status', 'source', 'workerId', 'startedAt', 'endedAt', 'truncated', 'fallback', 'beforeTokens', 'afterTokens', 'kinds'];
    // `kinds` is rebuilt on every projection, so compare by value to avoid a
    // re-render on identical telemetry.
    const unchanged = key => key === 'kinds' ? JSON.stringify(part[key]) === JSON.stringify(view.part[key]) : part[key] === view.part[key];
    if (!view.dirty && !actionsChanged && keys.every(unchanged)) return false;
    view.dirty = true;
    view.part = { ...part };
    const status = ['running', 'failed', 'interrupted'].includes(part.status) ? part.status : 'completed';
    if (view.element.dataset.status !== status) view.element.dataset.status = status;
    const scope = summaryScopeLabel(part.kinds);
    setText(view.title, { running: '正在整理上下文', completed: scope, failed: '摘要未完成', interrupted: '摘要已停止' }[status]);
    setText(view.source, part.source === 'reason' ? '规划' : part.source === 'worker' ? '子任务' : '');
    const title = part.workerId || view.source.textContent;
    if (view.source.title !== title) view.source.title = title;
    view.displayText = part.text || { running: '正在整理较早的对话与工具记录，完成后会在此显示摘要。', completed: '本次上下文整理已完成。', failed: '上下文整理未完成，请查看本轮执行错误。', interrupted: '上下文整理已停止。' }[status];
    // A fallback no longer pastes raw source; it keeps a recoverable pointer, so
    // the copy must not claim an excerpt was used.
    if (part.fallback) view.displayText = '本次未生成摘要，已保留可恢复来源。\n\n' + view.displayText;
    const hasMetrics = [part.beforeTokens, part.afterTokens].every(value => Number.isSafeInteger(value) && value >= 0);
    if (view.metrics.hidden !== !hasMetrics) view.metrics.hidden = !hasMetrics;
    const savedPercent = hasMetrics && part.beforeTokens > 0 && part.afterTokens <= part.beforeTokens
      ? Math.round((1 - part.afterTokens / part.beforeTokens) * 100) : 0;
    setText(view.metrics, hasMetrics
      ? `上下文用量估算：${part.beforeTokens.toLocaleString('en-US')} → ${part.afterTokens.toLocaleString('en-US')} tokens${savedPercent ? ` · 节省 ${savedPercent}%` : ''}`
      : '');
    const saved = savedPercent ? `节省 ${savedPercent}%` : '';
    setText(view.badge, part.fallback ? '未生成' : status === 'completed' ? saved || '已整理' : status === 'running' ? '进行中' : '需关注');
    if (view.notice.hidden !== !part.truncated) view.notice.hidden = !part.truncated;
    setText(view.notice, '摘要较长，此处仅显示已保留的部分。');
    trackDuration(view); renderThinking(view);
    view.dirty = false;
    return true;
  }
  // The toolbar is shared by both card modes. Previously the read-only branch and
  // the regular branch each re-declared the same visibility rules, which is how
  // they drifted apart (read-only forced `latest` hidden; the regular branch keyed
  // it off the output). Keep the rules in one place, and let each caller override
  // only what actually differs.
  function setToolbarVisibility(view, part, rules) {
    const set = (element, hidden) => { if (element.hidden !== hidden) element.hidden = hidden; };
    set(view.preview, rules.preview === true);
    set(view.latest, rules.latest === true);
    set(view.copy, !part.output);
    set(view.toolbar, false);
    set(view.notice, !part.truncated);
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
      const maintenance = part => part.type === 'summary' || part.type === 'tool' && (part.name === 'wait_workers' || part.name === 'wait_agent');
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
    // Assist mode groups consecutive tool parts into foldable `.tool-group` rows.
    // Readers that need a strictly chronological timeline (exploration log) can
    // pass `toolGrouping: false` so every tool part keeps its own standalone card.
    const toolGrouping = options.toolGrouping !== false;
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
        if (!toolGrouping) {
          // Standalone tool card: no `.tool-group` wrapper or batch summary.
          group = null;
          const standaloneNext = previous ? previous.nextSibling : element.firstChild;
          if (item.element !== standaloneNext) { element.insertBefore(item.element, standaloneNext); changed = true; }
          previous = item.element; previousTool = null;
          changed = updateTool(item, part, options) || changed;
          continue;
        }
        if (!group) {
          group = view.groups.get(part.id);
          if (!group) {
            group = node('div', 'tool-group');
            const toggle = node('button', 'tool-group-toggle'); toggle.type = 'button'; toggle.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            const status = node('span', 'tool-group-status'); status.setAttribute('aria-hidden', 'true');
            const summary = node('span', 'tool-group-summary');
            const runningChip = node('span', 'tool-group-chip'); runningChip.dataset.kind = 'running';
            const failedChip = node('span', 'tool-group-chip'); failedChip.dataset.kind = 'failed';
            const action = node('span', 'tool-group-action');
            const duration = node('span', 'tool-group-duration'); duration.dataset.value = '';
            const chevron = node('span', 'tool-group-chevron'); chevron.setAttribute('aria-hidden', 'true');
            toggle.append(status, summary, runningChip, failedChip, action, duration, chevron);
            group.append(toggle);
            group.toggle = toggle; group.summaryLabel = summary; group.runningChip = runningChip;
            group.failedChip = failedChip; group.action = action; group.duration = duration;
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
        const label = failed ? '后台步骤失败，请展开查看' : interrupted ? '后台步骤已停止' : running?.type === 'summary' ? '正在整理上下文' : running ? (running.name === 'wait_agent' ? '正在等待团队进展' : '正在等待并行任务') : '后台步骤已完成';
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
  function batchDuration(items, now = Date.now()) {
    let start = Infinity, end = -Infinity;
    for (const item of items) {
      const startedAt = Number(item.part.startedAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
      start = Math.min(start, startedAt);
      const endedAt = ['running', 'streaming'].includes(item.part.status) ? now : Number(item.part.endedAt);
      if (Number.isFinite(endedAt) && endedAt >= startedAt) end = Math.max(end, endedAt);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
    const seconds = (end - start) / 1000;
    return seconds < 60 ? (seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + 's' : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  }
  function refreshToolBatch(batch, items) {
    const operationLabel = item => {
      const title = item.element.querySelector('.tool-title')?.textContent?.trim();
      const path = item.element.querySelector('.tool-path')?.textContent?.trim();
      if (!title) return '工具调用';
      return path && path !== title ? `${title}：${path}` : title;
    };
    const operationSummary = (entries, limit = 3) => {
      const labels = entries.map(operationLabel).filter(Boolean);
      const visible = labels.slice(0, limit);
      const suffix = labels.length > limit ? ` 等 ${labels.length} 项` : '';
      return visible.join('、') + suffix;
    };
    batch.toolItems = items;
    // Only timestamps that overlap indicate parallel work. Mere adjacency is
    // not enough: a sequence of file reads should remain a sequential list.
    // Huge same-timestamp batches are more useful as foldable history than as
    // one "parallel" label, so only genuinely small clusters become a group.
    const clusters = [];
    for (const item of items) {
      const start = Number(item.part.startedAt);
      const last = clusters.at(-1);
      if (last && Number.isFinite(start) && start > 0 && start <= last.end) {
        last.items.push(item);
        last.end = Math.max(last.end, Number(item.part.endedAt) || (['running', 'streaming'].includes(item.part.status) ? Infinity : start));
      } else clusters.push({ items: [item], end: Number(item.part.endedAt) || (['running', 'streaming'].includes(item.part.status) && start > 0 ? Infinity : start) });
    }
    const batches = clusters.flatMap(cluster => cluster.items.length > 4
      ? cluster.items.map(item => ({ items: [item], end: Number(item.part.endedAt) || 0 }))
      : [cluster]);
    const previousGroups = batch.parallelGroups || new Map();
    const nextGroups = new Map();
    let anchor = batch.firstChild;
    for (const cluster of batches) {
      if (cluster.items.length === 1) {
        const card = cluster.items[0].element;
        delete card.dataset.parallelGroup;
        if (card.parentNode !== batch || card.previousSibling !== anchor) batch.insertBefore(card, anchor.nextSibling);
        anchor = card;
        continue;
      }
      const key = cluster.items[0].part.id;
      let parallel = previousGroups.get(key);
      if (!parallel) {
        parallel = node('div', 'parallel-tools');
        const heading = node('button', 'parallel-tools-heading'); heading.type = 'button';
        const status = node('span', 'parallel-tools-status'); status.setAttribute('aria-hidden', 'true');
        const title = node('span', 'parallel-tools-title');
        const progress = node('span', 'parallel-tools-progress');
        const arrow = node('span', 'parallel-tools-chevron'); arrow.setAttribute('aria-hidden', 'true');
        heading.append(status, title, progress, arrow);
        parallel.append(heading);
        parallel.dataset.collapsed = 'false';
        heading.setAttribute('aria-expanded', 'true');
        parallel.headingNode = heading; parallel.titleNode = title; parallel.progressNode = progress;
        heading.addEventListener('click', () => {
          const collapsed = parallel.dataset.collapsed !== 'true';
          parallel.dataset.collapsed = String(collapsed);
          heading.setAttribute('aria-expanded', String(!collapsed));
          for (const card of parallel.clusterItems || []) card.element.hidden = collapsed;
        });
      }
      nextGroups.set(key, parallel);
      parallel.clusterItems = cluster.items;
      const firstCard = cluster.items[0].element;
      if (parallel.parentNode !== batch || parallel.nextSibling !== firstCard) batch.insertBefore(parallel, firstCard);
      for (const item of cluster.items) item.element.dataset.parallelGroup = key;
      const runningCount = cluster.items.filter(item => ['running', 'streaming'].includes(item.part.status)).length;
      const failedCount = cluster.items.filter(item => item.part.status === 'failed').length;
      const interruptedCount = cluster.items.filter(item => item.part.status === 'interrupted').length;
      const clusterStatus = failedCount ? 'failed' : runningCount ? 'running' : interruptedCount ? 'interrupted' : 'completed';
      if (parallel.dataset.status !== clusterStatus) parallel.dataset.status = clusterStatus;
      const clusterTitle = tr('{0} 个并行调用', cluster.items.length);
      const clusterProgress = ' · ' + (failedCount ? tr('{0} 个失败', failedCount)
        : runningCount ? tr('{0} 个运行中', runningCount)
        : interruptedCount ? tr('{0} 个已停止', interruptedCount) : tr('全部完成'));
      setText(parallel.titleNode, clusterTitle);
      setRaw(parallel.progressNode, clusterProgress);
      const clusterLabel = `${clusterTitle}：${operationSummary(cluster.items)}`;
      if (parallel.headingNode.getAttribute('aria-label') !== clusterLabel) parallel.headingNode.setAttribute('aria-label', clusterLabel);
      anchor = cluster.items.at(-1).element;
    }
    for (const [key, parallel] of previousGroups) if (!nextGroups.has(key)) parallel.remove();
    batch.parallelGroups = nextGroups;
    // Two consecutive calls already form a useful tool group. History starts
    // folding only once a batch grows past the three most recent calls, so
    // short sequences stay fully readable.
    const compact = items.length >= 2, expanded = batch.dataset.expanded === 'true';
    if (batch.dataset.compact !== String(compact)) batch.dataset.compact = String(compact);
    const toggle = batch.firstChild;
    const keepRecent = 3;
    let hidden = 0, running = 0, failed = 0, interrupted = 0;
    // A parallel cluster folds as one unit while its calls sit in history.
    const positions = new Map(items.map((item, index) => [item, index]));
    const clusterFolded = new Map();
    if (compact && !expanded) {
      for (const [key, parallel] of nextGroups) {
        const members = parallel.clusterItems || [];
        const last = positions.get(members.at(-1));
        clusterFolded.set(key, Number.isInteger(last) && last < items.length - keepRecent
          && members.every(item => item.part.status === 'completed' && !item.element.open));
      }
    }
    items.forEach((item, index) => {
      const status = item.part.status;
      if (['running', 'streaming'].includes(status)) running++;
      if (status === 'failed') failed++;
      if (status === 'interrupted') interrupted++;
      const parallelKey = item.element.dataset.parallelGroup;
      const fold = compact && !expanded && (parallelKey ? clusterFolded.get(parallelKey) === true
        : index < items.length - keepRecent && status === 'completed' && !item.element.open);
      const parallel = parallelKey ? nextGroups.get(parallelKey) : undefined;
      const hiddenByParallel = parallel?.dataset.collapsed === 'true';
      if (item.element.hidden !== (fold || hiddenByParallel)) item.element.hidden = fold || hiddenByParallel;
      if (fold) hidden++;
    });
    for (const [key, parallel] of nextGroups) {
      const collapsedByUser = parallel.dataset.collapsed === 'true';
      const hiddenByFold = clusterFolded.get(key) === true;
      if (parallel.hidden !== (hiddenByFold && !collapsedByUser)) parallel.hidden = hiddenByFold && !collapsedByUser;
    }
    // Short completed batches with nothing folded need no header: the rows carry
    // everything. Show the summary whenever history is folded, the user expanded
    // the batch, or there is a live/error state worth surfacing.
    const showToggle = compact && (expanded || hidden > 0 || running > 0 || failed > 0 || interrupted > 0);
    if (toggle.hidden !== !showToggle) toggle.hidden = !showToggle;
    const status = failed ? 'failed' : running ? 'running' : interrupted ? 'interrupted' : 'completed';
    if (batch.dataset.status !== status) batch.dataset.status = status;
    setText(batch.summaryLabel, tr('{0} 个工具调用', items.length));
    setRaw(batch.runningChip, running ? ' · ' + tr('{0} 个运行中', running) : '');
    setRaw(batch.failedChip, failed ? ' · ' + tr('{0} 个失败', failed) : '');
    const action = expanded ? tr('收起历史') : hidden ? tr('展开 {0} 条历史', hidden) : tr('查看全部');
    setRaw(batch.action, ' · ' + action);
    const span = items.length > 1 ? batchDuration(items) : '';
    if (batch.duration.dataset.value !== span) batch.duration.dataset.value = span;
    const batchTitle = operationSummary(items, items.length) + (span ? ` · ${span}` : '');
    if (toggle.title !== batchTitle) toggle.title = batchTitle;
    if (toggle.getAttribute('aria-expanded') !== String(expanded)) toggle.setAttribute('aria-expanded', String(expanded));
    if (batch.dataset.failures !== String(failed > 0)) batch.dataset.failures = String(failed > 0);
  }
  function releaseItem(item) {
    item.released = true;
    item.pending = undefined;
    active.delete(item); clearTimeout(item.copyReset);
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
  window.UBOVMMessage = Object.freeze({ update, release, summaryScopeLabel });
})();
