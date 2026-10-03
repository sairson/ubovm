'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createSessions, inputMessageId, inputMessageIds } = require('../../../harness/session/sessions.cjs');
const source = readFileSync(require.resolve('../../../extension.cjs'), 'utf8');

async function fixture() {
  let saved, busy = false, status = 'idle', failSave = false, failStart = false;
  const starts = [];
  const vscode = { EventEmitter: class { event() {} fire() {} dispose() {} } };
  const context = { workspaceState: { get: () => undefined, update: async (_, value) => {
    if (failSave) { failSave = false; throw Error('disk failed'); } saved = structuredClone(value);
  } } };
  const sessions = createSessions(vscode, context, undefined, { isBusy: () => busy }); await sessions.ready;
  const id = sessions.current().id;
  const sandbox = { sessions, inputMessageId, inputMessageIds, randomUUID, setTimeout, Date, vscode: { window: { showErrorMessage() {} } }, stoppedInputQueues: new Set(), scheduledInputQueues: new Set(), shuttingDown: false, messageQueue: Promise.resolve(),
    errorText: error => error.message, output: { appendLine() {} }, publishState() {},
    assertCurrentSession: expected => assert.equal(expected, sessions.current().id),
    assertCanRun: () => { if (busy) throw Error('busy'); },
    executionContext: async () => ({ content: 'captured attachment' }), restoreExecution: async () => {},
    harness: { isBusy: () => busy, state: () => ({ status, canSteer: busy, runId: 'run-one' }),
      start: async value => { if (failStart) throw Error('start failed'); starts.push(value); busy = true; status = 'running'; },
      cancel: () => { setTimeout(() => { busy = false; status = 'interrupted'; }, 10); } },
    updateSession: (_, mutation) => {
      const task = sandbox.messageQueue.then(mutation); sandbox.messageQueue = task.catch(() => {}); return task;
    } };
  runInNewContext(source.slice(source.indexOf('  function submitPrompt('), source.indexOf('  function runGoal(')), sandbox);
  return { sessions, id, starts, sandbox, saved: () => saved, failSave: () => { failSave = true; }, failStart: () => { failStart = true; },
    finish: (value = 'completed') => { busy = false; status = value; }, send: text => sandbox.submitPrompt(text, id, 'manual') };
}

test('steering consumes only the selected input and preserves context without starting another turn', async () => {
  const f = await fixture(); await f.send('first'); await f.send('second'); await f.send('direction');
  const item = f.sessions.current().inputQueue[1];
  const received = [];
  f.sandbox.harness.steer = async (id, input) => { received.push({ sessionId: id, ...input }); return true; };
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id });
  assert.equal(received[0].text, 'direction');
  assert.equal(received[0].context.content, 'captured attachment');
  assert.equal(received[0].sessionId, f.id);
  assert.equal(received[0].id, item.id);
  assert.deepEqual(f.sessions.current().inputQueue.map(item => item.text), ['second']);
  assert.equal(f.sessions.current().messages.filter(message => message.id === item.id).length, 1);
  assert.equal(f.sessions.current().messages.find(message => message.id === item.id).steeringStatus, 'accepted');
  assert.equal(f.starts.length, 1);
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /已开始/);
});

test('a finishing agent rejects steering and restores a paused input without automatic replay', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = async () => { f.finish(); return false; };
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /已保留/);
  assert.equal(f.sessions.current().inputQueue[0].id, item.id);
  assert.equal(f.sessions.current().queuePaused, true);
  await f.sandbox.drainInputs(f.id);
  assert.equal(f.starts.length, 1);
});

test('steering persistence failures never reach the running agent', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = () => assert.fail('must not steer before saving');
  f.failSave();
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /disk/);
  assert.equal(f.sessions.current().inputQueue[0].id, item.id);
});

test('an ambiguous steering acknowledgement preserves history and pauses without replay', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction'); await f.send('later');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = async () => { throw Error('connection lost'); };
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /无法确认/);
  assert.equal(f.sessions.current().queuePaused, true);
  assert.deepEqual(f.sessions.current().inputQueue.map(input => input.text), ['direction', 'later']);
  assert.equal(f.sessions.current().inputQueue[0].delivery, 'uncertain');
  assert.equal(f.sessions.current().inputQueue[0].context.content, 'captured attachment');
  assert(f.sessions.current().messages.some(message => message.id === item.id));
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'resumeInputs' }), /核实/);
});

test('rejection restores the original queue position and removes only its tentative history', async () => {
  const f = await fixture(); await f.send('first'); await f.send('second'); await f.send('direction');
  const item = f.sessions.current().inputQueue[1];
  f.sandbox.harness.steer = async () => false;
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /已保留/);
  assert.deepEqual(f.sessions.current().inputQueue.map(input => input.text), ['second', 'direction']);
  assert(!f.sessions.current().messages.some(message => message.id === item.id));
});

test('a stale run cannot reserve or deliver an input', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = () => assert.fail('must not reach backend');
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'old-run', inputId: item.id }), /已变化/);
  assert.equal(f.sessions.current().inputQueue[0].delivery, undefined);
  assert(!f.sessions.current().messages.some(message => message.id === item.id));
});

test('explicit backend rejection restores input without leaving an ambiguous reservation', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = async () => { throw Object.assign(Error('limit reached'), { code: 'STEERING_NOT_SENT' }); };
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /limit reached/);
  assert.equal(f.sessions.current().inputQueue[0].delivery, undefined);
  assert.equal(f.sessions.current().queuePaused, true);
  assert(!f.sessions.current().messages.some(message => message.id === item.id));
});

for (const stop of ['shutdown', 'stop']) test(`a ${stop} during steering persistence never reaches the agent`, async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  const begin = f.sessions.beginSteering;
  f.sessions.beginSteering = async (...args) => {
    await begin(...args);
    if (stop === 'shutdown') f.sandbox.shuttingDown = true;
    else f.sandbox.stoppedInputQueues.add(f.id);
  };
  f.sandbox.harness.steer = () => assert.fail('must not inject after stop');
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /已保留/);
  assert.equal(f.sessions.current().inputQueue[0].delivery, undefined);
  assert(!f.sessions.current().messages.some(message => message.id === item.id));
});

test('a failed acknowledgement save retains a non-replayable reservation across reload', async () => {
  const f = await fixture(); await f.send('first'); await f.send('direction');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.harness.steer = async () => { f.failSave(); return true; };
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'steerInput', runId: 'run-one', inputId: item.id }), /disk/);
  assert.equal(f.sessions.current().inputQueue[0].delivery, 'sending');
  f.finish(); await f.sandbox.drainInputs(f.id, true);
  assert.equal(f.starts.length, 1);
  const reopened = createSessions({ EventEmitter: class { event() {} fire() {} dispose() {} } }, {
    workspaceState: { get: key => key === 'conversations' ? f.saved() : undefined, update: async () => {} }
  });
  await reopened.ready;
  assert.equal(reopened.current().inputQueue[0].delivery, 'uncertain');
  assert.equal(reopened.current().messages.find(message => message.id === item.id).steeringStatus, 'uncertain');
  assert.equal(reopened.current().inputQueue[0].context.content, 'captured attachment');
  assert.equal(reopened.current().queuePaused, true);
});

test('busy inputs are persisted FIFO with captured context, and drain one at a time', async () => {
  const f = await fixture();
  await f.send('first'); await f.send('second'); await f.send('third');
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.sessions.current().inputQueue.map(item => item.text), ['second', 'third']);
  assert.equal(f.saved().sessions[0].inputQueue[0].context.content, 'captured attachment');
  f.finish(); f.sandbox.scheduleInputs(f.id); f.sandbox.scheduleInputs(f.id); await f.sandbox.messageQueue;
  assert.deepEqual(f.starts.map(item => item.text), ['first', 'second']);
  assert.equal(f.starts[1].approvalMode, 'manual');
  f.finish('interrupted'); await f.sandbox.drainInputs(f.id);
  assert.equal(f.starts.length, 2);
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'resumeInputs' });
  assert.equal(f.starts[2].text, 'third');
});

test('a lone follow-up during a steerable run is delivered immediately without starting another turn', async () => {
  const f = await fixture();
  await f.send('first');
  const received = [];
  f.sandbox.harness.steer = async (id, input) => { received.push({ sessionId: id, ...input }); return true; };
  await f.send('adjust now');
  assert.equal(received.length, 1);
  assert.equal(received[0].text, 'adjust now');
  assert.equal(received[0].context.content, 'captured attachment');
  assert.equal(f.starts.length, 1);
  assert.equal(f.sessions.current().inputQueue.length, 0);
  const steered = f.sessions.current().messages.find(message => message.text === 'adjust now');
  assert.equal(steered.steeringStatus, 'accepted');
});

test('follow-ups join the queue when earlier inputs are already waiting', async () => {
  const f = await fixture();
  await f.send('first'); await f.send('queued');
  f.sandbox.harness.steer = async () => assert.fail('must not jump the waiting queue');
  await f.send('also later');
  assert.deepEqual(f.sessions.current().inputQueue.map(item => item.text), ['queued', 'also later']);
  assert.equal(f.starts.length, 1);
});

test('completion bursts share one pending input dispatch per session', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued'); f.finish();
  f.sandbox.scheduleInputs(f.id);
  const scheduled = f.sandbox.messageQueue;
  for (let i = 0; i < 10000; i++) f.sandbox.scheduleInputs(f.id);
  assert.equal(f.sandbox.messageQueue, scheduled, 'duplicate notifications must not create a promise backlog');
  await scheduled;
  assert.equal(f.starts.length, 2);
  assert.equal(f.sandbox.scheduledInputQueues.size, 0);
});

test('completion during dispatch can still schedule the next queued input', async () => {
  const f = await fixture(); await f.send('first'); await f.send('second'); await f.send('third'); f.finish();
  const start = f.sandbox.harness.start;
  f.sandbox.harness.start = async value => {
    await start(value);
    f.finish();
    f.sandbox.scheduleInputs(f.id);
  };
  f.sandbox.scheduleInputs(f.id);
  await f.sandbox.messageQueue;
  await f.sandbox.messageQueue;
  assert.deepEqual(f.starts.map(item => item.text), ['first', 'second', 'third']);
  assert.equal(f.sessions.current().inputQueue.length, 0);
  assert.equal(f.sandbox.scheduledInputQueues.size, 0);
});

test('failed dispatch releases its scheduling marker and allows explicit retry', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued'); f.finish();
  f.failSave(); f.sandbox.scheduleInputs(f.id); await f.sandbox.messageQueue;
  assert.equal(f.sandbox.scheduledInputQueues.size, 0);
  assert.equal(f.sessions.current().queuePaused, true);
  assert.equal(f.sessions.current().inputQueue[0].text, 'queued');
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'resumeInputs' });
  assert.equal(f.starts.length, 2);
});

for (const stage of ['append', 'dequeue']) test(`shutdown during ${stage} keeps queued input without launching more work`, async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued'); f.finish();
  const method = stage === 'append' ? 'appendMessage' : 'updateInputQueue';
  const original = f.sessions[method];
  f.sessions[method] = async (...args) => {
    const result = await original(...args);
    f.sandbox.shuttingDown = true;
    return result;
  };
  await f.sandbox.drainInputs(f.id);
  assert.equal(f.starts.length, 1);
  assert.equal(f.sessions.current().inputQueue[0]?.text, 'queued');
});

test('rewind waits for cancellation, truncates at the selected input and pauses remaining queue', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued');
  const first = f.sessions.current().messages[0];
  await f.sandbox.rewindInput({ sessionId: f.id, messageId: first.id });
  const current = f.sessions.current();
  assert.equal(current.messages.length, 0); assert.equal(current.queuePaused, true);
  assert.equal(current.inputQueue[0].text, 'queued'); assert(current.executionBranch);
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'resumeInputs' });
  assert.equal(f.starts[1].executionBranch, current.executionBranch);
  assert.deepEqual(f.starts[1].messages.map(item => item.text), ['queued']);
});

test('stale or invalid rewind requests cannot stop a running agent or pause its queue', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued');
  await f.sessions.appendMessage(f.id, { id: 'answer', role: 'assistant', text: 'progress' });
  const before = f.sessions.current();
  f.sandbox.harness.cancel = () => assert.fail('invalid rewind must not cancel');
  for (const messageId of ['missing', 'answer', '', undefined, null, 1]) {
    await assert.rejects(async () => f.sandbox.rewindInput({ sessionId: f.id, messageId }), /已不存在/);
    assert.deepEqual(f.sessions.current(), before);
    assert.equal(f.sandbox.stoppedInputQueues.has(f.id), false);
    assert.equal(f.sandbox.harness.isBusy(f.id), true);
  }
});

test('rewind rechecks its target after waiting for an earlier operation', async () => {
  const f = await fixture(); await f.send('first');
  const messageId = f.sessions.current().messages[0].id;
  let release;
  f.sandbox.messageQueue = new Promise(resolve => { release = resolve; });
  const waiting = f.sandbox.rewindInput({ sessionId: f.id, messageId });
  await f.sessions.saveMessages([]);
  f.sandbox.harness.cancel = () => assert.fail('removed target must not cancel');
  const before = f.sessions.current();
  release();
  await assert.rejects(waiting, /已不存在/);
  assert.deepEqual(f.sessions.current(), before);
  assert.equal(f.sandbox.harness.isBusy(f.id), true);
});

test('host rewind accepts legacy user message ids', async () => {
  const f = await fixture();
  await f.sessions.saveMessages([{ role: 'user', text: 'legacy' }, { role: 'assistant', text: 'reply' }]);
  await f.sandbox.rewindInput({ sessionId: f.id, messageId: inputMessageId(f.sessions.current().messages, 0) });
  assert.equal(f.sessions.current().messages.length, 0);
});

test('queue removal rejects stale entries and failed persistence retains input', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued');
  const item = f.sessions.current().inputQueue[0];
  f.failSave(); await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id }), /disk/);
  assert.equal(f.sessions.current().inputQueue.length, 1);
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id });
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id }), /已开始/);
});

test('a stop arriving during dispatch persistence prevents the next agent from launching', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued'); f.finish();
  const append = f.sessions.appendMessage;
  f.sessions.appendMessage = async (...args) => {
    await append(...args);
    f.sandbox.stoppedInputQueues.add(f.id);
  };
  await f.sandbox.drainInputs(f.id);
  assert.equal(f.starts.length, 1);
  assert.equal(f.sessions.current().inputQueue[0].text, 'queued');
});

test('a launch failure does not replay an ambiguously accepted input', async () => {
  const f = await fixture(); f.failStart(); await f.send('recover me');
  assert.equal(f.sessions.current().inputQueue.length, 0);
  assert.equal(f.sessions.current().messages[0].text, 'recover me');
  assert.equal(f.sessions.current().queuePaused, true);
});

test('legacy inputs can rewind without changing stored message format', async () => {
  const f = await fixture(); await f.sessions.saveMessages([{ role: 'user', text: 'legacy' }, { role: 'assistant', text: 'answer' }]);
  const messageId = inputMessageId(f.sessions.current().messages, 0);
  f.failSave(); await assert.rejects(f.sessions.rewindInput(f.id, messageId), /disk/);
  assert.equal(f.sessions.current().messages.length, 2);
  await f.sessions.rewindInput(f.id, messageId); assert.equal(f.sessions.current().messages.length, 0);
});

test('reload preserves queued input and execution branch but pauses automatic sending', async () => {
  const f = await fixture(); await f.send('first'); await f.send('queued');
  await f.sandbox.rewindInput({ sessionId: f.id, messageId: f.sessions.current().messages[0].id });
  const saved = f.saved();
  saved.sessions[0].queuePaused = false;
  const reopened = createSessions({ EventEmitter: class { event() {} fire() {} dispose() {} } }, {
    workspaceState: { get: key => key === 'conversations' ? saved : undefined, update: async () => {} }
  }); await reopened.ready;
  assert.equal(reopened.current().queuePaused, true);
  assert.equal(reopened.current().executionBranch, f.sessions.current().executionBranch);
  assert.equal(reopened.current().inputQueue[0].text, 'queued');
});
