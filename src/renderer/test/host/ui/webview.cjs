'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Script } = require('node:vm');
const { renderWebview } = require('../../../host/ui/webview.cjs');

test('assembled page includes all components and a syntactically valid browser entry', () => {
  const html = renderWebview({ version: 'test', workspaceName: 'fixture' });
  assert.doesNotMatch(html, /\{\{(?:APP_STYLE|APP_SCRIPT|SETTINGS_HTML|NONCE|VSCODE_VERSION|WORKSPACE_NAME)\}\}/);
  const scripts = [...html.matchAll(/<script\s+nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style\s+nonce="([^"]+)">([\s\S]*?)<\/style>/g)];
  assert(scripts.length > 10); assert.equal(styles.length, 1);
  for (const script of scripts) assert.equal(script[1], styles[0][1]);
  assert(html.includes("script-src 'nonce-" + scripts[0][1] + "'"));
  assert(html.includes("style-src 'nonce-" + scripts[0][1] + "'"));
  for (const component of ['UBOVMMarkdown', 'UBOVMMessage', 'UBOVMHtmlPreview', 'acquireVsCodeApi']) assert(scripts.some(script => script[2].includes(component)), component);
  assert(scripts[0][2].includes('UBOVMRuntime'), 'recovery must execute before application dependencies');
  for (const script of scripts) assert.doesNotThrow(() => new Script(script[2]));
  assert(html.includes('id="settings-dialog"'), 'Settings HTML fragment must be assembled');
  assert(html.includes('id="open-browser"') && html.includes('data-action="browser"'), 'Conversation must expose a browser entry');
  assert(html.includes('打开浏览器'), 'Home shortcuts must include the browser entry');
});

test('workspace labels remain text and cannot expand template tokens or break script tags', () => {
  const value = '</script><img src=x onerror=alert(1)> {{APP_SCRIPT}}';
  const html = renderWebview({ workspaceName: value, version: value });
  assert(html.includes('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; {{APP_SCRIPT}}'));
  assert.equal([...html.matchAll(/<script\s/g)].length, [...renderWebview().matchAll(/<script\s/g)].length);
  assert.equal([...html.matchAll(/<script\s/g)].length, [...html.matchAll(/<\/script>/g)].length);
  assert(!html.includes('<img src=x'));
});

test('each rendered webview gets a fresh CSP nonce', () => {
  const nonce = html => /<script\s+nonce="([^"]+)"/.exec(html)[1];
  assert.notEqual(nonce(renderWebview()), nonce(renderWebview()));
});

test('reopening panels reuses asset reads but refreshes workspace labels and CSP', () => {
  const fs = require('node:fs'), path = require('node:path'), { runInNewContext } = require('node:vm');
  const filename = require.resolve('../../../host/ui/webview.cjs');
  let reads = 0;
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(filename), require: name => name === 'node:fs'
    ? { readFileSync(...args) { reads++; return fs.readFileSync(...args); } } : require(name) };
  runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const render = sandbox.module.exports.renderWebview;
  const first = render({ workspaceName: 'FIRST_WORKSPACE', nonce: 'first' });
  const initialReads = reads;
  assert.ok(initialReads > 10);
  const second = render({ workspaceName: 'SECOND_WORKSPACE', nonce: 'second' });
  assert.equal(reads, initialReads);
  assert.ok(first.includes('FIRST_WORKSPACE') && second.includes('SECOND_WORKSPACE'));
  assert.ok(!second.includes('FIRST_WORKSPACE'));
  assert.ok(second.includes("script-src 'nonce-second'"));
});

test('missing assets produce a standalone usable recovery page and repaired files can be retried', () => {
  const fs = require('node:fs'), path = require('node:path'), { runInNewContext } = require('node:vm');
  const filename = require.resolve('../../../host/ui/webview.cjs');
  let broken = true, errors = 0;
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(filename), console: { error() { errors++; } },
    require: name => name === 'node:fs' ? { readFileSync(...args) { if (broken) throw Error('Missing asset'); return fs.readFileSync(...args); } } : require(name) };
  runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  const render = sandbox.module.exports.renderWebview;
  const fallback = render({ nonce: 'recovery-nonce' });
  assert.match(fallback, /页面资源暂时不可用/);
  assert.match(fallback, /send\('reloadConversation'\)/);
  assert.match(fallback, /script-src 'nonce-recovery-nonce'/);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(fallback)[1];
  assert.doesNotThrow(() => new Script(script));
  assert.equal(errors, 1);
  broken = false;
  assert.match(render(), /id="prompt-input"/);
});

test('standalone recovery handles rejected and false reload deliveries', async () => {
  const fs = require('node:fs'), path = require('node:path'), { runInNewContext } = require('node:vm');
  const filename = require.resolve('../../../host/ui/webview.cjs');
  const host = { module: { exports: {} }, __dirname: path.dirname(filename), console: { error() {} },
    require: name => name === 'node:fs' ? { readFileSync() { throw Error('Missing asset'); } } : require(name) };
  runInNewContext(fs.readFileSync(filename, 'utf8'), host);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(host.module.exports.renderWebview())[1];
  for (const rejected of [false, true]) {
    let click, sends = 0;
    const status = { textContent: '' };
    runInNewContext(script, { document: { getElementById: id => id === 'recovery-status' ? status : { addEventListener(_, handler) { click = handler; } } },
      acquireVsCodeApi: () => ({ postMessage(message) { if (message.action === 'contentReady') return true; sends++; return rejected ? Promise.reject(Error('Bridge lost')) : false; } }) });
    click(); await new Promise(resolve => setImmediate(resolve));
    assert.match(status.textContent, /页面连接不可用/);
    assert.equal(sends, 1);
  }
});
