import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runCollaboration } from '../index.mjs';

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

test('live user steering reaches the next model request in the same turn and is unregistered at completion', async t => {
  let steer, calls = 0;
  const options = await fixture(t, (model, request) => {
    if (++calls === 1) {
      steer({ text: '改为验证队列隔离', context: { file: 'queue.js' } });
      return respond(model, '原方向的中间输出');
    }
    assert(request.messages.some(message => message.role === 'user' && plain(message).includes('改为验证队列隔离')));
    assert(request.messages.some(message => plain(message).includes('queue.js')));
    return respond(model, '已按新方向验证');
  });
  const answer = await runCollaboration({ ...options, text: '检查队列', registerSteering: handler => { steer = handler; } });
  assert.equal(answer, '已按新方向验证');
  assert.equal(calls, 2);
  assert.equal(steer, undefined);
});

test('an interrupted turn retains accepted but unconsumed steering for the next request', async t => {
  let steer, recovering = false;
  const controller = new AbortController();
  const options = await fixture(t, (model, request) => {
    if (!recovering) {
      steer({ text: '保留这条引导', context: { file: 'important.js' } });
      controller.abort(Error('user interrupted'));
      return respond(model, 'partial');
    }
    const text = request.messages.map(plain).join('\n');
    assert.match(text, /原始任务/); assert.match(text, /保留这条引导/); assert.match(text, /important.js/);
    assert.match(text, /previous turn was interrupted/);
    return respond(model, 'continued with history');
  });
  await assert.rejects(runCollaboration({ ...options, text: '原始任务', signal: controller.signal, registerSteering: handler => { steer = handler; } }), /interrupt/);
  recovering = true;
  assert.equal(await runCollaboration({ ...options, text: '继续' }), 'continued with history');
});

test('steering unregister invalidates retained callbacks even when it is reentrant and throws', async t => {
  let retained;
  const options = await fixture(t, model => respond(model, 'done'));
  await assert.rejects(runCollaboration({ ...options, text: 'first', registerSteering: handler => {
    if (handler) { retained = handler; return; }
    assert.throws(() => retained({ text: 'too late' }), { code: 'STEERING_CLOSED' });
    throw Error('unregister failed');
  } }), /unregister failed/);
  assert.throws(() => retained({ text: 'still too late' }), { code: 'STEERING_CLOSED' });
  assert.equal(await runCollaboration({ ...options, text: 'second' }), 'done', 'failed cleanup notification must release storage');
});

test('direct SDK steering bounds bursts and invalid requests do not consume capacity', async t => {
  let steer, calls = 0;
  const options = await fixture(t, (model, request) => {
    if (++calls === 1) {
      for (let i = 0; i < 150; i++) assert.throws(() => steer({ text: '' }), { code: 'INVALID_STEERING' });
      for (let i = 0; i < 100; i++) steer({ text: 'direction-' + i });
      assert.throws(() => steer({ text: 'overflow' }), { code: 'STEERING_LIMIT' });
      return respond(model, 'intermediate');
    }
    assert.equal(request.messages.filter(message => plain(message).includes('direction-')).length, 100);
    assert(!request.messages.some(message => plain(message).includes('overflow')));
    return respond(model, 'done');
  });
  assert.equal(await runCollaboration({ ...options, text: 'first', registerSteering: handler => { steer = handler; } }), 'done');
  assert.equal(calls, 2);
});

test('cancellation during steering context serialization never enqueues a new instruction', async t => {
  let steer;
  const controller = new AbortController();
  const reason = Error('stop during serialization');
  const options = await fixture(t, model => {
    assert.throws(() => steer({ text: 'must not run', context: { toJSON() { controller.abort(reason); return {}; } } }), error => error === reason);
    return respond(model, 'stopped');
  });
  await assert.rejects(runCollaboration({ ...options, text: 'first', signal: controller.signal, registerSteering: handler => { if (handler) steer = handler; } }), error => error === reason);
  assert.throws(() => steer({ text: 'late' }), { code: 'STEERING_CLOSED' });
});

test('reentrant steering serialization cannot exceed the admission bound', async t => {
  let steer, calls = 0;
  const options = await fixture(t, (model, request) => {
    if (++calls === 1) {
      steer({ text: 'outer', context: { toJSON() {
        for (let i = 0; i < 99; i++) steer({ text: 'nested-' + i });
        assert.throws(() => steer({ text: 'overflow' }), { code: 'STEERING_LIMIT' });
        return {};
      } } });
      return respond(model, 'intermediate');
    }
    assert.equal(request.messages.filter(message => plain(message).includes('nested-')).length, 99);
    assert(!request.messages.some(message => plain(message).includes('overflow')));
    return respond(model, 'done');
  });
  assert.equal(await runCollaboration({ ...options, text: 'first', registerSteering: handler => { steer = handler; } }), 'done');
});

test('steering during a tool preserves its completed result and adjusts the following model call', async t => {
  let steer, effects = 0;
  const options = await fixture(t, (model, request) => {
    if (!toolResults(request, 'fixture_action').length) return respond(model, [toolCall('effect', 'fixture_action')]);
    assert(request.messages.some(message => message.role === 'user' && plain(message).includes('只汇报结果')));
    assert.equal(plain(toolResults(request, 'fixture_action')[0]), 'already done');
    return respond(model, '按引导汇报');
  }, { tools: [{ name: 'fixture_action', label: 'Action', description: 'Test', parameters: { type: 'object', properties: {} },
    execute: async () => { effects++; steer({ text: '只汇报结果' }); return { content: [{ type: 'text', text: 'already done' }] }; } }] });
  assert.equal(await runCollaboration({ ...options, text: '执行检查', registerSteering: handler => { steer = handler; } }), '按引导汇报');
  assert.equal(effects, 1);
});

test('multiple steering inputs at one boundary are observed together in order', async t => {
  let steer, calls = 0;
  const options = await fixture(t, (model, request) => {
    if (++calls === 1) {
      steer({ text: '先检查 A' }); steer({ text: '补充：优先检查 B' });
      return respond(model, 'intermediate');
    }
    const text = request.messages.map(plain).join('\n');
    assert(text.indexOf('先检查 A') < text.indexOf('补充：优先检查 B'));
    assert(text.includes('补充：优先检查 B'));
    return respond(model, 'combined');
  });
  assert.equal(await runCollaboration({ ...options, text: 'original', registerSteering: handler => { steer = handler; } }), 'combined');
  assert.equal(calls, 2);
});

test('steering wakes the automatic worker barrier without cancelling or waiting for that worker', { timeout: 5000 }, async t => {
  let steer, releaseWorker, mainCalls = 0, wakeTimer;
  t.after(() => clearTimeout(wakeTimer));
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const stream = new AssistantMessageEventStream();
      releaseWorker = () => stream.push({ type: 'done', reason: 'stop', message: assistant(model, 'worker done') });
      return stream;
    }
    if (++mainCalls === 1) return respond(model, [toolCall('spawn', 'spawn_worker', { task: 'Slow check' })]);
    if (mainCalls === 2) {
      wakeTimer = setTimeout(() => steer({ text: '立即调整方向' }), 30);
      return respond(model, 'provisional');
    }
    assert(request.messages.some(message => plain(message).includes('立即调整方向')));
    assert.equal(typeof releaseWorker, 'function');
    releaseWorker();
    return respond(model, 'adjusted');
  });
  assert.equal(await runCollaboration({ ...options, text: 'delegate', registerSteering: handler => { steer = handler; } }), 'adjusted');
});

test('a missing Pi model profile is rejected before consuming a Swarm slot', async t => {
  const events = [];
  const options = await fixture(t, (model, request) => {
    if (!toolResults(request, 'manage_harness_project').length) return respond(model, [toolCall('define-missing', 'manage_harness_project', {
      action: 'define', profile: { name: 'missing-model', instructions: 'Inspect', modelProfile: 'deleted' },
    })]);
    if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('spawn-missing', 'spawn_worker', { task: 'Inspect', profile: 'missing-model@1' })]);
    assert.equal(toolResults(request, 'spawn_worker')[0].isError, true);
    assert.match(plain(toolResults(request, 'spawn_worker')[0]), /Unknown host model profile/);
    return respond(model, 'Configuration missing.');
  });
  options.configuration.collaboration = { backendSelection: 'autonomous' };
  assert.equal(await runCollaboration({ ...options, text: 'Try unavailable model', onEvent: event => events.push(event) }), 'Configuration missing.');
  assert.equal(events.filter(event => event.type === 'agent.backend').length, 1);
  assert(!events.some(event => event.type === 'swarm.worker.event'));
});

test('autonomous Swarm selects multiple Pi model profiles and persists their identity', async t => {
  const events = [], models = Object.fromEntries(['fast', 'review'].map(id => [id, modelConfiguration(model => respond(model, id + ' done'))]));
  const options = await fixture(t, (model, request) => {
    if (!toolResults(request, 'spawn_worker').length) return respond(model, ['fast', 'review'].map(id => toolCall(id, 'spawn_worker', { task: 'Inspect', modelProfile: id })));
    assert(toolResults(request, 'spawn_worker').every(result => !result.isError));
    if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait', 'wait_workers')]);
    return respond(model, 'Both done');
  }, { collaboration: { backendSelection: 'autonomous', models } });
  assert.equal(await runCollaboration({ ...options, text: 'Select models', onEvent: e => events.push(e) }), 'Both done');
  const children = events.filter(e => e.type === 'agent.backend' && e.workerId !== options.sessionId);
  assert.deepEqual(children.map(e => e.backend), ['pi', 'pi']);
  assert.deepEqual(children.map(e => e.modelProfile).sort(), ['fast', 'review']);
});

test('fixed mode rejects profile-based backend overrides even when another model is configured', async t => {
  let invoked = false;
  const events = [];
  const options = await fixture(t, (model, request) => {
    if (!toolResults(request, 'manage_harness_project').length) return respond(model, [toolCall('fixed-profile', 'manage_harness_project', {
      action: 'define', profile: { name: 'other', instructions: 'Inspect', modelProfile: 'other' },
    })]);
    if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('fixed-spawn', 'spawn_worker', { task: 'Inspect', profile: 'other@1' })]);
    assert.equal(toolResults(request, 'spawn_worker')[0].isError, true);
    assert.match(plain(toolResults(request, 'spawn_worker')[0]), /disabled in configuration/);
    return respond(model, 'Fixed enforced');
  }, { collaboration: { models: { other: modelConfiguration(() => { invoked = true; }) } } });
  assert.equal(await runCollaboration({ ...options, text: 'Use another backend', onEvent: event => events.push(event) }), 'Fixed enforced');
  assert.equal(invoked, false);
  assert.equal(events.filter(event => event.type === 'agent.backend').length, 1);
});

test('a Worker authors a Harness profile and launches a constrained child; profiles survive the next turn', async t => {
  let sawProfile = false, recovering = false;
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const prompt = plain(request.messages.find(message => message.role === 'user'));
      if (prompt.startsWith('profile-child')) {
        assert.match(prompt, /Verify the runtime only/);
        sawProfile = true;
        const denied = toolResults(request, 'manage_harness_project');
        if (!denied.length) return respond(model, [toolCall('not-allowed', 'manage_harness_project', { action: 'define', profile: { name: 'escape', instructions: 'Should not be created' } })]);
        assert.equal(denied[0].isError, true, 'tools outside the profile must not execute');
        if (!toolResults(request, 'inspect_harness').length) return respond(model, [toolCall('runtime', 'inspect_harness')]);
        return respond(model, 'Checked');
      }
      const defined = toolResults(request, 'manage_harness_project');
      if (!defined.length) return respond(model, [toolCall('define', 'manage_harness_project', { action: 'define', profile: {
        name: 'runtime-checker', instructions: 'Verify the runtime only', allowedTools: ['inspect_harness'], maxModelCalls: 4
      } })]);
      if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('child', 'spawn_worker', {
        task: 'profile-child', profile: JSON.parse(plain(defined[0])).profiles[0].id
      })]);
      if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait-child', 'wait_workers', {})]);
      return respond(model, 'Custom Harness executed');
    }
    if (recovering) {
      const listed = toolResults(request, 'manage_harness_project');
      if (!listed.length) return respond(model, [toolCall('profiles', 'manage_harness_project', { action: 'list' })]);
      assert.deepEqual(JSON.parse(plain(listed.at(-1))).profiles.map(profile => profile.name), ['runtime-checker']);
      return respond(model, 'Profile restored');
    }
    if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('architect', 'spawn_worker', { task: 'Design a Harness profile and run it' })]);
    if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait', 'wait_workers', {})]);
    return respond(model, 'Done');
  });
  const events = [];
  assert.equal(await runCollaboration({ ...options, text: 'Customize task execution', onEvent: event => events.push(event) }), 'Done');
  assert.equal(sawProfile, true, JSON.stringify(events.filter(event => event.type === 'swarm.status').at(-1)));
  recovering = true;
  assert.equal(await runCollaboration({ ...options, text: 'List the saved Harness' }), 'Profile restored');
});

test('restricted Workers cannot widen a child profile or consume a worker slot on rejection', async t => {
  let rejected = false;
  const options = await fixture(t, (model, request) => {
    const defined = toolResults(request, 'manage_harness_project');
    if (childRequest(request)) {
      if (!defined.length) return respond(model, [toolCall('widen', 'manage_harness_project', { action: 'define', profile: {
        name: 'wide-child', instructions: 'Read results', allowedTools: ['read_worker_result']
      } })]);
      const spawned = toolResults(request, 'spawn_worker');
      if (!spawned.length) return respond(model, [toolCall('forbidden-child', 'spawn_worker', { task: 'must not start', profile: JSON.parse(plain(defined[0])).profiles[0].id })]);
      assert.equal(spawned[0].isError, true);
      assert.match(plain(spawned[0]), /unavailable tool/);
      const roster = toolResults(request, 'list_workers');
      if (!roster.length) return respond(model, [toolCall('roster', 'list_workers')]);
      const listed = JSON.parse(plain(roster[0]));
      assert.equal(listed.workers.length, 0);
      assert.equal(listed.capacity.remaining_workers, 11);
      rejected = true;
      return respond(model, 'Rejected before dispatch');
    }
    if (!defined.length) return respond(model, [toolCall('parent-profile', 'manage_harness_project', { action: 'define', profile: {
      name: 'restricted-parent', instructions: 'Check scope inheritance', allowedTools: ['manage_harness_project', 'spawn_worker', 'list_workers']
    } })]);
    if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('parent', 'spawn_worker', { task: 'Check child scope', profile: JSON.parse(plain(defined[0])).profiles[0].id })]);
    if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait', 'wait_workers', {})]);
    return respond(model, 'Checked');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Check inheritance' }), 'Checked');
  assert.equal(rejected, true);
});

test('Harness preflight reports environment mismatches without saving or launching work', async t => {
  const options = await fixture(t, (model, request) => {
    const results = toolResults(request, 'manage_harness_project');
    if (!results.length) return respond(model, [toolCall('preview', 'manage_harness_project', { action: 'validate', project: { version: 1, profiles: [
      { name: 'compatible', instructions: 'Check runtime', allowedTools: ['inspect_harness'], maxModelCalls: 10 },
      { name: 'incompatible', instructions: 'Requires absent tool', allowedTools: ['missing_environment_tool'] }
    ] } })]);
    if (results.length === 1) {
      const preview = JSON.parse(plain(results[0]));
      assert.equal(preview.valid, false);
      assert.deepEqual(preview.profiles[0].effectiveTools, ['inspect_harness']);
      assert.equal(preview.profiles[0].maxModelCalls, 4, 'host worker ceiling remains effective');
      assert.equal(preview.profiles[1].valid, false);
      return respond(model, [toolCall('list-after-preview', 'manage_harness_project', { action: 'list' })]);
    }
    assert.deepEqual(JSON.parse(plain(results.at(-1))).profiles, []);
    return respond(model, 'Checked without changes');
  }, { worker: { maxModelCalls: 4 } });
  const events = [];
  assert.equal(await runCollaboration({ ...options, text: 'Validate the environment', onEvent: event => events.push(event) }), 'Checked without changes');
  assert(events.filter(event => event.type === 'swarm.status').every(event => event.workers.length === 0));
});

test('Harness model budget is shared by coordinator and workers', async t => {
  let modelCalls = 0;
  const options = await fixture(t, (model, request) => {
    modelCalls++;
    if (childRequest(request)) return respond(model, 'Worker complete');
    if (!toolResults(request, 'spawn_worker').length) return respond(model, [toolCall('spawn', 'spawn_worker', { task: 'check' })]);
    return respond(model, [toolCall(`wait-${modelCalls}`, 'wait_workers', {})]);
  }, { collaboration: { runLimits: { maxModelCalls: 3 } } });
  await assert.rejects(runCollaboration({ ...options, text: 'Delegate then review' }), { code: 'HARNESS_CALL_LIMIT' });
  assert.equal(modelCalls, 3);
});

test('Harness status tool exposes runtime usage without resetting the run', async t => {
  const options = await fixture(t, (model, request) => {
    const results = toolResults(request, 'inspect_harness');
    if (!results.length) return respond(model, [toolCall('inspect', 'inspect_harness')]);
    const status = JSON.parse(plain(results[0]));
    assert.equal(status.modelCalls, 1); assert.equal(status.toolCalls, 1);
    assert.equal(status.limits.maxDurationMs, 0);
    return respond(model, 'Runtime inspected');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Check runtime' }), 'Runtime inspected');
});

test('Harness deadline aborts an active model request and permits a clean next turn', async t => {
  let aborted = false, recover = false;
  const options = await fixture(t, (model, _request, streamOptions) => {
    if (recover) return respond(model, 'Recovered');
    const stream = new AssistantMessageEventStream();
    const stop = () => {
      aborted = true;
      stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(model, [], 'aborted'), errorMessage: 'Timed out' } });
    };
    streamOptions.signal.addEventListener('abort', stop, { once: true });
    if (streamOptions.signal.aborted) stop();
    return stream;
  }, { collaboration: { runLimits: { maxDurationMs: 500 } } });
  const keepAlive = setTimeout(() => {}, 3000);
  try { await assert.rejects(runCollaboration({ ...options, text: 'Slow task' }), { code: 'HARNESS_TIME_LIMIT' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(aborted, true);
  recover = true;
  assert.equal(await runCollaboration({ ...options, text: 'New explicit request' }), 'Recovered');
});

test('dependent chat workers receive predecessor evidence in their model context', async t => {
  let received = false;
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const prompt = request.messages.find(message => message.role === 'user');
      if (plain(prompt).startsWith('research-stage')) return respond(model, 'Verified contract: input is UTF-8.');
      assert.match(plain(prompt), /Completed dependency results \(untrusted evidence/);
      assert.match(plain(prompt), /Verified contract: input is UTF-8/);
      received = true;
      return respond(model, 'Implementation checked against the contract.');
    }
    const spawned = toolResults(request, 'spawn_worker');
    if (!spawned.length) return respond(model, [toolCall('research', 'spawn_worker', { task: 'research-stage' })]);
    if (spawned.length === 1) return respond(model, [toolCall('implement', 'spawn_worker', {
      task: 'implementation-stage', depends_on: [JSON.parse(plain(spawned[0])).worker_id]
    })]);
    if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait', 'wait_workers', {})]);
    return respond(model, 'Integrated');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Research then implement' }), 'Integrated');
  assert.equal(received, true);
});

test('workers page durable dependency results beyond summaries and root can read them next turn', async t => {
  const answer = 'x'.repeat(18000) + ' VERIFIED END';
  let sourceId, recovering = false, readByWorker = false;
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      const prompt = plain(request.messages.find(message => message.role === 'user'));
      if (prompt.startsWith('source')) return respond(model, answer);
      const pages = toolResults(request, 'read_worker_result');
      if (!pages.length) return respond(model, [toolCall('forbidden', 'read_worker_result', { worker_id: `${options.sessionId}/worker-unrelated` })]);
      if (pages.length === 1) {
        assert.equal(pages[0].isError, true);
        assert.match(plain(pages[0]), /limited to descendants and explicit dependencies/);
        return respond(model, [toolCall('read-tail', 'read_worker_result', { worker_id: sourceId, offset: 18000, limit: 100 })]);
      }
      const page = JSON.parse(plain(pages.at(-1)));
      assert.equal(page.text, ' VERIFIED END');
      assert.equal(page.total, answer.length);
      assert.equal(page.nextOffset, null);
      assert.equal(page.sourceTruncated, false);
      readByWorker = true;
      return respond(model, 'Tail verified');
    }
    if (recovering) {
      const pages = toolResults(request, 'read_worker_result');
      if (!pages.length) return respond(model, [toolCall('restored-page', 'read_worker_result', { worker_id: sourceId, offset: 17999, limit: 2 })]);
      const page = JSON.parse(plain(pages.at(-1)));
      assert.equal(page.text, 'x ');
      assert.equal(page.nextOffset, 18001);
      assert.equal(page.sourceTruncated, false);
      return respond(model, 'Restored result');
    }
    const spawned = toolResults(request, 'spawn_worker');
    if (!spawned.length) return respond(model, [toolCall('source', 'spawn_worker', { task: 'source' })]);
    sourceId = JSON.parse(plain(spawned[0])).worker_id;
    if (spawned.length === 1) return respond(model, [toolCall('reader', 'spawn_worker', { task: 'reader', depends_on: [sourceId] })]);
    if (!toolResults(request, 'wait_workers').length) return respond(model, [toolCall('wait', 'wait_workers', {})]);
    return respond(model, 'Complete');
  });
  assert.equal(await runCollaboration({ ...options, text: 'Read long result' }), 'Complete');
  assert.equal(readByWorker, true);
  recovering = true;
  assert.equal(await runCollaboration({ ...options, text: 'Read saved result' }), 'Restored result');
});

test('read_worker_result reports an in-progress worker without marking the tool failed', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const options = await fixture(t, (model, request) => {
    if (childRequest(request)) {
      started.resolve();
      return finish.promise.then(() => respond(model, 'child done'));
    }
    const spawned = toolResults(request, 'spawn_worker');
    if (!spawned.length) return respond(model, [toolCall('slow', 'spawn_worker', { task: 'slow-child' })]);
    const worker_id = JSON.parse(plain(spawned[0])).worker_id;
    const pages = toolResults(request, 'read_worker_result');
    if (!pages.length) return started.promise.then(() => respond(model, [toolCall('peek', 'read_worker_result', { worker_id })]));
    assert.equal(pages[0].isError, false);
    const peek = JSON.parse(plain(pages[0]));
    assert.equal(peek.available, false);
    assert.equal(['queued', 'running', 'waiting'].includes(peek.status), true);
    assert.match(peek.guidance, /wait_workers/);
    assert.match(peek.guidance, /has not failed/);
    if (!toolResults(request, 'wait_workers').length) {
      finish.resolve();
      return respond(model, [toolCall('wait', 'wait_workers')]);
    }
    return respond(model, 'Integrated');
  });
  try {
    assert.equal(await runCollaboration({ ...options, text: 'Peek while running' }), 'Integrated');
  } finally {
    finish.resolve();
  }
});

test('durable notes publish before tool completion and survive immediate cancellation', async t => {
  let recovering = false;
  const options = await fixture(t, model => recovering ? respond(model, 'Restored')
    : respond(model, [toolCall('save-note', 'note', { action: 'write', content: 'Saved before cancellation' })]),
  { intools: { allowedTools: ['note'] } });
  const controller = new AbortController(), events = [];
  await assert.rejects(runCollaboration({ ...options, text: 'Save a note', signal: controller.signal, onEvent(event) {
    events.push(event);
    if (event.type === 'memory.status' && event.memory.notes.length) controller.abort(new Error('Stop after durable write'));
  } }), /Stop after durable write/);
  const saved = events.find(event => event.type === 'memory.status' && event.memory.notes.length);
  assert.equal(saved.memory.notes[0].content, 'Saved before cancellation');
  assert.equal(events.some(event => event.type === 'tool_execution_end'), false, 'the persisted update must arrive before tool completion');
  recovering = true;
  const restored = [];
  assert.equal(await runCollaboration({ ...options, text: 'Continue', onEvent: event => restored.push(event) }), 'Restored');
  assert.equal(restored.find(event => event.type === 'memory.status').memory.notes[0].content, 'Saved before cancellation');
});

test('chat can cancel a child, await cleanup and finish without cancelling the parent turn', { timeout: 5000 }, async t => {
  let notifyStarted, childAborted = false, childCalls = 0;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const approvals = [];
  const options = await fixture(t, async (model, request, streamOptions) => {
    if (childRequest(request)) {
      childCalls++;
      const stream = new AssistantMessageEventStream();
      const abort = () => {
        childAborted = true;
        stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(model, [], 'aborted'), errorMessage: 'Child cancelled.' } });
      };
      streamOptions.signal.addEventListener('abort', abort, { once: true });
      if (streamOptions.signal.aborted) abort();
      notifyStarted();
      return stream;
    }
    const spawned = toolResults(request, 'spawn_worker').at(-1);
    if (!spawned) return respond(model, [toolCall('spawn-cancel-target', 'spawn_worker', { task: 'Wait for cancellation.' })]);
    await started;
    const { worker_id } = JSON.parse(plain(spawned));
    if (!toolResults(request, 'cancel_workers').length) return respond(model, [toolCall('cancel-child', 'cancel_workers', { worker_ids: [worker_id], reason: 'No longer needed' })]);
    const waited = toolResults(request, 'wait_workers').at(-1);
    if (!waited) return respond(model, [toolCall('confirm-cleanup', 'wait_workers', { worker_ids: [worker_id], mode: 'all' })]);
    assert.equal(JSON.parse(plain(waited)).workers[0].status, 'interrupted');
    return respond(model, 'Child stopped; parent completed.');
  });
  const answer = await runCollaboration({ ...options, text: 'Manage an obsolete child.', requestToolApproval: request => { approvals.push(request.toolName); return true; } });
  assert.equal(answer, 'Child stopped; parent completed.');
  assert.equal(childAborted, true);
  assert.equal(childCalls, 1);
  assert.ok(approvals.includes('cancel_workers'));
});

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
  assert.equal(recoveryRequest.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && ['spawn-interrupted', 'wait-interrupted'].includes(part.id))), true);
  for (const id of ['spawn-interrupted', 'wait-interrupted']) assert(recoveryRequest.messages.some(message => message.role === 'toolResult' && message.toolCallId === id), 'interrupted tool calls must remain paired');
  assert.match(recoveryRequest.messages.filter(message => message.role === 'system').map(plain).join('\n'), /interrupt|cancel|previous turn/i);
  assert.ok(events.some(event => event.type === 'swarm.worker.event'));
});

test('long-running workers do not repeat a tool ID after its settled evidence is trimmed', async t => {
  let calls = 0, effects = 0;
  const options = await fixture(t, (model, request) => {
    calls++;
    if (calls <= 80) return respond(model, [toolCall(`effect-${calls}`, 'record_effect')]);
    if (calls === 81) return respond(model, [toolCall('effect-1', 'record_effect')]);
    const duplicate = toolResults(request, 'record_effect').at(-1);
    assert.equal(duplicate.isError, true);
    assert.match(plain(duplicate), /already attempted/);
    return respond(model, 'Completed without repeating effects');
  }, { tools: [{ name: 'record_effect', label: 'Record', description: 'Record a test effect', parameters: { type: 'object', properties: {} },
    execute: async () => { effects++; return { content: [{ type: 'text', text: 'Recorded' }] }; } }] });
  assert.equal(await runCollaboration({ ...options, text: 'Run a long task' }), 'Completed without repeating effects');
  assert.equal(effects, 80);
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

test('chat enforces the model-call budget and retains completed tool evidence in the next transcript', async t => {
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
  assert.equal(recoveryRequest.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'budget-list'), true);
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

test('collaboration closes its database when memory unsubscribe fails and permits the next turn', async t => {
  const { MemoryStore } = await import('../../../intools/shared/store/memory-store.mjs');
  const options = await fixture(t, model => respond(model, 'done'), { intools: { knowledge: false, allowedTools: [] } });
  const expected = new Error('collaboration unsubscribe failed');
  const original = MemoryStore.prototype.subscribe;
  const mock = t.mock.method(MemoryStore.prototype, 'subscribe', function(listener) {
    const unsubscribe = original.call(this, listener);
    return () => { unsubscribe(); throw expected; };
  });
  await assert.rejects(runCollaboration({ ...options, text: 'first turn' }), error => error instanceof AggregateError && error.errors.includes(expected));
  mock.mock.restore();
  assert.equal(await runCollaboration({ ...options, text: 'next turn' }), 'done');
});
