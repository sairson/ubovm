'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Script } = require('node:vm');
const { renderWebview } = require('../host/webview.cjs');

test('assembled page includes all components and a syntactically valid browser entry', () => {
  const html = renderWebview({ version: 'test', workspaceName: 'fixture' });
  assert.doesNotMatch(html, /\{\{(?:APP_STYLE|APP_SCRIPT|SETTINGS_HTML|NONCE|VSCODE_VERSION|WORKSPACE_NAME)\}\}/);
  const scripts = [...html.matchAll(/<script\s+nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style\s+nonce="([^"]+)">([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length, 1); assert.equal(styles.length, 1);
  assert.equal(scripts[0][1], styles[0][1]);
  assert(html.includes("script-src 'nonce-" + scripts[0][1] + "'"));
  assert(html.includes("style-src 'nonce-" + scripts[0][1] + "'"));
  for (const component of ['UBOVMMarkdown', 'UBOVMMessage', 'UBOVMHtmlPreview', 'acquireVsCodeApi']) assert(scripts[0][2].includes(component), component);
  assert.doesNotThrow(() => new Script(scripts[0][2]));
  assert(html.includes('id="settings-dialog"'), 'Settings HTML fragment must be assembled');
});

test('workspace labels remain text and cannot expand template tokens or break script tags', () => {
  const value = '</script><img src=x onerror=alert(1)> {{APP_SCRIPT}}';
  const html = renderWebview({ workspaceName: value, version: value });
  assert(html.includes('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; {{APP_SCRIPT}}'));
  assert.equal([...html.matchAll(/<script\s/g)].length, 1);
  assert.equal([...html.matchAll(/<\/script>/g)].length, 1);
  assert(!html.includes('<img src=x'));
});

test('each rendered webview gets a fresh CSP nonce', () => {
  const nonce = html => /<script\s+nonce="([^"]+)"/.exec(html)[1];
  assert.notEqual(nonce(renderWebview()), nonce(renderWebview()));
});

test('reopening panels reuses asset reads but refreshes workspace labels and CSP', () => {
  const fs = require('node:fs'), path = require('node:path'), { runInNewContext } = require('node:vm');
  const filename = require.resolve('../host/webview.cjs');
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
