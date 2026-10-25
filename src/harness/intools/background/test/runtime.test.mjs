import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalTools } from '../../index.mjs';

const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

function registerHost(commands) {
  const register = value => { commands.set(value.id, value); return () => commands.delete(value.id); };
  register.retainBackground = true;
  return register;
}

test('retained local shell commands appear in background_commands and can be read and stopped', { timeout: 40000 }, async t => {
  const commands = new Map();
  const runtime = await createInternalTools({
    sessionId: 'background-runtime', allowedTools: ['run_local_shell_command', 'background_commands'],
    localShell: { defaultTimeoutSeconds: 5, maxOutputBytes: 1 << 16 },
    onCommand: registerHost(commands)
  });
  t.after(async () => { for (const command of commands.values()) command.interrupt?.(); await runtime.close(); });
  const tools = await runtime.forWorker('lead');
  const shell = tools.find(tool => tool.name === 'run_local_shell_command');
  const background = tools.find(tool => tool.name === 'background_commands');
  assert(shell && background, 'both shell and background tools are exposed');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const code = "console.log('ready-background'); setTimeout(() => {}, 30000)";
  const call = await shell.execute('bg-call', {
    command: `${quote(process.execPath)} -e ${quote(code)}`, purpose: 'code', reason: 'verify retained background task', retain: true
  }, undefined, () => {});
  assert.equal(call.details?.background, true, 'retain=true returns immediately as a background task');
  const commandId = call.details.command_id;
  assert(commandId, 'the retained result carries a command id');
  assert.equal(commands.get(commandId)?.retained, true);
  const context = await runtime.contextProvider({ node: { id: 'lead', intent: { description: 'background task' } } });
  assert.match(context, /# Background commands/);
  assert.match(context, new RegExp('#' + commandId));
  const listed = await background.execute('list-call', { action: 'list' });
  assert.match(textOf(listed), new RegExp('#' + commandId + ' · local · running'));
  assert.equal(listed.details.tasks.some(task => task.command_id === commandId), true);
  const read = await background.execute('read-call', { action: 'read', command_id: commandId, wait_seconds: 5, tail_lines: 20 });
  assert.match(textOf(read), /ready-background/);
  assert.equal(read.details.command_id, commandId);
  const stopped = await background.execute('stop-call', { action: 'stop', command_id: '#' + commandId });
  assert.equal(stopped.details.stopped, true);
  await commands.get(commandId)?.done().catch(() => {});
  const finalRead = await background.execute('read-final', { action: 'read', command_id: commandId });
  assert.equal(finalRead.details.status, 'interrupted');
  assert.match(textOf(finalRead), /interrupted|已停止|interrupt/i);
  await assert.rejects(background.execute('read-unknown', { action: 'read', command_id: 'no-such-command' }), /Unknown background command/);
});

test('the same background registry mirrors SSH commands with their transport', async t => {
  const runtime = await createInternalTools({ sessionId: 'background-ssh', allowedTools: ['background_commands'] });
  t.after(async () => { await runtime.close(); });
  const [tool] = await runtime.forWorker('lead');
  let listener, output = '';
  const command = {
    id: 'ssh-command', name: 'run_linux_ssh_command', workerId: 'lead', toolCallId: 'ssh-call',
    args: JSON.stringify({ command: 'npm run dev', session: 'web' }), startedAt: Date.now() - 5000, retained: true,
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    interrupt() { listener?.({ output, status: 'interrupted' }); return true; }
  };
  runtime.backgroundTasks.track(command);
  listener?.({ output: 'vite ready in 320 ms', status: 'running' });
  const listed = await tool.execute('call', { action: 'list' });
  assert.match(textOf(listed), /#ssh-command · ssh · running/);
  const read = await tool.execute('call', { action: 'read', command_id: 'ssh-command' });
  assert.match(textOf(read), /vite ready/);
  assert.equal(read.details.status, 'running');
  const stopped = await tool.execute('call', { action: 'stop', command_id: 'ssh-command' });
  assert.equal(stopped.details.stopped, true);
  assert.equal((await tool.execute('call', { action: 'read', command_id: 'ssh-command' })).details.status, 'interrupted');
});
