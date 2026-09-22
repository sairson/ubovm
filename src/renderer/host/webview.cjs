'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Browser dependencies precede their consumers. Keeping this list together
// makes the development extension and installed runtime use the same page.
const assets = Object.freeze({
  styles: Object.freeze([
    'styles.css', 'theme.css', 'settings/settings.css', 'messages/message-markdown.css',
    'messages/message-view.css', 'workers/worker-panel.css', 'goal/blackboard-graph.css', 'preview/html-preview.css', 'motion.css', 'overlays.css'
  ]),
  scripts: Object.freeze([
    'errors.js', 'settings/settings-ui.js', 'vendor/marked.umd.js', 'messages/message-markdown.js',
    'messages/message-view.js', 'workers/worker-panel.js', 'goal/execution-log.js', 'goal/overview-split.js', 'goal/exploration-model.js', 'goal/blackboard-graph.js', 'preview/html-preview.js', 'app.js'
  ])
});
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

let bundle;
// Extension assets are immutable for the lifetime of the extension host.
// Reload the extension after development edits; per-page values stay uncached.
function loadBundle() {
  if (bundle) return bundle;
  const read = file => readFileSync(path.join(__dirname, '../webview', file), 'utf8');
  const providerManifest = JSON.parse(read('vendor/provider-icons/manifest.json'));
  const providerIcons = Object.fromEntries(Object.entries(providerManifest.providers).map(([key, { file }]) => [key, read('vendor/provider-icons/' + file)]));
  const providerScript = 'const UBOVM_PROVIDER_ICONS = Object.freeze(' + JSON.stringify(providerIcons).replace(/</g, '\\u003c') + ');';
  bundle = {
    PRODUCT_LOGO: readFileSync(path.join(__dirname, '../media/icon.svg'), 'utf8').replace('<svg ', '<svg class="product-logo" aria-hidden="true" '),
    APP_STYLE: assets.styles.map(read).join('\n'),
    APP_SCRIPT: providerScript + '\n' + assets.scripts.map(file => read(file).replace(/<\/script/gi, '<\\/script')).join('\n;\n'),
    SETTINGS_HTML: read('settings/settings.html'),
    template: read('index.html')
  };
  return bundle;
}

function renderWebview({ version = '', workspaceName = '', nonce = randomBytes(24).toString('base64') } = {}) {
  const { template, ...staticFragments } = loadBundle();
  const fragments = {
    ...staticFragments,
    NONCE: escapeHtml(nonce),
    VSCODE_VERSION: escapeHtml(version),
    WORKSPACE_NAME: escapeHtml(workspaceName)
  };
  // Replace only template tokens, never token-shaped user text or JavaScript.
  return template.replace(/\{\{(APP_STYLE|APP_SCRIPT|SETTINGS_HTML|PRODUCT_LOGO|NONCE|VSCODE_VERSION|WORKSPACE_NAME)\}\}/g, (_, name) => fragments[name]);
}

module.exports = { renderWebview, assets };
