/** Host-backed browser manager that drives the IDE Integrated Browser. */

/** Actions implemented by the IDE browser host (keep in sync with ide-browser-host.cjs). */
export const IDE_BROWSER_ACTIONS = Object.freeze([
  'status', 'tabs', 'tab_new', 'tab_close', 'tab_activate',
  'navigate', 'back', 'forward', 'reload',
  'snapshot', 'accessibility', 'screenshot', 'evaluate',
  'click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'wait',
  'console', 'cdp',
]);

export const IDE_BROWSER_UNSUPPORTED_HINT =
  '此操作在 IDE 内嵌浏览器模式下不可用。请在设置「浏览器与搜索」中关闭「使用 IDE 内嵌浏览器」后使用独立 Chromium（Obscura）。';

export function createIdeBrowserBridge({ invoke, sessionId } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('ide browser bridge requires invoke(op, payload, signal)');
  let closed = false;

  async function status(binding = {}) {
    if (closed) {
      return {
        source: 'ide-browser', state: 'closed', configured: false, available: false,
        connected: false, browser_action_available: false, manager_available: false,
        supported_actions: [...IDE_BROWSER_ACTIONS],
      };
    }
    return invoke('status', { binding: { sessionId, ...binding } });
  }

  async function call(binding, input, signal) {
    signal?.throwIfAborted();
    if (closed) throw new Error('IDE browser bridge is closed');
    const action = input?.action;
    if (action && !IDE_BROWSER_ACTIONS.includes(action)) {
      return { ok: false, error: IDE_BROWSER_UNSUPPORTED_HINT, action, source: 'ide-browser' };
    }
    return invoke('call', { binding: { sessionId, ...binding }, input }, signal);
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
