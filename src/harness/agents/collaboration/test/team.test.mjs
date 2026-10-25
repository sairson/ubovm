import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { HarnessDatabase } from '../../../blackboard/database/database.mjs';
import { runCollaboration } from '../index.mjs';
import { createTeam } from '../team.mjs';
import { TEAM_POLICY, teamPolicy, teammateSystemPrompt } from '../prompts.mjs';

const SESSION = 'team-session';
const ROOT = 'C:/tmp/ubovm-team-test';

const plain = message => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'));
const assistant = (model, content) => ({
  role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: Array.isArray(content) && content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop',
  timestamp: Date.now(),
});
function respond(model, content) {
  const stream = new AssistantMessageEventStream();
  const message = assistant(model, content);
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}
function modelConfiguration(streamFn) {
  return { provider: 'team-test', modelId: 'fake-team', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn };
}
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

function store() {
  const values = new Map();
  return {
    values,
    load: key => (values.has(key) ? structuredClone(values.get(key)) : undefined),
    save: (key, value) => { values.set(key, structuredClone(value)); },
  };
}

/** A fake member run that only settles when the test resolves it. */
function controlledRunMember({ steering = true } = {}) {
  const runs = [];
  const runMember = args => new Promise((resolve, reject) => {
    let settled = false;
    const finish = operation => { if (settled) return; settled = true; operation(); };
    const record = {
      args,
      name: args.name,
      prompt: args.prompt,
      context: args.context,
      steer: undefined,
      get settled() { return settled; },
      settle(value = 'done') { finish(() => resolve(value)); },
      fail(error) { finish(() => reject(error)); },
      emit(event) { args.onEvent?.(event); },
    };
    runs.push(record);
    if (steering) args.registerSteering?.(handler => { record.steer = handler ?? undefined; });
    args.signal?.addEventListener('abort', () => finish(() => reject(args.signal.reason ?? Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))), { once: true });
  });
  return { runs, runMember };
}

async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function fixture(t, options = {}) {
  const persistence = options.persistence ?? store();
  const events = [];
  const liveEvents = [];
  const controlled = options.runMember
    ? { runs: options.runs ?? [], runMember: options.runMember }
    : controlledRunMember({ steering: options.steering });
  const team = createTeam({
    sessionId: options.sessionId ?? SESSION,
    directory: ROOT,
    limits: options.limits,
    signal: options.signal,
    state: options.state,
    onEvent: options.onEvent ?? (event => events.push(event)),
    onLiveEvent: options.onLiveEvent ?? (event => liveEvents.push(event)),
    runMember: controlled.runMember,
    load: persistence.load,
    save: persistence.save,
  });
  t.after(() => team.close().catch(() => {}));
  return { team, persistence, events, liveEvents, runs: controlled.runs };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function spawn(team, name = 'reviewer', extra = {}) {
  return team.spawnTeammate('lead', {
    name,
    description: `Handle ${name} work`,
    prompt: `Complete the ${name} assignment`,
    ...extra,
  });
}

async function waitStatus(team, name, status) {
  return waitFor(() => team.snapshot().roster.find(member => member.name === name)?.status === status);
}

async function runningRun(team, runs, position = 0) {
  return waitFor(() => (runs.length > position ? runs[position] : undefined));
}

function createTask(team, input = {}, actor = 'lead') {
  return team.createTask(actor, {
    subject: input.subject ?? 'Shared task',
    description: input.description ?? 'Do the shared task',
    ...input,
  });
}

test('roster starts with the implicit Lead and spawn validates names, context and limits', async t => {
  const { team, runs } = fixture(t);
  const initial = team.snapshot();
  assert.deepEqual(initial.tasks, []);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.roster.map(row => [row.name, row.role, row.status]), [['lead', 'lead', 'inactive']]);

  for (const name of ['Reviewer', 'lead', 'a'.repeat(33), '-reviewer', 'reviewer_1', '']) {
    await expectCode(team.spawnTeammate('lead', { name, description: 'x', prompt: 'y' }), 'TEAM_INVALID_MEMBER_NAME');
  }
  await expectCode(team.spawnTeammate('reviewer', { name: 'reviewer', description: 'x', prompt: 'y' }), 'TEAM_LEAD_REQUIRED');
  await expectCode(team.spawnTeammate('lead', { name: 'reviewer', description: '', prompt: 'y' }), 'TEAM_INVALID_ARGUMENT');
  await expectCode(team.spawnTeammate('lead', { name: 'reviewer', description: 'x', prompt: '  ' }), 'TEAM_INVALID_ARGUMENT');
  await expectCode(team.spawnTeammate('lead', { name: 'reviewer', description: 'x', prompt: 'y', context: 'copy' }), 'TEAM_INVALID_ARGUMENT');

  const row = await spawn(team);
  assert.deepEqual([row.name, row.role, row.status, row.context], ['reviewer', 'teammate', 'provisioning', 'fresh']);
  const record = await runningRun(team, runs);
  assert.equal(record.name, 'reviewer');
  assert.equal(record.context, 'fresh');
  assert.match(record.prompt, /Complete the reviewer assignment/);
  await waitStatus(team, 'reviewer', 'running');
  record.settle('reviewed');
  await waitStatus(team, 'reviewer', 'inactive');
  assert.deepEqual((await team.listMembers('lead')).map(member => member.name), ['lead', 'reviewer']);

  await expectCode(spawn(team), 'TEAM_MEMBER_NAME_TAKEN');
});

test('member limits count failed members and names are never reused', async t => {
  const { team, runs } = fixture(t, { limits: { maxMembers: 1 } });
  await spawn(team, 'first');
  const record = await runningRun(team, runs);
  record.settle();
  await waitStatus(team, 'first', 'inactive');
  await expectCode(spawn(team, 'second'), 'TEAM_MEMBER_LIMIT');

  const failingRuns = [];
  const failing = fixture(t, { runMember: async args => { failingRuns.push(args); throw new Error('model refused to start'); } });
  await spawn(failing.team, 'broken');
  await waitStatus(failing.team, 'broken', 'failed');
  const failedRow = failing.team.snapshot().roster.find(member => member.name === 'broken');
  assert.match(failedRow.error, /model refused to start/);
  await expectCode(spawn(failing.team, 'broken'), 'TEAM_MEMBER_NAME_TAKEN');
  await expectCode(failing.team.sendMessage('lead', { target: 'broken', message: 'are you there' }), 'TEAM_MEMBER_FAILED');
});

test('fork spawns pass the fork context; teammate tools exclude interrupt_agent', async t => {
  const { team, runs } = fixture(t);
  await spawn(team, 'reviewer', { context: 'fork' });
  const record = await runningRun(team, runs);
  assert.equal(record.context, 'fork');
  record.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  assert.deepEqual(team.toolsFor('lead').map(tool => tool.name), [
    'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
    'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  ]);
  assert.deepEqual(team.toolsFor('reviewer').map(tool => tool.name), [
    'spawn_teammate', 'send_message', 'list_agents', 'wait_agent',
    'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  ]);
  for (const tool of team.toolsFor('lead')) {
    assert.equal(tool.executionMode, 'sequential', `${tool.name} must be sequential`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.throws(() => team.toolsFor('nobody'), { code: 'TEAM_MEMBER_NOT_FOUND' });
});

test('tools return compact JSON results in the documented shapes', async t => {
  const { team, runs } = fixture(t);
  const tool = name => team.toolsFor('lead').find(candidate => candidate.name === name);

  const spawnResult = await tool('spawn_teammate').execute('call-1', { name: 'reviewer', description: 'Review', prompt: 'Review the diff' });
  assert.equal(spawnResult.details.member.target, 'reviewer');
  assert.equal(spawnResult.details.member.status, 'provisioning');
  assert.deepEqual(JSON.parse(spawnResult.content[0].text), spawnResult.details);
  const record = await runningRun(team, runs);

  const listResult = await tool('list_agents').execute('call-2', {});
  assert.deepEqual(listResult.details.map(row => row.target), ['lead', 'reviewer']);

  const created = await tool('team_task_create').execute('call-3', { subject: 'Task A', description: 'Do A' });
  assert.deepEqual([created.details.id, created.details.revision, created.details.ready], ['task-1', 1, true]);
  assert.equal(JSON.parse(created.content[0].text).id, 'task-1');
  assert.equal((await tool('team_task_get').execute('call-4', { task_id: 'task-1' })).details.subject, 'Task A');
  const claimed = await tool('team_task_update').execute('call-5', { task_id: 'task-1', expected_revision: 1, action: 'claim' });
  assert.equal(claimed.details.ownerName, 'lead');
  assert.equal((await tool('team_task_list').execute('call-6', { status: 'in_progress' })).details.tasks.length, 1);
  await expectCode(tool('team_task_update').execute('call-7', { task_id: 'task-1', expected_revision: 1, action: 'complete' }), 'TEAM_TASK_STALE_REVISION');

  assert.deepEqual((await tool('send_message').execute('call-8', { target: 'reviewer', message: 'one more thing' })).details, { sent: true });
  assert.deepEqual(record.steer, { text: 'one more thing', teamMessage: { from: 'lead' } });

  const interrupted = await tool('interrupt_agent').execute('call-9', { target: 'reviewer' });
  assert.deepEqual(interrupted.details, { previousStatus: 'running' });
  await waitStatus(team, 'reviewer', 'inactive');
});

const RUN_EVENTS = events => events.filter(event => event.type === 'team.member.run');
const runPhases = events => RUN_EVENTS(events).map(event => event.phase);
const waitRunEvents = (events, count) => waitFor(() => RUN_EVENTS(events).length >= count);

test('teammate activity is a compact team.member.activity while every raw event reaches onLiveEvent', async t => {
  const { team, events, liveEvents, runs } = fixture(t);
  await spawn(team, 'reviewer');
  const record = await runningRun(team, runs);
  // Spawning opened the run lifecycle and the live channel.
  assert.deepEqual(runPhases(events), ['start']);
  const before = events.length;
  const liveBefore = liveEvents.length;
  record.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_workspace_code', args: { path: 'src/a.mjs' } });

  const activities = events.slice(before).filter(event => event.type === 'team.member.activity');
  assert.equal(activities.length, 1);
  assert.equal(activities[0].member, 'reviewer');
  assert.deepEqual(Object.keys(activities[0].activity).sort(), ['at', 'label', 'status'], 'activity is {label,status,at}');
  assert.equal(activities[0].activity.label, 'read_workspace_code');
  assert.equal(activities[0].activity.status, 'running');
  assert.equal(Number.isSafeInteger(activities[0].activity.at), true);
  const statuses = events.slice(before).filter(event => event.type === 'team.status');
  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0].team.roster[1].activity.label, 'read_workspace_code');
  assert.equal(statuses[0].team.roster[1].activity.status, 'running');

  const live = liveEvents.slice(liveBefore);
  assert.deepEqual(live.map(event => [event.type, event.member, event.event.type]), [['team.member.event', 'reviewer', 'tool_execution_start']]);
  assert.deepEqual(live[0].event.args, { path: 'src/a.mjs' }, 'the live channel forwards the raw event, not the compact record');

  const beforeEnd = events.length;
  record.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read_workspace_code', isError: true, result: { huge: 'x'.repeat(10000) } });
  assert.equal(events.at(-1).team.roster[1].activity.status, 'failed');
  const endActivity = events.slice(beforeEnd).find(event => event.type === 'team.member.activity');
  assert.deepEqual(Object.keys(endActivity.activity).sort(), ['at', 'label', 'status']);
  assert.equal('result' in endActivity.activity, false, 'tool results are not duplicated into activity events');
  assert.equal('args' in endActivity.activity, false, 'tool arguments are not duplicated into activity events');
  assert.equal(liveEvents.at(-1).event.result.huge.length, 10000, 'the live channel keeps the raw tool result');

  // Streaming partials stay live-only: they never reach the audited/durable channel.
  const filteredCount = events.length;
  const liveCount = liveEvents.length;
  record.emit({ type: 'message_update', message: { content: [{ type: 'text', text: 'partial' }] }, assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
  record.emit({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'read_workspace_code', partialResult: { text: 'p' } });
  assert.equal(events.length, filteredCount, 'streaming partials are not forwarded durably');
  assert.deepEqual(liveEvents.slice(liveCount).map(event => event.event.type), ['message_update', 'tool_execution_update'],
    'message_update and tool_execution_update are forwarded raw, including to the live observer');

  record.emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
  assert.equal(events.at(-1).type, 'team.status');
  assert.equal(events.at(-1).team.roster[1].activity.label, '正在回复');
  assert.equal(liveEvents.at(-1).event.type, 'message_start');
  record.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  assert.equal(liveEvents.at(-1).event.message.content[0].text, 'done');
  record.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  const revisions = events.filter(event => event.type === 'team.status').map(event => event.team.revision);
  assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right), 'status revisions are monotonic');
  assert.ok(new Set(revisions).size > 1);
});

test('member run lifecycle events bracket success, failure, interrupt, close and wake loops', async t => {
  // Success: start then end/inactive, start emitted before runMember is invoked.
  const success = fixture(t);
  await spawn(success.team, 'reviewer');
  const successRun = await runningRun(success.team, success.runs);
  successRun.settle();
  await waitStatus(success.team, 'reviewer', 'inactive');
  await waitRunEvents(success.events, 2);
  assert.deepEqual(RUN_EVENTS(success.events), [
    { type: 'team.member.run', member: 'reviewer', phase: 'start' },
    { type: 'team.member.run', member: 'reviewer', phase: 'end', status: 'inactive' },
  ]);

  // Failure: a rejected run still emits its end with status failed.
  let failedCalls = 0;
  const failed = fixture(t, { runMember: async () => { failedCalls += 1; throw new Error('model refused to start'); } });
  await spawn(failed.team, 'broken');
  await waitStatus(failed.team, 'broken', 'failed');
  await waitRunEvents(failed.events, 2);
  assert.equal(failedCalls, 1);
  assert.deepEqual(RUN_EVENTS(failed.events), [
    { type: 'team.member.run', member: 'broken', phase: 'start' },
    { type: 'team.member.run', member: 'broken', phase: 'end', status: 'failed' },
  ]);

  // Interrupt: the aborted run ends inactive and a later wake opens a new pair.
  const interrupted = fixture(t);
  await spawn(interrupted.team, 'reviewer');
  const interruptedRun = await runningRun(interrupted.team, interrupted.runs);
  await interrupted.team.interrupt('lead', 'reviewer');
  await waitStatus(interrupted.team, 'reviewer', 'inactive');
  await waitRunEvents(interrupted.events, 2);
  assert.deepEqual(runPhases(interrupted.events), ['start', 'end']);
  assert.equal(RUN_EVENTS(interrupted.events)[1].status, 'inactive');
  await interrupted.team.sendMessage('lead', { target: 'reviewer', message: 'resume' });
  const resumed = await runningRun(interrupted.team, interrupted.runs, 1);
  resumed.settle();
  await waitStatus(interrupted.team, 'reviewer', 'inactive');
  await waitRunEvents(interrupted.events, 4);
  assert.deepEqual(runPhases(interrupted.events), ['start', 'end', 'start', 'end'], 'every inbox-drain iteration is bracketed');
  assert.deepEqual(RUN_EVENTS(interrupted.events).filter(event => event.phase === 'end').map(event => event.status), ['inactive', 'inactive']);

  // Close: the pending run is interrupted and still emits its end before close resolves.
  const closing = fixture(t);
  await spawn(closing.team, 'reviewer');
  await runningRun(closing.team, closing.runs);
  await closing.team.close();
  assert.deepEqual(RUN_EVENTS(closing.events), [
    { type: 'team.member.run', member: 'reviewer', phase: 'start' },
    { type: 'team.member.run', member: 'reviewer', phase: 'end', status: 'inactive' },
  ]);
  assert.equal(closing.team.snapshot().roster.find(row => row.name === 'reviewer').status, 'inactive');

  // Every start precedes exactly one end: no dangling or duplicated pairs.
  for (const { events } of [success, failed, interrupted, closing]) {
    let open = 0;
    for (const event of RUN_EVENTS(events)) {
      if (event.phase === 'start') { assert.equal(open, 0, 'a new run cannot start before the previous one ended'); open = 1; } else { assert.equal(open, 1, 'every end follows its start'); open = 0; }
    }
    assert.equal(open, 0, 'every started run ends');
  }
});

test('onLiveEvent observers are isolated: throwing and rejecting observers never fail a run', async t => {
  const observers = [
    () => { throw new Error('live observer exploded'); },
    () => Promise.reject(new Error('live observer rejected')),
  ];
  for (const observer of observers) {
    const isolated = fixture(t, { onLiveEvent: observer });
    await spawn(isolated.team, 'reviewer');
    const record = await runningRun(isolated.team, isolated.runs);
    record.emit({ type: 'message_start', message: { role: 'assistant' } });
    record.emit({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
    record.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'list_files' });
    record.emit({ type: 'message_end', message: { role: 'assistant' } });
    record.settle('observer-safe');
    await waitStatus(isolated.team, 'reviewer', 'inactive');
    await waitRunEvents(isolated.events, 2);
    assert.deepEqual(runPhases(isolated.events), ['start', 'end'], 'the run still completes normally');
    assert.equal(isolated.team.snapshot().roster.find(row => row.name === 'reviewer').status, 'inactive');
    // The durable activity bookkeeping still ran despite the broken live observer.
    assert.ok(isolated.events.some(event => event.type === 'team.member.activity' && event.member === 'reviewer'), 'activity bookkeeping runs before the live channel');
  }
});


test('send_message steers a running teammate, wakes an inactive one and rejects invalid sends', async t => {
  const { team, runs } = fixture(t);
  await expectCode(team.sendMessage('lead', { target: 'lead', message: 'self' }), 'TEAM_SELF_MESSAGE');
  await expectCode(team.sendMessage('lead', { target: 'nobody', message: 'hello' }), 'TEAM_MEMBER_NOT_FOUND');
  await expectCode(team.sendMessage('lead', { target: 'reviewer', message: '   ' }), 'TEAM_INVALID_ARGUMENT');
  await expectCode(team.sendMessage('lead', { target: 'reviewer', message: 'x'.repeat(70000) }), 'TEAM_MESSAGE_TOO_LARGE');

  await spawn(team, 'reviewer');
  const first = await runningRun(team, runs);
  assert.deepEqual(await team.sendMessage('lead', { target: 'reviewer', message: 'focus on the failing tests' }), { sent: true });
  assert.deepEqual(first.steer, { text: 'focus on the failing tests', teamMessage: { from: 'lead' } });
  first.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  await team.sendMessage('lead', { target: 'reviewer', message: 'wake up for follow-up work' });
  const second = await runningRun(team, runs, 1);
  assert.match(second.prompt, /Team message from lead:\nwake up for follow-up work/);
  second.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  const small = fixture(t, { limits: { maxMessageBytes: 64 } });
  await spawn(small.team, 'reviewer');
  await runningRun(small.team, small.runs);
  await expectCode(small.team.sendMessage('lead', { target: 'reviewer', message: 'y'.repeat(200) }), 'TEAM_MESSAGE_TOO_LARGE');
});

test('Lead inbox queues peer reports for the next turn and Lead steering delivers immediately', async t => {
  const { team, runs } = fixture(t);
  await spawn(team, 'reviewer');
  const record = await runningRun(team, runs);
  await team.sendMessage('reviewer', { target: 'lead', message: 'found two failing tests' });
  record.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  assert.deepEqual(await team.consumeLeadInbox(), ['Team message from reviewer:\nfound two failing tests']);
  assert.deepEqual(await team.consumeLeadInbox(), [], 'consuming clears the durable inbox');

  let steered;
  await team.setLeadStatus('running');
  team.setLeadSteering(input => { steered = input; });
  await team.sendMessage('reviewer', { target: 'lead', message: 'steered mid-turn' });
  assert.deepEqual(steered, { text: 'steered mid-turn', teamMessage: { from: 'reviewer' } });
  assert.deepEqual(await team.consumeLeadInbox(), [], 'successful steering is not queued again');

  team.setLeadSteering(undefined);
  await team.sendMessage('reviewer', { target: 'lead', message: 'queued without a handler' });
  assert.deepEqual(await team.consumeLeadInbox(), ['Team message from reviewer:\nqueued without a handler']);
  await team.setLeadStatus('inactive');
  await expectCode(team.sendMessage('lead', { target: 'lead', message: 'self' }), 'TEAM_SELF_MESSAGE');
});

test('waitForChange validates its range, resolves on change, times out, aborts and closes', async t => {
  const { team } = fixture(t);
  for (const timeout of [0, 9999, 3600001, 10000.5, '10000']) {
    await expectCode(team.waitForChange('lead', timeout), 'TEAM_INVALID_TIMEOUT');
  }
  const changed = team.waitForChange('lead', 10000);
  await createTask(team);
  assert.deepEqual(await changed, { timedOut: false });

  const reason = new Error('stop waiting');
  const controller = new AbortController();
  const aborted = team.waitForChange('lead', 10000, controller.signal);
  controller.abort(reason);
  await assert.rejects(aborted, error => error === reason);
  const raw = new AbortController();
  const abortedRaw = team.waitForChange('lead', 10000, raw.signal);
  raw.abort('plain reason');
  await assert.rejects(abortedRaw, { code: 'TEAM_WAIT_ABORTED' });

  const closedWaiter = team.waitForChange('lead', 10000);
  await team.close();
  assert.deepEqual(await closedWaiter, { timedOut: false });
});

test('waitForChange times out after the bounded duration', async t => {
  const { team } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = team.waitForChange('lead', 10000);
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, { timedOut: true });
  await team.close();
});

test('wait_agent reports noProgress without an active peer and waits while one runs', async t => {
  const { team, runs } = fixture(t);
  const waitTool = team.toolsFor('lead').find(tool => tool.name === 'wait_agent');
  const noProgress = await waitTool.execute('call-1', { timeout_ms: 10000 });
  assert.equal(noProgress.details.timedOut, false);
  assert.equal(noProgress.details.noProgress.reason, 'no-active-peer');
  assert.match(noProgress.details.noProgress.message, /Re-list with list_agents/);

  await spawn(team, 'reviewer');
  await runningRun(team, runs);
  const pending = waitTool.execute('call-2', { timeout_ms: 10000 });
  await createTask(team);
  assert.deepEqual((await pending).details, { timedOut: false });
});

test('interrupt aborts only the current turn and preserves inbox and task ownership', async t => {
  const { team, runs } = fixture(t, { steering: false });
  await spawn(team, 'reviewer');
  await runningRun(team, runs);
  const task = await createTask(team, { subject: 'Owned work' });
  await team.updateTask('reviewer', { taskId: task.id, expectedRevision: 1, action: 'claim' });
  await team.sendMessage('lead', { target: 'reviewer', message: 'queued before interrupt' });

  assert.deepEqual(await team.interrupt('lead', 'reviewer'), { previousStatus: 'running' });
  const after = team.snapshot();
  assert.equal(after.roster.find(member => member.name === 'reviewer').status, 'inactive');
  const owned = after.tasks.find(candidate => candidate.id === task.id);
  assert.deepEqual([owned.ownerName, owned.status], ['reviewer', 'in_progress']);

  await team.sendMessage('lead', { target: 'reviewer', message: 'resume after interrupt' });
  const second = await runningRun(team, runs, 1);
  assert.match(second.prompt, /Team message from lead:\nqueued before interrupt/);
  assert.match(second.prompt, /Team message from lead:\nresume after interrupt/);
  second.settle();
  await waitStatus(team, 'reviewer', 'inactive');

  assert.deepEqual(await team.interrupt('lead', 'reviewer'), { previousStatus: 'inactive' });
  await expectCode(team.interrupt('lead', 'lead'), 'TEAM_INVALID_TARGET');
  await expectCode(team.interrupt('reviewer', 'reviewer'), 'TEAM_LEAD_REQUIRED');
  await expectCode(team.interrupt('lead', 'nobody'), 'TEAM_MEMBER_NOT_FOUND');
});

test('task board supports CAS transitions, readiness, dependencies and tombstones', async t => {
  const { team } = fixture(t);
  const first = await createTask(team, { subject: 'First', description: 'First task' });
  assert.deepEqual([first.id, first.revision, first.ready], ['task-1', 1, true]);
  assert.deepEqual(await team.listTasks('lead'), [first]);

  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 99, action: 'claim' }), 'TEAM_TASK_STALE_REVISION');
  await expectCode(team.updateTask('lead', { taskId: 'task-99', expectedRevision: 1, action: 'claim' }), 'TEAM_TASK_NOT_FOUND');
  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'complete' }), 'TEAM_TASK_INVALID_TRANSITION');
  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'release' }), 'TEAM_TASK_INVALID_TRANSITION');
  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'reopen' }), 'TEAM_TASK_INVALID_TRANSITION');
  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'nope' }), 'TEAM_INVALID_ARGUMENT');

  const claimed = await team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'claim' });
  assert.deepEqual([claimed.status, claimed.ownerName, claimed.revision], ['in_progress', 'lead', 2]);

  const second = await createTask(team, { subject: 'Second', blockedBy: ['task-1'] });
  assert.equal(second.ready, false);
  await expectCode(team.updateTask('lead', { taskId: 'task-2', expectedRevision: 1, action: 'claim' }), 'TEAM_TASK_BLOCKED');
  await expectCode(createTask(team, { subject: 'Bad blocker', blockedBy: ['task-99'] }), 'TEAM_TASK_NOT_FOUND');
  await expectCode(createTask(team, { subject: 'Bad scope', writeScopes: ['../escape'] }), 'TEAM_INVALID_WRITE_SCOPE');
  await expectCode(createTask(team, { subject: 'Duplicate blocker', blockedBy: ['task-1', 'task-1'] }), 'TEAM_INVALID_ARGUMENT');

  const completed = await team.updateTask('lead', { taskId: 'task-1', expectedRevision: 2, action: 'complete' });
  assert.equal(completed.status, 'completed');
  assert.equal((await team.getTask('lead', 'task-2')).ready, true);
  const claimedSecond = await team.updateTask('lead', { taskId: 'task-2', expectedRevision: 1, action: 'claim' });
  assert.equal(claimedSecond.ownerName, 'lead');

  const reopened = await team.updateTask('lead', { taskId: 'task-1', expectedRevision: 3, action: 'reopen' });
  assert.deepEqual([reopened.status, reopened.ownerName], ['pending', undefined]);
  const reclaimedFirst = await team.updateTask('lead', { taskId: 'task-1', expectedRevision: 4, action: 'claim' });
  assert.equal(reclaimedFirst.status, 'in_progress');

  const edited = await team.updateTask('lead', { taskId: 'task-2', expectedRevision: 2, action: 'edit', subject: 'Second revised', writeScopes: ['src/a'] });
  assert.equal(edited.subject, 'Second revised');
  await expectCode(team.updateTask('lead', { taskId: 'task-2', expectedRevision: 3, action: 'edit' }), 'TEAM_INVALID_ARGUMENT');
  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 5, action: 'set_dependencies', blockedBy: ['task-2'] }), 'TEAM_TASK_DEPENDENCY_CYCLE');
  await expectCode(team.updateTask('lead', { taskId: 'task-2', expectedRevision: 3, action: 'set_dependencies' }), 'TEAM_INVALID_ARGUMENT');

  await expectCode(team.updateTask('lead', { taskId: 'task-1', expectedRevision: 5, action: 'delete' }), 'TEAM_TASK_HAS_DEPENDENTS');
  const deleted = await team.updateTask('lead', { taskId: 'task-2', expectedRevision: 3, action: 'delete' });
  assert.equal(deleted.status, 'deleted');
  assert.equal((await team.snapshot()).tasks.some(task => task.id === 'task-2'), false, 'deleted tasks leave the visible board');
  assert.equal((await team.getTask('lead', 'task-2')).status, 'deleted', 'tombstones stay readable');
  await expectCode(team.updateTask('lead', { taskId: 'task-2', expectedRevision: 4, action: 'claim' }), 'TEAM_TASK_DELETED');

  const third = await createTask(team, { subject: 'Third' });
  assert.equal(third.id, 'task-3', 'deleted ids are never reused');
});

test('task ownership, advisory write scopes, edit/set_dependencies and Lead-only reassign', async t => {
  const { team, runs } = fixture(t);
  await spawn(team, 'reviewer');
  const record = await runningRun(team, runs);
  const first = await createTask(team, { subject: 'Lead task', writeScopes: ['src/harness'] });
  const second = await createTask(team, { subject: 'Member task' });
  await team.updateTask('lead', { taskId: first.id, expectedRevision: 1, action: 'claim' });

  await expectCode(team.updateTask('reviewer', { taskId: first.id, expectedRevision: 2, action: 'complete' }), 'TEAM_TASK_UNAUTHORIZED');
  await expectCode(team.updateTask('reviewer', { taskId: second.id, expectedRevision: 1, action: 'delete' }), 'TEAM_TASK_UNAUTHORIZED');
  const memberClaim = await team.updateTask('reviewer', { taskId: second.id, expectedRevision: 1, action: 'claim' });
  assert.equal(memberClaim.ownerName, 'reviewer');
  await expectCode(team.updateTask('reviewer', { taskId: second.id, expectedRevision: 2, action: 'reassign', owner: 'reviewer' }), 'TEAM_LEAD_REQUIRED');

  const overlapping = await createTask(team, { subject: 'Overlapping', writeScopes: ['src/harness/ide'] });
  await team.updateTask('lead', { taskId: overlapping.id, expectedRevision: 1, action: 'claim' });
  const firstView = await team.getTask('lead', first.id);
  assert.ok(firstView.writeScopeWarnings.includes('write scopes overlap with task-3'), JSON.stringify(firstView.writeScopeWarnings));
  const overlapView = await team.getTask('lead', overlapping.id);
  assert.ok(overlapView.writeScopeWarnings.includes('write scopes overlap with task-1'));
  assert.equal(overlapView.status, 'in_progress', 'write warnings never block the task');

  await expectCode(team.updateTask('lead', { taskId: second.id, expectedRevision: 2, action: 'reassign', owner: 'nobody' }), 'TEAM_MEMBER_NOT_FOUND');
  const reassigned = await team.updateTask('lead', { taskId: second.id, expectedRevision: 2, action: 'reassign', owner: 'lead' });
  assert.deepEqual([reassigned.ownerName, reassigned.status], ['lead', 'in_progress']);
  const unassigned = await team.updateTask('lead', { taskId: second.id, expectedRevision: 3, action: 'reassign' });
  assert.deepEqual([unassigned.status, unassigned.ownerName], ['pending', undefined]);
  record.settle();
  await waitStatus(team, 'reviewer', 'inactive');
});

test('team state reloads roster, tasks, tombstones and inboxes from persistence', async t => {
  const persistence = store();
  const { team, runs } = fixture(t, { persistence });
  await spawn(team, 'reviewer');
  const record = await runningRun(team, runs);
  await createTask(team, { subject: 'Persisted task' });
  await createTask(team, { subject: 'Dependent task', blockedBy: ['task-1'] });
  await createTask(team, { subject: 'Deleted task' });
  await team.sendMessage('reviewer', { target: 'lead', message: 'kept for reload' });
  await team.updateTask('lead', { taskId: 'task-3', expectedRevision: 1, action: 'delete' });
  record.settle('finished');
  await waitStatus(team, 'reviewer', 'inactive');
  await team.close();

  const saved = persistence.values.get('team:state');
  assert.equal(saved.version, 1);
  assert.equal(saved.sessionId, SESSION);
  assert.deepEqual(saved.roster.map(row => row.name), ['lead', 'reviewer']);
  assert.equal(saved.roster[1].status, 'inactive');
  assert.equal(saved.tasks.some(task => task.id === 'task-3'), false, 'the projection field hides deleted tasks');
  assert.equal(saved.tombstones.some(task => task.id === 'task-3'), true, 'tombstones are retained internally');
  assert.equal(saved.inbox.lead.length, 1);
  assert.equal(saved.inbox.lead[0].text, 'kept for reload');
  assert.ok(saved.revision > 0);
  assert.ok(saved.nextTaskNumber >= 4);

  const reloaded = fixture(t, { persistence, state: saved });
  const snapshot = reloaded.team.snapshot();
  assert.deepEqual(snapshot.roster.map(row => [row.name, row.status]), [['lead', 'inactive'], ['reviewer', 'inactive']]);
  assert.deepEqual(snapshot.tasks.map(task => task.id), ['task-1', 'task-2']);
  assert.equal(snapshot.tasks[0].subject, 'Persisted task');
  assert.equal(snapshot.revision, saved.revision);
  assert.equal((await reloaded.team.getTask('lead', 'task-3')).status, 'deleted');
  assert.deepEqual(await reloaded.team.consumeLeadInbox(), ['Team message from reviewer:\nkept for reload']);
  const nextTask = await createTask(reloaded.team, { subject: 'After reload' });
  assert.equal(nextTask.id, 'task-4', 'task ids continue after reload without reusing tombstones');
  const reclaimed = await reloaded.team.updateTask('lead', { taskId: 'task-1', expectedRevision: 1, action: 'claim' });
  assert.equal(reclaimed.ownerName, 'lead', 'persisted revisions remain the CAS baseline');
  await expectCode(spawn(reloaded.team, 'reviewer'), 'TEAM_MEMBER_NAME_TAKEN');
});

test('close interrupts runs, resolves waiters, persists final state and stays idempotent', async t => {
  const persistence = store();
  const { team, runs } = fixture(t, { persistence });
  await spawn(team, 'reviewer');
  await runningRun(team, runs);
  const waiter = team.waitForChange('lead', 10000);
  const first = team.close();
  const second = team.close();
  assert.equal(first, second, 'close is idempotent and returns the same promise');
  await first;
  assert.deepEqual(await waiter, { timedOut: false });
  assert.equal(team.snapshot().roster.find(member => member.name === 'reviewer').status, 'inactive');
  assert.equal(persistence.values.get('team:state').roster.find(row => row.name === 'reviewer').status, 'inactive');
  await second;

  await expectCode(spawn(team, 'late'), 'TEAM_CLOSED');
  await expectCode(team.sendMessage('lead', { target: 'lead', message: 'x' }), 'TEAM_CLOSED');
  await expectCode(createTask(team), 'TEAM_CLOSED');
  await expectCode(team.toolsFor('lead')[0].execute('call-1', { name: 'late', description: 'x', prompt: 'y' }), 'TEAM_CLOSED');
  assert.equal(team.snapshot().roster.filter(member => member.role === 'teammate').length, 1);
});

test('the turn signal aborts live teammates and closes the service without raw abort errors', async t => {
  const controller = new AbortController();
  const { team, runs } = fixture(t, { signal: controller.signal });
  await spawn(team, 'reviewer');
  await runningRun(team, runs);
  controller.abort(new Error('collaboration turn ended'));
  await waitStatus(team, 'reviewer', 'inactive');
  await team.close();
  await team.close();
  assert.equal(team.snapshot().roster.find(member => member.name === 'reviewer').status, 'inactive');
});

test('createTeam validates its inputs and rejects another session state', async t => {
  assert.throws(() => createTeam({ sessionId: '', runMember: async () => 'x' }), TypeError);
  assert.throws(() => createTeam({ sessionId: SESSION }), /runMember/);
  assert.throws(() => createTeam({ sessionId: SESSION, runMember: async () => 'x', onEvent: 'nope' }), TypeError);
  assert.throws(() => createTeam({ sessionId: SESSION, runMember: async () => 'x', onLiveEvent: 'nope' }), TypeError);
  assert.throws(() => createTeam({ sessionId: SESSION, runMember: async () => 'x', limits: { maxMembers: 0 } }), TypeError);
  assert.throws(() => createTeam({ sessionId: SESSION, runMember: async () => 'x', limits: { maxMessageBytes: -1 } }), TypeError);
  assert.throws(() => createTeam({ sessionId: SESSION, runMember: async () => 'x', state: { sessionId: 'other' } }), /another session/);

  const corrupted = createTeam({
    sessionId: SESSION,
    runMember: async () => 'x',
    state: {
      version: 1,
      sessionId: SESSION,
      revision: 4,
      nextTaskNumber: 1,
      roster: [{ name: 'lead', role: 'lead', status: 'running', createdAt: 1, updatedAt: 2 },
        { name: 'reviewer', role: 'teammate', status: 'provisioning', description: 'Reviewer', context: 'fork', createdAt: 3, updatedAt: 4 },
        { name: 'INVALID', role: 'teammate', status: 'inactive' }],
      tasks: [
        { id: 'task-2', revision: 3, subject: 'Two', description: 'Two', status: 'pending', blockedBy: ['task-1'], writeScopes: [] },
        { id: 'task-1', revision: 1, subject: 'One', description: 'One', status: 'completed', blockedBy: [], writeScopes: [] },
        { id: 'task-5', revision: 1, subject: 'Cyclic', description: 'Cyclic', status: 'pending', blockedBy: ['task-6'], writeScopes: [] },
        { id: 'task-6', revision: 1, subject: 'Cyclic', description: 'Cyclic', status: 'pending', blockedBy: ['task-5'], writeScopes: [] },
      ],
    },
  });
  t.after(() => corrupted.close().catch(() => {}));
  const snapshot = corrupted.snapshot();
  assert.deepEqual(snapshot.roster.map(row => row.name), ['lead', 'reviewer']);
  assert.equal(snapshot.roster[0].status, 'inactive');
  assert.equal(snapshot.roster[1].status, 'inactive');
  assert.equal(snapshot.roster[1].context, 'fork');
  assert.deepEqual(snapshot.tasks.map(task => task.id), ['task-1', 'task-2', 'task-5', 'task-6']);
  assert.equal((await corrupted.getTask('lead', 'task-2')).subject, 'Two');
  // Damaged cyclic dependencies are repaired so the board remains mutable.
  const fresh = await createTask(corrupted, { subject: 'Fresh task' });
  assert.equal(fresh.id, 'task-7');
  assert.equal(corrupted.snapshot().tasks.length, 5);
});

test('Team policy and teammate prompts carry the shared coordination contract', () => {
  assert.match(TEAM_POLICY, /share the same working directory and filesystem/);
  assert.match(TEAM_POLICY, /Split write work into disjoint scopes/);
  assert.match(TEAM_POLICY, /write-scope overlap is advisory, not a lock/i);
  assert.match(TEAM_POLICY, /send_message steers a running target at its nearest step boundary/);
  assert.match(TEAM_POLICY, /A successful send does not mean the recipient has processed it/);
  assert.match(TEAM_POLICY, /inactive means no turn is executing/);
  assert.match(TEAM_POLICY, /wait_agent observes only changes after that call starts/);
  assert.match(TEAM_POLICY, /The Lead must wait for required teammates before giving the final answer/);
  assert.match(TEAM_POLICY, /list, get, claim with the current revision, perform the work, then complete/);
  assert.match(TEAM_POLICY, /Only the Team Lead creates or interrupts teammates; there are no nested teams/);
  assert.match(TEAM_POLICY, /send_message\(\{ target: "lead" \}\)/);
  assert.match(TEAM_POLICY, /FS_STALE_VERSION/);

  assert.match(teamPolicy('lead', 'lead'), /You are the Team Lead named "lead"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /You are teammate "reviewer"/);
  assert.match(teamPolicy('teammate', 'reviewer'), /send_message\(\{ target: "lead"/);
  assert.match(teamPolicy('lead', 'lead'), /Use list_agents\(\{\}\)/);
  assert.match(teammateSystemPrompt, /You are a named teammate inside the UBOVM IDE collaboration mode/);
  assert.match(teammateSystemPrompt, /report concise results and limitations to the Lead/);
});

test('runCollaboration exposes Team tools, runs a spawned teammate and persists the roster', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const systems = [];
  let rootCalls = 0;
  const streamFn = (model, request) => {
    const system = plain(request.messages.find(message => message.role === 'system'));
    systems.push(system);
    if (system.includes('named teammate inside the UBOVM')) return respond(model, 'teammate report');
    rootCalls += 1;
    if (rootCalls === 1) {
      assert.match(system, /Agent Teams is available in this session/);
      return respond(model, [toolCall('spawn-1', 'spawn_teammate', { name: 'reviewer', description: 'Review the change', prompt: 'Review the change and report' })]);
    }
    if (rootCalls === 2) return respond(model, [toolCall('wait-1', 'wait_agent', { timeout_ms: 10000 })]);
    return respond(model, 'lead final');
  };
  const events = [];
  const answer = await runCollaboration({
    configuration: { model: modelConfiguration(streamFn), intools: false, contextSummary: false },
    sessionId, directory, workspaceRoots: [], text: 'delegate the review', onEvent: event => events.push(event),
  });
  assert.equal(answer, 'lead final');
  assert.ok(systems.some(system => system.includes('named teammate inside the UBOVM')), 'the spawned teammate ran a real conversational loop');
  const teamStatuses = events.filter(event => event.type === 'team.status');
  assert.ok(teamStatuses.length > 0);
  assert.ok(teamStatuses.some(event => event.team.roster.some(row => row.name === 'reviewer')), 'Team status includes the spawned teammate');
  const rawMemberEvents = events.filter(event => event.type === 'team.member.event' && event.member === 'reviewer');
  assert.ok(rawMemberEvents.length > 0, 'raw teammate events are forwarded on the un-audited live channel');
  assert.ok(rawMemberEvents.every(event => typeof event.event?.type === 'string'), 'the live channel carries raw runConversation events');
  assert.ok(rawMemberEvents.some(event => event.event.type === 'message_start'));
  assert.ok(rawMemberEvents.some(event => event.event.type === 'message_end'));
  assert.ok(events.some(event => event.type === 'team.member.activity' && event.member === 'reviewer'), 'compact activity events stay audited');
  assert.deepEqual(events.filter(event => event.type === 'team.member.run' && event.member === 'reviewer').map(event => [event.phase, event.status]),
    [['start', undefined], ['end', 'inactive']], 'teammate run lifecycle is audited');

  const database = await HarnessDatabase.open({ filePath: join(directory, 'assist.sqlite') });
  try {
    const saved = database.loadContext(sessionId, 'team:state');
    assert.ok(saved, 'Team state is persisted in the assist session database');
    assert.deepEqual(saved.roster.map(row => row.name), ['lead', 'reviewer']);
    assert.equal(saved.roster.find(row => row.name === 'reviewer').status, 'inactive');
    assert.equal(database.loadContext(sessionId, 'team:member:reviewer:transcript') !== undefined, true, 'teammate transcript is stored under its documented key');
    const audited = database.events(sessionId, { limit: 1000 }).map(payload => payload.event).filter(Boolean);
    const auditedTypes = new Set(audited.map(event => event.type));
    assert.ok(auditedTypes.has('team.member.activity'), 'compact activity events reach the SQLite audit');
    assert.ok(auditedTypes.has('team.member.run'), 'run lifecycle events reach the SQLite audit');
    assert.equal(auditedTypes.has('team.member.event'), false, 'raw streaming events are never routed through the audit');
  } finally {
    database.close();
  }
});

test('collaboration.team=false keeps Swarm-only collaboration without Team prompts or state', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-off-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const systems = [];
  const answer = await runCollaboration({
    configuration: {
      model: modelConfiguration((model, request) => {
        systems.push(plain(request.messages.find(message => message.role === 'system')));
        return respond(model, 'swarm-only answer');
      }),
      intools: false, contextSummary: false, collaboration: { team: false },
    },
    sessionId, directory, workspaceRoots: [], text: 'answer directly',
  });
  assert.equal(answer, 'swarm-only answer');
  assert.ok(systems.length > 0);
  assert.ok(systems.every(system => !system.includes('Agent Teams is available')), 'Team policy is not appended when the Team is disabled');
  const database = await HarnessDatabase.open({ filePath: join(directory, 'assist.sqlite') });
  try {
    assert.equal(database.loadContext(sessionId, 'team:state'), undefined, 'a disabled Team writes no Team state');
  } finally {
    database.close();
  }
});

test('invalid Team limits fail before any model request', async t => {
  let modelCalls = 0;
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(runCollaboration({
    configuration: {
      model: modelConfiguration(model => { modelCalls += 1; return respond(model, 'must not run'); }),
      intools: false, contextSummary: false, collaboration: { team: { maxMembers: 0 } },
    },
    sessionId: randomUUID(), directory, workspaceRoots: [], text: 'no run',
  }), TypeError);
  assert.equal(modelCalls, 0);
});
