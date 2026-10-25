import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundTaskRegistry } from '../../shared/process/background-tasks.mjs';
import { createBackgroundCommandsTool } from '../index.mjs';

function fakeCommand(overrides = {}) {
  let listener, output = '';
  const command = {
    id: 'cmd-1', name: 'run_local_shell_command', workerId: 'lead', toolCallId: 'call-1',
    args: JSON.stringify({ command: 'npm run dev', purpose: 'code' }), startedAt: Date.now() - 1000,
    retained: false,
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    interrupt() { command.interrupted = true; emit(output, 'interrupted'); return true; },
    ...overrides
  };
  const emit = (next, status = 'running', executionState = 'running') => {
    output = next;
    listener?.({ output, status, executionState });
  };
  return { command, emit, get interrupted() { return command.interrupted === true; } };
}

const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

test('registry mirrors retained commands with ids, output, elapsed and transport', () => {
  const registry = createBackgroundTaskRegistry();
  const { command, emit } = fakeCommand();
  const untrack = registry.track(command);
  assert.deepEqual(registry.list(), [], 'a foreground command is not listed');
  emit('starting dev server\nready on 3000');
  const [task] = registry.list();
  assert.equal(task.command_id, 'cmd-1');
  assert.equal(task.transport, 'local');
  assert.equal(task.command, 'npm run dev');
  assert.equal(task.status, 'running');
  assert.equal(task.worker_id, 'lead');
  assert.match(task.elapsed, /^\d+s$/);
  const read = registry.read('cmd-1');
  assert.match(read.output, /ready on 3000/);
  assert.equal(registry.read('missing'), undefined);
  untrack();
  emit('this update must be ignored');
  assert.doesNotMatch(registry.read('cmd-1').output, /ignored/);
});

test('foreground registrations are dropped on release instead of accumulating', () => {
  const registry = createBackgroundTaskRegistry();
  const { command } = fakeCommand();
  const untrack = registry.track(command);
  assert.equal(registry.size, 1);
  untrack();
  assert.equal(registry.size, 0, 'a command that never entered the background list leaves no record');
  assert.deepEqual(registry.list(), []);
});

test('registry lists running tasks first, stops one command and keeps terminal history', () => {
  const registry = createBackgroundTaskRegistry();
  const first = fakeCommand({ id: 'first', startedAt: Date.now() - 2000, name: 'run_linux_ssh_command' });
  const second = fakeCommand({ id: 'second', startedAt: Date.now() - 1000 });
  registry.track(first.command); registry.track(second.command);
  first.emit('ssh started');
  second.emit('local started');
  assert.deepEqual(registry.list().map(task => task.command_id), ['second', 'first']);
  assert.equal(registry.list()[1].transport, 'ssh');
  assert.equal(registry.stop('second').ok, true);
  assert.equal(second.interrupted, true);
  assert.deepEqual(registry.stop('second'), { ok: false, reason: 'finished' }, 'a stopped command cannot be interrupted twice');
  assert.deepEqual(registry.stop('missing'), { ok: false, reason: 'missing' });
  second.emit('local started', 'failed');
  const [ended] = registry.list().filter(task => task.command_id === 'second');
  assert.equal(ended.status, 'failed');
  assert.ok(ended.ended_at >= ended.started_at);
});

test('background_commands lists, reads a tail and stops a task', async () => {
  const registry = createBackgroundTaskRegistry();
  const { command, emit } = fakeCommand();
  registry.track(command);
  emit(Array.from({ length: 40 }, (_, index) => 'line ' + index).join('\n'));
  const tool = createBackgroundCommandsTool({ registry });
  const listed = await tool.execute('call', { action: 'list' });
  assert.match(textOf(listed), /#cmd-1 · local · running/);
  assert.equal(listed.details.tasks.length, 1);
  const read = await tool.execute('call', { action: 'read', command_id: '#cmd-1', tail_lines: 400 });
  assert.match(textOf(read), /line 39/);
  const short = await tool.execute('call', { action: 'read', command_id: 'cmd-1', tail_lines: 20 });
  assert.match(textOf(short), /省略前 20 行/);
  assert.match(textOf(short), /line 39/);
  assert.doesNotMatch(textOf(short), /\nline 10\b/);
  const stopped = await tool.execute('call', { action: 'stop', command_id: 'cmd-1' });
  assert.equal(stopped.details.stopped, true);
  assert.match(textOf(stopped), /已请求停止/);
  await assert.rejects(tool.execute('call', { action: 'read', command_id: 'missing' }), /Unknown background command/);
  await assert.rejects(tool.execute('call', { action: 'nope' }), /Unknown background_commands action/);
});

test('background_commands read can wait for fresh output', async () => {
  const registry = createBackgroundTaskRegistry();
  const { command, emit } = fakeCommand();
  registry.track(command);
  emit('booting');
  const tool = createBackgroundCommandsTool({ registry });
  setTimeout(() => emit('booting\nlistening on :8080'), 120);
  const started = Date.now();
  const read = await tool.execute('call', { action: 'read', command_id: 'cmd-1', wait_seconds: 2 });
  assert.match(textOf(read), /listening on :8080/);
  assert.ok(Date.now() - started >= 100 && Date.now() - started < 2000, 'wait returns as soon as output changes');
});

test('background_commands help is served from the catalog without executing', async () => {
  const registry = createBackgroundTaskRegistry();
  const tool = createBackgroundCommandsTool({ registry });
  const help = await tool.execute('call', { action: 'help', topic: 'read' });
  const explanation = JSON.parse(textOf(help));
  assert.equal(explanation.mode, 'help');
  assert.equal(explanation.topic, 'read');
  assert.equal(help.details.mode, 'help');
});
