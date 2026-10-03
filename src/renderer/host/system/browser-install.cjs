'use strict';

const { createRequire } = require('node:module');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER_PATH_KEY = 'ubovm.browserExecutablePath';

function parseInstallProgress(text, previous = {}) {
  const percentMatch = String(text).match(/(?:^|[^\d])(\d{1,3})(?:\.\d+)?%/);
  let percent = previous.percent;
  if (percentMatch) {
    const value = Math.min(100, Math.max(0, Number(percentMatch[1])));
    if (Number.isFinite(value)) percent = previous.percent == null ? value : Math.max(previous.percent, value);
  }
  const lower = String(text).toLowerCase();
  let phase = previous.phase || 'download';
  if (/install|extract|unzip|unpack/.test(lower)) phase = 'install';
  else if (/download|fetch|chromium|chrome/.test(lower)) phase = 'download';
  const message = percent != null
    ? (phase === 'install' ? `正在安装… ${percent}%` : `正在下载… ${percent}%`)
    : (phase === 'install' ? '正在安装 Chromium…' : '正在下载 Chromium…');
  return { percent, phase, message };
}

function normalizeInstallOptions(options) {
  if (typeof options === 'function') return { onLog: options };
  if (!options || typeof options !== 'object') return {};
  return options;
}

function createBrowserInstaller({
  sdkPath,
  run = spawn,
  exists = existsSync,
  load = () => createRequire(sdkPath),
  cachedPath,
  onReady
} = {}) {
  let pending, active, lastProgress = {};
  let rememberedPath = typeof cachedPath === 'string' && cachedPath ? cachedPath : undefined;
  let cachedRuntime;
  let cachedStatus;

  function runtime() {
    if (cachedRuntime) return cachedRuntime;
    const requireSDK = load();
    cachedRuntime = {
      executablePath: requireSDK('playwright-core').chromium.executablePath(),
      cli: path.join(path.dirname(requireSDK.resolve('playwright-core/package.json')), 'cli.js')
    };
    return cachedRuntime;
  }

  function invalidateStatus() { cachedStatus = undefined; }

  function remember(executablePath) {
    rememberedPath = executablePath;
    invalidateStatus();
    try { onReady?.(executablePath); } catch { /* Cache persistence must not fail install. */ }
  }

  function resolvePath() {
    try {
      const { executablePath } = runtime();
      if (exists(executablePath)) return executablePath;
    } catch { /* Fall through to remembered path. */ }
    if (rememberedPath && exists(rememberedPath)) return rememberedPath;
    return undefined;
  }

  function configure(config) {
    const browser = config.intools?.browser;
    if (!browser || browser.browser || browser.context || browser.cdpEndpoint || browser.channel || browser.executablePath || browser.launchOptions?.executablePath || browser.launchOptions?.channel) return config;
    const executablePath = resolvePath();
    return executablePath ? { ...config, intools: { ...config.intools, browser: { ...browser, executablePath } } } : config;
  }

  function emitSafe(handler, payload) {
    try { Promise.resolve(handler?.(payload)).catch(() => {}); } catch { /* Observer failures must not abort install. */ }
  }

  function cancel(reason = '浏览器安装已取消。') {
    if (!active?.child || active.closed) return false;
    active.cancelReason = reason;
    try { active.child.kill(); } catch { /* Retain lock until close. */ }
    return true;
  }

  function install(options) {
    if (pending) return pending;
    const { onLog, onProgress, signal } = normalizeInstallOptions(options);
    const operation = { child: null, closed: false, settled: false, cancelReason: undefined };
    active = operation;
    lastProgress = {};
    const release = () => {
      if (active === operation && operation.settled && (!operation.child || operation.closed)) {
        pending = undefined; active = undefined;
      }
    };
    const abort = () => cancel('浏览器安装已取消。');
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('浏览器安装已取消。'), { cancelled: true }));
    }
    signal?.addEventListener?.('abort', abort, { once: true });

    pending = (async () => {
      const existing = resolvePath();
      if (existing) {
        remember(existing);
        return existing;
      }
      const { executablePath, cli } = runtime();
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
          const text = String(chunk);
          emitSafe(onLog, text);
          lastProgress = parseInstallProgress(text, lastProgress);
          emitSafe(onProgress, { ...lastProgress, installation: status() });
        };
        child.stdout?.on('data', output);
        child.stderr?.on('data', output);
        child.once('error', error => {
          clearTimeout(timer);
          if (!child.pid) operation.closed = true;
          reject(error); release();
        });
        child.once('close', code => {
          operation.closed = true; clearTimeout(timer); release();
          if (operation.cancelReason) {
            reject(Object.assign(new Error(operation.cancelReason), { cancelled: true }));
            return;
          }
          code === 0 ? resolve() : reject(new Error('浏览器安装失败，请查看 UBOVM 输出日志并重试。已下载部分可被下次安装复用。'));
        });
      });
      if (!exists(executablePath) && !(rememberedPath && exists(rememberedPath))) {
        throw new Error('安装完成后未找到浏览器，请重新安装。');
      }
      const readyPath = exists(executablePath) ? executablePath : rememberedPath;
      remember(readyPath);
      return readyPath;
    })().finally(() => {
      signal?.removeEventListener?.('abort', abort);
      operation.settled = true;
      release();
    });
    return pending;
  }

  function status() {
    // Live progress while installing; otherwise reuse the last probe so publish /
    // settings refresh does not re-stat Playwright paths on every IPC tick.
    if (pending) {
      invalidateStatus();
      return {
        state: 'installing',
        executablePath: resolvePath(),
        percent: lastProgress.percent,
        phase: lastProgress.phase,
        message: lastProgress.message || '正在下载 Chromium…'
      };
    }
    if (cachedStatus) return cachedStatus;
    try {
      const { executablePath } = runtime();
      if (exists(executablePath)) cachedStatus = { state: 'ready', executablePath };
      else if (rememberedPath && exists(rememberedPath)) cachedStatus = { state: 'ready', executablePath: rememberedPath };
      else cachedStatus = { state: 'missing', executablePath };
    } catch (error) {
      if (rememberedPath && exists(rememberedPath)) cachedStatus = { state: 'ready', executablePath: rememberedPath };
      else cachedStatus = { state: 'error', message: error.message || '无法读取浏览器运行环境。' };
    }
    return cachedStatus;
  }

  return { install, configure, status, cancel, parseInstallProgress };
}

module.exports = { createBrowserInstaller, parseInstallProgress, BROWSER_PATH_KEY };
