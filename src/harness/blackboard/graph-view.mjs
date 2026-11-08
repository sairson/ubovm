/**
 * Complete-topology graph projection for Reason.
 *
 * The blackboard JSON projection is accurate but expensive: pretty-printed node
 * and fact objects repeat keys and carry full evidence bodies. This renderer keeps
 * EVERY node and parent edge in a compact one-line-per-node form, always reports
 * the completeness/detail level, and degrades fact detail deterministically while
 * keeping the graph readable through the exploration_graph tool.
 *
 * A GraphIndex is built once per snapshot revision and shared by every render so
 * fact bodies are decoded once and cross-fact citations are available to the
 * renderer without a second scan.
 */
import { createGraphIndex, collectRelevantRefs } from './graph-index.mjs';
import { BOUNDED_RETAINED_INTENT_STATUSES } from './blackboard.mjs';

export const GRAPH_DETAIL_LEVELS = Object.freeze(['full', 'summary', 'topology-only']);
const MIN_LINE_CHARS = 18;

const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};
const refOf = index => `n${index + 1}`;

/** Fact summary fields. The index parsed the body once, so this is pure. */
function factFields(view) {
  if (!view) return {};
  const statement = typeof view.statement === 'string' ? view.statement : '';
  if (!view.parsed) return { statement };
  const coverage = Array.isArray(view.coverage) ? view.coverage : [];
  const unresolved = coverage.filter(item => item && !['confirmed', 'negative'].includes(item.status)).map(item => item.point).filter(Boolean);
  return {
    statement,
    ...(typeof view.outcome === 'string' ? { outcome: view.outcome } : {}),
    ...(coverage.length ? { coverage: { total: coverage.length, confirmed: coverage.filter(item => ['confirmed', 'negative'].includes(item?.status)).length } } : {}),
    ...(unresolved.length ? { gaps: unresolved } : {}),
    ...(view.limitations.length ? { limitations: view.limitations.filter(item => typeof item === 'string') } : {}),
    ...(view.nextSteps.length ? { nextSteps: view.nextSteps.filter(item => typeof item === 'string') } : {})
  };
}

const profileFor = detail => detail === 'full'
  ? { desc: 240, statement: 360, point: 120, list: 4, item: 160 }
  : detail === 'summary'
    ? { desc: 72, statement: 120, point: 40, list: 1, item: 64 }
    : { desc: 0, statement: 0, point: 0, list: 0, item: 0 };

function citeText(node, detail, positions, graphIndex) {
  if (detail === 'topology-only') return undefined;
  const targets = graphIndex.citesOf(node.id);
  if (!targets.length) return undefined;
  const refs = targets.map(id => {
    const position = positions.get(id);
    return position === undefined ? '?' : refOf(position);
  });
  const shown = refs.slice(0, 5);
  return `cites=${shown.join(',')}${refs.length > shown.length ? `+${refs.length - shown.length}` : ''}`;
}

function renderNode(node, position, detail, positions, graphIndex, relevantRefs) {
  const profile = profileFor(detail);
  const ref = refOf(position);
  const parents = (node.parentIds ?? []).map(id => {
    const parentPosition = positions.get(id);
    return parentPosition === undefined ? '?' : refOf(parentPosition);
  });
  const parentText = parents.length ? ` <-${parents.join(',')}` : '';
  if (node.kind === 'root') {
    const goal = detail === 'topology-only' ? '' : ` "${clip(node.fact?.content, profile.statement)}"`;
    return `${ref} root${goal}`;
  }
  if (node.kind === 'fact') {
    const producerPosition = node.producerId ? positions.get(node.producerId) : undefined;
    const producer = producerPosition === undefined ? '' : ` producer=${refOf(producerPosition)}`;
    const cites = citeText(node, detail, positions, graphIndex);
    const view = graphIndex.factViewOf(node.id);
    if (detail === 'topology-only') {
      const outcome = typeof view?.outcome === 'string' ? ` outcome=${view.outcome}` : '';
      return `${ref} fact${parentText}${producer}${outcome} detail=omitted`;
    }
    const fields = factFields(view);
    const bits = [`${ref} fact${parentText}${producer}`];
    if (fields.outcome) bits.push(`outcome=${fields.outcome}`);
    if (fields.statement) bits.push(`statement="${clip(fields.statement, profile.statement)}"`);
    if (fields.coverage) bits.push(`coverage=${fields.coverage.confirmed}/${fields.coverage.total}`);
    if (fields.gaps?.length) bits.push(`gaps=[${fields.gaps.slice(0, profile.list).map(item => clip(item, profile.point)).join('|')}]`);
    if (fields.limitations?.length) bits.push(`limits=[${fields.limitations.slice(0, profile.list).map(item => clip(item, profile.item)).join('|')}]`);
    if (fields.nextSteps?.length) bits.push(`next=[${fields.nextSteps.slice(0, profile.list).map(item => clip(item, profile.point)).join('|')}]`);
    if (cites) bits.push(cites);
    bits.push('detail=summary');
    return bits.join(' ');
  }
  const intent = node.intent ?? {};
  const bits = [`${ref} intent${parentText} status=${intent.status ?? 'unknown'}`];
  if (intent.priority) bits.push(`prio=${intent.priority}`);
  if (detail === 'topology-only') {
    if (node.resultId) {
      const resultPosition = positions.get(node.resultId);
      if (resultPosition !== undefined) bits.push(`result=${refOf(resultPosition)}`);
    }
    bits.push('detail=omitted');
    return bits.join(' ');
  }
  // Completed Workers are archived to a single actionable line: their result
  // fact carries the evidence details, so repeating description/keyPoints/attempts
  // in every later review only bloats the context. Branches that open work still
  // depends on keep a compact coverage/keyPoint index so a long campaign can
  // deduplicate and reuse them without reading every archived result.
  if (intent.status === 'completed') {
    if (!node.resultId) return [...bits, 'detail=archived'].join(' ');
    const resultPosition = positions.get(node.resultId);
    if (resultPosition === undefined) return [...bits, 'detail=archived'].join(' ');
    const resultRef = refOf(resultPosition);
    bits.push(`result=${resultRef}`);
    const relevant = relevantRefs && (relevantRefs.has(ref) || relevantRefs.has(resultRef));
    if (!relevant) return [...bits, 'detail=archived'].join(' ');
    const resultView = graphIndex.factViewOf(node.resultId);
    const coverage = resultView?.coverage ?? [];
    bits.push(`cov=${coverage.filter(item => ['confirmed', 'negative'].includes(item?.status)).length}/${coverage.length}`);
    const keyPoints = (intent.keyPoints ?? []).map(point => clip(point, 32)).filter(Boolean).slice(0, 2);
    if (keyPoints.length) bits.push(`kp=[${keyPoints.join('|')}]`);
    return bits.join(' ');
  }
  if (Array.isArray(intent.keyPoints) && intent.keyPoints.length) bits.push(`kp=[${intent.keyPoints.slice(0, profile.list).map(item => clip(item, profile.point)).join('|')}]`);
  if (intent.description) bits.push(`desc="${clip(intent.description, profile.desc)}"`);
  if (node.attempts?.length) bits.push(`attempts=${node.attempts.length}`);
  const latest = node.attempts?.at(-1);
  if (intent.status === 'running' && latest?.checkpoint?.phase === 'execute' && typeof latest.checkpoint.plan?.[0]?.description === 'string') {
    bits.push(`step="${clip(latest.checkpoint.plan[0].description, profile.desc)}"`);
  }
  if (['failed', 'interrupted'].includes(intent.status) && latest?.error) bits.push(`error="${clip(latest.error, profile.desc)}"`);
  return bits.join(' ');
}

function indexOf(snapshot) {
  return new Map(snapshot.nodes.map((node, position) => [node.id, position]));
}

const countParts = (snapshot, graphIndex) => {
  let edges = 0;
  for (const node of snapshot.nodes) edges += node.parentIds?.length ?? 0;
  return {
    edges,
    intents: snapshot.nodes.filter(node => node.kind === 'intent').length,
    facts: snapshot.nodes.filter(node => node.kind === 'fact').length,
    cites: graphIndex.stats.cites
  };
};

const normalHeader = ({ counts, rootRef, detail, limit, overBudget, omittedRanges, usesIndex }) =>
  `nodes=${counts.nodes} intents=${counts.intents} facts=${counts.facts} edges=${counts.edges} root=${rootRef} detail=${detail} budget=${usesIndex}/${limit} over_budget=${overBudget} truncated=false omitted_nodes=0 omitted_ranges=${omittedRanges} cites=${counts.cites} fact_bodies=on_demand omitted_fact_bodies=${counts.facts}`;

const boundedHeader = ({ counts, rootRef, listedNodes, omittedNodes, omittedRanges, limit, usesIndex }) =>
  `nodes=${counts.nodes} intents=${counts.intents} facts=${counts.facts} edges=${counts.edges} root=${rootRef} detail=topology-only budget=${usesIndex}/${limit} over_budget=false truncated=true listed_nodes=${listedNodes} omitted_nodes=${omittedNodes} omitted_ranges=[${omittedRanges}] cites=${counts.cites} fact_bodies=on_demand omitted_fact_bodies=${counts.facts}`;

/** Insert a header whose `budget=<used>` reflects the finished text length. */
function finishText(lines, headerAt, buildHeader) {
  let used = 0;
  for (let pass = 0; pass < 6; pass++) {
    lines[headerAt] = buildHeader(used);
    const text = lines.join('\n');
    if (text.length === used) return text;
    used = text.length;
  }
  return lines.join('\n');
}

function render(snapshot, detail, graphIndex, relevantRefs, limit, overBudget = false, omittedRanges = 'none') {
  const positions = graphIndex.positionById;
  const lines = [];
  const counts = countParts(snapshot, graphIndex);
  counts.nodes = snapshot.nodes.length;
  lines.push('# Exploration graph (complete topology)');
  lines.push('');
  if (detail !== 'full') lines.push('Fact bodies are summarized/omitted; read exact content with exploration_graph action=read_fact ref=<nN>. Every node and parent edge is listed below.');
  for (const [position, node] of snapshot.nodes.entries()) lines.push(renderNode(node, position, detail, positions, graphIndex, relevantRefs));
  const rootPosition = positions.get(snapshot.rootId) ?? 0;
  const text = finishText(lines, 1, used => normalHeader({
    counts, rootRef: refOf(rootPosition), detail, limit, overBudget, omittedRanges, usesIndex: used
  }));
  return { text, positions, intents: counts.intents, facts: counts.facts, edges: counts.edges, factsOmitted: counts.facts, omittedRanges, chars: text.length };
}

/**
 * Render the complete topology under a character budget. Topology is never
 * dropped: if even the terse form exceeds the budget the renderer returns it
 * anyway with over_budget=true so the host can surface the condition instead of
 * silently truncating branches.
 */
export function buildGraphView(snapshot, { maxChars = 80000, maxNodes = 0, index, relevantRefs } = {}) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes)) throw new TypeError('A blackboard snapshot is required');
  const limit = Number.isSafeInteger(maxChars) && maxChars > MIN_LINE_CHARS ? maxChars : 80000;
  const nodeLimit = Number.isSafeInteger(maxNodes) && maxNodes > 0 ? maxNodes : 0;
  const graphIndex = index ?? createGraphIndex(snapshot);
  let rendered;
  for (const detail of GRAPH_DETAIL_LEVELS) {
    rendered = render(snapshot, detail, graphIndex, relevantRefs, limit);
    if (rendered.text.length <= limit && (!nodeLimit || snapshot.nodes.length <= nodeLimit)) {
      return { ...graphResult(snapshot, rendered, detail, false, false, limit), aliases: aliasMap(snapshot) };
    }
  }
  // A long campaign can grow the topology beyond any prompt budget. Keep the
  // complete topology contract for small/medium boards, but under an explicit
  // node budget render only the actionable frontier + recent tail. Decisions are
  // still validated against the full board; omitted nodes stay reachable through
  // exploration_graph search/node/read_fact.
  if (nodeLimit && snapshot.nodes.length > nodeLimit) {
    const bounded = renderBounded(snapshot, { nodeLimit, graphIndex, relevantRefs, limit });
    return { ...graphResult(snapshot, bounded, 'topology-only', false, true, limit), aliases: aliasMap(snapshot) };
  }
  // Re-render the terse form with over_budget=true so the model can tell a
  // complete terse view from a view that still exceeds its budget.
  rendered = render(snapshot, 'topology-only', graphIndex, relevantRefs, limit, true);
  return { ...graphResult(snapshot, rendered, 'topology-only', true, false, limit), aliases: aliasMap(snapshot) };
}

function omittedRangeText(snapshot, selected) {
  const ranges = [];
  let start;
  for (let position = 0; position < snapshot.nodes.length; position++) {
    if (selected.has(position)) {
      if (start !== undefined) { ranges.push([start, position - 1]); start = undefined; }
    } else if (start === undefined) start = position;
  }
  if (start !== undefined) ranges.push([start, snapshot.nodes.length - 1]);
  const shown = ranges.slice(0, 8).map(([from, to]) => from === to ? refOf(from) : `${refOf(from)}-${refOf(to)}`);
  return `${shown.join(',')}${ranges.length > shown.length ? `+${ranges.length - shown.length} ranges` : ''}`;
}

function renderBounded(snapshot, { nodeLimit, graphIndex, relevantRefs, limit }) {
  const positions = graphIndex.positionById;
  const selected = new Set();
  const add = position => { if (position >= 0 && position < snapshot.nodes.length) selected.add(position); };
  add(positions.get(snapshot.rootId) ?? 0);
  const retained = new Set(BOUNDED_RETAINED_INTENT_STATUSES);
  for (const [position, node] of snapshot.nodes.entries()) {
    if (node.kind === 'intent' && retained.has(node.intent?.status)) {
      add(position);
      for (const parentId of node.parentIds ?? []) add(positions.get(parentId));
      if (node.resultId) add(positions.get(node.resultId));
    }
  }
  // Recent tail keeps newly created facts/aliases visible even when they are not
  // attached to an open intent yet.
  for (let position = Math.max(0, snapshot.nodes.length - nodeLimit); position < snapshot.nodes.length; position++) add(position);
  // Keep direct parents for every selected node so parent edges never dangle.
  for (const position of [...selected]) {
    for (const parentId of snapshot.nodes[position].parentIds ?? []) add(positions.get(parentId));
  }
  const positionsSelected = [...selected].sort((left, right) => left - right);
  const omittedRanges = omittedRangeText(snapshot, selected);
  const counts = { ...countParts(snapshot, graphIndex), nodes: snapshot.nodes.length };
  const lines = [];
  lines.push('# Exploration graph (bounded topology)');
  lines.push('');
  lines.push('This view lists the root, open/failed branches, their direct parents/results and the recent tail. Other nodes and edges exist but are omitted from the prompt; locate them with exploration_graph action=overview/search, then page/node/children/parents/read_fact. Never invent an alias that is not returned by the graph tool.');
  for (const position of positionsSelected) lines.push(renderNode(snapshot.nodes[position], position, 'topology-only', positions, graphIndex, relevantRefs));
  const rootPosition = positions.get(snapshot.rootId) ?? 0;
  const text = finishText(lines, 1, used => boundedHeader({
    counts, rootRef: refOf(rootPosition),
    listedNodes: positionsSelected.length, omittedNodes: snapshot.nodes.length - positionsSelected.length,
    omittedRanges, limit, usesIndex: used
  }));
  return { text, positions, intents: counts.intents, facts: counts.facts, edges: counts.edges, factsOmitted: counts.facts, omittedRanges, listedNodes: positionsSelected.length };
}

function graphResult(snapshot, rendered, detail, overBudget, truncated = false, limit = rendered.text.length) {
  return {
    text: rendered.text,
    detail,
    overBudget,
    truncated,
    stats: {
      revision: snapshot.revision,
      nodes: snapshot.nodes.length,
      intents: rendered.intents,
      facts: rendered.facts,
      edges: rendered.edges,
      root: refOf(rendered.positions.get(snapshot.rootId) ?? 0),
      detail,
      omittedFacts: rendered.facts,
      overBudget,
      truncated,
      listedNodes: rendered.listedNodes ?? snapshot.nodes.length,
      omittedRanges: rendered.omittedRanges ?? 'none',
      chars: rendered.text.length,
      budgetChars: limit
    }
  };
}

function aliasMap(snapshot) {
  return new Map(snapshot.nodes.map((node, index) => [refOf(index), node.id]));
}

/** Cheap completeness summary for the host/UI without rendering the full graph. */
export function graphStats(snapshot, options = {}) {
  return buildGraphView(snapshot, options).stats;
}

export function graphNodeRef(snapshot, ref) {
  if (typeof ref !== 'string' || !/^n[1-9]\d*$/.test(ref.trim())) throw new TypeError('Graph ref must look like n3');
  const index = Number(ref.trim().slice(1)) - 1;
  const node = snapshot.nodes[index];
  if (!node) throw new Error(`Unknown graph ref: ${ref.trim()}`);
  return { node, index };
}

/** Compact one-node/edge listing used by subtree/children tool responses. */
export function renderGraphSubset(snapshot, ids, { detail = 'summary', index, relevantRefs } = {}) {
  const positions = index?.positionById ?? indexOf(snapshot);
  const graphIndex = index ?? createGraphIndex(snapshot);
  const wanted = new Set(ids);
  const lines = [];
  for (const [position, node] of snapshot.nodes.entries()) {
    if (wanted.has(node.id)) lines.push(renderNode(node, position, detail, positions, graphIndex, relevantRefs));
  }
  return lines.join('\n');
}

export function fullFactContent(snapshot, ref) {
  const { node } = graphNodeRef(snapshot, ref);
  return node.kind === 'fact' ? String(node.fact?.content ?? '') : '';
}

export { collectRelevantRefs };
