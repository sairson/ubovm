export const MAX_OPEN_INTENTS = 5;

export function normalizeOpenIntents(limit = MAX_OPEN_INTENTS) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('openIntents must be a positive integer');
  }
  return limit;
}

export function intentCapacity(nodes, limit = MAX_OPEN_INTENTS) {
  const openLimit = normalizeOpenIntents(limit);
  const open = nodes.filter(node => ['pending', 'running'].includes(node.intent?.status)).length;
  return { limit: openLimit, open, available: Math.max(0, openLimit - open) };
}

export function assertIntentCapacity(nodes, count, limit = MAX_OPEN_INTENTS) {
  const capacity = intentCapacity(nodes, limit);
  if (count > capacity.available) throw Object.assign(new Error(
    `Open intent limit is ${capacity.limit}; ${capacity.open} are pending/running, so at most ${capacity.available} new intents are allowed.`
  ), { code: 'OPEN_INTENT_LIMIT' });
}
