/**
 * IDE Integrated Browser bridge.
 *
 * The IDE browser and the standalone headless browser (Obscura) are two
 * separate execution modes, selected by settings:
 *   - `intools.browser.ideBrowser: true`  → this bridge drives the IDE browser.
 *   - `intools.browser.ideBrowser: false` → the harness builds a normal
 *     `BrowserManager` (Obscura/Chromium, headless) instead.
 *
 * The bridge never borrows Obscura behind the scenes. When the user has no IDE
 * browser page open the host returns a structured `IDE_BROWSER_NOT_OPEN` result;
 * the conversation shows a click-through prompt and the tool result explains the
 * two ways forward: click the prompt, or switch settings to the standalone mode.
 */

/** Actions implemented by the IDE browser host (keep in sync with ide-browser-host.cjs). */
export const IDE_BROWSER_ACTIONS = Object.freeze([
  'status', 'tabs', 'tab_new', 'tab_close', 'tab_activate',
  'navigate', 'back', 'forward', 'reload',
  'snapshot', 'accessibility', 'screenshot', 'evaluate', 'frames', 'frame_evaluate',
  'click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'wait',
  'console', 'cdp', 'cdp_events',
  'network_start', 'network', 'network_body', 'network_stop',
  'cookies', 'set_cookie', 'clear_cookies',
  'dialogs', 'dialog_policy', 'storage', 'upload', 'yield_control',
]);

export const IDE_BROWSER_UNSUPPORTED_HINT =
  '此操作在 IDE 内嵌浏览器模式下不可用。请在设置「浏览器与搜索」中关闭「使用 IDE 内嵌浏览器」，改用独立 Chromium（Obscura）模式。';

export const IDE_BROWSER_NOT_OPEN_GUIDANCE =
  'IDE 内嵌浏览器还没有打开。点击悬浮提示会立即打开页面并继续当前动作；约 10 秒不点击则自动打开页面继续。也可以到设置「浏览器与搜索」关闭「使用 IDE 内嵌浏览器」，切到独立 Chromium（Obscura）模式执行后台浏览。';

const CLOSED_STATUS = Object.freeze({
  source: 'ide-browser', state: 'closed', mode: 'ide', configured: false, available: false,
  connected: false, browser_action_available: false, manager_available: false, page_open: false,
});

export function createIdeBrowserBridge({ invoke, sessionId, openWaitMs = 10000, openPollMs = 300, autoOpen = true } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('ide browser bridge requires invoke(op, payload, signal)');
  let closed = false;

  function pageOpen(status) {
    return status?.page_open === true || Number(status?.tab_count || 0) > 0;
  }

  /**
   * The IDE browser cannot be opened by the agent. After reporting
   * IDE_BROWSER_NOT_OPEN the host shows a click-through prompt; wait for the page
   * to appear so the same tool call can continue instead of failing outright.
   */
  function waitForPage(binding, signal) {
    if (!(Number(openWaitMs) > 0) || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const deadline = Date.now() + Number(openWaitMs);
      let timer;
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const poll = async () => {
        if (done) return;
        try {
          if (pageOpen(await invoke('status', { binding: { sessionId, ...binding } }))) return finish(true);
        } catch { /* host may briefly reject while the workbench opens the page */ }
        if (Date.now() >= deadline) return finish(false);
        timer = setTimeout(poll, Math.max(10, Number(openPollMs) || 400));
      };
      void poll();
    });
  }

  async function status(binding = {}) {
    if (closed) return { ...CLOSED_STATUS, supported_actions: [...IDE_BROWSER_ACTIONS] };
    const result = await invoke('status', { binding: { sessionId, ...binding } });
    return {
      ...(result || {}),
      mode: 'ide',
      hidden_background_supported: false,
      page_open: result?.page_open === true,
      supported_actions: [...IDE_BROWSER_ACTIONS],
      guidance: result?.page_open === true
        ? 'IDE Integrated Browser has an open page; browser actions run on that shared tab.'
        : IDE_BROWSER_NOT_OPEN_GUIDANCE,
    };
  }

  async function call(binding = {}, input = {}, signal) {
    signal?.throwIfAborted();
    if (closed) throw new Error('IDE browser bridge is closed');
    const action = input?.action;
    if (action && !IDE_BROWSER_ACTIONS.includes(action)) {
      return {
        ok: false, error: IDE_BROWSER_UNSUPPORTED_HINT, action,
        source: 'ide-browser', mode: 'ide', help: { action: 'help', topic: 'core' },
      };
    }
    const result = await invoke('call', { binding: { sessionId, ...binding }, input }, signal);
    if (result?.code === 'IDE_BROWSER_NOT_OPEN') {
      if (await waitForPage(binding, signal)) {
        signal?.throwIfAborted();
        const retried = await invoke('call', { binding: { sessionId, ...binding }, input }, signal);
        if (retried?.code !== 'IDE_BROWSER_NOT_OPEN') return retried;
        return { ...retried, mode: 'ide', hidden_background_supported: false, guidance: IDE_BROWSER_NOT_OPEN_GUIDANCE };
      }
      // The user did not click within the grace period: open the IDE page itself
      // and retry, so browser capability never depends on a manual click.
      if (autoOpen === true) {
        try {
          await invoke('openAgentPage', { url: String(input?.url || binding?.target || '') }, signal);
          signal?.throwIfAborted();
          const retried = await invoke('call', { binding: { sessionId, ...binding }, input }, signal);
          if (retried?.code !== 'IDE_BROWSER_NOT_OPEN') {
            return { ...retried, mode: 'ide', auto_opened: true, hidden_background_supported: false };
          }
        } catch { /* fall through to the actionable result */ }
      }
      // Keep the host's URL/action; the user can still retry after opening.
      signal?.throwIfAborted();
      return { ...result, mode: 'ide', hidden_background_supported: false, guidance: IDE_BROWSER_NOT_OPEN_GUIDANCE };
    }
    return result;
  }

  async function close() { closed = true; }

  return {
    source: 'ide-browser',
    supportedActions: IDE_BROWSER_ACTIONS,
    status,
    call,
    close,
  };
}
