'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Browser dependencies precede their consumers. Keeping this list together
// makes the development extension and installed runtime use the same page.
const assets = Object.freeze({
  styles: Object.freeze([
    'styles.css', 'theme.css', 'settings/settings.css', 'delivery/delivery-view.css', 'messages/message-markdown.css',
    'messages/message-view.css', 'messages/background-tasks.css', 'messages/code-changes.css', 'workers/worker-panel.css', 'goal/blackboard-graph.css', 'preview/html-preview.css', 'motion.css', 'overlays.css', 'project/project-switcher.css'
  ]),
  scripts: Object.freeze([
    'runtime-guard.js', 'errors.js', 'connection-monitor.js', 'state-order.js', 'settings/settings-ui.js', 'delivery/delivery-view.js', 'vendor/marked.umd.js', 'messages/message-markdown.js',
    'messages/message-view.js', 'messages/background-tasks.js', 'messages/code-changes.js', 'messages/conversation-outline.js', 'workers/worker-panel.js', 'goal/execution-log.js', 'goal/exploration-model.js', 'goal/blackboard-graph.js', 'preview/html-preview.js', 'project/project-switcher.js', 'app.js'
  ])
});
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

let bundle;
// Extension assets are immutable for the lifetime of the extension host.
// Reload the extension after development edits; per-page values stay uncached.
function loadBundle() {
  if (bundle) return bundle;
  const read = file => readFileSync(path.join(__dirname, '../../webview', file), 'utf8');
  const providerManifest = JSON.parse(read('vendor/provider-icons/manifest.json'));
  const providerIcons = Object.fromEntries(Object.entries(providerManifest.providers).map(([key, { file }]) => [key, read('vendor/provider-icons/' + file)]));
  const providerScript = 'const UBOVM_PROVIDER_ICONS = Object.freeze(' + JSON.stringify(providerIcons).replace(/</g, '\\u003c') + ');';
  bundle = {
    PRODUCT_LOGO: readFileSync(path.join(__dirname, '../../media/icon.svg'), 'utf8').replace('<svg ', '<svg class="product-logo" aria-hidden="true" '),
    APP_STYLE: assets.styles.map(read).join('\n'),
    scripts: [read('runtime-guard.js'), providerScript, ...assets.scripts.slice(1).map(read)].map(source => source.replace(/<\/script/gi, '<\\/script')),
    SETTINGS_HTML: read('settings/settings.html'),
    template: read('index.html')
  };
  return bundle;
}

function renderWebview({ version = '', workspaceName = '', nonce = randomBytes(24).toString('base64') } = {}) {
  let loaded;
  try { loaded = loadBundle(); }
  catch (error) {
    console.error('[UBOVM] Conversation page assets could not be loaded', error);
    return renderUnavailablePage(nonce);
  }
  const { template, scripts, ...staticFragments } = loaded;
  const fragments = {
    ...staticFragments,
    APP_SCRIPT: scripts.map(source => '<script nonce="' + escapeHtml(nonce) + '">\n' + source + '\n</script>').join('\n'),
    NONCE: escapeHtml(nonce),
    VSCODE_VERSION: escapeHtml(version),
    WORKSPACE_NAME: escapeHtml(workspaceName)
  };
  // Replace only template tokens, never token-shaped user text or JavaScript.
  return template.replace(/\{\{(APP_STYLE|APP_SCRIPT|SETTINGS_HTML|PRODUCT_LOGO|NONCE|VSCODE_VERSION|WORKSPACE_NAME)\}\}/g, (_, name) => fragments[name]);
}

function renderUnavailablePage(nonce) {
  const safeNonce = escapeHtml(nonce);
  // No file reads or application dependencies in the last-resort page. Failed
  // bundles are never cached, so a manual retry can pick up repaired assets.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}';">
    <title>UBOVM · 页面恢复</title><style nonce="${safeNonce}">
    body { background: var(--vscode-editor-background, #fafafa); color: var(--vscode-editor-foreground, #222); font: 14px/1.7 system-ui; padding: 32px; }
    main { max-width: 640px; margin: auto; } button { padding: 8px 16px; cursor: pointer; }
    </style></head><body><main role="alert"><h1>页面资源暂时不可用</h1>
    <p id="recovery-status">对话页面未能加载。请重新加载页面；如果仍无法恢复，请重启 IDE 或检查安装文件。</p>
    <p>重新加载页面不会重新提交任务，请恢复后核实运行状态。</p>
    <button id="reload-page" type="button">重新加载页面</button></main>
    <script nonce="${safeNonce}">(() => {
      let api;
      const failed = () => { document.getElementById('recovery-status').textContent = '页面连接不可用，请通过命令“重新加载对话页面”或重启 IDE 恢复。'; };
      const send = action => {
        try {
          if (!api) throw Error();
          Promise.resolve(api.postMessage({ action })).then(result => { if (result === false) failed(); }, failed);
        } catch { failed(); }
      };
      try { api = acquireVsCodeApi(); send('contentReady'); } catch { failed(); }
      document.getElementById('reload-page').addEventListener('click', () => {
        send('reloadConversation');
      });
    })();</script></body></html>`;
}

module.exports = { renderWebview, assets };
