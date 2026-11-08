/**
 * Navigation brief for Reason reviews.
 *
 * Graph text is evidence (topology + fact summaries). This brief is the
 * complementary navigation channel: which evidence gaps are still open, what
 * lifecycle state each frontier branch is in, which human hints are active and
 * how much stored evidence exists. It is rendered deterministically under a
 * character budget and is always labelled as navigation, never proof.
 *
 * The brief consumes the same read-only GraphIndex / exploration index as the
 * renderer, so it never re-scans facts and never mutates the board.
 */
const STATUS_ORDER = Object.freeze({ review_results: 0, needs_replan: 1, in_progress: 2, unassigned: 3 });
const PRIORITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};
const refNumber = ref => Number(String(ref).replace(/^n/, '')) || 0;

/** Human hints attached to non-terminal intents, in a deterministic order. */
export function collectHints(snapshot, limit = 10) {
  const hints = [];
  for (const [position, node] of snapshot.nodes.entries()) {
    const hint = node.intent?.hint;
    if (typeof hint !== 'string' || !hint.trim()) continue;
    if (!['pending', 'running', 'failed', 'interrupted'].includes(node.intent.status)) continue;
    hints.push({ ref: `n${position + 1}`, hint: clip(hint, 320), status: node.intent.status, priority: node.intent.priority ?? 'medium' });
  }
  hints.sort((left, right) => (PRIORITY_ORDER[left.priority] ?? 1) - (PRIORITY_ORDER[right.priority] ?? 1) || refNumber(left.ref) - refNumber(right.ref));
  return hints.slice(0, limit);
}

function frontierLines(exploration, { compact = false } = {}) {
  const gapsByRef = new Map((exploration?.gaps ?? []).map(gap => [gap.ref, gap]));
  const entries = [...(exploration?.frontier ?? [])].sort((left, right) =>
    (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9) || refNumber(left.sourceRef) - refNumber(right.sourceRef));
  if (!entries.length) return ['frontier: none'];
  const lines = [];
  for (const entry of entries.slice(0, 6)) {
    const gap = gapsByRef.get(entry.sourceRef);
    const targets = [...(entry.activeRefs ?? []), ...(entry.resultRefs ?? []), ...(entry.failedRefs ?? [])].slice(0, 4);
    const targetText = targets.length ? ` → ${targets.join(',')}` : '';
    if (compact) {
      lines.push(`[${entry.status}] ${entry.sourceRef}${targetText}`);
      continue;
    }
    const bits = [`[${entry.status}] ${entry.sourceRef}${targetText}`];
    if (gap?.unresolvedKeyPoints?.length) bits.push(`kp=${gap.unresolvedKeyPoints.length}`);
    if (gap?.nextSteps?.length) bits.push(`next="${clip(gap.nextSteps[0], 100)}"`);
    lines.push(bits.join(' '));
  }
  if (entries.length > 6) lines.push(`(+${entries.length - 6} more frontier entries; use exploration_graph find status:…)`);
  return lines;
}

function gapLines(exploration, limit) {
  const gaps = [...(exploration?.gaps ?? [])].sort((left, right) =>
    (right.unresolvedKeyPoints?.length ?? 0) - (left.unresolvedKeyPoints?.length ?? 0) || refNumber(left.ref) - refNumber(right.ref));
  if (!gaps.length) return ['gaps: none'];
  return gaps.slice(0, limit).map(gap => {
    const point = clip(gap.unresolvedKeyPoints?.[0] ?? 'unresolved coverage', 120);
    const next = gap.nextSteps?.length ? ` next="${clip(gap.nextSteps[0], 100)}"` : '';
    return `${gap.ref} kp="${point}"${next}`;
  });
}

function hintLines(hints, limit) {
  if (!hints.length) return ['hints: none'];
  const shown = hints.slice(0, limit).map(hint => `${hint.ref} "${hint.hint}" (${hint.status}, ${hint.priority})`);
  if (hints.length > limit) shown.push(`(+${hints.length - limit} more hints)`);
  return shown;
}

function findingLine(exploration) {
  const findings = exploration?.findings ?? [];
  const eligible = findings.filter(finding => finding.completionEligible).length;
  return `findings: ${findings.length} completed, ${eligible} completion-eligible`;
}

const RULE = 'rule: review_results > needs_replan > in_progress > unassigned; navigation only, never evidence';

function buildLines({ snapshot, exploration, hints, surface }, level) {
  const lines = [`# Navigation brief (navigation only, not evidence) revision=${snapshot.revision}`];
  if (surface?.text) {
    const surfaceLines = String(surface.text).split('\n').filter(Boolean);
    if (level <= 1) lines.push(...surfaceLines.slice(0, 6));
    else if (level === 2) lines.push(...surfaceLines.slice(0, 2));
  }
  if (level <= 2) lines.push(...frontierLines(exploration, { compact: level >= 2 }));
  if (level <= 1) lines.push(...gapLines(exploration, level === 0 ? 4 : 2));
  if (level === 0) lines.push(...hintLines(hints, 4));
  else if (level <= 2 && hints.length) lines.push(`hints: ${hints.length} active (details omitted)`);
  if (level <= 2) lines.push(findingLine(exploration));
  if (level <= 1) lines.push(RULE);
  return lines;
}

/**
 * Render the navigation brief under `budgetChars`. Candidate renders go from
 * full to terse; the first one that fits is returned. The terse fallback keeps
 * every frontier ref/status so an over-budget review still knows where work is
 * open, and marks `truncated=true` in its stats.
 */
export function renderNavigationBrief({ snapshot, exploration, hints = [], surface, budgetChars = 1200 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) throw new TypeError('A blackboard snapshot is required for a navigation brief');
  const budget = Number.isSafeInteger(budgetChars) && budgetChars >= 200 ? budgetChars : 1200;
  let fallback;
  for (const level of [0, 1, 2, 3]) {
    const text = buildLines({ snapshot, exploration, hints, surface }, level).join('\n');
    if (text.length <= budget) {
      return { text: text || `# Navigation brief (navigation only, not evidence) revision=${snapshot.revision}`, stats: { chars: text.length, budgetChars: budget, truncated: level !== 0, level } };
    }
    fallback = text;
  }
  return { text: fallback.slice(0, budget), stats: { chars: budget, budgetChars: budget, truncated: true, level: 3, clipped: true } };
}
