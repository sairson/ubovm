'use strict';

// Exploration chat sidebar: a native right-side-bar WebviewView (same tab strip
// as Explorer / Worker / Blackboard). The page only renders the projection the
// host publishes; every model request goes through the host so the session
// identity is never trusted from the page.

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createLatestDelivery } = require('../agent/latest-delivery.cjs');
const { interfaceText, currentInterfaceLocale } = require('../../harness/runtime/interface-text.cjs');

let bundle;
function loadBundle() {
  const read = file => readFileSync(path.join(__dirname, '../../webview', file), 'utf8');
  const styles = ['styles.css', 'theme.css', 'messages/message-markdown.css', 'messages/message-view.css', 'goal/goal-chat.css']
    .map(read).join('\n');
  const scripts = ['i18n-en.js', 'i18n-en-more.js', 'i18n.js', 'vendor/marked.umd.js', 'messages/message-markdown.js',
    'messages/timeline-parts.js', 'messages/message-view.js', 'goal/goal-chat.js', 'goal/goal-chat-view.js']
    .map(read).join('\n;\n').replace(/<\/script/gi, '<\\/script');
  return bundle = { styles, scripts };
}

function renderGoalChatPanel() {
  const nonce = randomBytes(24).toString('hex');
  const { styles, scripts: source } = loadBundle();
  const locale = currentInterfaceLocale();
  const scripts = `try{localStorage.setItem('ubovm.locale',${JSON.stringify(locale)})}catch(e){}\n;${source}`;
  const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style nonce="${nonce}">${styles}
  html,body{height:100%}
  body{margin:0;overflow:hidden;color:var(--vscode-foreground,#292a2d);background:var(--vscode-sideBar-background,var(--canvas,#f7f7f6));font-family:var(--vscode-font-family,'Segoe UI','Microsoft YaHei UI',sans-serif);font-size:var(--vscode-font-size,13px)}
  /* The native sidebar owns the tab chrome; the page is the chat surface only,
     laid out like the upstream agent chat view: quiet centre, floating composer. */
  #goal-chat.goal-chat-page{width:100%;height:100%;border-left:0;background:transparent;--goal-chat-width:100%}
  #goal-chat.goal-chat-page .goal-chat-header,
  #goal-chat.goal-chat-page .goal-chat-body,
  #goal-chat.goal-chat-page .goal-chat-composer{min-width:0}
  #goal-chat-loading{margin:0;padding:24px 18px;color:var(--vscode-descriptionForeground,#666);font-size:12px;line-height:1.7}
  </style></head><body>
  <p id="goal-chat-loading" role="status">${html(interfaceText('正在连接探索对话…'))}</p>
  <aside id="goal-chat" class="goal-chat goal-chat-page" aria-label="${html(interfaceText('探索对话'))}" data-open="true" data-status="idle" hidden>
    <div class="goal-chat-threads" id="goal-chat-threads" role="tablist" aria-label="${html(interfaceText('探索对话会话'))}" hidden>
      <div class="goal-chat-thread-list" id="goal-chat-thread-list"></div>
      <button class="goal-chat-thread-new" id="goal-chat-thread-new" type="button" aria-label="${html(interfaceText('在当前探索中新建对话'))}" title="${html(interfaceText('在当前探索中新建对话'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
    <div class="goal-chat-body" id="goal-chat-body">
      <div class="goal-chat-empty" id="goal-chat-empty">
        <span class="goal-chat-hero" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-2 2V11.5A8.5 8.5 0 0 1 11.5 3h1A8.5 8.5 0 0 1 21 11.5Z"/><path d="m13 7 .9 2.1L16 10l-2.1.9L13 13l-.9-2.1L10 10l2.1-.9L13 7Z"/></svg></span>
        <h2 class="goal-chat-hero-title">${html(interfaceText('问探索进展'))}</h2>
        <p class="goal-chat-empty-copy">${html(interfaceText('查看 Reason 和 Worker 状态、事实与探索图；可读写工作区文件、创建意图、管理 Worker 与执行状态。'))}</p>
        <div class="goal-chat-suggestions" role="group" aria-label="${html(interfaceText('快捷问题'))}">
          <button class="goal-chat-suggestion" type="button" data-question="${html(interfaceText('现在进展到哪一步了？'))}">${html(interfaceText('现在进展到哪一步了？'))}</button>
          <button class="goal-chat-suggestion" type="button" data-question="${html(interfaceText('还有哪些没有验证完？'))}">${html(interfaceText('还有哪些没有验证完？'))}</button>
          <button class="goal-chat-suggestion" type="button" data-question="${html(interfaceText('下一步建议做什么？'))}">${html(interfaceText('下一步建议做什么？'))}</button>
        </div>
      </div>
      <div class="goal-chat-log" id="goal-chat-log" role="log" aria-live="polite" aria-relevant="additions text"></div>
      <p class="goal-chat-error" id="goal-chat-error" role="alert" hidden></p>
    </div>
    <div class="goal-chat-composer" id="goal-chat-composer">
      <button class="goal-chat-latest" id="goal-chat-latest" type="button" hidden>${html(interfaceText('↓ 回到最新'))}</button>
      <form class="goal-chat-form" id="goal-chat-form" aria-label="${html(interfaceText('探索对话输入'))}">
        <div class="goal-chat-images" id="goal-chat-images" role="group" aria-label="${html(interfaceText('待发送图片'))}" hidden></div>
        <label class="goal-chat-sr-only" for="goal-chat-input">${html(interfaceText('向探索对话提问'))}</label>
        <textarea class="goal-chat-input" id="goal-chat-input" rows="1" maxlength="4000" placeholder="${html(interfaceText('就当前探索提问…'))}" aria-describedby="goal-chat-hint goal-chat-count" disabled></textarea>
        <div class="goal-chat-toolbar">
          <button class="goal-chat-attach" id="goal-chat-attach" type="button" aria-label="${html(interfaceText('添加图片'))}" title="${html(interfaceText('添加图片'))}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z"/><path d="m4 16 4.5-4.5 3 3L15 11l5 5"/><path d="M15.5 8.5h.01"/></svg></button>
          <input class="goal-chat-image-input" id="goal-chat-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" multiple hidden>
          <span class="goal-chat-chip goal-chat-chip-readonly" title="${html(interfaceText('查看探索状态与证据，可管理 Worker 和探索意图；不执行命令或修改文件'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6a1.4 1.4 0 0 0 2 2l6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3Z"/></svg>${html(interfaceText('查看与管理'))}</span>
          <span class="goal-chat-chip goal-chat-chip-agent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m18.5 14 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"/></svg>${html(interfaceText('探索助手'))}</span>
          <span class="goal-chat-notice" id="goal-chat-notice" role="status" hidden></span>
          <span class="goal-chat-count" id="goal-chat-count">0 / 4,000</span>
          <button class="goal-chat-stop" id="goal-chat-stop" type="button" hidden>${html(interfaceText('停止回答'))}</button>
          <button class="goal-chat-send" id="goal-chat-send" type="submit" aria-label="${html(interfaceText('发送探索对话消息'))}" title="${html(interfaceText('发送（Enter）'))}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
        </div>
      </form>
      <p class="goal-chat-hint" id="goal-chat-hint">${html(interfaceText('Enter 发送 · Shift + Enter 换行，可粘贴或拖入图片'))}</p>
    </div>
  </aside>
  <script nonce="${nonce}">${scripts}</script></body></html>`;
}

/**
 * WebviewViewProvider for `ubovm.goalChat`.
 * options.onAction(message, view) handles page actions (send/cancel/copy/link/openFiles).
 */
function createGoalChatPanel(vscode, { onAction, onError = () => {}, onVisibilityChange = () => {}, readyTimeout = 15000 } = {}) {
  let view, ready = false, disposed = false, payload, subscriptions = [];
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Reporting cannot break cleanup. */ }
  };
  const notifyVisibility = () => {
    try { Promise.resolve(onVisibilityChange()).catch(() => {}); } catch { /* Observers cannot break the panel. */ }
  };
  const delivery = createLatestDelivery(report);
  function releaseView() {
    view = undefined; ready = false; delivery.clear();
    const current = subscriptions; subscriptions = [];
    for (const subscription of current) {
      try { Promise.resolve(subscription?.dispose?.()).catch(report); } catch (error) { report(error); }
    }
  }
  function stateView() {
    const state = payload && typeof payload === 'object' ? payload : {};
    return { type: 'goalChat', ...state };
  }
  function publish() {
    if (disposed || !ready || !view?.visible || !payload) return undefined;
    return delivery.publish(() => {
      if (!ready || !view?.visible || !payload) return undefined;
      return view.webview.postMessage(stateView());
    });
  }
  return {
    get visible() { return ready && view?.visible === true; },
    /** Replace the current projection and push it when the view can receive it. */
    update(next) {
      if (disposed) return;
      payload = next && typeof next === 'object' ? next : undefined;
      void publish();
    },
    publish,
    resolveWebviewView(next) {
      if (disposed || view === next) return;
      if (view) releaseView();
      delivery.clear();
      view = next; ready = false;
      next.webview.options = { enableScripts: true, localResourceRoots: [] };
      const listener = next.webview.onDidReceiveMessage(async message => {
        try {
          if (view !== next) return;
          if (message?.action === 'ready') { ready = true; await publish(); notifyVisibility(); return; }
          if (typeof onAction === 'function') await onAction(message, next);
        } catch (error) { if (view === next) report(error); }
      });
      const visibility = next.onDidChangeVisibility?.(() => {
        if (view !== next) return;
        if (!next.visible) { delivery.clear({ resetTransport: false }); notifyVisibility(); return; }
        void publish();
        notifyVisibility();
      });
      const disposal = next.onDidDispose(() => { if (view === next) { releaseView(); notifyVisibility(); } });
      subscriptions = [listener, visibility, disposal].filter(Boolean);
      next.title = interfaceText('探索对话');
      next.webview.html = renderGoalChatPanel();
    },
    /** Reveal the native right-side-bar tab next to the file tree. */
    async show() {
      if (disposed) throw new Error('探索对话组件已关闭。');
      await vscode.commands.executeCommand('workbench.view.extension.ubovm-goal-chat');
      view?.show?.(false);
      // The page handshake publishes the current projection; a slow first load
      // must not block the click that opened the tab.
      return true;
    },
    applyLanguage() {
      if (!view) return;
      view.title = interfaceText('探索对话');
      view.webview.html = renderGoalChatPanel();
      ready = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true; payload = undefined; releaseView();
    }
  };
}

module.exports = { createGoalChatPanel, renderGoalChatPanel };
