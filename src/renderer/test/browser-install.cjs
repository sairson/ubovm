'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserInstaller } = require('../host/browser-install.cjs');

function fixture() {
  let installed = false;
  const children = [], calls = [];
  const requireSDK = () => ({ chromium: { executablePath: () => '/cache/chrome.exe' } });
  requireSDK.resolve = () => '/sdk/node_modules/playwright-core/package.json';
  const installer = createBrowserInstaller({ load: () => requireSDK, exists: () => installed, run: (...args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    children.push(child); return child;
  } });
  return { installer, children, calls, installed: () => { installed = true; } };
}

test('installation shares concurrent requests, verifies binary and avoids repeated downloads', async () => {
  const f = fixture(), logs = [];
  assert.equal(f.installer.status().state, 'missing');
  const first = f.installer.install(text => logs.push(text));
  assert.equal(f.installer.status().state, 'installing');
  assert.equal(f.installer.install(), first);
  assert.deepEqual(f.calls[0][1].slice(1), ['install', 'chromium', '--no-shell']);
  assert.equal(f.calls[0][2].windowsHide, true);
  assert.equal(f.calls[0][2].env.ELECTRON_RUN_AS_NODE, '1');
  f.children[0].stdout.emit('data', Buffer.from('downloading'));
  f.installed(); f.children[0].emit('close', 0);
  assert.equal(await first, '/cache/chrome.exe');
  assert.deepEqual(f.installer.status(), { state: 'ready', executablePath: '/cache/chrome.exe' });
  assert.deepEqual(logs, ['downloading']);
  await f.installer.install(); assert.equal(f.calls.length, 1);
});

test('status reports missing runtime without breaking the settings page', () => {
  const installer = createBrowserInstaller({ load: () => { throw new Error('runtime missing'); } });
  assert.deepEqual(installer.status(), { state: 'error', message: 'runtime missing' });
});

test('failed downloads and missing binaries can be retried', async () => {
  const f = fixture();
  let attempt = f.installer.install(); f.children[0].emit('close', 1);
  await assert.rejects(attempt, /安装失败/);
  attempt = f.installer.install(); f.children[1].emit('close', 0);
  await assert.rejects(attempt, /未找到浏览器/);
  attempt = f.installer.install(); f.children[2].emit('error', new Error('spawn failed'));
  await assert.rejects(attempt, /spawn failed/);
  attempt = f.installer.install(); f.installed(); f.children[3].emit('close', 0); await attempt;
});

test('installed browser is the fallback while explicit connections remain unchanged', () => {
  const f = fixture(), config = { intools: { browser: { launchOptions: { headless: false } } } };
  assert.equal(f.installer.configure(config), config);
  f.installed();
  assert.equal(f.installer.configure(config).intools.browser.executablePath, '/cache/chrome.exe');
  assert.equal(f.installer.configure(config).intools.browser.launchOptions.headless, false);
  assert.equal(config.intools.browser.executablePath, undefined);
  for (const browser of [false, { channel: 'msedge' }, { executablePath: '/custom' }, { cdpEndpoint: 'http://localhost:9222' }, { launchOptions: { channel: 'chrome' } }]) {
    const custom = { intools: { browser } }; assert.equal(f.installer.configure(custom), custom);
  }
});
