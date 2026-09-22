'use strict';

const { createHash } = require('node:crypto');
const { sections, sshFields, mcpFields, modelPresets, tools } = require('./settings-schema.cjs');
const { modelConfig, keyFor, configurationState, updateConfiguration } = require('./model-config.cjs');
const { defaultDirectory, readSkillsCatalog } = require('./skills-catalog.cjs');
const clone = value => value === undefined ? undefined : structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const object = value => plain(value) ? clone(value) : {};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sshKey = p => 'ubovm.ssh.' + digest([p.id, p.host, p.port ?? 22, p.username]);
const webKey = w => 'ubovm.web.' + digest(w.baseURL ?? w.tavily?.baseURL ?? 'https://api.tavily.com');
const mcpKey = s => 'ubovm.mcp.' + digest([s.name, s.transport ?? 'stdio', s.url, s.command, s.args, s.cwd]);
const profiles = ssh => Array.isArray(ssh?.profiles) ? ssh.profiles : ssh?.host ? [{ ...ssh, id: ssh.id ?? 'default' }] : [];
const privateSSH = ['password', 'private_key_passphrase', 'privateKey'];
function sshConfigurationStatus(ssh) {
  const entries = profiles(ssh);
  const profile = entries.find(entry => entry?.id === (ssh?.defaultId || entries[0]?.id));
  const configured = Boolean(profile && ['host', 'username'].every(key => typeof profile[key] === 'string' && profile[key].trim())
    && (profile.port === undefined || Number.isInteger(profile.port) && profile.port > 0 && profile.port <= 65535));
  return configured ? { configured: true } : { configured: false, error: '请先在“系统配置 → SSH 连接”配置有效的默认 SSH 连接，才能运行 IDE 任务。' };
}
function readSSHStatus(vscode) {
  const entry = vscode.workspace.getConfiguration('ubovm').inspect('intools');
  return sshConfigurationStatus((entry?.globalValue ?? entry?.defaultValue)?.ssh);
}
const modelSections = { model: 'model', reasonModel: 'reason', workerModel: 'worker', summaryModel: 'contextSummary' };
async function readVault(context, key) { const raw = await context.secrets.get(key); return raw ? JSON.parse(raw) : {}; }

/** Terminal connections do not depend on a configured model or other tools. */
function readSSHConfiguration(vscode, context) {
  return configurationState(context).run(async () => {
    const entry = vscode.workspace.getConfiguration('ubovm').inspect('intools');
    const ssh = object((entry?.globalValue ?? entry?.defaultValue)?.ssh);
    return { ...ssh, profiles: await Promise.all(profiles(ssh).map(async profile => ({ ...profile, ...await readVault(context, sshKey(profile)) }))) };
  });
}

/** Credentials are injected only in the extension host, immediately before a run. */
async function hydrateRuntime(result, context) {
  if (result.skills !== false) {
    result.skills = { ...object(result.skills), directories: [defaultDirectory] };
    delete result.skills.skills;
  }
  if (plain(result.intools)) {
    if (result.intools.ssh) {
      const ssh = result.intools.ssh;
      result.intools.ssh = { ...ssh, profiles: await Promise.all(profiles(ssh).map(async p => ({ ...p, ...await readVault(context, sshKey(p)) }))) };
    }
    if (plain(result.intools.webSearch)) {
      const web = result.intools.webSearch;
      const key = await context.secrets.get(webKey(web));
      if (key) web.apiKey = key;
    }
  }
  if (Array.isArray(result.mcp?.servers)) {
    result.mcp.servers = await Promise.all(result.mcp.servers.map(async server => server.enabled === false ? server : ({ ...server, ...await readVault(context, mcpKey(server)) })));
  }
  return result;
}

async function resolveSSHTestProfile(vscode, context, input) {
  const profile = validateFields(input, sshFields);
  for (const key of ['id', 'host', 'username']) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) throw new Error('请填写连接标识、主机和用户名。');
    profile[key] = profile[key].trim();
  }
  if (profile.host_key_sha256 && !/^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/.test(profile.host_key_sha256)) throw new Error('SSH 主机指纹应为 SHA256 格式。');
  let configuration;
  try { configuration = await readSSHConfiguration(vscode, context); }
  catch { throw new Error('无法读取已保存的 SSH 凭据，请重新载入配置后重试。'); }
  const saved = configuration.profiles.find(p => sshKey(p) === sshKey(profile));
  const preserved = Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => privateSSH.includes(key) || !sshFields.some(field => field.key === key)));
  const result = { ...preserved, ...profile };
  if (!result.known_hosts_file && !result.host_key_sha256) result.insecure_ignore_host_key = true;
  else delete result.insecure_ignore_host_key;
  for (const key of privateSSH) if (profile[key] === null || profile[key] === '') delete result[key];
  return result;
}

function validateFields(input, fields) {
  if (!plain(input)) throw new Error('配置内容必须是对象。');
  const result = {};
  for (const key of Object.keys(input)) {
    const field = fields.find(f => f.key === key);
    if (!field) throw new Error(`不支持的配置字段：${key}`);
    const value = input[key];
    if (value === undefined || value === '' && field.type !== 'secret') continue;
    if (field.type === 'secret') {
      if (value !== null && (typeof value !== 'string' || value.length > 131072)) throw new Error(`${field.label} 格式无效。`);
    } else if (field.type === 'number') {
      if (!Number.isSafeInteger(value) || value < (field.min ?? 1) || value > (field.max ?? 1e9)) throw new Error(`${field.label} 必须是 ${field.min ?? 1}–${field.max ?? 1e9} 之间的整数。`);
    } else if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error(`${field.label} 必须为开关值。`);
    } else if (field.type === 'servers') {
      if (!Array.isArray(value) || value.length > 50) throw new Error('MCP 服务器列表最多支持 50 项。');
    } else if (field.type === 'json') {
      if (!plain(value) && !Array.isArray(value) && typeof value !== 'boolean') throw new Error(`${field.label} JSON 格式无效。`);
    } else if (field.type === 'checklist' || field.type === 'lines') {
      if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string' || !v.trim() || field.options && !field.options.includes(v))) throw new Error(`${field.label} 格式无效。`);
    } else if (typeof value !== 'string' || value.length > 65536 || field.options && !field.allowCustom && !field.options.includes(value)) throw new Error(`${field.label} 格式无效。`);
    result[key] = clone(value);
  }
  return result;
}
function url(value, label) {
  let parsed; try { parsed = new URL(value); } catch { throw new Error(`${label} 必须是完整的 HTTP(S) 地址。`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error(`${label} 不能包含凭据、查询参数或片段。`);
}
function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['apiKey', 'password', 'privateKey', 'private_key_passphrase', 'headers', 'env', 'authorization'].includes(key)) throw new Error('凭据请填写在专用加密字段中。');
    rejectSecrets(entry);
  }
}
function scrub(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['apiKey', 'password', 'privateKey', 'private_key_passphrase', 'headers', 'env', 'authorization'].includes(key)).map(([key, entry]) => [key, scrub(entry)]));
}

function createSettingsConfiguration(vscode, context) {
  const state = configurationState(context);
  const config = () => vscode.workspace.getConfiguration('ubovm');
  const get = name => { const entry = config().inspect(name); return clone(entry?.globalValue ?? entry?.defaultValue); };
  const raw = () => Object.fromEntries(['modelProfiles', 'model', 'reason', 'worker', 'contextSummary', 'summaryEnabled', 'intools', 'toolsEnabled', 'mcp', 'skills'].map(name => [name, get(name)]));
  const revision = () => digest([raw(), state.generation]);
  async function snapshot() {
    const source = raw(), stamp = digest([source, state.generation]), values = {}, secretState = {};
    for (const [section, setting] of Object.entries(modelSections)) {
      const model = section === 'model' ? object(source.model) : object(source[setting]?.model);
      values[section] = { ...scrub(model), ...(section === 'model' ? {} : { inherit: !source[setting]?.model }) };
      secretState[section] = { apiKey: Boolean(model.provider && await context.secrets.get(keyFor(model))) };
    }
    const intools = object(source.intools), web = object(intools.webSearch), ssh = object(intools.ssh);
    values.ssh = { defaultId: ssh.defaultId ?? profiles(ssh)[0]?.id ?? '', profiles: [] };
    for (const profile of profiles(ssh)) {
      const saved = await readVault(context, sshKey(profile));
      values.ssh.profiles.push({ ...scrub(profile), secretState: Object.fromEntries(privateSSH.map(key => [key, Boolean(saved[key] || profile[key])])) });
    }
    values.web = { ...scrub(web.tavily ?? {}), ...scrub(web), baseURL: web.baseURL ?? web.tavily?.baseURL, headless: intools.browser?.launchOptions?.headless ?? true };
    delete values.web.enabled;
    delete values.web.tavily;
    secretState.web = { apiKey: Boolean(await context.secrets.get(webKey(web)) || web.apiKey || web.tavily?.apiKey) };
    values.summary = { ...scrub(object(source.contextSummary)), enabled: source.contextSummary !== false && source.summaryEnabled !== false }; delete values.summary.model;
    for (const role of ['reason', 'worker']) { values[role] = scrub(object(source[role])); delete values[role].model; }
    values.mcp = scrub(object(source.mcp));
    secretState.mcp = { credentials: false };
    for (const server of source.mcp?.servers ?? []) if (server.env || server.headers || await context.secrets.get(mcpKey(server))) secretState.mcp.credentials = true;
    values.skills = scrub(object(source.skills));
    delete values.skills.directories;
    delete values.skills.skills;
    for (const [section, spec] of Object.entries(sections)) {
      const value = values[section] ?? {};
      const defaults = Object.fromEntries(spec.fields.filter(field => field.type !== 'secret').map(field => [field.key, clone(field.default)]));
      if (Object.hasOwn(modelSections, section)) {
        const { label, ...preset } = modelPresets[value.provider] ?? (value.provider ? modelPresets.custom : modelPresets.openai);
        Object.assign(defaults, preset);
      }
      // An explicit empty string / false / zero is a user choice, not a missing value.
      values[section] = { ...defaults, ...Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) };
    }
    const skillsCatalog = await readSkillsCatalog();
    const modelProfiles = await Promise.all((source.modelProfiles ?? []).map(async profile => ({
      ...scrub(profile), secretState: { apiKey: Boolean(await context.secrets.get(keyFor(profile.model))) }
    })));
    return { revision: stamp, values, secretState, sections, sshFields, mcpFields, modelPresets, skillsCatalog, modelProfiles };
  }
  async function commit(section, input, expectedRevision) {
    if (typeof expectedRevision !== 'string' || expectedRevision !== revision()) throw new Error('配置已发生变化，请重新载入后再保存。');
    if (!Object.hasOwn(sections, section)) throw new Error('未知配置分组。');
    const changes = new Map(), secrets = new Map();
    const old = raw();
    function patchFields(base, fields, next) {
      const result = object(base);
      for (const field of fields) if (field.type !== 'secret') delete result[field.key];
      return { ...result, ...next };
    }
    const intools = object(old.intools);
    if (Object.hasOwn(modelSections, section)) {
      if (!plain(input)) throw new Error('配置内容必须是对象。');
      const { profile: savedProfile, deleteProfileId, ...fields } = input;
      if (deleteProfileId !== undefined) {
        if (typeof deleteProfileId !== 'string' || !old.modelProfiles?.some(p => p.id === deleteProfileId)) throw new Error('模型配置不存在。');
        if (Object.keys(fields).length || savedProfile !== undefined) throw new Error('删除模型配置不能同时修改模型。');
        changes.set('modelProfiles', old.modelProfiles.filter(p => p.id !== deleteProfileId));
        await updateConfiguration(vscode, context, changes, secrets);
        return snapshot();
      }
      const value = validateFields(fields, sections[section].fields), setting = modelSections[section];
      const { apiKey, inherit, ...data } = value;
      if (inherit && section !== 'model') { const role = object(old[setting]); delete role.model; changes.set(setting, old[setting] === false ? false : role); }
      else {
        const model = modelConfig(data); rejectSecrets(model);
        if (model.input && !model.input.length) throw new Error('请至少选择一种模型输入类型。');
        for (const key of ['compat', 'streamOptions']) if (model[key] !== undefined && !plain(model[key])) throw new Error(`${key} 必须是 JSON 对象。`);
        if (apiKey !== undefined) secrets.set(keyFor(model), apiKey === null ? undefined : apiKey.trim() || undefined);
        changes.set(setting, section === 'model' ? model : { ...object(old[setting]), model });
        if (savedProfile !== undefined) {
          if (!plain(savedProfile) || typeof savedProfile.id !== 'string' || !/^[\w.-]{1,80}$/.test(savedProfile.id)
            || typeof savedProfile.name !== 'string' || !savedProfile.name.trim() || savedProfile.name.trim().length > 80) throw new Error('模型配置需要有效标识和 1–80 字名称。');
          const library = clone(old.modelProfiles ?? []);
          const index = library.findIndex(p => p.id === savedProfile.id);
          const entry = { id: savedProfile.id, name: savedProfile.name.trim(), model };
          if (index < 0) library.push(entry); else library[index] = entry;
          if (library.length > 30) throw new Error('最多保存 30 个模型配置。');
          changes.set('modelProfiles', library);
        }
      }
    } else if (section === 'ssh') {
      if (!plain(input) || !Array.isArray(input.profiles) || input.profiles.length > 30) throw new Error('SSH 配置格式无效。');
      const ids = new Set(), next = [];
      for (const entry of input.profiles) {
        const data = validateFields(entry, sshFields);
        for (const key of ['id', 'host', 'username']) if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error('每个 SSH 连接都需要标识、主机和用户名。');
        data.id = data.id.trim(); data.host = data.host.trim(); data.username = data.username.trim();
        if (!/^[\w.-]{1,80}$/.test(data.id) || ids.has(data.id)) throw new Error('SSH 连接标识应唯一，且只能包含字母、数字、点、短横线或下划线。');
        ids.add(data.id);
        if (data.host_key_sha256 && !/^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/.test(data.host_key_sha256)) throw new Error('SSH 主机指纹应为 SHA256 格式。');
        if ((data.default_command_timeout_seconds ?? 120) > (data.max_command_timeout_seconds ?? 1800)) throw new Error('命令超时不能超过命令超时上限。');
        const previous = profiles(old.intools?.ssh).find(p => sshKey(p) === sshKey(data));
        const credentials = { ...Object.fromEntries(privateSSH.filter(key => previous?.[key]).map(key => [key, previous[key]])), ...await readVault(context, sshKey(data)) };
        for (const key of privateSSH) { if (data[key] !== undefined) { if (data[key]) credentials[key] = data[key]; else delete credentials[key]; } delete data[key]; }
        secrets.set(sshKey(data), Object.keys(credentials).length ? JSON.stringify(credentials) : undefined);
        const preserved = Object.fromEntries(Object.entries(scrub(previous) ?? {}).filter(([key]) => !sshFields.some(field => field.key === key)));
        const profile = { ...preserved, ...data };
        if (!profile.known_hosts_file && !profile.host_key_sha256) profile.insecure_ignore_host_key = true;
        else delete profile.insecure_ignore_host_key;
        next.push(profile);
      }
      if (input.defaultId && !ids.has(input.defaultId)) throw new Error('默认 SSH 连接不存在。');
      for (const previous of profiles(old.intools?.ssh)) if (!next.some(p => sshKey(p) === sshKey(previous))) secrets.set(sshKey(previous), undefined);
      intools.ssh = { profiles: next, ...(next.length ? { defaultId: input.defaultId || next[0].id } : {}) };
      intools.allowedTools = [...tools]; changes.set('intools', intools);
    } else if (section === 'web') {
      if (!plain(input)) throw new Error('配置内容必须是对象。');
      const { enabled: legacyEnabled, ...currentInput } = input;
      const { apiKey, headless, ...value } = validateFields(currentInput, sections.web.fields);
      if (headless !== undefined && intools.browser !== false) {
        const browser = object(intools.browser);
        intools.browser = { ...browser, launchOptions: { ...object(browser.launchOptions), headless } };
      }
      const prior = object(old.intools?.webSearch);
      const endpoint = value.baseURL || 'https://api.tavily.com'; url(endpoint, '搜索地址');
      const saved = await context.secrets.get(webKey({ baseURL: endpoint }));
      const key = apiKey !== undefined ? apiKey : saved || (webKey(prior) === webKey({ baseURL: endpoint }) ? prior.apiKey || prior.tavily?.apiKey : undefined);
      secrets.set(webKey({ baseURL: endpoint }), key?.trim() || undefined);
      const web = { ...prior, baseURL: endpoint, timeoutMs: value.timeoutMs, providerRetryAttempts: value.providerRetryAttempts, fallbackToPublicProviders: value.fallbackToPublicProviders,
        tavily: { ...object(prior.tavily), searchDepth: value.searchDepth ?? 'basic', topic: value.topic ?? 'general', includeAnswer: value.includeAnswer ?? false, projectID: value.projectID, enabled: Boolean(key) } };
      delete web.apiKey; delete web.tavily.apiKey; delete web.tavily.baseURL;
      intools.webSearch = web; intools.allowedTools = [...tools]; changes.set('intools', intools);
    } else if (section === 'summary') {
      const { enabled, ...value } = validateFields(input, sections.summary.fields);
      if ((value.targetTokens ?? 24576) >= (value.triggerTokens ?? 49152)) throw new Error('压缩后的目标 Token 数必须小于触发 Token 数。');
      changes.set('contextSummary', patchFields(old.contextSummary, sections.summary.fields, value));
      changes.set('summaryEnabled', enabled);
    } else if (section === 'mcp') {
      const { credentials, ...value } = validateFields(input, sections.mcp.fields);
      if (!Array.isArray(value.servers)) throw new Error('服务器列表必须是 JSON 数组。');
      rejectSecrets(value);
      let supplied = {}; if (credentials) { try { supplied = JSON.parse(credentials); } catch { throw new Error('MCP 凭据必须是有效的 JSON 对象。'); } if (!plain(supplied)) throw new Error('MCP 凭据必须是对象。'); }
      const names = new Set();
      for (const server of value.servers) {
        if (!plain(server) || typeof server.name !== 'string' || !server.name.trim() || names.has(server.name)) throw new Error('每个 MCP 服务需要唯一名称。');
        names.add(server.name);
        if (!['stdio', 'sse', 'streamable_http', 'streamable-http'].includes(server.transport ?? 'stdio')) throw new Error('MCP 传输协议不受支持。');
        if ((server.transport ?? 'stdio') === 'stdio') { if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('stdio 服务需要启动命令。'); }
        else url(server.url, 'MCP 地址');
        if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string'))) throw new Error('MCP 参数必须是字符串数组。');
        const previous = old.mcp?.servers?.find(s => mcpKey(s) === mcpKey(server));
        let secret = credentials === null ? {} : { ...(previous?.env ? { env: previous.env } : {}), ...(previous?.headers ? { headers: previous.headers } : {}), ...await readVault(context, mcpKey(server)) };
        if (Object.hasOwn(supplied, server.name)) {
          secret = supplied[server.name];
          if (!plain(secret) || Object.keys(secret).some(key => !['env', 'headers'].includes(key)) || Object.values(secret).some(value => !plain(value) || Object.values(value).some(v => typeof v !== 'string'))) throw new Error('MCP 凭据仅支持字符串形式的 env 和 headers。');
        }
        secrets.set(mcpKey(server), Object.keys(secret).length ? JSON.stringify(secret) : undefined);
      }
      if (Object.keys(supplied).some(name => !names.has(name))) throw new Error('MCP 凭据包含未配置的服务器名称。');
      for (const server of old.mcp?.servers ?? []) if (!value.servers.some(s => mcpKey(s) === mcpKey(server))) secrets.set(mcpKey(server), undefined);
      changes.set('mcp', value);
    } else {
      const value = validateFields(input, sections[section].fields); rejectSecrets(value);
      const next = patchFields(old[section], sections[section].fields, value);
      if (section === 'skills') { delete next.directories; delete next.skills; }
      changes.set(section, next);
    }
    // Preparing SSH/MCP credentials may yield to an external settings edit.
    if (expectedRevision !== revision()) throw new Error('配置已发生变化，请重新载入后再保存。');
    await updateConfiguration(vscode, context, changes, secrets);
    return snapshot();
  }
  function save(section, value, expectedRevision) { return state.run(() => commit(section, value, expectedRevision)); }
  return { snapshot: () => state.run(snapshot), save };
}
module.exports = { createSettingsConfiguration, hydrateRuntime, readSSHConfiguration, resolveSSHTestProfile, sshConfigurationStatus, readSSHStatus };
