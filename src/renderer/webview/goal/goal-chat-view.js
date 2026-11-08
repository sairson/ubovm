(() => {
  'use strict';
  // Bootstrap for the native right-sidebar WebviewView (`ubovm.goalChat`).
  // goal-chat-panel.cjs serves the page bundle; this script owns the viewport
  // handshake, request/ack bridge and the page-local draft cache, then hands the
  // DOM to `window.createGoalChat`. Session ids and chat state are always pushed
  // by the host: the page never invents a session or a transcript entry.
  const t = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const DRAFT_PREFIX = 'ubovm.goalChatDraft:';
  const REQUEST_LIMIT = 120000;
  const vscode = window.UBOVMRuntime?.api ?? acquireVsCodeApi();
  const pending = new Map();
  let view;
  let session = '';
  let counter = 0;

  function post(action, payload) {
    try { return Promise.resolve(vscode.postMessage({ ...payload, action })).catch(() => {}); }
    catch { return Promise.resolve(); }
  }
  function readDraft(id) {
    if (!id) return '';
    try { return sessionStorage.getItem(DRAFT_PREFIX + id) || ''; } catch { return ''; }
  }
  function writeDraft(id, value) {
    if (!id) return;
    try {
      if (value) sessionStorage.setItem(DRAFT_PREFIX + id, value);
      else sessionStorage.removeItem(DRAFT_PREFIX + id);
    } catch { /* Sidebar storage can be blocked; the in-memory draft still works. */ }
  }
  function failureOf(value) {
    if (typeof value === 'string' && value) return new Error(value);
    if (value && typeof value === 'object') {
      const text = typeof value.message === 'string' && value.message
        ? value.message
        : typeof value.error === 'string' && value.error ? value.error : '';
      if (text) return new Error(text);
    }
    return new Error(t('操作失败，请重试。'));
  }
  function request(action, payload, done, timeout = REQUEST_LIMIT) {
    const requestId = 'goal-chat-' + Date.now().toString(36) + '-' + (++counter);
    const settle = {
      timer: setTimeout(() => {
        if (!pending.delete(requestId)) return;
        done?.failure?.(new Error(t('操作超时，请重试。')));
      }, timeout),
      success(value) {
        if (!pending.delete(requestId)) return;
        clearTimeout(settle.timer);
        done?.success?.(value);
      },
      failure(error) {
        if (!pending.delete(requestId)) return;
        clearTimeout(settle.timer);
        done?.failure?.(failureOf(error));
      }
    };
    pending.set(requestId, settle);
    post(action, { ...payload, requestId });
    return requestId;
  }

  const actions = {
    onCopy: text => post('copyText', { text }),
    onOpenLink: href => post('openMessageLink', { href }),
    onPreviewHtml: (source, button) => {
      try {
        window.UBOVMHtmlPreview?.open(source, {
          returnFocus: button || document.activeElement,
          onCopy: text => post('copyText', { text })
        });
      } catch { /* The preview bundle is optional in the sidebar page. */ }
    }
  };

  function revealPanel() {
    // The provider's HTML keeps the panel hidden behind a loading placeholder
    // until the first host snapshot; the inline page used to un-hide it in app.js.
    const root = document.getElementById('goal-chat');
    if (root && root.hidden) root.hidden = false;
    const loading = document.getElementById('goal-chat-loading');
    if (loading && !loading.hidden) loading.hidden = true;
  }

  function applyMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'uiResult') {
      const settle = pending.get(data.requestId);
      if (!settle) return;
      if (data.ok) settle.success(data.value);
      else settle.failure(data.error || data.failure || t('操作失败，请重试。'));
      return;
    }
    if (data.type === 'locale') {
      window.UBOVMi18n?.applyHostLocale?.(data.locale);
      window.UBOVMi18n?.apply(document.body);
      return;
    }
    if (data.type !== 'goalChat' || !view) return;
    const nextSession = typeof data.sessionId === 'string' ? data.sessionId : '';
    const changed = nextSession !== session;
    const draft = changed ? readDraft(nextSession) : undefined;
    session = nextSession;
    revealPanel();
    view.update({
      sessionId: nextSession,
      threads: data.threads,
      goalMissing: data.goalMissing,
      chat: data.chat,
      modelReady: data.modelReady,
      offline: data.offline,
      available: data.available,
      mode: data.mode,
      imageInput: data.imageInput,
      draft
    });
  }

  function boot() {
    if (view) return;
    document.body.classList.add('goal-chat-page');
    document.body.dataset.goalChatView = 'true';
    view = window.createGoalChat(document.body, {
      actions,
      onSend: (text, images, done) => {
        if (!session) { done?.failure(new Error(t('当前会话尚未准备完成，请稍后再试。'))); return; }
        // Images travel as data URLs; the host re-validates, saves and hands the
        // descriptors to the backend, which persists them on the user message.
        request('goalChatSend', { text, ...(images?.length ? { images } : {}) }, done);
      },
      onCancel: done => {
        if (!session) { done?.failure(new Error(t('当前会话尚未准备完成，请稍后再试。'))); return; }
        request('goalChatCancel', {}, done, 30000);
      },
      // Tab actions target host-owned sessions; the page only reports the intent.
      onSelectThread: (threadId, done) => {
        if (!threadId) { done?.failure(new Error(t('切换探索对话失败，请重试。'))); return; }
        request('selectGoalChatThread', { threadId }, done, 15000);
      },
      onNewThread: done => request('newGoalChatThread', {}, done, 15000),
      onDeleteThread: (threadId, done) => {
        if (!threadId) { done?.failure(new Error(t('删除对话失败，请重试。'))); return; }
        request('deleteGoalChatThread', { threadId }, done, 15000);
      },
      onRewind: (messageId, done) => {
        if (!messageId) { done?.failure(new Error(t('撤回失败，请重试。'))); return; }
        request('goalChatRewind', { messageId }, done, 15000);
      },
      // Saved user-message images are resolved one at a time and only when the
      // transcript actually shows them; the host answers with a data URI.
      onImage: (imageId, done) => {
        if (!imageId) { done?.failure(new Error(t('图片已不存在或不属于当前对话。'))); return; }
        request('goalChatImage', { imageId }, done, 30000);
      },
      onDraft: value => writeDraft(session, value),
      onClose: () => post('closeGoalChat')
    });
    window.addEventListener('message', event => {
      try { applyMessage(event.data); } catch (error) { console.warn('[UBOVM] goal chat message failed', error); }
    });
    // Translate the static shell once; dynamic labels already use i18n.t().
    window.UBOVMi18n?.apply(document.body);
    post('ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
