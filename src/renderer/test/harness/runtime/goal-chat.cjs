'use strict';

// Contract tests for the exploration-mode sidebar conversation ("探索对话").
// The fake SDK in the fixture replaces `createModelClient` so the chat model is
// a test-owned stream: each send records the prompt context and returns a
// controllable pi-ai event stream instead of a network transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHarnessService } = require('../../../../harness/ide/runtime/harness-service.cjs');

const GOAL = { objective: '验证聊天契约', criteria: ['对话能读到探索状态'] };
const CHAT_FILE = 'goal-chat.json';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 32);

let piModule;
const loadPi = () => piModule ??= import('@earendil-works/pi-ai');

async function waitFor(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let failure;
    try { const value = await check(); if (value) return value; }
    catch (error) { failure = error; }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}${failure ? `: ${failure.message}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function findRecords(directory, name) {
  let entries;
  try { entries = await readdir(directory, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile() && entry.name === name)
    .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function findRecord(directory, name) {
  return (await findRecords(directory, name))[0];
}

function assistantMessage(provider, text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions', provider, model: 'fixture-chat',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now()
  };
}

function createChatStream(AssistantMessageEventStream, context, options) {
  const stream = new AssistantMessageEventStream();
  let text = '';
  const message = () => assistantMessage('fixture', text);
  const control = {
    stream, context, options, text: () => text,
    push(delta) {
      text += delta;
      stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message() });
    },
    finish() {
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message() });
      stream.push({ type: 'done', reason: 'stop', message: message() });
    },
    abort(reason = '用户停止了回答。') {
      stream.push({ type: 'error', reason: 'aborted', error: { ...message(), stopReason: 'aborted', errorMessage: reason } });
    }
  };
  return control;
}

/**
 * A goal/assist harness service on a temporary workspace.
 * `configured: false` models a host without a chat model (MODEL_REQUIRED).
 */
async function fixture(t, { configured = true, agentRun, sessionTools, workspaceToolNames = [], hostTools = [], harnessSeed, modelInput = ['text'] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ubovm-goal-chat-'));
  const storage = path.join(directory, 'storage');
  const chats = [];
  let service, complete, sawBusy = false;
  let changes = 0;
  const imagePath = path.join(directory, 'screen.png');
  const image = { id: 'ab12cd34', name: 'screen.png', mimeType: 'image/png', bytes: PNG.length, path: imagePath };
  const completion = new Promise(resolve => { complete = resolve; });
  const { AssistantMessageEventStream } = await loadPi();
  t.after(async () => {
    await service?.close();
    const relative = path.relative(tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'ide'));
  await mkdir(path.join(directory, 'agents/collaboration'), { recursive: true });
  await Promise.all([
    writeFile(imagePath, PNG),
    writeFile(path.join(directory, 'index.mjs'), `
      export { HarnessDatabase } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../../harness/blackboard/database/database.mjs')).href)};
      export function createModelClient(configuration) {
        return {
          model: { id: configuration.modelId, provider: configuration.provider, api: configuration.api, baseUrl: configuration.baseUrl, input: configuration.input },
          streamFn: (selected, context, options) => configuration.streamFn(context, options)
        };
      }
      export async function createHarness(options) {
        const seed = options.fixtureHarness ?? {};
        const board = seed.board ?? { sessionId: options.sessionId, goal: options.goal, revision: 0, rootId: 'root', nodes: [] };
        const memory = seed.memory ?? { notes: [] };
        return {
          snapshot: () => board, memory: () => structuredClone(memory), middlewareStatus: () => ({}),
          close: async () => {}, cancel() {},
          agenda: () => seed.agenda ?? ({ items: [], counts: { planned: 0, active: 0, blocked: 0, done: 0, dropped: 0 }, gaps: [], lastUpdated: null }),
          // Session-level inspection/management tools (graph, agenda, Worker
          // control) the sidebar chat reuses while a goal run owns a session.
          chatTools: () => options.fixtureChatTools ? options.fixtureChatTools() : [],
          graphInfo: () => seed.graph ?? ({ revision: board.revision, nodes: board.nodes.length, intents: 0, facts: 0, edges: 0, root: 'n1', detail: 'full', omittedFacts: 0, overBudget: false }),
          addFact: async fact => { board.nodes.push({ id: 'fact-' + board.nodes.length, kind: 'fact', parentIds: fact.parentIds, childIds: [], fact, attempts: [] }); board.revision++; },
          run: ({ signal }) => options.fixture({ ...options, signal, memory, route: 'goal' }),
          resume: ({ signal }) => options.fixture({ ...options, signal, memory, route: 'goal' })
        };
      }`),
    writeFile(path.join(directory, 'agents/collaboration/index.mjs'), `
      export { loadImageParts } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../../../../harness/agents/collaboration/images.mjs')).href)};
      export const runCollaboration = options => options.configuration.fixture({ ...options, route: 'collaboration' });`),
    writeFile(path.join(directory, 'ide/workspace-tools.mjs'), `export const createWorkspaceTools = async () => (${JSON.stringify(workspaceToolNames)}).map(name => ({
      name, label: name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return { content: [{ type: 'text', text: JSON.stringify({ name }) }], details: { name } }; }
    }));`)
  ]);
  const model = {    provider: 'fixture', modelId: 'fixture-chat', api: 'openai-completions', input: modelInput,
    baseUrl: 'https://offline.invalid/v1', apiKey: 'fixture-key',
    streamFn: (context, options) => {
      const control = createChatStream(AssistantMessageEventStream, context, options);
      chats.push(control);
      return control.stream;
    }
  };
  let started, harnessOptions;
  const runReady = new Promise(resolve => { started = options => { harnessOptions = options; resolve(options); }; });
  service = createHarnessService({
    workspaceRoots: () => [directory],
    sdkPath: path.join(directory, 'index.mjs'),
    storageDirectory: storage,
    readConfiguration: async () => ({ fixture: options => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      complete = resolve;
      started(options);
    }), ...(harnessSeed ? { fixtureHarness: harnessSeed } : {}), ...(sessionTools ? { fixtureChatTools: () => sessionTools } : {}) }),
    readChatConfiguration: async () => configured ? { model, ...(agentRun ? { chatTools: true, fixture: agentRun } : {}) } : {},
    additionalTools: () => hostTools,
    onChange: () => { changes++; if (service.isBusy('current')) sawBusy = true; else if (sawBusy) complete?.(); }
  });
  const openGoal = goal => service.restore({ conversationId: 'current', mode: 'goal', goal });
  const restoreGoal = (conversationId, goal) => service.restore({ conversationId, mode: 'goal', goal });
  const view = () => service.state('current').goalChat;
  const viewOf = id => service.state(id).goalChat;
  const savedRecord = async () => {
    const file = await findRecord(storage, CHAT_FILE);
    if (!file) return undefined;
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  };
  const savedRecords = async () => {
    const records = [];
    for (const file of await findRecords(storage, CHAT_FILE)) {
      try { records.push(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    return records;
  };
  const activeMessages = record => (record && ((record.threads?.find(thread => thread.id === record.activeThreadId) ?? record.threads?.[0])?.messages ?? [])) || [];
  return {
    service, directory, storage, chats, model, image, imagePath,
    get changes() { return changes; },
    view, viewOf, openGoal, restoreGoal, savedRecord, savedRecords, activeMessages,
    harness: () => harnessOptions,
    memory: () => harnessOptions?.memory,
    emit: event => harnessOptions?.onEvent(event),
    waitFor,
    waitForChat: (predicate, label) => waitFor(() => view() && predicate(view()), label),
    waitForChatCount: count => waitFor(() => chats.length >= count, `${count} chat model call(s)`),
    openGoalTest: () => openGoal(GOAL),
    async send(text = '现在进展到哪一步了？') { return service.goalChatSend('current', text); },
    async sendImages(text, images) { return service.goalChatSend('current', text, images); },
    async sendTo(conversationId, text) { return service.goalChatSend(conversationId, text); },
    async startGoalRun() {
      await service.start({ conversationId: 'current', mode: 'goal', goal: GOAL });
      await runReady;
      return service.state('current');
    },
    completeRun(summary = '探索完成') { complete({ complete: true, revision: 1, summary }); },
    completion,
    async savedChat(minimum = 1) {
      return waitFor(async () => {
        const record = await savedRecord();
        return record && activeMessages(record).length >= minimum ? record : undefined;
      }, `saved ${CHAT_FILE} with ${minimum} message(s) in the active conversation`);
    }
  };
}

test('goal sessions project an empty idle goalChat and assist sessions do not expose it', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  const view = f.view();
  assert.deepEqual(Object.keys(view).sort(), ['activeThreadId', 'activity', 'canStop', 'error', 'messages', 'status', 'streamParts', 'streamText', 'threads', 'updatedAt']);
  assert.equal(view.status, 'idle');
  assert.deepEqual(view.messages, []);
  assert.equal(view.streamText, '');
  assert.deepEqual(view.streamParts, []);
  assert.equal(view.error, null);
  assert.equal(view.canStop, false);
  assert.equal(view.updatedAt, 0);
  // A goal conversation always owns one writable chat tab titled 「新对话」.
  assert.equal(view.threads.length, 1);
  assert.equal(view.threads[0].title, '新对话');
  assert.equal(view.activeThreadId, view.threads[0].id);
  assert.match(view.activeThreadId, /^chat:/);
  // The draft goal (no saved objective) must not leak a sidebar conversation either.
  await f.service.restore({ conversationId: 'current', mode: 'assist' });
  assert.equal(Object.hasOwn(f.service.state('current'), 'goalChat'), false);
  await assert.rejects(f.service.goalChatSend('current', '现在进展到哪一步了？'), { code: 'GOAL_CHAT_UNAVAILABLE' });
  await assert.rejects(f.service.goalChatRewind('current', 'chat:user'), { code: 'GOAL_CHAT_UNAVAILABLE' });
  assert.equal(f.chats.length, 0);
});

test('goalChatSend streams text deltas, publishes running state and saves both turns', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  const started = await f.send('现在进展到哪一步了？');
  assert.equal(started.started, true);
  const first = f.view();
  assert.equal(first.status, 'running');
  assert.equal(first.canStop, true);
  assert.equal(first.error, null);
  assert.deepEqual(first.messages.map(message => [message.role, message.text]), [['user', '现在进展到哪一步了？']]);
  assert.match(first.messages[0].id, /^chat:/);

  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  // The prompt carries the user message, the saved objective and the read-only
  // evidence rule; no tools are exposed and history is attached to the prompt.
  assert.match(JSON.stringify(control.context), /现在进展到哪一步了/);
  assert.match(control.context.systemPrompt, /验证聊天契约/);
  assert.match(control.context.systemPrompt, /待核对证据/);
  assert.ok(control.options.signal instanceof AbortSignal);

  const changesBefore = f.changes;
  control.push('当前');
  await f.waitForChat(view => view.streamText === '当前', 'first streamed delta');
  control.push('进展');
  await f.waitForChat(view => view.streamText === '当前进展', 'accumulated streamed text');
  await waitFor(() => f.changes > changesBefore, 'streaming change notification');
  assert.equal(f.view().messages.length, 1, 'the assistant turn lands only when the answer completes');

  control.finish();
  await f.waitForChat(view => view.status === 'completed', 'completed goal chat');
  const done = f.view();
  assert.deepEqual(done.messages.map(message => [message.role, message.text]),
    [['user', '现在进展到哪一步了？'], ['assistant', '当前进展']]);
  assert.equal(done.streamText, '');
  assert.equal(done.canStop, false);
  assert.equal(done.error, null);
  assert.ok(done.updatedAt > 0);

  const record = await f.savedChat(2);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.threads.length, 1);
  assert.equal(record.activeThreadId, record.threads[0].id);
  // The first user question becomes the chat tab title.
  assert.equal(record.threads[0].title, '现在进展到哪一步了？');
  assert.deepEqual(record.threads[0].messages.map(message => [message.role, message.text]),
    [['user', '现在进展到哪一步了？'], ['assistant', '当前进展']]);
  assert.equal(f.chats.length, 1);
});

test('goalChat retries once with a larger budget when the model returns only hidden reasoning', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await f.send('hi');
  const first = await f.waitForChatCount(1).then(() => f.chats[0]);
  assert.equal(first.options.maxTokens, 2048);
  // A reasoning model can consume the completion budget without emitting text.
  first.finish();
  const retry = await f.waitForChatCount(2).then(() => f.chats[1]);
  assert.equal(retry.options.maxTokens, 4096);
  assert.equal(f.view().status, 'running');
  retry.push('第二答');
  retry.finish();
  await f.waitForChat(view => view.status === 'completed', 'completed after retry');
  assert.deepEqual(f.view().messages.map(message => [message.role, message.text]),
    [['user', 'hi'], ['assistant', '第二答']]);
  assert.equal(f.chats.length, 2);
});

test('cancel keeps the partial answer and marks the turn interrupted', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await f.send('还有哪些没有验证完？');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('还有两个方向');
  await f.waitForChat(view => view.streamText === '还有两个方向', 'partial before cancel');

  assert.equal(f.service.goalChatCancel('current'), true);
  control.abort();
  await f.waitForChat(view => view.status === 'interrupted', 'interrupted goal chat');
  const view = f.view();
  assert.equal(view.canStop, false);
  assert.equal(view.error, null);
  assert.equal(view.streamText, '');
  assert.deepEqual(view.messages.map(message => [message.role, message.text]),
    [['user', '还有哪些没有验证完？'], ['assistant', '还有两个方向']]);
  assert.equal(f.service.goalChatCancel('current'), false, 'no second run to cancel');
  // A later turn must be able to start again after the interrupted one.
  await f.send('下一步建议做什么？');
  await f.waitForChatCount(2);
  f.chats[1].push('建议先补齐证据');
  f.chats[1].finish();
  await f.waitForChat(next => next.status === 'completed' && next.messages.length === 4, 'chat after interruption');
});

test('a second send while the previous answer is running is rejected as busy', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await f.send('现在进展到哪一步了？');
  await f.waitForChat(view => view.status === 'running', 'running turn');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  await assert.rejects(f.service.goalChatSend('current', '再来一个问题'), { code: 'GOAL_CHAT_BUSY' });
  assert.equal(f.chats.length, 1, 'a rejected send must not start another model call');
  control.push('正在核对');
  control.finish();
  await f.waitForChat(view => view.status === 'completed' && view.messages.some(message => message.role === 'assistant'), 'completed busy turn');
});

test('a missing chat model fails with MODEL_REQUIRED and blank input is rejected', async t => {
  const f = await fixture(t, { configured: false });
  await f.openGoalTest();
  await assert.rejects(f.service.goalChatSend('current', '   '), { code: 'CHAT_MESSAGE_REQUIRED' });
  await assert.rejects(f.service.goalChatSend('current', '现在进展到哪一步了？'), { code: 'MODEL_REQUIRED' });
  const view = f.view();
  assert.equal(view.status, 'failed');
  assert.equal(view.error?.code, 'MODEL_REQUIRED');
  assert.equal(view.canStop, false);
  assert.deepEqual(view.messages, []);
  assert.equal(f.chats.length, 0);
  // A goal draft without a saved objective is refused before any model call.
  const draft = await fixture(t, { configured: false });
  await draft.service.restore({ conversationId: 'current', mode: 'goal' });
  await assert.rejects(draft.service.goalChatSend('current', '现在进展到哪一步了？'), { code: 'GOAL_REQUIRED' });
});

test('saved history is restored by a fresh service without starting the model', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await f.send('现在进展到哪一步了？');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('目标已保存，');
  control.push('探索刚开始。');
  control.finish();
  await f.waitForChat(view => view.status === 'completed', 'completed turn');
  const saved = await f.savedChat(2);
  assert.deepEqual(f.activeMessages(saved).map(message => message.text), ['现在进展到哪一步了？', '目标已保存，探索刚开始。']);
  await f.service.close();

  let modelCalls = 0;
  const restored = createHarnessService({
    workspaceRoots: () => [f.directory],
    sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: f.storage,
    readConfiguration: () => { throw new Error('restoring the sidebar conversation must not start the goal runtime'); },
    readChatConfiguration: async () => { modelCalls++; return {}; }
  });
  t.after(() => restored.close());
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.equal(state.goalChat.status, 'idle');
    assert.equal(state.goalChat.canStop, false);
    assert.equal(state.goalChat.streamText, '');
    assert.deepEqual(state.goalChat.messages.map(message => [message.role, message.text]),
      [['user', '现在进展到哪一步了？'], ['assistant', '目标已保存，探索刚开始。']]);
    // Repeated restore must not duplicate or lose any saved turn.
    const again = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.deepEqual(again.goalChat.messages, state.goalChat.messages);
    assert.equal(modelCalls, 0);
  } finally { await restored.close(); }
});

test('a running goal execution keeps its status and busy flag while the sidebar answers', async t => {
  const f = await fixture(t);
  await f.startGoalRun();
  const running = f.service.state('current');
  assert.equal(running.status, 'running');
  assert.equal(running.busy, true);
  assert.equal(running.goalChat.status, 'idle');

  await f.send('现在进展到哪一步了？');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('仍在执行');
  control.finish();
  await f.waitForChat(view => view.status === 'completed', 'sidebar answer while the goal runs');
  const during = f.service.state('current');
  assert.equal(during.status, 'running', 'sidebar chat must not change the execution status');
  assert.equal(during.busy, true, 'sidebar chat must not clear the execution busy flag');
  assert.equal(during.goalChat.messages.length, 2);

  f.completeRun();
  await f.waitFor(() => !f.service.isBusy('current'), 'goal execution completion');
  assert.equal(f.service.state('current').status, 'completed');
});

const chatOf = (f, id) => id === 'current' ? f.view() : f.viewOf(id);

// Drive one complete sidebar turn: send, stream one delta, finish.
async function turn(f, conversationId, question, answerText, expectedMessages) {
  const index = f.chats.length;
  await f.service.goalChatSend(conversationId, question);
  const control = await f.waitForChatCount(index + 1).then(() => f.chats[index]);
  control.push(answerText);
  control.finish();
  await f.waitFor(() => {
    const view = chatOf(f, conversationId);
    return view && view.status === 'completed' && view.messages.length === expectedMessages;
  }, `${conversationId} completed turn with ${expectedMessages} messages`);
}

test('goalChatRewind removes the user turn and every later answer, returning its text', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await turn(f, 'current', '第一问', '第一答', 2);
  await turn(f, 'current', '第二问', '第二答', 4);
  const messages = f.view().messages;
  assert.equal(messages[2].role, 'user');
  const activeThreadId = f.view().activeThreadId;
  // Only saved user messages are rewind targets.
  await assert.rejects(f.service.goalChatRewind('current', messages[3].id), { code: 'CHAT_MESSAGE_NOT_FOUND' });
  await assert.rejects(f.service.goalChatRewind('current', 'chat:missing'), { code: 'CHAT_MESSAGE_NOT_FOUND' });
  assert.equal(f.view().messages.length, 4, 'a rejected rewind leaves the history intact');

  const rewound = await f.service.goalChatRewind('current', messages[2].id);
  assert.equal(rewound.text, '第二问');
  assert.equal(rewound.threadId, activeThreadId);
  const view = f.view();
  assert.equal(view.status, 'idle');
  assert.equal(view.streamText, '');
  assert.equal(view.error, null);
  assert.equal(view.canStop, false);
  assert.equal(view.activeThreadId, activeThreadId);
  assert.deepEqual(view.messages.map(message => [message.role, message.text]), [['user', '第一问'], ['assistant', '第一答']]);
  assert.deepEqual(f.activeMessages(await f.savedChat(2)).map(message => message.text), ['第一问', '第一答']);

  assert.equal((await f.service.goalChatRewind('current', view.messages[0].id)).text, '第一问');
  assert.deepEqual(f.view().messages, []);
  await f.waitFor(async () => f.activeMessages(await f.savedRecord()).length === 0, 'empty persisted history');
});

test('rewound history stays rewound after a service restart', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await turn(f, 'current', '第一问', '第一答', 2);
  await turn(f, 'current', '第二问', '第二答', 4);
  await f.service.goalChatRewind('current', f.view().messages[2].id);
  await f.waitFor(async () => f.activeMessages(await f.savedRecord()).length === 2, 'rewind persisted');
  await f.service.close();

  let modelCalls = 0;
  const restored = createHarnessService({
    workspaceRoots: () => [f.directory],
    sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: f.storage,
    readConfiguration: () => { throw new Error('restoring the sidebar conversation must not start the goal runtime'); },
    readChatConfiguration: async () => { modelCalls++; return {}; }
  });
  t.after(() => restored.close());
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.deepEqual(state.goalChat.messages.map(message => [message.role, message.text]), [['user', '第一问'], ['assistant', '第一答']]);
    assert.equal(state.goalChat.status, 'idle');
    assert.equal(modelCalls, 0);
  } finally { await restored.close(); }
});

test('a running answer blocks rewind until it settles', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await f.send('问题一');
  const running = await f.waitFor(() => {
    const view = f.view();
    return view.status === 'running' && view.messages.length === 1 && view;
  }, 'running turn');
  await assert.rejects(f.service.goalChatRewind('current', running.messages[0].id), { code: 'GOAL_CHAT_BUSY' });
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('回答一');
  control.finish();
  await f.waitForChat(view => view.status === 'completed' && view.messages.length === 2, 'completed turn');
  assert.equal((await f.service.goalChatRewind('current', f.view().messages[0].id)).text, '问题一');
  assert.deepEqual(f.view().messages, []);
});

test('two exploration sessions keep independent chat histories, files and rewind scope', async t => {
  const f = await fixture(t);
  await f.restoreGoal('current', { objective: '会话 A 的目标' });
  await f.restoreGoal('other', { objective: '会话 B 的目标' });
  await turn(f, 'current', 'A 的问题', 'A 的回答', 2);
  await turn(f, 'other', 'B 的问题', 'B 的回答', 2);
  assert.deepEqual(f.viewOf('current').messages.map(message => message.text), ['A 的问题', 'A 的回答']);
  assert.deepEqual(f.viewOf('other').messages.map(message => message.text), ['B 的问题', 'B 的回答']);

  const records = await f.waitFor(async () => {
    const all = await f.savedRecords();
    if (all.length !== 2) return false;
    const byQuestion = new Map(all.map(record => [f.activeMessages(record)[0]?.text, record]));
    return f.activeMessages(byQuestion.get('A 的问题')).length === 2 && f.activeMessages(byQuestion.get('B 的问题')).length === 2 && all;
  }, 'two persisted goal-chat.json files', 20000);
  const byQuestion = new Map(records.map(record => [f.activeMessages(record)[0]?.text, record]));
  assert.deepEqual(f.activeMessages(byQuestion.get('A 的问题')).map(message => message.text), ['A 的问题', 'A 的回答']);
  assert.deepEqual(f.activeMessages(byQuestion.get('B 的问题')).map(message => message.text), ['B 的问题', 'B 的回答']);

  // Rewinding A must not touch B.
  await f.service.goalChatRewind('current', f.viewOf('current').messages[0].id);
  assert.deepEqual(f.viewOf('current').messages, []);
  assert.deepEqual(f.viewOf('other').messages.map(message => message.text), ['B 的问题', 'B 的回答']);
  await turn(f, 'other', 'B 的第二问', 'B 的第二答', 4);
  const after = await f.waitFor(async () => {
    const all = await f.savedRecords();
    if (all.length !== 2) return false;
    const texts = all.map(record => f.activeMessages(record).map(message => message.text).join('|'));
    return texts.includes('') && texts.includes('B 的问题|B 的回答|B 的第二问|B 的第二答') && all;
  }, 'two files after the extra B turn', 20000);
  const textsByFile = after.map(record => f.activeMessages(record).map(message => message.text).join('|')).sort();
  assert.deepEqual(textsByFile, ['', 'B 的问题|B 的回答|B 的第二问|B 的第二答'].sort());
  assert.equal(f.viewOf('current').messages.length, 0);
});

test('goalChatNewThread adds an empty chat inside the exploration and titles it from the first question', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await turn(f, 'current', '第一个对话的问题', '第一个对话的回答', 2);
  const firstThreadId = f.view().activeThreadId;
  assert.equal(f.view().threads.length, 1);

  const created = await f.service.goalChatNewThread('current');
  assert.equal(typeof created.threadId, 'string');
  let view = f.view();
  assert.equal(view.threads.length, 2);
  assert.equal(view.activeThreadId, created.threadId);
  assert.equal(view.threads.find(thread => thread.id === created.threadId).title, '新对话');
  assert.deepEqual(view.messages, []);
  assert.equal(view.status, 'idle');
  assert.equal(view.error, null);

  // The first user question becomes the new tab's title; the old tab keeps its own.
  await turn(f, 'current', '第二个对话的问题', '第二个对话的回答', 2);
  view = f.view();
  assert.equal(view.threads.find(thread => thread.id === created.threadId).title, '第二个对话的问题');
  assert.equal(view.threads.find(thread => thread.id === firstThreadId).title, '第一个对话的问题');

  // Selecting a tab only swaps the visible transcript.
  const selected = await f.service.goalChatSelectThread('current', firstThreadId);
  assert.equal(selected.threadId, firstThreadId);
  view = f.view();
  assert.equal(view.activeThreadId, firstThreadId);
  assert.deepEqual(view.messages.map(message => message.text), ['第一个对话的问题', '第一个对话的回答']);

  const record = await f.waitFor(async () => {
    const current = await f.savedRecord();
    return current?.threads?.length === 2 && current;
  }, 'two saved chat tabs');
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.activeThreadId, firstThreadId);
  assert.deepEqual(record.threads.map(thread => thread.title).sort(), ['第一个对话的问题', '第二个对话的问题'].sort());
});

test('goalChatRewind only edits the active chat conversation', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await turn(f, 'current', '第一个问题', '第一个回答', 2);
  const firstThreadId = f.view().activeThreadId;
  const created = await f.service.goalChatNewThread('current');
  await turn(f, 'current', '第二个问题', '第二个回答', 2);

  const rewound = await f.service.goalChatRewind('current', f.view().messages[0].id);
  assert.equal(rewound.text, '第二个问题');
  assert.equal(rewound.threadId, created.threadId);
  assert.deepEqual(f.view().messages, []);
  await f.waitFor(async () => f.activeMessages(await f.savedRecord()).length === 0, 'rewind persisted for the active tab');

  await f.service.goalChatSelectThread('current', firstThreadId);
  assert.deepEqual(f.view().messages.map(message => message.text), ['第一个问题', '第一个回答']);
  const record = await f.savedRecord();
  assert.deepEqual(record.threads.find(thread => thread.id === firstThreadId).messages.map(message => message.text),
    ['第一个问题', '第一个回答']);
  assert.deepEqual(record.threads.find(thread => thread.id === created.threadId).messages, []);
});

test('an exploration keeps at most twenty chat conversations', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  for (let index = 0; index < 19; index++) await f.service.goalChatNewThread('current');
  assert.equal(f.view().threads.length, 20);
  await assert.rejects(f.service.goalChatNewThread('current'), { code: 'GOAL_CHAT_THREAD_LIMIT' });
  assert.equal(f.view().threads.length, 20);
  const record = await f.savedRecord();
  assert.equal(record.threads.length, 20);
});

test('a v1 goal-chat.json migrates into the first chat conversation', async t => {
  const f = await fixture(t);
  const goalText = `${GOAL.objective}\n\n验收标准：\n1. ${GOAL.criteria[0]}`;
  const key = `goal-${sha(goalText)}`;
  const directory = path.join(f.storage, sha('current'), key);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, CHAT_FILE), JSON.stringify({
    schemaVersion: 1,
    sessionId: `ide_${sha('current:' + key)}`,
    messages: [
      { id: 'chat:old-user', role: 'user', text: '旧对话的第一个问题', at: 1 },
      { id: 'chat:old-answer', role: 'assistant', text: '旧对话的回答', at: 2 }
    ],
    updatedAt: 5
  }));
  const state = await f.service.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
  const chat = state.goalChat;
  assert.equal(chat.threads.length, 1);
  assert.equal(chat.activeThreadId, chat.threads[0].id);
  assert.equal(chat.threads[0].title, '旧对话的第一个问题');
  assert.deepEqual(chat.messages.map(message => [message.role, message.text]),
    [['user', '旧对话的第一个问题'], ['assistant', '旧对话的回答']]);
});

test('a running answer blocks creating, switching and rewinding conversations', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  const initialThreadId = f.view().activeThreadId;
  const created = await f.service.goalChatNewThread('current');
  await f.send('问题一');
  const running = await f.waitFor(() => {
    const view = f.view();
    return view.status === 'running' && view.messages.length === 1 && view;
  }, 'running turn');
  assert.equal(f.view().activeThreadId, created.threadId);
  await assert.rejects(f.service.goalChatNewThread('current'), { code: 'GOAL_CHAT_BUSY' });
  await assert.rejects(f.service.goalChatSelectThread('current', initialThreadId), { code: 'GOAL_CHAT_BUSY' });
  await assert.rejects(f.service.goalChatRewind('current', running.messages[0].id), { code: 'GOAL_CHAT_BUSY' });

  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('回答一');
  control.finish();
  await f.waitForChat(view => view.status === 'completed' && view.messages.length === 2, 'settled turn');
  const switched = await f.service.goalChatSelectThread('current', initialThreadId);
  assert.equal(switched.threadId, initialThreadId);
  assert.deepEqual(f.view().messages, []);
});

test('chat conversations, active tab and titles survive a service restart', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await turn(f, 'current', '第一个问题', '第一个回答', 2);
  const firstThreadId = f.view().activeThreadId;
  const created = await f.service.goalChatNewThread('current');
  await turn(f, 'current', '第二个问题', '第二个回答', 2);
  await f.service.goalChatSelectThread('current', firstThreadId);
  await f.waitFor(async () => (await f.savedRecord())?.activeThreadId === firstThreadId, 'active tab persisted');
  await f.service.close();

  let modelCalls = 0;
  const restored = createHarnessService({
    workspaceRoots: () => [f.directory],
    sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: f.storage,
    readConfiguration: () => { throw new Error('restoring chat tabs must not start the goal runtime'); },
    readChatConfiguration: async () => { modelCalls++; return {}; }
  });
  t.after(() => restored.close());
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    const chat = state.goalChat;
    assert.equal(chat.threads.length, 2);
    assert.equal(chat.activeThreadId, firstThreadId);
    assert.deepEqual(chat.threads.map(thread => thread.title).sort(), ['第一个问题', '第二个问题'].sort());
    assert.deepEqual(chat.messages.map(message => message.text), ['第一个问题', '第一个回答']);
    assert.equal(modelCalls, 0);
    await restored.goalChatSelectThread('current', created.threadId);
    const after = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.deepEqual(after.goalChat.messages.map(message => message.text), ['第二个问题', '第二个回答']);
  } finally { await restored.close(); }
});

// Three chat conversations in one exploration, newest first: [third, second, first].
async function threeChatThreads(f) {
  await f.openGoalTest();
  await turn(f, 'current', '对话一的问题', '对话一的回答', 2);
  const first = f.view().activeThreadId;
  const second = (await f.service.goalChatNewThread('current')).threadId;
  await turn(f, 'current', '对话二的问题', '对话二的回答', 2);
  const third = (await f.service.goalChatNewThread('current')).threadId;
  await turn(f, 'current', '对话三的问题', '对话三的回答', 2);
  return { first, second, third };
}

test('deleting a non-active chat conversation keeps the current one selected', async t => {
  const f = await fixture(t);
  const ids = await threeChatThreads(f);
  const removed = await f.service.goalChatDeleteThread('current', ids.second);
  assert.deepEqual(removed, { threadId: ids.second, activeThreadId: ids.third });
  const view = f.view();
  assert.equal(view.activeThreadId, ids.third);
  assert.deepEqual(view.threads.map(thread => thread.id).sort(), [ids.first, ids.third].sort());
  assert.deepEqual(view.messages.map(message => message.text), ['对话三的问题', '对话三的回答']);
  const record = await f.waitFor(async () => {
    const current = await f.savedRecord();
    return current?.threads?.length === 2 && current;
  }, 'delete persisted', 15000);
  assert.equal(record.threads.some(thread => thread.id === ids.second), false);
  // The other conversation's history is untouched.
  await f.service.goalChatSelectThread('current', ids.first);
  assert.deepEqual(f.view().messages.map(message => message.text), ['对话一的问题', '对话一的回答']);
});

test('deleting the active chat conversation selects the adjacent one', async t => {
  const f = await fixture(t);
  const ids = await threeChatThreads(f);
  // The newest tab sits first; deleting it promotes the same position.
  const firstDelete = await f.service.goalChatDeleteThread('current', ids.third);
  assert.deepEqual(firstDelete, { threadId: ids.third, activeThreadId: ids.second });
  assert.equal(f.view().activeThreadId, ids.second);
  assert.deepEqual(f.view().messages.map(message => message.text), ['对话二的问题', '对话二的回答']);
  // Deleting the active tab in the last position falls back to the previous tab.
  const secondDelete = await f.service.goalChatDeleteThread('current', ids.second);
  assert.deepEqual(secondDelete, { threadId: ids.second, activeThreadId: ids.first });
  assert.equal(f.view().activeThreadId, ids.first);
  assert.deepEqual(f.view().threads.map(thread => thread.id), [ids.first]);
  assert.deepEqual(f.view().messages.map(message => message.text), ['对话一的问题', '对话一的回答']);
});

test('the last chat conversation cannot be deleted', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  const only = f.view().activeThreadId;
  await assert.rejects(f.service.goalChatDeleteThread('current', only), { code: 'GOAL_CHAT_LAST_THREAD' });
  assert.equal(f.view().threads.length, 1);
  assert.equal(f.view().activeThreadId, only);
  assert.equal(await f.savedRecord(), undefined, 'a rejected delete does not rewrite storage');
});

test('a running answer blocks deleting chat conversations', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  const first = f.view().activeThreadId;
  const second = (await f.service.goalChatNewThread('current')).threadId;
  await f.send('正在回答的问题');
  await f.waitFor(() => {
    const view = f.view();
    return view.status === 'running' && view.messages.length === 1 && view;
  }, 'running turn');
  await assert.rejects(f.service.goalChatDeleteThread('current', second), { code: 'GOAL_CHAT_BUSY' });
  await assert.rejects(f.service.goalChatDeleteThread('current', first), { code: 'GOAL_CHAT_BUSY' });
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('回答');
  control.finish();
  await f.waitForChat(view => view.status === 'completed' && view.messages.length === 2, 'settled turn');
  const removed = await f.service.goalChatDeleteThread('current', second);
  assert.equal(removed.threadId, second);
  assert.equal(f.view().threads.length, 1);
});

test('unknown chat conversations are rejected and assist sessions cannot delete tabs', async t => {
  const f = await fixture(t);
  await f.openGoalTest();
  await assert.rejects(f.service.goalChatDeleteThread('current', 'chat:missing'), { code: 'CHAT_THREAD_NOT_FOUND' });
  await assert.rejects(f.service.goalChatDeleteThread('current', '   '), { code: 'CHAT_THREAD_NOT_FOUND' });
  await f.service.restore({ conversationId: 'current', mode: 'assist' });
  await assert.rejects(f.service.goalChatDeleteThread('current', 'chat:thread'), { code: 'GOAL_CHAT_UNAVAILABLE' });
});

test('deleted conversations stay deleted after a restart and the rest keep their history', async t => {
  const f = await fixture(t);
  const ids = await threeChatThreads(f);
  await f.service.goalChatDeleteThread('current', ids.third);
  await f.waitFor(async () => {
    const current = await f.savedRecord();
    return current?.threads?.length === 2 && current.activeThreadId === ids.second;
  }, 'active deletion persisted', 15000);
  await f.service.close();

  const restored = createHarnessService({
    workspaceRoots: () => [f.directory],
    sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: f.storage,
    readConfiguration: () => { throw new Error('restoring deleted tabs must not start the goal runtime'); },
    readChatConfiguration: async () => ({})
  });
  t.after(() => restored.close());
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    const chat = state.goalChat;
    assert.equal(chat.threads.length, 2);
    assert.equal(chat.threads.some(thread => thread.id === ids.third), false, 'the deleted conversation must not come back');
    assert.equal(chat.activeThreadId, ids.second);
    assert.deepEqual(chat.messages.map(message => message.text), ['对话二的问题', '对话二的回答']);
    await restored.goalChatSelectThread('current', ids.first);
    const after = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.deepEqual(after.goalChat.messages.map(message => message.text), ['对话一的问题', '对话一的回答']);
  } finally { await restored.close(); }
});

// ---- Agentic chat: chatTools resolves the single completion into a real turn ----

function agentRunFixture({ answer = '当前在侦察阶段，Reason 已派发 2 个 Worker。', hold = false } = {}) {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = async options => {
    const events = options.onEvent;
    calls.push({ options });
    events?.({ type: 'message_update', message: assistantMessage('fixture', '正在核对探索状态。'), assistantMessageEvent: { type: 'text_delta', delta: '正在核对探索状态。' } });
    events?.({ type: 'tool_execution_start', toolName: 'goal_status' });
    const aborted = new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    if (hold) await Promise.race([gate, aborted]);
    else await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 0)), aborted]);
    events?.({ type: 'tool_execution_end', toolName: 'goal_status' });
    return answer;
  };
  return { calls, fixture, release: () => release() };
}

test('chatTools mode runs an agent turn with Worker tools and exploration status tools', async t => {
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture });
  await f.openGoalTest();
  const started = await f.send('列出当前 Worker 和 Reason 状态');
  assert.equal(started.started, true);
  const call = await waitFor(() => agent.calls[0], 'agent turn');
  const options = call.options;
  // The turn is transient and inspection-only: bounded host history, no durable
  // collaboration transcript, and only the exploration inspection/management tools.
  assert.equal(options.transient, true);
  assert.equal(options.inspectOnly, true);
  assert.deepEqual(options.messages, []);
  assert.equal(options.text, '列出当前 Worker 和 Reason 状态');
  assert.ok(options.signal instanceof AbortSignal);
  const names = options.configuration.tools.map(tool => tool.name);
  for (const name of ['workspace_info', 'goal_status', 'read_notes', 'read_fact', 'exploration_workers', 'exploration_agenda', 'exploration_graph', 'read_blackboard_facts', 'read_execution_log', 'exploration_control']) {
    assert.ok(names.includes(name), `missing inspection tool ${name}`);
  }
  // Command execution tools are deliberately absent from the sidebar chat; the
  // workspace file tools are added explicitly in a dedicated test below.
  for (const name of ['run_local_shell_command', 'run_python', 'ssh_execute', 'browser_open']) {
    assert.equal(names.includes(name), false, `unexpected execution tool ${name}`);
  }
  assert.equal(options.configuration.intools, false);
  assert.equal(options.configuration.mcp, false);
  assert.equal(options.configuration.skills, false);
  assert.equal(options.configuration.contextSummary, false);
  assert.match(options.configuration.worker.systemPrompt, /探索助手/);
  assert.match(options.configuration.worker.systemPrompt, /没有任何命令执行工具/);
  assert.match(options.configuration.worker.systemPrompt, /goal_status/);
  assert.match(options.configuration.worker.systemPrompt, /待核对证据/);
  assert.equal(options.configuration.collaboration.team, false);
  // The workspace directory tool answers with the selected roots.
  const workspaceInfo = options.configuration.tools.find(tool => tool.name === 'workspace_info');
  const info = JSON.parse((await workspaceInfo.execute('call-workspace-info', {}, new AbortController().signal)).content[0].text);
  assert.deepEqual(info.roots, [{ root: 0, path: f.directory }]);
  // Inspection tools answer from live exploration data.
  const goalStatus = options.configuration.tools.find(tool => tool.name === 'goal_status');
  const status = JSON.parse((await goalStatus.execute('call-status', {}, new AbortController().signal)).content[0].text);
  assert.match(status.goal, /验证聊天契约/);
  assert.equal(status.mode, 'goal');
  assert.equal(status.status, 'idle');
  const workers = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'exploration_workers').execute('call-workers', {}, new AbortController().signal)).content[0].text);
  assert.deepEqual(workers.workers, []);
  const facts = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'read_blackboard_facts').execute('call-facts', {}, new AbortController().signal)).content[0].text);
  assert.equal(facts.total, 0);
  const noteList = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'read_notes').execute('call-notes', {}, new AbortController().signal)).content[0].text);
  assert.equal(noteList.total, 0);
  // Status management: idle sessions cannot be stopped or resumed.
  const stop = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'exploration_control').execute('call-stop', { action: 'stop' }, new AbortController().signal)).content[0].text);
  assert.equal(stop.stopped, false);
  const resumeResult = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'exploration_control').execute('call-resume', { action: 'resume' }, new AbortController().signal)).content[0].text);
  assert.equal(resumeResult.resumed, false);
  await f.waitForChat(view => view.status === 'completed', 'completed agent turn');
  const completed = f.view();
  assert.deepEqual(completed.messages.map(message => [message.role, message.text]), [
    ['user', '列出当前 Worker 和 Reason 状态'], ['assistant', '当前在侦察阶段，Reason 已派发 2 个 Worker。']
  ]);
  assert.equal(completed.streamText, '');
  assert.equal(completed.activity, '');
  // The reasoning pass is projected as a real timeline: tool cards and text parts.
  const parts = completed.messages[1].parts;
  assert.ok(Array.isArray(parts) && parts.length >= 2, 'assistant turn keeps its timeline parts');
  assert.ok(parts.some(part => part.type === 'tool' && part.name === 'goal_status'), 'tool card part persisted');
  assert.ok(parts.some(part => part.type === 'text' && /Reason/.test(part.text)), 'answer text part persisted');
  assert.equal(completed.streamParts.length, 0);
});

test('chatTools mode adds workspace directory and file tools without command execution', async t => {
  const fakeTool = name => ({ name, label: name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: 'text', text: JSON.stringify({ name }) }], details: { name } }; } });
  const hostTools = ['read_workspace_code', 'edit_workspace_files', 'search_workspace'].map(fakeTool);
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture, workspaceToolNames: ['list_workspace_files'], hostTools });
  await f.openGoalTest();
  await f.send('看看工作目录里有什么文件');
  const call = await waitFor(() => agent.calls[0], 'agent turn');
  const options = call.options;
  const names = options.configuration.tools.map(tool => tool.name);
  for (const name of ['workspace_info', 'list_workspace_files', 'read_workspace_code', 'edit_workspace_files', 'search_workspace']) {
    assert.ok(names.includes(name), `missing workspace file tool ${name}`);
  }
  // The chat may read and write files but still cannot execute commands.
  for (const name of ['run_local_shell_command', 'run_python', 'ssh_execute', 'browser_open']) {
    assert.equal(names.includes(name), false, `unexpected command tool ${name}`);
  }
  assert.equal(options.inspectOnly, true);
  assert.match(options.configuration.worker.systemPrompt, /workspace_info/);
  assert.match(options.configuration.worker.systemPrompt, /edit_workspace_files/);
  assert.match(options.configuration.worker.systemPrompt, /文件操作会真实写入/);
  const signal = new AbortController().signal;
  const listed = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'list_workspace_files').execute('list', {}, signal)).content[0].text);
  assert.equal(listed.name, 'list_workspace_files');
  const edited = JSON.parse((await options.configuration.tools.find(tool => tool.name === 'edit_workspace_files').execute('edit', {}, signal)).content[0].text);
  assert.equal(edited.name, 'edit_workspace_files');
});

test('an active goal session adds Worker management and intent tools, not execution tools', async t => {
  const tool = name => ({ name, label: name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: 'text', text: '[]' }], details: [] }; } });
  const sessionTools = ['list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'exploration_todo', 'exploration_graph', 'create_intent', 'manage_intent'].map(tool);
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture, sessionTools });
  await f.openGoalTest();
  await f.startGoalRun();
  await f.send('列出 exploration 的 Worker');
  const call = await waitFor(() => agent.calls[0], 'agent turn with session tools');
  const names = call.options.configuration.tools.map(entry => entry.name);
  for (const name of ['list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'exploration_todo', 'exploration_graph', 'create_intent', 'manage_intent', 'goal_status', 'read_notes', 'read_fact', 'exploration_control']) {
    assert.ok(names.includes(name), `missing session tool ${name}`);
  }
  // Session tools replace the read-only fallbacks instead of duplicating them.
  assert.equal(names.includes('exploration_workers'), false);
  assert.equal(names.includes('exploration_agenda'), false);
  assert.equal(call.options.inspectOnly, true);
  assert.match(call.options.configuration.worker.systemPrompt, /stop_worker/);
  assert.match(call.options.configuration.worker.systemPrompt, /create_intent/);
  assert.match(call.options.configuration.worker.systemPrompt, /exploration_todo/);
});

test('exploration_control stops and resumes the goal run from the chat tools', async t => {
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture });
  await f.openGoalTest();
  await f.startGoalRun();
  await f.send('先停止当前探索，稍后再继续');
  const call = await waitFor(() => agent.calls[0], 'agent turn');
  const control = call.options.configuration.tools.find(tool => tool.name === 'exploration_control');
  const stopped = JSON.parse((await control.execute('stop-run', { action: 'stop' }, new AbortController().signal)).content[0].text);
  assert.equal(stopped.stopped, true);
  await waitFor(() => f.service.state('current').busy === false, 'goal run stopped');
  const interrupted = f.service.state('current');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.canResume, true);
  // Idle runs reject resume until canResume is reported; this one can continue.
  const resumed = JSON.parse((await control.execute('resume-run', { action: 'resume' }, new AbortController().signal)).content[0].text);
  assert.equal(resumed.resumed, true);
  await waitFor(() => f.service.state('current').busy === true, 'goal run resumed');
});

test('agent chat streams partial text and the active tool name, then persists both turns', async t => {
  const agent = agentRunFixture({ hold: true, answer: '结论：仍在侦察。' });
  const f = await fixture(t, { agentRun: agent.fixture });
  await f.openGoalTest();
  await f.send('进度如何？');
  await f.waitForChat(view => view.status === 'running' && view.activity === 'goal_status', 'tool activity while running');
  await f.waitForChat(view => view.streamText === '正在核对探索状态。', 'streamed partial text');
  assert.equal(f.view().canStop, true);
  agent.release();
  await f.waitForChat(view => view.status === 'completed', 'agent turn completed');
  const saved = await f.savedChat(2);
  assert.deepEqual(f.activeMessages(saved).map(message => message.text), ['进度如何？', '结论：仍在侦察。']);
  // A second turn receives the previous exchange as bounded history.
  await f.send('再说一次');
  await waitFor(() => agent.calls.length >= 2, 'second agent turn');
  assert.deepEqual(agent.calls[1].options.messages.map(message => [message.role, message.text]), [
    ['user', '进度如何？'], ['assistant', '结论：仍在侦察。']
  ]);
});

test('cancelling the agent chat interrupts the collaboration turn', async t => {
  const agent = agentRunFixture({ hold: true });
  const f = await fixture(t, { agentRun: agent.fixture });
  await f.openGoalTest();
  await f.send('开始巡检');
  await f.waitForChat(view => view.status === 'running', 'running agent turn');
  assert.equal(f.service.goalChatCancel('current'), true);
  await f.waitForChat(view => view.status === 'interrupted', 'interrupted agent turn');
  assert.equal(f.view().streamText, '');
  assert.equal(f.view().activity, '');
  assert.equal(f.service.isBusy('current'), false);
});

// ---- Bounded host digest and slim sidebar system prompt ----

/**
 * A saturated exploration state for digest tests: 12 intents (=> 12 workers),
 * 20 facts, a 20-row agenda, a 12-row note list and 12 execution rows.
 */
function chatHarnessSeed({ title = index => `议程 ${index}`, statement = index => `事实 ${index}` } = {}) {
  const statuses = ['pending', 'running', 'failed', 'completed'];
  const nodes = [];
  for (let index = 0; index < 12; index++) {
    nodes.push({
      id: `intent-${index}`, kind: 'intent', parentIds: ['root'], childIds: [], resultId: null, producerId: null,
      intent: { description: `方向 ${index}`, status: statuses[index % statuses.length], keyPoints: [] },
      fact: null, attempts: [{ id: `attempt-${index}`, status: 'completed' }]
    });
  }
  for (let index = 0; index < 20; index++) {
    nodes.push({
      id: `fact-${index}`, kind: 'fact', parentIds: ['root'], childIds: [], resultId: null, producerId: null, intent: null,
      fact: { content: JSON.stringify({ outcome: 'confirmed', statement: statement(index) }) }, attempts: []
    });
  }
  return {
    board: { sessionId: 'goal-chat-digest', goal: GOAL.objective, revision: 3, rootId: 'root', nodes },
    agenda: {
      items: Array.from({ length: 20 }, (_, index) => ({
        title: title(index), status: ['planned', 'active', 'blocked', 'done'][index % 4],
        ...(index % 4 === 1 ? { currentStep: `当前步骤 ${index}` } : {}),
        ...(index % 4 === 2 ? { blocker: `受阻 ${index}` } : {})
      })),
      counts: { planned: 5, active: 5, blocked: 5, done: 5, total: 20 }, gaps: [], lastUpdated: null
    },
    graph: { nodes: 40, edges: 55, detail: 'summary' },
    memory: { notes: Array.from({ length: 12 }, (_, index) => ({ content: `笔记 ${index}` })) }
  };
}

const chatDigestOf = systemPrompt => {
  const marker = '## 探索状态（宿主生成）\n';
  const start = systemPrompt.indexOf(marker);
  assert.ok(start >= 0, 'the host digest section is still embedded in the classic prompt');
  return systemPrompt.slice(start + marker.length);
};

const digestLines = (digest, label) => {
  const section = digest.split('\n\n').find(part => part.startsWith(label));
  if (!section) return [];
  return section.split('\n').slice(1).filter(line => line.trim());
};

async function startSeededGoal(f) {
  await f.openGoalTest();
  await f.startGoalRun();
  for (let index = 0; index < 12; index++) {
    f.emit({ type: 'reason.event', event: { type: 'pi_event', event: { type: 'tool_execution_start', toolName: `fixture_tool_${index}`, toolCallId: `call-${index}`, args: { index } } } });
    f.emit({ type: 'reason.event', event: { type: 'pi_event', event: { type: 'tool_execution_end', toolName: `fixture_tool_${index}`, toolCallId: `call-${index}`, result: { content: [{ type: 'text', text: `工具输出 ${index}` }] } } } });
  }
  return f;
}

test('the classic sidebar digest is bounded and caps every exploration source', async t => {
  const f = await fixture(t, { harnessSeed: chatHarnessSeed() });
  await startSeededGoal(f);
  await f.send('现在进展到哪一步了？');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  const systemPrompt = control.context.systemPrompt;
  const digest = chatDigestOf(systemPrompt);
  // Settle the turn first so an assertion failure cannot leave the fixture's
  // model stream open forever.
  control.push('已核对');
  control.finish();
  assert.ok(Buffer.byteLength(systemPrompt, 'utf8') < 6000, `sidebar prompt stays small (${Buffer.byteLength(systemPrompt, 'utf8')} bytes)`);
  assert.ok(digest.length < 3500, `digest should fit one bounded screen (${digest.length} chars)`);
  // Goal/criteria/status stay first even when the run is saturated.
  assert.match(digest, /^目标：验证聊天契约/);
  assert.match(digest, /验收标准/);
  assert.match(digest, /执行状态：/);
  // Each source keeps its newest bounded tail instead of the whole history.
  assert.equal(digestLines(digest, '议程（').length, 12);
  assert.equal(digestLines(digest, '探索任务（').length, 10);
  assert.equal(digestLines(digest, '黑板事实（').length, 10);
  assert.equal(digestLines(digest, '尚未完成的探索方向：').length, 8);
  assert.equal(digestLines(digest, '最近笔记：').length, 6);
  assert.equal(digestLines(digest, '最近活动：').length, 8);
  await f.waitForChat(view => view.status === 'completed', 'digest chat completed');
});

test('the classic digest clips oversized rows and never exceeds the hard cap', async t => {
  const f = await fixture(t, { harnessSeed: chatHarnessSeed({
    title: index => `议程 ${index} ${'长'.repeat(600)}`,
    statement: index => `事实 ${index} ${'证'.repeat(1200)}`
  }) });
  await startSeededGoal(f);
  await f.send('现在进展到哪一步了？');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  const digest = chatDigestOf(control.context.systemPrompt);
  control.push('已核对');
  control.finish();
  assert.ok(digest.length <= 3500, `digest hard cap (${digest.length} chars)`);
  assert.match(digest, /^目标：/);
  assert.match(digest, /…/, 'oversized rows are clipped, not silently dropped');
  await f.waitForChat(view => view.status === 'completed', 'oversized digest chat completed');
});

test('the agent sidebar prompt drops duplicated tool prose but keeps every surface rule and the bounded digest', async t => {
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture, harnessSeed: chatHarnessSeed() });
  await startSeededGoal(f);
  await f.send('列出当前 Worker 和 Reason 状态');
  const call = await waitFor(() => agent.calls[0], 'agent turn');
  const prompt = call.options.configuration.worker.systemPrompt;
  // The tool-meaning prose duplicated the tool schemas the model already
  // receives; the compact availability line and the schemas themselves stay.
  assert.doesNotMatch(prompt, /工具含义/);
  assert.doesNotMatch(prompt, /工作区文件工具/);
  assert.match(prompt, /可用工具：/);
  assert.match(prompt, /## 当前探索摘要（宿主生成，可能已过期；以工具结果为准）/);
  // Every surface rule still ships.
  for (const rule of ['先用对应工具核对', '待核对证据', '先说明将要做什么', '文件操作会真实写入', '没有任何命令执行工具', '用简体中文回答']) {
    assert.match(prompt, new RegExp(rule));
  }
  const marker = '## 当前探索摘要（宿主生成，可能已过期；以工具结果为准）\n';
  const digest = prompt.slice(prompt.indexOf(marker) + marker.length);
  assert.ok(digest.length <= 3500, `agent digest is bounded (${digest.length} chars)`);
  assert.match(digest, /^目标：/);
  assert.ok(prompt.length <= 5000, `agent system prompt stays bounded (${prompt.length} chars)`);
});

// ---- Local image attachments in the exploration sidebar chat ----

test('the classic goal chat sends saved image descriptors and persists them', async t => {
  const f = await fixture(t, { modelInput: ['text', 'image'] });
  await f.openGoalTest();
  const started = await f.sendImages('看看这张截图', [f.image]);
  assert.equal(started.started, true);
  const running = f.view();
  assert.equal(running.status, 'running');
  assert.deepEqual(running.messages[0].images, [f.image]);

  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  const content = control.context.messages.at(-1).content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '看看这张截图');
  const imagePart = content.find(part => part.type === 'image');
  assert.equal(imagePart.mimeType, 'image/png');
  assert.equal(imagePart.data, PNG.toString('base64'));
  control.push('看到了截图');
  control.finish();
  await f.waitForChat(view => view.status === 'completed', 'image chat completed');

  assert.deepEqual(f.view().messages[0].images, [f.image]);
  const record = await f.savedChat(2);
  assert.deepEqual(f.activeMessages(record)[0].images, [f.image], 'goal-chat.json keeps the descriptors, not raw bytes');
  assert.equal(JSON.stringify(record).includes(PNG.toString('base64').slice(0, 64)), false);
  await f.service.close();

  let modelCalls = 0;
  const restored = createHarnessService({
    workspaceRoots: () => [f.directory],
    sdkPath: path.join(f.directory, 'index.mjs'),
    storageDirectory: f.storage,
    readConfiguration: () => { throw new Error('restoring the sidebar conversation must not start the goal runtime'); },
    readChatConfiguration: async () => { modelCalls++; return {}; }
  });
  try {
    const state = await restored.restore({ conversationId: 'current', mode: 'goal', goal: GOAL });
    assert.deepEqual(state.goalChat.messages[0].images, [f.image]);
    assert.equal(modelCalls, 0);
  } finally { await restored.close(); }
});

test('the classic goal chat replays only recent history images and hints at older ones', async t => {
  const f = await fixture(t, { modelInput: ['text', 'image'] });
  await f.openGoalTest();
  for (let index = 0; index < 4; index++) {
    await f.sendImages(`第 ${index + 1} 张截图`, [f.image]);
    const control = await f.waitForChatCount(index + 1).then(() => f.chats[index]);
    control.push(`看到第 ${index + 1} 张`);
    control.finish();
    await f.waitForChat(view => view.status === 'completed' && view.messages.length === (index + 1) * 2, `turn ${index + 1} completed`);
  }
  const messages = f.chats[3].context.messages;
  // History keeps real image parts only for the newest two image-bearing user
  // turns; the older one keeps an actionable local-path hint instead.
  const imagePart = content => content.find(part => part.type === 'image');
  const hint = content => content.find(part => part.type === 'text' && /较早的图片已从上下文移除/.test(part.text));
  assert.equal(imagePart(messages[0].content), undefined);
  assert.match(hint(messages[0].content).text, /本地路径：/);
  assert.match(hint(messages[0].content).text, /read_image/);
  assert.equal(imagePart(messages[2].content)?.mimeType, 'image/png');
  assert.equal(imagePart(messages[4].content)?.mimeType, 'image/png');
  assert.equal(imagePart(messages.at(-1).content)?.mimeType, 'image/png');
});

test('a text-only chat model rejects an image turn but keeps the user message', async t => {
  const f = await fixture(t, { modelInput: ['text'] });
  await f.openGoalTest();
  await assert.rejects(f.sendImages('看看这张图', [f.image]), error => error.code === 'MODEL_IMAGE_UNSUPPORTED');
  const view = f.view();
  assert.equal(view.status, 'failed');
  assert.equal(view.error?.code, 'MODEL_IMAGE_UNSUPPORTED');
  assert.equal(view.messages.length, 1, 'the user message is committed before the turn, like assist mode');
  assert.deepEqual(view.messages[0].images, [f.image]);
  assert.equal(f.chats.length, 0, 'no model request is made for an unsupported image turn');
  // The conversation stays usable: a later text-only turn succeeds.
  await f.send('改用文字继续');
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  control.push('好的');
  control.finish();
  await f.waitForChat(next => next.status === 'completed', 'text-only turn after image rejection');
});

test('goalChatSend validates image descriptors and supports an image-only message', async t => {
  const f = await fixture(t, { modelInput: ['text', 'image'] });
  await f.openGoalTest();
  await assert.rejects(f.sendImages('', []), error => error.code === 'CHAT_MESSAGE_REQUIRED');
  await assert.rejects(f.sendImages('x', [{ ...f.image, id: 'not-hex' }]), error => error.code === 'INVALID_CHAT_IMAGES');
  await assert.rejects(f.sendImages('x', [{ ...f.image, path: 'relative.png' }]), error => error.code === 'INVALID_CHAT_IMAGES');
  await assert.rejects(f.sendImages('x', [{ ...f.image, mimeType: 'image/svg+xml' }]), error => error.code === 'INVALID_CHAT_IMAGES');
  await assert.rejects(f.sendImages('x', Array.from({ length: 5 }, (_, index) => ({ ...f.image, id: `ab12cd3${index}` }))), error => error.code === 'TOO_MANY_IMAGES');
  assert.equal(f.chats.length, 0);

  await f.sendImages('', [f.image]);
  const control = await f.waitForChatCount(1).then(() => f.chats[0]);
  const content = control.context.messages.at(-1).content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '');
  assert.equal(content.find(part => part.type === 'image')?.mimeType, 'image/png');
  control.push('图片已收到');
  control.finish();
  await f.waitForChat(view => view.status === 'completed', 'image-only turn completed');
  assert.equal(f.view().messages[0].text, '');
  assert.deepEqual(f.view().messages[0].images, [f.image]);
  assert.equal(f.view().threads[0].title, 'screen.png');
});

test('the agent goal chat passes image descriptors to runCollaboration and history', async t => {
  const agent = agentRunFixture();
  const f = await fixture(t, { agentRun: agent.fixture, modelInput: ['text', 'image'] });
  await f.openGoalTest();
  await f.sendImages('看看这张截图', [f.image]);
  const call = await waitFor(() => agent.calls[0], 'agent turn with images');
  assert.deepEqual(call.options.images, [f.image]);
  assert.deepEqual(call.options.messages, []);
  await f.waitForChat(view => view.status === 'completed', 'agent image turn completed');
  assert.deepEqual(f.view().messages[0].images, [f.image]);

  // The next turn keeps the previous image descriptors in bounded history.
  await f.send('继续分析');
  await waitFor(() => agent.calls.length >= 2, 'second agent turn');
  assert.deepEqual(agent.calls[1].options.images, []);
  assert.deepEqual(agent.calls[1].options.messages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(agent.calls[1].options.messages[0].images, [f.image]);
});

test('the agent chat offers read_image only to a vision model', async t => {
  const visionAgent = agentRunFixture();
  const vision = await fixture(t, { agentRun: visionAgent.fixture, modelInput: ['text', 'image'], workspaceToolNames: ['list_workspace_files', 'read_image'] });
  await vision.openGoalTest();
  await vision.send('看看工作区里的截图');
  const visionCall = await waitFor(() => visionAgent.calls[0], 'vision agent turn');
  const visionNames = visionCall.options.configuration.tools.map(tool => tool.name);
  assert.ok(visionNames.includes('read_image'), 'a vision chat model may read local images');
  assert.ok(visionNames.includes('list_workspace_files'));
  assert.match(visionCall.options.configuration.worker.systemPrompt, /read_image/);
  assert.match(visionCall.options.configuration.worker.systemPrompt, /截图/);
  await vision.waitForChat(view => view.status === 'completed', 'vision agent turn completed');

  const textAgent = agentRunFixture();
  const textOnly = await fixture(t, { agentRun: textAgent.fixture, modelInput: ['text'], workspaceToolNames: ['list_workspace_files', 'read_image'] });
  await textOnly.openGoalTest();
  await textOnly.send('看看工作区里的截图');
  const textCall = await waitFor(() => textAgent.calls[0], 'text-only agent turn');
  const textNames = textCall.options.configuration.tools.map(tool => tool.name);
  assert.equal(textNames.includes('read_image'), false, 'a text-only chat model never gets an image tool');
  assert.ok(textNames.includes('list_workspace_files'));
  assert.doesNotMatch(textCall.options.configuration.worker.systemPrompt, /read_image/);
  await textOnly.waitForChat(view => view.status === 'completed', 'text-only agent turn completed');
});

// A chat turn whose single tool card returns an image result.
function imageToolRunFixture({ data = PNG.toString('base64'), images = 1 } = {}) {
  const calls = [];
  const fixture = async options => {
    calls.push({ options });
    options.onEvent?.({ type: 'tool_execution_start', toolName: 'read_image', toolCallId: 'img-call' });
    options.onEvent?.({ type: 'tool_execution_end', toolName: 'read_image', toolCallId: 'img-call',
      result: {
        content: [
          ...Array.from({ length: images }, () => ({ type: 'image', data, mimeType: 'image/png' })),
          { type: 'text', text: '{"ok":true}' }
        ],
        details: { exists: true, path: 'screen.png', mimeType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
      } });
    return '图片已读取';
  };
  return { calls, fixture };
}

test('a tool image result is projected into the sidebar chat timeline without truncation', async t => {
  // Longer than the generic 64000-char redaction clamp: the published payload
  // must stay a complete base64 string or the page would render a broken image.
  const data = 'A'.repeat(100000);
  const agent = imageToolRunFixture({ data });
  const f = await fixture(t, { agentRun: agent.fixture, modelInput: ['text', 'image'] });
  await f.openGoalTest();
  await f.send('读取工作区里的截图');
  await f.waitForChat(view => view.status === 'completed', 'agent image tool turn');
  const tool = f.view().messages[1].parts.find(part => part.type === 'tool');
  assert.equal(tool.name, 'read_image');
  assert.equal(tool.image?.mimeType, 'image/png');
  assert.equal(tool.image?.data, data, 'the published base64 is not truncated by redaction');
  assert.equal(tool.image?.width, 1);
  assert.equal(tool.image?.height, 1);
  assert.equal(tool.image?.bytes, PNG.length);
  assert.equal(tool.image?.name, 'screen.png');
  assert.equal(tool.imageOmitted, undefined);
  const saved = await f.savedChat(2);
  assert.equal(f.activeMessages(saved)[1].parts[0].image.data, data, 'the saved timeline keeps the whole payload');
});

test('extra or oversized tool images are reported instead of inlined', async t => {
  const agent = imageToolRunFixture({ images: 2, data: 'ZZZZ' });
  const f = await fixture(t, { agentRun: agent.fixture, modelInput: ['text', 'image'] });
  await f.openGoalTest();
  await f.send('读取两张截图');
  await f.waitForChat(view => view.status === 'completed', 'extra image tool turn');
  const extra = f.view().messages[1].parts.find(part => part.type === 'tool');
  assert.equal(extra.image?.data, 'ZZZZ', 'the first image is still inlined');
  assert.equal(extra.imageOmitted, true, 'the extra image is reported');

  const oversized = imageToolRunFixture({ data: 'A'.repeat(400004) });
  const g = await fixture(t, { agentRun: oversized.fixture, modelInput: ['text', 'image'] });
  await g.openGoalTest();
  await g.send('读取超大截图');
  await g.waitForChat(view => view.status === 'completed', 'oversized image tool turn');
  const huge = g.view().messages[1].parts.find(part => part.type === 'tool');
  assert.equal(Object.hasOwn(huge, 'image'), false);
  assert.equal(huge.imageOmitted, true, 'an image beyond the per-image cap is never inlined');
});

