import { createProvider, lazyApi } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

const APIS = new Set([
  'anthropic-messages', 'openai-completions', 'openai-responses', 'openai-codex-responses',
  'azure-openai-responses', 'google-generative-ai', 'google-vertex', 'mistral-conversations',
  'bedrock-converse-stream', 'pi-messages',
]);
const OPTIONS = new Set([
  'model', 'provider', 'modelId', 'api', 'baseUrl', 'contextWindow', 'maxTokens', 'reasoning',
  'input', 'compat', 'headers', 'apiKey', 'getApiKey', 'streamFn', 'streamOptions',
]);
const STREAM_OPTIONS = new Set([
  'temperature', 'maxTokens', 'timeoutMs', 'maxRetries', 'maxRetryDelayMs', 'websocketConnectTimeoutMs',
  'transport', 'cacheRetention', 'sessionId', 'fetch', 'onPayload', 'onResponse', 'samplingParams',
  'metadata', 'env', 'reasoning', 'thinkingBudgets', 'toolChoice',
]);
const MODEL_FIELDS = new Set([
  'id', 'name', 'api', 'provider', 'baseUrl', 'reasoning', 'thinkingLevelMap', 'input', 'cost',
  'promptCache', 'contextWindow', 'maxTokens', 'samplingParams', 'headers', 'compat',
]);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

function positive(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} integer`);
}

function finiteJson(value, name) {
  const visit = (item, seen = new Set()) => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new TypeError(`${name} must contain finite JSON data`);
    if (!Array.isArray(item)) object(item, name);
    seen.add(item);
    for (const value of Object.values(item)) visit(value, seen);
    seen.delete(item);
  };
  visit(value);
  return structuredClone(value);
}

function headers(value, name) {
  if (value === undefined) return {};
  object(value, name);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key) ||
        (item !== null && (typeof item !== 'string' || /[\r\n\0]/u.test(item)))) {
      throw new TypeError(`${name} must contain valid HTTP header names and string or null values`);
    }
    result[key.toLowerCase()] = item;
  }
  return result;
}

function endpoint(value) {
  string(value, 'model.baseUrl');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('model.baseUrl must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('model.baseUrl must be an HTTP(S) URL without credentials or a fragment');
  }
}

function validateModel(model) {
  object(model, 'model');
  for (const key of ['id', 'name', 'api', 'provider']) string(model[key], `model.${key}`);
  const catalog = getBuiltinModel(model.provider, model.id);
  for (const key of Object.keys(model)) {
    if (!MODEL_FIELDS.has(key) && !Object.hasOwn(catalog ?? {}, key)) throw new TypeError(`Unknown model field: ${key}`);
  }
  // Some official providers resolve their endpoint from live host environment;
  // preserve that catalog convention without allowing an empty custom URL.
  if (!(model.baseUrl === '' && catalog?.baseUrl === '' && model.api === catalog.api)) endpoint(model.baseUrl);
  if (typeof model.reasoning !== 'boolean') throw new TypeError('model.reasoning must be a boolean');
  if (!Array.isArray(model.input) || !model.input.length || new Set(model.input).size !== model.input.length ||
      model.input.some(value => !['text', 'image'].includes(value))) throw new TypeError('model.input must contain text and/or image');
  positive(model.contextWindow, 'model.contextWindow');
  positive(model.maxTokens, 'model.maxTokens');
  if (model.maxTokens > model.contextWindow && !(model.maxTokens === catalog?.maxTokens && model.contextWindow === catalog.contextWindow)) {
    throw new TypeError('model.maxTokens must not exceed model.contextWindow');
  }
  object(model.cost, 'model.cost');
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (!Number.isFinite(model.cost[key]) || (model.cost[key] < 0 && model.cost[key] !== catalog?.cost[key])) {
      throw new TypeError(`model.cost.${key} must be a nonnegative finite number`);
    }
  }
  if (model.compat !== undefined) object(model.compat, 'model.compat');
  return finiteJson(model, 'model');
}

function streamDefaults(value = {}) {
  object(value, 'streamOptions');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!STREAM_OPTIONS.has(key)) throw new TypeError(`Unknown streamOptions field: ${key}`);
    if (['fetch', 'onPayload', 'onResponse'].includes(key)) {
      if (typeof item !== 'function') throw new TypeError(`streamOptions.${key} must be a function`);
      result[key] = item;
    } else result[key] = finiteJson(item, `streamOptions.${key}`);
    if (['maxTokens', 'timeoutMs', 'websocketConnectTimeoutMs'].includes(key)) positive(item, `streamOptions.${key}`);
    if (['maxRetries', 'maxRetryDelayMs'].includes(key)) positive(item, `streamOptions.${key}`, true);
    if (key === 'temperature' && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) throw new TypeError('streamOptions.temperature must be nonnegative and finite');
    if (key === 'sessionId') string(item, 'streamOptions.sessionId');
    if (key === 'transport' && !['sse', 'websocket', 'websocket-cached', 'auto'].includes(item)) throw new TypeError('Invalid streamOptions.transport');
    if (key === 'cacheRetention' && !['none', 'short', 'long'].includes(item)) throw new TypeError('Invalid streamOptions.cacheRetention');
    if (key === 'reasoning' && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item)) throw new TypeError('Invalid streamOptions.reasoning');
    if (['samplingParams', 'metadata', 'thinkingBudgets', 'env'].includes(key)) object(item, `streamOptions.${key}`);
    if (key === 'env' && Object.values(item).some(value => typeof value !== 'string')) throw new TypeError('streamOptions.env values must be strings');
    if (key === 'thinkingBudgets') for (const budget of Object.values(item)) positive(budget, 'streamOptions.thinkingBudgets value');
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build a pi-compatible model client without network access or global registry changes.
 * Choose a complete `model`, a catalog `{provider, modelId}`, or a custom
 * `{provider, modelId, api, baseUrl}`. Credentials/headers remain in closures,
 * never in the public model descriptor. Built-in credentials resolve at request
 * time; custom endpoints use explicit apiKey/getApiKey/headers (use an explicit
 * placeholder apiKey for a keyless OpenAI-compatible server).
 */
export function createModelClient(configuration = {}) {
  object(configuration, 'configuration');
  for (const key of Object.keys(configuration)) if (!OPTIONS.has(key)) throw new TypeError(`Unknown model configuration field: ${key}`);
  const { apiKey, getApiKey, streamFn } = configuration;
  if (apiKey !== undefined) string(apiKey, 'apiKey');
  if (getApiKey !== undefined && typeof getApiKey !== 'function') throw new TypeError('getApiKey must be a function');
  if (streamFn !== undefined && typeof streamFn !== 'function') throw new TypeError('streamFn must be a function');
  if (apiKey !== undefined && getApiKey !== undefined) throw new TypeError('Use apiKey or getApiKey, not both');

  let source;
  if (configuration.model !== undefined) {
    for (const key of ['provider', 'modelId', 'api', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'compat']) {
      if (configuration[key] !== undefined) throw new TypeError(`Do not combine model with ${key}`);
    }
    source = { ...object(configuration.model, 'model') };
  } else {
    const provider = string(configuration.provider, 'provider');
    const modelId = string(configuration.modelId, 'modelId');
    const builtin = getBuiltinModel(provider, modelId);
    if (configuration.api === undefined) {
      if (!builtin) throw new TypeError('Unknown catalog model; a custom model requires api and baseUrl');
      source = { ...builtin };
    } else {
      source = {
        id: modelId, name: modelId, provider, api: string(configuration.api, 'api'),
        baseUrl: configuration.baseUrl, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192,
      };
    }
    for (const key of ['contextWindow', 'maxTokens', 'reasoning', 'input', 'compat']) {
      if (configuration[key] !== undefined) source[key] = configuration[key];
    }
  }
  if (configuration.baseUrl !== undefined) source.baseUrl = configuration.baseUrl;
  const requestHeaders = { ...headers(source.headers, 'model.headers'), ...headers(configuration.headers, 'headers') };
  delete source.headers;
  const model = deepFreeze(validateModel(source));
  const defaults = streamDefaults(configuration.streamOptions);
  if (!streamFn && !APIS.has(model.api)) throw new TypeError('Unsupported model API; provide a streamFn for a custom API');

  // Each instance owns its collection. Importing /compat would register global
  // providers; use the current instance API instead.
  let transport = streamFn;
  if (!transport) {
    const models = builtinModels();
    let builtin = models.getProvider(model.provider);
    const headerAuth = ['authorization', 'cf-aig-authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
      .some(name => typeof requestHeaders[name] === 'string' && requestHeaders[name].trim());
    if (builtin?.auth.apiKey && headerAuth) {
      const originalAuth = builtin.auth.apiKey;
      builtin = { ...builtin, auth: { ...builtin.auth, apiKey: { ...originalAuth,
        resolve: async input => await originalAuth.resolve(input) ?? { auth: {} },
      } } };
      models.setProvider(builtin);
    }
    if (!builtin?.getModels().some(candidate => candidate.api === model.api)) {
      models.setProvider(createProvider({
        id: model.provider, models: [model],
        auth: builtin?.auth ?? { apiKey: { name: model.provider, resolve: async ({ credential }) => ({
          auth: credential?.type === 'api_key' ? { apiKey: credential.key } : {},
        }) } },
        api: lazyApi(() => import(`@earendil-works/pi-ai/api/${model.api}`)),
      }));
    }
    transport = (selected, context, options) => models.streamSimple(selected, context, options);
  }

  const resolveKey = apiKey === undefined && getApiKey === undefined ? undefined : async provider => {
    if (provider !== model.provider) throw new TypeError('Model client cannot resolve credentials for another provider');
    const key = getApiKey ? await getApiKey(provider) : apiKey;
    if (key !== undefined) string(key, 'getApiKey result');
    return key;
  };
  const client = {
    model,
    async streamFn(selected, context, options = {}) {
      if (!selected || selected.id !== model.id || selected.provider !== model.provider || selected.api !== model.api || selected.baseUrl !== model.baseUrl) {
        throw new TypeError('Model client must be used with its configured model');
      }
      const requestDefaults = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
        key, typeof value === 'function' ? value : structuredClone(value),
      ]));
      // Pi Agent includes optional undefined fields in every request. They must
      // not erase host defaults such as onPayload, sessionId or retry limits.
      const requestOptions = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
      const merged = { ...requestDefaults, ...requestOptions, headers: { ...requestHeaders, ...headers(options.headers, 'request headers') } };
      // Agent resolves getApiKey before calling streamFn. Direct stream consumers
      // receive the same behavior without resolving a rotating key twice.
      if (merged.apiKey === undefined && resolveKey && options.getApiKey !== resolveKey) merged.apiKey = await resolveKey(model.provider);
      return transport(model, context, merged);
    },
    ...(resolveKey ? { getApiKey: resolveKey } : {}),
  };
  return Object.freeze(client);
}
