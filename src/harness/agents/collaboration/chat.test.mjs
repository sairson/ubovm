import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runCollaboration } from './index.mjs';

const plain = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const childRequest = request => request.messages.some(message => message.role === 'system' && plain(message).includes('You are a Swarm Worker'));
const toolResults = (request, name) => request.messages.filter(message => message.role === 'toolResult' && message.toolName === name);
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

function assistant(model, content, stopReason = 'stop') {
  return {
    role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function respond(model, content) {
  const stream = new AssistantMessageEventStream();
  const message = assistant(model, content, Array.isArray(content) && content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop');
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}

function modelConfiguration(streamFn) {
  return {
    provider: 'collaboration-test', modelId: 'fake-chat', api: 'openai-completions',
    baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn,
  };
}

async function fixture(t, streamFn, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-collaboration-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory, sessionId: randomUUID(), workspaceRoots: [],
    configuration: { model: modelConfiguration(streamFn), intools: false, contextSummary: false, ...overrides },
  };
}

test('chat answers directly and persists a conversation without duplicating the submitted UI message', async t => {
  const requests = [], events = [];
  const options = await fixture(t, (model, request) => {
    requests.push(structuredClone(request));
    assert.equal(childRequest(request), false);
    return respond(model, requests.length === 1 ? '你好，我记住了蓝色。' : '你刚才选择的是蓝色。');
  });

  assert.equal(await runCollaboration({ ...options, text: '记住蓝色',
    messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好！' }, { role: 'user', text: '记住蓝色' }],
    onEvent: event => events.push(event),
  }), '你好，我记住了蓝色。');
  assert.equal(requests[0].messages.filter(message => message.role === 'user' && plain(message) === '记住蓝色').length, 1);
  assert.ok(requests[0].messages.some(message => message.role === 'assistant' && plain(message) === '你好！'));

  assert.equal(await runCollaboration({ ...options, text: '我选择了什么？', messages: [] }), '你刚才选择的是蓝色。');
  assert.ok(requests[1].messages.some(message => message.role === 'user' && plain(message) === '记住蓝色'));
  assert.ok(requests[1].messages.some(message => message.role === 'assistant' && plain(message) === '你好，我记住了蓝色。'));
  assert.equal(requests[1].messages.filter(message => message.role === 'user' && plain(message) === '我选择了什么？').length, 1);
  assert.ok(events.some(event => event.type === 'message_end' && plain(event.message) === '你好，我记住了蓝色。'));
  assert.equal(events.some(event => event.type === 'swarm.worker.event'), false);
});

test('chat delegates to separate conversational worker loops and aggregates their tool-backed results', async t => {
  const events = [], children = new Map();
  let mainCalls = 0;
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const task = request.messages.find(message => message.role === 'user' && plain(message).includes('inspect-'));
      assert.ok(task, 'each worker receives its own task');
      const name = plain(task).includes('inspect-alpha') ? 'alpha' : 'beta';
      children.set(name, (children.get(name) ?? 0) + 1);
      if (!toolResults(request, 'read_workspace_file').length) {
        return respond(model, [toolCall(`read-${name}`, 'read_workspace_file', { path: `${name}.txt` })]);
      }
      assert.match(plain(toolResults(request, 'read_workspace_file').at(-1)), new RegExp(`${name}-evidence`));
      return respond(model, `${name}: verified ${name}-evidence`);
    }
    if (++mainCalls === 1) return respond(model, [
      toolCall('spawn-alpha', 'spawn_worker', { name: 'Alpha', task: 'inspect-alpha' }),
      toolCall('spawn-beta', 'spawn_worker', { name: 'Beta', task: 'inspect-beta' }),
    ]);
    if (mainCalls === 2) {
      const spawned = toolResults(request, 'spawn_worker').map(message => JSON.parse(plain(message)));
      assert.equal(spawned.length, 2);
      assert.equal(new Set(spawned.map(worker => worker.worker_id)).size, 2);
      return respond(model, [toolCall('wait-both', 'wait_workers', { worker_ids: spawned.map(worker => worker.worker_id), timeout_ms: 1000 })]);
    }
    const waited = JSON.parse(plain(toolResults(request, 'wait_workers').at(-1)));
    assert.equal(waited.workers.length, 2);
    assert.ok(waited.workers.every(worker => worker.status === 'completed'));
    assert.ok(waited.workers.some(worker => worker.result === 'alpha: verified alpha-evidence'));
    assert.ok(waited.workers.some(worker => worker.result === 'beta: verified beta-evidence'));
    return respond(model, 'Both files verified: alpha-evidence and beta-evidence.');
  });
  await Promise.all(['alpha', 'beta'].map(name => writeFile(join(options.directory, `${name}.txt`), `${name}-evidence\n`)));
  const approvals = [];
  const answer = await runCollaboration({ ...options, workspaceRoots: [options.directory], text: 'Verify both files with workers.', onEvent: event => events.push(event),
    requestToolApproval: request => { approvals.push(request); return true; } });
  assert.equal(approvals.filter(request => request.toolName === 'spawn_worker').length, 2);
  assert.equal(approvals.filter(request => request.toolName === 'read_workspace_file' && request.workerId !== options.sessionId).length, 2);
  assert.ok(approvals.some(request => request.toolName === 'wait_workers'));
  assert.equal(answer, 'Both files verified: alpha-evidence and beta-evidence.');
  assert.deepEqual([...children].sort(), [['alpha', 2], ['beta', 2]]);
  const childEvents = events.filter(event => event.type === 'swarm.worker.event');
  assert.equal(new Set(childEvents.map(event => event.workerId)).size, 2);
  assert.ok(childEvents.some(event => event.event.type === 'tool_execution_end' && event.event.toolName === 'read_workspace_file'));
  assert.equal(events.some(event => event.type === 'message_end' && /^alpha:|^beta:/.test(plain(event.message))), false,
    'worker answers must stay out of the main response stream');
  assert.ok(events.some(event => event.type === 'swarm.status' && event.workers.filter(worker => worker.status === 'completed').length === 2));
});

test('a main chat that finishes early receives settled worker evidence before returning its final answer', async t => {
  let mainCalls = 0, releaseWorker, notifyWorkerStarted;
  const workerStarted = new Promise(resolve => { notifyWorkerStarted = resolve; });
  const options = await fixture(t, async (model, request) => {
    if (childRequest(request)) {
      const stream = new AssistantMessageEventStream();
      releaseWorker = () => {
        const message = assistant(model, 'The worker independently verified 42.');
        stream.push({ type: 'done', reason: 'stop', message });
      };
      notifyWorkerStarted();
      return stream;
    }
    if (++mainCalls === 1) return respond(model, [toolCall('spawn-for-barrier', 'spawn_worker', { task: 'Verify the number.' })]);
    if (mainCalls === 2) {
      // Complete the worker only once the main agent has tried to finish.
      await workerStarted;
      assert.equal(typeof releaseWorker, 'function');
      releaseWorker();
      return respond(model, 'Provisional answer without inspecting the worker.');
    }
    assert.match(request.messages.map(plain).join('\n'), /worker independently verified 42/);
    return respond(model, 'The verified result is 42.');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Delegate and report the verified result.' }), 'The verified result is 42.');
  assert.equal(mainCalls, 3);
});

test('worker model failures reach the parent as failed work without a completed result', async t => {
  let mainCalls = 0, childCalls = 0;
  const events = [];
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      childCalls++;
      const stream = new AssistantMessageEventStream();
      const message = { ...assistant(model, [], 'error'), errorMessage: 'Offline worker model unavailable.' };
      stream.push({ type: 'error', reason: 'error', error: message });
      return stream;
    }
    if (++mainCalls === 1) return respond(model, [toolCall('spawn-failing-worker', 'spawn_worker', { task: 'Attempt an independent check.' })]);
    if (mainCalls === 2) return respond(model, [toolCall('wait-failing-worker', 'wait_workers', { timeout_ms: 1000 })]);
    const waited = JSON.parse(plain(toolResults(request, 'wait_workers').at(-1)));
    assert.equal(waited.workers.length, 1);
    assert.equal(waited.workers[0].status, 'failed');
    assert.match(waited.workers[0].error, /Offline worker model unavailable/);
    assert.equal(waited.workers[0].result, undefined);
    return respond(model, 'The independent check failed because its worker model was unavailable.');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Delegate this check.', onEvent: event => events.push(event) }),
    'The independent check failed because its worker model was unavailable.');
  assert.equal(childCalls, 1);
  assert.ok(events.some(event => event.type === 'swarm.status' && event.workers.some(worker => worker.status === 'failed')));
  assert.equal(events.some(event => event.type === 'swarm.status' && event.workers.some(worker => worker.status === 'completed')), false);
});

test('concurrent worker todos share durable memory while tool-call identities remain scoped to each owner', { timeout: 10000 }, async t => {
  let mainCalls = 0, childStarts = 0, recovering = false, recoveryCalls = 0, releaseWorkers;
  const bothStarted = new Promise(resolve => { releaseWorkers = resolve; });
  const events = [], boards = [];
  const verifyBoard = message => {
    assert.equal(Boolean(message.isError), false);
    const board = JSON.parse(plain(message));
    assert.deepEqual(board.items.map(item => item.content).sort(), ['alpha durable todo', 'beta durable todo']);
    assert.equal(new Set(board.items.map(item => item.worker_id)).size, 2);
    assert.ok(board.items.every(item => item.owner === 'false'));
    boards.push(board.items.map(item => ({ id: item.id, worker_id: item.worker_id, content: item.content })).sort((left, right) => left.content.localeCompare(right.content)));
  };
  const options = await fixture(t, async (model, request) => {
    if (childRequest(request)) {
      const task = request.messages.find(message => message.role === 'user');
      const name = plain(task).includes('memory-alpha') ? 'alpha' : 'beta';
      if (!toolResults(request, 'todo').length) {
        if (++childStarts === 2) releaseWorkers();
        await bothStarted;
        // Providers can produce the same ID in independent worker conversations.
        return respond(model, [toolCall('same-worker-tool-id', 'todo', { action: 'write', items: [{ content: `${name} durable todo` }] })]);
      }
      const written = toolResults(request, 'todo').at(-1);
      assert.equal(Boolean(written.isError), false, 'another worker reusing the ID must not block this write');
      assert.ok(JSON.parse(plain(written)).items.some(item => item.content === `${name} durable todo` && item.owner === 'true'));
      return respond(model, `${name} saved its todo.`);
    }
    if (recovering) {
      if (++recoveryCalls === 1) {
        assert.ok(request.messages.some(message => message.role === 'user' && plain(message) === 'Save two worker todos.'));
        assert.ok(request.messages.some(message => message.role === 'assistant' && plain(message) === 'Both worker todos are saved.'));
        const memory = request.messages.find(message => message.role === 'user' && plain(message).startsWith('Session memory'));
        assert.match(plain(memory), /alpha durable todo/);
        assert.match(plain(memory), /beta durable todo/);
        return respond(model, [toolCall('list-persisted-todos', 'todo', { action: 'list' })]);
      }
      verifyBoard(toolResults(request, 'todo').at(-1));
      return respond(model, 'Both worker todos survived the next turn.');
    }
    if (++mainCalls === 1) return respond(model, [
      toolCall('spawn-memory-alpha', 'spawn_worker', { task: 'memory-alpha: save your own todo.' }),
      toolCall('spawn-memory-beta', 'spawn_worker', { task: 'memory-beta: save your own todo.' }),
    ]);
    if (mainCalls === 2) return respond(model, [toolCall('wait-memory-workers', 'wait_workers', { timeout_ms: 1000 })]);
    if (mainCalls === 3) {
      const waited = JSON.parse(plain(toolResults(request, 'wait_workers').at(-1)));
      assert.equal(waited.workers.length, 2);
      assert.ok(waited.workers.every(worker => worker.status === 'completed'));
      return respond(model, [toolCall('list-shared-todos', 'todo', { action: 'list' })]);
    }
    verifyBoard(toolResults(request, 'todo').at(-1));
    return respond(model, 'Both worker todos are saved.');
  }, { intools: { allowedTools: ['todo', 'note'] }, collaboration: { maxConcurrency: 2 } });

  assert.equal(await runCollaboration({ ...options, text: 'Save two worker todos.', onEvent: event => events.push(event) }), 'Both worker todos are saved.');
  assert.equal(childStarts, 2);
  assert.ok(events.some(event => event.type === 'swarm.status' && event.workers.filter(worker => worker.status === 'running').length === 2));
  const evidence = events.findLast(event => event.type === 'memory.status').memory.toolEvidence.filter(entry => entry.toolCallId === 'same-worker-tool-id');
  assert.equal(evidence.length, 2);
  assert.equal(new Set(evidence.map(entry => entry.workerId)).size, 2);
  assert.ok(evidence.every(entry => !entry.isError));

  recovering = true;
  assert.equal(await runCollaboration({ ...options, text: 'List the saved worker todos.' }), 'Both worker todos survived the next turn.');
  assert.equal(childStarts, 2, 'restoring shared memory must not restart old workers');
  assert.deepEqual(boards[1], boards[0], 'both owners and todo identities survive persistence');
});

test('nested workers release a single concurrency slot while waiting for their children', { timeout: 10000 }, async t => {
  let mainCalls = 0, parentCalls = 0, leafCalls = 0;
  const snapshots = [];
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const task = request.messages.find(message => message.role === 'user');
      if (plain(task).includes('nested-leaf')) {
        leafCalls++;
        return respond(model, 'Leaf evidence: 42.');
      }
      assert.match(plain(task), /nested-parent/);
      if (++parentCalls === 1) return respond(model, [toolCall('spawn-leaf', 'spawn_worker', { task: 'nested-leaf: verify the value.' })]);
      if (parentCalls === 2) return respond(model, [toolCall('parent-wait', 'wait_workers', { timeout_ms: 1000 })]);
      const waited = JSON.parse(plain(toolResults(request, 'wait_workers').at(-1)));
      assert.equal(waited.workers.length, 1);
      assert.equal(waited.workers[0].depth, 2);
      assert.equal(waited.workers[0].result, 'Leaf evidence: 42.');
      return respond(model, 'Parent verified the leaf evidence: 42.');
    }
    if (++mainCalls === 1) return respond(model, [toolCall('spawn-parent', 'spawn_worker', { task: 'nested-parent: delegate verification.' })]);
    if (mainCalls === 2) {
      const parent = JSON.parse(plain(toolResults(request, 'spawn_worker').at(-1)));
      return respond(model, [toolCall('main-wait-parent', 'wait_workers', { worker_ids: [parent.worker_id], timeout_ms: 1000 })]);
    }
    const waited = JSON.parse(plain(toolResults(request, 'wait_workers').at(-1)));
    assert.equal(waited.workers[0].status, 'completed');
    assert.equal(waited.workers[0].result, 'Parent verified the leaf evidence: 42.');
    return respond(model, 'Nested verification completed: 42.');
  }, { collaboration: { maxConcurrency: 1, maxWorkers: 2, maxDepth: 2 } });

  assert.equal(await runCollaboration({ ...options, text: 'Delegate nested verification.',
    onEvent: event => { if (event.type === 'swarm.status') snapshots.push(structuredClone(event.workers)); },
  }), 'Nested verification completed: 42.');
  assert.equal(mainCalls, 3);
  assert.equal(parentCalls, 3);
  assert.equal(leafCalls, 1);
  assert.ok(snapshots.some(workers => workers.some(worker => worker.depth === 1 && worker.status === 'waiting')));
  assert.ok(snapshots.every(workers => workers.filter(worker => worker.status === 'running').length <= 1));
  assert.ok(snapshots.some(workers => workers.length === 2 && workers.every(worker => worker.status === 'completed')));
});

test('cancelling a waiting conversation aborts its worker and does not replay its tools on the next turn', async t => {
  const controller = new AbortController();
  let phase = 'baseline', childCalls = 0, childAborted = false, cancelled = false, recoveryRequest, notifyWorkerStarted;
  const workerStarted = new Promise(resolve => { notifyWorkerStarted = resolve; });
  const events = [];
  const options = await fixture(t, async (model, request, streamOptions) => {
    if (childRequest(request)) {
      childCalls++;
      const stream = new AssistantMessageEventStream();
      const abort = () => {
        childAborted = true;
        const message = { ...assistant(model, [], 'aborted'), errorMessage: 'Test cancelled worker.' };
        stream.push({ type: 'error', reason: 'aborted', error: message });
      };
      streamOptions.signal.addEventListener('abort', abort, { once: true });
      if (streamOptions.signal.aborted) abort();
      notifyWorkerStarted();
      return stream;
    }
    if (phase === 'baseline') return respond(model, 'The previous successful answer.');
    if (phase === 'recover') {
      recoveryRequest = structuredClone(request);
      return respond(model, 'Ready for the next request.');
    }
    if (!toolResults(request, 'spawn_worker').some(message => message.toolCallId === 'spawn-interrupted')) {
      return respond(model, [toolCall('spawn-interrupted', 'spawn_worker', { task: 'Wait until cancelled.' })]);
    }
    await workerStarted;
    const spawned = JSON.parse(plain(toolResults(request, 'spawn_worker').at(-1)));
    return respond(model, [toolCall('wait-interrupted', 'wait_workers', { worker_ids: [spawned.worker_id], timeout_ms: 1000 })]);
  });
  await runCollaboration({ ...options, text: 'Establish a successful turn.' });
  phase = 'cancel';
  await assert.rejects(runCollaboration({ ...options, text: 'Start an interruptible worker.', signal: controller.signal,
    onEvent: event => {
      events.push(event);
      if (event.type === 'tool_execution_start' && event.toolName === 'wait_workers' && !cancelled) {
        cancelled = true;
        controller.abort(new Error('Intentional test cancellation'));
      }
    },
  }), /cancel|abort|interrupt/i);
  assert.equal(childCalls, 1);
  assert.equal(childAborted, true);
  phase = 'recover';
  assert.equal(await runCollaboration({ ...options, text: 'Continue with a new request.' }), 'Ready for the next request.');
  assert.equal(childCalls, 1, 'the cancelled worker must not restart on the next user turn');
  assert.ok(recoveryRequest.messages.some(message => message.role === 'assistant' && plain(message) === 'The previous successful answer.'));
  assert.equal(recoveryRequest.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && ['spawn-interrupted', 'wait-interrupted'].includes(part.id))), false);
  assert.match(recoveryRequest.messages.filter(message => message.role === 'system').map(plain).join('\n'), /interrupt|cancel|previous turn/i);
  assert.ok(events.some(event => event.type === 'swarm.worker.event'));
});

for (const explicit of [false, true]) test(`chat continues beyond former model and tool limits (${explicit ? 'explicit zero' : 'defaults'})`, async t => {
  let calls = 0;
  const options = await fixture(t, model => {
    calls++;
    return respond(model, calls <= 65 ? [toolCall(`long-run-${calls}`, 'list_workers')] : 'Long run completed.');
  }, explicit ? { worker: { maxModelCalls: 0, maxToolCalls: 0 }, collaboration: { maxModelCalls: 0, maxToolCalls: 0 } } : {});
  assert.equal(await runCollaboration({ ...options, text: 'Complete a long-running task.' }), 'Long run completed.');
  assert.equal(calls, 66);
});

test('chat rejects invalid collaboration limits before making a model request', async t => {
  let modelCalls = 0;
  const options = await fixture(t, model => { modelCalls++; return respond(model, 'Unexpected call.'); });
  for (const [name, value] of [['maxModelCalls', -1], ['maxToolCalls', -1], ['maxModelCalls', 1.5], ['maxToolCalls', Infinity], ['maxConcurrency', 0], ['maxWorkers', 0], ['maxDepth', -1]]) {
    await assert.rejects(runCollaboration({ ...options, text: 'Check limits.',
      configuration: { ...options.configuration, collaboration: { [name]: value } },
    }), TypeError, `${name} must be validated`);
  }
  assert.equal(modelCalls, 0);
});

test('chat enforces the model-call budget and keeps an unsuccessful tool turn out of the next transcript', async t => {
  let calls = 0, recoveryRequest;
  const options = await fixture(t, (model, request) => {
    calls++;
    if (calls === 1) return respond(model, [toolCall('budget-list', 'list_workers')]);
    recoveryRequest = request;
    return respond(model, 'A fresh turn completed.');
  }, { collaboration: { maxModelCalls: 1 } });
  await assert.rejects(runCollaboration({ ...options, text: 'Exhaust the model budget.' }), error => /BUDGET/.test(error.code) && /1/.test(error.message));
  assert.equal(calls, 1, 'the forbidden request must not reach the model transport');
  assert.equal(await runCollaboration({ ...options, text: 'Try a new turn.' }), 'A fresh turn completed.');
  assert.equal(recoveryRequest.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'budget-list'), false);
});

test('chat enforces the tool-call budget before executing another tool in the same batch', async t => {
  let modelCalls = 0;
  const events = [];
  const options = await fixture(t, model => {
    modelCalls++;
    return respond(model, [toolCall('allowed-list', 'list_workers'), toolCall('denied-spawn', 'spawn_worker', { task: 'This must never run.' })]);
  }, { collaboration: { maxToolCalls: 1 } });
  await assert.rejects(runCollaboration({ ...options, text: 'Exhaust the tool budget.', onEvent: event => events.push(event) }),
    error => /BUDGET/.test(error.code) && /1/.test(error.message));
  assert.equal(modelCalls, 1);
  assert.equal(events.some(event => event.type === 'swarm.worker.event'), false);
});

test('approval blocks side effects until explicitly granted and fails closed', async t => {
  for (const decision of [true, false, 'true', undefined, 'error']) {
    let executed = 0, calls = 0, requested, release;
    const ready = new Promise(resolve => { requested = resolve; });
    const permission = new Promise(resolve => { release = resolve; });
    const options = await fixture(t, (model, request) => {
      if (++calls === 1) return respond(model, [toolCall('review', 'fixture_action', { value: 'exact-args' })]);
      assert.equal(toolResults(request, 'fixture_action').at(-1).isError, decision !== true);
      return respond(model, 'finished');
    }, { tools: [{ name: 'fixture_action', label: 'Action', description: 'Test action', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, execute: async () => { executed++; return { content: [{ type: 'text', text: 'done' }] }; } }] });
    const pending = runCollaboration({ ...options, text: 'Review operation', requestToolApproval: async request => {
      assert.deepEqual(request.args, { value: 'exact-args' }); requested(); await permission;
      if (decision === 'error') throw new Error('UI unavailable');
      return decision;
    } });
    await ready;
    assert.equal(executed, 0);
    release();
    await pending;
    assert.equal(executed, decision === true ? 1 : 0);
  }
});

test('cancelling a pending approval exits without executing even if approval arrives late', async t => {
  let requested, release, executed = 0;
  const ready = new Promise(resolve => { requested = resolve; });
  const permission = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const options = await fixture(t, model => respond(model, [toolCall('cancel-approval', 'fixture_action')]), {
    tools: [{ name: 'fixture_action', label: 'Action', description: 'Test', parameters: { type: 'object', properties: {} }, execute: async () => { executed++; return { content: [] }; } }]
  });
  const pending = runCollaboration({ ...options, text: 'Cancelled action', signal: controller.signal, requestToolApproval: () => { requested(); return permission; } });
  await ready;
  controller.abort(new Error('stop pending approval'));
  await assert.rejects(pending, /stop pending approval/);
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed, 0);
});
