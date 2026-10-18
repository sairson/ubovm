const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelConnectionTest, describeError } = require('../../../host/system/model-connection-test.cjs');

test('model connection test classifies auth, missing model, and timeout failures', () => {
  assert.match(describeError({ status: 401, message: 'unauthorized' }), /认证失败/);
  assert.match(describeError({ status: 404, message: 'model not found' }), /模型或接口不存在/);
  assert.match(describeError({ status: 404, message: 'Model Not Exist' }), /模型或接口不存在/);
  assert.match(describeError({ code: 'ETIMEDOUT', message: 'timeout' }), /连接超时/);
  assert.match(describeError({ code: 'ECONNREFUSED' }), /被拒绝/);
  assert.match(describeError({ message: 'secret-key-value failed' }), /模型连接失败/);
  assert.doesNotMatch(describeError({ message: 'secret-key-value failed' }), /secret-key-value/);
  assert.match(describeError(new TypeError('Invalid streamOptions.reasoning')), /模型配置无效/);
  assert.match(describeError(new TypeError('Invalid streamOptions.reasoning')), /Invalid streamOptions.reasoning/);
  assert.match(describeError(new TypeError('Cannot convert argument to a ByteString because the character at index 7 has a value of 27169 which is greater than 255.')), /非英文字符/);
});

test('model connection test explains DeepSeek balance, context, reasoning and overload failures', () => {
  assert.match(describeError({ status: 402, message: 'Insufficient Balance' }), /余额或额度不足/);
  assert.match(describeError({ status: 429, message: 'insufficient_quota' }), /余额或额度不足/);
  assert.match(describeError({ status: 400, message: "This model's maximum context length is 65536 tokens" }), /上下文窗口/);
  assert.match(describeError({ status: 400, message: 'reasoning_effort is not supported for this model' }), /推理\/思考参数/);
  assert.match(describeError({ status: 503, message: 'Service Unavailable' }), /服务暂时不可用/);
  assert.match(describeError({ status: 400, message: 'Invalid Request' }), /请求参数无效/);
});

test('model connection test rejects non-Latin1 API keys before calling the provider', async () => {
  let created = 0;
  const service = createModelConnectionTest({
    loadModelClient: async () => ({
      createModelClient: () => { created++; throw new Error('should not create client'); }
    })
  });
  const result = await service.test({
    provider: 'openai', modelId: 'gpt', api: 'openai-completions', baseUrl: 'https://example.test',
    apiKey: '模型密钥-sk-test'
  });
  assert.equal(result.ok, false);
  assert.equal(created, 0);
  assert.match(result.message, /非英文字符/);
});

test('model connection test times out an unresponsive stream and allows retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = createModelConnectionTest({
    loadModelClient: async () => ({
      createModelClient: () => ({
        model: { id: 'test' },
        streamFn: async () => ({ result: () => blocked })
      })
    })
  });
  const pending = service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', baseUrl: 'https://example.test', apiKey: 'sk-test' });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
  release({ stopReason: 'stop' });
  assert.equal((await service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', baseUrl: 'https://example.test', apiKey: 'sk-test' })).ok, true);
});

test('model connection test rejects missing API keys and concurrent attempts', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = createModelConnectionTest({
    loadModelClient: async () => ({
      createModelClient: () => ({
        model: { id: 'test' },
        streamFn: async (_model, _input, options) => {
          started();
          return {
            result: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
          };
        }
      })
    })
  });
  assert.match((await service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', apiKey: '' })).message, /API Key/);
  const pending = service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', apiKey: 'sk-test' });
  await ready;
  assert.match((await service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', apiKey: 'sk-test' })).message, /正在测试/);
  service.dispose();
  assert.equal((await pending).ok, false);
  assert.match((await service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', apiKey: 'sk-test' })).message, /已关闭/);
});

test('successful model connection test sends hi with minimal options and returns elapsed time', async () => {
  let configuration, context, options;
  const service = createModelConnectionTest({
    loadModelClient: async () => ({
      createModelClient: value => {
        configuration = value;
        return {
          model: { id: 'gpt', provider: 'openai', api: 'openai-completions', baseUrl: 'https://example.test' },
          streamFn: async (_model, input, requestOptions) => {
            context = input;
            options = requestOptions;
            return { result: async () => ({ stopReason: 'stop' }) };
          }
        };
      }
    })
  });
  const result = await service.test({
    provider: 'openai', modelId: 'gpt', api: 'openai-completions', baseUrl: 'https://example.test', apiKey: 'sk-test',
    reasoning: 'high', maxTokens: 4096, compat: { foo: true }
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.durationMs, 'number');
  assert.match(result.message, /连接成功/);
  assert.equal(configuration.streamOptions?.reasoning, undefined);
  assert.equal(configuration.reasoning, undefined);
  assert.equal(configuration.maxTokens, undefined);
  assert.equal(configuration.compat, undefined);
  assert.equal(configuration.streamOptions.maxTokens, 16);
  assert.equal(configuration.streamOptions.maxRetries, 0);
  assert.equal(context.messages[0].content[0].text, 'hi');
  assert.equal(options.maxTokens, 16);
  assert.equal(options.reasoning, undefined);
});

test('model connection test surfaces createModelClient validation failures clearly', async () => {
  const service = createModelConnectionTest({
    loadModelClient: async () => ({
      createModelClient: () => { throw new TypeError('Invalid streamOptions.reasoning'); }
    })
  });
  const result = await service.test({ provider: 'openai', modelId: 'gpt', api: 'openai-completions', baseUrl: 'https://example.test', apiKey: 'sk-test' });
  assert.equal(result.ok, false);
  assert.match(result.message, /模型配置无效：Invalid streamOptions.reasoning/);
});
