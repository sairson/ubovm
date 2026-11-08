'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateOrder } = require('../../webview/state-order.js');
const full = (viewRevision, id = 'a', status = 'running') => ({ type: 'state', viewRevision,
  conversation: { id }, execution: { status }, busy: status === 'running', messages: [] });
const delta = (viewRevision, id = 'a', status = 'completed') => ({ type: 'executionState', viewRevision,
  conversationId: id, execution: { status }, busy: status === 'running' });

test('failed receive transactions restore both ordering counters for an identical resync', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  const checkpoint = order.checkpoint();
  order.full(full(3, 'b'), current);
  order.restore(checkpoint);
  current = order.full(full(3, 'b'), current);
  assert.equal(current.conversation.id, 'b');
  const executionCheckpoint = order.checkpoint();
  order.execution(delta(4, 'b'), current);
  order.restore(executionCheckpoint);
  assert.equal(order.execution(delta(4, 'b'), current).execution.status, 'completed');
});

test('full session updates preserve Agent memory omitted from the execution snapshot', () => {
  const order = createStateOrder();
  let current = order.full({ ...full(1), notes: [], execution: { status: 'running', memory: { notes: [{ id: 'n1', content: 'keep' }] } } });
  current = order.full({ ...full(2, 'a', 'idle'), notes: [], deletedAgentNotes: ['other'] }, current);
  assert.deepEqual(current.execution.memory, { notes: [{ id: 'n1', content: 'keep' }] });
  // A different conversation must not inherit the previous notebook.
  current = order.full({ ...full(3, 'b', 'idle'), execution: { status: 'idle' } }, current);
  assert.equal(current.execution.memory, undefined);
});

test('a status transition does not retain the error of the previous run', () => {
  const order = createStateOrder();
  let current = order.full({ ...full(1, 'a', 'failed'), execution: { status: 'failed', error: { code: 'OPERATION_FAILED', message: '旧错误' } } });
  // Same-status snapshots still keep a light projection's error.
  current = order.full({ ...full(2, 'a', 'failed'), execution: { status: 'failed', activities: [] } }, current);
  assert.deepEqual(current.execution.error, { code: 'OPERATION_FAILED', message: '旧错误' });
  current = order.full({ ...full(3, 'a', 'interrupted'), execution: { status: 'interrupted', canResume: true, activities: [] } }, current);
  assert.equal(current.execution.status, 'interrupted');
  assert.equal('error' in current.execution, false);
  assert.equal(current.execution.canResume, true);
  // A finished run must also drop its Team projection instead of leaving the
  // assist Team popover open over the next idle state.
  current = order.full({ ...full(4, 'a', 'running'), execution: { status: 'running', team: { roster: [{ name: 'Lead' }], tasks: [] } } }, current);
  current = order.full({ ...full(5, 'a', 'idle'), busy: false, execution: { status: 'idle' } }, current);
  assert.equal('team' in current.execution, false);
});

test('invalid fields are downgraded and the revision advances instead of retrying forever', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  for (const invalid of [{ messages: {} }, { relatedConversations: {} }, { context: [] }, { mode: 'invalid' }, { execution: { parts: {} } }]) {
    assert.doesNotThrow(() => { current = order.full({ ...full(2), ...invalid }, current); });
  }
  current = order.full(full(8), current);
  assert.equal(current.conversation.id, 'a');
  assert.doesNotThrow(() => { current = order.full({ ...full(9), messages: {} }, current); });
  assert.doesNotThrow(() => order.execution({ ...delta(10), execution: [] }, current));
  assert.equal(order.execution(delta(11), current).execution.status, 'completed');
});

test('old and duplicate execution updates cannot undo completion or a newer full state', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution(delta(3), current);
  assert.equal(order.execution(delta(2, 'a', 'running'), current), null);
  assert.equal(order.execution(delta(3), current), null);
  current = order.full(full(4, 'a', 'idle'), current);
  assert.equal(order.execution(delta(3), current), null);
  assert.equal(current.execution.status, 'idle');
});

test('late full state refreshes conversation metadata without rolling back newer execution', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution(delta(3), current);
  current = order.full({ ...full(2), messages: ['saved answer'], toolApprovals: ['new approval'] }, current);
  assert.deepEqual(current.messages, ['saved answer']);
  assert.deepEqual(current.toolApprovals, ['new approval']);
  assert.equal(current.execution.status, 'completed'); assert.equal(current.busy, false);
  assert.equal(order.full(full(1), current), null);
});

test('stale full states cannot switch conversations back and foreign deltas consume no revision', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.full(full(3, 'b'), current);
  assert.equal(order.full(full(2), current), null);
  assert.equal(order.execution(delta(100, 'a'), current), null);
  current = order.execution(delta(4, 'b'), current);
  assert.equal(current.conversation.id, 'b'); assert.equal(current.execution.status, 'completed');
});

test('legacy execution fixtures continue to apply without a view revision', () => {
  const order = createStateOrder();
  let current = order.full(full(undefined));
  current = order.execution(delta(undefined), current);
  assert.equal(current.execution.status, 'completed');
  assert.equal(order.full({ viewRevision: 100 }, current), null);
  current = order.full(full(2), current);
  assert.equal(order.full(full(undefined), current), null);
  assert.equal(order.execution(delta(undefined), current).execution.status, 'completed');
});

test('unversioned execution uses seq for deduplication when provided', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution({ ...delta(undefined), seq: 2, execution: { status: 'running' } }, current);
  assert.equal(order.execution({ ...delta(undefined), seq: 2, execution: { status: 'completed' } }, current), null);
  current = order.execution({ ...delta(undefined), seq: 3, execution: { status: 'completed' } }, current);
  assert.equal(current.execution.status, 'completed');
});

test('execution ticks can clear recovering without replacing conversation history', () => {
  const order = createStateOrder();
  let current = order.full({ ...full(1), recovering: true, messages: ['saved'] });
  assert.equal(current.recovering, true);
  current = order.execution({ ...delta(2), recovering: false }, current);
  assert.equal(current.recovering, false);
  assert.deepEqual(current.messages, ['saved']);
  current = order.execution(delta(3, 'a', 'running'), current);
  assert.equal(current.recovering, false);
});

test('team roster and task board survive full and incremental state updates', () => {
  const order = createStateOrder();
  const team = {
    revision: 2,
    roster: [{ name: 'lead', role: 'lead', status: 'running', updatedAt: 1 },
      { name: 'reviewer', role: 'teammate', status: 'inactive', description: 'Review', updatedAt: 2 }],
    tasks: [{ id: 'task-1', revision: 1, subject: 'Review', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }]
  };
  let current = order.full({ ...full(1), execution: { status: 'running', team } });
  assert.deepEqual(current.execution.team, team);
  const next = { revision: 3, roster: [{ name: 'reviewer', role: 'teammate', status: 'running' }], tasks: [] };
  current = order.execution({ ...delta(2), execution: { status: 'running', team: next } }, current);
  assert.equal(current.execution.team.revision, 3);
  assert.equal(current.execution.team.roster[0].status, 'running');
});

test('partial execution ticks merge over the last heavy projection', () => {
  const order = createStateOrder();
  const blackboard = { revision: 4, nodes: [{ id: 'root' }] };
  const graph = { revision: 4, stats: { nodes: 1 } };
  let current = order.full({ ...full(1), execution: { status: 'running', blackboard, graph, agenda: { items: [{ id: 'a' }], lastUpdated: 1 } } });
  current = order.execution({ ...delta(2), partialExecution: true, execution: { status: 'running', parts: [{ id: 'p', type: 'text', text: 'live' }] } }, current);
  assert.equal(current.execution.blackboard.revision, 4, 'board survives a partial tick');
  assert.equal(current.execution.graph.stats.nodes, 1, 'graph survives a partial tick');
  assert.equal(current.execution.agenda.items.length, 1, 'agenda survives a partial tick');
  assert.equal(current.execution.parts[0].text, 'live');
  current = order.execution({ ...delta(3), partialExecution: true, execution: { status: 'running', blackboard: { ...blackboard, revision: 5 } } }, current);
  assert.equal(current.execution.blackboard.revision, 5, 'a new heavy projection replaces the old one');
});

test('independently omitted heavy projections are treated as unchanged on live ticks', () => {
  const order = createStateOrder();
  const blackboard = { revision: 4, nodes: [{ id: 'root' }] };
  const memory = { revision: 3, notes: [{ id: 'n1', content: 'keep' }], domainInventory: { seedRoots: ['a.test'], revision: 1, domains: [{ hostname: 'a.test' }] } };
  const graph = { revision: 4, nodes: 1 };
  const agenda = { items: [{ id: 'agenda-1' }], lastUpdated: 1 };
  const logHistory = [{ id: 'round-1' }];
  let current = order.full({ ...full(1), execution: { status: 'running', blackboard, memory, graph, agenda, logHistory } });
  // The host deletes each unchanged projection independently: a new board tick
  // can omit unchanged memory, and a new memory tick can omit unchanged board.
  current = order.execution({ ...delta(2), execution: { status: 'running', blackboard: { ...blackboard, revision: 5 } } }, current);
  assert.equal(current.execution.blackboard.revision, 5, 'a new board still replaces the old one');
  assert.deepEqual(current.execution.memory, memory, 'omitted unchanged memory must not be blanked');
  assert.deepEqual(current.execution.graph, graph);
  assert.deepEqual(current.execution.agenda, agenda);
  assert.deepEqual(current.execution.logHistory, logHistory);
  current = order.execution({ ...delta(3), execution: { status: 'running', memory: { ...memory, revision: 4 } } }, current);
  assert.equal(current.execution.memory.revision, 4, 'a new memory projection still replaces the old one');
  assert.equal(current.execution.blackboard.revision, 5, 'omitted unchanged board must not be blanked');
  // A genuinely empty projection is sent explicitly and must replace the old one.
  current = order.execution({ ...delta(4), execution: { status: 'running', memory: { revision: 5, notes: [], domainInventory: null } } }, current);
  assert.deepEqual(current.execution.memory.notes, []);
  assert.equal(current.execution.blackboard.revision, 5);
});

test('malformed team payloads are downgraded or dropped instead of breaking the view', () => {
  const order = createStateOrder();
  let current = order.full(full(1));
  current = order.execution({ ...delta(2), execution: { status: 'running', team: { roster: {}, tasks: 'x' } } }, current);
  assert.deepEqual(current.execution.team, { roster: [], tasks: [] });
  current = order.execution({ ...delta(3), execution: { status: 'running', team: 'team' } }, current);
  assert.equal('team' in current.execution, false);
  assert.doesNotThrow(() => order.full({ ...full(4), execution: { status: 'running', team: { roster: 5 } } }, current));
});

test('team member watch payload survives execution updates and malformed parts are downgraded', () => {
  const order = createStateOrder();
  const teamWatch = {
    name: 'reviewer', role: 'teammate', status: 'running', running: true,
    history: { entries: [{ id: 'team:user:0', role: 'user', text: 'Team message from lead:\nreview' }], omitted: 0 },
    live: { parts: [{ id: 'text:1', type: 'text', text: 'working', status: 'streaming' }], streamText: 'working' }
  };
  let current = order.full({ ...full(1), execution: { status: 'running', teamWatch } });
  assert.deepEqual(current.execution.teamWatch, teamWatch);
  current = order.execution({ ...delta(2), execution: { status: 'running', teamWatch: { ...teamWatch, status: 'inactive', running: false } } }, current);
  assert.equal(current.execution.teamWatch.running, false);
  current = order.execution({ ...delta(3), execution: { status: 'running', teamWatch: { name: 'reviewer', history: { entries: {} }, live: { parts: 'x' } } } }, current);
  assert.deepEqual(current.execution.teamWatch.history.entries, []);
  assert.deepEqual(current.execution.teamWatch.live.parts, []);
  current = order.execution({ ...delta(4), execution: { status: 'running', teamWatch: 'reviewer' } }, current);
  assert.equal('teamWatch' in current.execution, false);
});


