'use strict';

const { createHash } = require('node:crypto');
const copy = value => value === undefined ? undefined : structuredClone(value);
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses', 'google-vertex', 'mistral-conversations', 'bedrock-converse-stream', 'pi-messages', 'openai-codex-responses'];
const MODEL_KEYS = new Set(['backend', 'provider', 'modelId', 'api', 'baseUrl', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'compat', 'streamOptions']);
const configurationStates = new WeakMap();
// Both configuration entry points share a transaction queue and revision. A
// credential-only update must invalidate an already open settings form too.
function configurationState(context) {
  let state = configurationStates.get(context);
  if (!state) {
    state = { generation: 0, queue: Promise.resolve(), run(operation) {
      const pending = this.queue.then(operation);
      this.queue = pending.catch(() => {});
      return pending;
    } };
    configurationStates.set(context, state);
    const subscription = context.secrets.onDidChange?.(event => {
      if (event.key.startsWith('ubovm.')) state.generation++;
    });
    if (subscription) context.subscriptions?.push(subscription);
  }
  return state;
}
async function updateConfiguration(vscode, context, changes, secrets) {
  const configuration = () => vscode.workspace.getConfiguration('ubovm');
  const backups = new Map(), applied = [];
  try {
    for (const [key, value] of secrets) {
      backups.set(key, await context.secrets.get(key));
      if (value === undefined) await context.secrets.delete(key); else await context.secrets.store(key, value);
    }
    for (const [name, value] of changes) {
      applied.push([name, copy(configuration().inspect(name)?.globalValue)]);
      await configuration().update(name, value, vscode.ConfigurationTarget.Global);
    }
  } catch {
    let failed = false;
    for (const [name, value] of applied.reverse()) try { await configuration().update(name, value, vscode.ConfigurationTarget.Global); } catch { failed = true; }
    for (const [key, value] of backups) try { if (value === undefined) await context.secrets.delete(key); else await context.secrets.store(key, value); } catch { failed = true; }
    throw new Error(failed ? '保存失败，部分配置未能恢复，请重新载入检查。' : '保存失败，已恢复原配置。请检查本机设置与凭据库是否可写。');
  } finally { configurationState(context).generation++; }
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} 必须是配置对象。`);
  return value;
}
function modelConfig(value) {
  object(value, '模型');
  const model = copy(value);
  const backend = model.backend ?? 'pi';
  if (!['pi', 'claude', 'codex'].includes(backend)) throw new Error('仅支持 Pi Agent。');
  if (backend !== 'pi') {
    if (backend === 'claude' && typeof model.modelId === 'string') model.modelId = model.modelId.replace(/\[1m\]$/i, '');
    const provider = model.provider || (backend === 'claude' ? 'anthropic' : 'openai'), api = backend === 'claude' ? 'anthropic-messages' : 'openai-responses';
    model.provider = provider; model.api ??= api;
    model.baseUrl ||= backend === 'codex'
      ? new Map([['openai', 'https://api.openai.com/v1'], ['deepseek', 'https://api.deepseek.com'], ['openrouter', 'https://openrouter.ai/api/v1']]).get(provider)
      : provider === 'deepseek' ? 'https://api.deepseek.com/anthropic' : provider === 'anthropic' ? 'https://api.anthropic.com' : undefined;
    if (!model.baseUrl) throw new Error(`自定义 ${backend} SDK 服务商需要填写 ${api} 兼容 API 地址。`);

  }
  model.backend = 'pi';
  for (const key of Object.keys(model)) if (!MODEL_KEYS.has(key)) throw new Error(`不支持模型配置 ${key}；API Key 请通过“配置模型”保存在凭据库中。`);
  for (const key of ['provider', 'modelId']) if (typeof model[key] !== 'string' || !model[key].trim()) throw new Error('请先配置模型的服务商和模型名称。');
  model.provider = model.provider.trim(); model.modelId = model.modelId.trim();
  if (model.api !== undefined && !APIS.includes(model.api)) throw new Error('模型协议不受支持。');
  if (model.api !== undefined && model.baseUrl === undefined) throw new Error('自定义模型协议必须配置 API 地址。');
  if (model.baseUrl !== undefined) {
    let url; try { url = new URL(model.baseUrl); } catch { throw new Error('模型地址必须是完整的 HTTP 或 HTTPS URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('模型地址不能包含用户名、密码或 URL 片段。');
    if (!model.api) throw new Error('自定义模型地址必须配置协议。');
  }
  for (const key of ['contextWindow', 'maxTokens']) if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] < 1)) throw new Error(`${key} 必须为正整数。`);
  if (model.contextWindow !== undefined && model.maxTokens !== undefined && model.maxTokens > model.contextWindow) throw new Error('最大输出 Token 不能超过上下文窗口。');
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') throw new Error('reasoning 必须为布尔值。');
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length || new Set(model.input).size !== model.input.length || model.input.some(value => !['text', 'image'].includes(value)))) throw new Error('模型输入类型必须包含 text 或 image，且不能重复。');
  for (const key of ['compat', 'streamOptions']) if (model[key] !== undefined) object(model[key], key);
  return model;
}
function keyFor(model) {
  return 'ubovm.model.key.' + createHash('sha256').update(JSON.stringify([model.provider, model.baseUrl ?? 'catalog'])).digest('hex');
}

/** Machine settings and SecretStorage remain in the extension host. */
function createModelConfiguration(vscode, context) {
  const state = configurationState(context);
  function setting(name, fallback) {
    const entry = vscode.workspace.getConfiguration('ubovm').inspect(name);
    // Workspace JSON must not replace endpoints, credentials or MCP commands.
    return copy(entry?.globalValue ?? entry?.defaultValue ?? fallback);
  }
  function status() {
    try {
      const model = modelConfig(setting('model', {}));
      return { connected: true, configured: true, label: `${model.backend ?? 'pi'} · ${model.modelId} · 已配置`, provider: model.provider, backend: model.backend ?? 'pi' };
    } catch (error) { return { connected: false, configured: false, label: '配置模型', error: error.message }; }
  }
  async function credentialModel(value) {
    const model = modelConfig(value);
    const key = await context.secrets.get(keyFor(model));
    return { ...model, ...(key ? { apiKey: key } : {}) };
  }
  async function read() {
    const result = { model: await credentialModel(setting('model', {})) };
    const backendSelection = setting('worker', {}).swarmBackendSelection ?? 'fixed';
    if (!['fixed', 'autonomous'].includes(backendSelection)) throw new Error('并行任务模型选择模式无效。');
    const library = backendSelection === 'autonomous' ? setting('modelProfiles', []) : [];
    if (!Array.isArray(library) || library.length > 30) throw new Error('模型配置库格式无效。');
    result.collaboration = { backendSelection, models: {} };
    for (const profile of library) {
      if (!profile || typeof profile.id !== 'string' || !/^[\w.-]{1,80}$/.test(profile.id)
        || Object.hasOwn(result.collaboration.models, `saved.${profile.id}`)) throw new Error('协作模型配置标识无效或重复。');
      Object.defineProperty(result.collaboration.models, `saved.${profile.id}`, { value: await credentialModel(profile.model), enumerable: true });
    }
    for (const role of ['reason', 'worker']) {
      const value = object(setting(role, {}), role);
      result[role] = { ...value, ...(value.model ? { model: await credentialModel(value.model) } : {}) };
      if (role === 'worker') delete result.worker.swarmBackendSelection;
    }
    const reason = result.reason;
    const openIntents = Number.isSafeInteger(reason.openIntents) ? reason.openIntents : 5;
    const maxConcurrency = Number.isSafeInteger(reason.maxConcurrency) ? reason.maxConcurrency : 3;
    const maxRounds = Number.isSafeInteger(reason.maxRounds) ? reason.maxRounds : 0;
    const maxIntents = Number.isSafeInteger(reason.maxIntents) ? reason.maxIntents : 5;
    for (const [name, value, min, max] of [
      ['openIntents', openIntents, 1, 20],
      ['maxConcurrency', maxConcurrency, 1, 10],
      ['maxRounds', maxRounds, 0, 10000],
      ['maxIntents', maxIntents, 1, 20]
    ]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min} 至 ${max} 之间。`);
    }
    if (maxConcurrency > openIntents) throw new Error('并行任务数不能超过同时进行上限。');
    if (maxIntents > openIntents) throw new Error('每轮新增任务上限不能超过同时进行上限。');
    result.openIntents = openIntents;
    result.maxConcurrency = maxConcurrency;
    result.maxRounds = maxRounds;
    result.reason = { ...reason, openIntents, maxIntents };
    // Planning log needs Reason thinking by default; workers stay opt-in.
    if (result.reason.thinkingLevel === undefined) result.reason.thinkingLevel = 'medium';
    delete result.reason.maxConcurrency;
    delete result.reason.maxRounds;
    result.contextSummary = setting('summaryEnabled', true) === false ? false : setting('contextSummary', true);
    if (result.contextSummary && typeof result.contextSummary === 'object' && result.contextSummary.model) {
      result.contextSummary.model = await credentialModel(result.contextSummary.model);
    }
    for (const name of ['mcp', 'skills', 'intools']) {
      const value = setting(name, undefined);
      if (value !== undefined) result[name] = value;
    }
    // The desktop product always exposes its built-in tools. Old allowlists and
    // switches must not silently disable them after upgrading the UI.
    const intools = result.intools && typeof result.intools === 'object' ? result.intools : {};
    result.intools = { ...intools, allowedTools: [...require('./settings-schema.cjs').tools] };
    for (const name of ['browser', 'webSearch', 'fetchContent', 'skillResource', 'skillScript', 'python']) {
      if (result.intools[name] === false || result.intools[name] === undefined) result.intools[name] = {};
    }
    await require('./settings-config.cjs').hydrateRuntime(result, context);
    return result;
  }
  async function apply(input) {
    object(input, '模型');
    const { apiKey, ...raw } = input;
    const model = modelConfig(raw);
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error('API Key 必须是字符串。');
    return state.run(async () => {
      await updateConfiguration(vscode, context, new Map([['model', model]]), new Map(apiKey === undefined ? [] : [[keyFor(model), apiKey.trim() || undefined]]));
      return status();
    });
  }
  async function configure(input) {
    if (input !== undefined) return apply(input);
    const current = setting('model', {});
    const choice = await vscode.window.showQuickPick([
      { label: '配置模型', description: '服务商、模型名称、地址与 API Key', action: 'model' },
      { label: '更新 API Key', description: '保存在系统凭据库中', action: 'key' },
      { label: '清除 API Key', description: '删除当前模型端点的凭据', action: 'clear' },
      { label: '高级设置', description: '规划、任务执行、MCP、Skills 和摘要', action: 'advanced' },
    ], { title: 'UBOVM 模型与工具' });
    if (!choice) return status();
    if (choice.action === 'advanced') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ubovm.ubovm-core'); return status(); }
    if (choice.action === 'clear') { await apply({ ...modelConfig(current), apiKey: '' }); return status(); }
    if (choice.action === 'key') {
      const model = modelConfig(current);
      const key = await vscode.window.showInputBox({ title: 'API Key', prompt: '密钥只保存在凭据库中；留空可清除。', password: true, ignoreFocusOut: true });
      if (key !== undefined) await apply({ ...model, apiKey: key });
      return status();
    }
    const backend = 'pi';
    const provider = await vscode.window.showInputBox({ title: '服务商标识', value: current.provider ?? 'custom', prompt: '例如 deepseek、openrouter，或自定义端点的标识', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : '请输入服务商标识。' });
    if (provider === undefined) return status();
    const modelId = await vscode.window.showInputBox({ title: '模型名称', value: current.modelId ?? '', prompt: '服务商提供的模型 ID', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : '请输入模型名称。' });
    if (modelId === undefined) return status();
    const api = await vscode.window.showQuickPick([{ label: '使用内置模型目录', api: undefined }, ...APIS.map(api => ({ label: api, api }))], { title: '模型协议', placeHolder: current.api ?? '内置模型可使用模型目录；自定义端点请选择协议' });
    if (!api) return status();
    let baseUrl;
    if (api.api) {
      const presetUrl = require('./model-presets.cjs')[provider]?.baseUrl ?? '';
      baseUrl = await vscode.window.showInputBox({ title: '模型 API 地址', value: current.provider === provider && current.backend === backend ? current.baseUrl ?? '' : presetUrl, placeHolder: 'https://your-provider.example/v1', ignoreFocusOut: true,
        validateInput: value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash ? undefined : '请输入不含凭据的 HTTP(S) 地址。'; } catch { return '请输入完整的 HTTP(S) 地址。'; } } });
      if (baseUrl === undefined) return status();
    }
    const model = modelConfig({ backend, provider, modelId, ...(api.api ? { api: api.api, baseUrl } : {}) });
    const existing = await context.secrets.get(keyFor(model));
    const apiKey = await vscode.window.showInputBox({ title: 'API Key', prompt: existing ? '留空保留该端点已保存的密钥。' : '密钥保存在凭据库中；无需认证的兼容服务可填任意占位值。', password: true, ignoreFocusOut: true });
    if (apiKey === undefined) return status();
    return apply({ ...model, ...(apiKey.trim() ? { apiKey } : {}) });
  }
  return { status, read: () => state.run(read), configure };
}

module.exports = { createModelConfiguration, modelConfig, keyFor, configurationState, updateConfiguration };
