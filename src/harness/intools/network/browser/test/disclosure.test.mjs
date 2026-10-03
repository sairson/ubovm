import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_ACTIONS, BROWSER_ACTION_DOCS, BROWSER_CORE_DESCRIPTION, BROWSER_IDE_DESCRIPTION,
  BROWSER_HELP_TIERS, buildBrowserHelp, createBrowserTools, createIdeBrowserBridge, browserActionParameters,
} from '../index.mjs';

test('tool descriptions stay short and point to help', () => {
  assert.ok(BROWSER_CORE_DESCRIPTION.length < 550);
  assert.ok(BROWSER_IDE_DESCRIPTION.length < 500);
  assert.match(BROWSER_CORE_DESCRIPTION, /action=help/);
  assert.match(BROWSER_IDE_DESCRIPTION, /action=help/);
  assert.ok(BROWSER_CORE_DESCRIPTION.length < 900, 'old megadescription should not return');
});

test('schema uses progressive action string instead of 40+ literals', () => {
  assert.equal(browserActionParameters.properties.action.anyOf, undefined);
  assert.equal(browserActionParameters.properties.action.type, 'string');
  assert.ok(browserActionParameters.properties.topic);
  assert.ok(BROWSER_ACTIONS.includes('help'));
  assert.ok(BROWSER_ACTION_DOCS.every(doc => BROWSER_ACTIONS.includes(doc.action)));
});

test('help defaults to core tier with next pointer', () => {
  const help = buildBrowserHelp({ backend: 'obscura' });
  assert.equal(help.mode, 'help');
  assert.equal(help.topic, 'core');
  assert.ok(help.actions.some(item => item.action === 'navigate' && item.params));
  assert.ok(help.actions.every(item => item.tier === 'core'));
  assert.ok(help.tiers.some(item => item.tier === 'security'));
  assert.equal(help.next.topic, 'interaction');
  assert.ok(!help.actions.some(item => item.action === 'identity_capture'));
});

test('help topic drills into tier and single action', () => {
  const tier = buildBrowserHelp({ topic: 'security', backend: 'obscura' });
  assert.ok(tier.actions.some(item => item.action === 'authz_compare' && item.params));
  const one = buildBrowserHelp({ topic: 'navigate', backend: 'obscura' });
  assert.equal(one.action.action, 'navigate');
  assert.ok(one.action.params.includes('url'));
  const unknown = buildBrowserHelp({ topic: 'nope', backend: 'obscura' });
  assert.equal(unknown.ok, false);
});

test('ide help hides obscura-only tiers and actions', () => {
  const help = buildBrowserHelp({
    backend: 'ide-browser',
    availableActions: ['help', 'status', 'navigate', 'snapshot', 'click', 'fill', 'wait', 'screenshot', 'tabs', 'console', 'cdp'],
  });
  assert.equal(help.backend, 'ide-browser');
  assert.ok(!help.tiers.some(item => item.tier === 'security'));
  assert.ok(!help.actions.some(item => item.action === 'popup_policy'));
  const all = buildBrowserHelp({
    topic: 'all',
    backend: 'ide-browser',
    availableActions: ['help', 'navigate', 'cdp', 'network_start'],
  });
  assert.ok(all.actions.some(item => item.action === 'cdp'));
  assert.ok(!all.actions.some(item => item.action === 'network_start'));
});

test('createBrowserTools serves help without calling the manager', async () => {
  let calls = 0;
  const manager = {
    source: 'obscura',
    async status() { return { source: 'obscura', state: 'configured' }; },
    async call() { calls++; return { ok: true }; },
  };
  const [action, statusTool] = createBrowserTools({ manager, sessionId: 's', workerId: 'w' });
  assert.match(action.description, /action=help/);
  assert.ok(action.description.length < 550);
  const core = await action.execute('1', { action: 'help' });
  assert.equal(calls, 0);
  assert.equal(core.details.mode, 'help');
  assert.equal(core.details.topic, 'core');
  const drill = await action.execute('2', { action: 'help', topic: 'interaction' });
  assert.ok(drill.details.actions.some(item => item.action === 'select'));
  const bad = await action.execute('3', { action: 'not_a_real_action' });
  assert.equal(bad.details.ok, false);
  assert.deepEqual(bad.details.help, { action: 'help', topic: 'core' });
  const status = await statusTool.execute('4', {});
  assert.deepEqual(status.details.help, { action: 'help', topic: 'core' });
  assert.ok(status.details.available_tiers.includes('core'));
});

test('ide bridge tools disclose only supported surface', async () => {
  const bridge = createIdeBrowserBridge({
    invoke: async (op, payload) => {
      if (op === 'status') return { source: 'ide-browser', state: 'configured', available: true };
      return { ok: true, action: payload.input.action, source: 'ide-browser' };
    }
  });
  const [action] = createBrowserTools({ manager: bridge, sessionId: 's', workerId: 'w' });
  const help = await action.execute('1', { action: 'help', topic: 'all' });
  assert.equal(help.details.backend, 'ide-browser');
  assert.ok(!help.details.actions.some(item => item.action === 'identity_capture'));
  const denied = await action.execute('2', { action: 'identity_capture' });
  assert.equal(denied.details.ok, false);
  assert.match(denied.details.error, /IDE 内嵌浏览器/);
  assert.ok(BROWSER_HELP_TIERS.includes('core'));
});
