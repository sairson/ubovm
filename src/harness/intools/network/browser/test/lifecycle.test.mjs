import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../index.mjs';

test('closing during context creation disposes the late context without closing a borrowed browser', async () => {
  let complete, started;
  const creating = new Promise(resolve => { started = resolve; });
  let contextClosed = 0, browserClosed = 0;
  const manager = new BrowserManager({ browser: {
    newContext() { started(); return new Promise(resolve => { complete = resolve; }); },
    async close() { browserClosed++; },
  } });
  const pending = manager.call({ sessionId: 'session', workerId: 'worker' }, { action: 'tabs' });
  const rejected = assert.rejects(pending, /closed during context creation/);
  await creating;
  await manager.close();
  complete({ async close() { contextClosed++; } });
  await rejected;
  assert.equal(contextClosed, 1);
  assert.equal(browserClosed, 0);
  assert.equal(manager.scopes.size, 0);
  await assert.rejects(manager.scope('late'), /closed/);
});

test('closing an injected context does not close the caller-owned context', async () => {
  let closed = 0;
  const manager = new BrowserManager({ context: { async close() { closed++; } } });
  await manager.scope('worker');
  await manager.close();
  assert.equal(closed, 0);
  assert.equal(manager.scopes.size, 0);
});
