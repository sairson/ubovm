'use strict';

const { randomUUID } = require('node:crypto');

const SUPPORTED = new Set([
  'status', 'tabs', 'tab_new', 'tab_close', 'tab_activate',
  'navigate', 'back', 'forward', 'reload',
  'snapshot', 'accessibility', 'screenshot', 'evaluate',
  'click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'wait',
  'console', 'cdp'
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

function createIdeBrowserHost(vscode, { lockCommand = 'workbench.action.browser.setAgentControlLock' } = {}) {
  const pages = new Map();
  const pageRefs = new Map();
  let activePageId;
  let nextCdpId = 1;
  let lockDepth = 0;
  const disposables = [];

  function listTabs() {
    return typeof vscode.window.browserTabs !== 'undefined' ? [...vscode.window.browserTabs] : [];
  }

  function consoleBuffer(entry) {
    if (!entry.console) entry.console = { entries: [], sequence: 0, droppedThrough: 0 };
    return entry.console;
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
      if (tab) track(tab, undefined, { activate: true });
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
    const target = typeof url === 'string' && url ? url : 'about:blank';
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
      return track(existing, preferred?.id, { activate: true });
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
        return track(existing, preferred?.id, { activate: true });
      }
      return openTab(target, options);
    }
    const tabs = listTabs();
    const match = (preferred && tabs.includes(preferred.tab) ? preferred.tab : undefined)
      || tabs.find(tab => tab.url === target)
      || existing
      || tabs[tabs.length - 1];
    if (!match) throw new Error('无法聚焦 IDE 内置浏览器页面。');
    return track(match, preferred?.id, { activate: true });
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
    // Focus the page when possible, then navigate the resolved page_id in-place.
    if (vscode.window.activeBrowserTab !== entry.tab) {
      await reveal(entry.tab.url || entry.url || 'about:blank', { force: true, pageId: entry.id });
    }
    entry = resolveTab(entry.id) || entry;
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
    } catch {
      // Prebuilt without the lock command still allows automation; page-level lock is best-effort.
    }
  }

  async function withLock(action) {
    lockDepth++;
    if (lockDepth === 1) await setAgentControl(true);
    try { return await action(); }
    finally {
      lockDepth = Math.max(0, lockDepth - 1);
      if (lockDepth === 0) await setAgentControl(false);
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
    // Navigation (by link, form, or history) invalidates refs; console survives.
    session.on('Page.frameNavigated', params => { if (!params?.frame?.parentId) pageRefs.delete(entry.id); });
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
    });
    session.send = async (method, params, options = {}) => {
      const id = nextCdpId++;
      const root = options.root === true || method.startsWith('Target.') || method.startsWith('Browser.');
      const sessionId = options.sessionId !== undefined ? options.sessionId : (root ? undefined : session.pageSessionId);
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 30000);
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
    subscribeSessionEvents(entry, session);
    session.pageSessionId = await attachPageSession(session.send, session.on, entry.tab?.url || entry.url);
    // Runtime drives console/exception capture; Page drives load/frame events.
    // Enabling here (once per session) replaces the old per-action re-injection.
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Page.enable').catch(() => {});
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
    try {
      return await fn(session.send, session.on, session);
    } catch (error) {
      if (isSessionInvalid(error)) disposeSession(entry);
      throw error;
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
      const target = input.url || binding?.target || 'about:blank';
      entry = await openTab(target, { preserveFocus: true });
    }
    activePageId = entry.id;
    return entry;
  }

  async function evaluate(send, expression, options = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise === true,
      returnByValue: true,
      userGesture: options.userGesture === true
    });
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

  function armLoadWait(on, timeoutMs) {
    // Must not be async: returning a Promise from async would flatten and wait before navigate.
    return new Promise(resolve => {
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
      const timer = setTimeout(() => finish('timeout'), Math.min(timeoutMs, 15000));
    });
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
      const available = typeof vscode.window.openBrowserTab === 'function'
        || !!(await vscode.commands.getCommands(true)).includes('workbench.action.browser.open');
      return {
        session_id: binding.sessionId, worker_id: binding.workerId, source: 'ide-browser',
        manager_available: true, configured: available, available, connected: tabs.length > 0 || available,
        browser_action_available: available, isolated: false,
        state: available ? (tabs.length ? 'connected' : 'configured') : 'not_configured',
        worker_page_id: activePageId || null,
        supported_actions: [...SUPPORTED],
        guidance: available
          ? 'IDE Integrated Browser is ready; use navigate or tab_new. Snapshot refs work like Obscura (data-intools-ref). Network/identity/sitemap actions require disabling ideBrowser.'
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
      const entry = await openTab(input.url || 'about:blank', { preserveFocus: true, background: true });
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
      if (!entry) throw new Error('Unknown page_id');
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
    return withSession(entry, async (send, on) => {
      if (action === 'navigate') {
        const url = String(input.url || '');
        if (!url) throw new Error('navigate requires url');
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          await send('Page.enable').catch(() => {});
          const waiting = armLoadWait(on, timeoutMs);
          await send('Page.navigate', { url });
          await waiting;
          entry.url = url;
          pageRefs.delete(entry.id);
          return { page_id: entry.id, url, source: 'ide-browser' };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'reload') {
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          await send('Page.enable').catch(() => {});
          const waiting = armLoadWait(on, timeoutMs);
          await send('Page.reload');
          await waiting;
          pageRefs.delete(entry.id);
          return { page_id: entry.id, source: 'ide-browser' };
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
          if (Number.isInteger(index) && history?.entries?.[targetIndex]) {
            await send('Page.enable').catch(() => {});
            const waiting = armLoadWait(on, timeoutMs);
            await send('Page.navigateToHistoryEntry', { entryId: history.entries[targetIndex].id });
            await waiting;
          } else if (!Number.isInteger(index)) {
            // Method unavailable: fall back to the page's own history API.
            await evaluate(send, action === 'back' ? 'history.back()' : 'history.forward()');
          }
          pageRefs.delete(entry.id);
          return { page_id: entry.id, source: 'ide-browser' };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'screenshot') {
        if (input.ref && input.full_page) throw new Error('Use either ref or full_page for screenshot');
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
          const result = await send('Page.captureScreenshot', {
            format: 'jpeg', quality: 72, clip: box, captureBeyondViewport: true
          });
          const bytes = Buffer.from(result.data, 'base64');
          return {
            page_id: entry.id, format: 'jpeg', ref,
            image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
            source: 'ide-browser'
          };
        }
        const result = await send('Page.captureScreenshot', {
          format: 'jpeg', quality: 72, captureBeyondViewport: input.full_page === true
        });
        const bytes = Buffer.from(result.data, 'base64');
        return {
          page_id: entry.id, format: 'jpeg',
          image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
          source: 'ide-browser'
        };
      }
      if (action === 'evaluate') {
        const expression = String(input.script || input.expression || '');
        if (!expression) throw new Error('evaluate requires script');
        const value = await evaluate(send, expression, { awaitPromise: true });
        return { page_id: entry.id, result: value, source: 'ide-browser' };
      }
      if (action === 'cdp') {
        const method = String(input.method || input.command || '');
        if (!method) throw new Error('cdp requires method');
        if (/^(Browser|Target|Storage)\./.test(method)) throw new Error('Browser-wide CDP domains are blocked');
        const result = await send(method, input.command_params || input.params || {});
        return { page_id: entry.id, result, source: 'ide-browser' };
      }
      if (action === 'wait') {
        const ms = Math.min(120000, Math.max(0, Number(input.timeout_seconds || 30) * 1000));
        const condition = String(input.wait_for || (input.ref ? 'visible' : (input.query ? 'text' : 'load')));
        // Poll in the page so a wait costs one round trip instead of one per tick.
        const outcome = await evaluate(send, `(async () => {
          const p = ${JSON.stringify({ ref: input.ref ? String(input.ref) : '', query: input.query ? String(input.query).toLowerCase() : '', condition, ms })};
          const deadline = Date.now() + p.ms;
          const find = ${FIND_REF_SCRIPT};
          const visible = el => {
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
            return !!(rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none');
          };
          const body = () => (document.body?.innerText || '').toLowerCase();
          for (;;) {
            let ready;
            if (p.ref) {
              const el = find(p.ref);
              if (p.condition === 'attached') ready = !!el;
              else if (p.condition === 'detached') ready = !el;
              else if (p.condition === 'visible') ready = !!el && visible(el);
              else if (p.condition === 'hidden') ready = !el || !visible(el);
              else throw new Error('wait_for with ref must be visible, hidden, attached or detached');
            } else if (p.query) {
              ready = body().includes(p.query);
            } else if (['load', 'domcontentloaded', 'networkidle'].includes(p.condition)) {
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
        })()`, { awaitPromise: true });
        if (!outcome?.ready) throw new Error('wait timed out');
        return { page_id: entry.id, ok: true, wait_for: condition, source: 'ide-browser' };
      }
      if (action === 'snapshot' || action === 'accessibility') {
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

  async function call(binding, input, signal) {
    signal?.throwIfAborted();
    if (input?.action === 'status') return perform(binding, input);
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
    if (op === 'reveal') return reveal(payload.url, payload.options);
    if (op === 'navigate') return navigate(payload.url, payload.pageId || payload.page_id);
    if (op === 'listPages') return listPages();
    if (op === 'closePage') return closePage(payload.pageId || payload.page_id);
    if (op === 'setAgentControl') return setAgentControl(payload.locked, payload.reason);
    throw new Error(`Unknown ide browser op: ${op}`);
  }

  async function open(url, options) {
    return openTab(url, options);
  }

  function dispose() {
    for (const disposable of disposables) {
      try { disposable.dispose?.(); } catch { /* ignore */ }
    }
    disposables.length = 0;
    for (const entry of pages.values()) disposeSession(entry);
    pages.clear();
    pageRefs.clear();
    if (lockDepth > 0) {
      lockDepth = 0;
      void setAgentControl(false);
    }
  }

  return {
    call, status, open, reveal, navigate, listPages, closePage, setAgentControl, handle, dispose,
    supportedActions: [...SUPPORTED]
  };
}

module.exports = { createIdeBrowserHost, SUPPORTED, UNSUPPORTED_HINT };
