'use strict';

const { randomUUID } = require('node:crypto');

const SUPPORTED = new Set([
  'status', 'tabs', 'tab_new', 'tab_close', 'tab_activate',
  'navigate', 'back', 'forward', 'reload',
  'snapshot', 'accessibility', 'screenshot', 'evaluate', 'frames', 'frame_evaluate',
  'click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'wait',
  'console', 'cdp', 'cdp_events',
  'network_start', 'network', 'network_body', 'network_stop',
  'cookies', 'set_cookie', 'clear_cookies',
  'dialogs', 'dialog_policy', 'storage', 'upload', 'yield_control'
]);

const UNSUPPORTED_HINT = '此操作在 IDE 内嵌浏览器模式下不可用。请在设置「浏览器与搜索」中关闭「使用 IDE 内嵌浏览器」后使用独立 Chromium（Obscura）。';

/** Page script shared by snapshot/accessibility — mirrors Obscura refs + open shadow roots. */
const SNAPSHOT_SCRIPT = `(({ token, max, chars, offset, role, query, clear }) => {
  if (clear) {
    const wipe = root => {
      for (const node of root.querySelectorAll('[data-intools-ref]')) node.removeAttribute('data-intools-ref');
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) wipe(node.shadowRoot);
    };
    wipe(document);
  }
  const nodes = [];
  const visit = root => {
    for (const node of root.querySelectorAll('*')) {
      if (node.matches('a,button,input,textarea,select,summary,[role],[contenteditable="true"],[tabindex],[onclick]')) {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        if (rect.width && rect.height && !['hidden', 'collapse'].includes(style.visibility) && style.display !== 'none') nodes.push(node);
      }
      if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  visit(document);
  const describe = node => {
    const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\\s+/)
      .map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ').trim();
    const label = labelledBy || node.getAttribute('aria-label') || node.labels?.[0]?.innerText
      || node.innerText || node.getAttribute('placeholder') || node.getAttribute('title')
      || node.getAttribute('name') || node.id || '';
    const inputRole = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button',
      reset: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox' }[node.type] || 'textbox';
    const roleValue = node.getAttribute('role') || ({
      A: node.hasAttribute('href') ? 'link' : '', BUTTON: 'button', SUMMARY: 'button',
      INPUT: inputRole, TEXTAREA: 'textbox', SELECT: node.multiple || node.size > 1 ? 'listbox' : 'combobox'
    }[node.tagName]) || node.tagName.toLowerCase();
    return {
      tag: node.tagName.toLowerCase(), role: roleValue,
      name: String(label).trim().slice(0, 300),
      ...(node.type === 'password' ? {} : { value: String(node.value ?? '').slice(0, 300) || undefined }),
      href: node.getAttribute('href') || undefined,
      ...(node.id ? { id: String(node.id).slice(0, 200) } : {}),
      ...(node.getAttribute('type') ? { input_type: String(node.getAttribute('type')).slice(0, 40) } : {}),
      ...(node.getAttribute('name') ? { field_name: String(node.getAttribute('name')).slice(0, 200) } : {}),
      ...(node.getAttribute('placeholder') ? { placeholder: String(node.getAttribute('placeholder')).slice(0, 200) } : {}),
      ...(node.required === true ? { required: true } : {}),
      ...(node.readOnly === true ? { readonly: true } : {}),
      ...(node.multiple === true ? { multiple: true } : {}),
      ...(node.getAttribute('pattern') ? { pattern: String(node.getAttribute('pattern')).slice(0, 200) } : {}),
      ...(node.getAttribute('accept') ? { accept: String(node.getAttribute('accept')).slice(0, 200) } : {}),
      ...(node.hasAttribute('aria-expanded') ? { expanded: node.getAttribute('aria-expanded') === 'true' } : {}),
      ...(node.hasAttribute('aria-selected') ? { aria_selected: node.getAttribute('aria-selected') === 'true' } : {}),
      disabled: !!(node.matches?.(':disabled') || node.disabled || node.getAttribute('aria-disabled') === 'true'),
      ...((node.type === 'checkbox' || node.type === 'radio' || node.hasAttribute('aria-checked'))
        ? { checked: node.hasAttribute('aria-checked') ? node.getAttribute('aria-checked') === 'true' : !!node.checked }
        : {})
    };
  };
  const selected = nodes.map(node => ({ node, data: describe(node) }))
    .filter(({ data }) => (!role || data.role.toLowerCase() === role) && (!query || data.name.toLowerCase().includes(query)));
  const elements = selected.slice(offset, offset + max).map(({ node, data }, index) => {
    const ref = token + '_' + index;
    node.setAttribute('data-intools-ref', ref);
    return { ref, ...data };
  });
  const text = document.body?.innerText || '';
  return {
    url: location.href, title: document.title,
    text: text.slice(0, chars), text_truncated: text.length > chars,
    elements, elements_truncated: offset > 0 || selected.length > elements.length,
    offset, next_offset: offset + elements.length < selected.length ? offset + elements.length : null,
    has_more: offset + elements.length < selected.length, total_elements: selected.length
  };
})`;

const FIND_REF_SCRIPT = `(ref => {
  const attr = 'data-intools-ref';
  const visit = root => {
    for (const node of root.querySelectorAll('[' + attr + ']')) {
      if (node.getAttribute(attr) === ref) return node;
    }
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) {
        const found = visit(node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(document);
})`;

const CONSOLE_LIMIT = 500;
const CONSOLE_TEXT_LIMIT = 4000;
const CONSOLE_ENVELOPE_BYTES = 40 * 1024;
const PAGE_ERROR_KIND = 'pageerror';
const CDP_EVENT_LIMIT = 300;
const NETWORK_EVENT_LIMIT = 500;
const EVENT_PARAMS_LIMIT = 4096;
// CDP errors that mean the cached page session is unusable. Only these evict
// the session so the next action reattaches; the failed action is never retried.
const SESSION_INVALID = /session (?:with given id )?(?:closed|not found)|no session with given id|target closed|not attached|inspected target navigated or closed|execution context was destroyed|cannot find context|detached from target|browser has been closed/i;
const isSessionInvalid = error => SESSION_INVALID.test(String(error?.message || error || ''));

function safeText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Render a CDP RemoteObject as a short console string. */
function formatRemoteObject(argument) {
  if (argument === null || argument === undefined) return '';
  if (typeof argument !== 'object') return String(argument);
  if (argument.value !== undefined) return safeText(argument.value);
  if (argument.unserializableValue !== undefined) return String(argument.unserializableValue);
  if (argument.description !== undefined) return String(argument.description);
  return String(argument.type ?? '');
}

function recordConsole(buffer, entry) {
  buffer.entries.push({ sequence: ++buffer.sequence, timestamp: new Date().toISOString(), ...entry });
  if (buffer.entries.length > CONSOLE_LIMIT) buffer.droppedThrough = buffer.entries.shift().sequence;
}

/** Read the host-side console ring buffer, matching the Obscura contract. */
function consoleResult(buffer, input) {
  const after = Number.isSafeInteger(input.after_sequence) && input.after_sequence > 0 ? input.after_sequence : 0;
  const level = input.level ? String(input.level) : '';
  const query = String(input.query || '').toLowerCase();
  const selected = buffer.entries.filter(entry => entry.sequence > after
    && (!level || entry.level === level)
    && (!query || String(entry.text || '').toLowerCase().includes(query)));
  const limit = Number(input.limit) > 0 ? Math.min(200, Number(input.limit)) : 40;
  const entries = [];
  let bytes = 0;
  for (const entry of selected) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (entries.length >= limit || (entries.length && bytes + size > CONSOLE_ENVELOPE_BYTES)) break;
    entries.push(entry);
    bytes += size;
  }
  if (input.clear === true) {
    const removed = new Set(entries.map(entry => entry.sequence));
    buffer.entries = buffer.entries.filter(entry => !removed.has(entry.sequence));
  }
  const hasMore = entries.length < selected.length;
  return {
    entries,
    has_more: hasMore,
    next_sequence: hasMore ? entries[entries.length - 1].sequence : Math.max(after, buffer.sequence),
    dropped_through_sequence: buffer.droppedThrough || undefined,
    buffer_overflow: after < buffer.droppedThrough
  };
}

/** Map a key name to CDP Input.dispatchKeyEvent fields. */
function keyDescriptor(key) {
  const named = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  };
  if (named[key]) return named[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : undefined;
    return { key, ...(code ? { code } : {}), text: key };
  }
  return { key };
}

function createIdeBrowserHost(vscode, { lockCommand = 'workbench.action.browser.setAgentControlLock', onActivity } = {}) {
  const pages = new Map();
  const pageRefs = new Map();
  let activePageId;
  let nextCdpId = 1;
  // Task-scoped lock: the first browser action of an agent run locks the tab
  // until the run ends (which can span many slow tool calls); a per-action
  // counter lets a release requested mid-call settle after that call finishes.
  let taskLocked = false;
  let taskLockReason = '';
  let activeCalls = 0;
  let releaseWhenIdle = false;
  let nativeLockSupported = true;
  const disposables = [];

  // The page the user is actually looking at. Agent actions never bring the
  // browser editor forward: when the agent drives a page that is not visible the
  // host reports activity and the conversation shows a click-through affordance.
  let visiblePageId;
  let visibleInitialized = false;
  let lastActivityKey;
  function reportActivity(active, entry, url, title) {
    const payload = active
      ? { active: true, pageId: entry?.id ?? null, url: url || entry?.tab?.url || entry?.url || '', title: title || entry?.tab?.title || entry?.title || '' }
      : { active: false };
    const key = JSON.stringify(payload);
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    try { onActivity?.(payload); } catch { /* observers must not fail a browser action */ }
  }
  function visibleId() {
    if (!visibleInitialized) {
      visibleInitialized = true;
      const active = vscode.window.activeBrowserTab;
      if (active) visiblePageId = track(active)?.id;
    }
    return visiblePageId;
  }
  function pageVisible(entry) { return Boolean(entry?.id) && visibleId() === entry.id; }
  function markVisible(entry) { if (!entry) return; visiblePageId = entry.id; visibleInitialized = true; reportActivity(false, entry); }

  // The IDE browser editor cannot be created invisibly: opening a BrowserTab
  // brings its editor group forward. IDE mode therefore never opens a page on
  // the agent's behalf: with no page open the host reports the requested URL and
  // returns a structured "not open" result. The conversation shows a
  // click-through prompt; hidden background browsing is the separate Obscura
  // mode selected in settings.
  function notOpenResult(action, input, binding) {
    const url = String(input?.url || binding?.target || '');
    reportActivity(true, undefined, url);
    return {
      ok: false,
      code: 'IDE_BROWSER_NOT_OPEN',
      action,
      url,
      page_open: false,
      source: 'ide-browser',
      guidance: 'IDE 内嵌浏览器没有打开：请点击对话里的悬浮提示打开页面后重试；或在设置「浏览器与搜索」关闭「使用 IDE 内嵌浏览器」，切到独立 Chromium（Obscura）模式执行后台浏览。'
    };
  }

  let browserApiAvailable;
  async function hasBrowserApi() {
    if (browserApiAvailable === true) return true;
    const available = typeof vscode.window.openBrowserTab === 'function'
      || !!(await vscode.commands.getCommands(true)).includes('workbench.action.browser.open');
    if (available) browserApiAvailable = true;
    return available;
  }

  // A Browser editor pane that is already open (even with no tab) is an explicit
  // user affordance: filling it does not change the layout, so the agent may use
  // it without the click-through prompt. With no pane open the agent must not
  // create one behind the user's back.
  function browserEditorOpen() {
    try {
      const groups = vscode.window.tabGroups?.all;
      if (!Array.isArray(groups)) return false;
      for (const group of groups) {
        for (const tab of group?.tabs || []) {
          const input = tab?.input;
          const name = input?.constructor?.name || '';
          const viewType = String(input?.viewType || input?.id || '');
          const label = String(tab?.label || '').trim();
          if (/browser/i.test(name) || /browser/i.test(viewType)) return true;
          if (/^(browser|浏览器)$/i.test(label) && !input?.uri) return true;
        }
      }
    } catch { /* tabGroups is a proposed API surface; absence means no pane */ }
    return false;
  }

  function listTabs() {
    return typeof vscode.window.browserTabs !== 'undefined' ? [...vscode.window.browserTabs] : [];
  }

  function consoleBuffer(entry) {
    if (!entry.console) entry.console = { entries: [], sequence: 0, droppedThrough: 0 };
    return entry.console;
  }

  function dialogBuffer(entry) {
    if (!entry.dialogs) entry.dialogs = { entries: [], sequence: 0, policy: { accept: true, promptText: '' } };
    return entry.dialogs;
  }

  function eventBuffer(entry) {
    if (!entry.events) entry.events = { entries: [], sequence: 0, droppedThrough: 0 };
    return entry.events;
  }

  function networkBuffer(entry) {
    if (!entry.network) entry.network = { capture: false, entries: [], sequence: 0, droppedThrough: 0 };
    return entry.network;
  }

  function recordCdpEvent(entry, method, params) {
    if (!method || method === 'Runtime.bindingCalled') return;
    let serialized = '';
    try { serialized = JSON.stringify(params ?? {}); } catch { serialized = ''; }
    const buffer = eventBuffer(entry);
    buffer.entries.push({
      sequence: ++buffer.sequence, method, at: Date.now(),
      params: serialized.length > EVENT_PARAMS_LIMIT ? serialized.slice(0, EVENT_PARAMS_LIMIT) + '…' : serialized
    });
    while (buffer.entries.length > CDP_EVENT_LIMIT) buffer.droppedThrough = buffer.entries.shift().sequence;
  }

  function recordNetwork(entry, method, params) {
    const buffer = networkBuffer(entry);
    if (!buffer.capture) return;
    const requestId = params?.requestId;
    if (!requestId) return;
    const at = Date.now();
    let record;
    if (method === 'Network.requestWillBeSent') {
      record = { kind: 'request', request_id: requestId, url: params.request?.url, method: params.request?.method,
        resource_type: params.type, headers: params.request?.headers, post_data: typeof params.request?.postData === 'string'
          ? params.request.postData.slice(0, 8000) : undefined, mixed_content_type: params.request?.mixedContentType, at };
    } else if (method === 'Network.responseReceived') {
      record = { kind: 'response', request_id: requestId, url: params.response?.url, status: params.response?.status,
        status_text: params.response?.statusText, mime_type: params.response?.mimeType,
        headers: params.response?.headers, from_service_worker: params.response?.fromServiceWorker === true, at };
    } else if (method === 'Network.loadingFailed') {
      record = { kind: 'failed', request_id: requestId, error_text: params.errorText, blocked_reason: params.blockedReason, at };
    } else if (method === 'Network.loadingFinished') {
      record = { kind: 'finished', request_id: requestId, encoded_data_length: params.encodedDataLength, at };
    } else return;
    buffer.entries.push({ sequence: ++buffer.sequence, ...record });
    while (buffer.entries.length > NETWORK_EVENT_LIMIT) buffer.droppedThrough = buffer.entries.shift().sequence;
  }

  function disposeSession(entry) {
    const session = entry?.session;
    entry.session = undefined;
    entry.sessionPromise = undefined;
    if (!session) return;
    for (const dispose of session.disposers) { try { dispose(); } catch { /* ignore */ } }
    try { session.onMessage?.dispose?.(); } catch { /* ignore */ }
    try { Promise.resolve(session.handle?.close?.()).catch(() => {}); } catch { /* ignore */ }
  }

  function forgetPage(id) {
    const entry = pages.get(id);
    if (entry) disposeSession(entry);
    if (visiblePageId === id) { visiblePageId = undefined; reportActivity(false); }
    pages.delete(id);
    pageRefs.delete(id);
    if (activePageId === id) {
      const active = vscode.window.activeBrowserTab;
      activePageId = active ? track(active)?.id : pages.keys().next().value;
    }
  }

  function ownedTabs(except) {
    const owned = new Set();
    for (const entry of pages.values()) {
      if (entry !== except && entry.tab) owned.add(entry.tab);
    }
    return owned;
  }

  function resolveTab(pageId) {
    if (pageId && pages.has(pageId)) {
      const entry = pages.get(pageId);
      const tabs = listTabs();
      if (tabs.includes(entry.tab)) {
        entry.url = entry.tab.url;
        entry.title = entry.tab.title;
        return entry;
      }
      // Tab object may have been replaced; rebind only when a single unowned URL match remains.
      const candidates = tabs.filter(tab => !ownedTabs(entry).has(tab) && tab.url === entry.url);
      if (candidates.length === 1) {
        disposeSession(entry);
        entry.tab = candidates[0];
        entry.url = candidates[0].url;
        entry.title = candidates[0].title;
        return entry;
      }
      forgetPage(pageId);
    }
    const active = vscode.window.activeBrowserTab;
    if (active) return track(active, activePageId, { activate: true });
    if (activePageId && pages.has(activePageId) && activePageId !== pageId) {
      const entry = pages.get(activePageId);
      if (listTabs().includes(entry.tab)) {
        entry.url = entry.tab.url;
        entry.title = entry.tab.title;
        return entry;
      }
    }
    const tabs = listTabs();
    if (tabs[0]) return track(tabs[0], activePageId, { activate: true });
    return undefined;
  }

  function track(tab, preferredId, options = {}) {
    if (!tab) return undefined;
    for (const entry of pages.values()) {
      if (entry.tab === tab) {
        entry.url = tab.url;
        entry.title = tab.title;
        if (options.activate) activePageId = entry.id;
        return entry;
      }
    }
    if (preferredId && pages.has(preferredId)) {
      const entry = pages.get(preferredId);
      if (!listTabs().includes(entry.tab)) {
        disposeSession(entry);
        entry.tab = tab;
        entry.url = tab.url;
        entry.title = tab.title;
        if (options.activate || !activePageId) activePageId = preferredId;
        return entry;
      }
    }
    const id = preferredId && !pages.has(preferredId) ? preferredId : randomUUID();
    const entry = { id, tab, url: tab.url, title: tab.title, loading: false };
    pages.set(id, entry);
    if (options.activate || !activePageId) activePageId = id;
    return entry;
  }

  function pageFlags(tab, entry) {
    const url = tab?.url || entry?.url || '';
    return {
      loading: typeof tab?.loading === 'boolean' ? tab.loading : entry?.loading === true,
      canGoBack: typeof tab?.canGoBack === 'boolean' ? tab.canGoBack : !!(url && url !== 'about:blank'),
      canGoForward: typeof tab?.canGoForward === 'boolean' ? tab.canGoForward : true
    };
  }

  if (typeof vscode.window.onDidCloseBrowserTab === 'function') {
    disposables.push(vscode.window.onDidCloseBrowserTab(tab => {
      for (const [id, entry] of [...pages]) {
        if (entry.tab === tab) forgetPage(id);
      }
    }));
  }
  if (typeof vscode.window.onDidChangeActiveBrowserTab === 'function') {
    disposables.push(vscode.window.onDidChangeActiveBrowserTab(tab => {
      if (tab) markVisible(track(tab, undefined, { activate: true }));
      else { visiblePageId = undefined; reportActivity(false); }
    }));
  }
  if (typeof vscode.window.onDidChangeBrowserTabState === 'function') {
    disposables.push(vscode.window.onDidChangeBrowserTabState(tab => {
      for (const entry of pages.values()) {
        if (entry.tab === tab) {
          entry.url = tab.url;
          entry.title = tab.title;
          entry.loading = typeof tab.loading === 'boolean' ? tab.loading : false;
          pageRefs.delete(entry.id);
        }
      }
    }));
  }

  async function openTab(url, options = {}) {
    // An explicit empty target starts the native welcome surface without a
    // synthetic about:blank page. Other callers keep the old fallback.
    const target = options.startBlank === true && (url === undefined || url === '')
      ? '' : (typeof url === 'string' && url ? url : 'about:blank');
    // Column 2 is the file/browser area. Beside would split the locked conversation group.
    const viewColumn = options.viewColumn ?? vscode.ViewColumn.Two;
    const preserveFocus = options.preserveFocus === true;
    const background = options.background === true;
    if (typeof vscode.window.openBrowserTab === 'function') {
      try {
        const tab = await vscode.window.openBrowserTab(target, { viewColumn, preserveFocus, background });
        if (tab) return track(tab, undefined, { activate: true });
      } catch {
        // Locked groups and compact layout vetoes fall through to the workbench command.
      }
    }
    try {
      await vscode.commands.executeCommand('workbench.action.browser.open', target);
    } catch (error) {
      throw new Error(`无法打开 IDE 内置浏览器。${error && error.message ? error.message : error}`);
    }
    const tabs = listTabs();
    const match = tabs.find(tab => tab.url === target && !ownedTabs().has(tab)) || tabs[tabs.length - 1];
    if (!match) throw new Error('无法打开 IDE 内置浏览器。请确认工作台已启用 Integrated Browser。');
    return track(match, undefined, { activate: true });
  }

  async function reveal(url, options = {}) {
    const target = typeof url === 'string' && url ? url : 'about:blank';
    const preferred = options.pageId && pages.get(options.pageId);
    const existing = (preferred && listTabs().includes(preferred.tab) ? preferred.tab : undefined)
      || listTabs().find(tab => tab.url === target)
      || [...pages.values()].find(entry => entry.url === target)?.tab;
    const active = vscode.window.activeBrowserTab;
    if (options.force !== true && existing && active && active === existing) {
      const entry = track(existing, preferred?.id, { activate: true });
      markVisible(entry);
      return entry;
    }
    // Prefer the workbench reuse filter so we focus an existing editor instead of minting a new BrowserTab.
    try {
      await vscode.commands.executeCommand('workbench.action.browser.open', {
        url: target,
        reuseUrlFilter: target,
        openToSide: options.openToSide === true
      });
    } catch {
      if (existing) {
        // Command unavailable: keep logical selection only.
        const entry = track(existing, preferred?.id, { activate: true });
        markVisible(entry);
        return entry;
      }
      return openTab(target, options);
    }
    const tabs = listTabs();
    const match = (preferred && tabs.includes(preferred.tab) ? preferred.tab : undefined)
      || tabs.find(tab => tab.url === target)
      || existing
      || tabs[tabs.length - 1];
    if (!match) throw new Error('无法聚焦 IDE 内置浏览器页面。');
    const entry = track(match, preferred?.id, { activate: true });
    markVisible(entry);
    return entry;
  }

  async function navigate(url, pageId) {
    const target = typeof url === 'string' && url ? url : 'about:blank';
    let entry = pageId ? resolveTab(pageId) : resolveTab(activePageId);
    if (!entry) {
      const active = vscode.window.activeBrowserTab;
      if (active) entry = track(active, undefined, { activate: true });
    }
    if (!entry) return openTab(target, { preserveFocus: false });
    activePageId = entry.id;
    // Never foreground the page for an agent navigation: the user opens it from
    // the conversation's floating indicator. tab_activate remains the explicit
    // reveal path.
    entry = resolveTab(entry.id) || entry;
    if (!pageVisible(entry)) reportActivity(true, entry);
    if ((entry.tab.url || entry.url) === target) return entry;
    entry.loading = true;
    try {
      return await call({}, { action: 'navigate', url: target, page_id: entry.id });
    } finally {
      if (pages.has(entry.id)) entry.loading = false;
    }
  }

  function listPages() {
    const tabs = listTabs();
    for (const tab of tabs) track(tab);

    const activeTab = vscode.window.activeBrowserTab;
    if (activeTab) {
      const workbenchEntry = track(activeTab);
      const preferred = activePageId && pages.get(activePageId);
      // When several pages share a URL, workbench reuse may focus the wrong tab.
      // Keep an explicit page_id selection until the user (or workbench) picks another tab object.
      const ambiguousReuse = preferred
        && preferred.tab !== activeTab
        && tabs.includes(preferred.tab)
        && preferred.url === activeTab.url;
      if (!ambiguousReuse) activePageId = workbenchEntry.id;
    } else if (!(activePageId && pages.has(activePageId)) && tabs[0]) {
      activePageId = track(tabs[0]).id;
    }

    const activeId = activePageId && pages.has(activePageId) ? activePageId : '';
    return tabs.map(tab => {
      const entry = track(tab);
      return {
        id: entry.id,
        url: tab.url || '',
        title: tab.title || tab.url || '未命名页面',
        active: entry.id === activeId,
        ...pageFlags(tab, entry)
      };
    });
  }

  async function closePage(pageId) {
    const entry = resolveTab(pageId);
    if (!entry) return { ok: true, closed: false };
    await entry.tab.close();
    forgetPage(entry.id);
    return { ok: true, closed: true };
  }

  async function setAgentControl(locked, reason) {
    const value = locked === true;
    try {
      await vscode.commands.executeCommand(lockCommand, value, reason || 'Agent 正在操作浏览器（只读）');
      nativeLockSupported = true;
      return true;
    } catch {
      // Prebuilt without the lock command still needs a tab-page mask; fall
      // back to an in-page overlay for the whole agent task.
      nativeLockSupported = false;
      return false;
    }
  }

  const OVERLAY_ID = '__ubovm_agent_control_overlay__';
  function overlayExpression(action, reason = '') {
    const message = JSON.stringify(String(reason || 'Agent 正在操作浏览器'));
    const begin = `(() => { const id = ${JSON.stringify(OVERLAY_ID)};`;
    if (action === 'remove') return `${begin} const root = document.getElementById(id); if (root) root.remove(); return true; })()`;
    if (action === 'hide') return `${begin} const root = document.getElementById(id); if (root) root.style.display = 'none'; return true; })()`;
    if (action === 'show') return `${begin} const root = document.getElementById(id); if (root) { root.style.display = 'flex'; return true; } return false; })()`;
    return `${begin}
      if (window.__ubovmAgentOverlayDismissed) return 'dismissed';
      const existing = document.getElementById(id);
      if (existing) { existing.style.display = 'flex'; return 'shown'; }
      if (!document.getElementById('__ubovm_agent_overlay_style__')) {
        const style = document.createElement('style');
        style.id = '__ubovm_agent_overlay_style__';
        style.textContent = [
          '#' + id + '{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.46);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);pointer-events:auto;cursor:not-allowed;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}',
          '#' + id + ' .u-card{width:min(344px,calc(100vw - 40px));padding:16px 18px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(18,21,26,.96);color:#e9edf3;box-shadow:0 12px 40px rgba(0,0,0,.35);cursor:default;}',
          '#' + id + ' .u-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.01em;}',
          '#' + id + ' .u-dot{width:7px;height:7px;border-radius:50%;background:#9aa7b5;box-shadow:0 0 0 3px rgba(154,167,181,.14);animation:ubovmAgentPulse 1.6s ease-in-out infinite;}',
          '#' + id + ' .u-state{margin-left:auto;font-size:10.5px;color:#8e9aa7;font-weight:400;letter-spacing:.02em;}',
          '#' + id + ' .u-detail{margin:9px 0 14px;font-size:12px;line-height:1.65;color:#a4afbb;}',
          '#' + id + ' .u-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
          '#' + id + ' .u-hint{font-size:10.5px;color:#778390;letter-spacing:.02em;}',
          '#' + id + ' .u-take{padding:5px 11px;border:1px solid rgba(255,255,255,.14);border-radius:6px;background:transparent;color:#dce4ec;font:inherit;font-size:11.5px;cursor:pointer;}',
          '#' + id + ' .u-take:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.22);}',
          '#' + id + ' .u-take:focus-visible{outline:1px solid rgba(255,255,255,.5);outline-offset:2px;}',
          '@keyframes ubovmAgentPulse{0%,100%{opacity:.55;transform:scale(.92);}50%{opacity:1;transform:scale(1);}}',
          '@media (prefers-reduced-motion:reduce){#' + id + ' .u-dot{animation:none;}}'
        ].join('');
        document.documentElement.append(style);
      }
      const root = document.createElement('div');
      root.id = id;
      root.setAttribute('data-ubovm-agent-overlay', '');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', ${message});
      const card = document.createElement('div');
      card.className = 'u-card';
      const head = document.createElement('div');
      head.className = 'u-head';
      const dot = document.createElement('span');
      dot.className = 'u-dot';
      dot.setAttribute('aria-hidden', 'true');
      const heading = document.createElement('span');
      heading.textContent = 'Agent 正在操作浏览器';
      const state = document.createElement('span');
      state.className = 'u-state';
      state.textContent = '任务中';
      head.append(dot, heading, state);
      const detail = document.createElement('p');
      detail.className = 'u-detail';
      detail.textContent = '页面暂时只读，避免与 Agent 同时操作；任务结束后自动解除。';
      const foot = document.createElement('div');
      foot.className = 'u-foot';
      const hint = document.createElement('span');
      hint.className = 'u-hint';
      hint.textContent = '只读保护';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'u-take';
      button.textContent = '接管页面';
      button.addEventListener('click', () => {
        window.__ubovmAgentOverlayDismissed = true;
        try { window.__ubovmAgentOverlayDismiss?.(); } catch {}
        root.remove();
      });
      foot.append(hint, button);
      card.append(head, detail, foot);
      root.append(card);
      document.documentElement.append(root);
      if (!window.__ubovmAgentOverlayKeys) {
        window.__ubovmAgentOverlayKeys = true;
        window.addEventListener('keydown', (event) => {
          if (window.__ubovmAgentOperating || root.contains(event.target)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        }, true);
      }
      try { button.focus({ preventScroll: true }); } catch {}
      return 'created';
    })()`;
  }

  async function pageOverlay(entry, send, action, reason) {
    if (nativeLockSupported) return false;
    try {
      await send('Runtime.evaluate', { expression: overlayExpression(action, reason), returnByValue: true, awaitPromise: false });
      return true;
    } catch { return false; }
  }

  async function showAgentOverlay(entry, send) {
    if (nativeLockSupported || !taskLocked || entry.agentOverlayDismissed) return;
    await pageOverlay(entry, send, 'create', taskLockReason);
  }

  async function hideAgentOverlay(entry, send) {
    if (nativeLockSupported) return;
    await pageOverlay(entry, send, 'hide');
  }

  async function setAgentOperating(send, active) {
    if (nativeLockSupported) return;
    try {
      await send('Runtime.evaluate', { expression: `window.__ubovmAgentOperating = ${active ? 'true' : 'false'}`, returnByValue: true });
    } catch { /* page may have navigated away */ }
  }

  function removePageOverlays() {
    for (const entry of pages.values()) {
      const send = entry.session?.send;
      if (!send) continue;
      void pageOverlay(entry, send, 'remove').catch?.(() => {});
    }
  }

  async function acquireTaskLock(reason) {
    if (taskLocked) return;
    taskLocked = true;
    taskLockReason = String(reason || 'Agent 正在操作浏览器；任务完成前页面只读');
    for (const entry of pages.values()) entry.agentOverlayDismissed = false;
    await setAgentControl(true, taskLockReason);
  }

  async function endAgentTask() {
    reportActivity(false);
    if (!taskLocked) return;
    if (activeCalls > 0) { releaseWhenIdle = true; return; }
    releaseWhenIdle = false;
    taskLocked = false;
    if (nativeLockSupported) await setAgentControl(false);
    removePageOverlays();
    for (const entry of pages.values()) entry.agentOverlayDismissed = false;
  }

  async function withLock(action) {
    activeCalls++;
    if (!taskLocked) await acquireTaskLock();
    try { return await action(); }
    finally {
      activeCalls = Math.max(0, activeCalls - 1);
      if (releaseWhenIdle && activeCalls === 0) {
        releaseWhenIdle = false;
        void endAgentTask();
      }
    }
  }

  function subscribeSessionEvents(entry, session) {
    const buffer = consoleBuffer(entry);
    session.on('Runtime.consoleAPICalled', params => {
      const frame = params?.stackTrace?.callFrames?.[0];
      const text = (params?.args || []).map(formatRemoteObject).join(' ');
      recordConsole(buffer, {
        kind: 'console', level: params?.type || 'log',
        text: text.slice(0, CONSOLE_TEXT_LIMIT), truncated: text.length > CONSOLE_TEXT_LIMIT,
        ...(frame ? { location: { url: String(frame.url || '').slice(0, 2000), line: frame.lineNumber, column: frame.columnNumber } } : {})
      });
    });
    session.on('Runtime.exceptionThrown', params => {
      const details = params?.exceptionDetails || {};
      const text = String(details.exception?.description || details.text || 'Uncaught error');
      recordConsole(buffer, { kind: PAGE_ERROR_KIND, level: 'error', text: text.slice(0, CONSOLE_TEXT_LIMIT), truncated: text.length > CONSOLE_TEXT_LIMIT });
    });
    // Browser log (CSP violations, mixed content, deprecations) — distinct from
    // page console but equally useful as audit evidence.
    session.on('Log.entryAdded', params => {
      const item = params?.entry || {};
      const text = String(item.text || '');
      recordConsole(buffer, {
        kind: 'browser', level: item.level || 'info',
        text: text.slice(0, CONSOLE_TEXT_LIMIT), truncated: text.length > CONSOLE_TEXT_LIMIT,
        source: item.source || 'browser',
        ...(item.url ? { location: { url: String(item.url).slice(0, 2000), line: item.lineNumber ?? 0, column: 0 } } : {})
      });
    });
    // Navigation (by link, form, or history) invalidates refs; console survives.
    session.on('Page.frameNavigated', params => { if (!params?.frame?.parentId) pageRefs.delete(entry.id); });
    // JS dialogs block the renderer; without a handler navigate/click hang.
    session.on('Page.javascriptDialogOpening', params => {
      const state = dialogBuffer(entry);
      state.entries.push({
        sequence: ++state.sequence, type: params?.type || 'alert',
        message: String(params?.message || '').slice(0, 2000), url: params?.url || '',
        default_prompt: params?.defaultPrompt || '', at: Date.now()
      });
      while (state.entries.length > 50) state.entries.shift();
      const policy = state.policy;
      void session.send('Page.handleJavaScriptDialog', {
        accept: policy.accept !== false,
        ...(policy.promptText ? { promptText: policy.promptText } : {})
      }).catch(() => {});
    });
    session.onAny?.((method, params) => {
      recordCdpEvent(entry, method, params);
      recordNetwork(entry, method, params);
    });
  }

  async function createSession(entry) {
    if (!entry.tab?.startCDPSession) throw new Error('当前浏览器标签不支持 CDP。');
    const handle = await entry.tab.startCDPSession();
    const pending = new Map();
    const listeners = new Map();
    const session = { handle, pending, listeners, pageSessionId: undefined, console: consoleBuffer(entry), disposers: [] };
    session.onMessage = handle.onDidReceiveMessage(message => {
      if (!message || typeof message !== 'object') return;
      if (message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(Object.assign(new Error(message.error.message || 'CDP error'), { cdp: message.error }));
        else resolve(message.result);
        return;
      }
      if (message.method && listeners.has(message.method)) {
        for (const listener of listeners.get(message.method)) {
          try { listener(message.params || {}, message); } catch { /* ignore listener errors */ }
        }
      }
      if (message.method) {
        for (const listener of session.anyListeners) {
          try { listener(message.method, message.params || {}, message); } catch { /* ignore listener errors */ }
        }
      }
    });
    session.send = async (method, params, options = {}) => {
      const id = nextCdpId++;
      const root = options.root === true || method.startsWith('Target.') || method.startsWith('Browser.');
      const sessionId = options.sessionId !== undefined ? options.sessionId : (root ? undefined : session.pageSessionId);
      const result = new Promise((resolve, reject) => {
        const timeoutMs = Math.min(180000, Math.max(1000, Number(options.timeoutMs) || 30000));
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, timeoutMs);
        pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); }
        });
      });
      await handle.sendMessage(sessionId ? { id, method, params, sessionId } : { id, method, params });
      return result;
    };
    session.on = (method, listener) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return () => listeners.get(method)?.delete(listener);
    };
    // Raw stream for cdp_events/network capture: every page event, not just the
    // handful the host subscribes to.
    session.anyListeners = new Set();
    session.onAny = listener => {
      session.anyListeners.add(listener);
      return () => session.anyListeners.delete(listener);
    };
    subscribeSessionEvents(entry, session);
    session.pageSessionId = await attachPageSession(session.send, session.on, entry.tab?.url || entry.url);
    // Runtime drives console/exception capture; Page drives load/frame events
    // and JS dialog interception. Enabling here (once per session) replaces the
    // old per-action re-injection.
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Page.enable').catch(() => {});
    await session.send('Log.enable').catch(() => {});
    // In-page fallback mask (used when the prebuilt workbench lacks the native
    // agent-control command) reports its manual dismissal through this binding.
    session.on('Runtime.bindingCalled', params => {
      if (params?.name === '__ubovmAgentOverlayDismiss') entry.agentOverlayDismissed = true;
    });
    await session.send('Runtime.addBinding', { name: '__ubovmAgentOverlayDismiss' }).catch(() => {});
    entry.session = session;
    return session;
  }

  function ensureSession(entry) {
    if (entry.session) return Promise.resolve(entry.session);
    if (!entry.sessionPromise) {
      entry.sessionPromise = createSession(entry).catch(error => { entry.sessionPromise = undefined; throw error; });
    }
    return entry.sessionPromise;
  }

  // One cached CDP session per page, reused across actions. A transiently
  // invalidated session is evicted so the next call reattaches; the failed
  // action is never replayed (retrying could double-apply a click).
  async function withSession(entry, fn) {
    const session = await ensureSession(entry);
    await showAgentOverlay(entry, session.send);
    await setAgentOperating(session.send, true);
    try {
      return await fn(session.send, session.on, session);
    } catch (error) {
      if (isSessionInvalid(error)) disposeSession(entry);
      throw error;
    } finally {
      await setAgentOperating(session.send, false);
      // Navigation replaces the document (and its overlay); restore the task
      // mask after every action so the page stays protected between slow calls.
      if (!nativeLockSupported && taskLocked && !entry.agentOverlayDismissed) {
        await showAgentOverlay(entry, session.send).catch(() => {});
      }
    }
  }

  function pickPageTarget(targets, preferredUrl) {
    const list = Array.isArray(targets) ? targets.filter(item => item && item.targetId) : [];
    const skip = new Set(['browser', 'service_worker', 'shared_worker', 'worker', 'worklet', 'iframe']);
    const pages = list.filter(item => item.type === 'page' || item.type === 'tab' || item.type === 'webview');
    if (preferredUrl) {
      const match = pages.find(item => item.url === preferredUrl) || list.find(item => item.url === preferredUrl);
      if (match) return match;
    }
    return pages[0] || list.find(item => !skip.has(item.type)) || list[0];
  }

  function isMethodNotFound(error) {
    const text = String(error?.message || error || '');
    return /method not found/i.test(text);
  }

  async function attachPageSession(send, on, preferredUrl) {
    try {
      await send('Target.setDiscoverTargets', { discover: true }, { root: true });
    } catch (error) {
      if (isMethodNotFound(error)) return undefined;
    }
    let infos;
    try {
      const result = await send('Target.getTargets', {}, { root: true });
      infos = result?.targetInfos;
    } catch (error) {
      if (isMethodNotFound(error)) return undefined;
      infos = undefined;
    }
    if (!Array.isArray(infos)) return undefined;
    let target = pickPageTarget(infos, preferredUrl);
    if (!target) {
      target = await new Promise(resolve => {
        const timer = setTimeout(() => {
          offCreated();
          offAttached();
          resolve(undefined);
        }, 1500);
        const finish = info => {
          const picked = pickPageTarget([info], preferredUrl);
          if (!picked) return;
          clearTimeout(timer);
          offCreated();
          offAttached();
          resolve(picked);
        };
        const offCreated = on('Target.targetCreated', params => {
          if (params?.targetInfo) finish(params.targetInfo);
        });
        const offAttached = on('Target.attachedToTarget', params => {
          if (params?.targetInfo) finish(params.targetInfo);
        });
      });
    }
    if (!target?.targetId) return undefined;
    try {
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, { root: true });
      return typeof attached?.sessionId === 'string' && attached.sessionId ? attached.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  async function ensurePage(binding, input) {
    let entry = resolveTab(input.page_id);
    if (!entry) {
      if (!browserEditorOpen()) return undefined;
      // The user already has a Browser pane open; fill it and continue.
      try {
        entry = await openTab(String(input.url || binding?.target || 'about:blank'), { preserveFocus: true, background: true });
      } catch { return undefined; }
    }
    activePageId = entry.id;
    if (!pageVisible(entry)) reportActivity(true, entry);
    return entry;
  }

  async function evaluate(send, expression, options = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise === true,
      returnByValue: true,
      userGesture: options.userGesture === true
    }, { timeoutMs: options.timeoutMs });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'evaluate failed';
      throw new Error(text);
    }
    const remote = result.result;
    // returnByValue omits non-serializable objects (nodes, buffers). Surface a
    // short description instead of silently returning undefined.
    if (remote && remote.value === undefined && remote.type === 'object' && remote.subtype && remote.subtype !== 'null') {
      return remote.description ?? `[${remote.subtype}]`;
    }
    return remote?.value;
  }

  async function evaluateHandle(send, expression, timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: false, returnByValue: false
    }, { timeoutMs: timeoutMs || 15000 });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    }
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error('weak reference required: the expression did not produce an object');
    return objectId;
  }

  function armLoadWait(on, timeoutMs) {
    let cancel = () => {};
    const promise = new Promise(resolve => {
      let done = false;
      const finish = reason => {
        if (done) return;
        done = true;
        off();
        offFrame();
        clearTimeout(timer);
        resolve(reason);
      };
      const off = on('Page.loadEventFired', () => finish('load'));
      const offFrame = on('Page.frameStoppedLoading', () => finish('frame'));
      const timer = setTimeout(() => finish('timeout'), Math.min(120000, Math.max(1000, timeoutMs)));
      cancel = () => finish('cancelled');
    });
    return { promise, cancel: () => cancel() };
  }

  /**
   * Wait for a navigation triggered by an interaction (click). Resolves
   * `no-navigation` quickly when the page did not start loading, so a click on a
   * non-navigating control does not block for the full timeout.
   */
  function armNavigationWait(on, timeoutMs, detectMs = 4000) {
    let cancel = () => {};
    const promise = new Promise(resolve => {
      let done = false;
      let started = false;
      const cleanup = () => {
        offStart(); offLoad(); offStop();
        clearTimeout(detect); clearTimeout(timer);
      };
      const finish = reason => {
        if (done) return;
        done = true;
        cleanup();
        resolve(reason);
      };
      const offStart = on('Page.frameStartedLoading', () => { started = true; clearTimeout(detect); });
      const offLoad = on('Page.loadEventFired', () => finish('load'));
      const offStop = on('Page.frameStoppedLoading', () => finish('frame'));
      const detect = setTimeout(() => { if (!started) finish('no-navigation'); }, Math.min(detectMs, timeoutMs));
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      cancel = () => finish('cancelled');
    });
    return { promise, cancel: () => cancel() };
  }

  function rememberRefs(entry, elements) {
    const map = new Map();
    for (const item of elements || []) map.set(item.ref, `[data-intools-ref="${item.ref}"]`);
    pageRefs.set(entry.id, map);
  }

  function requireRef(entry, ref) {
    if (!ref) throw new Error('ref is required');
    const known = pageRefs.get(entry.id);
    if (known && !known.has(ref)) throw new Error('Unknown or stale element ref; take a new snapshot');
    return ref;
  }

  async function perform(binding, input) {
    const action = input.action;
    if (!SUPPORTED.has(action)) {
      return { ok: false, error: UNSUPPORTED_HINT, action, source: 'ide-browser' };
    }
    if (action === 'status') {
      const tabs = listTabs();
      const available = await hasBrowserApi();
      return {
        session_id: binding.sessionId, worker_id: binding.workerId, source: 'ide-browser',
        manager_available: true, configured: available, available, connected: tabs.length > 0 || available,
        browser_action_available: available, isolated: false,
        state: available ? (tabs.length ? 'connected' : 'configured') : 'not_configured',
        page_open: tabs.length > 0,
        tab_count: tabs.length,
        active_page_id: activePageId || null,
        worker_page_id: activePageId || null,
        agent_control: taskLocked ? 'agent' : 'user',
        ...(taskLocked ? { agent_control_reason: taskLockReason } : {}),
        yield_supported: true,
        supported_actions: [...SUPPORTED],
        guidance: available
          ? (tabs.length
            ? 'IDE Integrated Browser has open tabs. Use navigate or tab_new. Network capture (network_start/network/network_stop), cookies and cdp_events are available. Snapshot refs work like Obscura (data-intools-ref); sitemap/identity/replay need the standalone Obscura mode (disable「使用 IDE 内嵌浏览器」).'
            : 'No IDE browser page is open. Browser actions return IDE_BROWSER_NOT_OPEN: click the floating prompt to open the page, or switch off「使用 IDE 内嵌浏览器」to use the standalone Chromium mode for hidden background browsing.')
          : 'Integrated Browser API is unavailable in this workbench build.'
      };
    }
    if (action === 'tabs') {
      const tabs = listTabs().map(tab => {
        const entry = track(tab);
        return {
          page_id: entry.id, url: tab.url, title: tab.title,
          active: entry.id === activePageId || tab === vscode.window.activeBrowserTab
        };
      });
      return { active_page_id: activePageId || null, pages: tabs, source: 'ide-browser' };
    }
    if (action === 'tab_new') {
      const target = input.url || 'about:blank';
      const visible = listTabs().some(tab => { const tracked = track(tab); return tracked && pageVisible(tracked); });
      if (!visible && !browserEditorOpen()) return notOpenResult(action, input, binding);
      const entry = await openTab(target, { preserveFocus: true, background: true });
      return { page_id: entry.id, url: entry.tab.url, title: entry.tab.title, source: 'ide-browser' };
    }
    if (action === 'tab_close') {
      const entry = resolveTab(input.page_id);
      if (!entry) return { ok: true, closed: false, source: 'ide-browser' };
      await entry.tab.close();
      forgetPage(entry.id);
      return { ok: true, closed: true, source: 'ide-browser' };
    }
    if (action === 'tab_activate') {
      const entry = resolveTab(input.page_id);
      if (!entry) return notOpenResult(action, input, binding);
      activePageId = entry.id;
      await reveal(entry.tab.url || entry.url || 'about:blank', {
        preserveFocus: false,
        force: true,
        pageId: entry.id
      });
      activePageId = entry.id;
      return {
        page_id: entry.id, url: entry.tab.url, title: entry.tab.title, source: 'ide-browser'
      };
    }

    const entry = await ensurePage(binding, input);
    if (!entry) return notOpenResult(action, input, binding);
    return withSession(entry, async (send, on) => {
      if (action === 'navigate') {
        const url = String(input.url || '');
        if (!url) throw new Error('navigate requires url');
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          await send('Page.enable').catch(() => {});
          const wait = armLoadWait(on, timeoutMs);
          let navigation;
          try { navigation = await send('Page.navigate', { url }); }
          catch (error) { wait.cancel(); throw error; }
          if (navigation?.errorText) {
            wait.cancel();
            throw Object.assign(new Error(`导航失败：${navigation.errorText}`), { code: 'IDE_BROWSER_NAVIGATION_FAILED' });
          }
          if (!navigation?.loaderId) {
            // Hash/route navigation does not fire load events.
            wait.cancel();
            entry.url = url;
            pageRefs.delete(entry.id);
            return { page_id: entry.id, url, loaded: true, load_state: 'same-document', source: 'ide-browser' };
          }
          const loadState = await wait.promise;
          entry.url = url;
          pageRefs.delete(entry.id);
          return { page_id: entry.id, url, loaded: loadState !== 'timeout' && loadState !== 'cancelled', load_state: loadState, source: 'ide-browser' };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'reload') {
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          await send('Page.enable').catch(() => {});
          const wait = armLoadWait(on, timeoutMs);
          await send('Page.reload', { ignoreCache: input.ignore_cache === true });
          const loadState = await wait.promise;
          pageRefs.delete(entry.id);
          return { page_id: entry.id, loaded: loadState !== 'timeout' && loadState !== 'cancelled', load_state: loadState, source: 'ide-browser' };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'back' || action === 'forward') {
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          const history = await send('Page.getNavigationHistory').catch(() => null);
          const index = history?.currentIndex;
          const targetIndex = action === 'back' ? index - 1 : index + 1;
          let loadState = 'unknown';
          if (Number.isInteger(index) && history?.entries?.[targetIndex]) {
            await send('Page.enable').catch(() => {});
            const wait = armLoadWait(on, timeoutMs);
            await send('Page.navigateToHistoryEntry', { entryId: history.entries[targetIndex].id });
            loadState = await wait.promise;
          } else if (!Number.isInteger(index)) {
            // Method unavailable: fall back to the page's own history API.
            await send('Page.enable').catch(() => {});
            const wait = armLoadWait(on, timeoutMs);
            await evaluate(send, action === 'back' ? 'history.back()' : 'history.forward()');
            loadState = await wait.promise;
          }
          pageRefs.delete(entry.id);
          return {
            page_id: entry.id, loaded: loadState !== 'timeout' && loadState !== 'cancelled',
            load_state: loadState, source: 'ide-browser'
          };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'screenshot') {
        // The mask is for the human reader; never bake it into agent captures.
        await hideAgentOverlay(entry, send);
        if (input.ref && input.full_page) throw new Error('Use either ref or full_page for screenshot');
        const format = input.format === 'png' ? 'png' : 'jpeg';
        const quality = format === 'jpeg' ? Math.min(100, Math.max(10, Number(input.quality) || 72)) : undefined;
        const capture = extras => send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}), ...extras });
        if (input.ref) {
          const ref = requireRef(entry, String(input.ref));
          const box = await evaluate(send, `(() => {
            const el = ${FIND_REF_SCRIPT}(${JSON.stringify(ref)});
            if (!el) throw new Error('Unknown or stale element ref; take a new snapshot');
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            const rect = el.getBoundingClientRect();
            // captureBeyondViewport uses page coordinates; fixed elements do not scroll.
            const fixed = getComputedStyle(el).position === 'fixed';
            const scrollX = fixed ? 0 : (window.scrollX || 0);
            const scrollY = fixed ? 0 : (window.scrollY || 0);
            return {
              x: Math.max(0, rect.x + scrollX), y: Math.max(0, rect.y + scrollY),
              width: Math.max(1, rect.width), height: Math.max(1, rect.height), scale: 1
            };
          })()`);
          const result = await capture({ clip: box, captureBeyondViewport: true });
          const bytes = Buffer.from(result.data, 'base64');
          return {
            page_id: entry.id, format, ref,
            image: { type: 'image', data: bytes.toString('base64'), mimeType: `image/${format}` },
            source: 'ide-browser'
          };
        }
        let clip;
        if (input.full_page === true) {
          const metrics = await send('Page.getLayoutMetrics').catch(() => null);
          const size = metrics?.cssContentSize || metrics?.contentSize;
          if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
            clip = { x: 0, y: 0, width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)), scale: 1 };
          }
        }
        const result = await capture(clip ? { clip, captureBeyondViewport: true } : { captureBeyondViewport: input.full_page === true });
        const bytes = Buffer.from(result.data, 'base64');
        return {
          page_id: entry.id, format,
          ...(clip ? { full_page: true, width: clip.width, height: clip.height } : {}),
          image: { type: 'image', data: bytes.toString('base64'), mimeType: `image/${format}` },
          source: 'ide-browser'
        };
      }
      if (action === 'frames') {
        const tree = await send('Page.getFrameTree').catch(() => null);
        const flatten = (node, parent) => {
          const frame = node?.frame || {};
          const list = [{
            frame_id: frame.id, parent_frame_id: parent || null,
            url: frame.url || '', name: frame.name || '',
            security_origin: frame.securityOrigin || '', mime_type: frame.mimeType || ''
          }];
          for (const child of node?.childFrames || []) list.push(...flatten(child, frame.id));
          return list;
        };
        return { page_id: entry.id, frames: tree?.frameTree ? flatten(tree.frameTree) : [], source: 'ide-browser' };
      }
      if (action === 'frame_evaluate') {
        const frameId = String(input.frame_id || '');
        if (!frameId) throw new Error('frame_evaluate requires frame_id (see action=frames)');
        const expression = String(input.script || input.expression || '');
        if (!expression) throw new Error('frame_evaluate requires script');
        const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ubovm-agent' });
        const contextId = world?.executionContextId;
        if (!contextId) throw new Error('could not create an execution context for the frame');
        const evaluation = await send('Runtime.evaluate', {
          expression, contextId,
          awaitPromise: input.await_promise !== false,
          returnByValue: true
        }, { timeoutMs: Math.min(180000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000)) });
        if (evaluation.exceptionDetails) {
          throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || 'frame_evaluate failed');
        }
        return {
          page_id: entry.id, frame_id: frameId,
          result: evaluation.result?.value ?? evaluation.result?.description ?? null,
          source: 'ide-browser'
        };
      }
      if (action === 'evaluate') {
        const expression = String(input.script || input.expression || '');
        if (!expression) throw new Error('evaluate requires script');
        const value = await evaluate(send, expression, {
          // Async scripts are common; allow opting out for expressions that
          // return a thenable but should not be awaited.
          awaitPromise: input.await_promise !== false,
          userGesture: input.user_gesture === true,
          timeoutMs: Math.min(180000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000))
        });
        return { page_id: entry.id, result: value, source: 'ide-browser' };
      }
      if (action === 'cdp') {
        const method = String(input.method || input.command || '');
        if (!method) throw new Error('cdp requires method');
        if (/^(Browser|Target|Storage)\./.test(method)) throw new Error('Browser-wide CDP domains are blocked');
        const result = await send(method, input.command_params || input.params || {});
        return { page_id: entry.id, result, source: 'ide-browser' };
      }
      if (action === 'cdp_events') {
        const buffer = eventBuffer(entry);
        const query = String(input.query || '').toLowerCase();
        const after = Math.max(0, Number(input.after_sequence) || 0);
        const limit = Math.min(200, Math.max(1, Number(input.limit) || 40));
        const selected = buffer.entries.filter(item => item.sequence > after
          && (!query || item.method.toLowerCase().includes(query) || String(item.params).toLowerCase().includes(query)));
        const entries = selected.slice(0, limit);
        return {
          page_id: entry.id, entries, total: selected.length, has_more: selected.length > entries.length,
          next_sequence: entries.length ? entries[entries.length - 1].sequence : Math.max(after, buffer.sequence),
          dropped_through_sequence: buffer.droppedThrough || undefined,
          source: 'ide-browser'
        };
      }
      if (action === 'dialogs') {
        const state = dialogBuffer(entry);
        const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
        const entries = state.entries.slice(-limit);
        if (input.clear === true) state.entries = [];
        return { page_id: entry.id, dialogs: entries, policy: state.policy, source: 'ide-browser' };
      }
      if (action === 'dialog_policy') {
        const state = dialogBuffer(entry);
        if (typeof input.accept === 'boolean') state.policy.accept = input.accept;
        if (input.prompt_text !== undefined) state.policy.promptText = String(input.prompt_text).slice(0, 2000);
        return { page_id: entry.id, accept: state.policy.accept, prompt_text: state.policy.promptText, source: 'ide-browser' };
      }
      if (action === 'storage') {
        const scope = ['local', 'session', 'both'].includes(String(input.source || '')) ? String(input.source) : 'both';
        const mutations = input.mutations && typeof input.mutations === 'object' ? input.mutations : {};
        const clear = input.clear === true;
        const values = await evaluate(send, `(() => {
          const scope = ${JSON.stringify(scope)};
          const mutations = ${JSON.stringify(mutations)};
          const stores = scope === 'local' ? [localStorage] : scope === 'session' ? [sessionStorage] : [localStorage, sessionStorage];
          if (${clear ? 'true' : 'false'}) for (const store of stores) store.clear();
          for (const store of stores) for (const [key, value] of Object.entries(mutations)) store.setItem(key, String(value));
          const read = store => Object.fromEntries(Array.from({ length: store.length }, (_, index) => store.key(index)).map(key => [key, String(store.getItem(key)).slice(0, 4000)]));
          const output = {};
          if (scope !== 'session') output.local = read(localStorage);
          if (scope !== 'local') output.session = read(sessionStorage);
          return output;
        })()`, { timeoutMs: 15000 });
        return { page_id: entry.id, storage: values, source: 'ide-browser' };
      }
      if (action === 'upload') {
        const ref = String(input.ref || '');
        if (!ref) throw new Error('upload requires ref');
        requireRef(entry, ref);
        const files = Array.isArray(input.values) ? input.values
          : (Array.isArray(input.mutations?.files) ? input.mutations.files : []);
        if (!files.length || files.some(file => typeof file !== 'string' || !file)) {
          throw new Error('upload requires values[] with absolute file paths');
        }
        await send('DOM.enable').catch(() => {});
        const objectId = await evaluateHandle(send, `(() => {
          const el = ${FIND_REF_SCRIPT}(${JSON.stringify(ref)});
          if (!el) throw new Error('Unknown or stale element ref; take a new snapshot');
          if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error('upload ref must be an <input type="file">');
          return el;
        })()`);
        const node = await send('DOM.requestNode', { objectId });
        if (!node?.nodeId) throw new Error('upload could not resolve the file input node');
        await send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
        return { page_id: entry.id, ok: true, files: files.length, source: 'ide-browser' };
      }
      if (action === 'network_start') {
        entry.network = { capture: true, entries: [], sequence: 0, droppedThrough: 0 };
        await send('Network.enable', {}).catch(error => { throw new Error('无法启用网络抓包：' + (error?.message || error)); });
        return { page_id: entry.id, capturing: true, source: 'ide-browser' };
      }
      if (action === 'network_stop') {
        if (entry.network) entry.network.capture = false;
        await send('Network.disable').catch(() => {});
        return { page_id: entry.id, capturing: false, source: 'ide-browser' };
      }
      if (action === 'network') {
        const buffer = networkBuffer(entry);
        const query = String(input.query || '').toLowerCase();
        const method = String(input.method || '').toUpperCase();
        const after = Math.max(0, Number(input.after_sequence) || 0);
        const limit = Math.min(200, Math.max(1, Number(input.limit || input.page_size) || 40));
        const selected = buffer.entries.filter(item => item.sequence > after
          && (!query || String(item.url || '').toLowerCase().includes(query))
          && (!method || String(item.method || '').toUpperCase() === method));
        const entries = selected.slice(0, limit);
        if (input.clear === true) {
          const removed = new Set(entries.map(item => item.sequence));
          buffer.entries = buffer.entries.filter(item => !removed.has(item.sequence));
        }
        return {
          page_id: entry.id, capturing: buffer.capture, entries, total: selected.length,
          has_more: selected.length > entries.length,
          next_sequence: entries.length ? entries[entries.length - 1].sequence : Math.max(after, buffer.sequence),
          dropped_through_sequence: buffer.droppedThrough || undefined,
          source: 'ide-browser'
        };
      }
      if (action === 'network_body') {
        const requestId = String(input.request_id || '');
        if (!requestId) throw new Error('network_body requires request_id');
        const body = await send('Network.getResponseBody', { requestId });
        const maxBytes = Math.min(1 << 20, Math.max(256, Number(input.max_bytes) || 65536));
        const encoded = body?.base64Encoded === true;
        const raw = encoded ? Buffer.from(String(body.body || ''), 'base64') : Buffer.from(String(body.body || ''), 'utf8');
        const slice = raw.subarray(0, maxBytes);
        return {
          page_id: entry.id, request_id: requestId, base64: encoded,
          body: encoded ? slice.toString('base64') : slice.toString('utf8'),
          truncated: raw.length > slice.length, total_bytes: raw.length,
          source: 'ide-browser'
        };
      }
      if (action === 'cookies') {
        const url = /^https?:/i.test(entry.url || entry.tab.url || '') ? (entry.url || entry.tab.url) : entry.tab.url;
        if (!/^https?:/i.test(url || '')) throw new Error('cookies requires an http(s) page');
        const result = await send('Network.getCookies', { urls: [url] });
        return {
          page_id: entry.id, url,
          cookies: (result?.cookies || []).map(cookie => ({
            name: cookie.name, domain: cookie.domain, path: cookie.path,
            secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
            sameSite: cookie.sameSite, expires: cookie.expires,
            value_present: typeof cookie.value === 'string' && cookie.value.length > 0,
            ...(input.include_credentials === true ? { value: cookie.value } : {})
          })),
          source: 'ide-browser'
        };
      }
      if (action === 'set_cookie') {
        const mutation = input.mutations && typeof input.mutations === 'object' ? input.mutations : {};
        const name = String(mutation.name || input.name || '');
        if (!name) throw new Error('set_cookie requires name');
        const params = {
          name, value: String(mutation.value ?? input.value ?? ''),
          ...(mutation.url ? { url: String(mutation.url) } : /^https?:/i.test(entry.url || '') ? { url: entry.url } : {}),
          ...(mutation.domain ? { domain: String(mutation.domain) } : {}),
          ...(mutation.path ? { path: String(mutation.path) } : {}),
          ...(mutation.secure !== undefined ? { secure: mutation.secure === true } : {}),
          ...(mutation.httpOnly !== undefined ? { httpOnly: mutation.httpOnly === true } : {}),
          ...(mutation.sameSite ? { sameSite: String(mutation.sameSite) } : {}),
          ...(Number.isFinite(Number(mutation.expires)) ? { expires: Number(mutation.expires) } : {})
        };
        const result = await send('Network.setCookie', params);
        return { page_id: entry.id, ok: result?.success !== false, name, domain: params.domain || params.url, source: 'ide-browser' };
      }
      if (action === 'clear_cookies') {
        const name = String(input.name || '');
        if (name) {
          await send('Network.deleteCookies', { name, ...(input.url ? { url: String(input.url) } : /^https?:/i.test(entry.url || '') ? { url: entry.url } : {}) });
        } else {
          await send('Network.clearBrowserCookies');
        }
        return { page_id: entry.id, ok: true, cleared: name ? 'named' : 'all', source: 'ide-browser' };
      }
      if (action === 'wait') {
        const ms = Math.min(120000, Math.max(0, Number(input.timeout_seconds || 30) * 1000));
        const condition = String(input.wait_for || (input.ref ? 'visible' : (input.query ? 'text' : 'load')));
        // Poll in the page so a wait costs one round trip instead of one per tick.
        const outcome = await evaluate(send, `(async () => {
          const p = ${JSON.stringify({ ref: input.ref ? String(input.ref) : '', query: input.query ? String(input.query).toLowerCase() : '', url: input.url ? String(input.url).toLowerCase() : '', condition, ms })};
          const deadline = Date.now() + p.ms;
          const find = ${FIND_REF_SCRIPT};
          const visible = el => {
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
            return !!(rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none');
          };
          const body = () => (document.body?.innerText || '').toLowerCase();
          let idleCount = -1, idleAt = 0;
          for (;;) {
            let ready;
            if (p.ref) {
              const el = find(p.ref);
              if (p.condition === 'attached') ready = !!el;
              else if (p.condition === 'detached') ready = !el;
              else if (p.condition === 'visible') ready = !!el && visible(el);
              else if (p.condition === 'hidden') ready = !el || !visible(el);
              else throw new Error('wait_for with ref must be visible, hidden, attached or detached');
            } else if (p.url || p.condition === 'url') {
              ready = location.href.toLowerCase().includes((p.url || p.condition).toLowerCase());
            } else if (p.query) {
              ready = body().includes(p.query);
            } else if (p.condition === 'networkidle') {
              // Approximate Chromium's networkidle: document loaded plus no new
              // resource entries observed for 500ms.
              const count = performance.getEntriesByType('resource').length;
              if (count !== idleCount) { idleCount = count; idleAt = Date.now(); }
              ready = document.readyState === 'complete' && Date.now() - idleAt >= 500;
            } else if (['load', 'domcontentloaded'].includes(p.condition)) {
              ready = document.readyState === 'complete';
            } else if (p.condition) {
              ready = body().includes(p.condition.toLowerCase());
            } else {
              ready = document.readyState === 'complete';
            }
            if (ready) return { ready: true };
            if (Date.now() >= deadline) return { ready: false };
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        })()`, { awaitPromise: true, timeoutMs: ms + 10000 });
        if (!outcome?.ready) throw new Error('wait timed out');
        return { page_id: entry.id, ok: true, wait_for: condition, ...(input.url ? { url: String(input.url) } : {}), source: 'ide-browser' };
      }
      if (action === 'snapshot' || action === 'accessibility') {
        // Keep the fallback mask out of the agent's DOM/accessibility view.
        await hideAgentOverlay(entry, send);
        const payload = {
          token: 'r' + randomUUID().replaceAll('-', '').slice(0, 12),
          max: Number(input.max_elements) > 0 ? Math.min(300, Number(input.max_elements)) : 120,
          chars: Number(input.max_chars) > 0 ? Math.min(20000, Number(input.max_chars)) : (action === 'accessibility' ? 1 : 6000),
          offset: Number(input.offset) > 0 ? Math.floor(Number(input.offset)) : 0,
          role: String(input.role || '').toLowerCase(),
          query: String(input.query || '').toLowerCase(),
          clear: true
        };
        const data = await evaluate(send, `(${SNAPSHOT_SCRIPT})(${JSON.stringify(payload)})`);
        rememberRefs(entry, data.elements);
        if (action === 'accessibility') {
          let tree = [];
          try {
            await send('Accessibility.enable').catch(() => {});
            const ax = await send('Accessibility.getFullAXTree');
            const nodes = ax.nodes || [];
            const filtered = nodes.filter(node => (input.include_ignored || !node.ignored)
              && (input.include_text || !['StaticText', 'InlineTextBox'].includes(node.role?.value))
              && (!payload.role || String(node.role?.value || '').toLowerCase() === payload.role)
              && (!payload.query || [node.name?.value, node.value?.value, node.description?.value].join(' ').toLowerCase().includes(payload.query)));
            const maxNodes = Number(input.max_nodes) > 0 ? Math.min(300, Number(input.max_nodes)) : 100;
            const offset = payload.offset;
            tree = filtered.slice(offset, offset + maxNodes).map(node => ({
              role: node.role?.value, name: node.name?.value, value: node.value?.value,
              description: node.description?.value, ignored: node.ignored
            }));
            return {
              page_id: entry.id, url: data.url, title: data.title, tree, nodes: tree, elements: data.elements,
              offset, next_offset: offset + tree.length < filtered.length ? offset + tree.length : null,
              has_more: offset + tree.length < filtered.length, total_nodes: filtered.length,
              source: 'ide-browser'
            };
          } catch {
            return { page_id: entry.id, ...data, tree, nodes: tree, source: 'ide-browser' };
          }
        }
        return { page_id: entry.id, ...data, source: 'ide-browser' };
      }
      if (['click', 'fill', 'select', 'check', 'press', 'hover', 'scroll'].includes(action)) {
        const ref = input.ref || input.selector ? String(input.ref || input.selector) : '';
        if (!ref && action !== 'press' && action !== 'scroll') throw new Error(`${action} requires ref`);
        if (ref) requireRef(entry, ref);
        if (action === 'check' && typeof input.checked !== 'boolean') throw new Error('checked must be a boolean');

        const centerOf = async expression => evaluate(send, `(() => {
          const el = ${expression};
          if (!el) throw new Error('Unknown or stale element ref; take a new snapshot');
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);

        // Real input events (not synthetic DOM calls) so hover styles, pointer
        // handlers, focus, and keyboard shortcuts behave like a user's.
        if (action === 'click' || action === 'hover') {
          const point = await centerOf(`${FIND_REF_SCRIPT}(${JSON.stringify(ref)})`);
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
          if (action === 'click') {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
            if (input.wait_for_navigation === true) {
              const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
              const wait = armNavigationWait(on, timeoutMs);
              const loadState = await wait.promise;
              pageRefs.delete(entry.id);
              return {
                page_id: entry.id, ok: true, action,
                loaded: loadState === 'load' || loadState === 'frame', load_state: loadState,
                source: 'ide-browser'
              };
            }
            return { page_id: entry.id, ok: true, action, source: 'ide-browser' };
          }
          return { page_id: entry.id, ok: true, action, source: 'ide-browser' };
        }
        if (action === 'scroll') {
          const point = ref
            ? await centerOf(`${FIND_REF_SCRIPT}(${JSON.stringify(ref)})`)
            : await evaluate(send, '({ x: Math.floor((window.innerWidth || 0) / 2), y: Math.floor((window.innerHeight || 0) / 2) })');
          await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: Number(input.delta_x) || 0, deltaY: Number(input.delta_y) || 0 });
          return { page_id: entry.id, ok: true, action, source: 'ide-browser' };
        }
        if (action === 'press') {
          if (ref) await evaluate(send, `(() => { const el = ${FIND_REF_SCRIPT}(${JSON.stringify(ref)}); if (el) el.focus(); return true; })()`);
          const key = String(input.key || 'Enter');
          const descriptor = keyDescriptor(key);
          // Printable keys carry text (keyDown + text, like Puppeteer); named keys use rawKeyDown.
          await send('Input.dispatchKeyEvent', {
            type: descriptor.text ? 'keyDown' : 'rawKeyDown',
            key: descriptor.key, code: descriptor.code,
            windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
            ...(descriptor.text ? { text: descriptor.text } : {})
          });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode });
          return { page_id: entry.id, ok: true, action, key: descriptor.key, source: 'ide-browser' };
        }

        // fill/select/check mutate the DOM directly and dispatch input/change.
        const payload = { action, ref, value: input.value ?? '', values: input.values || null, checked: input.checked };
        const value = await evaluate(send, `(() => {
          const p = ${JSON.stringify(payload)};
          const find = ${FIND_REF_SCRIPT};
          const el = p.ref ? find(p.ref) : null;
          if (!el) throw new Error('Unknown or stale element ref; take a new snapshot');
          if (p.action === 'fill') {
            el.focus();
            if (el.isContentEditable) el.textContent = p.value;
            else {
              // Use the native setter so React/Vue value trackers observe the change.
              const proto = typeof HTMLTextAreaElement !== 'undefined' && el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
              const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
              if (setter) setter.call(el, p.value); else el.value = p.value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
          if (p.action === 'select') {
            const list = Array.isArray(p.values) ? p.values : [p.value];
            if (el.multiple) [...el.options].forEach(option => { option.selected = list.includes(option.value); });
            else el.value = list[0] ?? '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, values: list };
          }
          if (p.action === 'check') {
            if (el.checked !== (p.checked === true)) el.click();
            if (el.checked !== (p.checked === true)) {
              el.checked = p.checked === true;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { ok: true, checked: el.checked === true };
          }
          return { ok: false };
        })()`, { userGesture: true });
        return { page_id: entry.id, ...value, source: 'ide-browser' };
      }
      if (action === 'console') {
        // Read the host-side ring buffer filled by Runtime.consoleAPICalled and
        // Runtime.exceptionThrown, so logs survive navigation and CSP.
        return { page_id: entry.id, ...consoleResult(consoleBuffer(entry), input), source: 'ide-browser' };
      }
      throw new Error(`Unsupported action: ${action}`);
    });
  }

  async function yieldAgentControl() {
    if (activeCalls > 0) {
      return {
        ok: false, code: 'IDE_BROWSER_BUSY', action: 'yield_control', source: 'ide-browser',
        guidance: 'A browser call is still returning. Retry yield_control after it completes.'
      };
    }
    const entry = (activePageId && pages.get(activePageId))
      || [...pages.values()].at(-1);
    taskLocked = false;
    releaseWhenIdle = false;
    if (nativeLockSupported) await setAgentControl(false, 'Agent released control for user interaction');
    removePageOverlays();
    for (const page of pages.values()) page.agentOverlayDismissed = false;
    return {
      ok: true, action: 'yield_control', source: 'ide-browser', control: 'user',
      ...(entry ? { page_id: entry.id, url: entry.tab.url, title: entry.tab.title } : {}),
      guidance: 'Agent control released. Ask the user to complete the interactive step (login, MFA, consent), then call browser_action again; the next action reacquires the lock automatically.'
    };
  }

  async function call(binding, input, signal) {
    signal?.throwIfAborted();
    if (input?.action === 'status') return perform(binding, input);
    if (input?.action === 'yield_control') return yieldAgentControl();
    return withLock(async () => {
      signal?.throwIfAborted();
      return perform(binding, input);
    });
  }

  async function status(binding) {
    return perform(binding || {}, { action: 'status' });
  }

  async function handle(op, payload = {}, signal) {
    signal?.throwIfAborted();
    if (op === 'status') return status(payload.binding || {});
    if (op === 'call') return call(payload.binding || {}, payload.input || {}, signal);
    if (op === 'open') return open(payload.url, payload.options);
    if (op === 'openAgentPage') return openAgentPage(payload.url);
    if (op === 'reveal') return reveal(payload.url, payload.options);
    if (op === 'navigate') return navigate(payload.url, payload.pageId || payload.page_id);
    if (op === 'listPages') return listPages();
    if (op === 'closePage') return closePage(payload.pageId || payload.page_id);
    if (op === 'setAgentControl') return setAgentControl(payload.locked, payload.reason);
    if (op === 'yieldControl') return yieldAgentControl();
    if (op === 'endAgentTask') return endAgentTask();
    throw new Error(`Unknown ide browser op: ${op}`);
  }

  async function open(url, options) {
    const entry = await openTab(url, options);
    markVisible(entry);
    // The user opened the page while an agent task is still running: reapply the
    // read-only task mask so the page stays protected.
    if (taskLocked) { try { await setAgentControl(true, taskLockReason); } catch { /* mask is best effort */ } }
    return entry;
  }

  // Agent-initiated fallback: after the click-through grace period the bridge may
  // ask the host to open the page itself (the user stayed idle). The tab may be
  // revealed by the workbench, which is acceptable after the grace period.
  async function openAgentPage(url) {
    const target = typeof url === 'string' && url ? url : 'about:blank';
    const entry = await openTab(target, { preserveFocus: true, background: true });
    activePageId = entry.id;
    if (!pageVisible(entry)) reportActivity(true, entry);
    if (taskLocked) { try { await setAgentControl(true, taskLockReason); } catch { /* mask is best effort */ } }
    return { page_id: entry.id, url: entry.tab.url, title: entry.tab.title, opened: true, source: 'ide-browser' };
  }

  function dispose() {
    reportActivity(false);
    for (const disposable of disposables) {
      try { disposable.dispose?.(); } catch { /* ignore */ }
    }
    disposables.length = 0;
    for (const entry of pages.values()) disposeSession(entry);
    pages.clear();
    pageRefs.clear();
    if (taskLocked) {
      taskLocked = false;
      void setAgentControl(false);
    }
  }

  return {
    call, status, open, reveal, navigate, listPages, closePage, setAgentControl, endAgentTask, handle, dispose,
    supportedActions: [...SUPPORTED]
  };
}

module.exports = { createIdeBrowserHost, SUPPORTED, UNSUPPORTED_HINT };
