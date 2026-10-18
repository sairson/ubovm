import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { runCollaboration } from '../index.mjs';
import { applyExecutionModes } from '../../../intools/shared/tool-modes.mjs';
import { applyToolRuntime, createParallelGate } from '../../../intools/shared/tool-runtime.mjs';

const model = {
  id: 'fake-tool-model', name: 'fake-tool-model', provider: 'test', api: 'openai-completions',
  baseUrl: 'https://offline.invalid/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 8192,
};

const message = (content, stopReason) => ({
  role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now(),
});

const text = value => ({ type: 'text', text: value });
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function stream(messageValue) {
  const output = new AssistantMessageEventStream();
  output.push({ type: 'start', partial: { ...messageValue, content: [] } });
  output.push({ type: 'done', reason: messageValue.stopReason, message: messageValue });
  return output;
}

const respondText = value => stream(message([text(value)], 'stop'));
const respondTools = calls => stream(message(calls, 'toolUse'));

const modelConfiguration = streamFn => ({
  provider: 'collaboration-test', modelId: 'fake-chat', api: 'openai-completions',
  baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', streamFn,
});

function tool(name, execute) {
  return {
    name, label: name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute,
  };
}

function agentWith(tools, streamFn) {
  return new Agent({
    initialState: { model, thinkingLevel: 'off', systemPrompt: 'test', tools, messages: [] },
    streamFn,
    toolExecution: 'parallel',
  });
}

test('a read-only batch executes concurrently', async () => {
  let active = 0, peak = 0, calls = 0;
  const read = name => tool(name, async id => {
    active++;
    peak = Math.max(peak, active);
    await delay(20);
    active--;
    return { content: [text(id)], details: { id } };
  });
  const tools = applyToolRuntime(applyExecutionModes([
    read('read_workspace_file'), read('read_workspace_code'), read('search_workspace'),
  ]), { gate: createParallelGate(4) });
  const agent = agentWith(tools, (_model, context) => {
    calls++;
    if (calls === 1) return respondTools([
      toolCall('r1', 'read_workspace_file'),
      toolCall('r2', 'read_workspace_code'),
      toolCall('r3', 'search_workspace'),
    ]);
    assert.equal(context.messages.filter(entry => entry.role === 'toolResult').length, 3);
    return respondText('done');
  });
  await agent.prompt('go');
  assert.equal(calls, 2);
  assert.equal(peak, 3);
});

test('one sequential tool keeps the whole mixed batch in source order', async () => {
  let active = 0, peak = 0, calls = 0;
  const order = [];
  const fake = name => tool(name, async id => {
    active++;
    peak = Math.max(peak, active);
    order.push(id);
    await delay(10);
    active--;
    return { content: [text(id)], details: { id } };
  });
  const tools = applyToolRuntime(applyExecutionModes([
    fake('read_workspace_file'), fake('read_workspace_code'), fake('edit_workspace_file'),
  ]), { gate: createParallelGate(4) });
  const agent = agentWith(tools, (_model, context) => {
    calls++;
    if (calls === 1) return respondTools([
      toolCall('r1', 'read_workspace_file'),
      toolCall('r2', 'read_workspace_code'),
      toolCall('e1', 'edit_workspace_file'),
    ]);
    assert.equal(context.messages.filter(entry => entry.role === 'toolResult').length, 3);
    return respondText('done');
  });
  await agent.prompt('go');
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['r1', 'r2', 'e1']);
});

test('the shared gate caps a large read-only batch', async () => {
  let active = 0, peak = 0, calls = 0;
  const read = tool('read_workspace_file', async id => {
    active++;
    peak = Math.max(peak, active);
    await delay(10);
    active--;
    return { content: [text(id)], details: { id } };
  });
  const tools = applyToolRuntime(applyExecutionModes([read]), { gate: createParallelGate(2) });
  const agent = agentWith(tools, (_model, context) => {
    calls++;
    if (calls === 1) return respondTools(Array.from({ length: 5 }, (_, index) => toolCall(`r${index}`, 'read_workspace_file')));
    assert.equal(context.messages.filter(entry => entry.role === 'toolResult').length, 5);
    return respondText('done');
  });
  await agent.prompt('go');
  assert.equal(calls, 2);
  assert.equal(peak, 2);
});

test('a timed-out read reaches the model as an error result without ending the turn', async () => {
  let calls = 0;
  const hanging = tool('read_workspace_file', () => new Promise(() => {}));
  const tools = applyToolRuntime(applyExecutionModes([hanging]), {
    gate: createParallelGate(2),
    timeouts: { read_workspace_file: 20 },
  });
  const agent = agentWith(tools, (_model, context) => {
    calls++;
    if (calls === 1) return respondTools([toolCall('slow', 'read_workspace_file')]);
    const result = context.messages.find(entry => entry.role === 'toolResult');
    assert.equal(result.isError, true);
    assert.match(result.content.map(part => part.text).join(''), /\[TOOL_TIMEOUT\]/);
    return respondText('recovered');
  });
  const started = Date.now();
  await agent.prompt('go');
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1000);
});

test('runCollaboration applies the read-only parallel policy to custom tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-parallel-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let active = 0, peak = 0, calls = 0;
  const fake = name => ({
    name, label: name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async id => {
      active++;
      peak = Math.max(peak, active);
      await delay(20);
      active--;
      return { content: [text(id)], details: { id } };
    },
  });
  const streamFn = (_model, context) => {
    calls++;
    if (calls === 1) return respondTools([
      toolCall('s1', 'search_workspace'),
      toolCall('s2', 'preview_workspace_rename'),
    ]);
    assert.equal(context.messages.filter(entry => entry.role === 'toolResult').length, 2);
    return respondText('done');
  };
  const answer = await runCollaboration({
    configuration: {
      model: modelConfiguration(streamFn), intools: false, contextSummary: false,
      tools: [fake('search_workspace'), fake('preview_workspace_rename')],
    },
    sessionId: randomUUID(), directory, workspaceRoots: [], text: 'go',
  });
  assert.equal(answer, 'done');
  assert.equal(calls, 2);
  assert.equal(peak, 2);
});

test('parallel starts keep source order while ends follow completion order', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-parallel-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const events = [];
  const slow = {
    name: 'search_workspace', label: 'slow', description: 'slow',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => { await delay(40); return { content: [text('slow')], details: {} }; },
  };
  const fast = {
    name: 'preview_workspace_rename', label: 'fast', description: 'fast',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => { await delay(5); return { content: [text('fast')], details: {} }; },
  };
  const streamFn = (_model, context) => {
    calls++;
    if (calls === 1) return respondTools([
      toolCall('slow-id', 'search_workspace'),
      toolCall('fast-id', 'preview_workspace_rename'),
    ]);
    return respondText('done');
  };
  const answer = await runCollaboration({
    configuration: {
      model: modelConfiguration(streamFn), intools: false, contextSummary: false,
      tools: [slow, fast],
    },
    sessionId: randomUUID(), directory, workspaceRoots: [], text: 'go',
    onEvent: event => events.push(event),
  });
  assert.equal(answer, 'done');
  const starts = events.filter(event => event.type === 'tool_execution_start').map(event => event.toolCallId);
  const ends = events.filter(event => event.type === 'tool_execution_end').map(event => event.toolCallId);
  assert.deepEqual(starts, ['slow-id', 'fast-id']);
  assert.deepEqual(ends, ['fast-id', 'slow-id']);
});
