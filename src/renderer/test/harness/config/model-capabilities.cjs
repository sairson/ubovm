'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { providers, providerPreset, providerModels, supportedThinkingLevels, thinkingLevelsFor, clampThinkingLevel } = require('../../../harness/config/model-capabilities.cjs');

const catalogPath = join(__dirname, '../../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json');

test('DeepSeek capability table matches the installed pi-ai catalog', () => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))['openai-completions'];
  for (const [id, model] of Object.entries(providers.deepseek.models)) {
    const entry = catalog[id];
    assert.ok(entry, `missing catalog entry for ${id}`);
    assert.equal(model.label, entry.name);
    assert.equal(model.reasoning, entry.reasoning);
    assert.deepEqual(model.input, entry.input);
    assert.equal(model.contextWindow, entry.contextWindow);
    assert.equal(model.maxTokens, entry.maxTokens);
    assert.deepEqual(model.thinkingLevelMap, entry.thinkingLevelMap);
    assert.deepEqual(supportedThinkingLevels(model), supportedThinkingLevels(entry));
  }
});

test('DeepSeek reasoning levels mirror pi-ai support and clamping', () => {
  assert.deepEqual(thinkingLevelsFor('deepseek', 'deepseek-flash'), ['off', 'low', 'high', 'max']);
  assert.deepEqual(thinkingLevelsFor('deepseek', 'deepseek-v4-pro'), ['off', 'high', 'max']);
  assert.equal(thinkingLevelsFor('deepseek', 'deepseek-chat'), undefined);
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-flash', 'medium'), 'high');
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-flash', 'minimal'), 'low');
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-flash', 'xhigh'), 'max');
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-v4-pro', 'low'), 'high');
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-v4-pro', 'medium'), 'high');
  assert.equal(clampThinkingLevel('deepseek', 'deepseek-flash', 'off'), 'off');
  assert.equal(clampThinkingLevel('custom', 'demo', 'medium'), 'medium');
});

test('DeepSeek preset exposes its model list, labels and per-model levels', () => {
  const preset = providerPreset('deepseek');
  assert.equal(preset.provider, 'deepseek');
  assert.equal(preset.modelId, 'deepseek-flash');
  assert.equal(preset.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(preset.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(preset.modelLabels, { 'deepseek-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' });
  assert.deepEqual(preset.thinkingLevels, {
    'deepseek-flash': ['off', 'low', 'high', 'max'],
    'deepseek-v4-pro': ['off', 'high', 'max'],
  });
  assert.deepEqual(Object.keys(providerModels('deepseek')), preset.models);
});
