'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createSessions, inputMessageId, inputMessageIds } = require('../../../harness/session/sessions.cjs');
const source = readFileSync(require.resolve('../../../extension.cjs'), 'utf8');

async function fixture() {
  let saved, busy = false, status = 'idle', failSave = false, failStart = false;
  const starts = [];
  const warnings = [];
  const fileContexts = new Map();
  const pendingImages = new Map();
  const vscode = { EventEmitter: class { event() {} fire() {} dispose() {} } };
  const context = { workspaceState: { get: () => undefined, update: async (_, value) => {
    if (failSave) { failSave = false; throw Error('disk failed'); } saved = structuredClone(value);
  } } };
  const sessions = createSessions(vscode, context, undefined, { isBusy: () => busy }); await sessions.ready;
  const id = sessions.current().id;
  const sandbox = { sessions, inputMessageId, inputMessageIds, randomUUID, setTimeout, Date, path, structuredClone,
    pendingImages, fileContexts, vscode: { window: { showErrorMessage() {}, showWarningMessage(message) { warnings.push(String(message)); } } }, stoppedInputQueues: new Set(), scheduledInputQueues: new Set(), steeringSchedules: new Set(), shuttingDown: false, messageQueue: Promise.resolve(),
    errorText: error => error.message, output: { appendLine() {} }, publishState() {},
    assertCurrentSession: expected => assert.equal(expected, sessions.current().id),
    assertCanRun: () => { if (busy) throw Error('busy'); },
    executionContext: async () => ({ content: 'captured attachment' }), restoreExecution: async () => {},
    markFullAccess: () => {}, openAssistant: async () => {},
    harness: { isBusy: () => busy, state: () => ({ status, canSteer: busy, runId: 'run-one' }),
      start: async value => { if (failStart) throw Error('start failed'); starts.push(value); busy = true; status = 'running'; },
      cancel: () => { setTimeout(() => { busy = false; status = 'interrupted'; }, 10); } },
    updateSession: (_, mutation) => {
      const task = sandbox.messageQueue.then(mutation); sandbox.messageQueue = task.catch(() => {}); return task;
    } };
  runInNewContext(source.slice(source.indexOf('  function submitPrompt('), source.indexOf('  function runGoal(')), sandbox);
  return { sessions, id, starts, warnings, sandbox, fileContexts, pendingImages, saved: () => saved, failSave: () => { failSave = true; }, failStart: () => { failStart = true; },
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

test('waiting inputs are steered in FIFO order once the run can steer', async () => {
  const f = await fixture();
  await f.send('first');
  await f.send('queued');
  const received = [];
  f.sandbox.harness.steer = async (id, input) => { received.push({ sessionId: id, ...input }); return true; };
  await f.send('also later');
  assert.deepEqual(received.map(item => item.text), ['queued', 'also later']);
  assert.equal(received[0].context.content, 'captured attachment');
  assert.equal(f.starts.length, 1, 'steering must not start another turn');
  assert.equal(f.sessions.current().inputQueue.length, 0);
});

test('an input queued before steering was ready is delivered at the next steerable transition', async () => {
  const f = await fixture();
  await f.send('first');
  await f.send('early');
  const received = [];
  f.sandbox.harness.steer = async (id, input) => { received.push({ sessionId: id, ...input }); return true; };
  f.sandbox.scheduleSteer(f.id);
  await f.sandbox.messageQueue;
  assert.deepEqual(received.map(item => item.text), ['early']);
  assert.equal(f.starts.length, 1);
  assert.equal(f.sessions.current().inputQueue.length, 0);
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
  for (let index = 0; index < 6; index++) await f.sandbox.messageQueue;
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
  assert.equal(f.sessions.current().inputQueue[0].text, 'recover me');
  assert.equal(f.sessions.current().inputQueue[0].delivery, 'sending');
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

test('published queue projection carries bounded metadata and never context content', async () => {
  const f = await fixture();
  // Normalize the vm-realm result into this realm for strict comparison.
  const projected = JSON.parse(JSON.stringify(f.sandbox.publishedInputQueue({ inputQueue: [
    { id: 'full', text: '带图输入', approvalMode: 'manual', modelId: 'deepseek-chat', delivery: 'uncertain',
      images: [{ id: 'img-a', path: '/attachments/a.png' }, { id: 'img-b', path: '/attachments/b.png' }],
      context: { workspace: 'ws', file: '/ws/src/app.ts', content: 'secret snapshot body' },
      contextMeta: { label: 'src/app.ts', kind: 'selection', range: 'L10–12' } },
    { id: 'plain', text: '只有文本' }
  ] })));
  assert.deepEqual(projected, [
    { id: 'full', text: '带图输入', delivery: 'uncertain', modelId: 'deepseek-chat', imageCount: 2, approvalMode: 'manual',
      context: { label: 'src/app.ts', kind: 'selection', range: 'L10–12' } },
    { id: 'plain', text: '只有文本' }
  ]);
  assert.deepEqual(Object.keys(projected[1]), ['id', 'text'], 'absent metadata must be omitted instead of published as undefined');
  assert.equal('context' in projected[1], false);
  assert.equal(JSON.stringify(projected).includes('secret snapshot body'), false, 'context content must never reach the webview');
  assert.deepEqual(JSON.parse(JSON.stringify(f.sandbox.publishedInputQueue(undefined))), []);
});

test('enqueue captures bounded, content-free metadata for selection, file, active and empty context', async () => {
  const f = await fixture();
  await f.send('first');
  const longLabel = 'src/' + 'nested/'.repeat(30) + 'selection.ts';
  const longRange = 'L' + '1'.repeat(100);
  f.sandbox.fileContexts.set(f.id, { kind: 'selection', label: longLabel, path: '/ws/selection.ts', rangeLabel: longRange,
    snapshot: { file: '/ws/selection.ts', content: 'selected code body' } });
  await f.send('second');
  f.sandbox.fileContexts.set(f.id, { label: 'notes.md', path: '/ws/notes.md' });
  await f.send('third');
  f.sandbox.fileContexts.delete(f.id);
  f.sandbox.executionContext = async () => ({ workspace: 'ws', file: '/ws/src/active.ts', content: 'active body' });
  await f.send('fourth');
  f.sandbox.executionContext = async () => ({ content: 'captured attachment' });
  await f.send('fifth');
  const queue = f.sessions.current().inputQueue;
  assert.deepEqual(queue.map(item => item.text), ['second', 'third', 'fourth', 'fifth']);
  const selection = queue[0].contextMeta;
  assert.equal(selection.kind, 'selection');
  assert(selection.label.length <= 120, 'labels stay bounded to 120 chars');
  assert(selection.label.endsWith('…'));
  assert(selection.label.startsWith('src/nested/'));
  assert(selection.range.length <= 80, 'ranges stay bounded to 80 chars');
  assert(selection.range.endsWith('…'));
  assert.equal(JSON.stringify(selection).includes('selected code body'), false, 'metadata must not embed file contents');
  assert.deepEqual(Object.keys(selection).sort(), ['kind', 'label', 'range']);
  assert.deepEqual(queue[1].contextMeta, { label: 'notes.md', kind: 'file' });
  assert.deepEqual(queue[2].contextMeta, { label: 'active.ts', kind: 'active' });
  assert.equal(queue[3].contextMeta, undefined);
  // The bounded metadata survives persistence alongside the full snapshot.
  assert.equal(f.saved().sessions[0].inputQueue[0].contextMeta.kind, 'selection');
  // Recall of an implicit active-editor row restores it as an explicit snapshot.
  const active = queue[2];
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: active.id });
  const restored = structuredClone(f.sandbox.fileContexts.get(f.id));
  assert.deepEqual(restored, { kind: 'file-drop', label: 'active.ts', path: '/ws/src/active.ts',
    snapshot: { workspace: 'ws', file: '/ws/src/active.ts', content: 'active body' } });
});

test('recall restores queued images and the captured context snapshot for the next send', async () => {
  const f = await fixture();
  const capturedContext = { workspace: 'ws', file: '/ws/src/app.ts', content: 'snapshot body', unsaved: true };
  f.sandbox.executionContext = async () => ({ ...capturedContext });
  await f.send('first');
  f.sandbox.pendingImages.set(f.id, [{ id: 'img-queued', path: '/attachments/queued.png' }, { id: 'img-other', path: '/attachments/other.png' }]);
  f.sandbox.fileContexts.set(f.id, { kind: 'selection', label: 'src/app.ts', path: '/ws/src/app.ts', rangeLabel: 'L3–5',
    snapshot: { file: '/ws/src/app.ts', content: 'selected body' } });
  await f.send('recall me');
  const captured = f.sessions.current().inputQueue[0];
  assert.equal(f.pendingImages.get(f.id), undefined, 'enqueue consumes pending images');
  assert.deepEqual(captured.images.map(image => image.id), ['img-queued', 'img-other']);
  assert.deepEqual(captured.context, capturedContext);
  assert.deepEqual(captured.contextMeta, { label: 'src/app.ts', kind: 'selection', range: 'L3–5' });
  // Images the user attached after the input was queued must survive and stay first.
  f.pendingImages.set(f.id, [{ id: 'img-other', path: '/attachments/other.png' }, { id: 'img-new', path: '/attachments/new.png' }]);
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: captured.id });
  assert.equal(f.sessions.current().inputQueue.length, 0);
  assert.deepEqual(structuredClone(f.pendingImages.get(f.id)).map(image => image.id), ['img-other', 'img-new', 'img-queued']);
  assert.deepEqual(structuredClone(f.sandbox.fileContexts.get(f.id)), {
    kind: 'selection', label: 'src/app.ts', path: '/ws/src/app.ts', rangeLabel: 'L3–5', snapshot: capturedContext
  });
  assert.equal(f.starts.length, 1, 'recall never replays the input');
  // The next send through executionContext() reuses the snapshot and restored images.
  f.sandbox.executionContext = async () => {
    const attached = f.fileContexts.get(f.id);
    if (attached?.kind === 'selection' || attached?.kind === 'file-drop') return { workspace: 'ws', ...structuredClone(attached.snapshot) };
    return { workspace: 'ws', content: 'reread from disk' };
  };
  await f.send('send again');
  const resent = f.sessions.current().inputQueue[0];
  assert.deepEqual(resent.context, capturedContext, 'resubmit reuses the captured snapshot instead of re-reading the file');
  assert.deepEqual(resent.contextMeta, { label: 'src/app.ts', kind: 'selection', range: 'L3–5' });
  assert.deepEqual(resent.images.map(image => image.id), ['img-other', 'img-new', 'img-queued']);
});

test('recall replaces a different composer context and tells the operator once', async () => {
  const f = await fixture();
  const capturedContext = { workspace: 'ws', file: '/ws/src/queued.ts', content: 'queued body' };
  f.sandbox.executionContext = async () => ({ ...capturedContext });
  await f.send('first');
  f.sandbox.fileContexts.set(f.id, { kind: 'selection', label: 'queued.ts', path: '/ws/src/queued.ts', rangeLabel: 'L1–2',
    snapshot: { file: '/ws/src/queued.ts', content: 'queued body' } });
  await f.send('queued with context');
  const item = f.sessions.current().inputQueue[0];
  assert.equal(item.contextMeta.label, 'queued.ts');
  // The user attaches a different context while the recalled row waits.
  f.sandbox.fileContexts.set(f.id, { label: 'newer.md', path: '/ws/newer.md' });
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id });
  assert.deepEqual(structuredClone(f.sandbox.fileContexts.get(f.id)), {
    kind: 'selection', label: 'queued.ts', path: '/ws/src/queued.ts', rangeLabel: 'L1–2', snapshot: capturedContext
  });
  assert.equal(f.warnings.length, 1, 'replacing a different context must be announced once');
  assert.match(f.warnings[0], /替换.*上下文/);
});

test('recall of a plain text row leaves composer attachments untouched', async () => {
  const f = await fixture();
  await f.send('first'); await f.send('plain queued');
  const item = f.sessions.current().inputQueue[0];
  assert.equal(item.contextMeta, undefined);
  assert.equal(item.images, undefined);
  const descriptor = { label: 'keep.md', path: '/ws/keep.md' };
  f.sandbox.fileContexts.set(f.id, descriptor);
  f.pendingImages.set(f.id, [{ id: 'keep-image', path: '/attachments/keep.png' }]);
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id });
  assert.equal(f.fileContexts.get(f.id), descriptor, 'recall must not replace an unrelated composer chip');
  assert.deepEqual(structuredClone(f.pendingImages.get(f.id)).map(image => image.id), ['keep-image']);
});

test('failed queue removal never restores attachments into the composer', async () => {
  const f = await fixture();
  await f.send('first');
  f.sandbox.pendingImages.set(f.id, [{ id: 'img-held', path: '/attachments/held.png' }]);
  f.sandbox.fileContexts.set(f.id, { kind: 'selection', label: 'src/held.ts', path: '/ws/held.ts', rangeLabel: 'L1',
    snapshot: { file: '/ws/held.ts', content: 'held body' } });
  await f.send('queued with attachments');
  const item = f.sessions.current().inputQueue[0];
  f.sandbox.pendingImages.delete(f.id);
  f.sandbox.fileContexts.delete(f.id);
  f.failSave();
  await assert.rejects(f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id }), /disk/);
  assert.equal(f.sessions.current().inputQueue.length, 1, 'failed save keeps the queued row');
  assert.equal(f.pendingImages.get(f.id), undefined, 'failed save must not restore images');
  assert.equal(f.fileContexts.get(f.id), undefined, 'failed save must not restore the context chip');
});

test('recall of a delivery-uncertain row still restores its attachments without replay', async () => {
  const f = await fixture();
  await f.send('first');
  f.sandbox.pendingImages.set(f.id, [{ id: 'img-uncertain', path: '/attachments/uncertain.png' }]);
  await f.send('queued image');
  const item = f.sessions.current().inputQueue[0];
  await f.sessions.updateInputQueue(f.id, current => ({ inputQueue: current.inputQueue.map(input => input.id === item.id ? { ...input, delivery: 'uncertain' } : input) }));
  await f.sandbox.changeInputQueue({ sessionId: f.id, action: 'removeInput', inputId: item.id });
  assert.equal(f.sessions.current().inputQueue.length, 0);
  assert.deepEqual(structuredClone(f.sandbox.pendingImages.get(f.id)).map(image => image.id), ['img-uncertain']);
  assert.equal(f.starts.length, 1, 'recall of an uncertain delivery must not replay it');
});


