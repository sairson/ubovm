'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, text, title } = require('../../webview/errors.js');

test('hostile error properties and conversions cannot break the recovery surface', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const values = [revoked.proxy, new Proxy({}, { get() { throw Error('secret getter'); } }),
    { get message() { throw Error('secret message'); } },
    { message: 'failure', get cause() { throw Error('secret cause'); } },
    { status: Symbol('private') }, { status: { valueOf() { throw Error('private conversion'); } } },
    { message: 'failed', hint: 'hint', get detail() { throw Error('secret detail'); } }];
  for (const value of values) {
    const failure = normalize(value, 'copyText');
    assert.equal(failure.code, 'OPERATION_FAILED');
    assert.equal(failure.detail, ''); assert.equal(failure.action, 'copyText');
    assert.equal(failure.cancelled, false);
    assert.equal(text(value), '操作未能完成，请稍后重试。');
    assert.doesNotMatch(JSON.stringify(failure), /secret|private/);
  }
});

test('errors normalize thrown values and nested service failures without empty messages', () => {
  for (const value of [undefined, null, {}, 42, '', { error: {} }]) assert.equal(normalize(value).message, '操作未能完成，请稍后重试。');
  assert.equal(text({ error: { message: '请先保存目标。' } }), '请先保存目标。');
  assert.equal(text(new Error('请先填写模型。')), '请先填写模型。');
});
test('common failures provide actionable localized messages and retain codes', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EACCES', 'ENOENT', 'ENOSPC']) {
    const failure = normalize(Object.assign(new Error(code), { code }));
    assert.equal(failure.code, code); assert.ok(failure.hint); assert.notEqual(failure.message, code);
    assert.equal(text(failure), failure.message + ' ' + failure.hint);
  }
  assert.equal(normalize({ status: 401 }).code, 'AUTHENTICATION_FAILED');
  assert.equal(normalize({ cause: { code: 'ENOTFOUND' } }).code, 'ENOTFOUND');
  assert.equal(normalize({ name: 'AbortError' }).cancelled, true);
});

test('agent runtime disconnect codes explain resume instead of generic failure', () => {
  for (const code of ['AGENT_HEARTBEAT_TIMEOUT', 'AGENT_THREAD_EXIT']) {
    const failure = normalize(Object.assign(new Error(code), { code }));
    assert.equal(failure.code, code);
    assert.match(failure.message, /Agent 后端/);
    assert.match(failure.hint, /继续执行/);
  }
  assert.equal(normalize(Object.assign(new Error('closed'), { code: 'SERVICE_CLOSED' })).code, 'SERVICE_CLOSED');
  assert.equal(normalize(Object.assign(new Error('busy'), { code: 'RPC_BUSY' })).code, 'RPC_BUSY');
});

test('SSH and shell command timeouts are distinct from UI wait timeouts', () => {
  const ssh = normalize(new Error('SSH command timed out after 120 seconds'));
  assert.equal(ssh.code, 'TIMEOUT');
  assert.match(ssh.message, /远程命令已超时（120 秒）/);
  assert.match(ssh.hint, /timeout_seconds/);
  assert.doesNotMatch(ssh.hint, /可能仍在执行/);
  const shell = normalize(new Error('Shell command timed out after 30 seconds'));
  assert.match(shell.message, /远程命令已超时（30 秒）/);
  const queue = normalize(Object.assign(new Error('Shell queue wait timed out after 8 seconds; command was not executed'), { code: 'SHELL_QUEUE_TIMEOUT' }));
  assert.match(queue.message, /远程命令已超时（8 秒）/);
  const wait = normalize(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  assert.equal(wait.code, 'ETIMEDOUT');
  assert.match(wait.message, /等待操作结果超时/);
  assert.match(wait.hint, /可能仍在执行/);
});
test('display errors redact credentials, bound details and exclude stacks from summaries', () => {
  const failure = normalize('fetch failed: https://alice:password@example.com/?api_key=hidden token=private Authorization: Bearer credential sk-1234567890');
  assert.doesNotMatch(JSON.stringify(failure), /alice|password@|=hidden|=private|Bearer credential|sk-1234567890/);
  assert.ok(normalize('x'.repeat(10000)).detail.length <= 4000);
  assert.equal(normalize('失败\n    at private/file.js:1').message, '失败');
  const sensitive = normalize('password="two secret words" passphrase=private Basic dXNlcjpwYXNz\n-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_DATA\n-----END RSA PRIVATE KEY-----');
  assert.doesNotMatch(JSON.stringify(sensitive), /two secret words|=private|dXNlcjpwYXNz|PRIVATE_DATA/);
});

test('normalization preserves operation identity and distinguishes HTTP status from user content', () => {
  const failure = normalize({ status: 503 }, 'prompt');
  assert.equal(title(normalize(failure)), '发送消息未完成');
  assert.equal(normalize(failure).action, 'prompt');
  for (const value of ['请将长度控制在 401 字以内。', '第 503 行无效。', '任务 429 不存在。', 'Could not write cancelled.json']) {
    assert.equal(normalize(value).message, value);
    assert.equal(normalize(value).cancelled, false);
  }
  assert.equal(normalize('HTTP 503 unavailable').code, 'SERVICE_UNAVAILABLE');
  assert.equal(normalize({ response: { status: 401 } }).code, 'AUTHENTICATION_FAILED');
  assert.equal(title(normalize({ name: 'AbortError' }, 'prompt')), '发送消息已取消');
});

test('nested causes remain useful and cyclic causes are bounded', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' });
  const error = new Error('Request failed', { cause });
  cause.cause = error;
  const failure = normalize(error);
  assert.match(failure.message, /无法连接/);
  assert.match(failure.detail, /Request failed/);
  assert.match(failure.detail, /getaddrinfo/);
  assert.equal(normalize({ message: '', hint: '', detail: '' }).message, '操作未能完成，请稍后重试。');
});
