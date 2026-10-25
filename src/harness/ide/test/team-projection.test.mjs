import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { projectTeam, teamTranscriptConversation, interruptExecution } = require('../runtime/projection.cjs');

const member = (overrides = {}) => ({
  name: 'reviewer', role: 'teammate', status: 'inactive', description: 'Review the diff',
  context: 'fresh', updatedAt: 10, ...overrides
});
const task = (overrides = {}) => ({
  id: 'task-1', revision: 2, subject: 'Review runtime', description: 'Check limits',
  status: 'in_progress', ownerName: 'reviewer', blockedBy: [], writeScopes: ['src/harness'],
  ready: true, writeScopeWarnings: [], ...overrides
});

test('projectTeam keeps the bounded UI shape and drops unavailable fields', () => {
  const team = projectTeam({ revision: 3, roster: [
    { name: 'lead', role: 'lead', status: 'running', updatedAt: 1 },
    member({ activity: { label: 'read_workspace_code', status: 'running', at: 5 }, extra: 'drop me' })
  ], tasks: [task()], mailboxes: { reviewer: ['secret'] } });
  assert.deepEqual(team, {
    revision: 3,
    roster: [
      { name: 'lead', role: 'lead', status: 'running', updatedAt: 1 },
      { name: 'reviewer', role: 'teammate', status: 'inactive', description: 'Review the diff', context: 'fresh', updatedAt: 10,
        activity: { label: 'read_workspace_code', status: 'running', at: 5 } }
    ],
    tasks: [{ id: 'task-1', revision: 2, subject: 'Review runtime', description: 'Check limits', status: 'in_progress',
      ownerName: 'reviewer', blockedBy: [], writeScopes: ['src/harness'], ready: true, writeScopeWarnings: [] }]
  });
});

test('projectTeam returns undefined for an empty, Lead-only or malformed Team', () => {
  assert.equal(projectTeam(undefined), undefined);
  assert.equal(projectTeam(null), undefined);
  assert.equal(projectTeam('team'), undefined);
  assert.equal(projectTeam({}), undefined);
  assert.equal(projectTeam({ revision: 1, roster: [{ name: 'lead', role: 'lead', status: 'running' }], tasks: [] }), undefined);
});

test('projectTeam hides a task-only board because a Lead row is always present', () => {
  const team = projectTeam({ revision: 1, roster: [], tasks: [task({ status: 'pending', ownerName: undefined })] });
  assert.equal(team.roster.length, 0);
  assert.equal(team.tasks.length, 1);
  assert.equal('ownerName' in team.tasks[0], false);
  assert.equal(team.tasks[0].ready, true);
});

test('projectTeam clamps hostile values instead of forwarding them to the page', () => {
  const huge = 'x'.repeat(5000);
  const team = projectTeam({
    revision: -2, roster: [{ name: huge, role: 'owner', status: 'sleeping', description: huge, error: huge,
      activity: { label: huge, status: huge, at: -1 } }],
    tasks: [{ id: huge, revision: Number.MAX_SAFE_INTEGER + 2, subject: huge, description: huge, status: 'deleted',
      ownerName: huge, blockedBy: [huge, 1, null], writeScopes: [huge], ready: 'yes', writeScopeWarnings: [huge] }]
  });
  assert.equal(team.revision, 0);
  assert.equal(team.roster[0].name.length, 80);
  assert.equal(team.roster[0].role, 'teammate');
  assert.equal(team.roster[0].status, 'inactive');
  assert.equal(team.roster[0].description.length, 500);
  assert.equal(team.roster[0].error.length, 500);
  assert.equal(team.roster[0].activity.label.length, 200);
  assert.equal(team.roster[0].activity.status.length, 40);
  assert.equal('at' in team.roster[0].activity, false);
  assert.equal(team.tasks[0].id.length, 80);
  assert.equal(team.tasks[0].revision, 0);
  assert.equal(team.tasks[0].subject.length, 300);
  assert.equal(team.tasks[0].description.length, 4000);
  assert.equal(team.tasks[0].status, 'pending');
  assert.deepEqual(team.tasks[0].blockedBy, [team.roster[0].name]);
  assert.equal(team.tasks[0].ready, false);
});

test('projectTeam ignores non-object rows and caps roster/task counts', () => {
  const roster = [null, 5, 'x', ...Array.from({ length: 40 }, (_, index) => member({ name: `m${index}` }))];
  const tasks = [null, ...Array.from({ length: 600 }, (_, index) => task({ id: `task-${index + 1}` }))];
  const team = projectTeam({ revision: 4, roster, tasks });
  assert.equal(team.roster.length, 32);
  assert.equal(team.tasks.length, 500);
});

test('projectTeam accepts the persisted {team:…} envelope used by restore', () => {
  const team = projectTeam({ team: { revision: 7, roster: [member()], tasks: [] }, sessionId: 's' });
  assert.equal(team.revision, 7);
  assert.equal(team.roster[0].name, 'reviewer');
});

test('interruptExecution turns live teammates inactive without touching tasks', () => {
  const state = {
    status: 'running', busy: true, parts: [], activities: [], workers: [],
    team: { revision: 2, roster: [{ name: 'reviewer', role: 'teammate', status: 'running' },
      { name: 'tester', role: 'teammate', status: 'provisioning' },
      { name: 'idle', role: 'teammate', status: 'inactive' }],
      tasks: [{ id: 'task-1', status: 'in_progress' }] }
  };
  const next = interruptExecution(state, undefined, 50);
  assert.deepEqual(next.team.roster.map(row => row.status), ['inactive', 'inactive', 'inactive']);
  assert.deepEqual(next.team.tasks, [{ id: 'task-1', status: 'in_progress' }]);
  assert.equal(next.status, 'interrupted');
});

test('interruptExecution leaves a missing Team untouched', () => {
  const next = interruptExecution({ status: 'running', busy: true, parts: [], activities: [], workers: [] }, undefined, 1);
  assert.equal('team' in next, false);
});

const transcript = () => ([
  { role: 'user', content: [{ type: 'text', text: 'Team message from lead:\n审查协作模块。' }], timestamp: 10 },
  { role: 'assistant', timestamp: 20, content: [
    { type: 'thinking', thinking: '先看工具边界。' },
    { type: 'text', text: '已定位入口，开始读取。' },
    { type: 'toolCall', id: 'call-1', name: 'read_workspace_code', arguments: { path: 'src/harness/agents/collaboration/team.mjs' } }
  ] },
  { role: 'toolResult', toolCallId: 'call-1', toolName: 'read_workspace_code', isError: false,
    content: [{ type: 'text', text: 'export function createTeam() {}' }], timestamp: 30 },
  { role: 'assistant', timestamp: 40, content: [{ type: 'text', text: '审查完成，发现一处边界问题。' }] },
  { role: 'toolResult', toolCallId: 'missing-call', content: [{ type: 'text', text: 'ignored' }] }
]);

test('teamTranscriptConversation converts user, assistant, thinking, tool call and result', () => {
  const { entries, omitted } = teamTranscriptConversation(transcript());
  assert.equal(omitted, 0);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { id: 'team:user:0', role: 'user', text: 'Team message from lead:\n审查协作模块。', timestamp: 10 });
  const first = entries[1];
  assert.equal(first.role, 'assistant');
  assert.equal(first.text, '已定位入口，开始读取。');
  assert.equal(first.parts.length, 3);
  assert.deepEqual(first.parts[0], { id: 'team:thinking:1:0', type: 'thinking', text: '先看工具边界。', status: 'completed', source: 'assistant', startedAt: 20, endedAt: 20 });
  assert.equal(first.parts[1].type, 'text');
  const tool = first.parts[2];
  assert.equal(tool.type, 'tool');
  assert.equal(tool.name, 'read_workspace_code');
  assert.match(tool.args, /team\.mjs/);
  assert.equal(tool.output, 'export function createTeam() {}');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.endedAt, 30);
  assert.equal(entries[2].text, '审查完成，发现一处边界问题。');
});

test('teamTranscriptConversation leaves interrupted tools explicit and ignores orphan results', () => {
  const messages = transcript();
  messages.splice(2, 1);
  const { entries } = teamTranscriptConversation(messages);
  const tool = entries[1].parts.find(part => part.type === 'tool');
  assert.equal(tool.status, 'interrupted');
  assert.equal(tool.output, '');
});

test('teamTranscriptConversation bounds entries, parts and text without mutating input', () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    role: 'assistant', timestamp: index,
    content: [{ type: 'text', text: `${index}:` + 'x'.repeat(30000) }]
  }));
  const snapshot = JSON.stringify(messages);
  const { entries, omitted } = teamTranscriptConversation(messages, { maxEntries: 10, maxParts: 10, maxText: 100 });
  assert.equal(entries.length, 10);
  assert.equal(omitted, 110);
  assert(entries.every(entry => entry.parts.length <= 10));
  assert(entries.every(entry => entry.text.length <= 100 + '\n[内容已截断]'.length));
  assert.equal(JSON.stringify(messages), snapshot);
});

test('teamTranscriptConversation tolerates malformed transcripts', () => {
  for (const value of [undefined, null, 'text', 42, [null, 5, {}], [{ role: 'assistant' }]]) {
    const result = teamTranscriptConversation(value);
    assert.deepEqual(result.entries, []);
    assert.equal(result.omitted, 0);
  }
});
