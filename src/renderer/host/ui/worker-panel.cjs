'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createLatestDelivery } = require('../agent/latest-delivery.cjs');
const { interfaceText, currentInterfaceLocale } = require('../../harness/runtime/interface-text.cjs');

let bundle;
function loadBundle() {
  if (bundle) return bundle;
  const read = file => readFileSync(path.join(__dirname, '../../webview', file), 'utf8');
  const styles = ['styles.css', 'theme.css', 'messages/message-markdown.css', 'messages/message-view.css', 'workers/worker-panel.css', 'preview/html-preview.css'].map(read).join('\n');
  const scripts = ['i18n-en.js', 'i18n-en-more.js', 'i18n.js', 'vendor/marked.umd.js', 'messages/message-markdown.js', 'messages/timeline-parts.js', 'messages/message-view.js', 'workers/worker-panel.js', 'preview/html-preview.js', 'workers/native-panel.js'].map(read).join('\n;\n').replace(/<\/script/gi, '<\\/script');
  return bundle = { styles, scripts };
}

function renderWorkerPanel() {
  const nonce = randomBytes(24).toString('hex');
  const { styles, scripts: source } = loadBundle();
  const scripts = `try{localStorage.setItem('ubovm.locale',${JSON.stringify(currentInterfaceLocale())})}catch(e){}\n;${source}`;
  const loading = interfaceText('正在加载 Worker 日志…');
  return `<!doctype html><html lang="${currentInterfaceLocale() === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src blob:;"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">${styles}
  .shell { height:100%; min-width:0; } .worker-panel { position:static; width:100%; height:100%; border:0; box-shadow:none; } .worker-panel-header { padding:4px 12px; } .worker-detail-summary,.worker-detail-content { padding:12px 16px; } #worker-empty { flex:1; min-height:0; display:grid; place-items:center; margin:0; padding:20px; text-align:center; color:var(--muted); } #worker-error { padding:8px 16px; color:var(--vscode-errorForeground); }
  </style></head><body><div class="shell"><p id="worker-empty" role="status" aria-busy="true">${loading}</p><p id="worker-error" role="status" hidden></p></div><script nonce="${nonce}">${scripts}</script></body></html>`;
}

function createWorkerPanel(vscode, { readState, onAction, onError = () => {}, readyTimeout = 10000 }) {
  let view, ready = false, selected = '', sessionId = '', revealRevision = 0;
  const opening = new Set();
  let openingTask, openingController, migrated = false, lifecycle = 0;
  let disposed = false, viewSubscriptions = [];
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Error observers cannot interrupt component cleanup. */ }
  };
  const delivery = createLatestDelivery(report);
  function releaseView() {
    view = undefined; ready = false; delivery.clear(); cancelOpening();
    const subscriptions = viewSubscriptions; viewSubscriptions = [];
    for (const subscription of subscriptions) {
      try { Promise.resolve(subscription?.dispose()).catch(report); } catch (error) { report(error); }
    }
  }
  function cancelOpening() {
    ++lifecycle;
    const error = new Error('Worker 日志加载已取消，请重新打开。');
    openingController?.abort(error);
    openingTask = undefined; openingController = undefined;
    for (const cancel of [...opening]) cancel(error);
  }
  function checkReady() {
    if (ready && view?.visible) for (const resolve of [...opening]) resolve();
  }
  function waitUntilReady(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (ready && view?.visible) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = error => { clearTimeout(timer); opening.delete(done); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
      const cancel = () => done(signal.reason);
      const timer = setTimeout(() => done(new Error('Worker 日志加载超时，请再次点击 Worker 重试。')), readyTimeout);
      signal.addEventListener('abort', cancel, { once: true });
      opening.add(done);
    });
  }
  function publish(snapshot) {
    if (!ready || !view?.visible) return;
    return delivery.publish(() => {
      if (!ready || !view?.visible) return;
      const state = snapshot || readState();
      if (sessionId !== state.sessionId) { sessionId = state.sessionId; selected = ''; }
      return view.webview.postMessage({ type: 'workers', ...state, selected, revealRevision });
    });
  }
  return {
    get visible() { return ready && view?.visible === true; },
    publish,
    async show(id, expectedSessionId) {
      if (disposed) throw new Error('Worker 日志组件已关闭。');
      const state = readState();
      if (state.sessionId !== expectedSessionId || !state.workers.some(worker => worker.id === id)) throw new Error('Worker 已失效，请在当前会话重新选择。');
      sessionId = state.sessionId; selected = id; revealRevision++;
      // Rapid clicks share component loading; the latest selection wins.
      if (!openingTask) {
        const generation = lifecycle;
        const controller = new AbortController();
        openingController = controller;
        const checkCurrent = () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (generation !== lifecycle) throw new Error('Worker 日志加载已取消，请重新打开。');
          const current = readState();
          if (current.sessionId !== sessionId || !current.workers.some(worker => worker.id === selected)) throw new Error('Worker 已失效，请在当前会话重新选择。');
        };
        let cancel;
        const cancelled = new Promise((resolve, reject) => {
          cancel = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', cancel, { once: true });
        });
        // Include layout/focus commands in the deadline, not only the ready
        // handshake. A stalled command must not permanently block retries.
        const deadline = setTimeout(() => controller.abort(new Error('Worker 日志加载超时，请再次点击 Worker 重试。')), readyTimeout);
        const loading = (async () => {
          if (!migrated) {
            await vscode.commands.executeCommand('workbench.view.extension.ubovm-workers.resetViewContainerLocation');
            checkCurrent();
            await vscode.commands.executeCommand('ubovm.workerLogs.resetViewLocation');
            checkCurrent();
            migrated = true;
          }
          await vscode.commands.executeCommand('ubovm.workerLogs.focus');
          checkCurrent();
          view?.show?.(false);
          await waitUntilReady(controller.signal);
          checkCurrent();
          // Ready means the component can be used; streaming bridge backlog
          // must not keep navigation pending or turn a visible panel into a timeout.
          void publish();
        })();
        const task = Promise.race([loading, cancelled]).finally(() => {
          clearTimeout(deadline);
          controller.signal.removeEventListener('abort', cancel);
          if (openingTask === task) { openingTask = undefined; openingController = undefined; }
        });
        openingTask = task;
      }
      await openingTask;
    },
    resolveWebviewView(next) {
      if (disposed || view === next) return;
      if (view) releaseView();
      delivery.clear();
      view = next; ready = false;
      next.webview.options = { enableScripts: true, localResourceRoots: [] };
      const listener = next.webview.onDidReceiveMessage(async message => {
        try {
          if (view !== next) return;
          if (message?.action === 'ready') { ready = true; checkReady(); await publish(); }
          else if (message?.action === 'selectWorker') {
            const state = readState();
            if (message.sessionId === state.sessionId && state.workers.some(worker => worker.id === message.workerId)) selected = message.workerId;
          } else if (['copyText', 'openMessageLink', 'interruptCommand', 'backgroundCommand'].includes(message?.action)) await onAction(message, next);
        } catch (error) { if (view === next) report(error); }
      });
      const visibility = next.onDidChangeVisibility(() => {
        if (view !== next) return;
        if (!next.visible) { delivery.clear({ resetTransport: false }); cancelOpening(); }
        checkReady();
        if (next.visible) {
          // Both snapshot reads and the bridge can throw before returning a promise.
          try { void Promise.resolve(publish()).catch(report); } catch (error) { report(error); }
        }
      });
      const disposal = next.onDidDispose(() => { if (view === next) releaseView(); });
      viewSubscriptions = [listener, visibility, disposal];
      next.title = interfaceText('Worker 日志');
      next.webview.html = renderWorkerPanel();
    },
    applyLanguage() {
      if (!view) return;
      view.title = interfaceText('Worker 日志');
      view.webview.html = renderWorkerPanel();
      ready = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true; releaseView(); selected = ''; sessionId = '';
    }
  };
}

module.exports = { createWorkerPanel, renderWorkerPanel };
