// Chinese is the source language. English is the second locale.
// Unknown strings stay as written, so missing catalog entries remain Chinese.
(function (root) {
  'use strict';
  const STORAGE_KEY = 'ubovm.locale';
  const USER_TEXT_IDS = new Set(['conversation-title', 'goal-objective', 'workspace-name', 'context-label', 'goal-selection-label']);
  const SKIP = '#messages, #goal-output-content, #note-reader-body, #blackboard-nodes, #assist-activities, #collaboration-worker-list, #goal-workers-list, #goal-notes-list, #agent-notes-list, #outline-list, #exploration-run-list, #assist-evidence-list, #criteria-list, #project-switcher-list, #ubovm-modal-list, #settings-fields, .settings-locale-options, #ui-error-detail, pre, code, textarea, script, style';
  const catalog = { ...(root.UBOVM_I18N_EN || {}), ...(root.UBOVM_I18N_EN_MORE || {}) };
  const patterns = [
    [/^(\d[\d,]*) 条笔记$/, '$1 notes'],
    [/^(\d[\d,]*) 条记录$/, '$1 records'],
    [/^(\d[\d,]*) 条对话依据$/, '$1 conversation references'],
    [/^(\d[\d,]*) \/ (\d[\d,]*) 项已确认$/, '$1 / $2 confirmed'],
    [/^(\d[\d,]*) 运行中$/, '$1 running'],
    [/^找到 (\d[\d,]*) 条匹配记录$/, '$1 matching records'],
    [/^找到 (\d[\d,]*) \/ (\d[\d,]*) 个技能$/, 'Found $1 / $2 skills'],
    [/^已发现 (\d[\d,]*) 个技能$/, '$1 skills found'],
    [/^(\d[\d,]*) 个服务 · (\d[\d,]*) 个已启用$/, '$1 services · $2 enabled'],
    [/^(\d[\d,]*) 个连接$/, '$1 connections'],
    [/^(.+) · (\d[\d,]*) 条记录$/, '$1 · $2 records'],
    [/^基础配置 (\d)\/2 · 请完成(.+)。$/, 'Basic setup $1/2 · still needed: $2.'],
    [/^远程命令已超时（(\d+) 秒）。$/, 'Remote command timed out ($1 seconds).'],
    [/^正在下载… (\d+)%$/, 'Downloading… $1%'],
    [/^正在下载 (\d+)%$/, 'Downloading $1%'],
    [/^删除(探索会话|会话)“([\s\S]*)”？$/, (_, kind, name) => `Delete ${kind === '探索会话' ? 'exploration' : 'session'} “${name}”?`],
    [/^(\d+) 个服务 · (\d+) 个已启用$/, '$1 services · $2 enabled'],
    [/^(\d+) 个连接$/, '$1 connections'],
    [/^(\d+) 个技能$/, '$1 skills'],
    [/^(\d+) 个配置$/, '$1 profiles'],
    [/^(\d+) 个服务已加载$/, '$1 services loaded'],
    [/^(\d+) 个可用技能$/, '$1 skills available'],
    [/^(\d+) 条待发送输入$/, '$1 queued inputs'],
    [/^(\d+) 条结果$/, '$1 results'],
    [/^(\d+) 个工具调用$/, '$1 tool calls'],
    [/^(\d+) 个工具调用(?: · (\d+) 个运行中)?(?: · (\d+) 个失败)? · (收起历史|查看全部|展开 (\d+) 条历史)$/, (_, calls, running, failed, action, hidden) => `${calls} tool calls${running ? ` · ${running} running` : ''}${failed ? ` · ${failed} failed` : ''} · ${action === '收起历史' ? 'Hide history' : action === '查看全部' ? 'View all' : `Show ${hidden} earlier items`}`],
    [/^(\d+) 轮$/, '$1 turns'],
    [/^展开 (\d+) 条历史$/, 'Show $1 earlier items'],
    [/^本轮修改 (\d+) 个文件$/, '$1 files changed this turn'],
    [/^查询：([\s\S]*)$/, 'Query: $1'],
    [/^保存将更新“([\s\S]*)”$/, 'Saving updates “$1”'],
    [/^下次启动将使用 (English|中文)。$/, (_, name) => `The next start will use ${name === '中文' ? 'Chinese' : 'English'}.`],
    [/^(\d+)–(\d+) \/ (\d+) 条$/, '$1–$2 / $3 items'],
    [/^(\d+)–(\d+) \/ (\d+)$/, '$1–$2 / $3'],
    [/^找到 (\d+) \/ (\d+) 个技能$/, 'Found $1 / $2 skills'],
    [/^已发现 (\d+) 个技能$/, 'Found $1 skills'],
    [/^0 个技能$/, '0 skills'],
    [/^正在验证连接与登录认证（最多 (\d+) 秒）…$/, 'Checking the connection and login (up to $1 seconds)…'],
    [/^(\d+) 个协助会话 · (\d+) 个探索会话$/, '$1 assist sessions · $2 exploration sessions'],
    [/^(\d+) 个会话运行中$/, '$1 sessions running'],
    [/^(\d+) · (\d+) 运行$/, '$1 · $2 running'],
    [/^，(\d+) 个会话$/, ', $1 sessions'],
    [/^，(\d+) 个运行中$/, ', $1 running'],
    [/^(\d+) 条消息$/, '$1 messages'],
    [/^再显示 (\d+) 个会话$/, 'Show $1 more sessions'],
    [/^更多，还有 (\d+) 个会话$/, 'More, $1 sessions remaining']
  ];
  const textSource = new WeakMap();
  const attrSource = new WeakMap();
  let titleSource = '';
  let chosen = false;
  let locale = readLocale();
  let selected = locale;

  function readLocale() {
    try {
      const saved = root.localStorage?.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'zh-CN') { chosen = true; return saved; }
    } catch { /* Storage can be blocked in a locked webview. */ }
    return 'zh-CN';
  }
  function fill(text, args) {
    if (!args.length) return text;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      return text.replace(/\{(\w+)\}/g, (match, key) => args[0][key] == null ? match : String(args[0][key]));
    }
    return text.replace(/\{(\d+)\}/g, (match, index) => args[index] == null ? match : String(args[index]));
  }
  function lookup(source) {
    if (Object.prototype.hasOwnProperty.call(catalog, source)) return catalog[source];
    for (const [pattern, replacement] of patterns) {
      if (pattern.test(source)) return source.replace(pattern, replacement);
    }
    return source;
  }
  function t(message, ...args) {
    const source = message == null ? '' : String(message);
    return fill(locale === 'en' ? lookup(source) : source, args);
  }
  function canTranslate(value) {
    if (!value || value.length > 400) return false;
    return lookup(value) !== value;
  }
  function skipElement(element) {
    if (!element || USER_TEXT_IDS.has(element.id)) return true;
    return Boolean(element.closest(SKIP));
  }
  function formatNode(original) {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
    if (!match) return t(original);
    return match[1] + t(match[2]) + match[3];
  }
  function apply(scope) {
    const rootNode = scope && scope.nodeType ? scope : root.document?.body;
    if (!rootNode || !root.document) return;
    const walker = root.document.createTreeWalker(rootNode, root.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || skipElement(parent)) return root.NodeFilter.FILTER_REJECT;
        return root.NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      let original = textSource.get(node);
      const current = node.nodeValue;
      if (original != null && current !== original && current !== formatNode(original)) original = null;
      if (original == null) {
        const trimmed = current.trim();
        if (!canTranslate(trimmed)) continue;
        original = current;
        textSource.set(node, original);
      }
      const next = formatNode(original);
      if (node.nodeValue !== next) node.nodeValue = next;
    }
    const elements = rootNode.querySelectorAll ? rootNode.querySelectorAll('[title], [aria-label], [placeholder], [alt]') : [];
    for (const element of elements) {
      if (skipElement(element)) continue;
      let stored = attrSource.get(element);
      if (!stored) { stored = {}; attrSource.set(element, stored); }
      for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
        const current = element.getAttribute(name);
        if (current == null) continue;
        if (stored[name] != null && current !== stored[name] && current !== t(stored[name])) stored[name] = null;
        if (stored[name] == null) {
          if (!canTranslate(current)) continue;
          stored[name] = current;
        }
        const next = t(stored[name]);
        if (element.getAttribute(name) !== next) element.setAttribute(name, next);
      }
    }
    if (rootNode === root.document.body && root.document.title) {
      const current = root.document.title;
      if (!titleSource || (current !== titleSource && current !== t(titleSource))) titleSource = current;
      if (canTranslate(titleSource)) {
        const next = t(titleSource);
        if (root.document.title !== next) root.document.title = next;
      }
    }
  }
  function publishChoice(active) {
    try { root.UBOVMRuntime?.api?.postMessage({ action: 'setInterfaceLocale', locale: active ? locale : selected, active }); }
    catch { /* The next page load reports the saved language. */ }
  }
  function updateToggle() {
    const zh = root.document?.getElementById('settings-locale-zh');
    const en = root.document?.getElementById('settings-locale-en');
    if (zh) zh.setAttribute('aria-pressed', selected === 'zh-CN' ? 'true' : 'false');
    if (en) en.setAttribute('aria-pressed', selected === 'en' ? 'true' : 'false');
    const current = root.document?.getElementById('settings-locale-current');
    if (current) current.textContent = t(locale === 'en' ? '当前语言：English' : '当前语言：中文');
    const notice = root.document?.getElementById('settings-locale-notice');
    const noticeText = root.document?.getElementById('settings-locale-notice-text');
    const restart = root.document?.getElementById('settings-locale-restart');
    if (restart) restart.textContent = t('重新启动');
    if (!notice) return;
    const waiting = selected !== locale;
    notice.hidden = !waiting;
    if (waiting && noticeText) noticeText.textContent = t(selected === 'en' ? '下次启动将使用 English。' : '下次启动将使用中文。');
  }
  function setLocale(next, { persist = true, user = false, applyNow = true } = {}) {
    const resolved = next === 'en' ? 'en' : 'zh-CN';
    if (user) chosen = true;
    if (persist) {
      try { root.localStorage?.setItem(STORAGE_KEY, resolved); chosen = true; } catch { /* Ignore storage failures. */ }
    }
    selected = resolved;
    if (!applyNow) {
      updateToggle();
      if (user) publishChoice(false);
      return;
    }
    locale = resolved;
    if (root.document?.documentElement) root.document.documentElement.lang = resolved === 'en' ? 'en' : 'zh-CN';
    apply(root.document?.body);
    updateToggle();
    root.dispatchEvent?.(new root.CustomEvent('ubovm-locale', { detail: { locale: resolved } }));
    publishChoice(true);
  }
  function applyHostLocale(next) {
    if (chosen) return;
    if (next !== 'en' && next !== 'zh-CN') return;
    if (next === locale) return;
    setLocale(next, { persist: false, user: false });
  }
  function text(element, value) {
    if (!element) return;
    const source = value == null ? '' : String(value);
    const next = element.id && USER_TEXT_IDS.has(element.id) ? source : t(source);
    if (element.textContent !== next) element.textContent = next;
  }
  const api = { t, apply, setLocale, applyHostLocale, text, get locale() { return locale; }, get selected() { return selected; } };
  root.UBOVMi18n = api;
  if (root.document?.getElementById) {
    for (const button of root.document.querySelectorAll?.('.settings-locale [data-locale]') || []) {
      button.addEventListener('click', () => setLocale(button.dataset.locale, { user: true, applyNow: false }));
    }
    root.document.getElementById('settings-locale-restart')?.addEventListener('click', () => {
      if (selected === locale) return;
      try { root.UBOVMRuntime?.api?.postMessage({ action: 'restartWindow' }); } catch { /* The notice still tells the user to restart. */ }
    });
    if (locale === 'en') { if (root.document.documentElement) root.document.documentElement.lang = 'en'; apply(root.document.body); }
    updateToggle();
    publishChoice(true);
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
