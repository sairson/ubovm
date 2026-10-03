import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdeBrowserBridge, IDE_BROWSER_ACTIONS } from '../ide-bridge.mjs';
import { createBrowserTools } from '../index.mjs';

test('ide bridge forwards status and call to invoke', async () => {
  const calls = [];
  const bridge = createIdeBrowserBridge({
    sessionId: 'session-1',
    invoke: async (op, payload, signal) => {
      calls.push({ op, payload, aborted: signal?.aborted === true });
      if (op === 'status') return { source: 'ide-browser', state: 'configured', available: true };
      return { ok: true, action: payload.input.action, source: 'ide-browser' };
    }
  });
  assert.equal(bridge.source, 'ide-browser');
  assert.ok(bridge.supportedActions.includes('snapshot'));
  const status = await bridge.status({ workerId: 'w1' });
  assert.equal(status.source, 'ide-browser');
  const result = await bridge.call({ workerId: 'w1', target: 'https://example.com' }, { action: 'navigate', url: 'https://example.com' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].op, 'status');
  assert.equal(calls[0].payload.binding.sessionId, 'session-1');
  assert.equal(calls[1].op, 'call');
  assert.equal(calls[1].payload.input.action, 'navigate');
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
});

test('createBrowserTools adapts description and soft-rejects for IDE bridge', async () => {
  const bridge = createIdeBrowserBridge({
    invoke: async (op, payload) => {
      if (op === 'status') return { source: 'ide-browser', state: 'configured', available: true };
      return { ok: true, action: payload.input.action, source: 'ide-browser' };
    }
  });
  const [actionTool, statusTool] = createBrowserTools({
    manager: bridge, sessionId: 's', workerId: 'w', target: 'https://example.com'
  });
  assert.match(actionTool.description, /IDE Integrated Browser/);
  assert.match(statusTool.description, /IDE Integrated Browser/);
  const denied = await actionTool.execute('1', { action: 'network_start' });
  assert.equal(denied.details.source, 'ide-browser');
  assert.match(JSON.parse(denied.content[0].text).error, /IDE 内嵌浏览器/);
  const ok = await actionTool.execute('2', { action: 'navigate', url: 'https://example.com' });
  assert.equal(ok.details.source, 'ide-browser');
  assert.equal(JSON.parse(ok.content[0].text).ok, true);
});
