'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHarnessService } = require('../harness/harness-service.cjs');
const { cleanTimelineParts } = require('../harness/sessions.cjs');

async function fixture(t, mode = 'assist', initialFacts = '', configuration = {}, approvalMode) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'ubovm-streaming-'));
  let service;
  t.after(async () => {
    await service?.close();
    const relative = path.relative(parent, directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'ide'));
  await mkdir(path.join(directory, 'agents/collaboration'), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'index.mjs'), `
      export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../harness/blackboard/database/database.mjs')).href)};
      export async function createHarness(options) {
        const board = { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
        const memory = { notes: [] };
        return { snapshot: () => board, memory: () => structuredClone(memory), middlewareStatus: () => ({}), close: async () => {},
          addFact: async fact => { board.nodes.push({ id: 'fact', kind: 'fact', parentIds: fact.parentIds, childIds: [], fact, attempts: [] }); board.revision++; },
          run: ({ signal }) => options.fixture({ ...options, signal, memory, route: 'goal' }) };
      }`),
    writeFile(path.join(directory, 'agents/collaboration/index.mjs'), "export const runCollaboration = options => options.configuration.fixture({ ...options, route: 'collaboration' });"),
    writeFile(path.join(directory, 'ide/workspace-tools.mjs'), 'export const createWorkspaceTools = async () => [];')
  ]);
  let started, complete, finished, observedBusy = false;
  const ready = new Promise(resolve => { started = resolve; });
  const completion = new Promise(resolve => { finished = resolve; });
  const delivered = [];
  service = createHarnessService({
    workspaceRoots: id => { assert.equal(id, 'current'); return [directory]; },
    additionalTools: conversationId => [{ name: 'fixture_coding_tool', conversationId }],
    sdkPath: path.join(directory, 'index.mjs'), storageDirectory: path.join(directory, 'storage'),
    readConfiguration: async () => ({ ...configuration, fixture: options => new Promise((resolve, reject) => {
      complete = resolve;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started(options);
    }) }),
    onMessage: async (_, message) => delivered.push(message),
    onChange: id => { if (service.isBusy(id)) observedBusy = true; else if (observedBusy) finished(); }
  });
  await service.start({ conversationId: 'current', mode, approvalMode, text: 'fixture', messages: [], ...(mode === 'goal' ? { goal: { objective: 'Verify the goal route', initialFacts } } : {}) });
  const running = await ready;
  if (mode === 'goal') assert.equal(running.intools.localShell.cwd, directory);
  else {
    assert.deepEqual(running.workspaceRoots, [directory]);
    assert.equal(running.configuration.intools.localShell.cwd, directory);
  }
  const suppliedTools = mode === 'goal' ? running.tools : await running.configuration.tools({ workerId: 'test' });
  assert(suppliedTools.some(tool => tool.name === 'fixture_coding_tool' && tool.conversationId === 'current'), 'Coding tools must be bound to the originating conversation in both execution modes');
  return { service, directory, running, memory: running.memory, route: running.route, event: running.onEvent, delivered, completion, complete: text => complete(text) };
}

test('goal notes refresh before the running worker returns', async t => {
  const f = await fixture(t, 'goal');
  f.memory.notes.push({ id: 'live-note', content: 'Saved during execution' });
  f.event({ type: 'memory.changed', revision: 1 });
  assert.equal(f.service.isBusy('current'), true);
  assert.equal(f.service.state('current').memory.notes[0].content, 'Saved during execution');
  f.memory.notes[0].content = 'Updated during execution';
  f.event({ type: 'memory.changed', revision: 2 });
  assert.equal(f.service.state('current').memory.notes[0].content, 'Updated during execution');
  f.complete({ complete: true, revision: 1, summary: 'goal verified' });
  await f.completion;
});

test('initial facts enter the blackboard separately from the desired goal', async t => {
  const f = await fixture(t, 'goal', '现有桌面框架\n数据保存在本地');
  const board = f.service.state('current').blackboard;
  const runtime = f.service.runtimeSummary('current');
  assert.equal(runtime.busy, true);
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.workerCount, f.service.state('current').workers.length);
  assert.equal(Object.hasOwn(runtime, 'blackboard'), false, 'background status does not copy the board');
  assert.equal(Object.hasOwn(runtime, 'parts'), false, 'background status does not copy the transcript');
  assert.equal(board.goal, 'Verify the goal route');
  assert.ok(board.nodes.some(node => node.fact?.content.includes('现有桌面框架\n数据保存在本地')));
  f.complete({ complete: true, revision: board.revision, summary: 'Done' });
  await f.completion;
  assert.equal(f.service.runtimeSummary('current').busy, false);
});

test('removal rejects running sessions and clears only the deleted conversation storage after completion', async t => {
  const f = await fixture(t, 'goal');
  const { access, readFile } = require('node:fs/promises');
  const { createHash } = require('node:crypto');
  const key = id => createHash('sha256').update(id).digest('hex').slice(0, 32);
  const removed = path.join(f.directory, 'storage', key('current'));
  const retained = path.join(f.directory, 'storage', key('other'));
  await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, 'retain.txt'), 'untouched');
  await assert.rejects(f.service.remove('current'), { code: 'SESSION_BUSY' });
  await assert.rejects(f.service.releaseWorkspace('current'), { code: 'SESSION_BUSY' });
  await access(removed);
  f.complete({ complete: true, revision: 1, summary: 'Done' }); await f.completion;
  await f.service.remove('current');
  await assert.rejects(access(removed), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(retained, 'retain.txt'), 'utf8'), 'untouched');
  assert.equal(f.service.state('current').status, 'idle');
  assert.equal(f.service.state('current').canResume, false);
});

test('stream bursts project the latest text once while keeping snapshots detached and redacted', async t => {
  const f = await fixture(t);
  assert.equal(f.service.isBusy('current'), true);
  assert.equal(f.service.isBusy('missing'), false);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  let contentReads = 0, latest = '';
  const message = { role: 'assistant', get content() { contentReads++; return [{ type: 'text', text: latest }]; } };
  for (let index = 0; index < 1000; index++) {
    latest = `chunk ${index} api_key=supersecret`;
    f.event({ type: 'message_update', message });
  }
  assert.equal(contentReads, 0, 'unobserved token updates do not repeatedly traverse message contents');
  const snapshot = f.service.state('current');
  assert(contentReads > 0 && contentReads < 10, 'only the last token snapshot is projected');
  assert.match(snapshot.parts[0].text, /chunk 999/);
  assert(!JSON.stringify(snapshot).includes('supersecret'));
  snapshot.parts[0].text = 'tampered';
  snapshot.activities.push({ label: 'tampered' });
  snapshot.workers.push({ id: 'tampered' });
  const clean = f.service.state('current');
  assert.match(clean.parts[0].text, /chunk 999/);
  assert.equal(clean.activities.length, 0);
  assert.equal(clean.workers.length, 0);
  f.complete('finished');
  await f.completion;
  assert.equal(f.service.isBusy('current'), false);
  assert.equal(f.delivered[0].text, 'finished');
});

test('deferred text preserves ordering across tools and commits the final answer once', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'before tool' } });
  f.event({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-1', args: { path: 'fixture.txt' } });
  f.event({ type: 'tool_execution_end', toolName: 'read_file', toolCallId: 'tool-1', result: 'file text' });
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'stale partial' } });
  f.event({ type: 'message_end', message: { role: 'assistant', content: 'final answer' } });
  f.complete('final answer');
  await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text', 'tool', 'text']);
  assert.deepEqual(f.delivered[0].parts.filter(part => part.type === 'text').map(part => part.text), ['before tool', 'final answer']);
  assert.equal(f.delivered[0].parts[1].status, 'completed');
});

test('cancellation retains the latest unpublished partial text', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'last visible progress' } });
  f.service.cancel('current');
  await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted');
  assert.equal(state.busy, false);
  assert.equal(state.parts[0].text, 'last visible progress');
  assert.equal(f.delivered.length, 0);
});

test('collaboration worker events expose status and tools without replacing the root chat response', async t => {
  const f = await fixture(t);
  assert.equal(f.route, 'collaboration');
  assert.equal(f.service.state('current').phase, 'chat');
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_update', message: { role: 'assistant', content: 'root progress' } });
  f.event({ type: 'swarm.status', workers: [{ id: 'worker-1', parentId: 'root', task: 'Inspect a file', depth: 1, status: 'running' }] });
  const workerEvent = event => f.event({ type: 'swarm.worker.event', workerId: 'worker-1', parentId: 'root', event });
  workerEvent({ type: 'message_start', message: { role: 'assistant' } });
  workerEvent({ type: 'message_update', message: { role: 'assistant', content: 'private worker response' } });
  workerEvent({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-1', args: { path: 'fixture.txt' } });
  workerEvent({ type: 'tool_execution_end', toolName: 'read_file', toolCallId: 'tool-1', result: 'worker evidence' });
  workerEvent({ type: 'message_end', message: { role: 'assistant', content: 'private worker response' } });
  const working = f.service.state('current');
  assert.equal(working.streamText, 'root progress');
  assert.equal(working.workers[0].description, 'Inspect a file');
  assert.equal(working.workers[0].status, 'running');
  const workerTool = working.workers[0].parts.find(part => part.type === 'tool');
  assert.equal(workerTool.workerId, 'worker-1');
  assert.equal(workerTool.output, 'worker evidence');
  assert(!JSON.stringify(working.parts).includes('private worker response'));
  f.event({ type: 'swarm.status', workers: [{ id: 'worker-1', parentId: 'root', task: 'Inspect a file', depth: 1, status: 'completed' }] });
  f.event({ type: 'message_start', message: { role: 'assistant' } });
  f.event({ type: 'message_end', message: { role: 'assistant', content: 'root final answer' } });
  f.complete('root final answer');
  await f.completion;
  assert.equal(f.service.state('current').workers[0].status, 'completed');
  assert.equal(f.delivered[0].text, 'root final answer');
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text', 'text']);
  assert(!JSON.stringify(f.delivered).includes('private worker response'));
});

test('goal mode continues to use the Reason/Worker harness instead of collaboration Chat', async t => {
  const f = await fixture(t, 'goal');
  assert.equal(f.route, 'goal');
  assert.equal(f.service.state('current').phase, 'reason');
  f.event({ type: 'reason.start' });
  f.event({ type: 'reason.decision' });
  f.complete({ complete: true, revision: 1, summary: 'goal verified' });
  await f.completion;
  assert.equal(f.service.state('current').status, 'completed');
  assert.equal(f.delivered[0].text, 'goal verified');
  assert(f.delivered[0].id.startsWith('goal:'));
});

test('cancellation settles projected queued and waiting collaboration workers', async t => {
  const f = await fixture(t);
  f.event({ type: 'swarm.status', workers: [
    { id: 'parent', parentId: 'root', task: 'Await the nested worker', depth: 1, status: 'waiting' },
    { id: 'child', parentId: 'parent', task: 'Queued nested task', depth: 2, status: 'queued' }
  ] });
  f.service.cancel('current');
  await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted');
  assert(state.workers.every(worker => worker.status === 'interrupted'));
  assert(state.activities.every(item => item.status === 'interrupted'));
});

const assistant = content => ({ role: 'assistant', content });
const thought = thinking => ({ type: 'thinking', thinking, thinkingSignature: 'provider-signature-never-display' });
const thinkingEvent = (type, content, contentIndex = 0) => ({ type: 'message_update', message: assistant(content), assistantMessageEvent: { type, contentIndex } });

test('thinking streams separately, coalesces snapshots and completes before the final answer', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_start', [thought('')]));
  assert.deepEqual(f.service.state('current').parts, [], 'an empty thinking start does not invent display text');
  let reads = 0, latest = '';
  const message = { role: 'assistant', get content() { reads++; return [thought(latest)]; } };
  for (let i = 0; i < 1000; i++) { latest = `Inspect ${i} api_key=thinking-secret`; f.event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: String(i) } }); }
  assert.equal(reads, 0);
  const running = f.service.state('current');
  assert(reads > 0 && reads < 10);
  assert.equal(running.streamText, '');
  assert.equal(running.parts.length, 1);
  assert.equal(running.parts[0].source, 'assistant');
  assert.equal(running.parts[0].status, 'running');
  assert.match(running.parts[0].text, /Inspect 999/);
  assert(!JSON.stringify(running).includes('thinking-secret'));
  assert(!JSON.stringify(running).includes('provider-signature'));
  f.event(thinkingEvent('thinking_end', [thought('Inspect the result.')]));
  const completed = f.service.state('current').parts[0];
  assert.equal(completed.id, running.parts[0].id);
  assert.equal(completed.status, 'completed');
  assert(completed.startedAt > 0 && completed.endedAt >= completed.startedAt);
  const content = [thought('Inspect the result.'), { type: 'text', text: 'Verified answer.' }];
  f.event(thinkingEvent('text_start', content, 1));
  f.event({ type: 'message_end', message: assistant(content) });
  f.complete('Verified answer.'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['thinking', 'text']);
  assert.equal(f.delivered[0].parts[0].endedAt, completed.endedAt);
  assert.equal(f.delivered[0].parts[1].text, f.delivered[0].text);
});

test('redacted provider blocks stay hidden and ordinary think tags remain ordinary prose', async t => {
  const f = await fixture(t);
  const content = [{ ...thought('encrypted-payload-never-display'), redacted: true }, { type: 'thinking', thinkingSignature: 'signature-only-never-display' }, { type: 'redacted_thinking', data: 'raw-secret' }, { type: 'text', text: '<think>ordinary text</think>' }];
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_delta', [thought('temporary plaintext later withdrawn')]));
  assert.equal(f.service.state('current').parts[0].text, 'temporary plaintext later withdrawn');
  f.event(thinkingEvent('thinking_delta', [content[0]]));
  assert.deepEqual(f.service.state('current').parts, []);
  f.event(thinkingEvent('thinking_end', [thought('temporary plaintext later withdrawn')]));
  assert.deepEqual(f.service.state('current').parts, [], 'a later stale snapshot cannot resurrect a redacted block');
  f.event({ type: 'message_end', message: assistant(content) });
  f.complete('<think>ordinary text</think>'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['text']);
  assert.equal(f.delivered[0].parts[0].text, '<think>ordinary text</think>');
  assert(!JSON.stringify(f.delivered).includes('never-display'));
  assert(!JSON.stringify(f.delivered).includes('raw-secret'));
});

test('cancellation retains an unpublished thinking-only response as interrupted', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_start', [thought('')]));
  f.event(thinkingEvent('thinking_delta', [thought('Partial visible reasoning.')]));
  f.service.cancel('current'); await f.completion;
  const state = f.service.state('current');
  assert.equal(state.status, 'interrupted'); assert.equal(state.streamText, '');
  assert.equal(state.parts.length, 1); assert.equal(state.parts[0].type, 'thinking');
  assert.equal(state.parts[0].status, 'interrupted');
  assert(state.parts[0].endedAt >= state.parts[0].startedAt);
  assert.equal(f.delivered.length, 0);
});

test('worker thinking identities and timers do not overwrite root or sibling messages', async t => {
  const f = await fixture(t);
  const worker = (id, event) => f.event({ type: 'swarm.worker.event', workerId: id, event });
  f.event({ type: 'message_start', message: assistant([]) });
  f.event(thinkingEvent('thinking_delta', [thought('Root analysis')]));
  const rootId = f.service.state('current').parts[0].id;
  for (const id of ['one', 'two']) {
    worker(id, { type: 'message_start', message: assistant([]) });
    worker(id, thinkingEvent('thinking_delta', [thought(`Worker ${id}`)]));
  }
  worker('one', thinkingEvent('thinking_end', [thought('Worker one finished')]));
  worker('two', thinkingEvent('thinking_delta', [thought('Worker two still running')]));
  f.event(thinkingEvent('text_start', [thought('Root analysis'), { type: 'text', text: 'Root progress' }], 1));
  const snapshot = f.service.state('current');
  assert.equal(snapshot.parts[0].id, rootId); assert.equal(snapshot.parts[0].status, 'completed');
  const one = snapshot.workers.find(worker => worker.id === 'one').parts[0], two = snapshot.workers.find(worker => worker.id === 'two').parts[0];
  assert.equal(one.workerId, 'one'); assert.equal(one.status, 'completed');
  assert.equal(two.workerId, 'two'); assert.equal(two.status, 'running');
  assert.equal(new Set([...snapshot.parts, one, two].map(part => part.id)).size, snapshot.parts.length + 2);
  assert.equal(snapshot.streamText, 'Root progress');
  worker('two', { type: 'message_end', message: assistant([thought('Worker two still running'), { type: 'text', text: 'private-worker-protocol' }]) });
  f.event({ type: 'message_end', message: assistant([thought('Root analysis'), { type: 'text', text: 'Root final' }]) });
  f.complete('Root final'); await f.completion;
  assert.deepEqual(f.delivered[0].parts.map(part => part.type), ['thinking', 'text']);
  assert.equal(f.delivered[0].parts[0].id, rootId);
  assert(!JSON.stringify(f.delivered).includes('private-worker-protocol'));
});

test('Reason and goal Worker thinking retain sources while protocol JSON stays hidden', async t => {
  const f = await fixture(t, 'goal');
  const reason = event => f.event({ type: 'reason.event', event: { type: 'pi_event', event } });
  const worker = event => f.event({ type: 'worker.event', timestamp: '2026-09-21T08:00:00.000Z', event: { type: 'pi_event', intentId: 'goal-worker', attemptId: 'attempt-1', event } });
  reason({ type: 'message_start', message: assistant([]) });
  reason(thinkingEvent('thinking_delta', [thought('Choose an evidence check.')]));
  worker({ type: 'message_start', message: assistant([]) });
  worker(thinkingEvent('thinking_delta', [thought('Inspect the file.')]));
  reason({ type: 'message_end', message: assistant([thought('Choose an evidence check.'), { type: 'text', text: '{"intents":[]}' }]) });
  worker({ type: 'message_end', message: assistant([thought('Inspect the file.'), { type: 'text', text: '{"steps":[]}' }]) });
  f.complete({ complete: true, revision: 1, summary: 'Goal complete' }); await f.completion;
  const parts = f.delivered[0].parts;
  assert.deepEqual(parts.map(part => part.type), ['thinking', 'text']);
  const workerThinking = f.service.state('current').workers.find(worker => worker.id === 'goal-worker').parts[0];
  assert.equal(parts[0].source, 'reason'); assert.equal(workerThinking.source, 'worker');
  assert.equal(workerThinking.workerId, 'goal-worker'); assert.equal(workerThinking.startedAt, Date.parse('2026-09-21T08:00:00.000Z'));
  assert(!JSON.stringify(parts).includes('intents')); assert(!JSON.stringify(parts).includes('steps'));
  const { readFile, readdir } = require('node:fs/promises');
  const storage = path.join(f.directory, 'storage');
  const conversation = path.join(storage, (await readdir(storage))[0]);
  const goal = path.join(conversation, (await readdir(conversation))[0]);
  const saved = JSON.parse(await readFile(path.join(goal, 'goal-timeline.json'), 'utf8'));
  assert.deepEqual(saved.parts, parts);
  assert(!JSON.stringify(saved).includes('provider-signature'));
});

test('long timelines keep all earlier fragments without an omission placeholder', () => {
  const input = Array.from({ length: 240 }, (_, i) => ({ id: 'part-' + i, type: 'text', text: '记录 ' + i + ' 内容'.repeat(2000), status: 'completed' }));
  const cleaned = cleanTimelineParts(input);
  assert.deepEqual(cleaned, input);
  assert.deepEqual(cleanTimelineParts(JSON.parse(JSON.stringify(cleaned))), input);
});

test('thinking cleaners whitelist plaintext, redact credentials and retain every earlier fragment', () => {
  const thinking = { id: 'thinking', type: 'thinking', source: 'assistant', status: 'completed', text: 'api_key=private-secret\n' + 'analysis '.repeat(5000), startedAt: 100, endedAt: 150, signature: 'signature-secret', thinkingSignature: 'secret-signature', encrypted: 'opaque-secret' };
  const parts = cleanTimelineParts([thinking, { ...thinking, id: 'redacted', redacted: true }, ...Array.from({ length: 10 }, (_, index) => ({ ...thinking, id: `thinking-${index}` })), { id: 'final', type: 'text', text: 'Final '.repeat(12000), status: 'completed' }]);
  assert(parts.every(part => part.type !== 'thinking' || part.text.length <= 12000));
  assert.equal(parts.at(-1).text.length, 64000);
  assert.equal(parts.filter(part => part.type === 'thinking').length, 11);
  assert(parts.filter(part => part.type === 'thinking').every(part => part.text.length === 12000));
  assert(parts.some(part => part.truncated));
  assert(!parts.some(part => part.id === 'redacted'));
  assert(!/private-secret|signature-secret|secret-signature|opaque-secret/.test(JSON.stringify(parts)));
  assert.deepEqual(cleanTimelineParts(parts), parts);
});

test('context summary reminders keep their identity, content and estimates in the timeline without duplicate activities', async t => {
  const f = await fixture(t);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event({ type: 'message_update', message: assistant([{ type: 'text', text: 'Before compaction' }]) });
  const start = { type: 'context.summary_start', scope: 'chat:fixture', operationId: 'summary-1', startedAt: 100 };
  f.event(start);
  const initial = f.service.state('current');
  assert.deepEqual(initial.parts.map(part => part.type), ['text', 'summary']);
  assert.equal(initial.parts[1].status, 'running');
  assert.equal(initial.parts[1].text, '');
  const end = { ...start, type: 'context.summary_end', status: 'completed', endedAt: 350, text: 'Keep verified findings. api_key=summary-secret', beforeTokens: 9000, afterTokens: 2000, fallback: true };
  f.event({ type: 'context.summary', scope: start.scope, artifactId: 'artifact', fallback: true });
  f.event(end); f.event(end); f.event(start);
  f.event({ type: 'message_start', message: assistant([]) });
  f.event({ type: 'message_end', message: assistant([{ type: 'text', text: 'Final answer' }]) });
  f.complete('Final answer'); await f.completion;
  const parts = f.delivered[0].parts;
  assert.deepEqual(parts.map(part => part.type), ['text', 'summary', 'text']);
  assert.equal(parts[1].id, initial.parts[1].id);
  assert.equal(parts[1].status, 'completed'); assert.equal(parts[1].endedAt, 350);
  assert.equal(parts[1].beforeTokens, 9000); assert.equal(parts[1].afterTokens, 2000); assert.equal(parts[1].fallback, true);
  assert(!JSON.stringify(parts).includes('summary-secret'));
  assert(!f.service.state('current').activities.some(item => item.label.startsWith('context.')));
  assert.deepEqual(cleanTimelineParts(parts), parts);
});

test('summary reminders remain scoped to worker views and cancelled root summaries stop', async t => {
  const f = await fixture(t);
  f.event({ type: 'context.summary_start', scope: 'worker:child', operationId: 'child-summary', startedAt: 100 });
  f.event({ type: 'context.summary_end', scope: 'worker:child', operationId: 'child-summary', startedAt: 100, endedAt: 200, status: 'failed', text: '' });
  const state = f.service.state('current');
  assert.equal(state.parts.length, 0);
  const part = state.workers.find(worker => worker.id === 'child').parts[0];
  assert.equal(part.type, 'summary'); assert.equal(part.source, 'worker'); assert.equal(part.status, 'failed');
  f.event({ type: 'context.summary_start', scope: 'chat:fixture', operationId: 'root-summary', startedAt: 100 });
  f.service.cancel('current'); await f.completion;
  assert.equal(f.service.state('current').parts[0].status, 'interrupted');
});

test('goal middleware summaries use the same persisted inline reminder', async t => {
  const f = await fixture(t, 'goal');
  for (const event of [
    { type: 'context.summary_start', scope: 'reason', operationId: 'reason-summary', startedAt: 100 },
    { type: 'context.summary_end', scope: 'reason', operationId: 'reason-summary', startedAt: 100, endedAt: 200, status: 'completed', text: 'Evidence summary', beforeTokens: 5000, afterTokens: 900 }
  ]) f.event({ type: 'middleware.event', event });
  f.complete({ complete: true, revision: 1, summary: 'Goal done' }); await f.completion;
  assert.equal(f.delivered[0].parts[0].type, 'summary');
  assert.equal(f.delivered[0].parts[0].source, 'reason');
  assert.equal(f.delivered[0].parts[0].text, 'Evidence summary');
});

test('desktop assistance installs fail-closed approval by default, switch disables it, goal mode is unchanged', async t => {
  const enabled = await fixture(t);
  assert.equal(typeof enabled.running.requestToolApproval, 'function');
  assert.throws(() => enabled.running.requestToolApproval({ toolName: 'test' }), /人工审核界面不可用/);
  enabled.complete('done'); await enabled.completion;
  const disabled = await fixture(t, 'assist', '', { worker: { requireToolApproval: false } });
  assert.equal(disabled.running.requestToolApproval, undefined);
  disabled.complete('done'); await disabled.completion;
  const goal = await fixture(t, 'goal');
  assert.equal(goal.running.requestToolApproval, undefined);
  goal.complete({ complete: true, revision: 1, summary: 'done' }); await goal.completion;
});

test('composer mode overrides settings for each submitted assistance turn', async t => {
  const automatic = await fixture(t, 'assist', '', { worker: { requireToolApproval: true } }, 'auto');
  assert.equal(automatic.running.requestToolApproval, undefined);
  automatic.complete('done'); await automatic.completion;
  const manual = await fixture(t, 'assist', '', { worker: { requireToolApproval: false } }, 'manual');
  assert.equal(typeof manual.running.requestToolApproval, 'function');
  manual.complete('done'); await manual.completion;
  await assert.rejects(manual.service.start({ conversationId: 'bad', mode: 'assist', text: 'test', approvalMode: 'invalid' }), /无效的工具执行方式/);
});
