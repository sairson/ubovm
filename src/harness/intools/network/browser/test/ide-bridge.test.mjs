import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdeBrowserBridge, IDE_BROWSER_ACTIONS } from '../ide-bridge.mjs';
import { createBrowserTools } from '../index.mjs';

test('ide bridge forwards status and call to invoke when a page is open', async () => {
  const calls = [];
  const bridge = createIdeBrowserBridge({
    sessionId: 'session-1',
    invoke: async (op, payload, signal) => {
      calls.push({ op, payload, aborted: signal?.aborted === true });
      if (op === 'status') return { source: 'ide-browser', state: 'connected', available: true, page_open: true, tab_count: 1 };
      return { ok: true, action: payload.input.action, source: 'ide-browser' };
    }
  });
  assert.equal(bridge.source, 'ide-browser');
  assert.ok(bridge.supportedActions.includes('snapshot'));
  assert.ok(bridge.supportedActions.includes('yield_control'));
  assert.ok(IDE_BROWSER_ACTIONS.includes('yield_control'));
  const status = await bridge.status({ workerId: 'w1' });
  assert.equal(status.source, 'ide-browser');
  assert.equal(status.mode, 'ide');
  assert.equal(status.page_open, true);
  const result = await bridge.call({ workerId: 'w1', target: 'https://example.com' }, { action: 'navigate', url: 'https://example.com' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].op, 'status');
  assert.equal(calls[0].payload.binding.sessionId, 'session-1');
  assert.equal(calls[1].op, 'call');
  assert.equal(calls[1].payload.input.action, 'navigate');
});

test('ide bridge waits for the user to open the page and continues the same action', async () => {
  let opened = false;
  let calls = 0;
  const bridge = createIdeBrowserBridge({
    sessionId: 's', openWaitMs: 5000, openPollMs: 10,
    invoke: async (op, payload) => {
      if (op === 'status') return { page_open: opened, tab_count: opened ? 1 : 0, source: 'ide-browser' };
      if (op === 'call') {
        calls += 1;
        return calls === 1
          ? { ok: false, code: 'IDE_BROWSER_NOT_OPEN', url: payload.input.url, source: 'ide-browser' }
          : { ok: true, url: payload.input.url, title: 'Example', source: 'ide-browser' };
      }
      return { ok: true };
    }
  });
  setTimeout(() => { opened = true; }, 15);
  const result = await bridge.call({ workerId: 'w' }, { action: 'navigate', url: 'https://example.com/a' });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/a');
});

test('ide bridge auto-opens the page and retries when the user stays idle', async () => {
  const calls = [];
  let pageOpened = false;
  const bridge = createIdeBrowserBridge({
    sessionId: 's', openWaitMs: 20, openPollMs: 10, autoOpen: true,
    invoke: async (op, payload) => {
      calls.push(op);
      if (op === 'status') return { page_open: pageOpened, source: 'ide-browser' };
      if (op === 'openAgentPage') { pageOpened = true; return { opened: true, url: payload.url, source: 'ide-browser' }; }
      if (op === 'call') {
        return pageOpened
          ? { ok: true, url: payload.input.url, title: 'Example', auto_source: 'retry', source: 'ide-browser' }
          : { ok: false, code: 'IDE_BROWSER_NOT_OPEN', url: payload.input.url, source: 'ide-browser' };
      }
      return { ok: true };
    }
  });
  const result = await bridge.call({ workerId: 'w' }, { action: 'navigate', url: 'https://example.com/auto' });
  assert.equal(result.ok, true);
  assert.equal(result.auto_opened, true);
  assert.ok(calls.includes('openAgentPage'));
});

test('ide bridge passes IDE_BROWSER_NOT_OPEN through when the user does not open the page', async () => {
  const bridge = createIdeBrowserBridge({
    openWaitMs: 0, autoOpen: false,
    invoke: async (op, payload) => op === 'status'
      ? { source: 'ide-browser', state: 'configured', page_open: false, tab_count: 0 }
      : { ok: false, code: 'IDE_BROWSER_NOT_OPEN', action: payload.input.action, url: payload.input.url, source: 'ide-browser' }
  });
  const status = await bridge.status({ workerId: 'w' });
  assert.equal(status.page_open, false);
  assert.match(status.guidance, /悬浮提示|独立 Chromium/);
  const result = await bridge.call({ workerId: 'w' }, { action: 'navigate', url: 'https://example.com/a' });
  assert.equal(result.code, 'IDE_BROWSER_NOT_OPEN');
  assert.equal(result.mode, 'ide');
  assert.equal(result.hidden_background_supported, false);
  assert.match(result.guidance, /悬浮提示/);
  assert.match(result.guidance, /独立 Chromium/);
});

test('ide bridge rejects unsupported security actions locally', async () => {
  let invoked = false;
  const bridge = createIdeBrowserBridge({
    invoke: async () => { invoked = true; return {}; }
  });
  const result = await bridge.call({ workerId: 'w' }, { action: 'identity_capture' });
  assert.equal(result.ok, false);
  assert.match(result.error, /IDE 内嵌浏览器/);
  assert.equal(invoked, false);
  assert.equal(IDE_BROWSER_ACTIONS.includes('identity_capture'), false);
});

test('ide bridge rejects after close', async () => {
  const bridge = createIdeBrowserBridge({ invoke: async () => ({}) });
  await bridge.close();
  await assert.rejects(() => bridge.call({ workerId: 'w' }, { action: 'navigate', url: 'https://x' }), /closed/);
  const status = await bridge.status({ workerId: 'w' });
  assert.equal(status.state, 'closed');
  assert.equal(status.mode, 'ide');
});

test('createBrowserTools adapts description and soft-rejects for IDE bridge', async () => {
  const bridge = createIdeBrowserBridge({
    invoke: async (op, payload) => {
      if (op === 'status') return { source: 'ide-browser', state: 'connected', available: true, page_open: true, tab_count: 1 };
      return { ok: true, action: payload.input.action, source: 'ide-browser' };
    }
  });
  const [actionTool, statusTool] = createBrowserTools({
    manager: bridge, sessionId: 's', workerId: 'w', target: 'https://example.com'
  });
  assert.match(actionTool.description, /IDE Integrated Browser/);
  assert.match(statusTool.description, /IDE Integrated Browser/);
  const denied = await actionTool.execute('1', { action: 'identity_capture' });
  assert.equal(denied.details.source, 'ide-browser');
  assert.match(JSON.parse(denied.content[0].text).error, /IDE 内嵌浏览器/);
  const ok = await actionTool.execute('2', { action: 'navigate', url: 'https://example.com' });
  assert.equal(ok.details.source, 'ide-browser');
  assert.equal(JSON.parse(ok.content[0].text).ok, true);
});
