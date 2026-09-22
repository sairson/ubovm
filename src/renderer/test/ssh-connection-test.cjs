const test = require('node:test');
const assert = require('node:assert/strict');
const { createSSHConnectionTest } = require('../host/ssh-connection-test.cjs');

test('SSH test authenticates without executing commands and always closes its connection', async () => {
  let closed = 0, config;
  class SSHCommands {
    constructor(value) { config = value; }
    async waitForConnection() {}
    async close() { closed++; }
  }
  const service = createSSHConnectionTest({ loadSSH: async () => ({ SSHCommands }) });
  const result = await service.test({ host: 'example', connect_timeout_seconds: 300 });
  assert.equal(result.ok, true); assert.equal(closed, 1); assert.equal(config.connect_timeout_seconds, 30);
});

test('SSH test classifies failures without exposing raw errors or credentials', async () => {
  let closed = 0;
  for (const [code, expected] of [['ECONNREFUSED', /被拒绝/], ['ENOTFOUND', /解析/], ['Authentication failed', /认证失败/], ['Host denied (verification failed)', /身份校验/], ['timeout', /超时/]]) {
    const service = createSSHConnectionTest({ loadSSH: async () => ({ SSHCommands: class {
      async waitForConnection() { throw new Error(code + ' secret-password'); }
      async close() { closed++; }
    } }) });
    const result = await service.test({});
    assert.equal(result.ok, false); assert.match(result.message, expected); assert.doesNotMatch(JSON.stringify(result), /secret-password/);
  }
  assert.equal(closed, 5);
});

test('SSH test prevents concurrent attempts and disposes active authentication', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = createSSHConnectionTest({ loadSSH: async () => ({ SSHCommands: class {
    waitForConnection(signal) { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    async close() {}
  } }) });
  const pending = service.test({}); await ready;
  assert.match((await service.test({})).message, /正在测试/);
  service.dispose(); assert.equal((await pending).ok, false);
});
