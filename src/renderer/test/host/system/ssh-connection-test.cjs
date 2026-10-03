const test = require('node:test');
const assert = require('node:assert/strict');
const { createSSHConnectionTest } = require('../../../host/system/ssh-connection-test.cjs');

for (const stage of ['load', 'connect', 'close']) test(`SSH deadline releases an unresponsive ${stage} and allows retry`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stuck = true, lateReject, closes = 0, constructed = 0;
  const blocked = new Promise((_, reject) => { lateReject = reject; });
  class SSHCommands {
    constructor() { constructed++; }
    waitForConnection() { return stuck && stage === 'connect' ? blocked : Promise.resolve(); }
    close() { closes++; return stuck && stage === 'close' ? blocked : Promise.resolve(); }
  }
  const service = createSSHConnectionTest({ loadSSH: () => stuck && stage === 'load' ? blocked : { SSHCommands } });
  const pending = service.test({ connect_timeout_seconds: 1 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.ok, stage === 'close', 'successful authentication remains successful even if cleanup stalls');
  if (stage !== 'close') assert.match(result.message, /超时/);
  if (stage === 'load') assert.equal(constructed, 0);
  else assert.equal(closes, 1);
  stuck = false;
  assert.equal((await service.test({})).ok, true);
  lateReject(Error('obsolete failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('disposing during lazy loading returns immediately and never creates a late connection', async () => {
  let release, created = 0;
  const service = createSSHConnectionTest({ loadSSH: () => new Promise(resolve => { release = resolve; }) });
  const pending = service.test({});
  await new Promise(resolve => setImmediate(resolve));
  service.dispose();
  assert.equal((await pending).ok, false);
  release({ SSHCommands: class { constructor() { created++; } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 0); assert.match((await service.test({})).message, /已关闭/);
});

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
