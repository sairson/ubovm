'use strict';

const modelPresets = require('./model-presets.cjs');
const defaultValues = { ...modelPresets.custom, inherit: true, enabled: true, thinkingLevel: 'off', maxIntents: 5, openIntents: 5, maxConcurrency: 3, maxRounds: 0, maxRepairs: 1, maxResponseBytes: 32768,
  maxModelCalls: 0, maxToolCalls: 0, maxPlanSteps: 8, maxCheckpointBytes: 16777216, maxToolResultBytes: 262144,
  connectTimeoutMs: 20000, callTimeoutMs: 60000, maxResultBytes: 262144, maxSkills: 160, maxSkillBytes: 262144, maxTotalBytes: 4194304, maxFiles: 256, maxWorkers: 10000,
  known_hosts_file: '' };
const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, default: defaultValues[key] ?? (type === 'checkbox' ? false : ['lines', 'checklist', 'servers'].includes(type) ? [] : type === 'json' ? {} : ''), ...extra });
const modelFields = [f('provider', '服务商', 'select', { options: Object.keys(modelPresets), labels: Object.fromEntries(Object.entries(modelPresets).map(([key, value]) => [key, value.label])), allowCustom: true }), f('modelId', '默认模型'), f('models', '可选模型（每行一个）', 'lines', { default: [] }),
  f('api', 'API 协议', 'select', { options: ['', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses', 'google-vertex', 'mistral-conversations', 'bedrock-converse-stream', 'pi-messages', 'openai-codex-responses'] }),
  f('baseUrl', 'API 地址', 'text', { placeholder: '自定义服务需要填写实际 API 地址' }), f('apiKey', 'API Key', 'secret'),
  f('contextWindow', '上下文窗口', 'number'), f('maxTokens', '最大输出 Token', 'number'), f('reasoning', '支持推理', 'checkbox'),
  f('input', '支持的输入类型', 'checklist', { options: ['text', 'image'], labels: { text: '文本', image: '图片' }, default: ['text'] }), f('compat', '兼容性参数', 'json'), f('streamOptions', '请求与采样参数', 'json')];
const thinking = f('thinkingLevel', '思考级别', 'select', { options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], labels: { '': '跟随模型默认', off: '关闭', minimal: '最低', low: '较低', medium: '中等', high: '较高', xhigh: '很高', max: '最高' } });
// Every autonomous built-in the desktop exposes. This must keep parity with
// INTERNAL_TOOL_NAMES in harness/intools/runtime.mjs (minus learn_capability,
// which stays a back-channel): the host force-assigns this list to
// intools.allowedTools, so a name missing here is silently unreachable even
// when the prompts and bundled skills instruct the agent to call it. Host
// interaction tools (ask_human) are intentionally absent: the assist path adds
// them only when a human-facing hook is wired, and goal sessions never do.
const tools = ['delivery_workflow', 'todo', 'note', 'domain_inventory', 'fetch_web_content', 'web_search', 'browser_action', 'browser_connection_status', 'read_skills_resource', 'run_local_skill_script', 'run_linux_ssh_command', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service', 'background_commands'];
const sections = {
  python: { title: 'Python 执行', description: '对话可在本地沙箱里运行 Python，无需 Docker。默认允许联网和访问/修改所有已打开工作区；凭据目录仍受保护。解释器留空时使用随 IDE 打包的 Python。首次准备沙箱时，Windows 可能弹出授权提示。', fields: [
    f('executable', 'Python 解释器绝对路径', 'text', { placeholder: '例如 C:\\Python312\\python.exe 或项目 .venv 中的 Python' }),
    f('allowedDomains', '允许联网的域名（每行一个，* 表示任意主机）', 'lines', { default: ['*'] }),
    f('allowWorkspaceWrite', '允许修改已打开工作区文件（不生成 IDE 修改快照）', 'checkbox', { default: true }),
    f('defaultTimeoutSeconds', '默认超时（秒）', 'number', { default: 120, max: 3600 }),
    f('maxTimeoutSeconds', '超时上限（秒）', 'number', { default: 600, max: 3600 }),
    f('maxOutputBytes', '输出字节上限', 'number', { default: 1048576, min: 1024, max: 10485760 })] },
  model: { title: '模型连接', description: '默认预置 DeepSeek（deepseek-flash 与 deepseek-v4-pro）；思考级别按模型实际支持范围收敛，思考请求会忽略 temperature 等采样参数，上下文缓存自动复用。选择其他服务商会填入对应地址与能力，完成连接测试后再分配模型。', fields: modelFields },
  reasonModel: { title: '规划模型', description: '规划与分析使用的模型；打开继承时跟随默认模型。', fields: [f('inherit', '继承默认模型', 'checkbox'), ...modelFields] },
  workerModel: { title: '任务模型', description: '执行任务使用的模型；打开继承时跟随默认模型。', fields: [f('inherit', '继承默认模型', 'checkbox'), ...modelFields] },
  summaryModel: { title: '摘要模型', description: '压缩长对话使用的模型；打开继承时跟随规划模型。', fields: [f('inherit', '继承规划模型', 'checkbox'), ...modelFields] },
  ssh: { title: 'SSH 连接', description: '添加远程主机，并指定一台默认连接。保存后，终端和远程命令都会使用这套配置。', fields: [] },
  web: { title: '浏览器与搜索', description: '在 IDE 里查看网页，并可选配置搜索服务。对话操作网页时页面只读；关闭内嵌后可改用独立浏览器。', fields: [
    f('ideBrowser', '使用 IDE 内嵌浏览器', 'checkbox', { default: true }),
    f('headless', '无头模式（隐藏独立浏览器窗口）', 'checkbox', { default: true }),
    f('apiKey', 'Tavily API Key', 'secret'),
    f('baseURL', 'Tavily 服务地址', 'text', { default: 'https://api.tavily.com' }), f('searchDepth', '搜索深度', 'select', { options: ['basic', 'advanced', 'fast', 'ultra-fast'], labels: { basic: '基础', advanced: '深入', fast: '快速', 'ultra-fast': '极速' }, default: 'basic' }),
    f('topic', '搜索主题', 'select', { options: ['general', 'news', 'finance'], labels: { general: '通用', news: '新闻', finance: '财经' }, default: 'general' }), f('includeAnswer', '包含搜索摘要', 'checkbox'), f('projectID', 'Tavily 项目 ID'),
    f('fallbackToPublicProviders', '允许公共搜索回退', 'checkbox', { default: true }), f('timeoutMs', '请求超时（毫秒）', 'number', { default: 15000 }), f('providerRetryAttempts', '重试次数', 'number', { default: 3, max: 5 })] },
  summary: { title: '上下文摘要', description: '正文摘要与工具摘要分开：对话正文压缩为「进度检查点」（用户目标、决策、待办、失败与不确定），工具结果压缩为「工具摘要」（观测值、成功/失败、精确引用、未验证项），二者使用不同的提示词、输出预算与调用上限，互不抢占额度。压缩阈值按当前模型上下文窗口的可用比例计算：已知窗口时按「触发窗口占比」触发，窗口越大压缩越晚（例如 1M 上下文的模型会在接近上限时才触发，而不再固定在 96K）；窗口未知时回退到「触发 Token 数」。消息数量阈值会随窗口放大（大窗口更晚按消息数压缩），且一次压缩后只有再次明显增长才重新触发，避免同一段历史被反复摘要。压缩失败时不再回填原文，而是标记不可用并保留可恢复 artifact。摘要模型在「模型连接」中单独设置。', fields: [f('enabled', '启用上下文摘要', 'checkbox', { default: true }),
    f('triggerPercent', '触发窗口占比（%）', 'number', { default: 90, min: 50, max: 99 }),
    ...Object.entries({ triggerTokens: ['触发 Token 数', 49152], targetTokens: ['压缩后的目标 Token 数', 24576], triggerMessages: ['触发消息数', 60], keepRecentMessages: ['保留最近消息数', 8], maxSummaryTokens: ['正文摘要单次最大 Token', 4096], toolSummaryTokens: ['工具摘要单次最大 Token', 1024], maxSummaryInputTokens: ['单次摘要输入 Token', 12000], maxSummaryCalls: ['正文摘要单轮次数上限', 16], maxToolSummaryCalls: ['工具摘要单轮次数上限', 16], maxSummaryCallsPerTransform: ['单轮摘要分段次数上限', 8], maxSummaryCallsPerScope: ['每个作用域摘要次数上限', 64], earlyCompactRatio: ['提前压缩倍数', 2], timeoutMs: ['摘要超时（毫秒）', 30000] }).map(([key, [label, value]]) => f(key, label, 'number', { default: value }))] },
  reason: { title: '规划设置', description: '控制同时进行的任务数量、规划轮次，以及思考深度。字节上限和协议修复收在「预算与提示词」里。', fields: [
    f('thinkingLevel', '思考级别', 'select', { options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], labels: { '': '跟随模型默认', off: '关闭', minimal: '最低', low: '较低', medium: '中等', high: '较高', xhigh: '很高', max: '最高' }, default: 'medium' }),
    f('openIntents', '同时进行的任务上限（排队+执行中）', 'number', { min: 1, max: 20 }),
    f('maxIntents', '每轮新增任务上限（不超过同时进行上限）', 'number', { min: 1, max: 20 }),
    f('maxConcurrency', '并行任务数（不超过同时进行上限）', 'number', { min: 1, max: 10 }),
    f('maxRounds', '规划轮次上限（0 为不限）', 'number', { min: 0, max: 10000 }),
    f('maxRepairs', '协议修复次数', 'number', { min: 0, max: 4 }),
    f('maxResponseBytes', '响应字节上限', 'number'),
    f('systemPrompt', '自定义系统提示词', 'textarea')
  ] },
  worker: { title: '任务执行', description: '协助模式可默认打开人工审核，输入框仍可随时切换。调用次数、字节上限和提示词收在「预算与提示词」里。', fields: [f('requireToolApproval', '协助模式默认使用人工审核（输入框可切换）', 'checkbox', { default: true }), thinking, ...[['maxModelCalls', '模型调用上限（0 为不限）'], ['maxToolCalls', '工具调用上限（0 为不限）'], ['maxPlanSteps', '计划步骤上限'], ['maxResponseBytes', '响应字节上限'], ['maxCheckpointBytes', '检查点字节上限'], ['maxToolResultBytes', '工具结果字节上限']].map(([key, label]) => f(key, label, 'number', key === 'maxResponseBytes' ? { default: 24576 } : ['maxModelCalls', 'maxToolCalls'].includes(key) ? { min: 0 } : {})), f('systemPrompt', '自定义系统提示词', 'textarea', { placeholder: '留空使用内置执行提示词' })] },
  mcp: { title: 'MCP 服务', description: '连接外部工具与数据源，扩展对话能调用的能力。未启用的服务不会出现在工具列表里。', fields: [f('servers', '服务器列表', 'servers', { default: [] }),
    f('credentials', '请求头 / 环境变量（按服务器名称填写 JSON）', 'secret', { placeholder: '{"local":{"env":{"TOKEN":"…"}},"remote":{"headers":{"Authorization":"Bearer …"}}}' }),
    f('connectTimeoutMs', '连接超时（毫秒）', 'number'), f('callTimeoutMs', '调用超时（毫秒）', 'number'), f('maxResultBytes', '结果字节上限', 'number')] },
  skills: { title: 'Skills', description: '已安装的技能会按需加载，不占用每次对话的固定上下文。下方限制只在技能很多时才需要改。', fields: [...[['maxSkills', '技能数量上限'], ['maxSkillBytes', '单个技能字节上限'], ['maxTotalBytes', '总读取字节上限'], ['maxFiles', '文件数量上限'], ['maxWorkers', '并行任务状态数量上限']].map(([key, label]) => f(key, label, 'number'))] },
};
const sshFields = [f('id', '连接标识'), f('name', '显示名称'), f('host', '主机地址'), f('port', '端口', 'number', { default: 22, max: 65535 }), f('username', '用户名'),
  f('password', '登录密码', 'secret'), f('private_key_file', '私钥文件路径', 'text', { placeholder: '~/.ssh/id_ed25519' }), f('private_key_passphrase', '私钥口令', 'secret'),
  f('known_hosts_file', 'known_hosts 文件（可选）', 'text', { placeholder: '留空可跳过；也可填写 ~/.ssh/known_hosts' }), f('host_key_sha256', '主机 SHA256 指纹（可选）'),
  f('connect_timeout_seconds', '连接超时（秒）', 'number', { default: 10, max: 300 }), f('default_command_timeout_seconds', '命令超时（秒）', 'number', { default: 120, max: 86400 }), f('max_command_timeout_seconds', '命令超时上限（秒）', 'number', { default: 1800, max: 86400 })];
const mcpFields = [f('name', '服务名称'), f('transport', '传输协议', 'select', { default: 'stdio', options: ['stdio', 'streamable_http', 'sse'], labels: { stdio: '标准输入输出（stdio）', streamable_http: 'Streamable HTTP', sse: 'Server-Sent Events（SSE）' } }),
  f('enabled', '启用服务', 'checkbox'), f('required', '连接失败时中止运行', 'checkbox', { default: true }), f('command', '启动命令', 'text', { default: 'node' }), f('args', '启动参数（每行一个）', 'lines'), f('cwd', '工作目录'), f('url', '服务地址', 'text', { placeholder: 'https://your-server.example/mcp' }), f('tools', '允许的工具（留空表示全部）', 'lines'), f('toolNamePrefix', '工具名称前缀')];
sections.worker.fields.unshift(f('swarmBackendSelection', '并行任务模型选择', 'select', {
  default: 'fixed', options: ['fixed', 'autonomous'], labels: { fixed: '固定任务模型', autonomous: '从配置库自主选择模型' }
}));
sections.worker.description += ' 并行任务模型选择在「模型连接 → 角色使用」中配置：固定模式统一用任务模型，自主选择则允许子任务使用已配置的模型。';
module.exports = { sections, sshFields, mcpFields, modelPresets, tools };
