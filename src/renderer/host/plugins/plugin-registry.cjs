'use strict';

const path = require('node:path');

/**
 * UBOVM plugin registry.
 *
 * Third-party VS Code extensions call the ubovm-core extension exports
 * (`vscode.extensions.getExtension('ubovm.ubovm-core').exports.ubovm`) to:
 *   - register agent tools that the harness exposes via `additionalTools`;
 *   - register declarative UI contributions for UBOVM-owned pages (slots);
 *
 * The registry keeps only serializable descriptors for the webview and the
 * click handlers live here in the extension host, so the webview can never ask
 * the host to run an arbitrary command.
 */

const PLUGIN_SLOTS = Object.freeze({
  'topbar.actions': '顶部栏操作',
  'composer.toolbar': '输入框工具栏',
  'welcome.shortcuts': '欢迎页工作区工具',
  'status.item': '输入框状态区'
});

const COMPONENT_TYPES = new Set(['button', 'text', 'badge', 'link']);
const SETTING_TYPES = new Set(['text', 'boolean', 'number', 'select']);
const MCP_TRANSPORTS = new Set(['stdio', 'streamable_http', 'sse']);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SLOTS_PER_PLUGIN = 64;
const MAX_TOOLS = 64;
const MAX_SETTINGS_FIELDS = 40;
const PLUGIN_PREFIX = 'plugin_';
const CREDENTIAL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CREDENTIAL_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_CREDENTIAL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function pluginCredentialMap(value, header) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, raw] of Object.entries(value).slice(0, 100)) {
    if (RESERVED_CREDENTIAL_NAMES.has(key) || (header ? !CREDENTIAL_HEADER_NAME.test(key) : !CREDENTIAL_ENV_NAME.test(key))) {
      throw new Error(`MCP 凭据${header ? '请求头' : '环境变量'}名无效：${key}`);
    }
    const text = String(raw);
    if (text.includes('\0') || (header && /[\r\n]/.test(text))) throw new Error(`MCP 凭据值包含非法字符：${key}`);
    if (text.length > 32768) throw new Error(`MCP 凭据值过大：${key}`);
    result[key] = text;
  }
  return result;
}

function createPluginRegistry({ vscode, onChange = () => {}, log = () => {}, settings = {}, state = {} } = {}) {
  if (typeof vscode?.extensions?.getExtension !== 'function') {
    throw new TypeError('plugin registry requires vscode.extensions.getExtension');
  }
  const slotsByPlugin = new Map();
  const tools = new Map();
  const skillsByPlugin = new Map();
  const eventListeners = new Map();
  const settingsSections = new Map();
  const settingsListeners = new Map();
  const mcpServersByPlugin = new Map();
  let revision = 0;
  let disposed = false;

  function readSettings(pluginId) {
    try {
      const value = settings.read?.(pluginId);
      return value && typeof value === 'object' ? value : {};
    } catch (error) {
      log('读取插件设置失败：' + (error?.message || error));
      return {};
    }
  }

  function settingsValues(section) {
    const stored = readSettings(section.pluginId);
    const raw = stored?.[section.id] && typeof stored[section.id] === 'object' ? stored[section.id] : {};
    const values = {};
    for (const field of section.fields) {
      values[field.key] = raw[field.key] !== undefined ? raw[field.key] : field.default;
    }
    return values;
  }

  function readPluginState(pluginId) {
    try {
      const value = state.read?.(pluginId);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      log('读取插件状态失败：' + (error?.message || error));
      return {};
    }
  }

  function writePluginState(pluginId, value) {
    const serialized = JSON.stringify(value);
    if (serialized.length > 64 * 1024) throw new Error('插件状态超过 64KB');
    try { state.write?.(pluginId, value); }
    catch (error) { throw new Error('保存插件状态失败：' + (error?.message || error)); }
  }

  function pluginStorage(pluginId) {
    assertInstalled(pluginId);
    return Object.freeze({
      get(key, fallback) {
        const normalized = String(key || '');
        if (!normalized || normalized.length > 80) throw new Error('插件状态键无效');
        const values = readPluginState(pluginId);
        return Object.hasOwn(values, normalized) ? values[normalized] : fallback;
      },
      set(key, value) {
        const normalized = String(key || '');
        if (!normalized || normalized.length > 80) throw new Error('插件状态键无效');
        const values = { ...readPluginState(pluginId), [normalized]: value };
        writePluginState(pluginId, values);
      },
      delete(key) {
        const normalized = String(key || '');
        const values = { ...readPluginState(pluginId) };
        delete values[normalized];
        writePluginState(pluginId, values);
      },
      keys() {
        return Object.keys(readPluginState(pluginId));
      }
    });
  }

  function pluginLogger(pluginId) {
    const prefix = `[${pluginId}] `;
    const render = value => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    return Object.freeze({
      info: (...args) => log(prefix + args.map(render).join(' ')),
      warn: (...args) => log(prefix + 'WARN ' + args.map(render).join(' ')),
      error: (...args) => log(prefix + 'ERROR ' + args.map(render).join(' '))
    });
  }

  function assertInstalled(pluginId) {
    if (typeof pluginId !== 'string' || !ID_PATTERN.test(pluginId)) throw new Error('插件 ID 无效');
    if (pluginId === 'ubovm.ubovm-core') throw new Error('UBOVM 核心扩展不能通过插件 API 注册自身');
    const extension = vscode.extensions.getExtension(pluginId);
    if (!extension) throw new Error(`插件 ${pluginId} 未安装或未激活`);
    return extension;
  }

  function sanitize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'plugin';
  }

  function slotKey(pluginId, slot, id) { return `${pluginId}\u0000${slot}\u0000${id}`; }

  function notify() {
    revision += 1;
    try { onChange(); } catch (error) { log('插件状态刷新失败：' + (error?.message || error)); }
  }

  /**
   * @param {string} pluginId installed extension id, e.g. "acme.scan"
   * @param {'topbar.actions'|'composer.toolbar'|'welcome.shortcuts'} slot
   * @param {{id:string,label:string,title?:string,type?:string,url?:string,order?:number,onSelect?:Function}} contribution
   */
  function registerSlot(pluginId, slot, contribution = {}) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    if (!Object.hasOwn(PLUGIN_SLOTS, slot)) throw new Error(`不支持的插件插槽：${slot}`);
    const id = String(contribution.id || '').trim();
    if (!ID_PATTERN.test(id)) throw new Error('插槽贡献 ID 无效');
    const label = String(contribution.label || contribution.title || '').trim().slice(0, 80);
    if (!label) throw new Error('插槽贡献需要 label');
    const type = String(contribution.type || 'button');
    if (!COMPONENT_TYPES.has(type)) throw new Error(`不支持的组件类型：${type}`);
    const map = slotsByPlugin.get(pluginId) || new Map();
    if (map.size >= MAX_SLOTS_PER_PLUGIN) throw new Error('该插件的插槽贡献过多');
    const key = slotKey(pluginId, slot, id);
    map.set(key, {
      pluginId, slot, id, type, label,
      title: String(contribution.title || label).slice(0, 200),
      order: Number.isFinite(contribution.order) ? Number(contribution.order) : 100,
      url: /^https?:/i.test(String(contribution.url || '')) ? String(contribution.url) : '',
      onSelect: typeof contribution.onSelect === 'function' ? contribution.onSelect : undefined
    });
    slotsByPlugin.set(pluginId, map);
    notify();
    return {
      dispose() {
        const current = slotsByPlugin.get(pluginId);
        if (!current) return;
        current.delete(key);
        if (!current.size) slotsByPlugin.delete(pluginId);
        notify();
      }
    };
  }

  /**
   * @param {string} pluginId installed extension id
   * @param {{name:string,label?:string,description?:string,parameters?:object,execute:Function,recovery?:string}} definition
   */
  function registerAgentTool(pluginId, definition = {}) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    if (tools.size >= MAX_TOOLS) throw new Error('插件工具过多');
    const rawName = String(definition.name || '').trim();
    if (!ID_PATTERN.test(rawName) || rawName === 'help') throw new Error('插件工具名无效');
    const name = `${PLUGIN_PREFIX}${sanitize(pluginId)}_${sanitize(rawName)}`.slice(0, 64);
    if (tools.has(name)) throw new Error(`插件工具名冲突：${name}`);
    if (typeof definition.execute !== 'function') throw new Error('插件工具需要 execute(input, signal)');
    const parameters = definition.parameters && typeof definition.parameters === 'object'
      ? definition.parameters
      : { type: 'object', properties: {}, additionalProperties: true };
    const tool = {
      name,
      label: String(definition.label || rawName).slice(0, 80),
      description: String(definition.description || '').slice(0, 4000),
      parameters,
      pluginId,
      ...(definition.recovery ? { recovery: String(definition.recovery) } : {}),
      async execute(_toolCallId, input, signal) {
        if (disposed) throw new Error('插件系统已关闭');
        signal?.throwIfAborted?.();
        const value = await definition.execute(input ?? {}, signal);
        signal?.throwIfAborted?.();
        if (value === undefined) return null;
        // Host tools feed the same transcript/UI pipeline as built-ins; keep a
        // bounded payload so a plugin cannot freeze rendering with one result.
        let serialized;
        try { serialized = JSON.stringify(value); }
        catch { throw new Error(`插件工具 ${name} 返回了不可序列化的结果`); }
        if (typeof serialized === 'string' && serialized.length > 256 * 1024) {
          throw new Error(`插件工具 ${name} 结果过大（${serialized.length} 字符），请分页返回`);
        }
        return serialized === undefined ? null : JSON.parse(serialized);
      }
    };
    tools.set(name, tool);
    notify();
    return {
      dispose() {
        if (!tools.has(name)) return;
        tools.delete(name);
        notify();
      }
    };
  }

  function agentTools() { return [...tools.values()]; }

  /** Plugin-shipped SKILL.md directories, merged into the harness skills config. */
  function registerSkillDirectory(pluginId, directory) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    const value = String(directory || '');
    if (!value || !path.isAbsolute(value)) throw new Error('技能目录必须是绝对路径');
    const set = skillsByPlugin.get(pluginId) || new Set();
    set.add(path.normalize(value));
    skillsByPlugin.set(pluginId, set);
    notify();
    return {
      dispose() {
        const current = skillsByPlugin.get(pluginId);
        if (!current) return;
        current.delete(path.normalize(value));
        if (!current.size) skillsByPlugin.delete(pluginId);
        notify();
      }
    };
  }

  function skillDirectories() {
    const all = new Set();
    for (const directories of skillsByPlugin.values()) for (const directory of directories) all.add(directory);
    return [...all];
  }

  /**
   * Subscribe to UBOVM agent lifecycle events. Event delivery is best-effort:
   * a throwing handler is logged and never interrupts the agent run.
   */
  function onAgentEvent(pluginId, listener) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    if (typeof listener !== 'function') throw new Error('onAgentEvent 需要函数');
    const set = eventListeners.get(pluginId) || new Set();
    set.add(listener);
    eventListeners.set(pluginId, set);
    return {
      dispose() {
        const current = eventListeners.get(pluginId);
        if (!current) return;
        current.delete(listener);
        if (!current.size) eventListeners.delete(pluginId);
      }
    };
  }

  function emitAgentEvent(event) {
    if (disposed || !event || typeof event.type !== 'string') return;
    for (const [pluginId, listeners] of eventListeners) {
      for (const listener of [...listeners]) {
        try { listener({ ...event, pluginId }); }
        catch (error) { log(`插件 ${pluginId} 的事件处理器失败：` + (error?.message || error)); }
      }
    }
  }

  function sectionKey(pluginId, id) { return `${pluginId}\u0000${id}`; }

  function normalizeSettingField(field = {}) {
    const key = String(field.key || '').trim();
    if (!ID_PATTERN.test(key)) throw new Error(`插件设置字段 key 无效：${key}`);
    const type = String(field.type || 'text');
    if (!SETTING_TYPES.has(type)) throw new Error(`不支持的插件设置类型：${type}`);
    const normalized = {
      key,
      type,
      label: String(field.label || key).slice(0, 80),
      description: String(field.description || '').slice(0, 300),
      default: field.default
    };
    if (type === 'select') {
      normalized.options = (Array.isArray(field.options) ? field.options : [])
        .slice(0, 100)
        .map(option => ({ value: String(option?.value ?? option), label: String(option?.label ?? option?.value ?? option).slice(0, 80) }));
      if (!normalized.options.length) throw new Error(`插件设置 ${key} 需要 options`);
      if (normalized.default === undefined) normalized.default = normalized.options[0].value;
    } else if (type === 'boolean') {
      normalized.default = normalized.default === true;
    } else if (type === 'number') {
      normalized.default = Number.isFinite(Number(normalized.default)) ? Number(normalized.default) : 0;
    } else {
      normalized.default = normalized.default === undefined ? '' : String(normalized.default).slice(0, 4000);
    }
    return normalized;
  }

  function registerSettingsSection(pluginId, section = {}) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    const id = String(section.id || '').trim();
    if (!ID_PATTERN.test(id)) throw new Error('插件设置 section ID 无效');
    if (settingsSections.has(sectionKey(pluginId, id))) throw new Error(`插件设置 section 已存在：${id}`);
    const fields = Array.isArray(section.fields) ? section.fields : [];
    if (!fields.length) throw new Error('插件设置 section 需要 fields');
    if (fields.length > MAX_SETTINGS_FIELDS) throw new Error('插件设置字段过多');
    const normalized = fields.map(normalizeSettingField);
    const keys = new Set();
    for (const field of normalized) {
      if (keys.has(field.key)) throw new Error(`插件设置字段重复：${field.key}`);
      keys.add(field.key);
    }
    settingsSections.set(sectionKey(pluginId, id), {
      pluginId, id,
      title: String(section.title || id).slice(0, 80),
      description: String(section.description || '').slice(0, 300),
      fields: normalized
    });
    notify();
    return {
      dispose() {
        settingsSections.delete(sectionKey(pluginId, id));
        notify();
      }
    };
  }

  function settingsSection(pluginId, sectionId) {
    return settingsSections.get(sectionKey(pluginId, String(sectionId || '')));
  }

  function getSettings(pluginId, sectionId) {
    const section = settingsSection(pluginId, sectionId);
    return section ? settingsValues(section) : {};
  }

  function coerceSettingValue(field, value) {
    if (field.type === 'boolean') return value === true || value === 'true';
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`插件设置 ${field.key} 需要数字`);
      return number;
    }
    if (field.type === 'select') {
      const selected = String(value ?? '');
      if (!field.options.some(option => option.value === selected)) throw new Error(`插件设置 ${field.key} 的值不在 options 中`);
      return selected;
    }
    return String(value ?? '').slice(0, 4000);
  }

  async function updateSetting(pluginId, sectionId, key, value) {
    const section = settingsSection(pluginId, sectionId);
    if (!section) throw new Error('插件设置 section 不存在');
    const field = section.fields.find(item => item.key === key);
    if (!field) throw new Error('插件设置字段不存在');
    const next = coerceSettingValue(field, value);
    const stored = { ...readSettings(pluginId) };
    const current = stored[section.id] && typeof stored[section.id] === 'object' ? stored[section.id] : {};
    stored[section.id] = { ...current, [key]: next };
    await settings.write?.(pluginId, stored);
    for (const listener of [...(settingsListeners.get(pluginId) || [])]) {
      try { listener({ pluginId, sectionId: section.id, key, value: next, values: settingsValues(section) }); }
      catch (error) { log(`插件 ${pluginId} 的设置变更处理器失败：` + (error?.message || error)); }
    }
    notify();
    return next;
  }

  function onSettingsChanged(pluginId, listener) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    if (typeof listener !== 'function') throw new Error('onSettingsChanged 需要函数');
    const set = settingsListeners.get(pluginId) || new Set();
    set.add(listener);
    settingsListeners.set(pluginId, set);
    return {
      dispose() {
        const current = settingsListeners.get(pluginId);
        if (!current) return;
        current.delete(listener);
        if (!current.size) settingsListeners.delete(pluginId);
      }
    };
  }

  function settingsState() {
    return [...settingsSections.values()].map(section => ({
      pluginId: section.pluginId,
      id: section.id,
      title: section.title,
      description: section.description,
      fields: section.fields,
      values: settingsValues(section)
    }));
  }

  /** Plugin-provided MCP servers, merged into the harness config at run time. */
  function registerMcpServer(pluginId, server = {}) {
    if (disposed) throw new Error('插件系统已关闭');
    assertInstalled(pluginId);
    const name = String(server.name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('MCP 服务名无效');
    const transport = String(server.transport || 'stdio');
    if (!MCP_TRANSPORTS.has(transport)) throw new Error(`不支持的 MCP 传输协议：${transport}`);
    const normalized = { name, transport, enabled: server.enabled !== false, required: server.required === true };
    if (transport === 'stdio') {
      normalized.command = String(server.command || '').trim();
      if (!normalized.command) throw new Error('stdio MCP 服务需要 command');
      if (Array.isArray(server.args)) normalized.args = server.args.map(String).slice(0, 100);
      if (server.cwd) normalized.cwd = String(server.cwd);
    } else {
      normalized.url = String(server.url || '');
      if (!/^https?:\/\//i.test(normalized.url)) throw new Error('HTTP/SSE MCP 服务需要 http(s) url');
    }
    const env = pluginCredentialMap(server.env, false);
    if (env) normalized.env = env;
    const headers = pluginCredentialMap(server.headers, true);
    if (headers) normalized.headers = headers;
    if (Array.isArray(server.tools)) normalized.tools = server.tools.map(String).slice(0, 500);
    if (server.toolNamePrefix) normalized.toolNamePrefix = String(server.toolNamePrefix).slice(0, 40);
    for (const [otherPlugin, servers] of mcpServersByPlugin) {
      if (otherPlugin !== pluginId && servers.has(name)) throw new Error(`MCP 服务名 ${name} 已被插件 ${otherPlugin} 使用`);
    }
    const map = mcpServersByPlugin.get(pluginId) || new Map();
    if (map.has(name)) throw new Error(`MCP 服务名重复：${name}`);
    map.set(name, normalized);
    mcpServersByPlugin.set(pluginId, map);
    notify();
    return {
      dispose() {
        const current = mcpServersByPlugin.get(pluginId);
        if (!current) return;
        current.delete(name);
        if (!current.size) mcpServersByPlugin.delete(pluginId);
        notify();
      }
    };
  }

  function mcpServers() {
    const list = [];
    for (const servers of mcpServersByPlugin.values()) list.push(...servers.values());
    return list;
  }

  function uiState() {
    const slots = {};
    for (const slot of Object.keys(PLUGIN_SLOTS)) slots[slot] = [];
    for (const map of slotsByPlugin.values()) {
      for (const item of map.values()) {
        slots[item.slot].push({
          pluginId: item.pluginId, id: item.id, type: item.type,
          label: item.label, title: item.title, order: item.order
        });
      }
    }
    for (const list of Object.values(slots)) list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    return {
      revision,
      slots,
      tools: agentTools().map(({ name, label, pluginId }) => ({ name, label, pluginId })),
      skills: skillDirectories(),
      slotsSupported: Object.keys(PLUGIN_SLOTS)
    };
  }

  async function invokeSlot(pluginId, slot, contributionId) {
    const item = slotsByPlugin.get(pluginId)?.get(slotKey(pluginId, slot, contributionId));
    if (!item) throw new Error('插件操作已失效，请刷新页面后重试');
    if (item.onSelect) return item.onSelect({ pluginId, slot, id: item.id });
    if (item.url) return vscode.env.openExternal(vscode.Uri.parse(item.url));
    return undefined;
  }

  function workspaceFolders() {
    return (vscode.workspace?.workspaceFolders || [])
      .map(folder => folder?.uri?.fsPath)
      .filter(value => typeof value === 'string' && value);
  }

  function getInfo() {
    return {
      apiVersion: 2,
      ideVersion: String(vscode.version || ''),
      appName: String(vscode.env?.appName || 'UBOVM'),
      platform: `${process.platform}-${process.arch}`,
      workspaceFolders: workspaceFolders()
    };
  }

  async function openExternal(pluginId, url) {
    assertInstalled(pluginId);
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) throw new Error('只允许打开 http(s) 链接');
    return vscode.env.openExternal(vscode.Uri.parse(target));
  }

  async function setSetting(pluginId, sectionId, key, value) {
    assertInstalled(pluginId);
    return updateSetting(pluginId, sectionId, key, value);
  }

  const api = Object.freeze({
    apiVersion: 2,
    version: 2,
    slots: PLUGIN_SLOTS,
    registerSlot,
    registerAgentTool,
    registerSkillDirectory,
    onAgentEvent,
    registerSettingsSection,
    getSettings,
    setSetting,
    onSettingsChanged,
    registerMcpServer,
    storage: pluginStorage,
    logger: pluginLogger,
    workspaceFolders,
    getInfo,
    openExternal
  });

  function dispose() {
    disposed = true;
    slotsByPlugin.clear();
    tools.clear();
    skillsByPlugin.clear();
    eventListeners.clear();
    settingsSections.clear();
    settingsListeners.clear();
    mcpServersByPlugin.clear();
  }

  /** Drop contributions from extensions that were uninstalled or disabled. */
  function prune() {
    if (disposed) return false;
    const installed = new Set((vscode.extensions.all || []).map(extension => extension.id));
    let changed = false;
    for (const map of [slotsByPlugin, skillsByPlugin, mcpServersByPlugin]) {
      for (const pluginId of [...map.keys()]) {
        if (!installed.has(pluginId)) { map.delete(pluginId); changed = true; }
      }
    }
    for (const [name, tool] of [...tools.entries()]) {
      if (!installed.has(tool.pluginId)) { tools.delete(name); changed = true; }
    }
    for (const pluginId of [...eventListeners.keys()]) {
      if (!installed.has(pluginId)) { eventListeners.delete(pluginId); changed = true; }
    }
    for (const pluginId of [...settingsListeners.keys()]) {
      if (!installed.has(pluginId)) { settingsListeners.delete(pluginId); changed = true; }
    }
    for (const [key, section] of [...settingsSections.entries()]) {
      if (!installed.has(section.pluginId)) { settingsSections.delete(key); changed = true; }
    }
    if (changed) notify();
    return changed;
  }

  return {
    api,
    uiState,
    agentTools,
    skillDirectories,
    mcpServers,
    emitAgentEvent,
    settingsState,
    updateSetting,
    invokeSlot,
    slots: PLUGIN_SLOTS,
    prune,
    dispose
  };
}

module.exports = { createPluginRegistry, PLUGIN_SLOTS, PLUGIN_PREFIX };
