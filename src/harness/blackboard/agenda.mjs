import { buildBlackboardContext } from './context.mjs';

export const EXPLORATION_AGENDA_OWNER = 'reason';
/** Intent attempts interrupted by a Reason-directed stop are displayed as dropped. */
export const EXPLORATION_STOP_MARKER = '[已放弃] ';
const DEDUPE_LIMIT = 512;
const MAX_DONE = 10;
const MAX_DIRECTIONS = 40;
const MAX_SUGGESTIONS = 8;

const normalize = value => String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};

function intentStatus(node) {
  const status = node?.intent?.status;
  if (status === 'pending') return 'planned';
  if (status === 'running') return 'active';
  if (status === 'completed') return 'done';
  const latest = node.attempts?.at(-1);
  if (status === 'interrupted' && String(latest?.error ?? '').startsWith(EXPLORATION_STOP_MARKER)) return 'dropped';
  return 'blocked';
}

function planSteps(node) {
  const latest = node.attempts?.at(-1);
  const checkpoint = latest?.status === 'running' ? latest.checkpoint : undefined;
  const plan = Array.isArray(checkpoint?.plan) ? checkpoint.plan : [];
  return plan.map(step => clip(step?.description, 240)).filter(Boolean).slice(0, 12);
}

function currentStep(node) {
  if (node.intent?.status !== 'running') return undefined;
  const latest = node.attempts?.at(-1);
  const checkpoint = latest?.status === 'running' ? latest.checkpoint : undefined;
  if (checkpoint?.phase !== 'execute') return undefined;
  return clip(checkpoint.plan?.[0]?.description, 240) || undefined;
}

function latestBlocker(node) {
  const attempt = [...(node.attempts ?? [])].reverse().find(item => item.status === 'failed' || item.status === 'interrupted');
  if (!attempt) return undefined;
  return clip(attempt.error, 320) || undefined;
}

/** Extract remaining checks and self-reported limits from a structured Worker fact. */
function factGaps(factNode) {
  if (!factNode?.fact?.content) return [];
  let fact;
  try { fact = JSON.parse(factNode.fact.content); } catch { return []; }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return [];
  const gaps = [];
  for (const item of Array.isArray(fact.coverage) ? fact.coverage : []) {
    if (!item || typeof item !== 'object') continue;
    if (['confirmed', 'negative'].includes(item.status)) continue;
    const point = clip(item.point, 240);
    if (point) gaps.push({ point, status: String(item.status ?? 'partial'), note: clip(item.result, 240) || undefined });
  }
  for (const limitation of Array.isArray(fact.limitations) ? fact.limitations : []) {
    const text = clip(limitation, 240);
    if (text) gaps.push({ point: text, status: 'limitation' });
  }
  return gaps.slice(0, 8);
}

function directionStatus(entry) {
  return ['planned', 'active', 'done', 'dropped'].includes(entry?.status) ? entry.status : 'planned';
}

/**
 * Build the shared exploration agenda. Intent status and Worker plan steps are
 * projected from durable blackboard state on every call; Reason-owned direction
 * items come from the shared memory store. Suggestions are derived (never
 * dispatched): a failed intent asks for a different method, and a partial fact
 * asks for the missing key point.
 */
export function buildExplorationAgenda({ snapshot, memory, focusId } = {}) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes)) throw new TypeError('A blackboard snapshot is required');
  const context = buildBlackboardContext(snapshot, focusId === undefined ? {} : { focusId });
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const items = [];
  const completedIntents = [];
  for (const node of snapshot.nodes) {
    if (!node.intent) continue;
    const status = intentStatus(node);
    const resultId = node.resultId;
    const evidenceNode = resultId ? byId.get(resultId) : undefined;
    const gaps = status === 'done' ? factGaps(evidenceNode) : [];
    const item = {
      id: `intent:${node.id}`,
      kind: 'intent',
      intentId: node.id,
      ref: context.aliasFor(node.id),
      title: clip(node.intent.description, 500),
      status,
      priority: node.intent.priority,
      source: 'blackboard',
      dedupeKey: normalize(node.intent.description).slice(0, DEDUPE_LIMIT),
      attempts: node.attempts?.length ?? 0,
      ...(node.resultId ? { evidenceRef: context.aliasFor(node.resultId) } : {}),
      ...(currentStep(node) ? { currentStep: currentStep(node) } : {}),
      ...(planSteps(node).length ? { planSteps: planSteps(node) } : {}),
      ...(latestBlocker(node) ? { blocker: latestBlocker(node) } : {}),
      ...(gaps.length ? { gaps } : {})
    };
    items.push(item);
    if (status === 'done') completedIntents.push(item);
  }

  const directions = (Array.isArray(memory?.agenda) ? memory.agenda : [])
    .filter(entry => entry && entry.worker_id === EXPLORATION_AGENDA_OWNER)
    .slice(0, MAX_DIRECTIONS)
    .map(entry => ({
      id: `direction:${entry.id}`,
      kind: 'direction',
      directionId: entry.id,
      title: clip(entry.content, 500),
      status: directionStatus(entry),
      source: 'reason',
      dedupeKey: normalize(entry.dedupe_key || entry.content).slice(0, DEDUPE_LIMIT),
      ...(entry.method ? { method: clip(entry.method, 500) } : {}),
      ...(entry.acceptance ? { acceptance: clip(entry.acceptance, 500) } : {})
    }));
  items.push(...directions);

  const suggestions = [];
  for (const item of items) {
    if (item.kind !== 'intent') continue;
    if (item.status === 'blocked' && suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push({
        id: `suggestion:retry:${item.intentId}`,
        kind: 'suggestion',
        source: 'failure',
        status: 'planned',
        intentId: item.intentId,
        title: `换一种方法继续：${item.title}`,
        dedupeKey: normalize(`alternative method ${item.title}`).slice(0, DEDUPE_LIMIT),
        ...(item.blocker ? { blocker: item.blocker } : {})
      });
    }
    for (const gap of item.gaps ?? []) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      suggestions.push({
        id: `suggestion:gap:${item.intentId}:${normalize(gap.point).slice(0, 80)}`,
        kind: 'suggestion',
        source: 'gap',
        status: 'planned',
        intentId: item.intentId,
        title: `补充验证：${gap.point}`,
        dedupeKey: normalize(`verify gap ${gap.point}`).slice(0, DEDUPE_LIMIT),
        ...(gap.note ? { blocker: gap.note } : {})
      });
    }
  }
  items.push(...suggestions);

  const counts = { planned: 0, active: 0, blocked: 0, done: 0, dropped: 0, total: items.length };
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const duplicateKeys = new Map();
  for (const item of items) {
    if (!item.dedupeKey) continue;
    if (!duplicateKeys.has(item.dedupeKey)) duplicateKeys.set(item.dedupeKey, item);
    for (const key of [normalize(item.title)]) if (key && !duplicateKeys.has(key)) duplicateKeys.set(key, item);
  }
  return {
    items,
    counts,
    duplicateKeys,
    completedIntents,
    gaps: suggestions.filter(item => item.source === 'gap'),
    open: items.filter(item => ['planned', 'active', 'blocked'].includes(item.status)),
    lastUpdated: snapshot.nodes.map(node => node.updatedAt).sort().at(-1) ?? null
  };
}

/** Find a likely duplicate for a proposed intent description. */
export function agendaDuplicate(agenda, description) {
  if (!agenda || typeof description !== 'string') return undefined;
  const key = normalize(description);
  if (!key) return undefined;
  return agenda.duplicateKeys.get(key);
}

/**
 * Prompt-ready agenda. Bounded to open items plus the most recent completions so
 * each Reason review does not pay for the whole exploration history.
 */
export function renderAgenda(agenda, { maxOpen = 18, maxDone = 8 } = {}) {
  if (!agenda || !Array.isArray(agenda.items)) return '';
  const rank = { active: 0, blocked: 1, planned: 2, suggestion: 2, done: 3, dropped: 4 };
  const sorted = [...agenda.items].sort((left, right) => (rank[left.status] ?? 5) - (rank[right.status] ?? 5));
  const open = sorted.filter(item => ['planned', 'active', 'blocked'].includes(item.status) || item.kind === 'suggestion').slice(0, maxOpen);
  const done = sorted.filter(item => item.status === 'done').slice(-maxDone);
  const dropped = sorted.filter(item => item.status === 'dropped').slice(-4);
  const line = item => {
    const bits = [`[${item.status}]`];
    if (item.kind === 'intent') bits.push(`intent ${item.ref ?? ''}`.trim());
    else if (item.kind === 'direction') bits.push('direction');
    else bits.push('suggestion');
    bits.push(item.title);
    if (item.dedupeKey && item.dedupeKey !== normalize(item.title)) bits.push(`dedupe: ${item.dedupeKey}`);
    if (item.method) bits.push(`method: ${item.method}`);
    if (item.acceptance) bits.push(`acceptance: ${item.acceptance}`);
    if (item.currentStep) bits.push(`current: ${item.currentStep}`);
    if (item.planSteps?.length) bits.push(`plan: ${item.planSteps.slice(0, 4).join(' > ')}`);
    if (item.blocker) bits.push(`blocker: ${item.blocker}`);
    if (item.evidenceRef) bits.push(`evidence: ${item.evidenceRef}`);
    return '- ' + bits.filter(Boolean).join(' · ');
  };
  return [
    '# Shared exploration agenda',
    `Status: ${agenda.counts.planned ?? 0} planned, ${agenda.counts.active ?? 0} active, ${agenda.counts.blocked ?? 0} blocked, ${agenda.counts.done ?? 0} done, ${agenda.counts.dropped ?? 0} dropped.`,
    'Rules: before proposing an intent, match it against every agenda entry below and against Worker plan steps; never rerun completed content, duplicate an active/planned item, or repeat a failed method. Reuse the cited evidence instead. Record new exploration directions with exploration_todo (content + dedupe_key + method + acceptance) before referencing them. Failed or blocked items need a materially different method; adopt gap/换方法 suggestions or mark them dropped. Worker plan steps are execution detail, not evidence.',
    ...(open.length ? ['Open agenda:', ...open.map(line)] : []),
    ...(done.length ? ['Recently confirmed:', ...done.map(line)] : []),
    ...(dropped.length ? ['Recently dropped:', ...dropped.map(line)] : [])
  ].join('\n');
}
