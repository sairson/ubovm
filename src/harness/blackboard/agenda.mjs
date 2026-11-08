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

/** Classify why a path failed so Reason can choose a materially different next method. */
export function classifyBlocker(blocker) {
  const text = String(blocker ?? '');
  if (/401|403|unauthor|forbidden|permission|denied|credential|login|token|auth/i.test(text)) return 'auth';
  if (/429|rate.?limit|too many/i.test(text)) return 'rate-limit';
  if (/timeout|timed out|ECONN|ENOTFOUND|network|unreachable|DNS|connection (?:refused|reset)/i.test(text)) return 'network';
  if (/command not found|not installed|ENOENT|unavailable|disabled|tool.*missing/i.test(text)) return 'tooling';
  if (/404|not found|missing|no such|不存在/i.test(text)) return 'missing';
  if (/scope|out of scope|authoriz|policy|forbidden target/i.test(text)) return 'scope';
  return 'unknown';
}

const BLOCKER_ALTERNATIVES = {
  auth: '先确认凭据/会话获取路径，再重试该检查',
  'rate-limit': '降低速率，或改用被动/缓存来源',
  network: '先验证网络可达性与执行环境，再用不同传输或超时重试',
  missing: '先做端点/资产发现，确认目标存在',
  tooling: '补齐外部工具，或改用本地替代方法',
  scope: '回到授权范围内，不要扩大目标',
  unknown: '换用信息增益更高的不同方法'
};

function blockerAlternative(kind) {
  return BLOCKER_ALTERNATIVES[kind] ?? BLOCKER_ALTERNATIVES.unknown;
}

function priorityRank(priority) {
  return priority === 'high' ? 0 : priority === 'low' ? 2 : 1;
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
    const blocker = latestBlocker(node);
    const blockerClass = blocker ? classifyBlocker(blocker) : undefined;
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
      ...(blocker ? { blocker, blockerClass, methodAlternative: blockerAlternative(blockerClass) } : {}),
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
        ...(item.ref ? { ref: item.ref } : {}),
        title: `换一种方法继续：${item.title}`,
        dedupeKey: normalize(`alternative method ${item.title}`).slice(0, DEDUPE_LIMIT),
        ...(item.blocker ? { blocker: item.blocker } : {}),
        ...(item.blockerClass ? { blockerClass: item.blockerClass } : {}),
        ...(item.blockerClass ? { methodAlternative: item.methodAlternative } : {})
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
        ...(item.ref ? { ref: item.ref } : {}),
        title: `补充验证：${gap.point}`,
        dedupeKey: normalize(`verify gap ${gap.point}`).slice(0, DEDUPE_LIMIT),
        ...(gap.note ? { blocker: gap.note } : {})
      });
    }
  }
  items.push(...suggestions);

  // A bounded path audit for the cruise planner: failed branches are wrong
  // paths to avoid; open branches are ranked by decision value so Reason can
  // choose a next path instead of adding equivalent breadth.
  const deadEnds = items.filter(item => item.kind === 'intent' && item.status === 'blocked')
    .map(item => ({ ref: item.ref, intentId: item.intentId, title: item.title, attempts: item.attempts,
      blockerClass: item.blockerClass, blocker: item.blocker, methodAlternative: item.methodAlternative }))
    .slice(0, 5);
  const next = items.filter(item => item.kind === 'intent' && ['planned', 'active'].includes(item.status))
    .map(item => ({ ref: item.ref, intentId: item.intentId, title: item.title, status: item.status,
      priority: item.priority, attempts: item.attempts, gaps: item.gaps?.length ?? 0 }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
      || right.gaps - left.gaps || left.attempts - right.attempts)
    .slice(0, 4);
  const pathReview = { deadEnds, next };

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
    pathReview,
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
 *
 * The default renderer is the human/tool view and repeats intent titles. Model
 * prompts use `compact: true`: intent lines are addressed by their graph alias
 * (nX) and the title/description already in the evidence graph or blackboard
 * JSON is not repeated, which keeps the shared board usable without paying for
 * the same description twice in one request. Directions are Reason-owned and
 * have no other projection, so their content/method/acceptance stay verbatim.
 */
export function renderAgenda(agenda, { maxOpen = 18, maxDone = 8, compact = false } = {}) {
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
    if (item.blockerClass) bits.push(`class: ${item.blockerClass}`);
    if (item.blocker) bits.push(`blocker: ${item.blocker}`);
    if (item.methodAlternative) bits.push(`try: ${item.methodAlternative}`);
    if (item.evidenceRef) bits.push(`evidence: ${item.evidenceRef}`);
    return '- ' + bits.filter(Boolean).join(' · ');
  };
  // Compact prompt line: alias-addressed intents, full direction content.
  const compactLine = item => {
    const bits = [`[${item.status}]`];
    if (item.kind === 'intent') {
      bits.push(`intent ${item.ref ?? ''}`.trim());
      if (item.currentStep) bits.push(`current: ${clip(item.currentStep, 200)}`);
      if (item.planSteps?.length) bits.push(`plan: ${item.planSteps.slice(0, 3).map(step => clip(step, 120)).join(' > ')}`);
      if (item.blockerClass) bits.push(`class: ${item.blockerClass}`);
      if (item.blocker) bits.push(`blocker: ${clip(item.blocker, 200)}`);
      if (item.evidenceRef) bits.push(`evidence: ${item.evidenceRef}`);
      return '- ' + bits.filter(Boolean).join(' · ');
    }
    if (item.kind === 'direction') {
      bits.push('direction', clip(item.title, 240));
      if (item.method) bits.push(`method: ${clip(item.method, 160)}`);
      if (item.acceptance) bits.push(`acceptance: ${clip(item.acceptance, 160)}`);
      return '- ' + bits.filter(Boolean).join(' · ');
    }
    const target = item.ref ?? item.intentId ?? '';
    bits.push(`suggestion ${target}`.trim());
    // A retry suggestion only points at the source intent; repeating its long
    // description here would duplicate the graph line it refers to.
    if (item.source === 'failure') bits.push('retry: ' + clip(item.methodAlternative || 'use a materially different method', 160));
    else bits.push(clip(item.title, 160));
    if (item.blockerClass) bits.push(`class: ${item.blockerClass}`);
    if (item.blocker) bits.push(`note: ${clip(item.blocker, 160)}`);
    return '- ' + bits.filter(Boolean).join(' · ');
  };
  const renderLine = compact ? compactLine : line;
  const rules = compact
    ? 'Rules: dedupe against these entries; nX refs resolve in the evidence graph / blackboard JSON. Failed/blocked entries are wrong paths: use the class-specific alternative, never repeat the method. Path review ranks next; prefer a prerequisite or discriminating check over equivalent breadth. Navigation only, never evidence.'
    : 'Rules: before proposing an intent, match it against every agenda entry and Worker plan step; never rerun completed content, duplicate planned/active work, or repeat a failed method. Reuse cited evidence. Record a new direction with exploration_todo (content + dedupe_key + method + acceptance). Failed/blocked entries are wrong paths: use the class-specific alternative or mark them dropped. Path review ranks next candidates; prefer prerequisites and discriminating checks over equivalent breadth. Worker plan steps are execution detail, not evidence.';
  const lines = [
    '# Shared exploration agenda',
    `Status: ${agenda.counts.planned ?? 0} planned, ${agenda.counts.active ?? 0} active, ${agenda.counts.blocked ?? 0} blocked, ${agenda.counts.done ?? 0} done, ${agenda.counts.dropped ?? 0} dropped.`,
    rules
  ];
  const path = agenda.pathReview;
  if (path && (path.deadEnds?.length || path.next?.length)) {
    const wrong = path.deadEnds?.slice(0, 3).map(item => `${item.ref ?? item.intentId}:${item.blockerClass ?? 'unknown'}`).join(', ');
    const next = path.next?.slice(0, 3).map(item => `${item.ref ?? item.intentId}:${item.priority ?? 'medium'}`).join(', ');
    lines.push(`Path review — wrong paths: ${wrong || 'none'}; candidate next: ${next || 'none'}. Use a class-specific alternative; never repeat a failed method.`);
  }
  return [
    ...lines,
    ...(open.length ? ['Open agenda:', ...open.map(renderLine)] : []),
    ...(done.length ? ['Recently confirmed:', ...done.map(renderLine)] : []),
    ...(dropped.length ? ['Recently dropped:', ...dropped.map(renderLine)] : [])
  ].join('\n');
}
