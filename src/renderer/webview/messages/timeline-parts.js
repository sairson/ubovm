(() => {
  'use strict';
  const TOOL_LABELS = Object.freeze({
    search_workspace: '搜索项目代码', inventory_workspace_dependencies: '盘点工作区依赖',
    scan_workspace_secrets: '扫描疑似密钥', analyze_workspace_call_chain: '分析代码调用链', navigate_workspace_code: '代码符号导航',
    get_workspace_diagnostics: '读取代码诊断', validate_workspace_changes: '验证代码修改', recover_workspace_changes: '恢复代码修改状态',
    read_workspace_code: '读取待编辑代码', edit_workspace_file: '编辑代码', list_workspace_changes: '查看代码更改',
    wait_workers: '等待并行任务', spawn_worker: '分派并行任务', manage_workers: '调度并行任务',
    cancel_workers: '中断并行任务', list_workers: '检查协作进展', read_worker_evidence: '查看任务记录',
    read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令',
    run_python: '运行 Python 沙箱', manage_python_environment: '管理 Python 依赖', run_linux_ssh_command: '运行命令',
    upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', fetch_web_content: '读取网页', web_search: '搜索网页',
    load_skill: '加载技能', read_skills_resource: '读取技能资源', run_local_skill_script: '执行技能脚本',
    note: '更新笔记', todo: '更新任务', browser_action: '浏览器操作', read_context_evidence: '读取上下文证据',
    install_skill: '安装技能', install_mcp_server: '安装 MCP 服务',
    browser_connection_status: '检查浏览器状态', domain_inventory: '登记域名资产', learn_capability: '记录能力',
    inspect_harness: '查看运行预算', manage_harness_project: '管理任务配置', read_worker_result: '读取任务结果',
    read_workspace_change: '读取代码改动快照', preview_workspace_edits: '预览代码修改', preview_workspace_rename: '预览符号重命名',
    edit_workspace_files: '批量编辑代码', inspect_workspace_project: '检查项目配置',
    list_assist_evidence: '查看已记录证据', record_assist_evidence: '记录证据', attach_assist_evidence: '关联证据',
    list_linked_goals: '查看关联目标', create_linked_goal: '创建关联目标', ask_human: '询问用户',
    spawn_teammate: '创建团队成员', send_message: '向团队发消息', list_agents: '查看团队成员', wait_agent: '等待团队进展',
    interrupt_agent: '中断团队成员', team_task_create: '创建任务', team_task_list: '查看任务板', team_task_get: '读取任务',
    team_task_update: '更新任务', background_commands: '后台任务',
    stop_worker: '停止 Worker', start_worker: '启动 Worker', prompt_worker: '派发 Worker 提示',
    wait_worker_sleep: '等待 Worker 进展', exploration_graph: '查看探索图',
    exploration_todo: '更新探索任务', submit_decision: '提交规划决策'
  });
  const isBackgroundTool = part => Boolean(part && part.type === 'tool' && part.background === true);
  const visibleTimelineParts = parts => Array.isArray(parts) ? parts.filter(part => !isBackgroundTool(part)) : [];
  // Read-only tools return content the user does not need echoed back (file
  // reads, search results, evidence lookups). Their cards keep the operation,
  // target and status but must not render the returned body.
  const READ_ONLY_PREFIXES = Object.freeze(['read_', 'list_', 'get_', 'search_', 'inspect_']);
  const READ_ONLY_TOOLS = Object.freeze(new Set([
    'web_search', 'fetch_web_content', 'navigate_workspace_code', 'load_skill',
    'scan_workspace_secrets', 'inventory_workspace_dependencies', 'analyze_workspace_call_chain',
    // Team roster/board lookups return whole snapshots the Team panel already
    // shows; their cards stay flat and never echo the returned content.
    'list_agents', 'team_task_list', 'team_task_get', 'wait_agent'
  ]));
  // Task-board updates are flat like read-only cards: the board already carries
  // the current items, so the card only needs the operation, status and timing.
  const FLAT_TOOLS = Object.freeze(new Set(['todo']));
  const isReadOnlyTool = name => typeof name === 'string' && name.length > 0
    && (READ_ONLY_TOOLS.has(name) || READ_ONLY_PREFIXES.some(prefix => name.startsWith(prefix)));
  // Some read tools return user-facing content (search result lists, fetched
  // pages). They stay read-only semantically, but their card must be expandable
  // so the user can inspect what was actually returned.
  const EXPANDABLE_READ_TOOLS = Object.freeze(new Set(['web_search', 'fetch_web_content']));
  const isFlatToolCard = name => (isReadOnlyTool(name) && !EXPANDABLE_READ_TOOLS.has(name)) || FLAT_TOOLS.has(name);
  // Tools whose result carries a unified patch. The extension host returns the
  // exact patch in the tool result; the card can therefore show the same diff
  // DSH shows for write/edit instead of making the user read raw JSON.
  const DIFF_TOOLS = Object.freeze(new Set(['edit_workspace_file', 'edit_workspace_files', 'preview_workspace_edits']));
  const patchTotals = patch => {
    let added = 0, removed = 0;
    for (const line of String(patch || '').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
  };
  function toolDiff(part) {
    if (!part || !DIFF_TOOLS.has(part.name) || typeof part.output !== 'string' || !part.output || part.output.length > 512 * 1024) return null;
    let data;
    try { data = JSON.parse(part.output); } catch { return null; }
    let fallbackPath = '';
    try { const args = JSON.parse(part.args || '{}'); if (args && typeof args.path === 'string') fallbackPath = args.path; } catch { /* truncated args */ }
    const entries = [], seen = new Set();
    const add = item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const diff = item.diff && typeof item.diff === 'object' && !Array.isArray(item.diff) ? item.diff : {};
      const patch = [item.patch, diff.patch, item.unifiedDiff, item.unified_diff].find(value => typeof value === 'string' && value.trim());
      if (!patch) return;
      const path = typeof item.path === 'string' && item.path
        ? item.path
        : typeof item.file === 'string' && item.file ? item.file : fallbackPath;
      const key = path + '\0' + patch;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ path, patch, added: Number.isSafeInteger(diff.added) ? diff.added : null,
        removed: Number.isSafeInteger(diff.removed) ? diff.removed : null, approximate: diff.approximate === true });
    };
    if (Array.isArray(data)) data.forEach(add);
    else if (data && typeof data === 'object') {
      add(data);
      for (const key of ['results', 'completed', 'files', 'changes']) if (Array.isArray(data[key])) data[key].forEach(add);
    }
    if (!entries.length) return null;
    let added = 0, removed = 0, approximate = false;
    for (const entry of entries) {
      const counted = patchTotals(entry.patch);
      entry.added = entry.added === null ? counted.added : entry.added;
      entry.removed = entry.removed === null ? counted.removed : entry.removed;
      added += entry.added; removed += entry.removed;
      approximate = approximate || entry.approximate;
    }
    return { entries, added, removed, approximate };
  }
  const diffSummary = diff => !diff ? '' : [diff.added ? `+${diff.added}` : '', diff.removed ? `−${diff.removed}` : ''].filter(Boolean).join(' ') || (diff.entries.length ? '内容变更' : '');
  function eachToolPart(state, visit) {
    const seen = new Set();
    const walk = part => {
      if (!part || part.type !== 'tool' && part.type !== 'summary' || typeof part.name !== 'string' || !part.name) return;
      const key = part.id || part.commandId || JSON.stringify([part.name, part.status, part.background]);
      if (seen.has(key)) return;
      seen.add(key); visit(part);
    };
    for (const part of state?.execution?.parts || []) walk(part);
    for (const worker of state?.execution?.workers || []) for (const part of worker.parts || []) walk(part);
    for (const message of state?.messages || []) for (const part of message.parts || []) walk(part);
  }
  function displayActivityLabel(label) {
    if (typeof label !== 'string' || !label) return '工具调用';
    if (label === 'Reason') return '规划';
    if (TOOL_LABELS[label]) return TOOL_LABELS[label];
    if (label.startsWith('mcp_')) return 'MCP 工具';
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(label)) return '工具调用';
    return label;
  }
  function visibleActivities(activities, state) {
    const token = (label, status) => JSON.stringify([label, typeof status === 'string' ? status : '']);
    const candidates = [], remaining = new Set();
    for (const item of Array.isArray(activities) ? activities : []) {
      if (!item || typeof item.label !== 'string' || !item.label.trim() || item.label === 'skill.loaded' && item.status === 'completed') continue;
      candidates.push(item); remaining.add(token(item.label, item.status));
    }
    const backgroundNames = new Set();
    if (remaining.size) eachToolPart(state, part => {
      remaining.delete(token(part.name, part.status)); remaining.delete(token(part.name, ''));
      if (isBackgroundTool(part)) backgroundNames.add(part.name);
    });
    const visible = [];
    for (let index = candidates.length - 1; index >= 0 && visible.length < 8; index--) {
      const item = candidates[index];
      if (backgroundNames.has(item.label)) continue;
      if (remaining.has(token(item.label, item.status))) visible.push(item);
    }
    return visible.reverse();
  }
  const toolDisplayName = name => typeof name === 'string' && name ? (TOOL_LABELS[name] || name) : '';
  const api = { TOOL_LABELS, toolDisplayName, isBackgroundTool, isReadOnlyTool, isFlatToolCard, visibleTimelineParts, visibleActivities, displayActivityLabel, eachToolPart, toolDiff, diffSummary };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.UBOVMTimeline = api;
})();
