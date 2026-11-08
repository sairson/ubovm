export const plain = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const messageSizeCache = new WeakMap();
const messageBytes = message => {
  if (message && typeof message === 'object') {
    const cached = messageSizeCache.get(message);
    if (cached !== undefined) return cached;
    const size = Buffer.byteLength(JSON.stringify(message) ?? 'null');
    messageSizeCache.set(message, size);
    return size;
  }
  return Buffer.byteLength(JSON.stringify(message) ?? 'null');
};

/** Keep interrupted progress without handing a provider unmatched tool calls. */
export function interruptedHistory(messages, limits) {
  const retained = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'system' || message.role === 'toolResult') continue;
    if (message.role !== 'assistant') { retained.push(message); continue; }
    const calls = (Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'toolCall');
    if (!calls.length && !plain(message).trim()) continue;
    const { errorMessage, ...assistant } = message;
    retained.push({ ...assistant, stopReason: calls.length ? 'toolUse' : 'stop' });
    const results = new Map();
    while (messages[index + 1]?.role === 'toolResult') {
      const result = messages[++index]; results.set(result.toolCallId, result);
    }
    for (const call of calls) retained.push(results.get(call.id) ?? {
      role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: 'Execution was interrupted. No confirmed result was recorded for this call. Its effects are unknown; inspect current state before repeating it.' }]
    });
  }
  retained.push({ role: 'user', content: 'The previous turn was interrupted. Preserve the progress and tool evidence above. This is not a completed answer; unconfirmed tool effects must be checked before retrying. Continue according to the next user message.', timestamp: Date.now() });
  return boundedHistory(retained, limits);
}

// Pruned turns are gone from the transcript, but the next model call must still
// know whose objective was lost and that effects may already exist. Keep bounded,
// verbatim user anchors plus a tool-effect census in the gap metadata; the
// conversation injects that metadata into the system prompt.
const ANCHOR_LIMIT = 8, ANCHOR_CHARS = 512, ANCHOR_BYTES = 4096, EVIDENCE_SCAN_LIMIT = 512;
function gapEvidence(messages) {
  const anchors = [], toolNames = new Set();
  let toolCalls = 0, failedCalls = 0, scanned = 0;
  for (const message of messages) {
    if (++scanned > EVIDENCE_SCAN_LIMIT) break;
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      const text = plain(message).trim();
      if (!text || anchors.length >= ANCHOR_LIMIT) continue;
      // Host-compacted checkpoints are durable summaries, not user instructions.
      if (text.startsWith('Compacted historical context (')) continue;
      anchors.push({ ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        complete: Buffer.byteLength(text, 'utf8') <= ANCHOR_CHARS,
        text: text.length <= ANCHOR_CHARS ? text : text.slice(0, ANCHOR_CHARS) });
    } else if (message.role === 'assistant') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'toolCall') continue;
        toolCalls++;
        if (typeof part.name === 'string' && toolNames.size < 16) toolNames.add(part.name);
      }
    } else if (message.role === 'toolResult' && message.isError === true) failedCalls++;
  }
  while (anchors.length > 1 && Buffer.byteLength(JSON.stringify(anchors), 'utf8') > ANCHOR_BYTES) anchors.pop();
  return { ...(anchors.length ? { userAnchors: anchors } : {}),
    ...(toolCalls ? { toolCalls, toolNames: [...toolNames], failedCalls } : {}) };
}

function mergeGapEvidence(gap, messages) {
  const evidence = gapEvidence(messages);
  const anchors = [];
  for (const anchor of [...(gap.userAnchors ?? []), ...(evidence.userAnchors ?? [])]) {
    if (anchors.length >= ANCHOR_LIMIT) break;
    if (!anchors.some(item => item.text === anchor.text)) anchors.push(anchor);
  }
  while (anchors.length > 1 && Buffer.byteLength(JSON.stringify(anchors), 'utf8') > ANCHOR_BYTES) anchors.pop();
  const toolCalls = (gap.toolCalls ?? 0) + (evidence.toolCalls ?? 0);
  const failedCalls = (gap.failedCalls ?? 0) + (evidence.failedCalls ?? 0);
  const toolNames = [...new Set([...(gap.toolNames ?? []), ...(evidence.toolNames ?? [])])].slice(0, 16);
  return { ...(anchors.length ? { userAnchors: anchors } : {}), ...(toolCalls ? { toolCalls, toolNames, failedCalls } : {}) };
}

/** Drop complete old turns using one sizing pass; never split tool exchanges. */
export function boundedHistory(messages, limits = {}) {
  const maximumMessages = limits.maxHistoryMessages ?? 200, maximumBytes = limits.maxHistoryBytes ?? 4 << 20;
  if (!Number.isSafeInteger(maximumMessages) || maximumMessages < 4 || maximumMessages > 2000 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 65536 || maximumBytes > 32 << 20) throw new TypeError('Invalid assistant history limits');
  const sizes = messages.map(messageBytes);
  let bytes = 2 + Math.max(0, messages.length - 1) + sizes.reduce((total, size) => total + size, 0);
  let start = 0;
  let droppedBytes = 0;
  while (messages.length - start > maximumMessages || bytes > maximumBytes) {
    let nextTurn = start + 1;
    while (nextTurn < messages.length && messages[nextTurn].role !== 'user') nextTurn++;
    if (nextTurn === messages.length) return compactTurn(messages.slice(start), maximumBytes,
      { droppedMessages: start, droppedBytes, ...gapEvidence(messages.slice(0, start)) });
    for (; start < nextTurn; start++) { bytes -= sizes[start] + 1; droppedBytes += sizes[start] + 1; }
  }
  return { messages: messages.slice(start), omitted: start > 0,
    ...(start > 0 ? { historyGap: { kind: 'turns-omitted', droppedMessages: start, droppedBytes, ...gapEvidence(messages.slice(0, start)) } } : {}) };
}

function compactTurn(messages, maximumBytes, gap = {}) {
  // Preserve every user message in the collapsed turn, not only the first: a
  // mid-turn correction is user intent, and a single-user assumption silently
  // dropped earlier objectives in oversized turns.
  const users = messages.filter(message => message.role === 'user');
  const last = messages.findLast(message => message.role === 'assistant' && message.stopReason === 'stop');
  const compact = length => [
    ...users.map(message => ({ ...message, content: plain(message).slice(0, length) })),
    ...(last ? [{ ...last, content: [{ type: 'text', text: plain(last).slice(0, length) }] }] : [])
  ];
  const fits = value => Buffer.byteLength(JSON.stringify(value)) <= maximumBytes;
  // Metadata is retained for provider compatibility. Never persist an oversized
  // record just because clipping the text cannot reduce that metadata.
  if (!fits(compact(0))) throw Object.assign(new Error('Assistant history metadata exceeds the storage limit'), { code: 'COLLABORATION_HISTORY_LIMIT' });
  let low = 0, high = 12000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(compact(middle))) low = middle;
    else high = middle - 1;
  }
  return { messages: compact(low), omitted: true,
    historyGap: { kind: 'turn-compacted', droppedMessages: gap.droppedMessages ?? 0, droppedBytes: gap.droppedBytes ?? 0, retainedCharsPerMessage: low, ...mergeGapEvidence(gap, messages) } };
}
