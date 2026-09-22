'use strict';
// Presets from the installed pi-ai 0.86.1 catalog; no network discovery.
module.exports = {
  "openai": {
    "label": "OpenAI",
    "provider": "openai",
    "modelId": "gpt-4.1",
    "api": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "contextWindow": 1047576,
    "maxTokens": 32768,
    "reasoning": false,
    "input": [
      "text",
      "image"
    ]
  },
  "anthropic": {
    "label": "Anthropic",
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-6",
    "api": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "google": {
    "label": "Google Gemini",
    "provider": "google",
    "modelId": "gemini-3.5-flash",
    "api": "google-generative-ai",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "deepseek": {
    "label": "DeepSeek",
    "provider": "deepseek",
    "modelId": "deepseek-flash",
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "openrouter": {
    "label": "OpenRouter",
    "provider": "openrouter",
    "modelId": "openai/gpt-4.1",
    "api": "openai-completions",
    "baseUrl": "https://openrouter.ai/api/v1",
    "contextWindow": 1047576,
    "maxTokens": 32768,
    "reasoning": false,
    "input": [
      "text",
      "image"
    ]
  },
  "mistral": {
    "label": "Mistral",
    "provider": "mistral",
    "modelId": "mistral-small-latest",
    "api": "mistral-conversations",
    "baseUrl": "https://api.mistral.ai",
    "contextWindow": 256000,
    "maxTokens": 256000,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "groq": {
    "label": "Groq",
    "provider": "groq",
    "modelId": "llama-3.3-70b-versatile",
    "api": "openai-completions",
    "baseUrl": "https://api.groq.com/openai/v1",
    "contextWindow": 131072,
    "maxTokens": 32768,
    "reasoning": false,
    "input": [
      "text"
    ]
  },
  "xai": {
    "label": "xAI",
    "provider": "xai",
    "modelId": "grok-4.3",
    "api": "openai-responses",
    "baseUrl": "https://api.x.ai/v1",
    "contextWindow": 1000000,
    "maxTokens": 30000,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "moonshotai": {
    "label": "Moonshot / Kimi",
    "provider": "moonshotai",
    "modelId": "kimi-k2.6",
    "api": "openai-completions",
    "baseUrl": "https://api.moonshot.ai/v1",
    "contextWindow": 262144,
    "maxTokens": 262144,
    "reasoning": true,
    "input": [
      "text",
      "image"
    ]
  },
  "custom": {
    "label": "自定义 / OpenAI 兼容",
    "provider": "custom",
    "modelId": "",
    "api": "openai-completions",
    "baseUrl": "",
    "contextWindow": 128000,
    "maxTokens": 8192,
    "reasoning": false,
    "input": [
      "text"
    ]
  }
};
