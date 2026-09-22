import { isDeepStrictEqual } from 'node:util';

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const PHASES = new Set(['plan', 'execute', 'replan', 'conclude', 'done']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);

function invalid(message) {
  return Object.assign(new Error(`Invalid worker checkpoint: ${message}`), { code: 'INVALID_CHECKPOINT' });
}

function check(condition, message) {
  if (!condition) throw invalid(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Copy only lossless JSON data; never invoke a checkpoint's getters or toJSON. */
export function cloneCheckpoint(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'maxBytes must be a positive integer');
  const active = new Set();
  function visit(item, depth) {
    check(depth <= 256, 'JSON nesting is too deep');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      check(Number.isFinite(item), 'numbers must be finite');
      return;
    }
    check(typeof item === 'object', 'only JSON values are supported');
    const prototype = Object.getPrototypeOf(item);
    check(Array.isArray(item) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'only plain objects and arrays are supported');
    check(!active.has(item), 'cyclic data is not supported');
    active.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      check(keys.length === item.length + 1, 'arrays must be dense and have no extra properties');
    }
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      check(typeof key === 'string', 'symbol keys are not JSON');
      if (Array.isArray(item)) {
        check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length, 'invalid array property');
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'properties must be enumerable data');
      visit(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  try {
    visit(value, 0);
    const serialized = JSON.stringify(value);
    check(Buffer.byteLength(serialized, 'utf8') <= maxBytes, `exceeds ${maxBytes} bytes`);
    return JSON.parse(serialized);
  } catch (error) {
    if (error?.code === 'INVALID_CHECKPOINT') throw error;
    throw invalid('cannot read JSON data');
  }
}

export function createWorkerCheckpoint({ intentId, goal }) {
  check(nonempty(intentId), 'intentId must be a nonempty string');
  check(nonempty(goal), 'goal must be a nonempty string');
  return {
    kind: 'ubovm.pi-worker', version: 1, intentId, goal,
    phase: 'plan', plan: [], completed: [], messages: [],
    modelCalls: 0, toolCalls: 0, ledger: [], repairs: 0,
    barrierResult: null, fact: null,
  };
}

function validateContent(content, types, label, allowString = false) {
  if (allowString && typeof content === 'string') return;
  check(Array.isArray(content), `${label} content must be an array`);
  for (const block of content) {
    check(object(block) && types.includes(block.type), `${label} has an unsupported content block`);
    if (block.type === 'text') check(typeof block.text === 'string', `${label} text must be a string`);
    if (block.type === 'image') {
      check(typeof block.data === 'string' && nonempty(block.mimeType), `${label} image needs data and mimeType`);
    }
    if (block.type === 'thinking') {
      check(typeof block.thinking === 'string', `${label} thinking must be a string`);
    }
    if (block.type === 'toolCall') {
      check(nonempty(block.id) && nonempty(block.name) && object(block.arguments), `${label} has a malformed tool call`);
    }
  }
}

function validateLedger(ledger, retryableReadTools = []) {
  const safeReads = new Set(retryableReadTools);
  check(Array.isArray(ledger), 'ledger must be an array');
  const entries = new Map();
  for (const entry of ledger) {
    check(object(entry) && nonempty(entry.toolCallId) && nonempty(entry.toolName), 'invalid ledger tool identity');
    check(!entries.has(entry.toolCallId), 'duplicate ledger toolCallId');
    check(object(entry.args), 'ledger args must be an object');
    if (Object.hasOwn(entry, 'executedArgs')) check(object(entry.executedArgs), 'ledger executedArgs must be an object');
    check(entry.status === 'running' || entry.status === 'completed', 'invalid ledger status');
    if (entry.status === 'running') {
      if (!safeReads.has(entry.toolName)) throw Object.assign(new Error(`Cannot safely resume tool ${entry.toolName} (${entry.toolCallId}): it started without a durable result; execution may already have had side effects.`), { code: 'UNSAFE_TOOL_REPLAY' });
      // Only current host tool definitions authorize this repair, never saved
      // metadata. Do not fabricate observations or execute during restoration.
      entry.status = 'completed';
      entry.isError = true;
      entry.result = { content: [{ type: 'text', text: 'This read-only tool was interrupted before its result was durably saved. No result is available. Call it again with a new tool call ID to read the latest state before continuing; do not infer file contents or hashes from this interrupted call.' }] };
    }
    check(typeof entry.isError === 'boolean', 'completed ledger entry needs isError');
    check(object(entry.result), 'completed ledger entry needs its result');
    validateContent(entry.result.content, ['text', 'image'], 'ledger result');
    entries.set(entry.toolCallId, entry);
  }
  return entries;
}

function validateMessage(message) {
  check(object(message), 'message must be an object');
  check(['system', 'user', 'assistant', 'toolResult'].includes(message.role), 'unknown message role');
  check(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp >= 0, 'message timestamp must be a nonnegative number');
  if (message.role === 'system') {
    validateContent(message.content, ['text'], 'system', true);
    if (Object.hasOwn(message, 'sections')) {
      check(object(message.sections) && Object.values(message.sections).every((item) => item === null || typeof item === 'string'), 'invalid system sections');
    }
    if (Object.hasOwn(message, 'toolsAdded')) {
      check(Array.isArray(message.toolsAdded), 'system toolsAdded must be an array');
      for (const tool of message.toolsAdded) {
        check(object(tool) && nonempty(tool.name) && typeof tool.description === 'string' && object(tool.parameters), 'invalid system tool definition');
      }
    }
    if (Object.hasOwn(message, 'toolsRemoved')) {
      check(Array.isArray(message.toolsRemoved) && message.toolsRemoved.every((item) => object(item) && nonempty(item.name)), 'invalid system toolsRemoved');
    }
  } else if (message.role === 'user') {
    validateContent(message.content, ['text', 'image'], 'user', true);
  } else if (message.role === 'assistant') {
    validateContent(message.content, ['text', 'thinking', 'toolCall'], 'assistant');
    check(STOP_REASONS.has(message.stopReason), 'unsupported assistant stopReason');
    // Keep provider-specific metadata opaque, while validating fields adapters read.
    for (const field of ['api', 'provider', 'model']) check(nonempty(message[field]), `assistant ${field} is required`);
    check(object(message.usage) && object(message.usage.cost), 'assistant usage is required');
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      check(typeof message.usage[field] === 'number' && message.usage[field] >= 0, `invalid assistant usage ${field}`);
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      check(typeof message.usage.cost[field] === 'number' && message.usage.cost[field] >= 0, `invalid assistant cost ${field}`);
    }
  } else {
    validateContent(message.content, ['text', 'image'], 'toolResult');
    check(nonempty(message.toolCallId) && nonempty(message.toolName) && typeof message.isError === 'boolean', 'invalid toolResult identity or isError');
  }
}

function recoverValidatedTranscript(messages, entries) {
  check(Array.isArray(messages), 'messages must be an array');
  // An interrupted provider response cannot be continued as an assistant turn.
  // Its partially streamed tool calls were never a completed execution request.
  while (messages.at(-1)?.role === 'assistant' && ['error', 'aborted'].includes(messages.at(-1).stopReason)) messages.pop();
  const called = new Set();
  let pending = [];
  let pendingTimestamp = 0;
  for (const message of messages) {
    validateMessage(message);
    if (message.role === 'toolResult') {
      const call = pending[0];
      check(call && call.id === message.toolCallId, 'orphan, duplicate, or out-of-order toolResult');
      check(call.name === message.toolName, 'toolResult name does not match its call');
      pending.shift();
      continue;
    }
    check(pending.length === 0, 'unfinished tool batch appears before another message');
    if (message.role !== 'assistant') continue;
    check(!['error', 'aborted'].includes(message.stopReason), 'interrupted assistant appears inside transcript');
    pending = message.content.filter((block) => block.type === 'toolCall');
    pendingTimestamp = message.timestamp;
    for (const call of pending) {
      check(!called.has(call.id), 'duplicate assistant tool call id');
      called.add(call.id);
      const entry = entries.get(call.id);
      if (entry) {
        // args records the original request; executedArgs may independently
        // contain Pi's validated/coerced or prepareArguments-transformed input.
        check(call.name === entry.toolName && isDeepStrictEqual(call.arguments, entry.args), 'ledger tool call does not match transcript');
      }
    }
  }
  for (const call of pending) {
    const entry = entries.get(call.id);
    const result = entry?.result ?? {
      content: [{ type: 'text', text: 'The previous run was interrupted before this tool call started. The tool was not executed. Reconsider whether to call it using the latest context.' }],
    };
    messages.push({
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: result.content,
      ...(Object.hasOwn(result, 'details') ? { details: result.details } : {}),
      isError: entry ? entry.isError : true,
      timestamp: pendingTimestamp,
    });
  }
  return messages;
}

/** Repair only a terminal interrupted exchange, without ever executing a tool. */
export function recoverTranscript(messages, ledger, { retryableReadTools = [] } = {}) {
  const copy = cloneCheckpoint({ messages, ledger });
  return recoverValidatedTranscript(copy.messages, validateLedger(copy.ledger, retryableReadTools));
}

export function restoreWorkerCheckpoint(value, { intentId, goal, maxBytes = DEFAULT_MAX_BYTES, retryableReadTools = [] }) {
  const initial = createWorkerCheckpoint({ intentId, goal });
  if (value === null || value === undefined) return cloneCheckpoint(initial, { maxBytes });
  const checkpoint = cloneCheckpoint(value, { maxBytes });
  check(object(checkpoint) && checkpoint.kind === initial.kind && checkpoint.version === initial.version, 'unrecognized schema');
  check(checkpoint.intentId === intentId && checkpoint.goal === goal, 'checkpoint belongs to a different intent or goal');
  check(PHASES.has(checkpoint.phase), 'unknown worker phase');
  check(Array.isArray(checkpoint.plan), 'plan must be an array');
  const validStep = (step) => object(step) && nonempty(step.description) && nonempty(step.doneWhen);
  check(checkpoint.plan.every(validStep), 'invalid plan step');
  check(Array.isArray(checkpoint.completed) && checkpoint.completed.every((item) => object(item) && validStep(item.step) && typeof item.output === 'string'), 'invalid completed step');
  for (const key of ['modelCalls', 'toolCalls', 'repairs']) check(counter(checkpoint[key]), `${key} must be a nonnegative integer`);
  check(checkpoint.barrierResult === null || typeof checkpoint.barrierResult === 'string', 'invalid barrierResult');
  check(checkpoint.fact === null || object(checkpoint.fact), 'fact must be an object or null');
  checkpoint.messages = recoverValidatedTranscript(checkpoint.messages, validateLedger(checkpoint.ledger, retryableReadTools));
  // Recovery itself adds data; the configured bound also applies to that result.
  return cloneCheckpoint(checkpoint, { maxBytes });
}
