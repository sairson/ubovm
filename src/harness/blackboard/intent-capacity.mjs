export const MAX_OPEN_INTENTS = 5;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

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

/** How many of `count` new intents this snapshot can persist. Zero remaining slots still throw. */
export function takeOpenIntentSlots(nodes, count, limit = MAX_OPEN_INTENTS) {
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('count must be a nonnegative integer');
  if (count === 0) return 0;
  const capacity = intentCapacity(nodes, limit);
  if (capacity.available === 0) assertIntentCapacity(nodes, count, limit);
  return Math.min(count, capacity.available);
}

/**
 * Fill remaining slots from a Reason proposal instead of rejecting the whole
 * decision. Higher priority wins; original order is the tiebreaker.
 * `tryPrepare` may throw to skip one item; later valid items still fill slots.
 * A nonempty surplus against a full board becomes wait, not an error.
 */
export function fillIntentSlots(proposals, { available, maxIntents, tryPrepare = item => item } = {}) {
  if (!Array.isArray(proposals)) return { admitted: [], deferred: 0, wait: false, errors: [] };
  const room = Math.max(0, Number.isSafeInteger(available) ? available : 0);
  const perResponse = Number.isSafeInteger(maxIntents) && maxIntents > 0 ? maxIntents : Number.MAX_SAFE_INTEGER;
  const limit = Math.min(room, perResponse);
  if (limit <= 0) return { admitted: [], deferred: proposals.length, wait: proposals.length > 0, errors: [] };
  const ranked = proposals.map((item, index) => ({ item, index })).sort((left, right) => {
    const rank = (PRIORITY_RANK[left.item?.priority] ?? 1) - (PRIORITY_RANK[right.item?.priority] ?? 1);
    return rank || left.index - right.index;
  });
  const admitted = [];
  const errors = [];
  for (const entry of ranked) {
    if (admitted.length >= limit) break;
    try { admitted.push(tryPrepare(entry.item, entry.index, admitted)); }
    catch (error) { errors.push(error); }
  }
  return {
    admitted,
    deferred: Math.max(0, proposals.length - admitted.length),
    wait: false,
    errors
  };
}

export function admitIntentProposals(proposals, options) {
  return fillIntentSlots(proposals, options);
}
