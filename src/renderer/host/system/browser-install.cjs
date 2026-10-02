'use strict';

const { createRequire } = require('node:module');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createBrowserInstaller({ sdkPath, run = spawn, exists = existsSync, load = () => createRequire(sdkPath) }) {
  let pending, active;
  function runtime() {
    const requireSDK = load();
    return { executablePath: requireSDK('playwright-core').chromium.executablePath(),
      cli: path.join(path.dirname(requireSDK.resolve('playwright-core/package.json')), 'cli.js') };
  }
  function configure(config) {
    const browser = config.intools?.browser;
    if (!browser || browser.browser || browser.context || browser.cdpEndpoint || browser.channel || browser.executablePath || browser.launchOptions?.executablePath || browser.launchOptions?.channel) return config;
    const { executablePath } = runtime();
    return exists(executablePath) ? { ...config, intools: { ...config.intools, browser: { ...browser, executablePath } } } : config;
  }
  function install(onOutput = () => {}) {
    if (pending) return pending;
    const operation = { child: null, closed: false, settled: false };
    active = operation;
    const release = () => {
      if (active === operation && operation.settled && (!operation.child || operation.closed)) {
        pending = undefined; active = undefined;
      }
    };
    pending = (async () => {
      const { executablePath, cli } = runtime();
      if (exists(executablePath)) return executablePath;
      await new Promise((resolve, reject) => {
        const child = run(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        operation.child = child;
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* Still retain ownership until close. */ }
          reject(new Error('浏览器下载超时，请检查网络后重试。'));
        }, 10 * 60 * 1000);
        const output = chunk => {
          // A disposed output channel must not throw through the child stream
          // into the extension host or turn a successful download into failure.
          try { Promise.resolve(onOutput(String(chunk))).catch(() => {}); } catch {}
        };
        child.stdout?.on('data', output);
        child.stderr?.on('data', output);
        child.once('error', error => {
          clearTimeout(timer);
          if (!child.pid) operation.closed = true; // A failed spawn has no live process.
          reject(error); release();
        });
        child.once('close', code => {
          operation.closed = true; clearTimeout(timer); release();
          code === 0 ? resolve() : reject(new Error('浏览器安装失败，请查看 UBOVM 输出日志并重试。'));
        });
      });
      if (!exists(executablePath)) throw new Error('安装完成后未找到浏览器，请重新安装。');
      return executablePath;
    })().finally(() => { operation.settled = true; release(); });
    return pending;
  }
  function status() {
    try {
      const { executablePath } = runtime();
      return { state: pending ? 'installing' : exists(executablePath) ? 'ready' : 'missing', executablePath };
    } catch (error) { return { state: 'error', message: error.message || '无法读取浏览器运行环境。' }; }
  }
  return { install, configure, status };
}

module.exports = { createBrowserInstaller };
