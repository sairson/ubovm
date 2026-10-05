import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';

const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/** True when an AbortSignal or abort-shaped error should stop retrying. */
export function isAbortError(error) {
  if (!error || typeof error !== 'object') return false;
  return error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'CANCELLED';
}

/** Classify thrown transport/provider failures that are safe to retry before any tokens. */
export function isTransientTransportError(error) {
  if (!error || typeof error !== 'object' || isAbortError(error)) return false;
  const status = Number(error.status || error.statusCode || error.response?.status);
  if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 524].includes(status)) return true;
  if (TRANSPORT_CODES.has(error.code)) return true;
  const message = String(error.message || error);
  return isRetryableAssistantError({ stopReason: 'error', errorMessage: message })
    || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|Failed to fetch|other side closed|upstream connect|reset before headers/i.test(message);
}

/** Classify a finished assistant message as a transient provider/network failure. */
export function isRetryableModelFailure(message) {
  return Boolean(message && message.stopReason === 'error' && isRetryableAssistantError(message));
}

/** True when the assistant already produced visible text, thinking, or tool calls. */
export function hasAssistantContent(message) {
  return (message?.content ?? []).some(part =>
    (part.type === 'text' && part.text)
    || (part.type === 'thinking' && part.thinking)
    || part.type === 'toolCall');
}

function eventShowsContent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.partial && hasAssistantContent(event.partial)) return true;
  if (event.type === 'text_delta' || event.type === 'text_end') return Boolean(event.content || event.delta);
  if (event.type === 'thinking_delta' || event.type === 'thinking_end') return Boolean(event.content || event.delta);
  if (event.type === 'toolcall_start' || event.type === 'toolcall_delta' || event.type === 'toolcall_end') return true;
  return false;
}

export function sleepAbortable(ms, signal) {
  const delay = Math.max(0, Math.min(Number.isFinite(ms) ? ms : 0, 2_147_483_647));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function retryBackoffMs(attempt, { baseDelayMs = 250, maxDelayMs = 5000 } = {}) {
  const base = Number.isSafeInteger(baseDelayMs) ? Math.max(0, baseDelayMs) : 250;
  const cap = Number.isSafeInteger(maxDelayMs) ? Math.max(0, maxDelayMs) : 5000;
  const delay = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER, cap);
}

/**
 * Best-effort Retry-After extraction in milliseconds for rate-limit failures.
 * Providers surface it as a retryAfter field, a response header, or message
 * text; absent evidence returns 0 so callers keep their own backoff.
 */
export function rateLimitDelayMs(error, { maxDelayMs = 60000 } = {}) {
  if (!error) return 0;
  const record = error instanceof Error || (typeof error === 'object' && !Array.isArray(error)) ? error : null;
  const message = record ? String(record.message || record.errorMessage || '') : String(error);
  const status = record ? Number(record.status || record.statusCode || record.response?.status) || 0 : 0;
  if (status !== 429 && !/\b429\b|rate[ _-]?limit|too many requests/i.test(message)) return 0;
  const header = record?.headers?.['retry-after'] ?? record?.headers?.get?.('retry-after');
  const raw = record?.retryAfter ?? record?.retryAfterMs ?? header;
  let seconds;
  if (typeof raw === 'number' && Number.isFinite(raw)) seconds = raw > 10000 ? raw / 1000 : raw;
  else if (typeof raw === 'string' && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) seconds = numeric;
    else {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) seconds = (date - Date.now()) / 1000;
    }
  }
  if (seconds === undefined) {
    const match = message.match(/retry[ _-]?after[":=\s]+(\d+(?:\.\d+)?)/i);
    if (match) seconds = Number(match[1]);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.round(seconds * 1000), Math.max(0, maxDelayMs));
}

// Cross-call rate-limit coordination: concurrent workers sharing one model
// consult this cooldown instead of hammering a throttled provider in lockstep.
const rateLimitCooldowns = new Map();
const RATE_LIMIT_COOLDOWN_ENTRIES = 1024;

function noteRateLimit(key, delayMs) {
  if (!key || !(delayMs > 0)) return;
  if (rateLimitCooldowns.size >= RATE_LIMIT_COOLDOWN_ENTRIES) rateLimitCooldowns.clear();
  const until = Date.now() + delayMs;
  if ((rateLimitCooldowns.get(key) ?? 0) < until) rateLimitCooldowns.set(key, until);
}

async function honorRateLimit(key, signal) {
  if (!key) return;
  for (;;) {
    const wait = (rateLimitCooldowns.get(key) ?? 0) - Date.now();
    if (wait <= 0) return;
    await sleepAbortable(Math.min(wait, 60000), signal);
  }
}

function isAssistantStream(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value[Symbol.asyncIterator] === 'function'
    && typeof value.result === 'function'
    && typeof value.push === 'function';
}

/**
 * Retry a model stream when the transport fails before any assistant content.
 * Provider SDKs already use streamOptions.maxRetries for HTTP retries; this layer
 * covers thrown setup failures and empty retryable error streams after that budget.
 */
export async function withTransientStreamRetry(transport, model, context, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const configured = Number.isSafeInteger(options.maxRetries) ? options.maxRetries : 2;
  // Keep outer retries small; provider retries already ran inside transport.
  const outerRetries = Math.min(2, Math.max(0, configured));
  const maxDelayMs = Number.isSafeInteger(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 5000;
  const policy = { baseDelayMs: 250, maxDelayMs };
  const rateLimitKey = model && typeof model === 'object' ? `${model.provider ?? ''}:${model.id ?? ''}` : null;

  const open = async () => { await honorRateLimit(rateLimitKey, signal); return transport(model, context, options); };

  let stream;
  for (let attempt = 0; ; attempt++) {
    try {
      stream = await open();
      break;
    } catch (error) {
      signal?.throwIfAborted();
      // Record the provider's rate-limit window even when this caller gives up,
      // so concurrent workers sharing the model wait instead of piling on.
      const rateLimited = rateLimitDelayMs(error);
      noteRateLimit(rateLimitKey, rateLimited);
      if (attempt >= outerRetries || !isTransientTransportError(error)) throw error;
      await sleepAbortable(Math.max(retryBackoffMs(attempt + 1, policy), rateLimited), signal);
      signal?.throwIfAborted();
    }
  }

  if (!isAssistantStream(stream)) return stream;

  const output = new AssistantMessageEventStream();
  (async () => {
    let current = stream;
    for (let attempt = 0; ; attempt++) {
      const buffered = [];
      let committed = false;
      let terminal;
      try {
        for await (const event of current) {
          if (event.type === 'done' || event.type === 'error') {
            terminal = event;
            break;
          }
          if (!committed && eventShowsContent(event)) {
            committed = true;
            for (const item of buffered) output.push(item);
            buffered.length = 0;
            output.push(event);
          } else if (committed) {
            output.push(event);
          } else {
            buffered.push(event);
          }
        }
        const result = terminal
          ? (terminal.type === 'done' ? terminal.message : terminal.error)
          : await current.result();
        const retryable = !committed
          && !hasAssistantContent(result)
          && result?.stopReason === 'error'
          && isRetryableModelFailure(result)
          && attempt < outerRetries
          && !signal?.aborted;
        const rateLimited = rateLimitDelayMs(result);
        noteRateLimit(rateLimitKey, rateLimited);
        if (retryable) {
          await sleepAbortable(Math.max(retryBackoffMs(attempt + 1, policy), rateLimited), signal);
          signal?.throwIfAborted();
          current = await open();
          if (!isAssistantStream(current)) {
            output.push({
              type: 'error',
              reason: 'error',
              error: {
                role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: 'error', errorMessage: 'Model transport returned a non-stream response during retry',
                timestamp: Date.now(),
              },
            });
            return;
          }
          continue;
        }
        if (!committed) for (const item of buffered) output.push(item);
        if (terminal) output.push(terminal);
        else if (result) {
          output.push(result.stopReason === 'error' || result.stopReason === 'aborted'
            ? { type: 'error', reason: result.stopReason, error: result }
            : { type: 'done', reason: result.stopReason, message: result });
        } else {
          output.end();
        }
        return;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          output.push({
            type: 'error',
            reason: 'aborted',
            error: {
              role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'aborted', errorMessage: error instanceof Error ? error.message : 'Aborted',
              timestamp: Date.now(),
            },
          });
          return;
        }
        const rateLimited = rateLimitDelayMs(error);
        noteRateLimit(rateLimitKey, rateLimited);
        if (!committed && attempt < outerRetries && isTransientTransportError(error)) {
          await sleepAbortable(Math.max(retryBackoffMs(attempt + 1, policy), rateLimited), signal);
          signal?.throwIfAborted();
          current = await open();
          if (isAssistantStream(current)) continue;
        }
        output.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        });
        return;
      }
    }
  })().catch(() => {
    // The output stream already carries the failure; never reject the wrapper.
  });
  return output;
}
