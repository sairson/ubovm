import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runCollaboration } from '../index.mjs';

const plain = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const assistant = (model, content, stopReason = 'stop') => ({
  role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now()
});
function respond(model, content) {
  const stream = new AssistantMessageEventStream();
  const message = assistant(model, content, Array.isArray(content) && content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop');
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}
const lastToolResult = (request, name) => request.messages.filter(message => message.role === 'toolResult' && (!name || message.toolName === name)).at(-1);
const toolResultValue = (request, name) => {
  const result = lastToolResult(request, name);
  if (!result) return undefined;
  try { return JSON.parse(plain(result)); } catch { return undefined; }
};
const systemText = request => plain(request.messages.find(message => message.role === 'system'));
const memberName = system => /You are teammate "([^"]+)"/.exec(system)?.[1];

async function fixture(t, streamFn, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory, sessionId: randomUUID(), workspaceRoots: [],
    configuration: {
      model: { provider: 'collaboration-test', modelId: 'fake-chat', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn },
      intools: false, contextSummary: false, ...overrides
    }
  };
}

const TEAM_TOOL_NAMES = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'];

test('Agent Teams spawns a durable teammate, runs the shared task board and reports to the Lead', async t => {
  const events = [];
  const callCounts = new Map();
  const options = await fixture(t, (model, request) => {
    const system = systemText(request);
    const role = memberName(system) ?? 'lead';
    const calls = (callCounts.get(role) ?? 0) + 1;
    callCounts.set(role, calls);
    if (role === 'lead') {
      const last = lastToolResult(request);
      if (!last) return respond(model, [toolCall('spawn-1', 'spawn_teammate', {
        name: 'reviewer', description: 'Review the shared task', prompt: 'Create one task, claim it, complete it and report back to the Lead.'
      })]);
      if (last.toolName === 'spawn_teammate') {
        assert.match(plain(last), /"target":"reviewer"/);
        return respond(model, [toolCall('wait-1', 'wait_agent', { timeout_ms: 12000 })]);
      }
      if (last.toolName === 'wait_agent') {
        const wait = toolResultValue(request, 'wait_agent') ?? {};
        if (wait.noProgress || wait.timedOut || calls >= 6) return respond(model, 'Reviewer finished; it reported the result to the Lead.');
        return respond(model, [toolCall(`wait-${calls}`, 'wait_agent', { timeout_ms: 12000 })]);
      }
      return respond(model, 'Reviewer finished; it reported the result to the Lead.');
    }
    // Teammate: create -> claim -> complete -> report to Lead -> final answer.
    const created = toolResultValue(request, 'team_task_create');
    const claimed = toolResultValue(request, 'team_task_update');
    const sent = toolResultValue(request, 'send_message');
    if (!created) return respond(model, [toolCall('task-1', 'team_task_create', {
      subject: 'Review shared diff', description: 'Read the diff and report the risk.', write_scopes: ['src/harness/agents'] })]);
    assert.equal(created.id, 'task-1'); assert.equal(created.status, 'pending'); assert.equal(created.ready, true);
    if (!claimed || claimed.status === 'completed') {
      // First update claims the task; the second completes it with the CAS
      // revision returned by the claim.
      if (!claimed) return respond(model, [toolCall('claim-1', 'team_task_update', {
        task_id: created.id, expected_revision: created.revision, action: 'claim' })]);
    }
    if (claimed && claimed.status === 'in_progress' && !sent) {
      assert.equal(claimed.ownerName, 'reviewer');
      return respond(model, [toolCall('complete-1', 'team_task_update', {
        task_id: created.id, expected_revision: claimed.revision, action: 'complete' })]);
    }
    if (claimed && claimed.status === 'completed' && !sent) {
      return respond(model, [toolCall('send-1', 'send_message', { target: 'lead', message: 'task-1 completed: shared diff has no unresolved risks.' })]);
    }
    if (sent) assert.equal(sent.sent, true);
    return respond(model, 'Review complete: task-1 is completed.');
  });
  const answer = await runCollaboration({ ...options, text: 'Create a reviewer teammate and have it complete one task.', onEvent: event => events.push(event) });
  assert.match(answer, /Reviewer finished/);

  const statuses = events.filter(event => event.type === 'team.status').map(event => event.team);
  assert(statuses.length >= 2, 'team status changes are projected to the host');
  const final = statuses.at(-1);
  const reviewer = final.roster.find(row => row.name === 'reviewer');
  assert(reviewer, 'reviewer is on the roster');
  assert.equal(reviewer.role, 'teammate');
  assert.equal(reviewer.status, 'inactive');
  const task = final.tasks.find(item => item.id === 'task-1');
  assert.equal(task.status, 'completed');
  assert.equal(task.ownerName, 'reviewer');
  assert.equal(task.revision >= 2, true);
  assert(events.some(event => event.type === 'team.member.event' && event.member === 'reviewer' && event.event.type === 'tool_execution_start'));
  assert(events.some(event => event.type === 'team.member.event' && event.member === 'reviewer' && event.event.type === 'tool_execution_end'));
  // The conversation view needs a start/end boundary per teammate run and a
  // compact activity channel separate from the raw live stream.
  const runs = events.filter(event => event.type === 'team.member.run' && event.member === 'reviewer');
  assert.equal(runs.filter(event => event.phase === 'start').length, 1);
  assert.equal(runs.filter(event => event.phase === 'end').length, 1);
  assert.equal(runs.find(event => event.phase === 'end').status, 'inactive');
  assert(events.some(event => event.type === 'team.member.activity' && event.member === 'reviewer' && event.activity.label === 'team_task_create'));
  assert(events.some(event => event.type === 'team.member.event' && event.member === 'reviewer' && event.event.type === 'message_start'), 'raw message boundaries stay on the un-audited live channel');
});

test('Agent Teams roster, task board and teammate history survive the next assist turn', async t => {
  let turn = 0, wakes = 0, wakeStarted = false;
  const options = await fixture(t, (model, request) => {
    const role = memberName(systemText(request)) ?? 'lead';
    if (role === 'reviewer') {
      if (turn === 0) {
        const created = toolResultValue(request, 'team_task_create');
        if (!created) return respond(model, [toolCall('persist-task', 'team_task_create', {
          subject: 'Persisted board check', description: 'Created in the first turn and read in the second.', write_scopes: ['src/harness'] })]);
        return respond(model, 'Task created for the next turn.');
      }
      if (!wakeStarted) { wakeStarted = true; wakes++; }
      const sent = toolResultValue(request, 'send_message');
      if (sent) return respond(model, 'Confirmation delivered.');
      return respond(model, [toolCall('wake-send', 'send_message', { target: 'lead', message: 'reviewer confirmed the persisted task board' })]);
    }
    if (turn === 0) {
      const last = lastToolResult(request);
      if (!last) return respond(model, [toolCall('spawn-turn-1', 'spawn_teammate', {
        name: 'reviewer', description: 'Persisted roster/task check', prompt: 'Create one task and leave it pending for the next turn.'
      })]);
      if (last.toolName === 'spawn_teammate') return respond(model, [toolCall('wait-turn-1', 'wait_agent', { timeout_ms: 12000 })]);
      const wait = toolResultValue(request, 'wait_agent') ?? {};
      if (!wait.noProgress && !wait.timedOut) return respond(model, [toolCall('wait-turn-1b', 'wait_agent', { timeout_ms: 12000 })]);
      return respond(model, 'Teammate is idle for the next turn.');
    }
    // Turn 2: read durable team state, then wake the inactive teammate.
    const listed = toolResultValue(request, 'list_agents');
    const board = toolResultValue(request, 'team_task_list');
    const sent = toolResultValue(request, 'send_message');
    if (!listed) return respond(model, [toolCall('list-turn-2', 'list_agents', {})]);
    assert(listed.some(row => row.target === 'reviewer' && row.status === 'inactive'));
    if (!board) return respond(model, [toolCall('board-turn-2', 'team_task_list', {})]);
    assert(board.tasks.some(item => item.subject === 'Persisted board check'));
    if (!sent) return respond(model, [toolCall('send-turn-2', 'send_message', { target: 'reviewer', message: 'Confirm the persisted board.' })]);
    const last = lastToolResult(request);
    if (last?.toolName === 'send_message') return respond(model, [toolCall('wait-turn-2', 'wait_agent', { timeout_ms: 12000 })]);
    return respond(model, 'Persisted Team state was read and reviewer was woken.');
  });
  const firstAnswer = await runCollaboration({ ...options, text: 'Spawn a teammate that leaves one pending task.' });
  assert.match(firstAnswer, /idle/);
  turn = 1;
  const secondAnswer = await runCollaboration({ ...options, text: 'Show the persisted team board and wake reviewer.' });
  assert.match(secondAnswer, /Persisted Team state/);
  assert.equal(wakes, 1, 'the inactive teammate is woken exactly once by send_message');
});
