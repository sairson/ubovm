'use strict';

// DeepSeek capability table mirrored from the installed pi-ai 0.86.1 catalog
// (`providers/data/deepseek.json`). The renderer runs in CommonJS and cannot
// import the ESM catalog, so this small table is the single source for the
// settings presets, model lists, reasoning-level filtering and DeepSeek-aware
// defaults. Keep it in sync with pi-ai; the renderer test suite compares it
// against the installed catalog.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const providers = {
  deepseek: {
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    defaultModelId: 'deepseek-flash',
    models: {
      'deepseek-flash': {
        label: 'DeepSeek V4.1 Flash',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 384000,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek V4 Pro',
        reasoning: true,
        input: ['text'],
        contextWindow: 1000000,
        maxTokens: 384000,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
      },
    },
  },
};

function providerModels(provider) {
  return providers[provider]?.models;
}

/** Mirrors pi-ai getSupportedThinkingLevels for a catalog model. */
function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ['off'];
  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

function thinkingLevelsFor(provider, modelId) {
  const model = providerModels(provider)?.[modelId];
  return model ? supportedThinkingLevels(model) : undefined;
}

/** Mirrors pi-ai clampThinkingLevel so the form previews what will be sent. */
function clampThinkingLevel(provider, modelId, level) {
  const levels = thinkingLevelsFor(provider, modelId);
  if (!levels || levels.includes(level) || typeof level !== 'string') return level;
  const requested = THINKING_LEVELS.indexOf(level);
  if (requested === -1) return levels[0] ?? 'off';
  for (let index = requested; index < THINKING_LEVELS.length; index++) {
    if (levels.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
  }
  for (let index = requested - 1; index >= 0; index--) {
    if (levels.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
  }
  return levels[0] ?? 'off';
}

/** Build the settings preset for a provider whose catalog data lives here. */
function providerPreset(provider) {
  const entry = providers[provider];
  if (!entry) throw new Error(`Unknown model capability table: ${provider}`);
  const model = entry.models[entry.defaultModelId];
  if (!model) throw new Error(`Unknown default model for ${provider}`);
  return {
    label: entry.label,
    provider,
    modelId: entry.defaultModelId,
    api: entry.api,
    baseUrl: entry.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
    models: Object.keys(entry.models),
    modelLabels: Object.fromEntries(Object.entries(entry.models).map(([id, item]) => [id, item.label])),
    thinkingLevels: Object.fromEntries(Object.entries(entry.models).map(([id, item]) => [id, supportedThinkingLevels(item)])),
  };
}

module.exports = { THINKING_LEVELS, providers, providerPreset, providerModels, supportedThinkingLevels, thinkingLevelsFor, clampThinkingLevel };
