import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalTools } from '../index.mjs';

const sshTools = ['run_linux_ssh_command', 'upload_sftp', 'deploy_remote_service'];
const allowedTools = [...sshTools, 'run_local_shell_command'];
const names = async runtime => (await runtime.forWorker('root')).map(tool => tool.name);

test('incomplete SSH configuration removes SSH tools from the agent surface', async () => {
  for (const ssh of [undefined, { profiles: [] }, { profiles: [{ id: 'stale', host: 'example.test', username: '' }] }]) {
    const runtime = await createInternalTools({ sessionId: 'ssh-surface', allowedTools, ssh });
    try {
      const tools = await names(runtime);
      for (const name of sshTools) assert.equal(tools.includes(name), false, `${name} must be hidden without a complete SSH endpoint`);
      assert.equal(tools.includes('run_local_shell_command'), true);
    } finally { await runtime.close(); }
  }
});

test('a complete SSH endpoint exposes the SSH tools', async () => {
  const runtime = await createInternalTools({
    sessionId: 'ssh-surface',
    allowedTools,
    ssh: { profiles: [{ id: 'remote', host: 'example.test', username: 'root', port: 22, insecure_ignore_host_key: true }] }
  });
  try {
    const tools = await names(runtime);
    for (const name of sshTools) assert.equal(tools.includes(name), true, `${name} must be available for a configured endpoint`);
  } finally { await runtime.close(); }
});
