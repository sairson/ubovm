'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { homedir } = require('node:os');
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
    if (result.intools.knowledge !== false) {
      result.intools.knowledge = { libraryFile: path.join(homedir(), '.ubovm', 'learning', 'knowledge.sqlite'), reflection: true, ...object(result.intools.knowledge) };
    }
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
// Shared by the settings form and by the agent-facing install path so an
// installed server is validated exactly like one entered by hand.
function validateMcpServer(server, names) {
  if (!plain(server) || typeof server.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(server.name) || names.has(server.name)) throw new Error('每个 MCP 服务需要唯一名称（1–64 位字母、数字、点、下划线或连字符，且以字母或数字开头）。');
  names.add(server.name);
  const transport = server.transport ?? 'stdio';
  if (!['stdio', 'sse', 'streamable_http', 'streamable-http'].includes(transport)) throw new Error('MCP 传输协议不受支持。');
  if (transport === 'stdio') { if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('stdio 服务需要启动命令。'); }
  else url(server.url, 'MCP 地址');
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('MCP 参数必须是不含 NUL 的字符串数组。');
  if (server.cwd !== undefined && (typeof server.cwd !== 'string' || !server.cwd.trim() || server.cwd.includes('\0'))) throw new Error('MCP 工作目录无效。');
  if (server.tools !== undefined && (!Array.isArray(server.tools) || server.tools.some(tool => typeof tool !== 'string' || !tool || tool.includes('\0')) || new Set(server.tools).size !== server.tools.length)) throw new Error('MCP 允许工具必须是不重复的非空名称数组。');
  if (server.toolNamePrefix !== undefined && (typeof server.toolNamePrefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(server.toolNamePrefix))) throw new Error('MCP 工具名称前缀无效。');
  return server;
}
function stringMap(value, label) {
  if (value === undefined) return undefined;
  if (!plain(value) || Object.values(value).some(entry => typeof entry !== 'string')) throw new Error(`${label} 必须是字符串映射。`);
  return value;
}

function createSettingsConfiguration(vscode, context) {
  const state = configurationState(context);
  const config = () => vscode.workspace.getConfiguration('ubovm');
  const get = name => { const entry = config().inspect(name); return clone(entry?.globalValue ?? entry?.defaultValue); };
  const raw = () => Object.fromEntries(['modelProfiles', 'model', 'reason', 'worker', 'contextSummary', 'summaryEnabled', 'intools', 'toolsEnabled', 'mcp', 'skills'].map(name => [name, get(name)]));
  const revision = () => digest([raw(), state.generation]);
  async function snapshot({ includeSkills = true } = {}) {
    const source = raw(), stamp = digest([source, state.generation]), values = {}, secretState = {};
    const availableModelPresets = clone(modelPresets);
    // Vault calls cross the extension-host boundary. Read unique keys with a
    // bounded pool once per snapshot instead of serializing every saved profile.
    const models = Object.entries(modelSections).map(([section, setting]) => section === 'model' ? source.model : source[setting]?.model);
    const sourceTools = object(source.intools);
    const keys = [...new Set([
      ...models.filter(model => model?.provider).map(keyFor),
      ...(source.modelProfiles ?? []).map(profile => keyFor(profile.model)),
      ...profiles(object(sourceTools.ssh)).map(sshKey), webKey(object(sourceTools.webSearch)),
      ...(source.mcp?.servers ?? []).map(mcpKey),
    ])];
    const secrets = new Map(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
      while (next < keys.length) { const key = keys[next++]; secrets.set(key, await context.secrets.get(key)); }
    }));
    const vaultContext = { secrets: { get: async key => secrets.get(key) } };
    for (const [section, setting] of Object.entries(modelSections)) {
      const model = section === 'model' ? object(source.model) : object(source[setting]?.model);
      values[section] = { ...scrub(model), ...(section === 'model' ? {} : { inherit: !source[setting]?.model }) };
      secretState[section] = { apiKey: Boolean(model.provider && secrets.get(keyFor(model))) };
    }
    const intools = object(source.intools), web = object(intools.webSearch), ssh = object(intools.ssh);
    values.python = scrub(object(intools.python));
    values.ssh = { defaultId: ssh.defaultId ?? profiles(ssh)[0]?.id ?? '', profiles: [] };
    for (const profile of profiles(ssh)) {
      const saved = await readVault(vaultContext, sshKey(profile));
      values.ssh.profiles.push({ ...scrub(profile), secretState: Object.fromEntries(privateSSH.map(key => [key, Boolean(saved[key] || profile[key])])) });
    }
    values.web = { ...scrub(web.tavily ?? {}), ...scrub(web), baseURL: web.baseURL ?? web.tavily?.baseURL,
      ideBrowser: intools.browser === false ? false : intools.browser?.ideBrowser !== false,
      headless: intools.browser?.launchOptions?.headless ?? true };
    delete values.web.enabled;
    delete values.web.tavily;
    secretState.web = { apiKey: Boolean(secrets.get(webKey(web)) || web.apiKey || web.tavily?.apiKey) };
    values.summary = { ...scrub(object(source.contextSummary)), enabled: source.contextSummary !== false && source.summaryEnabled !== false }; delete values.summary.model;
    for (const role of ['reason', 'worker']) { values[role] = scrub(object(source[role])); delete values[role].model; }
    values.mcp = scrub(object(source.mcp));
    secretState.mcp = { credentials: false };
    for (const server of source.mcp?.servers ?? []) if (server.env || server.headers || secrets.get(mcpKey(server))) secretState.mcp.credentials = true;
    values.skills = scrub(object(source.skills));
    delete values.skills.directories;
    delete values.skills.skills;
    for (const [section, spec] of Object.entries(sections)) {
      const stored = values[section] ?? {};
      const value = Object.hasOwn(modelSections, section) && ['claude', 'codex'].includes(stored.backend)
        ? { ...stored, ...modelConfig(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'inherit'))) } : stored;
      const defaults = Object.fromEntries(spec.fields.filter(field => field.type !== 'secret').map(field => [field.key, clone(field.default)]));
      if (Object.hasOwn(modelSections, section)) {
        const { label, ...preset } = availableModelPresets[value.provider] ?? (value.provider ? availableModelPresets.custom : availableModelPresets.openai);
        Object.assign(defaults, preset);
      }
      // An explicit empty string / false / zero is a user choice, not a missing value.
      values[section] = { ...defaults, ...Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) };
    }
    for (const key of Object.keys(modelSections)) values[key].backend = 'pi';
    const skillsCatalog = includeSkills ? await readSkillsCatalog() : undefined;
    const modelProfiles = await Promise.all((source.modelProfiles ?? []).map(async profile => ({
      ...scrub(profile), model: modelConfig(scrub(profile.model)), secretState: { apiKey: Boolean(secrets.get(keyFor(profile.model))) }
    })));
    let modelConfigured = false;
    try { modelConfig(source.model); modelConfigured = true; } catch { /* Form defaults are not saved configuration. */ }
    const initialization = { model: modelConfigured, ssh: sshConfigurationStatus(sourceTools.ssh).configured };
    initialization.complete = initialization.model && initialization.ssh;
    return { revision: stamp, values, secretState, sections, sshFields, mcpFields, modelPresets: availableModelPresets, skillsCatalog, modelProfiles, initialization };
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
      const { profile: savedProfile, deleteProfileId, backend, assignments, ...fields } = input;
      if (deleteProfileId !== undefined) {
        if (typeof deleteProfileId !== 'string' || !old.modelProfiles?.some(p => p.id === deleteProfileId)) throw new Error('模型配置不存在。');
        if (Object.keys(fields).length || savedProfile !== undefined || backend !== undefined || assignments !== undefined) throw new Error('删除模型配置不能同时修改模型。');
        changes.set('modelProfiles', old.modelProfiles.filter(p => p.id !== deleteProfileId));
        await updateConfiguration(vscode, context, changes, secrets);
        return snapshot({ includeSkills: section === 'skills' });
      }
      const modelEqual = (left, right) => {
        if (!left || !right) return false;
        return ['provider', 'modelId', 'api', 'baseUrl'].every(key => String(left[key] ?? '') === String(right[key] ?? ''));
      };
      const writeModel = (model, apiKey) => {
        rejectSecrets(model);
        if (model.input && !model.input.length) throw new Error('请至少选择一种模型输入类型。');
        for (const key of ['compat', 'streamOptions']) if (model[key] !== undefined && !plain(model[key])) throw new Error(`${key} 必须是 JSON 对象。`);
        if (apiKey !== undefined && apiKey !== null) {
          if (typeof apiKey !== 'string') throw new Error('API Key 必须是字符串。');
          const trimmed = apiKey.trim();
          if (trimmed) {
            for (let index = 0; index < trimmed.length; index++) {
              if (trimmed.charCodeAt(index) > 255) {
                throw new Error('API Key 含有非英文字符（例如中文），无法用于 HTTP 请求头。请粘贴纯英文/数字密钥后保存。');
              }
            }
          }
          secrets.set(keyFor(model), trimmed || undefined);
        } else if (apiKey === null) {
          secrets.set(keyFor(model), undefined);
        }
      };
      const upsertProfile = (savedProfile, model) => {
        if (savedProfile === undefined) return undefined;
        if (!plain(savedProfile) || typeof savedProfile.id !== 'string' || !/^[\w.-]{1,80}$/.test(savedProfile.id)
          || typeof savedProfile.name !== 'string' || !savedProfile.name.trim() || savedProfile.name.trim().length > 80) throw new Error('模型配置需要有效标识和 1–80 字名称。');
        const library = clone(changes.has('modelProfiles') ? changes.get('modelProfiles') : (old.modelProfiles ?? []));
        const index = library.findIndex(p => p.id === savedProfile.id);
        const previous = index >= 0 ? library[index].model : undefined;
        const entry = { id: savedProfile.id, name: savedProfile.name.trim(), model };
        if (index < 0) library.push(entry); else library[index] = entry;
        if (library.length > 30) throw new Error('最多保存 30 个模型配置。');
        changes.set('modelProfiles', library);
        return previous;
      };
      const syncBoundRoles = (previous, model) => {
        if (!previous || modelEqual(previous, model)) return;
        if (modelEqual(object(old.model), previous)) changes.set('model', model);
        for (const role of ['reason', 'worker', 'contextSummary']) {
          const current = object(changes.has(role) ? changes.get(role) : old[role]);
          if (!modelEqual(current.model, previous)) continue;
          changes.set(role, { ...current, model });
        }
      };
      if (assignments !== undefined) {
        if (section !== 'model' || !plain(assignments)) throw new Error('角色分配只能在默认模型页提交。');
        const value = validateFields(fields, sections.model.fields);
        const { apiKey, inherit, ...data } = value;
        if (inherit) throw new Error('默认模型不能继承。');
        const model = modelConfig({ ...data, ...(backend === undefined ? {} : { backend }) });
        writeModel(model, apiKey);
        upsertProfile(savedProfile, model);
        const library = changes.get('modelProfiles') ?? clone(old.modelProfiles ?? []);
        const pick = id => {
          if (savedProfile && id === savedProfile.id) return model;
          const entry = library.find(item => item.id === id);
          if (!entry) throw new Error('角色指定的模型配置不存在。');
          return modelConfig(entry.model);
        };
        if (typeof assignments.model !== 'string' || !assignments.model) throw new Error('请为默认模型选择一份配置。');
        changes.set('model', pick(assignments.model));
        for (const [roleKey, setting] of [['reasonModel', 'reason'], ['workerModel', 'worker'], ['summaryModel', 'contextSummary']]) {
          if (!Object.hasOwn(assignments, roleKey) || assignments[roleKey] === undefined) continue;
          const choice = assignments[roleKey];
          if (choice === null || choice === '') {
            const role = object(old[setting]); delete role.model;
            changes.set(setting, old[setting] === false ? false : role);
          } else if (typeof choice === 'string') {
            changes.set(setting, { ...object(old[setting]), model: pick(choice) });
          } else throw new Error('角色模型分配无效。');
        }
        if (assignments.swarmBackendSelection !== undefined) {
          if (!['fixed', 'autonomous'].includes(assignments.swarmBackendSelection)) throw new Error('并行任务模型选择模式无效。');
          changes.set('worker', { ...object(changes.has('worker') ? changes.get('worker') : old.worker), swarmBackendSelection: assignments.swarmBackendSelection });
        }
      } else {
        const value = validateFields(fields, sections[section].fields), setting = modelSections[section];
        const { apiKey, inherit, ...data } = value;
        if (inherit && section !== 'model') { const role = object(old[setting]); delete role.model; changes.set(setting, old[setting] === false ? false : role); }
        else {
          const model = modelConfig({ ...data, ...(backend === undefined ? {} : { backend }) });
          writeModel(model, apiKey);
          changes.set(setting, section === 'model' ? model : { ...object(old[setting]), model });
          const previous = upsertProfile(savedProfile, model);
          if (previous) syncBoundRoles(previous, model);
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
    } else if (section === 'python') {
      const value = validateFields(input, sections.python.fields);
      if (value.executable && (!path.isAbsolute(value.executable) || value.executable.includes('\0'))) throw new Error('Python 解释器必须是绝对路径。');
      if ((value.defaultTimeoutSeconds ?? 120) > (value.maxTimeoutSeconds ?? 600)) throw new Error('Python 默认超时不能超过上限。');
      if (value.allowedDomains) {
        value.allowedDomains = [...new Set(value.allowedDomains.map(domain => domain.trim().toLowerCase()))];
        if (value.allowedDomains.includes('*')) value.allowedDomains = ['*'];
        if (value.allowedDomains.length > 100 || value.allowedDomains.some(domain => {
          if (domain === '*') return false;
          const match = /^(?:\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/.exec(domain);
          return !match || domain.length > 253 || match[1].split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
            || match[2] && (+match[2] < 1 || +match[2] > 65535);
        })) throw new Error('请填写 *（任意主机），或有效域名如 *.example.com、example.com:443，端口范围为 1–65535。');
      }
      intools.python = value; intools.allowedTools = [...tools]; changes.set('intools', intools);
    } else if (section === 'web') {
      if (!plain(input)) throw new Error('配置内容必须是对象。');
      const { enabled: legacyEnabled, ...currentInput } = input;
      const { apiKey, headless, ideBrowser, ...value } = validateFields(currentInput, sections.web.fields);
      if ((headless !== undefined || ideBrowser !== undefined) && intools.browser !== false) {
        const browser = object(intools.browser);
        const next = { ...browser };
        if (ideBrowser !== undefined) next.ideBrowser = ideBrowser;
        if (headless !== undefined) next.launchOptions = { ...object(browser.launchOptions), headless };
        intools.browser = next;
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
        validateMcpServer(server, names);
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
      if (section === 'reason') {
        const openIntents = next.openIntents ?? 5;
        if ((next.maxConcurrency ?? 3) > openIntents) throw new Error('并行任务数不能超过同时进行上限。');
        if ((next.maxIntents ?? 5) > openIntents) throw new Error('每轮新增任务上限不能超过同时进行上限。');
      }
      if (section === 'skills') { delete next.directories; delete next.skills; }
      changes.set(section, next);
    }
    // Preparing SSH/MCP credentials may yield to an external settings edit.
    if (expectedRevision !== revision()) throw new Error('配置已发生变化，请重新载入后再保存。');
    await updateConfiguration(vscode, context, changes, secrets);
    return snapshot({ includeSkills: section === 'skills' });
  }
  function save(section, value, expectedRevision) { return state.run(() => commit(section, value, expectedRevision)); }
  // Agent-facing install path: add or replace a single MCP server without
  // round-tripping the whole form. Credentials live only in SecretStorage.
  async function addMcpServer({ server, credentials = {}, overwrite = false } = {}) {
    if (!plain(server)) throw new Error('MCP 服务配置必须是对象。');
    if (!plain(credentials)) throw new Error('MCP 凭据必须是对象。');
    if (typeof overwrite !== 'boolean') throw new Error('overwrite 必须是布尔值。');
    const env = stringMap(credentials.env, 'MCP env');
    const headers = stringMap(credentials.headers, 'MCP headers');
    if (Object.keys(credentials).some(key => !['env', 'headers'].includes(key))) throw new Error('MCP 凭据仅支持 env 和 headers。');
    return state.run(async () => {
      const old = raw();
      const stamp = revision();
      const existing = clone(old.mcp?.servers ?? []);
      const normalized = clone(server);
      rejectSecrets(normalized);
      const names = new Set(existing.filter(entry => entry.name !== normalized.name).map(entry => entry.name));
      validateMcpServer(normalized, names);
      const previous = existing.find(entry => entry.name === normalized.name);
      if (previous && !overwrite) throw new Error(`MCP 服务 ${normalized.name} 已存在；如需替换请设置 overwrite 为 true。`);
      const next = existing.filter(entry => entry.name !== normalized.name);
      if (next.length >= 50) throw new Error('MCP 服务器列表最多支持 50 项。');
      next.push(normalized);
      const inherited = previous && mcpKey(previous) === mcpKey(normalized) ? await readVault(context, mcpKey(previous)) : {};
      const secret = { ...inherited };
      if (env !== undefined) secret.env = env;
      if (headers !== undefined) secret.headers = headers;
      const secrets = new Map();
      secrets.set(mcpKey(normalized), Object.keys(secret).length ? JSON.stringify(secret) : undefined);
      if (previous && mcpKey(previous) !== mcpKey(normalized)) secrets.set(mcpKey(previous), undefined);
      if (stamp !== revision()) throw new Error('配置已发生变化，请重试安装。');
      await updateConfiguration(vscode, context, new Map([['mcp', { ...object(old.mcp), servers: next }]]), secrets);
      return { name: normalized.name, transport: normalized.transport ?? 'stdio', enabled: normalized.enabled !== false, replaced: Boolean(previous), credentials: Object.keys(secret).length > 0 };
    });
  }
  return { snapshot: options => state.run(() => snapshot(options)), save, addMcpServer };
}
module.exports = { createSettingsConfiguration, hydrateRuntime, readSSHConfiguration, resolveSSHTestProfile, sshConfigurationStatus, readSSHStatus };
