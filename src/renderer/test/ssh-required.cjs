'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sshConfigurationStatus, readSSHStatus } = require('../harness/config/settings-config.cjs');
const profile = { id: 'server', host: 'example.test', username: 'dev' };

test('IDE requires a valid default SSH connection, including legacy settings', () => {
  for (const ssh of [undefined, false, {}, { profiles: [] }, { profiles: [profile], defaultId: 'missing' },
    ...[{ host: ' ' }, { username: '' }, { port: 0 }, { port: 65536 }, { port: '22' }].map(change => ({ profiles: [{ ...profile, ...change }] }))]) {
    assert.equal(sshConfigurationStatus(ssh).configured, false);
    assert.match(sshConfigurationStatus(ssh).error, /SSH/);
  }
  for (const ssh of [profile, { profiles: [profile] }, { profiles: [profile], defaultId: 'server' }]) {
    assert.deepEqual(sshConfigurationStatus(ssh), { configured: true });
  }
});

test('workspace SSH settings cannot bypass required machine configuration', () => {
  let entry = { workspaceValue: { ssh: profile } };
  const vscode = { workspace: { getConfiguration: () => ({ inspect: () => entry }) } };
  assert.equal(readSSHStatus(vscode).configured, false);
  entry.globalValue = { ssh: profile };
  assert.equal(readSSHStatus(vscode).configured, true);
  entry.globalValue = { ssh: { profiles: [] } };
  assert.equal(readSSHStatus(vscode).configured, false);
});
