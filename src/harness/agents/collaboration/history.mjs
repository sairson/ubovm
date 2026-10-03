export const plain = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

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

/** Drop complete old turns using one sizing pass; never split tool exchanges. */
export function boundedHistory(messages, limits = {}) {
  const maximumMessages = limits.maxHistoryMessages ?? 200, maximumBytes = limits.maxHistoryBytes ?? 4 << 20;
  if (!Number.isSafeInteger(maximumMessages) || maximumMessages < 4 || maximumMessages > 2000 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 65536 || maximumBytes > 32 << 20) throw new TypeError('Invalid assistant history limits');
  const sizes = messages.map(message => Buffer.byteLength(JSON.stringify(message) ?? 'null'));
  let bytes = 2 + Math.max(0, messages.length - 1) + sizes.reduce((total, size) => total + size, 0);
  let start = 0;
  while (messages.length - start > maximumMessages || bytes > maximumBytes) {
    let nextTurn = start + 1;
    while (nextTurn < messages.length && messages[nextTurn].role !== 'user') nextTurn++;
    if (nextTurn === messages.length) return compactTurn(messages.slice(start), maximumBytes);
    for (; start < nextTurn; start++) bytes -= sizes[start] + 1;
  }
  return { messages: messages.slice(start), omitted: start > 0 };
}

function compactTurn(messages, maximumBytes) {
  const first = messages.find(message => message.role === 'user');
  const last = messages.findLast(message => message.role === 'assistant' && message.stopReason === 'stop');
  const prompt = first ? plain(first) : '', answer = last ? plain(last) : '';
  const compact = length => [
    ...(first ? [{ ...first, content: prompt.slice(0, length) }] : []),
    ...(last ? [{ ...last, content: [{ type: 'text', text: answer.slice(0, length) }] }] : [])
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
  return { messages: compact(low), omitted: true };
}
