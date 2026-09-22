function createSettingsPanel(vscode) {
  const $ = id => document.getElementById(id);
  const dialog = $('settings-dialog'), form = $('settings-form'), fields = $('settings-fields');
  let data, section = 'model', page = 'settings', dirty = false, saving = false, closeAction, lastFocus, requestId = '', sequence = 0;
  let operation = '', requestView, renderedSection = '', renderedFingerprint = '', navigation = '', pendingOpen;
  let requestTimer;
  const views = new Map();
  const selectedModels = new Map();
  const sshTests = new Map();
  let browserInstalling = false, browserTimer;
  let browserInstallResult = '';
  let browserInstallation = {}, browserInstallFailed = false;
  function refreshBrowserInstall() {
    const state = browserInstalling ? 'installing' : browserInstallFailed ? 'error' : browserInstallation.state || 'unknown';
    const button = fields.querySelector('[data-install-browser]');
    if (button) { button.disabled = browserInstalling || state === 'ready'; button.textContent = browserInstalling ? '正在下载并安装…' : state === 'ready' ? '已安装' : browserInstallFailed ? '重试安装' : '下载并安装内置浏览器'; }
    const note = fields.querySelector('[data-browser-install-status]');
    if (note) { note.textContent = browserInstalling ? '正在下载 Chromium，可继续配置其他选项。详细进度请查看安装日志。' : browserInstallResult || browserInstallation.message || (state === 'ready' ? '内置 Chromium 已就绪，下次运行可自动使用。' : '安装后，Agent 可使用浏览器工具访问和操作网页。'); note.dataset.error = String(state === 'error'); }
    const badge = fields.querySelector('[data-browser-badge]');
    if (badge) { badge.textContent = { installing: '安装中', ready: '已就绪', missing: '未安装', error: '需要处理', unknown: '尚未检测' }[state] || '尚未检测'; badge.dataset.state = state; }
    const location = fields.querySelector('[data-browser-location]');
    if (location) { location.textContent = browserInstallation.executablePath || ''; location.title = location.textContent; location.parentElement.hidden = !browserInstallation.executablePath; }
  }
  function finishSSHTest(id, result) {
    const pending = sshTests.get(id); if (!pending) return;
    sshTests.delete(id); clearTimeout(pending.timer);
    pending.button.disabled = false; pending.button.textContent = '测试连接';
    if (!pending.group.isConnected) return;
    let unchanged = false;
    try { unchanged = JSON.stringify(readFields(pending.group)) === pending.signature; } catch {}
    pending.status.dataset.error = String(unchanged && !result.ok);
    pending.status.textContent = unchanged ? (result.ok ? result.message || '连接成功。' : window.UBOVMErrors.text(result.failure || result.message)) + (result.ok && Number.isFinite(result.durationMs) ? `（${result.durationMs} ms）` : '') : '配置已更改，请重新测试连接。';
  }
  const modelRoles = [['model', '默认模型'], ['reasonModel', '思考Agent'], ['workerModel', '执行Agent'], ['summaryModel', '摘要模型']];
  const iconTemplates = new Map();
  function providerIcon(key) {
    const markup = UBOVM_PROVIDER_ICONS[key];
    let svg;
    if (markup) {
      if (!iconTemplates.has(key)) iconTemplates.set(key, new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement);
      svg = document.importNode(iconTemplates.get(key), true);
      svg.querySelectorAll('title').forEach(title => title.remove());
      // Each mounted SVG owns its gradient IDs, including inherited model badges.
      const ids = new Map();
      for (const node of svg.querySelectorAll('[id]')) { const old = node.id; node.id = 'provider-icon-' + (++sequence); ids.set(old, node.id); }
      for (const node of svg.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
        if (attribute.value.includes('url(#')) node.setAttribute(attribute.name, attribute.value.replace(/url\(#([^)]*)\)/g, (match, id) => ids.has(id) ? 'url(#' + ids.get(id) + ')' : match));
      }
    } else {
      // A neutral connector is only used for custom/unknown providers.
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
      const shape = document.createElementNS(svg.namespaceURI, 'path');
      for (const [name, value] of Object.entries({ d: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) shape.setAttribute(name, value);
      svg.append(shape);
    }
    svg.setAttribute('class', 'settings-provider-icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    return svg;
  }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function status(text, error = false) { const node = $('settings-status'); node.setAttribute('role', error ? 'alert' : 'status'); node.setAttribute('aria-live', error ? 'assertive' : 'polite'); node.textContent = error ? window.UBOVMErrors.text(text) : text; node.dataset.error = String(error); }
  function busy(value, kind = '') {
    saving = value; operation = value ? kind : ''; dialog.dataset.operation = operation;
    form.setAttribute('aria-busy', String(value)); $('settings-progress').hidden = !value;
    $('settings-save').disabled = value || !data; $('settings-reload').disabled = value;
    $('settings-save').textContent = kind === 'save' && value ? '正在保存…' : '保存更改';
    $('settings-reload').textContent = kind === 'read' && value ? '正在载入…' : '重新载入';
    fields.inert = value; roles.inert = value;
  }
  function guard(action) { if (saving && operation !== 'open') return; if (!dirty) return action(); closeAction = action; $('settings-discard').hidden = false; $('settings-keep').focus(); }
  function invalidateView() { views.delete(renderedSection); renderedFingerprint = ''; }
  function close() {
    for (const id of sshTests.keys()) finishSSHTest(id, { ok: false, message: '' });
    clearTimeout(requestTimer);
    dialog.close(); data = undefined; pendingOpen = undefined; requestId = ''; requestView = undefined;
    fields.replaceChildren(); views.clear(); selectedModels.clear(); renderedSection = ''; renderedFingerprint = ''; dirty = false; navigation = ''; busy(false);
    $('settings-discard').hidden = true; closeAction = undefined; lastFocus?.focus();
    window.dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: false } }));
    vscode.postMessage({ action: 'settingsNavigation', page: '' });
  }
  function showDialog() {
    if (dialog.open) return;
    lastFocus = document.activeElement; dialog.showModal(); $('settings-close').focus();
    window.dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: true } }));
  }
  function viewState() {
    const active = document.activeElement;
    return { scroll: form.scrollTop, focus: dialog.contains(active) ? active.id : '', start: active?.selectionStart, end: active?.selectionEnd,
      controlIndex: [...fields.querySelectorAll('[data-setting]')].indexOf(active),
      expanded: [...fields.querySelectorAll('details')].map(detail => detail.open) };
  }
  function restoreView(view, focus = false) {
    if (!view) { form.scrollTop = 0; return; }
    [...fields.querySelectorAll('details')].forEach((detail, index) => { detail.open = Boolean(view.expanded[index]); });
    if (focus && view.focus) {
      const control = $(view.focus) ?? fields.querySelectorAll('[data-setting]')[view.controlIndex]; control?.focus({ preventScroll: true });
      if (control && typeof view.start === 'number' && ['text', 'password', 'search', 'url', 'tel'].includes(control.type)) control.setSelectionRange(view.start, view.end);
      else if (control?.tagName === 'TEXTAREA' && typeof view.start === 'number') control.setSelectionRange(view.start, view.end);
    }
    form.scrollTop = view.scroll;
  }
  function switchTo(key, focusTab = false) {
    if (key === section || !data || saving) return;
    guard(() => { section = key; dirty = false; render(); if (focusTab) $('settings-tab-' + key)?.focus({ preventScroll: true }); });
  }
  const roles = $('settings-model-roles');
  for (const [key, label] of modelRoles) {
    const button = element('button', '', label); button.type = 'button'; button.dataset.role = key; button.id = 'settings-tab-' + key;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'settings-fields');
    button.addEventListener('click', () => switchTo(key, true)); roles.append(button);
  }
  roles.addEventListener('keydown', event => {
    const tabs = [...roles.children], index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    switchTo(tabs[next].dataset.role, true);
  });
  function field(spec, value, secretState, prefix = '') {
    if (spec.type === 'servers') return serverList(spec, value ?? spec.default ?? []);
    const wide = ['textarea', 'lines', 'json', 'checklist', 'secret'].includes(spec.type);
    const root = element('div', 'settings-field' + (wide ? ' wide' : '') + (spec.type === 'checkbox' ? ' toggle' : ''));
    const id = 'setting-' + prefix + spec.key;
    root.dataset.field = spec.key;
    const label = element('label', '', spec.label); label.htmlFor = id;
    let control;
    if (spec.type === 'checklist') {
      control = element('div', 'settings-checklist'); control.id = id;
      for (const option of spec.options) { const row = element('label'); const box = element('input'); box.type = 'checkbox'; box.value = option; box.checked = (value ?? spec.default ?? []).includes(option); row.append(box, element('span', '', option)); control.append(row); }
    } else if (spec.type === 'select') {
      control = element('select');
      if (spec.key === 'provider' && CSS.supports('appearance', 'base-select')) {
        control.classList.add('settings-provider-select');
        const button = element('button'); button.type = 'button'; button.append(element('selectedcontent')); control.append(button);
      }
      for (const option of spec.options) { const node = element('option', '', spec.labels?.[option] ?? (option || '自动 / 使用内置默认')); node.value = option; control.append(node); }
      if (value && !spec.options.includes(value)) { const saved = element('option', '', value + '（已配置）'); saved.value = value; control.append(saved); }
      if (spec.allowCustom) { const custom = element('option', '', '其他服务商…'); custom.value = '__custom__'; control.append(custom); }
      control.value = value ?? spec.default ?? '';
      if (control.classList.contains('settings-provider-select')) for (const option of control.options) {
        const label = option.textContent; option.replaceChildren(providerIcon(option.value), element('span', '', label));
      }
    } else if (['textarea', 'lines', 'json'].includes(spec.type)) {
      control = element('textarea'); control.dataset.type = spec.type;
      control.value = spec.type === 'json' ? JSON.stringify(value ?? spec.default, null, 2) ?? '' : spec.type === 'lines' ? (value ?? spec.default ?? []).join('\n') : value ?? spec.default ?? '';
    } else {
      control = element('input'); control.type = spec.type === 'secret' ? 'password' : spec.type === 'number' ? 'number' : spec.type === 'checkbox' ? 'checkbox' : 'text';
      if (spec.type === 'checkbox') control.checked = value ?? spec.default ?? false;
      else if (spec.type !== 'secret') control.value = value ?? spec.default ?? '';
      if (spec.type === 'number') { control.min = spec.min ?? 1; if (spec.max) control.max = spec.max; control.step = '1'; }
    }
    control.id = id; control.dataset.setting = spec.key; control.dataset.kind = spec.type;
    if ('placeholder' in control) control.placeholder = spec.type === 'secret' && secretState?.[spec.key] ? '已保存 · 留空保留，输入新值替换' : spec.placeholder ?? '';
    control.autocomplete = 'off'; control.spellcheck = false;
    root.append(...(spec.type === 'checkbox' ? [control, label] : [label, control]));
    if (spec.key === 'provider' && !control.classList.contains('settings-provider-select')) {
      const wrap = element('div', 'settings-provider-fallback'); control.before(wrap); wrap.append(providerIcon(control.value), control);
      control.addEventListener('change', () => wrap.querySelector('svg').replaceWith(providerIcon(control.value)));
    }
    if (spec.allowCustom) {
      const custom = element('input'); custom.type = 'text'; custom.dataset.customFor = id; custom.placeholder = '填写自定义服务商标识'; custom.setAttribute('aria-label', '自定义' + spec.label); custom.hidden = true;
      control.addEventListener('change', () => { custom.hidden = control.value !== '__custom__'; if (!custom.hidden) custom.focus(); }); root.append(custom);
    }
    if (spec.type === 'secret') {
      const help = element('label', 'settings-secret-help'); const remove = element('input'); remove.type = 'checkbox'; remove.dataset.clearSecret = spec.key;
      help.append(remove, element('span', '', secretState?.[spec.key] ? '清除已保存的凭据' : '清除凭据（当前未保存）')); root.append(help);
      remove.addEventListener('change', () => { control.disabled = remove.checked; if (remove.checked) control.value = ''; });
    }
    return root;
  }
  function readFields(container) {
    const value = {};
    for (const control of container.querySelectorAll('[data-setting]')) {
      if (control.closest('[data-server-card]') && !container.matches('[data-server-card]')) continue;
      const key = control.dataset.setting, kind = control.dataset.kind;
      if (kind === 'servers') {
        value[key] = [...control.querySelectorAll('[data-server-card]')].map(group => {
          const server = readFields(group);
          if (!server.tools.length && !group.dataset.explicitEmptyTools) delete server.tools;
          if (server.transport === 'stdio') delete server.url;
          else { delete server.command; delete server.args; delete server.cwd; }
          return server;
        });
      } else if (kind === 'select' && control.value === '__custom__') {
        const custom = container.querySelector(`[data-custom-for="${control.id}"]`); if (!custom.value.trim()) { custom.focus(); throw new Error('请输入自定义服务商标识。'); } value[key] = custom.value.trim();
      } else if (kind === 'secret') {
        if (container.querySelector(`[data-clear-secret="${key}"]`)?.checked) value[key] = null;
        else if (control.value) value[key] = control.value;
      } else if (kind === 'checkbox') value[key] = control.checked;
      else if (kind === 'checklist') value[key] = [...control.querySelectorAll('input:checked')].map(box => box.value);
      else if (kind === 'lines') value[key] = control.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
      else if (control.value.trim()) {
        if (kind === 'json') { try { value[key] = JSON.parse(control.value); } catch { control.focus(); throw new Error('JSON 格式无效，请检查对应字段。'); } }
        else value[key] = kind === 'number' ? Number(control.value) : control.value.trim();
      }
    }
    return value;
  }
  function serverList(spec, servers) {
    const root = element('div', 'settings-mcp-library'); root.id = 'setting-servers'; root.dataset.setting = spec.key; root.dataset.kind = 'servers';
    const toolbar = element('div', 'settings-library-toolbar');
    const list = element('div', 'settings-extension-list');
    const summary = element('div', 'settings-library-summary'); summary.setAttribute('role', 'status');
    const refresh = () => {
      const cards = [...root.querySelectorAll('[data-server-card]')];
      const enabled = cards.filter(card => card.querySelector('[data-setting="enabled"]').checked).length;
      summary.textContent = cards.length + ' 个服务 · ' + enabled + ' 个已启用';
      root.querySelector('.settings-empty')?.remove();
      if (!cards.length) list.append(element('div', 'settings-empty', '尚未添加服务。连接本地工具或远程 MCP 服务，扩展 Agent 的能力。'));
    };
    root.append(toolbar, list, element('p', 'settings-library-hint', '服务在任务运行时连接，启用状态不代表已连接。'));
    const add = element('button', '', '+ 添加 MCP 服务'); add.id = 'settings-add-mcp'; add.type = 'button';
    function appendServer(server = { name: 'server-' + (++sequence) }, expanded = false) {
      const group = element('article', 'settings-server-row'); group.dataset.serverCard = '';
      if (Array.isArray(server.tools) && !server.tools.length) group.dataset.explicitEmptyTools = 'true';
      const header = element('div', 'settings-extension-header');
      const icon = element('span', 'settings-extension-icon', '⌘'); icon.setAttribute('aria-hidden', 'true');
      const info = element('div', 'settings-extension-info');
      const legend = element('h4', '', server.name || '新服务');
      const caption = element('p', 'settings-server-caption'); info.append(legend, caption);
      const edit = element('button', 'settings-server-edit', expanded ? '收起' : '配置'); edit.type = 'button';
      const grid = element('div', 'settings-profile-grid settings-server-editor'); grid.id = 'mcp-editor-' + (++sequence); grid.hidden = !expanded;
      edit.setAttribute('aria-controls', grid.id); edit.setAttribute('aria-expanded', String(expanded));
      edit.addEventListener('click', () => { grid.hidden = !grid.hidden; edit.textContent = grid.hidden ? '配置' : '收起'; edit.setAttribute('aria-expanded', String(!grid.hidden)); });
      for (const item of data.mcpFields) grid.append(field(item, item.key === 'transport' && server.transport === 'streamable-http' ? 'streamable_http' : server[item.key], null, 'mcp-' + (++sequence) + '-'));
      const toggle = grid.querySelector('[data-setting="enabled"]').closest('.settings-field');
      header.append(icon, info, toggle, edit); group.append(header);
      const advanced = element('details', 'settings-advanced');
      advanced.append(element('summary', '', '工具权限与连接选项'));
      const advancedGrid = element('div', 'settings-profile-grid');
      for (const key of ['required', 'cwd', 'tools', 'toolNamePrefix']) advancedGrid.append(grid.querySelector('[data-setting="' + key + '"]').closest('.settings-field'));
      advanced.append(advancedGrid); grid.append(advanced);
      const transport = grid.querySelector('[data-setting="transport"]');
      const update = () => {
        for (const item of grid.querySelectorAll('[data-setting]')) if (['command', 'args', 'cwd', 'url'].includes(item.dataset.setting)) item.closest('.settings-field').hidden = item.dataset.setting === 'cwd' || (item.dataset.setting === 'url' ? transport.value === 'stdio' : transport.value !== 'stdio');
        legend.textContent = grid.querySelector('[data-setting="name"]').value.trim() || '新服务';
        const enabled = group.querySelector('[data-setting="enabled"]').checked;
        group.dataset.enabled = String(enabled);
        caption.textContent = (enabled ? '已启用' : '已停用') + ' · ' + (transport.value === 'stdio' ? 'STDIO' : transport.value === 'sse' ? 'SSE' : 'HTTP');
        toggle.querySelector('input').setAttribute('aria-label', (enabled ? '停用 ' : '启用 ') + legend.textContent);
        edit.setAttribute('aria-label', '配置 ' + legend.textContent);
      };
      grid.addEventListener('input', update);
      grid.addEventListener('change', () => { update(); refresh(); });
      toggle.addEventListener('change', () => { update(); refresh(); });
      transport.addEventListener('change', update); update();
      const actions = element('div', 'settings-profile-actions');
      const remove = element('button', '', '移除服务'); remove.type = 'button'; remove.addEventListener('click', () => { group.remove(); refresh(); dirty = true; }); actions.append(remove); grid.append(actions);
      group.append(grid); list.append(group);
    }
    toolbar.append(summary, add); for (const server of servers) appendServer(server);
    refresh();
    add.addEventListener('click', () => { appendServer({ name: 'server-' + (++sequence), enabled: true }, true); refresh(); dirty = true; root.querySelector('[data-server-card]:last-of-type [data-setting="name"]')?.focus(); }); return root;
  }
  function skillLibrary() {
    const catalog = data.skillsCatalog;
    const root = element('section', 'settings-skill-library wide'); root.setAttribute('aria-label', '已发现的技能');
    const toolbar = element('div', 'settings-library-toolbar');
    toolbar.append(element('div', 'settings-library-summary', '已安装 · ' + (catalog?.items.length ?? 0)), element('span', 'settings-library-hint', '点击技能查看内容'));
    root.append(toolbar);
    const grid = element('div', 'settings-skill-grid');
    for (const skill of catalog?.items ?? []) {
      const card = element('details', 'settings-skill-card');
      const heading = element('summary', 'settings-extension-header');
      const icon = element('span', 'settings-extension-icon', '◇'); icon.setAttribute('aria-hidden', 'true');
      const info = element('div', 'settings-extension-info');
      info.append(element('h4', '', skill.name), element('p', '', skill.description));
      const chevron = element('span', 'settings-row-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
      heading.append(icon, info, element('span', 'settings-skill-badge', skill.builtin ? '内置' : '已安装'), chevron);
      const detail = element('div', 'settings-skill-detail');
      detail.append(element('p', '', '技能内容'));
      if (typeof skill.content === 'string') {
        const content = element('pre', 'settings-skill-content', skill.content || '此技能暂无内容。');
        content.tabIndex = 0; content.setAttribute('role', 'region'); content.setAttribute('aria-label', skill.name + ' 技能内容');
        detail.append(content);
      } else detail.append(element('p', 'settings-catalog-error', skill.contentError || '暂时无法读取技能内容，请重新载入。'));
      card.append(heading, detail); grid.append(card);
    }
    root.append(grid);
    root.append(element('p', 'settings-library-hint', '技能由应用统一管理。更新后，点击“重新载入”刷新内容。'));
    if (!catalog?.items.length) root.append(element('p', 'settings-empty', '尚未发现技能，请重新载入。'));
    for (const error of catalog?.errors ?? []) root.append(element('p', 'settings-catalog-error', error));
    return root;
  }
  function bindProviderPresets() {
    const provider = fields.querySelector('[data-setting="provider"]'); if (!provider) return;
    provider.addEventListener('change', () => {
      const preset = data.modelPresets[provider.value] ?? data.modelPresets.custom;
      for (const [key, value] of Object.entries(preset)) {
        if (key === 'provider' || key === 'label') continue;
        const control = fields.querySelector(`[data-setting="${key}"]`); if (!control) continue;
        if (control.dataset.kind === 'checkbox') control.checked = value;
        else if (control.dataset.kind === 'checklist') for (const box of control.querySelectorAll('input')) box.checked = value.includes(box.value);
        else control.value = value;
      }
      // A provider switch must not submit a credential typed for a different endpoint.
      const key = fields.querySelector('[data-setting="apiKey"]'); key.value = ''; key.placeholder = '填写该服务商的密钥；留空使用此端点已保存的凭据'; key.disabled = false;
      fields.querySelector('[data-clear-secret="apiKey"]').checked = false;
      key.closest('.settings-field').querySelector('.settings-secret-help span').textContent = '清除当前端点已保存的凭据';
      fields.querySelector('[data-setting="compat"]').value = '{}';
      fields.querySelector('[data-setting="streamOptions"]').value = '{}';
      dirty = true; status('已填入服务商预设；检查配置后保存。');
    });
  }
  function refreshSSHList() {
    const groups = [...fields.querySelectorAll('.settings-ssh-profile')];
    const summary = fields.querySelector('[data-ssh-count]');
    if (summary) summary.textContent = groups.length + ' 个连接';
    for (const group of groups) group.dataset.default = String(group.querySelector('[data-default-ssh]').checked);
    fields.querySelector('.settings-empty')?.remove();
    if (!groups.length) fields.append(element('div', 'settings-empty', '还没有 SSH 连接。点击“添加 SSH 连接”配置第一台主机。'));
  }
  function addProfile(value = {}) {
    const group = element('section', 'settings-profile settings-ssh-profile');
    const title = element('h4', 'settings-ssh-name'), endpoint = element('p', 'settings-ssh-endpoint');
    title.id = 'ssh-title-' + (++sequence); group.setAttribute('aria-labelledby', title.id);
    const grid = element('div', 'settings-ssh-body');
    const addFields = (parent, keys) => {
      const content = element('div', 'settings-profile-grid');
      for (const key of keys) {
        const spec = data.sshFields.find(spec => spec.key === key);
        if (spec) content.append(field(spec, value[spec.key], value.secretState, 'ssh-' + (++sequence) + '-'));
      }
      parent.append(content);
    };
    const connection = element('section', 'settings-ssh-section'); connection.append(element('h4', '', '连接信息'));
    addFields(connection, ['name', 'username', 'host', 'port']);
    const auth = element('section', 'settings-ssh-section'); auth.append(element('h4', '', '身份认证'), element('p', 'settings-ssh-hint', '填写登录密码或私钥路径；已保存的密码留空即可保留。'));
    addFields(auth, ['password', 'private_key_file', 'private_key_passphrase']);
    const advanced = element('details', 'settings-ssh-advanced'); advanced.append(element('summary', '', '高级选项 · 主机校验与超时'));
    advanced.append(element('p', 'settings-ssh-hint', 'known_hosts 和指纹均为可选；都留空时跳过主机身份校验。'));
    addFields(advanced, ['id', 'known_hosts_file', 'host_key_sha256', 'connect_timeout_seconds', 'default_command_timeout_seconds', 'max_command_timeout_seconds']);
    grid.append(connection, auth, advanced);
    const actions = element('div', 'settings-ssh-actions'), label = element('label', 'settings-ssh-default'), radio = element('input'); radio.type = 'radio'; radio.name = 'settings-default-ssh'; radio.dataset.defaultSsh = '';
    radio.checked = value.id === data.values.ssh.defaultId || !fields.querySelector('.settings-profile');
    radio.addEventListener('change', refreshSSHList);
    label.append(radio, element('span', '', '默认连接'));
    const remove = element('button', 'settings-ssh-remove', '移除连接'); remove.type = 'button'; remove.addEventListener('click', () => {
      for (const [id, pending] of sshTests) if (pending.group === group) { clearTimeout(pending.timer); sshTests.delete(id); }
      group.remove(); dirty = true;
      if (!fields.querySelector('[data-default-ssh]:checked')) { const first = fields.querySelector('[data-default-ssh]'); if (first) first.checked = true; }
      refreshSSHList(); $('settings-add-ssh').focus();
    });
    const test = element('button', 'settings-ssh-test', '测试连接'); test.type = 'button';
    const testStatus = element('p', 'settings-ssh-test-status'); testStatus.setAttribute('role', 'status');
    test.addEventListener('click', () => {
      let id;
      try {
        const profile = readFields(group); id = 'ssh-test-' + (++sequence);
        test.disabled = true; test.textContent = '正在测试…'; testStatus.dataset.error = 'false'; testStatus.textContent = '正在验证连接与登录认证（最多 30 秒）…';
        const timer = setTimeout(() => finishSSHTest(id, { ok: false, message: '连接测试超时，请重试。' }), 35000);
        sshTests.set(id, { group, button: test, status: testStatus, signature: JSON.stringify(profile), timer });
        vscode.postMessage({ action: 'settingsTestSSH', requestId: id, profile });
      } catch (error) { if (id) { clearTimeout(sshTests.get(id)?.timer); sshTests.delete(id); } test.disabled = false; test.textContent = '测试连接'; testStatus.dataset.error = 'true'; testStatus.textContent = window.UBOVMErrors.text(error); }
    });
    const duplicate = element('button', '', '复制连接'); duplicate.type = 'button';
    duplicate.addEventListener('click', () => {
      try {
        const copy = readFields(group);
        delete copy.password; delete copy.private_key_passphrase;
        addProfile({ ...copy, id: 'server-' + Date.now().toString(36) + '-' + (++sequence), name: (copy.name || copy.host || 'SSH') + ' 副本' });
        dirty = true; status('已复制连接参数，请为新连接填写密码或私钥口令后保存。');
      } catch (error) { status(error.message, true); }
    });
    const identity = element('div', 'settings-ssh-identity'); identity.append(title, endpoint);
    const header = element('div', 'settings-ssh-card-header'); header.append(identity, label);
    const secondary = element('div', 'settings-ssh-secondary'); secondary.append(duplicate, remove);
    actions.append(test, secondary);
    group.append(header, actions, testStatus, grid); fields.append(group);
    const updateIdentity = () => {
      const read = key => group.querySelector(`[data-setting="${key}"]`).value.trim();
      title.textContent = read('name') || read('host') || '新 SSH 连接';
      endpoint.textContent = read('host') ? (read('username') ? read('username') + '@' : '') + read('host') + ':' + (read('port') || '22') : '填写主机地址与登录信息';
    };
    group.addEventListener('input', updateIdentity); updateIdentity(); refreshSSHList();
    return group;
  }
  function modelLibrary(value, draft) {
    const library = data.modelProfiles ?? [];
    const matches = p => Object.keys(p.model).every(key => JSON.stringify(p.model[key]) === JSON.stringify(value[key]));
    const matched = draft ?? library.find(p => p.id === selectedModels.get(section) && matches(p)) ?? library.find(matches);
    const card = element('section', 'settings-model-library');
    const heading = element('div', 'settings-model-heading');
    heading.append(element('h4', '', '配置库'), element('span', 'settings-model-count', library.length + ' 个已保存配置'));
    const label = element('label', '', '已保存的模型配置'), select = element('select'); select.id = 'settings-model-profile'; label.htmlFor = select.id;
    select.append(new Option('当前配置 / 新配置', ''));
    for (const profile of library) select.append(new Option(profile.name + ' · ' + profile.model.modelId, profile.id));
    select.value = matched?.id ?? '';
    const nameLabel = element('label', '', '配置名称'), name = element('input'); name.id = 'settings-model-profile-name'; nameLabel.htmlFor = name.id;
    name.type = 'text'; name.maxLength = 80; name.placeholder = '例如：日常对话、代码模型'; name.value = matched?.name ?? '';
    card.dataset.profileId = matched?.id ?? '';
    select.addEventListener('input', event => event.stopPropagation());
    select.addEventListener('change', event => {
      event.stopPropagation();
      const next = library.find(p => p.id === select.value);
      // Restore the selection if the user keeps the current unsaved form.
      select.value = card.dataset.profileId;
      if (!next) return;
      guard(() => { invalidateView(); dirty = false; render(undefined, next); dirty = true; });
    });
    const actions = element('div', 'settings-model-actions');
    const add = element('button', '', '另存为新配置'); add.type = 'button';
    add.addEventListener('click', () => { card.dataset.profileId = ''; select.value = ''; name.value = name.value ? name.value + ' 副本' : ''; remove.disabled = true; dirty = true; name.focus(); });
    const remove = element('button', 'settings-model-remove', '删除已保存配置'); remove.type = 'button'; remove.disabled = !library.some(p => p.id === card.dataset.profileId);
    remove.title = '从配置库移除，角色当前使用的模型仍会保留';
    remove.addEventListener('click', () => guard(() => {
      if (request('settingsSave', { section, value: { deleteProfileId: card.dataset.profileId }, revision: data.revision })) status('正在删除配置…');
    }));
    actions.append(add, remove);
    const controls = element('div', 'settings-model-library-fields');
    const choice = element('div'), naming = element('div'); choice.append(label, select); naming.append(nameLabel, name); controls.append(choice, naming);
    card.append(heading, controls, actions, element('p', 'settings-model-hint', '保存后应用到' + modelRoles.find(([key]) => key === section)[1] + '。可加载已有配置，或另存一份新配置。'));
    return card;
  }
  function modelConnection(spec, value, secretState) {
    const card = element('section', 'settings-model-connection'); card.setAttribute('aria-label', '模型连接设置');
    const heading = element('div', 'settings-model-heading'), badge = element('span', 'settings-model-credential');
    badge.setAttribute('role', 'status'); heading.append(element('h4', '', '连接设置'), badge);
    const common = element('div', 'settings-model-connection-fields');
    const advanced = element('details', 'settings-advanced settings-model-advanced');
    advanced.append(element('summary', '', '高级选项 · 容量、推理与请求参数'));
    const extra = element('div', 'settings-advanced-fields'); advanced.append(extra);
    for (const entry of spec.fields) {
      if (entry.key === 'inherit') continue;
      (['provider', 'modelId', 'api', 'baseUrl', 'apiKey'].includes(entry.key) ? common : extra).append(field(entry, value[entry.key], secretState));
    }
    const keyRow = common.querySelector('[data-field="apiKey"]');
    keyRow.append(element('p', 'settings-model-hint', '密钥加密保存，留空保留。同一服务商和 API 地址共用密钥。'));
    card.append(heading, common, advanced);
    const refresh = () => {
      const provider = common.querySelector('[data-setting="provider"]');
      const custom = common.querySelector(`[data-custom-for="${provider.id}"]`);
      const endpointChanged = (provider.value === '__custom__' ? custom.value.trim() : provider.value) !== value.provider
        || common.querySelector('[data-setting="baseUrl"]').value.trim() !== (value.baseUrl ?? '');
      const clear = common.querySelector('[data-clear-secret="apiKey"]').checked;
      const key = common.querySelector('[data-setting="apiKey"]');
      const entered = key.value.trim();
      badge.textContent = clear ? '凭据待清除' : entered ? '新凭据待保存' : endpointChanged ? '端点已更改' : secretState?.apiKey ? '凭据已保存' : '未填写凭据';
      badge.dataset.saved = String(!clear && !endpointChanged && Boolean(secretState?.apiKey));
      key.placeholder = !endpointChanged && secretState?.apiKey ? '已保存 · 留空保留，输入新值替换' : '填写当前端点的密钥；留空保留该端点已存凭据';
      keyRow.querySelector('.settings-secret-help span').textContent = !endpointChanged && secretState?.apiKey ? '清除已保存的凭据' : '清除当前端点已保存的凭据';
    };
    card.addEventListener('input', refresh); card.addEventListener('change', refresh); refresh();
    return card;
  }
  function render(preserve, modelDraft) {
    if (data.browserInstallation) {
      browserInstallation = data.browserInstallation;
      browserInstalling = browserInstallation.state === 'installing';
      browserInstallFailed = false; browserInstallResult = '';
      delete data.browserInstallation;
    }
    const spec = data.sections[section], value = modelDraft ? { ...modelDraft.model, ...(section === 'model' ? {} : { inherit: false }) } : data.values[section] ?? {};
    const modelSecretState = modelDraft?.secretState ?? data.secretState[section];
    const fingerprint = JSON.stringify([spec, value, data.secretState[section], section === 'ssh' ? data.sshFields : section === 'mcp' ? data.mcpFields : null,
      modelRoles.some(([key]) => key === section) ? [data.modelPresets, data.values.model, section === 'summaryModel' ? data.values.reasonModel : null, data.modelProfiles, modelDraft?.id] : null, section === 'skills' ? data.skillsCatalog : null]);
    if (renderedSection && renderedFingerprint && !dirty) views.set(renderedSection, { fingerprint: renderedFingerprint, nodes: [...fields.children], view: viewState() });
    const cached = views.get(section);
    dialog.dataset.page = page;
    $('settings-skeleton').hidden = true; $('settings-load-error').hidden = true; fields.hidden = false;
    $('settings-title').textContent = page === 'mcp' ? 'MCP 服务' : page === 'skills' ? 'Skills' : '系统配置';
    $('settings-section-kicker').textContent = page === 'settings' ? 'PREFERENCES' : 'EXTENSIONS';
    const isModel = modelRoles.some(([key]) => key === section);
    $('settings-section-title').textContent = isModel ? data.sections.model.title : section === 'web' ? '浏览器与搜索' : spec.title;
    $('settings-description').textContent = isModel ? spec.description : section === 'web' ? '管理 Agent 的网页浏览能力与网络搜索服务。' : spec.description;
    const nextNavigation = page + ':' + (section.endsWith('Model') ? 'model' : section);
    if (navigation !== nextNavigation) { navigation = nextNavigation; vscode.postMessage({ action: 'settingsNavigation', page, section: section.endsWith('Model') ? 'model' : section }); }
    roles.hidden = !isModel;
    for (const button of roles.children) { const selected = button.dataset.role === section; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    fields.setAttribute('role', isModel ? 'tabpanel' : 'group');
    fields.setAttribute('aria-labelledby', isModel ? 'settings-tab-' + section : 'settings-section-title');
    if (cached?.fingerprint === fingerprint) {
      if (renderedSection !== section) fields.replaceChildren(...cached.nodes);
      renderedSection = section; renderedFingerprint = fingerprint;
      refreshBrowserInstall();
      restoreView(preserve ?? cached.view, Boolean(preserve)); status('更改将在下一次运行时生效。'); return;
    }
    fields.replaceChildren();
    renderedSection = section; renderedFingerprint = fingerprint;
    if (isModel) {
      const inheritField = spec.fields.find(entry => entry.key === 'inherit');
      if (inheritField) { const row = field(inheritField, value.inherit); row.classList.add('settings-model-inherit'); fields.append(row); }
      fields.append(modelLibrary(value, modelDraft));
    }
    if (section === 'skills') fields.append(skillLibrary());
    if (section === 'web') {
      const card = element('section', 'settings-browser-card wide'); card.setAttribute('aria-label', '内置浏览器');
      const heading = element('div', 'settings-browser-heading'), badge = element('span', 'settings-browser-badge'); badge.dataset.browserBadge = '';
      heading.append(element('h3', '', '内置浏览器'), badge);
      card.append(heading, element('p', 'settings-card-description', '为 Agent 提供 Chromium 网页浏览与操作能力。'));
      const mode = field(spec.fields.find(entry => entry.key === 'headless'), value.headless, data.secretState[section]);
      const modeHint = element('p', 'settings-field-hint', '关闭后显示浏览器窗口，下次启动生效。连接已有浏览器时，沿用其窗口模式。');
      modeHint.id = 'web-hint-headless'; mode.querySelector('[data-setting]').setAttribute('aria-describedby', modeHint.id);
      mode.append(modeHint);
      const button = element('button'); button.type = 'button'; button.dataset.installBrowser = '';
      const note = element('p', 'settings-card-status'); note.dataset.browserInstallStatus = ''; note.setAttribute('role', 'status');
      button.addEventListener('click', () => {
        if (browserInstalling) return;
        browserInstalling = true; browserInstallFailed = false; browserInstallResult = ''; refreshBrowserInstall();
        clearTimeout(browserTimer);
        browserTimer = setTimeout(() => {
          browserInstalling = false; browserInstallFailed = true;
          browserInstallResult = '安装结果尚未返回。请查看安装日志并刷新状态，确认是否仍在下载。'; refreshBrowserInstall();
        }, 600000);
        try { vscode.postMessage({ action: 'settingsInstallBrowser' }); }
        catch (error) { clearTimeout(browserTimer); browserInstalling = false; browserInstallFailed = true; browserInstallResult = window.UBOVMErrors.text(error); refreshBrowserInstall(); }
      });
      const actions = element('div', 'settings-browser-actions'), check = element('button', '', '检查状态'), logs = element('button', '', '查看安装日志');
      check.type = logs.type = 'button';
      check.addEventListener('click', () => vscode.postMessage({ action: 'settingsBrowserStatus' }));
      logs.addEventListener('click', () => vscode.postMessage({ action: 'settingsBrowserLogs' }));
      actions.append(button, check, logs);
      const details = element('details', 'settings-browser-details'), location = element('code'); location.dataset.browserLocation = '';
      location.tabIndex = 0; location.setAttribute('aria-label', '浏览器可执行文件完整路径');
      details.append(element('summary', '', '浏览器文件位置'), location);
      card.append(note, actions, mode, details, element('p', 'settings-browser-hint', '安装无需保存配置。已有外部浏览器连接或路径配置时，优先使用外部浏览器。'));
      fields.append(card); refreshBrowserInstall();
    }
    if (section === 'ssh') {
      const row = element('div', 'settings-ssh-toolbar'), add = element('button', '', '+ 添加 SSH 连接'); add.id = 'settings-add-ssh'; add.type = 'button';
      const summary = element('span'); summary.dataset.sshCount = '';
      add.addEventListener('click', () => {
        const group = addProfile({ id: 'server-' + Date.now().toString(36) + '-' + (++sequence) }); dirty = true;
        group.querySelector('[data-setting="name"]').focus();
      }); row.append(summary, add); fields.append(row);
      for (const profile of value.profiles) addProfile(profile);
      refreshSSHList();
    } else if (section === 'web') {
      const card = element('section', 'settings-search-card'); card.setAttribute('aria-label', '网络搜索配置');
      const heading = element('div', 'settings-browser-heading'), badge = element('span', 'settings-browser-badge'); badge.dataset.searchBadge = '';
      heading.append(element('h3', '', '网络搜索'), badge);
      const summary = element('p', 'settings-search-summary settings-card-status'); summary.dataset.searchSummary = ''; summary.setAttribute('role', 'status');
      const common = element('div', 'settings-search-fields');
      const advanced = element('details', 'settings-advanced settings-search-advanced');
      advanced.append(element('summary', '', '服务地址与请求选项'));
      const extra = element('div', 'settings-advanced-fields'); advanced.append(extra);
      const advancedKeys = new Set(['baseURL', 'projectID', 'timeoutMs', 'providerRetryAttempts']);
      const hints = {
        apiKey: '凭据安全保存，不会回显。留空可保留当前服务地址已保存的 Key。',
        searchDepth: '基础适合日常查询；深入用于需要更多信息的任务；快速选项优先响应速度。',
        fallbackToPublicProviders: 'Tavily 未配置或请求失败时，允许尝试公共搜索服务。',
        baseURL: '凭据与服务地址绑定。更换地址后，请为新地址填写 API Key。',
        projectID: '可选；需要关联 Tavily 项目时填写。',
        timeoutMs: '单次请求等待上限，单位为毫秒。',
        providerRetryAttempts: '请求失败后的重试配置，上限为 5。'
      };
      for (const specField of spec.fields) {
        if (specField.key === 'headless') continue;
        const row = field(specField, value[specField.key], data.secretState[section]);
        if (hints[specField.key]) {
          const hint = element('p', 'settings-field-hint', hints[specField.key]); hint.id = 'web-hint-' + specField.key;
          row.querySelector('[data-setting]').setAttribute('aria-describedby', hint.id); row.append(hint);
        }
        (advancedKeys.has(specField.key) ? extra : common).append(row);
      }
      const savedEndpoint = value.baseURL || 'https://api.tavily.com';
      const refresh = () => {
        const key = card.querySelector('[data-setting="apiKey"]');
        const clearing = card.querySelector('[data-clear-secret="apiKey"]').checked;
        const endpoint = card.querySelector('[data-setting="baseURL"]').value.trim() || 'https://api.tavily.com';
        const changedEndpoint = endpoint !== savedEndpoint;
        const saved = !clearing && !changedEndpoint && data.secretState.web?.apiKey;
        const entered = !clearing && Boolean(key.value.trim());
        const fallback = card.querySelector('[data-setting="fallbackToPublicProviders"]').checked;
        badge.textContent = entered ? '新凭据待保存' : saved ? '已保存凭据' : fallback ? '公共搜索回退' : '待配置凭据';
        badge.dataset.state = saved || entered ? 'ready' : fallback ? 'missing' : 'error';
        summary.dataset.error = String(badge.dataset.state === 'error');
        summary.textContent = (changedEndpoint ? '服务地址已修改，原地址的凭据不会自动带入。' : '') +
          (entered ? '保存后将使用新凭据。' : saved ? '当前地址已有凭据，连接可用性以实际请求结果为准。' : fallback ? '未填写 Tavily Key，允许尝试公共搜索服务。' : '没有 Tavily 凭据且已关闭回退，搜索请求可能无法完成。');
        key.placeholder = saved ? '已保存 · 留空保留，输入新值替换' : '填写当前服务地址的 API Key';
        card.querySelector('.settings-secret-help span').textContent = '清除当前服务地址的凭据';
      };
      card.append(heading, element('p', 'settings-card-description', '配置 Tavily 搜索服务，为 Agent 获取网页信息。'), summary, common, advanced); fields.append(card);
      card.addEventListener('input', refresh); card.addEventListener('change', refresh); refresh();
    } else if (isModel) {
      fields.append(modelConnection(spec, value, modelSecretState));
    } else {
      const advancedKeys = modelRoles.some(([key]) => key === section) ? ['contextWindow', 'maxTokens', 'reasoning', 'input', 'compat', 'streamOptions']
        : page === 'skills' ? spec.fields.map(field => field.key)
        : page === 'mcp' ? ['credentials', 'connectTimeoutMs', 'callTimeoutMs', 'maxResultBytes'] : [];
      const advanced = element('details', 'settings-advanced'); advanced.append(element('summary', '', page === 'skills' ? '加载限制' : page === 'mcp' ? '凭据与高级选项' : '高级选项'));
      const body = element('div', 'settings-advanced-fields'); advanced.append(body);
      for (const entry of spec.fields) (advancedKeys.includes(entry.key) ? body : fields).append(field(entry, value[entry.key], modelSecretState));
      if (body.children.length) fields.append(advanced);
    }
    bindProviderPresets();
    const inherit = fields.querySelector('[data-setting="inherit"]');
    if (inherit) {
      const note = element('div', 'settings-inherit-note');
      const model = section === 'summaryModel' && !data.values.reasonModel.inherit ? data.values.reasonModel : data.values.model;
      const source = section === 'summaryModel' ? '思考 Agent 模型' : '默认模型';
      note.append(providerIcon(model.provider), element('div', '', '使用' + source + ' · ' + (data.modelPresets[model.provider]?.label ?? model.provider) + ' / ' + model.modelId));
      note.append(element('p', '', '关闭上方继承开关，即可为此角色选择已有配置或设置独立模型。')); fields.append(note);
      const update = () => { for (const row of fields.children) if (!row.contains(inherit)) row.hidden = row === note ? !inherit.checked : inherit.checked; };
      inherit.addEventListener('change', update); update();
    }
    restoreView(preserve, Boolean(preserve)); status('更改将在下一次运行时生效。');
  }
  function request(action, payload = {}) {
    pendingOpen = undefined;
    requestView = viewState(); requestId = 'settings-' + (++sequence); busy(true, action === 'settingsSave' ? 'save' : 'read');
    $('settings-load-error').hidden = true;
    if (!data) { $('settings-skeleton').hidden = false; fields.hidden = true; }
    clearTimeout(requestTimer);
    const id = requestId;
    const fail = error => {
      if (requestId !== id) return;
      requestId = ''; clearTimeout(requestTimer); busy(false); $('settings-skeleton').hidden = true;
      if (!data) { $('settings-load-error').hidden = false; $('settings-load-error').textContent = window.UBOVMErrors.text(error) + ' 点击“重新载入”重试。'; }
      restoreView(requestView, true); requestView = undefined; status(error, true);
    };
    requestTimer = setTimeout(() => fail('等待配置操作结果超时。输入已保留；请先重新载入确认保存状态，再决定是否重试。'), 30000);
    try { vscode.postMessage({ action, requestId, ...payload }); }
    catch (error) { fail(error); }
    return Boolean(requestId);
  }
  function reload() { guard(() => { dirty = false; if (request('settingsRead')) status('正在读取配置…'); }); }
  form.addEventListener('input', () => { dirty = true; status('有未保存的更改。'); });
  form.addEventListener('change', () => { dirty = true; });
  // Native validation must be able to reveal invalid advanced fields.
  form.addEventListener('invalid', event => {
    for (let parent = event.target.parentElement; parent && parent !== form; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  }, true);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (saving || !data) return;
    try {
      let value;
      if (section === 'ssh') {
        const groups = [...fields.querySelectorAll('.settings-profile')];
        const profiles = groups.map(readFields);
        value = { profiles, defaultId: profiles[groups.findIndex(group => group.querySelector('[data-default-ssh]').checked)]?.id ?? '' };
      } else value = fields.querySelector('[data-setting="inherit"]')?.checked ? { inherit: true } : readFields(fields);
      if (modelRoles.some(([key]) => key === section) && !value.inherit) {
        const library = fields.querySelector('.settings-model-library');
        value.profile = { id: library.dataset.profileId || 'model-' + Date.now().toString(36) + '-' + (++sequence), name: $('settings-model-profile-name').value.trim() || value.modelId };
        selectedModels.set(section, value.profile.id);
      }
      if (request('settingsSave', { section, value, revision: data.revision })) status('正在保存…');
    } catch (error) { status(error.message, true); }
  });
  $('settings-close').addEventListener('click', () => guard(close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); guard(close); });
  $('settings-reload').addEventListener('click', reload);
  $('settings-keep').addEventListener('click', () => { $('settings-discard').hidden = true; closeAction = undefined; if (pendingOpen && !pendingOpen.started) pendingOpen = undefined; $('settings-save').focus(); });
  $('settings-discard-confirm').addEventListener('click', () => { $('settings-discard').hidden = true; invalidateView(); dirty = false; const action = closeAction; closeAction = undefined; action?.(); });
  function finishOpen(pending) {
    if (pending !== pendingOpen || !pending.started) return;
    if (pending.error) {
      clearTimeout(requestTimer);
      busy(false); $('settings-skeleton').hidden = true; $('settings-load-error').hidden = false;
      $('settings-load-error').textContent = pending.error + ' 点击“重新载入”重试。'; status(pending.error, true); return;
    }
    if (!pending.data) return;
    clearTimeout(requestTimer);
    data = pending.data; dirty = false; busy(false); render(); pendingOpen = undefined;
  }
  function beginOpen(pending) {
    if (pending !== pendingOpen) return;
    pending.started = true; page = ['mcp', 'skills'].includes(pending.page) ? pending.page : 'settings'; section = page === 'settings' ? (['model', 'ssh', 'web', 'summary', 'reason', 'worker'].includes(pending.section) ? pending.section : 'model') : page;
    if (pending.data) { showDialog(); finishOpen(pending); return; }
    data = undefined; dirty = false; dialog.dataset.page = page;
    $('settings-title').textContent = page === 'mcp' ? 'MCP 服务' : page === 'skills' ? 'Skills' : '系统配置';
    $('settings-section-kicker').textContent = page === 'settings' ? 'PREFERENCES' : 'EXTENSIONS';
    $('settings-section-title').textContent = page === 'settings' ? '系统配置' : page === 'mcp' ? 'MCP 服务' : 'Skills';
    $('settings-description').textContent = '正在读取配置…'; roles.hidden = true; fields.hidden = true;
    $('settings-skeleton').hidden = false; $('settings-load-error').hidden = true;
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => { if (pending !== pendingOpen) return; pending.error = '配置读取超时，请检查服务状态后重试。'; finishOpen(pending); }, 30000);
    busy(true, 'open'); status('正在读取配置…'); showDialog(); finishOpen(pending);
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'settingsBrowserStatus') {
      if (message.installation?.state !== 'installing') clearTimeout(browserTimer);
      browserInstallation = message.installation || {}; browserInstalling = browserInstallation.state === 'installing'; browserInstallFailed = false; browserInstallResult = ''; refreshBrowserInstall(); return;
    }
    if (message?.type === 'settingsBrowserInstallResult') { clearTimeout(browserTimer); browserInstalling = false; browserInstallFailed = !message.ok; browserInstallation = message.installation || { state: message.ok ? 'ready' : 'error' }; browserInstallResult = message.ok ? message.message || '浏览器已安装。' : window.UBOVMErrors.text(message.failure || message.message); refreshBrowserInstall(); return; }
    if (message?.type === 'settingsSSHTestResult') { finishSSHTest(message.requestId, message); return; }
    if (message?.type === 'settingsLoading') {
      if (saving && operation !== 'open') return;
      const pending = pendingOpen = { requestId: message.requestId, page: message.page, section: message.section, started: false };
      if (dialog.open) guard(() => beginOpen(pending)); else beginOpen(pending);
    } else if (message?.type === 'settingsLoadError') {
      if (!pendingOpen || message.requestId !== pendingOpen.requestId) return;
      pendingOpen.error = window.UBOVMErrors.text(message.failure || message.error || '配置加载失败。'); finishOpen(pendingOpen);
    } else if (message?.type === 'openSettings') {
      if (message.requestId) {
        if (!pendingOpen || message.requestId !== pendingOpen.requestId) return;
        pendingOpen.data = message.data; finishOpen(pendingOpen);
      } else {
        const pending = pendingOpen = { page: message.page, data: message.data, started: false };
        if (dialog.open) guard(() => beginOpen(pending)); else beginOpen(pending);
      }
    } else if (message?.type === 'closeSettings' && dialog.open) { guard(close);
    } else if (message?.type === 'settingsSection' && dialog.open && page === 'settings' && ['model', 'ssh', 'web', 'summary', 'reason', 'worker'].includes(message.section)) { switchTo(message.section);
    } else if (message?.type === 'settingsResult' && requestId && message.requestId === requestId && dialog.open) {
      clearTimeout(requestTimer); requestId = ''; busy(false); $('settings-skeleton').hidden = true;
      if (message.ok === false || message.error || !message.data) {
        const failure = message.failure || message.error || '未收到有效的配置结果，请重新载入。';
        if (!data) { $('settings-load-error').hidden = false; $('settings-load-error').textContent = window.UBOVMErrors.text(failure) + ' 点击“重新载入”重试。'; }
        restoreView(requestView, true); requestView = undefined; status(failure, true); return;
      }
      if (dirty) invalidateView();
      data = message.data; dirty = false; busy(false); render(requestView); requestView = undefined;
      status(message.saved ? '已保存。后续运行将使用新配置。' : '已重新载入配置。');
    }
  });
}
