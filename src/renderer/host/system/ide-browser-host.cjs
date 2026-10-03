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
    .filter(({ data }) => (!role || data.role.toLowerCase().includes(role)) && (!query || data.name.toLowerCase().includes(query)));
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

const CONSOLE_INSTALL_SCRIPT = `(() => {
  if (window.__ubovmConsole) return { installed: true, existing: true };
  const state = { entries: [], seq: 0, dropped: 0 };
  const push = entry => {
    state.entries.push(entry);
    if (state.entries.length > 500) { state.entries.shift(); state.dropped++; }
  };
  const textOf = args => args.map(value => {
    try { return typeof value === 'string' ? value : JSON.stringify(value); }
    catch { return String(value); }
  }).join(' ').slice(0, 4000);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      push({
        sequence: ++state.seq, timestamp: Date.now(), kind: 'console',
        level: level === 'warn' ? 'warning' : level, text: textOf(args)
      });
      return original(...args);
    };
  }
  window.addEventListener('error', event => {
    push({
      sequence: ++state.seq, timestamp: Date.now(), kind: 'page_error', level: 'error',
      text: String(event.message || event.error || 'error').slice(0, 4000)
    });
  });
  window.addEventListener('unhandledrejection', event => {
    push({
      sequence: ++state.seq, timestamp: Date.now(), kind: 'page_error', level: 'error',
      text: String(event.reason || 'unhandledrejection').slice(0, 4000)
    });
  });
  window.__ubovmConsole = state;
  return { installed: true, existing: false };
})()`;

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

  function forgetPage(id) {
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

  async function withCDP(entry, fn) {
    if (!entry?.tab?.startCDPSession) throw new Error('当前浏览器标签不支持 CDP。');
    const session = await entry.tab.startCDPSession();
    const pending = new Map();
    const listeners = new Map();
    let pageSessionId;
    const onMessage = session.onDidReceiveMessage(message => {
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
    const send = async (method, params, options = {}) => {
      const id = nextCdpId++;
      const root = options.root === true || method.startsWith('Target.') || method.startsWith('Browser.');
      const sessionId = options.sessionId !== undefined
        ? options.sessionId
        : (root ? undefined : pageSessionId);
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
      await session.sendMessage(sessionId ? { id, method, params, sessionId } : { id, method, params });
      return result;
    };
    const on = (method, listener) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return () => listeners.get(method)?.delete(listener);
    };
    try {
      pageSessionId = await attachPageSession(send, on, entry.tab?.url || entry.url);
      return await fn(send, { on, session, pageSessionId });
    } finally {
      onMessage.dispose?.();
      try { await session.close(); } catch { /* session may already be closed */ }
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
    return result.result?.value;
  }

  async function installConsole(send) {
    await evaluate(send, CONSOLE_INSTALL_SCRIPT);
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
    return withCDP(entry, async (send, { on }) => {
      await send('Runtime.enable').catch(() => {});
      await installConsole(send).catch(() => {});

      if (action === 'navigate') {
        const url = String(input.url || '');
        if (!url) throw new Error('navigate requires url');
        const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_seconds || 30) * 1000));
        entry.loading = true;
        try {
          await send('Page.enable');
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
          await send('Page.enable');
          const waiting = armLoadWait(on, timeoutMs);
          await send('Page.reload');
          await waiting;
          pageRefs.delete(entry.id);
          return { page_id: entry.id, source: 'ide-browser' };
        } finally {
          entry.loading = false;
        }
      }
      if (action === 'back') {
        await evaluate(send, 'history.back()');
        pageRefs.delete(entry.id);
        return { page_id: entry.id, source: 'ide-browser' };
      }
      if (action === 'forward') {
        await evaluate(send, 'history.forward()');
        pageRefs.delete(entry.id);
        return { page_id: entry.id, source: 'ide-browser' };
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
            const dpr = window.devicePixelRatio || 1;
            return {
              x: Math.max(0, rect.x * dpr), y: Math.max(0, rect.y * dpr),
              width: Math.max(1, rect.width * dpr), height: Math.max(1, rect.height * dpr),
              scale: 1
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
        const ms = Math.min(120000, Math.max(0, Number(input.timeout_seconds || 1) * 1000));
        const condition = String(input.wait_for || (input.ref ? 'attached' : 'load'));
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          let ready = false;
          if (input.ref) {
            const ref = String(input.ref);
            const present = await evaluate(send, `!!(${FIND_REF_SCRIPT}(${JSON.stringify(ref)}))`);
            if (condition === 'attached' || condition === 'visible') {
              if (condition === 'visible') {
                ready = await evaluate(send, `(() => {
                  const el = ${FIND_REF_SCRIPT}(${JSON.stringify(ref)});
                  if (!el) return false;
                  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
                  return !!(rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none');
                })()`);
              } else ready = present === true;
            } else if (condition === 'detached' || condition === 'hidden') {
              if (condition === 'hidden') {
                ready = await evaluate(send, `(() => {
                  const el = ${FIND_REF_SCRIPT}(${JSON.stringify(ref)});
                  if (!el) return true;
                  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
                  return !(rect.width && rect.height) || style.visibility === 'hidden' || style.display === 'none';
                })()`);
              } else ready = present !== true;
            } else {
              throw new Error('wait_for with ref must be visible, hidden, attached or detached');
            }
          } else if (input.query) {
            ready = await evaluate(send, `document.body?.innerText?.toLowerCase().includes(${JSON.stringify(String(input.query).toLowerCase())})`);
          } else {
            ready = await evaluate(send, 'document.readyState === "complete"');
          }
          if (ready) return { page_id: entry.id, ok: true, wait_for: condition, source: 'ide-browser' };
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('wait timed out');
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
        const payload = {
          action, ref, value: input.value ?? '', values: input.values || null,
          checked: input.checked, key: input.key || 'Enter',
          deltaX: Number(input.delta_x) || 0, deltaY: Number(input.delta_y) || 0
        };
        const value = await evaluate(send, `(() => {
          const p = ${JSON.stringify(payload)};
          const find = ${FIND_REF_SCRIPT};
          const el = p.ref ? find(p.ref) : null;
          if (p.action !== 'press' && p.action !== 'scroll' && !el) throw new Error('Unknown or stale element ref; take a new snapshot');
          if (p.action === 'click') {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            el.click();
            return { ok: true };
          }
          if (p.action === 'hover') {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
            return { ok: true };
          }
          if (p.action === 'fill') {
            el.focus();
            if (el.isContentEditable) el.textContent = p.value;
            else {
              el.value = p.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
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
            el.checked = p.checked === true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, checked: el.checked };
          }
          if (p.action === 'press') {
            const target = el || document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', { key: p.key, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keypress', { key: p.key, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: p.key, bubbles: true }));
            return { ok: true };
          }
          if (p.action === 'scroll') {
            if (el) el.scrollBy(p.deltaX, p.deltaY);
            else window.scrollBy(p.deltaX, p.deltaY);
            return { ok: true };
          }
          return { ok: false };
        })()`, { userGesture: true });
        return { page_id: entry.id, ...value, source: 'ide-browser' };
      }
      if (action === 'console') {
        const after = Number(input.after_sequence) > 0 ? Number(input.after_sequence) : 0;
        const limit = Number(input.limit) > 0 ? Math.min(100, Number(input.limit)) : 40;
        const level = input.level ? String(input.level) : '';
        const query = String(input.query || '').toLowerCase();
        const result = await evaluate(send, `(() => {
          const state = window.__ubovmConsole || { entries: [], seq: 0, dropped: 0 };
          const all = state.entries.filter(entry => entry.sequence > ${after});
          const matched = all.filter(entry =>
            (!${JSON.stringify(level)} || entry.level === ${JSON.stringify(level)}) &&
            (!${JSON.stringify(query)} || String(entry.text || '').toLowerCase().includes(${JSON.stringify(query)}))
          );
          const entries = matched.slice(0, ${limit});
          if (${input.clear === true}) {
            const remove = new Set(entries.map(entry => entry.sequence));
            state.entries = state.entries.filter(entry => !remove.has(entry.sequence));
          }
          const examined = all.length ? all[all.length - 1].sequence : ${after};
          return {
            entries,
            next_sequence: matched.length > entries.length
              ? entries[entries.length - 1].sequence
              : Math.max(examined, state.seq || 0),
            buffer_overflow: state.dropped > 0,
            dropped_through_sequence: state.dropped > 0 ? state.dropped : undefined
          };
        })()`);
        return { page_id: entry.id, ...(result || { entries: [], next_sequence: 0 }), source: 'ide-browser' };
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
