import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runCollaboration } from '../index.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=', 'base64');
const plain = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const imagePart = request => [...(request.messages.at(-1)?.content ?? [])].find(part => part.type === 'image');

function respond(model, text) {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: 'stop', message });
  return stream;
}

function respondToolCall(model, name, args) {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: 'assistant', content: [{ type: 'toolCall', id: 'call-image', name, arguments: args }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: 'toolUse', message });
  return stream;
}

async function fixture(t, input) {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-image-prompt-'));
  const imagePath = join(directory, 'screen.png');
  await writeFile(imagePath, PNG);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, image: { id: 'screen', name: 'screen.png', mimeType: 'image/png', bytes: PNG.length, path: imagePath },
    configuration: { model: {
      provider: 'image-test', modelId: 'vision', api: 'openai-completions',
      baseUrl: 'https://offline.invalid/v1', apiKey: 'unused-test-key', input,
    }, intools: false, contextSummary: false } };
}

test('collaboration sends the attached image as a Pi image part', async t => {
  let calls = 0;
  const { directory, image, configuration } = await fixture(t, ['text', 'image']);
  configuration.model.streamFn = (model, request) => {
    calls++;
    const part = imagePart(request);
    assert.equal(part?.type, 'image');
    assert.equal(part.mimeType, 'image/png');
    assert.equal(part.data, PNG.toString('base64'));
    assert.match(plain(request.messages.at(-1)), /看看这张图/);
    return respond(model, '看到了');
  };
  const answer = await runCollaboration({ configuration, sessionId: randomUUID(), directory, workspaceRoots: [], text: '看看这张图', images: [image] });
  assert.equal(answer, '看到了');
  assert.equal(calls, 1);
});

test('an image on a text-only model fails before a model request', async t => {
  let calls = 0;
  const { directory, image, configuration } = await fixture(t, ['text']);
  configuration.model.streamFn = model => { calls++; return respond(model, 'should not run'); };
  await assert.rejects(runCollaboration({ configuration, sessionId: randomUUID(), directory, workspaceRoots: [], text: '看看', images: [image] }), error => error.code === 'MODEL_IMAGE_UNSUPPORTED');
  assert.equal(calls, 0);
});

test('stored user images are replayed as image parts in later turns', async t => {
  let seen;
  const { directory, image, configuration } = await fixture(t, ['text', 'image']);
  configuration.model.streamFn = (model, request) => {
    seen = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : []);
    return respond(model, '继续分析');
  };
  const messages = [
    { role: 'user', text: '先看这张图', images: [image] },
    { role: 'assistant', text: '已收到图片' },
  ];
  const answer = await runCollaboration({ configuration, sessionId: randomUUID(), directory, workspaceRoots: [], text: '继续分析', messages });
  assert.equal(answer, '继续分析');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mimeType, 'image/png');
  assert.equal(seen[0].data, PNG.toString('base64'));
});

test('a read_image tool result reaches the next model request as an image part', async t => {
  let calls = 0, seen;
  const { directory, configuration } = await fixture(t, ['text', 'image']);
  configuration.tools = [{
    name: 'custom_image', label: 'custom_image', description: 'read an image',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    async execute() { return { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: '{"bytes":89}' }], details: { bytes: PNG.length } }; }
  }];
  configuration.model.streamFn = (model, request) => {
    calls++;
    if (calls === 1) return respondToolCall(model, 'custom_image', { path: 'screen.png' });
    const result = request.messages.findLast(message => message.role === 'toolResult');
    seen = result?.content?.find(part => part.type === 'image');
    return respond(model, '图片已读取');
  };
  const answer = await runCollaboration({ configuration, sessionId: randomUUID(), directory, workspaceRoots: [], text: '读取图片' });
  assert.equal(answer, '图片已读取');
  assert.equal(calls, 2);
  assert.equal(seen?.mimeType, 'image/png');
  assert.equal(seen?.data, PNG.toString('base64'));
});
