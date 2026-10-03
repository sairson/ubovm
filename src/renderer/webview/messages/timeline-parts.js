(() => {
  'use strict';
  const TOOL_LABELS = Object.freeze({
    delivery_workflow: '交付闭环', search_workspace: '搜索项目代码', inventory_workspace_dependencies: '盘点工作区依赖',
    scan_workspace_secrets: '扫描疑似密钥', analyze_workspace_call_chain: '分析代码调用链', navigate_workspace_code: '代码符号导航',
    get_workspace_diagnostics: '读取代码诊断', validate_workspace_changes: '验证代码修改', recover_workspace_changes: '恢复代码修改状态',
    read_workspace_code: '读取待编辑代码', edit_workspace_file: '编辑代码', list_workspace_changes: '查看代码更改',
    wait_workers: '等待并行任务', spawn_worker: '分派并行任务', manage_workers: '调度并行任务',
    cancel_workers: '中断并行任务', list_workers: '检查协作进展', read_worker_evidence: '查看任务记录',
    read_workspace_file: '读取文件', list_workspace_files: '查看目录', run_local_shell_command: '运行本地命令',
    run_python: '运行 Python 沙箱', manage_python_environment: '管理 Python 依赖', run_linux_ssh_command: '运行命令',
    upload_sftp: 'SFTP 上传', deploy_remote_service: '部署远程服务', fetch_web_content: '读取网页', web_search: '搜索网页',
    load_skill: '加载技能', read_skills_resource: '读取技能资源', run_local_skill_script: '执行技能脚本',
    note: '更新笔记', todo: '更新任务', browser_action: '浏览器操作', read_context_evidence: '读取上下文证据'
  });
  const isBackgroundTool = part => Boolean(part && part.type === 'tool' && part.background === true);
  const visibleTimelineParts = parts => Array.isArray(parts) ? parts.filter(part => !isBackgroundTool(part)) : [];
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
  const api = { TOOL_LABELS, isBackgroundTool, visibleTimelineParts, visibleActivities, displayActivityLabel, eachToolPart };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.UBOVMTimeline = api;
})();
