function createSettingsPanel(vscode) {
  const $ = id => document.getElementById(id);
  const dialog = $('settings-dialog'), form = $('settings-form'), fields = $('settings-fields');
  // Responses from a previous webview generation can arrive after a reload.
  const requestScope = [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
  let data, section = 'model', page = 'settings', dirty = false, saving = false, closeAction, lastFocus, requestId = '', sequence = 0;
  let operation = '', requestView, renderedSection = '', renderedFingerprint = '', navigation = '', pendingOpen;
  let requestTimer;
  let renderFailure;
  let saveUncertain = false;
  let initialStepPending = false;
  let discardView;
  let contentReadySent = false, contentReadyFrame = 0, pageSuspended = false;
  const cancelContentReady = () => { cancelAnimationFrame(contentReadyFrame); contentReadyFrame = 0; };
  function queueContentReady() {
    const visible = () => !pageSuspended && !document.hidden && dialog.open && data && renderedFingerprint && !renderFailure && $('settings-skeleton').hidden && !fields.hidden;
    if (contentReadySent || contentReadyFrame || !visible()) return;
    contentReadyFrame = requestAnimationFrame(() => {
      contentReadyFrame = 0;
      if (!visible()) return;
      contentReadyFrame = requestAnimationFrame(() => {
        contentReadyFrame = 0;
        if (!visible()) return;
        try { vscode.postMessage({ action: 'contentReady' }); contentReadySent = true; }
        catch { /* A later render or visibility recovery retries the acknowledgement. */ }
      });
    });
  }
  window.addEventListener('pagehide', () => { pageSuspended = true; cancelContentReady(); });
  window.addEventListener('pageshow', () => { pageSuspended = false; queueContentReady(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelContentReady(); else queueContentReady(); });
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const setAttribute = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  function validateSnapshot(snapshot, targetPage = page, targetSection = section) {
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!record(snapshot) || typeof snapshot.revision !== 'string' || !record(snapshot.values) || !record(snapshot.sections) || !record(snapshot.secretState)) {
      throw new Error('配置数据不完整，请重新载入后重试。');
    }
    const initialization = snapshot.initialization;
    if ((targetPage === 'initialize' || initialization !== undefined) && (!record(initialization)
      || ['model', 'ssh', 'complete'].some(key => typeof initialization[key] !== 'boolean')
      || initialization.complete !== (initialization.model && initialization.ssh))) {
      throw new Error('初始化状态无效，请重新载入后重试。');
    }
    const required = targetPage === 'initialize' ? ['model', 'ssh', 'web'] : [targetSection];
    if (required.some(key => !record(snapshot.sections[key]) || !Array.isArray(snapshot.sections[key].fields) || !record(snapshot.values[key]))) {
      throw new Error('配置分组不完整，请重新载入后重试。');
    }
    return snapshot;
  }
  function acceptSnapshot(snapshot) {
    const previousRevision = data?.revision;
    data = validateSnapshot(snapshot);
    if (previousRevision !== data.revision) invalidateSSHVerification();
    saveUncertain = false;
    if (data.browserInstallation) {
      browserInstallation = data.browserInstallation;
      trackBrowserInstallation(browserInstallation.state === 'installing');
      browserInstallFailed = false; browserInstallResult = '';
    }
  }
  const views = new Map();
  // Snapshots are immutable; cache per-section keys without retaining old snapshots.
  const fingerprints = new WeakMap();
  const selectedModels = new Map();
  const sshTests = new Map();
  const sshTestResults = new WeakMap();
  function invalidateSSHVerification() {
    for (const [id, pending] of sshTests) if (pending.revision !== data.revision) finishSSHTest(id, { ok: false });
    const groups = new Set(fields.querySelectorAll('.settings-ssh-profile'));
    for (const view of views.values()) for (const node of view.nodes) {
      if (node.matches('.settings-ssh-profile')) groups.add(node);
      for (const group of node.querySelectorAll('.settings-ssh-profile')) groups.add(group);
    }
    for (const group of groups) {
      const result = sshTestResults.get(group);
      if (!result || result.revision === data.revision) continue;
      sshTestResults.delete(group);
      const note = group.querySelector('.settings-ssh-test-status');
      note.dataset.error = 'false'; setText(note, '已保存配置发生变化，请重新测试连接。');
    }
  }
  let browserInstalling = false, browserTimer;
  let browserInstallResult = '';
  let browserInstallation = {}, browserInstallFailed = false;
  function armBrowserWatchdog() {
    clearTimeout(browserTimer);
    browserTimer = setTimeout(() => {
      browserTimer = undefined; browserInstalling = false; browserInstallFailed = true;
      browserInstallResult = '安装结果尚未返回。请查看安装日志并刷新状态，确认是否仍在下载。';
      status(browserInstallResult, true); refreshBrowserInstall();
    }, 600000);
  }
  function trackBrowserInstallation(installing, { heartbeat = false } = {}) {
    browserInstalling = installing;
    if (!installing) { clearTimeout(browserTimer); browserTimer = undefined; return; }
    if (heartbeat || browserTimer === undefined) armBrowserWatchdog();
  }
  function browserAction(action) {
    try { vscode.postMessage({ action }); }
    catch (error) { status(error, true); }
  }
  const setupSteps = [['model', '模型'], ['ssh', '远程环境'], ['web', '可选能力']];
  function sectionKicker() {
    return page === 'initialize' ? '开始配置' : page === 'settings' ? '系统设置' : '扩展能力';
  }
  function readyStatus() {
    return section === 'web' ? '浏览器安装立即生效；其余配置从下一轮对话生效。' : '保存后，下一轮对话生效。';
  }
  const nextSetupSection = () => !data?.initialization?.model ? 'model' : !data?.initialization?.ssh ? 'ssh' : 'web';
  function focusSetupSection() {
    if (page !== 'initialize') return;
    $('settings-init-title')?.focus?.({ preventScroll: true }); form.scrollTop = 0;
  }
  function refreshInitialization() {
    const initializing = page === 'initialize', ready = data?.initialization;
    $('settings-initialization').hidden = !initializing;
    $('settings-finish').hidden = !initializing;
    $('settings-finish').disabled = saving || saveUncertain || Boolean(renderFailure) || !ready?.complete;
    setText($('settings-finish'), operation === 'finish' ? '正在确认配置…' : '完成初始化');
    setText($('settings-close').querySelector('span'), initializing ? '稍后配置' : '返回对话');
    $('settings-close').setAttribute('aria-label', initializing ? '稍后配置' : '返回对话');
    if (!initializing) return;
    setText($('settings-title'), '首次初始化');
    setText($('settings-section-kicker'), '开始配置');
    const stepTitle = section === 'model' ? '配置对话模型' : section === 'ssh' ? '配置远程命令环境' : '可选能力';
    setText($('settings-init-title'), stepTitle);
    setText($('settings-save'), saveUncertain ? '请先确认保存状态' : saving && operation === 'save' ? '正在保存…' : section === 'web' ? '保存可选配置' : !dirty && ready?.[section] ? '继续下一步' : '保存并继续');
    setText($('settings-initialization-status'), !ready ? '正在读取已保存的配置…' : ready.complete
      ? '基础配置已就绪。搜索、浏览器和 MCP 可稍后配置。'
      : `基础配置 ${Number(ready.model) + Number(ready.ssh)}/2 · 请完成` + [!ready.model && '模型', !ready.ssh && '远程环境'].filter(Boolean).join('和') + '。');
    for (const [key, label] of setupSteps) {
      const button = dialog.querySelector(`[data-setup-step="${key}"]`);
      const waiting = !data;
      button.disabled = saving || waiting;
      setAttribute(button, 'aria-busy', String(waiting));
      if (waiting) button.title = '正在读取配置…'; else button.removeAttribute('title');
      setText(button, `${ready?.[key] ? '✓' : setupSteps.findIndex(([step]) => step === key) + 1} · ${label}`);
      if (section === key) { if (button.getAttribute('aria-current') !== 'step') button.setAttribute('aria-current', 'step'); } else button.removeAttribute('aria-current');
    }
  }
  for (const button of dialog.querySelectorAll('[data-setup-step]')) button.addEventListener('click', () => switchTo(button.dataset.setupStep));
  $('settings-finish').addEventListener('click', () => {
    if (!saveUncertain && data?.initialization?.complete) guard(() => {
      // A discarded draft must not survive a failed completion read as a clean form.
      if (!render()) return;
      if (request('settingsRead', {}, 'finish')) status('正在确认最新保存的基础配置…');
    });
  });
  let browserInstallView = '';
  function refreshBrowserInstall() {
    const state = browserInstalling ? 'installing' : browserInstallFailed ? 'error' : browserInstallation.state || 'unknown';
    const percent = browserInstallation.percent;
    const progressText = browserInstalling
      ? (browserInstallation.message || (percent != null ? `正在下载… ${percent}%` : '正在下载 Chromium…'))
      : '';
    const path = browserInstallation.executablePath || '';
    const noteText = browserInstalling
      ? `${progressText} 可继续配置其他选项；失败后可直接重试（已下载部分会被复用）。`
      : browserInstallResult || browserInstallation.message || (state === 'ready' ? '内置 Chromium 已就绪，可立即使用（外部浏览器配置优先）。' : '安装后，对话即可在浏览器中打开和操作网页。');
    const buttonLabel = browserInstalling ? (percent != null ? `正在下载 ${percent}%` : '正在下载并安装…') : state === 'ready' ? '已安装' : browserInstallFailed ? '重试安装' : '下载并安装内置浏览器';
    const badgeLabel = { installing: percent != null ? `${percent}%` : '安装中', ready: '已就绪', missing: '未安装', error: '需要处理', unknown: '尚未检测' }[state] || '尚未检测';
    const view = JSON.stringify([state, browserInstalling, buttonLabel, badgeLabel, noteText, path, percent ?? null]);
    const installButton = fields.querySelector('[data-install-browser]');
    if (view === browserInstallView && installButton?.textContent === buttonLabel) {
      if (browserInstalling && progressText) status(progressText);
      return;
    }
    browserInstallView = view;
    const button = fields.querySelector('[data-install-browser]');
    if (button) {
      const disabled = browserInstalling || state === 'ready';
      if (button.disabled !== disabled) button.disabled = disabled;
      setText(button, buttonLabel);
    }
    const cancel = fields.querySelector('[data-cancel-browser]');
    if (cancel) {
      const hidden = !browserInstalling;
      if (cancel.hidden !== hidden) cancel.hidden = hidden;
      if (cancel.disabled === browserInstalling) cancel.disabled = !browserInstalling;
    }
    const note = fields.querySelector('[data-browser-install-status]');
    if (note) {
      setText(note, noteText);
      setAttribute(note, 'data-error', String(state === 'error'));
    }
    const badge = fields.querySelector('[data-browser-badge]');
    if (badge) { setText(badge, badgeLabel); setAttribute(badge, 'data-state', state); }
    const location = fields.querySelector('[data-browser-location]');
    if (location) {
      setText(location, path); setAttribute(location, 'title', path);
      if (location.parentElement.hidden !== !path) location.parentElement.hidden = !path;
    }
    if (browserInstalling && progressText) status(progressText);
  }
  function finishSSHTest(id, result) {
    const pending = sshTests.get(id); if (!pending) return;
    sshTests.delete(id); clearTimeout(pending.timer);
    pending.button.disabled = false; pending.button.textContent = '测试连接';
    // Cached steps are detached but still owned by this panel. Keep their
    // results current; eviction/removal already unregisters pending tests.
    const currentRevision = pending.revision === data?.revision;
    let unchanged = false;
    try { unchanged = JSON.stringify(readFields(pending.group)) === pending.signature; } catch {}
    unchanged = unchanged && currentRevision;
    if (unchanged) sshTestResults.set(pending.group, { signature: pending.signature, revision: pending.revision }); else sshTestResults.delete(pending.group);
    pending.status.dataset.error = String(unchanged && !result.ok);
    pending.status.textContent = unchanged ? (result.ok ? result.message || '连接成功。' : window.UBOVMErrors.text(result.failure || result.message)) + (result.ok && Number.isFinite(result.durationMs) ? `（${result.durationMs} ms）` : '') : currentRevision ? '配置已更改，请重新测试连接。' : '已保存配置发生变化，请重新测试连接。';
  }
  const modelRoles = [['model', '默认模型'], ['reasonModel', '规划模型'], ['workerModel', '任务模型'], ['summaryModel', '摘要模型']];
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
  function status(text, error = false) {
    const node = $('settings-status'), value = error ? window.UBOVMErrors.text(text) : text;
    if (node.textContent === value && node.dataset.error === String(error)) return;
    node.setAttribute('role', error ? 'alert' : 'status'); node.setAttribute('aria-live', error ? 'assertive' : 'polite'); node.textContent = value; node.dataset.error = String(error);
  }
  function busy(value, kind = '') {
    saving = value; operation = value ? kind : ''; dialog.dataset.operation = operation;
    form.setAttribute('aria-busy', String(value)); $('settings-progress').hidden = !value;
    $('settings-save').disabled = value || saveUncertain || !data || Boolean(renderFailure); $('settings-reload').disabled = value;
    $('settings-render-retry').disabled = value;
    if (page !== 'initialize') setText($('settings-save'), saveUncertain ? '请先确认保存状态' : kind === 'save' && value ? '正在保存…' : '保存更改');
    setText($('settings-reload'), kind === 'read' && value ? '正在载入…' : '重新载入');
    fields.inert = value || Boolean(renderFailure); roles.inert = value;
    refreshInitialization();
  }
  function guard(action) {
    if (saving && operation !== 'open') { status('正在处理配置，请完成后重试。'); return; }
    if (!dirty) return action();
    if ($('settings-discard').hidden) discardView = viewState();
    closeAction = action; $('settings-discard').hidden = false; $('settings-keep').focus();
  }
  function evictView(key) {
    const expired = views.get(key); views.delete(key);
    if (!expired) return;
    releaseViewResources(expired);
  }
  function releaseViewResources(expired) {
    for (const [id, pending] of sshTests) if (expired.nodes.some(node => node.contains(pending.group))) finishSSHTest(id, { ok: false, message: '' });
  }
  function cacheView(key, view) {
    evictView(key);
    // Count serialized metadata as well as DOM text: a collapsed skill can still own a large preview.
    view.bytes = view.fingerprint.length * 2;
    view.nodeCount = 0;
    for (const node of view.nodes) {
      view.nodeCount += 1 + node.querySelectorAll('*').length;
      view.bytes += (node.textContent?.length || 0) * 2;
    }
    if (view.bytes > 1024 * 1024 || view.nodeCount > 1500) { releaseViewResources(view); return; }
    views.set(key, view);
    let bytes = 0, nodes = 0;
    for (const item of views.values()) { bytes += item.bytes; nodes += item.nodeCount; }
    while (views.size > 4 || bytes > 1024 * 1024 || nodes > 1500) {
      const oldest = views.keys().next().value, item = views.get(oldest);
      bytes -= item.bytes; nodes -= item.nodeCount; evictView(oldest);
    }
  }
  function invalidateView() {
    releaseViewResources({ nodes: [...fields.children] });
    evictView(renderedSection); renderedFingerprint = '';
  }
  function close(destination) {
    cancelContentReady();
    try {
      vscode.postMessage({ action: 'settingsNavigation', page: '',
        ...(['assist', 'goal'].includes(destination?.mode) && typeof destination?.sessionId === 'string' ? { mode: destination.mode, sessionId: destination.sessionId } : {}) });
    } catch (error) {
      // Keep the panel usable if the bridge cannot send the close navigation.
      // An explicitly discarded draft must still revert to saved values.
      if (data && !dirty) render();
      status(error, true); return;
    }
    for (const id of sshTests.keys()) finishSSHTest(id, { ok: false, message: '' });
    clearTimeout(requestTimer);
    renderFailure = undefined; $('settings-render-retry').hidden = true;
    dialog.close(); data = undefined; pendingOpen = undefined; initialStepPending = false; requestId = ''; requestView = undefined;
    fields.replaceChildren(); views.clear(); selectedModels.clear(); renderedSection = ''; renderedFingerprint = ''; dirty = false; navigation = ''; busy(false);
    $('settings-discard').hidden = true; closeAction = undefined; discardView = undefined; lastFocus?.focus();
    window.dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: false } }));
  }
  function showDialog() {
    if (dialog.open) return;
    window.UBOVMHtmlPreview?.close();
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
    if (page === 'initialize' && !setupSteps.some(([step]) => step === key)) return;
    if (pendingOpen?.started && operation === 'open') {
      initialStepPending = false;
      section = key; pendingOpen.section = key; refreshInitialization(); publishNavigation(); return;
    }
    if (saving) { status('正在处理配置，请完成后重试。'); return; }
    if (key === section || !data) return;
    guard(() => { section = key; dirty = false; if (render()) focusSetupSection(); if (focusTab) $('settings-tab-' + key)?.focus({ preventScroll: true }); });
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
      for (const option of spec.options) { const row = element('label'); const box = element('input'); box.type = 'checkbox'; box.value = option; box.checked = (value ?? spec.default ?? []).includes(option); row.append(box, element('span', '', spec.labels?.[option] ?? option)); control.append(row); }
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
    if (page === 'initialize' && (section === 'model' && spec.key === 'modelId' || section === 'ssh' && ['host', 'username'].includes(spec.key))) control.required = true;
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
    const search = element('input', 'settings-library-search'); search.type = 'search'; search.placeholder = '搜索服务名称或协议'; search.setAttribute('aria-label', '搜索 MCP 服务');
    const noMatch = element('p', 'settings-empty', '没有匹配的服务，请调整搜索条件。'); noMatch.hidden = true;
    const filter = () => { const query = search.value.trim().toLocaleLowerCase(); const cards = [...list.querySelectorAll('[data-server-card]')]; for (const card of cards) card.hidden = !card.querySelector('.settings-extension-info').textContent.toLocaleLowerCase().includes(query); noMatch.hidden = !cards.length || cards.some(card => !card.hidden); };
    search.addEventListener('input', event => { event.stopPropagation(); filter(); });
    search.addEventListener('change', event => event.stopPropagation());
    search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    const summary = element('div', 'settings-library-summary'); summary.setAttribute('role', 'status');
    const refresh = () => {
      const cards = [...root.querySelectorAll('[data-server-card]')];
      const enabled = cards.filter(card => card.querySelector('[data-setting="enabled"]').checked).length;
      summary.textContent = cards.length + ' 个服务 · ' + enabled + ' 个已启用';
      list.querySelector('.settings-empty')?.remove();
      if (!cards.length) list.append(element('div', 'settings-empty', '尚未添加服务。连接本地工具或远程 MCP 后，对话就能调用它们。'));
      filter();
    };
    root.append(toolbar, search, list, noMatch, element('p', 'settings-library-hint', '保存后在下次任务运行时连接。已启用仅表示允许加载，不代表连接成功。')); 
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
        for (const item of grid.querySelectorAll('[data-setting]')) if (['command', 'args', 'cwd', 'url'].includes(item.dataset.setting)) item.closest('.settings-field').hidden = item.dataset.setting === 'url' ? transport.value === 'stdio' : transport.value !== 'stdio';
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
    add.addEventListener('click', () => { search.value = ''; appendServer({ name: 'server-' + (++sequence), enabled: true }, true); refresh(); dirty = true; root.querySelector('[data-server-card]:last-of-type [data-setting="name"]')?.focus(); }); return root;
  }
  function skillLibrary() {
    const catalog = data.skillsCatalog;
    const items = catalog?.items ?? [];
    const root = element('section', 'settings-skill-library wide'); root.setAttribute('aria-label', '已发现的技能');
    const toolbar = element('div', 'settings-library-toolbar');
    const summary = element('div', 'settings-library-summary'); summary.setAttribute('role', 'status');
    const search = element('input', 'settings-library-search'); search.type = 'search'; search.placeholder = '搜索技能名称或描述'; search.setAttribute('aria-label', '搜索技能');
    toolbar.append(summary, search); root.append(toolbar);
    const grid = element('div', 'settings-skill-grid');
    const pager = element('div', 'settings-library-toolbar settings-library-pagination');
    const previous = element('button', '', '上一页'), next = element('button', '', '下一页'); previous.type = next.type = 'button';
    const range = element('span', 'settings-library-hint'); range.setAttribute('role', 'status');
    pager.append(previous, range, next);
    let offset = 0;
    function renderSkills() {
      const query = search.value.trim().toLocaleLowerCase();
      const filtered = items.filter(skill => (skill.name + ' ' + skill.description).toLocaleLowerCase().includes(query));
      offset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / 30) - 1) * 30);
      summary.textContent = query ? '找到 ' + filtered.length + ' / ' + items.length + ' 个技能' : '已发现 ' + items.length + ' 个技能';
      grid.replaceChildren();
      for (const skill of filtered.slice(offset, offset + 30)) {
        const card = element('details', 'settings-skill-card');
        const heading = element('summary', 'settings-extension-header');
        const icon = element('span', 'settings-extension-icon', '◇'); icon.setAttribute('aria-hidden', 'true');
        const info = element('div', 'settings-extension-info'); info.append(element('h4', '', skill.name), element('p', '', skill.description));
        const chevron = element('span', 'settings-row-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
        heading.append(icon, info, element('span', 'settings-skill-badge', skill.contentError ? '预览不可用' : skill.builtin ? '内置' : '已安装'), chevron);
        const detail = element('div', 'settings-skill-detail');
        card.addEventListener('toggle', () => {
          detail.replaceChildren();
          if (!card.open || !card.isConnected) return;
          detail.append(element('p', '', '技能内容 · 任务运行时按需激活'));
          if (typeof skill.content === 'string') {
            const content = element('pre', 'settings-skill-content', skill.content || '此技能暂无内容。');
            content.tabIndex = 0; content.setAttribute('role', 'region'); content.setAttribute('aria-label', skill.name + ' 技能内容'); detail.append(content);
          } else detail.append(element('p', 'settings-catalog-error', skill.contentError || '暂时无法读取技能内容，请重新载入。'));
        });
        card.append(heading, detail); grid.append(card);
      }
      if (!filtered.length) grid.append(element('p', 'settings-empty', query ? '没有匹配的技能，请调整搜索条件。' : '尚未发现技能，安装后点击“重新载入”。'));
      pager.hidden = filtered.length <= 30; previous.disabled = offset === 0; next.disabled = offset + 30 >= filtered.length;
      range.textContent = filtered.length ? (offset + 1) + '–' + Math.min(offset + 30, filtered.length) + ' / ' + filtered.length : '0 个技能';
    }
    search.addEventListener('input', event => { event.stopPropagation(); offset = 0; renderSkills(); });
    search.addEventListener('change', event => event.stopPropagation());
    search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    previous.addEventListener('click', () => { offset -= 30; renderSkills(); });
    next.addEventListener('click', () => { offset += 30; renderSkills(); });
    root.append(grid, pager, element('p', 'settings-library-hint', '列表表示已发现的技能，不代表已激活。点击展开预览；更新文件后点击“重新载入”。'));
    for (const error of catalog?.errors ?? []) root.append(element('p', 'settings-catalog-error', error));
    renderSkills(); return root;
  }
  function bindProviderPresets() {
    const provider = fields.querySelector('[data-setting="provider"]'); if (!provider) return;
    provider.addEventListener('change', () => {
      const preset = { ...(data.modelPresets[provider.value] ?? data.modelPresets.custom) };
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
      markDirty(); status('已填入服务商预设；检查配置后保存。');
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
    if (page === 'initialize') advanced.open = false;
    grid.append(connection, auth, advanced);
    const actions = element('div', 'settings-ssh-actions'), label = element('label', 'settings-ssh-default'), radio = element('input'); radio.type = 'radio'; radio.name = 'settings-default-ssh'; radio.dataset.defaultSsh = '';
    radio.checked = value.id === data.values.ssh.defaultId || !fields.querySelector('.settings-profile');
    radio.addEventListener('change', refreshSSHList);
    label.append(radio, element('span', '', '默认连接'));
    const remove = element('button', 'settings-ssh-remove', '移除连接'); remove.type = 'button'; remove.addEventListener('click', () => {
      for (const [id, pending] of sshTests) if (pending.group === group) { clearTimeout(pending.timer); sshTests.delete(id); }
      group.remove(); markDirty();
      if (!fields.querySelector('[data-default-ssh]:checked')) { const first = fields.querySelector('[data-default-ssh]'); if (first) first.checked = true; }
      refreshSSHList(); $('settings-add-ssh').focus();
    });
    const test = element('button', 'settings-ssh-test', '测试连接'); test.type = 'button';
    const testStatus = element('p', 'settings-ssh-test-status'); testStatus.setAttribute('role', 'status');
    test.addEventListener('click', () => {
      let id;
      sshTestResults.delete(group);
      try {
        const profile = readFields(group); id = 'ssh-test-' + requestScope + '-' + (++sequence);
        test.disabled = true; test.textContent = '正在测试…'; testStatus.dataset.error = 'false'; testStatus.textContent = '正在验证连接与登录认证（最多 30 秒）…';
        const timer = setTimeout(() => finishSSHTest(id, { ok: false, message: '连接测试超时，请重试。' }), 35000);
        sshTests.set(id, { group, button: test, status: testStatus, signature: JSON.stringify(profile), revision: data.revision, timer });
        const failed = () => finishSSHTest(id, { ok: false, message: '连接测试请求发送失败，请重试。' });
        Promise.resolve(vscode.postMessage({ action: 'settingsTestSSH', requestId: id, profile })).then(value => {
          if (value === false) failed();
        }, failed);
      } catch (error) { if (id) { clearTimeout(sshTests.get(id)?.timer); sshTests.delete(id); } test.disabled = false; test.textContent = '测试连接'; testStatus.dataset.error = 'true'; testStatus.textContent = window.UBOVMErrors.text(error); }
    });
    const duplicate = element('button', '', '复制连接'); duplicate.type = 'button';
    duplicate.addEventListener('click', () => {
      try {
        const copy = readFields(group);
        delete copy.password; delete copy.private_key_passphrase;
        addProfile({ ...copy, id: 'server-' + Date.now().toString(36) + '-' + (++sequence), name: (copy.name || copy.host || 'SSH') + ' 副本' });
        markDirty(); status('已复制连接参数，请为新连接填写密码或私钥口令后保存。');
      } catch (error) { status(error.message, true); }
    });
    const identity = element('div', 'settings-ssh-identity'); identity.append(title, endpoint);
    const header = element('div', 'settings-ssh-card-header'); header.append(identity, label);
    const secondary = element('div', 'settings-ssh-secondary'); secondary.append(duplicate, remove);
    actions.append(test, secondary);
    group.append(header, actions, testStatus, grid); fields.append(group);
    const updateIdentity = () => {
      const read = key => group.querySelector(`[data-setting="${key}"]`).value.trim();
      setText(title, read('name') || read('host') || '新 SSH 连接');
      setText(endpoint, read('host') ? (read('username') ? read('username') + '@' : '') + read('host') + ':' + (read('port') || '22') : '填写主机地址与登录信息');
      const signature = sshTestResults.get(group)?.signature;
      if (signature !== undefined) {
        let unchanged = false;
        try { unchanged = JSON.stringify(readFields(group)) === signature; } catch {}
        if (!unchanged) {
          sshTestResults.delete(group);
          testStatus.dataset.error = 'false';
          setText(testStatus, '配置已更改，请重新测试连接。');
        }
      }
    };
    group.addEventListener('input', updateIdentity); group.addEventListener('change', updateIdentity); updateIdentity(); refreshSSHList();
    return group;
  }
  function savedModelProfile(value) {
    const library = data.modelProfiles ?? [];
    const matches = p => Object.keys(p.model).every(key => JSON.stringify(p.model[key]) === JSON.stringify(value[key]));
    return library.find(p => p.id === selectedModels.get(section) && matches(p)) ?? library.find(matches);
  }
  function modelLibrary(value, draft) {
    const library = data.modelProfiles ?? [];
    const matched = draft ?? savedModelProfile(value);
    const card = element('section', 'settings-model-library');
    const heading = element('div', 'settings-model-heading');
    heading.append(element('h4', '', '已保存的模型'), element('span', 'settings-model-count', library.length + ' 个配置'));
    const search = element('input'); search.type = 'search'; search.placeholder = '搜索配置、服务商或模型'; search.setAttribute('aria-label', '搜索已保存模型');
    const preview = element('p', 'settings-model-preview'); preview.setAttribute('role', 'status');
    const load = element('button', '', '加载到当前角色'); load.type = 'button';
    const label = element('label', '', '已保存的模型配置'), select = element('select'); select.id = 'settings-model-profile'; label.htmlFor = select.id;
    select.size = 3;
    select.append(new Option('选择一份配置以查看详情', ''));
    for (const profile of library) select.append(new Option(profile.name + ' · ' + profile.model.modelId, profile.id));
    select.value = matched?.id ?? '';
    const nameLabel = element('label', '', '配置名称'), name = element('input'); name.id = 'settings-model-profile-name'; nameLabel.htmlFor = name.id;
    name.type = 'text'; name.maxLength = 80; name.placeholder = '例如：日常对话、代码模型'; name.value = matched?.name ?? '';
    card.dataset.profileId = matched?.id ?? '';
    const hint = element('p', 'settings-model-hint'); hint.setAttribute('role', 'status');
    const refreshSaveHint = () => {
      const saved = library.find(p => p.id === card.dataset.profileId);
      hint.textContent = (saved ? `保存将更新“${saved.name}”` : '保存将新增一份配置') + '，应用到' + modelRoles.find(([key]) => key === section)[1] + '。';
    };
    const previewSelection = () => {
      const selected = library.find(p => p.id === select.value);
      load.disabled = !selected;
      preview.textContent = selected ? `${data.modelPresets[selected.model.provider]?.label ?? selected.model.provider} · ${selected.model.modelId}\n${selected.model.baseUrl || '使用默认服务地址'}`
        : library.length ? '先选择，再加载。浏览列表不会修改当前配置。' : '首次使用：填写连接设置并保存，之后可从这里复用。';
    };
    search.addEventListener('input', event => {
      event.stopPropagation();
      const query = search.value.trim().toLocaleLowerCase(), previous = select.value;
      const found = library.filter(p => [p.name, p.model.backend ?? 'pi', p.model.provider, p.model.modelId].join(' ').toLocaleLowerCase().includes(query));
      select.replaceChildren(new Option(found.length ? '选择一份配置以查看详情' : '没有匹配的配置', ''), ...found.map(p => new Option(p.name + ' · ' + p.model.modelId, p.id)));
      select.value = found.some(p => p.id === previous) ? previous : '';
      previewSelection();
    });
    search.addEventListener('change', event => event.stopPropagation());
    select.addEventListener('input', event => event.stopPropagation());
    select.addEventListener('change', event => {
      event.stopPropagation(); previewSelection();
    });
    load.addEventListener('click', () => {
      const next = library.find(p => p.id === select.value);
      if (!next) return;
      guard(() => { invalidateView(); dirty = false; render(undefined, next); dirty = true; });
    });
    const actions = element('div', 'settings-model-actions');
    const add = element('button', '', '另存为新配置'); add.type = 'button';
    add.addEventListener('click', () => { card.dataset.profileId = ''; name.value = name.value ? (name.value.slice(0, 77) + ' 副本') : ''; remove.disabled = true; dirty = true; refreshSaveHint(); status('正在编辑副本，保存后新增配置。'); name.focus(); });
    const remove = element('button', 'settings-model-remove', '删除已保存配置'); remove.type = 'button'; remove.disabled = !library.some(p => p.id === card.dataset.profileId);
    remove.title = '从配置库移除，角色当前使用的模型仍会保留';
    remove.addEventListener('click', () => guard(() => {
      if (request('settingsSave', { section, value: { deleteProfileId: card.dataset.profileId }, revision: data.revision })) status('正在删除配置…');
    }));
    actions.append(add, remove);
    const controls = element('div', 'settings-model-library-fields');
    const choice = element('div'), naming = element('div'); choice.className = 'settings-model-browser'; naming.className = 'settings-model-editing';
    choice.append(label, search, select, preview, load); naming.append(element('span', 'settings-model-editing-title', '当前编辑'), nameLabel, name, hint, actions); controls.append(choice, naming);
    previewSelection(); refreshSaveHint();
    card.append(heading, controls);
    return card;
  }
  function modelConnection(spec, value, secretState) {
    const card = element('section', 'settings-model-connection'); card.setAttribute('aria-label', '模型连接设置');
    const heading = element('div', 'settings-model-heading'), badge = element('span', 'settings-model-credential');
    badge.setAttribute('role', 'status'); heading.append(element('h4', '', '连接参数'), badge);
    const common = element('div', 'settings-model-connection-fields');
    const advanced = element('details', 'settings-advanced settings-model-advanced');
    advanced.append(element('summary', '', '高级选项 · 容量、推理与请求参数'));
    const extra = element('div', 'settings-advanced-fields'); advanced.append(extra);
    for (const entry of spec.fields) {
      if (entry.key === 'inherit') continue;
      const row = field(entry.key === 'modelId' ? { ...entry, label: '模型 ID' } : entry, value[entry.key], secretState);
      (['provider', 'modelId', 'api', 'baseUrl', 'apiKey'].includes(entry.key) ? common : extra).append(row);
      const help = { modelId: '填写服务商提供的模型标识。', api: '与服务商接口一致；通常可保留预设。', baseUrl: '自建或代理服务请填写对应的 API 根地址。' }[entry.key];
      if (help) row.append(element('p', 'settings-model-hint', help));
    }
    const keyRow = common.querySelector('[data-field="apiKey"]');
    keyRow.append(element('p', 'settings-model-hint', '留空保留已存密钥。同一服务商、同一 API 地址共用凭据。'));
    const protocolNote = element('p', 'settings-model-hint'); protocolNote.dataset.sdkProtocol = '';
    protocolNote.textContent = '选择服务商后会填入预设，确认模型与地址，再填写 API Key。';
    card.append(heading, protocolNote, common, advanced);
    const provider = common.querySelector('[data-setting="provider"]');
    const custom = common.querySelector(`[data-custom-for="${provider.id}"]`);
    const baseUrl = common.querySelector('[data-setting="baseUrl"]');
    const clearKey = common.querySelector('[data-clear-secret="apiKey"]');
    const key = common.querySelector('[data-setting="apiKey"]');
    const clearLabel = keyRow.querySelector('.settings-secret-help span');
    let credentialState, keyPresent;
    const refresh = () => {
      const endpointChanged = (provider.value === '__custom__' ? custom.value.trim() : provider.value) !== value.provider
        || baseUrl.value.trim() !== (value.baseUrl ?? '');
      const clear = clearKey.checked, entered = Boolean(key.value.trim());
      keyPresent = entered;
      const next = `${endpointChanged}:${clear}:${entered}`;
      if (next === credentialState) return;
      credentialState = next;
      const label = clear ? '凭据待清除' : entered ? '新凭据待保存' : endpointChanged ? '端点已更改' : secretState?.apiKey ? '凭据已保存' : '未填写凭据';
      if (badge.textContent !== label) badge.textContent = label;
      const saved = String(!clear && !endpointChanged && Boolean(secretState?.apiKey));
      if (badge.dataset.saved !== saved) badge.dataset.saved = saved;
      const placeholder = !endpointChanged && secretState?.apiKey ? '已保存 · 留空保留，输入新值替换' : '填写当前端点的密钥；留空保留该端点已存凭据';
      if (key.placeholder !== placeholder) key.placeholder = placeholder;
      const help = !endpointChanged && secretState?.apiKey ? '清除已保存的凭据' : '清除当前端点已保存的凭据';
      if (clearLabel.textContent !== help) clearLabel.textContent = help;
    };
    const refreshCredentials = event => {
      // Ordinary typing changes the secret, not its UI state. Avoid consulting
      // the styled provider select or writing DOM again until emptiness changes.
      if (event.target === key && Boolean(key.value.trim()) === keyPresent) return;
      if ([provider, custom, baseUrl, key, clearKey].includes(event.target)) refresh();
    };
    card.addEventListener('input', refreshCredentials); card.addEventListener('change', refreshCredentials); refresh();
    return card;
  }
  function collaborationGuide() {
    const card = element('section', 'settings-cooperation-guide');
    card.dataset.cooperationGuide = ''; card.setAttribute('aria-label', '模型与协作关系');
    const help = element('details', 'settings-model-help');
    help.append(element('summary', '', '模型和并行任务如何配合？'));
    const steps = element('ol');
    for (const [title, text] of [
      ['连接', '配置库保存可重复使用的模型连接，默认模型即可开始对话。'],
      ['角色', '默认模型用于对话，规划模型用于拆步骤，任务模型用于子任务，摘要模型用于压缩上下文。继承时无需重复配置。'],
      ['协作', '复杂请求会拆成多个并行任务。固定模式共用任务模型，自主选择模式可选用配置库中的模型。'],
    ]) { const row = element('li'); row.append(element('strong', '', title), element('span', '', text)); steps.append(row); }
    help.append(steps);
    const current = element('p', 'settings-cooperation-current'); current.setAttribute('role', 'status');
    const describe = model => model?.modelId || '尚未配置模型';
    const main = data.values.model, worker = data.values.workerModel;
    const workerModel = worker?.inherit === false ? worker : main;
    const refresh = () => {
      const mode = fields.querySelector('[data-setting="swarmBackendSelection"]')?.value ?? data.values.worker?.swarmBackendSelection ?? 'fixed';
      current.textContent = `主对话：${describe(main)}\n子任务：${describe(workerModel)}`;
      const note = mode === 'autonomous'
        ? '自主选择：主对话模型保持不变，子任务可从已配置的角色和配置库里选模型。请先保存要用的模型和密钥。'
        : '固定模式：子任务统一使用任务模型。只想用一个模型时，配置默认模型并保持任务模型继承即可。';
      explanation.textContent = note + ' 更改保存后，下一轮对话生效。';
    };
    const explanation = element('p', 'settings-model-hint');
    const action = element('button', '', section === 'worker' ? '选择任务模型 →' : '设置并行任务模式 →'); action.type = 'button';
    action.addEventListener('click', () => switchTo(section === 'worker' ? 'workerModel' : 'worker', true));
    help.append(explanation); card.append(current, help, action);
    card.refresh = refresh; refresh(); return card;
  }
  function capabilityOverview() {
    const sshProfiles = data.values.ssh?.profiles ?? [];
    const sshReady = sshProfiles.some(profile => profile.host && profile.username);
    const defaultId = data.values.ssh?.defaultId;
    const defaultSsh = sshProfiles.find(profile => profile.id === defaultId) || sshProfiles.find(profile => profile.host);
    const mcpServers = (data.values.mcp?.servers ?? []).filter(server => server.enabled !== false);
    const searchKey = data.secretState.web?.apiKey;
    const fallback = data.values.web?.fallbackToPublicProviders !== false;
    const ideBrowser = data.values.web?.ideBrowser !== false;
    const browserReady = ideBrowser || data.browserInstallation?.state === 'ready';
    const modelId = data.values.model?.modelId;
    const items = [
      ['对话', modelId || '待配置', Boolean(modelId)],
      ['远程命令', sshReady ? (defaultSsh?.name || defaultSsh?.host || '已配置') : '未配置', sshReady],
      ['浏览网页', browserReady ? (ideBrowser ? 'IDE 内嵌' : '独立浏览器') : '待安装', browserReady],
      ['网络搜索', searchKey ? '已配置' : fallback ? '公共回退' : '待配置', Boolean(searchKey || fallback)],
      ['Python', '本地沙箱', true],
      ['MCP', mcpServers.length ? mcpServers.length + ' 个服务' : '未连接', mcpServers.length > 0]
    ];
    const card = element('section', 'settings-capability-overview');
    card.dataset.capabilityOverview = '';
    card.setAttribute('aria-label', '当前可用能力');
    card.append(element('h4', '', '当前能力'));
    const list = element('ul', 'settings-capability-list');
    for (const [name, detail, ready] of items) {
      const item = element('li');
      item.dataset.ready = String(ready);
      item.append(element('span', 'settings-capability-name', name), element('span', 'settings-capability-detail', detail));
      list.append(item);
    }
    card.append(list);
    return card;
  }
  function render(preserve, modelDraft) {
    const previous = { section: renderedSection, nodes: [...fields.children], view: viewState() }, recovering = Boolean(renderFailure);
    renderFailure = undefined;
    try {
      renderContent(preserve, modelDraft);
      $('settings-render-retry').hidden = true;
      if (recovering) busy(false);
      queueContentReady();
      return true;
    }
    catch {
      evictView(section); renderedFingerprint = '';
      renderFailure = { preserve: preserve ?? previous.view, modelDraft };
      busy(false);
      // Keep the existing form available when rebuilding the same section fails.
      if (previous.section === section) fields.replaceChildren(...previous.nodes);
      else { fields.replaceChildren(); renderedSection = ''; }
      fields.hidden = !fields.children.length;
      $('settings-skeleton').hidden = true; $('settings-load-error').hidden = false;
      $('settings-load-error').textContent = '当前步骤显示失败，已保留可用输入。可重新显示当前步骤，或重新载入配置。';
      $('settings-render-retry').hidden = false;
      $('settings-save').disabled = true;
      status('页面渲染失败，请恢复当前步骤后继续。', true);
      return false;
    }
  }
  function renderContent(preserve, modelDraft) {
    const spec = data.sections[section], value = modelDraft ? { ...modelDraft.model, ...(section === 'model' ? {} : { inherit: false }) } : data.values[section] ?? {};
    const modelSecretState = modelDraft?.secretState ?? data.secretState[section];
    let keys = fingerprints.get(data);
    if (!keys) { keys = new Map(); fingerprints.set(data, keys); }
    const fingerprintKey = page + ':' + section;
    let fingerprint = modelDraft ? undefined : keys.get(fingerprintKey);
    if (fingerprint === undefined) {
      fingerprint = JSON.stringify([page, spec, value, data.secretState[section], [data.values.model, data.values.workerModel, data.values.worker?.swarmBackendSelection], section === 'ssh' ? data.sshFields : section === 'mcp' ? data.mcpFields : null,
        modelRoles.some(([key]) => key === section) ? [data.modelPresets, data.values.model, section === 'summaryModel' ? data.values.reasonModel : null, data.modelProfiles, modelDraft?.id] : null,         section === 'skills' ? data.skillsCatalog : null, page === 'settings' && section === 'model' ? [data.values.ssh?.profiles, data.values.web, data.values.mcp?.servers, data.secretState.web, data.browserInstallation?.state] : null]);
      if (!modelDraft) keys.set(fingerprintKey, fingerprint);
    }
    const unchanged = renderedSection === section && renderedFingerprint === fingerprint;
    if (!unchanged && renderedSection && renderedFingerprint && !dirty) {
      cacheView(renderedSection, { fingerprint: renderedFingerprint, nodes: [...fields.children], view: viewState() });
    }
    const cached = views.get(section);
    dialog.dataset.page = page;
    $('settings-skeleton').hidden = true; $('settings-load-error').hidden = true; fields.hidden = false;
    setText($('settings-title'), page === 'initialize' ? '首次初始化' : page === 'mcp' ? 'MCP 服务' : page === 'skills' ? 'Skills' : '系统配置');
    setText($('settings-section-kicker'), sectionKicker());
    const isModel = modelRoles.some(([key]) => key === section);
    setText($('settings-section-title'), isModel ? data.sections.model.title : section === 'web' ? '浏览器与搜索' : spec.title);
    const description = page === 'initialize' && section === 'ssh' ? '填写主机、用户名和认证信息。可先测试连接，再保存为默认远程环境。'
      : page === 'initialize' && section === 'web' ? '浏览器与网络搜索均可选。不配也能完成初始化，之后随时可补。'
      : spec.description;
    setText($('settings-description'), description);
    publishNavigation();
    roles.hidden = !isModel;
    refreshInitialization();
    for (const button of roles.children) { const selected = button.dataset.role === section; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    fields.setAttribute('role', isModel && page !== 'initialize' ? 'tabpanel' : 'group');
    fields.setAttribute('aria-labelledby', isModel && page !== 'initialize' ? 'settings-tab-' + section : 'settings-section-title');
    if (unchanged || cached?.fingerprint === fingerprint) {
      if (!unchanged) { fields.replaceChildren(...cached.nodes); views.delete(section); }
      renderedSection = section; renderedFingerprint = fingerprint;
      refreshBrowserInstall();
      restoreView(preserve ?? (unchanged ? viewState() : cached.view), Boolean(preserve));
      status(readyStatus());
      return;
    }
    evictView(section);
    fields.replaceChildren();
    renderedSection = section; renderedFingerprint = '';
    if (isModel) {
      const inheritField = spec.fields.find(entry => entry.key === 'inherit');
      if (inheritField) { const row = field(inheritField, value.inherit); row.classList.add('settings-model-inherit'); fields.append(row); }
      if (page !== 'initialize') fields.append(modelLibrary(value, modelDraft));
    }
    if (section === 'skills') fields.append(skillLibrary());
    if (section === 'web') {
      const card = element('section', 'settings-browser-card wide'); card.setAttribute('aria-label', '内置浏览器');
      const heading = element('div', 'settings-browser-heading'), badge = element('span', 'settings-browser-badge'); badge.dataset.browserBadge = '';
      heading.append(element('h3', '', '内置浏览器'), badge);
      card.append(heading, element('p', 'settings-card-description', '默认在 IDE 内嵌浏览器中查看网页；对话操作时页面只读。也可安装独立 Chromium 作为回退。'));
      const ide = field(spec.fields.find(entry => entry.key === 'ideBrowser'), value.ideBrowser !== false, data.secretState[section]);
      const ideHint = element('p', 'settings-field-hint', '开启后在编辑器内查看网页；操作期间显示只读遮盖。关闭后改用下方独立 Chromium。');
      ideHint.id = 'web-hint-ideBrowser'; ide.querySelector('[data-setting]').setAttribute('aria-describedby', ideHint.id);
      ide.append(ideHint);
      const mode = field(spec.fields.find(entry => entry.key === 'headless'), value.headless, data.secretState[section]);
      const modeHint = element('p', 'settings-field-hint', '仅在关闭 IDE 内嵌浏览器时生效。关闭无头后显示独立浏览器窗口，下次启动生效。');
      modeHint.id = 'web-hint-headless'; mode.querySelector('[data-setting]').setAttribute('aria-describedby', modeHint.id);
      mode.append(modeHint);
      const button = element('button'); button.type = 'button'; button.dataset.installBrowser = '';
      const cancel = element('button', '', '取消'); cancel.type = 'button'; cancel.dataset.cancelBrowser = ''; cancel.hidden = true;
      const note = element('p', 'settings-card-status'); note.dataset.browserInstallStatus = ''; note.setAttribute('role', 'status');
      button.addEventListener('click', () => {
        if (browserInstalling) return;
        trackBrowserInstallation(true); browserInstallFailed = false; browserInstallResult = ''; refreshBrowserInstall();
        try { vscode.postMessage({ action: 'settingsInstallBrowser' }); }
        catch (error) { trackBrowserInstallation(false); browserInstallFailed = true; browserInstallResult = window.UBOVMErrors.text(error); refreshBrowserInstall(); }
      });
      cancel.addEventListener('click', () => browserAction('settingsCancelBrowserInstall'));
      const actions = element('div', 'settings-browser-actions'), check = element('button', '', '检查状态'), logs = element('button', '', '查看安装日志');
      check.type = logs.type = 'button';
      check.addEventListener('click', () => browserAction('settingsBrowserStatus'));
      logs.addEventListener('click', () => browserAction('settingsBrowserLogs'));
      actions.append(button, cancel, check, logs);
      const details = element('details', 'settings-browser-details'), location = element('code'); location.dataset.browserLocation = '';
      location.tabIndex = 0; location.setAttribute('aria-label', '浏览器可执行文件完整路径');
      details.append(element('summary', '', '浏览器文件位置'), location);
      card.append(note, actions, ide, mode, details, element('p', 'settings-browser-hint', '安装无需保存配置。已有外部浏览器连接或路径配置时，独立模式优先使用外部浏览器。'));
      fields.append(card); refreshBrowserInstall();
    }
    if (section === 'ssh') {
      const row = element('div', 'settings-ssh-toolbar'), add = element('button', '', '+ 添加 SSH 连接'); add.id = 'settings-add-ssh'; add.type = 'button';
      const summary = element('span'); summary.dataset.sshCount = '';
      add.addEventListener('click', () => {
        const group = addProfile({ id: 'server-' + Date.now().toString(36) + '-' + (++sequence) }); markDirty();
        group.querySelector('[data-setting="name"]').focus();
      }); row.append(summary, add); fields.append(row);
      for (const profile of value.profiles) addProfile(profile);
      if (page === 'initialize' && !value.profiles.length) addProfile({ id: 'server-' + Date.now().toString(36) + '-' + (++sequence) });
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
      const optional = page === 'initialize' ? element('details', 'settings-advanced settings-search-optional') : null;
      if (optional) {
        optional.append(element('summary', '', '可选：联网搜索（Tavily）'));
        optional.append(element('p', 'settings-card-description', '可跳过。配置后对话可以检索网页信息。'));
      }
      for (const specField of spec.fields) {
        if (specField.key === 'headless' || specField.key === 'ideBrowser') continue;
        const row = field(specField, value[specField.key], data.secretState[section]);
        if (hints[specField.key]) {
          const hint = element('p', 'settings-field-hint', hints[specField.key]); hint.id = 'web-hint-' + specField.key;
          row.querySelector('[data-setting]').setAttribute('aria-describedby', hint.id); row.append(hint);
        }
        (advancedKeys.has(specField.key) ? extra : common).append(row);
      }
      if (optional) optional.append(common, advanced);
      const savedEndpoint = value.baseURL || 'https://api.tavily.com';
      const refresh = () => {
        const key = card.querySelector('[data-setting="apiKey"]');
        const clearing = card.querySelector('[data-clear-secret="apiKey"]').checked;
        const endpoint = card.querySelector('[data-setting="baseURL"]').value.trim() || 'https://api.tavily.com';
        const changedEndpoint = endpoint !== savedEndpoint;
        const saved = !clearing && !changedEndpoint && data.secretState.web?.apiKey;
        const entered = !clearing && Boolean(key.value.trim());
        const fallback = card.querySelector('[data-setting="fallbackToPublicProviders"]').checked;
        setText(badge, entered ? '新凭据待保存' : saved ? '已保存凭据' : fallback ? '公共搜索回退' : '待配置凭据');
        setAttribute(badge, 'data-state', saved || entered ? 'ready' : fallback ? 'missing' : 'error');
        setAttribute(summary, 'data-error', String(badge.dataset.state === 'error'));
        setText(summary, (changedEndpoint ? '服务地址已修改，原地址的凭据不会自动带入。' : '') +
          (entered ? '保存后将使用新凭据。' : saved ? '当前地址已有凭据，连接可用性以实际请求结果为准。' : fallback ? '未填写 Tavily Key，允许尝试公共搜索服务。' : '没有 Tavily 凭据且已关闭回退，搜索请求可能无法完成。'));
        setAttribute(key, 'placeholder', saved ? '已保存 · 留空保留，输入新值替换' : '填写当前服务地址的 API Key');
        setText(card.querySelector('.settings-secret-help span'), '清除当前服务地址的凭据');
      };
      if (optional) {
        card.append(heading, summary, optional);
      } else {
        card.append(heading, element('p', 'settings-card-description', '配置 Tavily 后即可检索网页；也可以只使用公共搜索回退。'), summary, common, advanced);
      }
      fields.append(card);
      card.addEventListener('input', refresh); card.addEventListener('change', refresh); refresh();
    } else if (isModel) {
      fields.append(modelConnection(spec, value, modelSecretState));
    } else {
      const advancedKeys = modelRoles.some(([key]) => key === section) ? ['contextWindow', 'maxTokens', 'reasoning', 'input', 'compat', 'streamOptions']
        : page === 'skills' ? spec.fields.map(field => field.key)
        : page === 'mcp' ? ['credentials', 'connectTimeoutMs', 'callTimeoutMs', 'maxResultBytes']
        : section === 'python' ? ['maxTimeoutSeconds', 'maxOutputBytes']
        : section === 'reason' ? ['maxIntents', 'maxRepairs', 'maxResponseBytes', 'systemPrompt']
        : section === 'worker' ? ['maxModelCalls', 'maxToolCalls', 'maxPlanSteps', 'maxResponseBytes', 'maxCheckpointBytes', 'maxToolResultBytes', 'systemPrompt'] : [];
      const advanced = element('details', 'settings-advanced'); advanced.append(element('summary', '', page === 'skills' ? '加载限制' : page === 'mcp' ? '凭据与高级选项' : section === 'reason' || section === 'worker' ? '预算与提示词' : '高级选项'));
      const body = element('div', 'settings-advanced-fields'); advanced.append(body);
      for (const entry of spec.fields) (advancedKeys.includes(entry.key) ? body : fields).append(field(entry, value[entry.key], modelSecretState));
      if (body.children.length) fields.append(advanced);
    }
    bindProviderPresets();
    const inherit = fields.querySelector('[data-setting="inherit"]');
    if (inherit) {
      const note = element('div', 'settings-inherit-note');
      const model = section === 'summaryModel' && !data.values.reasonModel.inherit ? data.values.reasonModel : data.values.model;
      const source = section === 'summaryModel' ? '规划模型' : '默认模型';
      note.append(providerIcon(model.provider), element('div', '', '使用' + source + ' · ' + (model.backend ?? 'pi') + ' · ' + (data.modelPresets[model.provider]?.label ?? model.provider) + ' / ' + model.modelId));
      note.append(element('p', '', '关闭上方继承开关，即可为此角色选择已有配置或设置独立模型。')); fields.append(note);
      const update = () => { for (const row of fields.children) if (!row.contains(inherit) && !row.hasAttribute('data-cooperation-guide') && !row.hasAttribute('data-capability-overview')) row.hidden = row === note ? !inherit.checked : inherit.checked; };
      inherit.addEventListener('change', update); update();
    }
    if (page !== 'initialize' && (isModel || section === 'worker')) {
      const guide = collaborationGuide(); fields.prepend(guide);
      fields.querySelector('[data-setting="swarmBackendSelection"]')?.addEventListener('change', guide.refresh);
    }
    if (page === 'settings' && section === 'model') fields.prepend(capabilityOverview());
    restoreView(preserve, Boolean(preserve));
    status(readyStatus());
    renderedFingerprint = fingerprint;
  }
  function request(action, payload = {}, kind = '') {
    // Saving supersedes a previously requested navigation/discard decision.
    // Its deferred action must not survive into the newly saved form.
    $('settings-discard').hidden = true; closeAction = undefined; discardView = undefined;
    pendingOpen = undefined;
    requestView = viewState(); requestId = 'settings-' + requestScope + '-' + (++sequence); busy(true, kind || (action === 'settingsSave' ? 'save' : 'read'));
    $('settings-load-error').hidden = true;
    if (!data) { $('settings-skeleton').hidden = false; fields.hidden = true; }
    clearTimeout(requestTimer);
    const id = requestId;
    const fail = error => {
      if (requestId !== id) return;
      if (action === 'settingsSave') saveUncertain = true;
      requestId = ''; clearTimeout(requestTimer); busy(false); $('settings-skeleton').hidden = true;
      if (!data) { $('settings-load-error').hidden = false; $('settings-load-error').textContent = window.UBOVMErrors.text(error) + ' 点击“重新载入”重试。'; }
      restoreView(requestView, true); requestView = undefined; status(error, true);
    };
    requestTimer = setTimeout(() => fail('等待配置操作结果超时。输入已保留；请先重新载入确认保存状态，再决定是否重试。'), 30000);
    try {
      Promise.resolve(vscode.postMessage({ action, requestId, page, ...payload })).then(value => {
        if (value === false) fail('配置操作未能发送。输入已保留，请重新载入确认状态。');
      }, () => fail('配置操作发送失败。输入已保留，请重新载入确认状态。'));
    }
    catch (error) { fail(error); }
    return Boolean(requestId);
  }
  function reload() {
    const discardDraft = dirty;
    guard(() => {
      // Discard means restore the saved form even if the subsequent read fails.
      if (discardDraft && data) render();
      dirty = false; if (request('settingsRead')) status('正在读取配置…');
    });
  }
  function markDirty() { const changed = !dirty; dirty = true; if (changed) refreshInitialization(); }
  function isSettingsControl(target) {
    const control = target?.closest?.('[data-setting], [data-clear-secret], [data-default-ssh], [data-custom-for]');
    if (!control) return false;
    return !control.closest('.settings-library-search') && !control.classList?.contains('settings-library-search');
  }
  form.addEventListener('input', event => {
    if (!isSettingsControl(event.target)) return;
    markDirty(); status('有未保存的更改。');
  });
  form.addEventListener('change', event => {
    if (!isSettingsControl(event.target)) return;
    markDirty();
  });
  // Native validation must be able to reveal invalid advanced fields.
  form.addEventListener('invalid', event => {
    for (let parent = event.target.parentElement; parent && parent !== form; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  }, true);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (saving || saveUncertain || !data || !renderedFingerprint) return;
    if (page === 'initialize' && !dirty && data.initialization?.[section]) {
      section = nextSetupSection(); if (render()) focusSetupSection(); return;
    }
    try {
      let value;
      if (section === 'ssh') {
        const groups = [...fields.querySelectorAll('.settings-profile')];
        const profiles = groups.map(readFields);
        value = { profiles, defaultId: profiles[groups.findIndex(group => group.querySelector('[data-default-ssh]').checked)]?.id ?? '' };
      } else value = fields.querySelector('[data-setting="inherit"]')?.checked ? { inherit: true } : readFields(fields);
      if (modelRoles.some(([key]) => key === section) && !value.inherit) {
        const library = fields.querySelector('.settings-model-library');
        const saved = page === 'initialize' ? savedModelProfile(data.values[section] ?? {}) : undefined;
        value.profile = { id: (library?.dataset.profileId ?? saved?.id) || 'model-' + Date.now().toString(36) + '-' + (++sequence),
          name: (library ? $('settings-model-profile-name').value.trim() : saved?.name) || value.modelId };
        selectedModels.set(section, value.profile.id);
      }
      if (request('settingsSave', { section, value, revision: data.revision })) status('正在保存…');
    } catch (error) { status(error.message, true); }
  });
  $('settings-close').addEventListener('click', () => guard(close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!$('settings-discard').hidden) keepDraft(); else guard(close); });
  $('settings-reload').addEventListener('click', reload);
  $('settings-render-retry').addEventListener('click', () => {
    if (saving || !renderFailure) return;
    const retry = renderFailure;
    if (render(retry.preserve, retry.modelDraft)) {
      status('当前步骤已恢复，配置未重新读取。');
      focusSetupSection();
    }
  });
  function keepDraft() {
    $('settings-discard').hidden = true; closeAction = undefined;
    if (pendingOpen && !pendingOpen.started) pendingOpen = undefined;
    if (discardView?.focus) restoreView(discardView, true); else $('settings-save').focus();
    discardView = undefined;
  }
  $('settings-keep').addEventListener('click', keepDraft);
  $('settings-discard-confirm').addEventListener('click', () => {
    const action = closeAction;
    if (!action || saving && operation !== 'open') return;
    $('settings-discard').hidden = true; closeAction = undefined; discardView = undefined;
    invalidateView(); dirty = false; action();
  });
  function finishOpen(pending) {
    if (pending !== pendingOpen || !pending.started) return;
    if (pending.error) {
      clearTimeout(requestTimer);
      pendingOpen = undefined;
      busy(false); $('settings-skeleton').hidden = true; $('settings-load-error').hidden = false;
      $('settings-load-error').textContent = pending.error + ' 点击“重新载入”重试。'; status(pending.error, true); return;
    }
    if (!pending.data) return;
    clearTimeout(requestTimer);
    acceptSnapshot(pending.data); dirty = false; busy(false);
    if (initialStepPending) section = nextSetupSection();
    initialStepPending = false;
    if (render()) focusSetupSection(); pendingOpen = undefined;
  }
  function publishNavigation() {
    const nextNavigation = page + ':' + (section.endsWith('Model') ? 'model' : section);
    if (navigation !== nextNavigation) {
      vscode.postMessage({ action: 'settingsNavigation', page, section: section.endsWith('Model') ? 'model' : section });
      navigation = nextNavigation;
    }
  }
  function openTarget(pending) {
    const targetPage = ['mcp', 'skills', 'initialize'].includes(pending.page) ? pending.page : 'settings';
    const targetSection = targetPage === 'initialize' ? (setupSteps.some(([key]) => key === pending.section) ? pending.section : pending.data?.initialization?.model ? 'ssh' : 'model') : targetPage === 'settings' ? (['model', 'ssh', 'web', 'python', 'summary', 'reason', 'worker'].includes(pending.section) ? pending.section : 'model') : targetPage;
    return { targetPage, targetSection };
  }
  function validatePendingOpen(pending) {
    const { targetPage, targetSection } = openTarget(pending);
    if (pending.data && data) validateSnapshot(pending.data, targetPage, targetSection);
  }
  function beginOpen(pending) {
    if (pending !== pendingOpen) return;
    const { targetPage, targetSection } = openTarget(pending);
    // Reject invalid direct navigation before changing the binding of an
    // existing form. Its visible inputs must never be submitted to a new group.
    validatePendingOpen(pending);
    pending.started = true; page = targetPage; section = targetSection;
    initialStepPending = page === 'initialize' && !setupSteps.some(([key]) => key === pending.section);
    if (pending.data) { showDialog(); finishOpen(pending); return; }
    renderFailure = undefined; $('settings-render-retry').hidden = true;
    data = undefined; dirty = false; dialog.dataset.page = page;
    $('settings-title').textContent = page === 'mcp' ? 'MCP 服务' : page === 'skills' ? 'Skills' : '系统配置';
    $('settings-section-kicker').textContent = sectionKicker();
    $('settings-section-title').textContent = page === 'initialize' ? '首次初始化' : page === 'settings' ? '系统配置' : page === 'mcp' ? 'MCP 服务' : 'Skills';
    const loadingText = page === 'skills' ? '正在扫描已安装技能并读取预览…' : page === 'mcp' ? '正在读取 MCP 服务与连接配置…' : '正在读取配置…';
    $('settings-description').textContent = loadingText; roles.hidden = true; fields.hidden = true;
    $('settings-skeleton').hidden = false; $('settings-load-error').hidden = true;
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => { if (pending !== pendingOpen) return; pending.error = '配置读取超时，请检查服务状态后重试。'; finishOpen(pending); }, 30000);
    busy(true, 'open'); status(loadingText); showDialog(); publishNavigation(); finishOpen(pending);
  }
  function receiveSettingsMessage(message) {
    if (message?.type === 'settingsBrowserInstallProgress') {
      browserInstallation = { ...browserInstallation, ...message.installation, percent: message.percent, phase: message.phase, message: message.message };
      trackBrowserInstallation(true, { heartbeat: true });
      browserInstallFailed = false; browserInstallResult = '';
      refreshBrowserInstall();
      return;
    }
    if (message?.type === 'settingsBrowserStatus') {
      browserInstallation = message.installation || {}; trackBrowserInstallation(browserInstallation.state === 'installing'); browserInstallFailed = false; browserInstallResult = ''; refreshBrowserInstall(); return;
    }
    if (message?.type === 'settingsBrowserInstallResult') {
      trackBrowserInstallation(false);
      browserInstallFailed = !message.ok && !message.cancelled;
      browserInstallation = message.installation || { state: message.ok ? 'ready' : 'error' };
      browserInstallResult = message.ok
        ? message.message || '浏览器已安装。'
        : message.cancelled
          ? (message.message || '浏览器安装已取消。')
          : window.UBOVMErrors.text(message.failure || message.message);
      refreshBrowserInstall();
      if (message.ok) status(browserInstallResult);
      else if (message.cancelled) status(browserInstallResult);
      else status(browserInstallResult, true);
      return;
    }
    if (message?.type === 'settingsSSHTestResult') { finishSSHTest(message.requestId, message); return; }
    if (message?.type === 'settingsLoading') {
      if (saving && operation !== 'open') { status('正在处理配置，请完成后重试。'); return; }
      const pending = pendingOpen = { requestId: message.requestId, page: message.page, section: message.section, started: false };
      if (dialog.open) guard(() => beginOpen(pending)); else beginOpen(pending);
    } else if (message?.type === 'settingsLoadError') {
      if (!pendingOpen || message.requestId !== pendingOpen.requestId) return;
      pendingOpen.error = window.UBOVMErrors.text(message.failure || message.error || '配置加载失败。'); finishOpen(pendingOpen);
    } else if (message?.type === 'openSettings') {
      if (!message.requestId && saving && operation !== 'open') { status('正在处理配置，请完成后重试。'); return; }
      if (message.requestId) {
        if (!pendingOpen || message.requestId !== pendingOpen.requestId) return;
        // A deferred navigation must be validated while edits are still dirty,
        // not later inside the discard button's DOM event handler.
        validatePendingOpen({ ...pendingOpen, data: message.data });
        pendingOpen.data = message.data; finishOpen(pendingOpen);
      } else {
        const pending = { page: message.page, data: message.data, started: false };
        validatePendingOpen(pending);
        pendingOpen = pending;
        if (dialog.open) guard(() => beginOpen(pending)); else beginOpen(pending);
      }
    } else if (message?.type === 'closeSettings' && dialog.open) { guard(() => close(message));
    } else if (message?.type === 'settingsSection' && dialog.open && ['settings', 'initialize'].includes(page) && ['model', 'ssh', 'web', 'python', 'summary', 'reason', 'worker'].includes(message.section)) { switchTo(message.section);
    } else if (message?.type === 'settingsResult' && requestId && message.requestId === requestId && dialog.open) {
      const finishing = operation === 'finish';
      const saveResult = operation === 'save';
      clearTimeout(requestTimer); requestId = ''; busy(false); $('settings-skeleton').hidden = true;
      if (message.ok === false || message.error || !message.data) {
        if (saveResult && message.ok !== false && !message.error) { saveUncertain = true; busy(false); }
        const failure = message.failure || message.error || '未收到有效的配置结果，请重新载入。';
        if (!data) { $('settings-load-error').hidden = false; $('settings-load-error').textContent = window.UBOVMErrors.text(failure) + ' 点击“重新载入”重试。'; }
        restoreView(requestView, true); requestView = undefined; status(failure, true); return;
      }
      if (saveResult) saveUncertain = true;
      validateSnapshot(message.data);
      if (dirty) invalidateView();
      acceptSnapshot(message.data); dirty = false;
      if (finishing && data.initialization?.complete) { close(); return; }
      const advance = page === 'initialize' && (initialStepPending || finishing || message.saved && data.initialization?.[section]);
      initialStepPending = false;
      if (advance) {
        section = nextSetupSection(); requestView = undefined;
      }
      busy(false); const rendered = render(requestView); requestView = undefined;
      if (rendered) {
        if (advance) focusSetupSection();
        status(finishing ? '基础配置已发生变化，请完成当前步骤后重试。' : message.saved ? '已保存。后续运行将使用新配置。' : '已重新载入配置。', finishing);
      }
    }
  }
  window.addEventListener('message', event => {
    const message = event.data;
    const saveInFlight = operation === 'save';
    try { receiveSettingsMessage(message); }
    catch (error) {
      // A bad snapshot or one failed message must not tear down the application
      // or leave a request permanently busy. Unrelated notifications cannot
      // cancel an in-flight save.
      if (['settingsLoading', 'openSettings', 'settingsLoadError', 'settingsResult'].includes(message?.type)) {
        if (saveInFlight) saveUncertain = true;
        clearTimeout(requestTimer); requestId = ''; pendingOpen = undefined;
        closeAction = undefined; discardView = undefined; $('settings-discard').hidden = true;
        busy(false); $('settings-skeleton').hidden = true;
        if (!data) {
          fields.hidden = true; $('settings-load-error').hidden = false;
          $('settings-load-error').textContent = '配置未能载入，请重新载入后重试。';
        }
        restoreView(requestView, true); requestView = undefined;
        showDialog();
      }
      status(error, true);
    }
  });
  let wasHidden = document.hidden;
  document.addEventListener('visibilitychange', () => {
    const resumed = wasHidden && !document.hidden; wasHidden = document.hidden;
    if (!resumed || !dialog.open || section !== 'web') return;
    // Refresh the installer only; never reload or overwrite unsaved form data.
    try { vscode.postMessage({ action: 'settingsBrowserStatus' }); }
    catch { status('无法刷新浏览器安装状态，可稍后点击“检查状态”重试。', true); }
  });
}
