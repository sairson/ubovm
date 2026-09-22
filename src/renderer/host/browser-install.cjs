'use strict';

const { createRequire } = require('node:module');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createBrowserInstaller({ sdkPath, run = spawn, exists = existsSync, load = () => createRequire(sdkPath) }) {
  let pending;
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
    pending = (async () => {
      const { executablePath, cli } = runtime();
      if (exists(executablePath)) return executablePath;
      await new Promise((resolve, reject) => {
        const child = run(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        const timer = setTimeout(() => { child.kill(); reject(new Error('浏览器下载超时，请检查网络后重试。')); }, 10 * 60 * 1000);
        child.stdout?.on('data', chunk => onOutput(String(chunk)));
        child.stderr?.on('data', chunk => onOutput(String(chunk)));
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('浏览器安装失败，请查看 UBOVM 输出日志并重试。')); });
      });
      if (!exists(executablePath)) throw new Error('安装完成后未找到浏览器，请重新安装。');
      return executablePath;
    })().finally(() => { pending = undefined; });
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
