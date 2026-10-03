'use strict';

const modelPresets = require('./model-presets.cjs');
const defaultValues = { ...modelPresets.openai, inherit: true, enabled: true, thinkingLevel: 'off', maxIntents: 5, openIntents: 5, maxConcurrency: 3, maxRounds: 20, maxRepairs: 1, maxResponseBytes: 32768,
  maxModelCalls: 0, maxToolCalls: 0, maxPlanSteps: 8, maxCheckpointBytes: 16777216, maxToolResultBytes: 262144,
  connectTimeoutMs: 20000, callTimeoutMs: 60000, maxResultBytes: 262144, maxSkills: 160, maxSkillBytes: 262144, maxTotalBytes: 4194304, maxFiles: 256, maxWorkers: 10000,
  known_hosts_file: '' };
const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, default: defaultValues[key] ?? (type === 'checkbox' ? false : ['lines', 'checklist', 'servers'].includes(type) ? [] : type === 'json' ? {} : ''), ...extra });
const modelFields = [f('provider', '服务商', 'select', { options: Object.keys(modelPresets), labels: Object.fromEntries(Object.entries(modelPresets).map(([key, value]) => [key, value.label])), allowCustom: true }), f('modelId', '模型名称'),
  f('api', 'API 协议', 'select', { options: ['', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses', 'google-vertex', 'mistral-conversations', 'bedrock-converse-stream', 'pi-messages', 'openai-codex-responses'] }),
  f('baseUrl', 'API 地址', 'text', { placeholder: '自定义服务需要填写实际 API 地址' }), f('apiKey', 'API Key', 'secret'),
  f('contextWindow', '上下文窗口', 'number'), f('maxTokens', '最大输出 Token', 'number'), f('reasoning', '支持推理', 'checkbox'),
  f('input', '支持的输入类型', 'checklist', { options: ['text', 'image'], default: ['text'] }), f('compat', '兼容性参数', 'json'), f('streamOptions', '请求与采样参数', 'json')];
const thinking = f('thinkingLevel', '思考级别', 'select', { options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });
const tools = ['delivery_workflow', 'todo', 'note', 'fetch_web_content', 'web_search', 'browser_action', 'browser_connection_status', 'read_skills_resource', 'run_local_skill_script', 'run_linux_ssh_command', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service'];
const sections = {
  python: { title: 'Python 执行', description: 'AI 使用本地 Python 沙箱，无需 Docker。Windows 启动时自动准备沙箱，首次调用会等待准备完成；首次初始化可能出现管理员授权提示。取消或失败后，可运行“UBOVM: 初始化 Python 沙箱”重试。解释器留空优先使用随 IDE 打包的 Python，无需系统安装 Python；AI 可用依赖管理工具通过 pip/uv 创建项目独立环境；下载 PyPI 包需在下方允许 pypi.org 和 files.pythonhosted.org。Windows 后端仍为 Alpha，系统 DNS 查询不受网络白名单约束。', fields: [
    f('executable', 'Python 解释器绝对路径', 'text', { placeholder: '例如 C:\\Python312\\python.exe 或项目 .venv 中的 Python' }),
    f('allowedDomains', '允许联网的域名（每行一个）', 'lines', { default: [] }),
    f('allowWorkspaceWrite', '允许修改项目文件（不生成 IDE 修改快照）', 'checkbox', { default: false }),
    f('defaultTimeoutSeconds', '默认超时（秒）', 'number', { default: 120, max: 3600 }),
    f('maxTimeoutSeconds', '超时上限（秒）', 'number', { default: 600, max: 3600 }),
    f('maxOutputBytes', '输出字节上限', 'number', { default: 1048576, min: 1024, max: 10485760 })] },
  model: { title: '模型连接', description: '先连接一个默认模型即可开始。需要分工时，再为其他角色选择模型。', fields: modelFields },
  reasonModel: { title: '思考Agent模型', description: '规划与分析使用的模型；继承时使用默认模型。', fields: [f('inherit', '继承默认模型', 'checkbox'), ...modelFields] },
  workerModel: { title: '执行Agent模型', description: '执行任务使用的模型；继承时使用默认模型。', fields: [f('inherit', '继承默认模型', 'checkbox'), ...modelFields] },
  summaryModel: { title: '摘要模型', description: '压缩上下文使用的模型；继承时使用思考 Agent 模型。', fields: [f('inherit', '继承思考 Agent 模型', 'checkbox'), ...modelFields] },
  ssh: { title: 'SSH 连接', description: '管理远程主机，选择一台作为默认连接。运行任务前需保存有效的默认连接；新终端和 SSH 工具将在保存后使用这些配置。', fields: [] },
  web: { title: '浏览器与搜索', description: '管理 Agent 的网页浏览能力与网络搜索服务。', fields: [f('headless', '无头模式（隐藏浏览器窗口）', 'checkbox', { default: true }), f('apiKey', 'Tavily API Key', 'secret'),
    f('baseURL', 'Tavily 服务地址', 'text', { default: 'https://api.tavily.com' }), f('searchDepth', '搜索深度', 'select', { options: ['basic', 'advanced', 'fast', 'ultra-fast'], labels: { basic: '基础', advanced: '深入', fast: '快速', 'ultra-fast': '极速' }, default: 'basic' }),
    f('topic', '搜索主题', 'select', { options: ['general', 'news', 'finance'], labels: { general: '通用', news: '新闻', finance: '财经' }, default: 'general' }), f('includeAnswer', '包含搜索摘要', 'checkbox'), f('projectID', 'Tavily 项目 ID'),
    f('fallbackToPublicProviders', '允许公共搜索回退', 'checkbox', { default: true }), f('timeoutMs', '请求超时（毫秒）', 'number', { default: 15000 }), f('providerRetryAttempts', '重试次数', 'number', { default: 3, max: 5 })] },
  summary: { title: '上下文摘要', description: '长对话达到阈值后压缩历史上下文，保留最近消息；摘要模型在「模型连接」中单独设置。', fields: [f('enabled', '启用上下文摘要', 'checkbox', { default: true }),
    ...Object.entries({ triggerTokens: ['触发 Token 数', 49152], targetTokens: ['压缩后的目标 Token 数', 24576], triggerMessages: ['触发消息数', 60], keepRecentMessages: ['保留最近消息数', 8], maxSummaryTokens: ['单次摘要最大 Token', 1024], maxSummaryInputTokens: ['单次摘要输入 Token', 12000], maxSummaryCalls: ['单轮摘要次数上限', 16], maxSummaryCallsPerScope: ['每个作用域摘要次数上限', 64], timeoutMs: ['摘要超时（毫秒）', 30000] }).map(([key, [label, value]]) => f(key, label, 'number', { default: value }))] },
  reason: { title: '思考Agent', description: '控制思考Agent的任务规划预算、探索深度和系统提示词。', fields: [
    thinking,
    f('openIntents', '开放意图上限（pending+running）', 'number', { min: 1, max: 20 }),
    f('maxIntents', '每轮新增意图上限（不超过开放意图上限）', 'number', { min: 1, max: 20 }),
    f('maxConcurrency', '并行 Worker 数（不超过开放意图上限）', 'number', { min: 1, max: 10 }),
    f('maxRounds', 'Reason 规划轮次上限', 'number', { min: 1, max: 100 }),
    f('maxRepairs', '协议修复次数', 'number', { min: 0, max: 4 }),
    f('maxResponseBytes', '响应字节上限', 'number'),
    f('systemPrompt', '自定义系统提示词', 'textarea')
  ] },
  worker: { title: '执行Agent', description: '人工审核仅用于协助模式（含子 Worker），保存后从下一轮对话生效。其他预算适用于执行Agent。', fields: [f('requireToolApproval', '协助模式默认使用人工审核（输入框可切换）', 'checkbox', { default: true }), thinking, ...[['maxModelCalls', '模型调用上限（0 为不限）'], ['maxToolCalls', '工具调用上限（0 为不限）'], ['maxPlanSteps', '计划步骤上限'], ['maxResponseBytes', '响应字节上限'], ['maxCheckpointBytes', '检查点字节上限'], ['maxToolResultBytes', '工具结果字节上限']].map(([key, label]) => f(key, label, 'number', key === 'maxResponseBytes' ? { default: 24576 } : ['maxModelCalls', 'maxToolCalls'].includes(key) ? { min: 0 } : {})), f('systemPrompt', '自定义系统提示词', 'textarea', { placeholder: '留空使用内置执行提示词' })] },
  mcp: { title: 'MCP 服务', description: '连接外部工具与数据源，扩展 Agent 的能力。', fields: [f('servers', '服务器列表', 'servers', { default: [] }),
    f('credentials', '请求头 / 环境变量（按服务器名称填写 JSON）', 'secret', { placeholder: '{"local":{"env":{"TOKEN":"…"}},"remote":{"headers":{"Authorization":"Bearer …"}}}' }),
    f('connectTimeoutMs', '连接超时（毫秒）', 'number'), f('callTimeoutMs', '调用超时（毫秒）', 'number'), f('maxResultBytes', '结果字节上限', 'number')] },
  skills: { title: 'Skills', description: '为 Agent 提供可复用的指令与能力，运行时按需加载。', fields: [...[['maxSkills', '技能数量上限'], ['maxSkillBytes', '单个技能字节上限'], ['maxTotalBytes', '总读取字节上限'], ['maxFiles', '文件数量上限'], ['maxWorkers', 'Worker 状态数量上限']].map(([key, label]) => f(key, label, 'number'))] },
};
const sshFields = [f('id', '连接标识'), f('name', '显示名称'), f('host', '主机地址'), f('port', '端口', 'number', { default: 22, max: 65535 }), f('username', '用户名'),
  f('password', '登录密码', 'secret'), f('private_key_file', '私钥文件路径', 'text', { placeholder: '~/.ssh/id_ed25519' }), f('private_key_passphrase', '私钥口令', 'secret'),
  f('known_hosts_file', 'known_hosts 文件（可选）', 'text', { placeholder: '留空可跳过；也可填写 ~/.ssh/known_hosts' }), f('host_key_sha256', '主机 SHA256 指纹（可选）'),
  f('connect_timeout_seconds', '连接超时（秒）', 'number', { default: 10, max: 300 }), f('default_command_timeout_seconds', '命令超时（秒）', 'number', { default: 120, max: 86400 }), f('max_command_timeout_seconds', '命令超时上限（秒）', 'number', { default: 1800, max: 86400 })];
const mcpFields = [f('name', '服务名称'), f('transport', '传输协议', 'select', { default: 'stdio', options: ['stdio', 'streamable_http', 'sse'], labels: { stdio: '标准输入输出（stdio）', streamable_http: 'Streamable HTTP', sse: 'Server-Sent Events（SSE）' } }),
  f('enabled', '启用服务', 'checkbox'), f('required', '连接失败时中止运行', 'checkbox', { default: true }), f('command', '启动命令', 'text', { default: 'node' }), f('args', '启动参数（每行一个）', 'lines'), f('cwd', '工作目录'), f('url', '服务地址', 'text', { placeholder: 'https://your-server.example/mcp' }), f('tools', '允许的工具（留空表示全部）', 'lines'), f('toolNamePrefix', '工具名称前缀')];
sections.worker.fields.unshift(f('swarmBackendSelection', 'Swarm 模型选择模式', 'select', {
  default: 'fixed', options: ['fixed', 'autonomous'], labels: { fixed: '固定执行 Agent 模型', autonomous: 'Agent 从配置库自主选择模型' }
}));
sections.worker.description += ' Swarm 负责把任务交给多个子 Agent。固定模式使用执行 Agent 模型；自主选择模式允许子任务选择已配置的 Pi 模型。';
module.exports = { sections, sshFields, mcpFields, modelPresets, tools };
