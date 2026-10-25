import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHarnessService } = require('../../ide/runtime/harness-service.cjs');
const sdkPath = fileURLToPath(new URL('../../index.mjs', import.meta.url));

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
const teamModel = () => ({
  provider: 'watch-test', modelId: 'fake-chat', api: 'openai-completions',
  baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key',
  streamFn: (model, request) => {
    const role = memberName(systemText(request)) ?? 'lead';
    if (role === 'reviewer') {
      const created = toolResultValue(request, 'team_task_create');
      const claimed = toolResultValue(request, 'team_task_update');
      const sent = toolResultValue(request, 'send_message');
      if (!created) return respond(model, [toolCall('watch-task', 'team_task_create', {
        subject: '实现成员会话视图', description: '实现会话视图面板与实时更新。', write_scopes: ['src/renderer/webview/team'] })]);
      if (!claimed) return respond(model, [toolCall('watch-claim', 'team_task_update', { task_id: created.id, expected_revision: created.revision, action: 'claim' })]);
      if (claimed.status === 'in_progress' && !sent) return respond(model, [toolCall('watch-complete', 'team_task_update', { task_id: created.id, expected_revision: claimed.revision, action: 'complete' })]);
      if (!sent) return respond(model, [toolCall('watch-send', 'send_message', { target: 'lead', message: '成员会话视图已实现并通过测试。' })]);
      return respond(model, '实现完成：会话视图可打开，历史与实时更新均已验证。');
    }
    const last = lastToolResult(request);
    if (!last) return respond(model, [toolCall('watch-spawn', 'spawn_teammate', {
      name: 'reviewer', description: '实现成员会话视图', prompt: '创建并完成成员会话视图任务，完成后向 Lead 汇报。'
    })]);
    if (last.toolName === 'spawn_teammate') return respond(model, [toolCall('watch-wait', 'wait_agent', { timeout_ms: 12000 })]);
    return respond(model, '成员会话视图任务已由 reviewer 完成。');
  }
});

test('watchTeamMember projects teammate history from the durable transcript and clears cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-watch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conversationId = randomUUID();
  const model = teamModel();
  let resolveMessage;
  const delivered = new Promise(resolve => { resolveMessage = resolve; });
  const service = createHarnessService({
    sdkPath, storageDirectory: directory,
    workspaceRoots: () => [],
    additionalTools: () => [],
    requestToolApproval: undefined,
    askHuman: undefined,
    readConfiguration: async () => ({ model, intools: false, contextSummary: false }),
    onChange: () => {},
    onMessage: (id, message) => { if (id === conversationId && message?.role === 'assistant') resolveMessage(message); }
  });
  try {
    await service.start({ conversationId, mode: 'assist', approvalMode: 'auto', text: '请安排 reviewer 实现成员会话视图并汇报。' });
    const deadline = Date.now() + 20000;
    let message, failure;
    while (Date.now() < deadline) {
      const current = service.state(conversationId);
      if (current.status === 'failed') { failure = current.error; break; }
      if (current.status === 'interrupted') { failure = current.error ?? { message: 'interrupted' }; break; }
      const raced = await Promise.race([delivered.then(value => ({ message: value })), new Promise(resolve => setTimeout(() => resolve(undefined), 100))]);
      if (raced?.message) { message = raced.message; break; }
      if (service.state(conversationId).status === 'completed') break;
    }
    assert(message, 'assistant message was delivered: ' + JSON.stringify(failure ?? service.state(conversationId).error ?? service.state(conversationId).status));
    const before = service.state(conversationId);
    assert(before.team?.roster?.some(row => row.name === 'reviewer'), 'roster is projected before watching');
    await assert.rejects(service.watchTeamMember({ conversationId, name: 'nobody' }), { code: 'TEAM_MEMBER_NOT_FOUND' });
    const opened = await service.watchTeamMember({ conversationId, name: 'reviewer' });
    assert.deepEqual(opened, { watching: 'reviewer' });
    const state = service.state(conversationId);
    assert(state.team?.roster?.some(row => row.name === 'reviewer'), 'roster is projected');
    const watch = state.teamWatch;
    assert.equal(watch.name, 'reviewer');
    assert.equal(watch.role, 'teammate');
    assert.equal(watch.running, false);
    assert.equal(watch.live.parts.length, 0);
    assert.equal(watch.history.loading, undefined);
    const entries = watch.history.entries;
    assert(entries.length >= 3, 'history has user and assistant entries');
    const user = entries.find(entry => entry.role === 'user');
    assert.match(user.text, /成员会话视图任务|Team message from lead/);
    const assistantEntries = entries.filter(entry => entry.role === 'assistant');
    assert(assistantEntries.length >= 1);
    const tool = assistantEntries.flatMap(entry => entry.parts ?? []).find(part => part.type === 'tool' && part.name === 'team_task_create');
    assert(tool, 'history keeps teammate tool cards');
    assert.equal(tool.status, 'completed');
    assert.match(tool.output, /实现成员会话视图/);
    await service.watchTeamMember({ conversationId, name: null });
    assert.equal('teamWatch' in service.state(conversationId), false);
  } finally {
    await service.close();
  }
});

test('watching a teammate while it runs exposes live state and refreshes history when it settles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-team-watch-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conversationId = randomUUID();
  let releaseMember, memberStream;
  const message = (model, content, stopReason) => assistant(model, content, stopReason);
  const base = teamModel();
  const model = {
    ...base,
    streamFn: (modelInfo, request) => {
      const role = memberName(systemText(request)) ?? 'lead';
      if (role === 'reviewer' && !memberStream) {
        // Keep the teammate's first turn in flight so the test can watch it.
        const stream = new AssistantMessageEventStream();
        const pending = message(modelInfo, [toolCall('live-task', 'team_task_create', {
          subject: '实时成员视图', description: '保持运行以便观察实时状态。', write_scopes: ['src/renderer/webview/team'] })], 'toolUse');
        stream.push({ type: 'start', partial: { ...pending, content: [] } });
        memberStream = { stream, pending };
        releaseMember = () => stream.push({ type: 'done', reason: 'toolUse', message: pending });
        return stream;
      }
      return base.streamFn(modelInfo, request);
    }
  };
  let resolveDelivered;
  const delivered = new Promise(resolve => { resolveDelivered = resolve; });
  const service = createHarnessService({
    sdkPath, storageDirectory: directory, workspaceRoots: () => [], additionalTools: () => [],
    readConfiguration: async () => ({ model, intools: false, contextSummary: false }),
    onChange: () => {},
    onMessage: (id, value) => { if (id === conversationId && value?.role === 'assistant') resolveDelivered(value); }
  });
  try {
    await service.start({ conversationId, mode: 'assist', approvalMode: 'auto', text: '让 reviewer 实时展示成员视图。' });
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = service.state(conversationId);
      if (state.team?.roster?.some(row => row.name === 'reviewer')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(state.team?.roster?.some(row => row.name === 'reviewer'), 'reviewer is provisioned while the lead waits');
    await service.watchTeamMember({ conversationId, name: 'reviewer' });
    const live = service.state(conversationId).teamWatch;
    assert.equal(live.name, 'reviewer');
    assert.equal(live.running, true);
    assert.equal(live.status, 'running');
    assert.deepEqual(live.live.parts, []);
    releaseMember();
    const answer = await Promise.race([delivered, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('live assist run timed out')), 20000);
      if (typeof timer.unref === 'function') timer.unref();
    })]);
    assert.match(answer.text, /成员会话视图任务已由 reviewer 完成/);
    let settled;
    for (let attempt = 0; attempt < 100; attempt++) {
      settled = service.state(conversationId).teamWatch;
      if (settled && settled.running === false && settled.history.loading === undefined) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(settled.running, false);
    assert.equal(settled.live.parts.length, 0);
    assert(settled.history.entries.some(entry => entry.role === 'user'), 'settled history reloaded from the transcript');
    assert(settled.history.entries.filter(entry => entry.role === 'assistant').length >= 1);
  } finally {
    releaseMember?.();
    await service.close();
  }
});

