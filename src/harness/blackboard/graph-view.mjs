/**
 * Complete-topology graph projection for Reason.
 *
 * The blackboard JSON projection is accurate but expensive: pretty-printed node
 * and fact objects repeat keys and carry full evidence bodies. This renderer keeps
 * EVERY node and parent edge in a compact one-line-per-node form, always reports
 * the completeness/detail level, and degrades fact detail deterministically while
 * keeping the graph readable through the exploration_graph tool.
 */
export const GRAPH_DETAIL_LEVELS = Object.freeze(['full', 'summary', 'topology-only']);
const MIN_LINE_CHARS = 18;

const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};
const refOf = index => `n${index + 1}`;

function factFields(node) {
  if (typeof node.fact?.content !== 'string') return {};
  let fact;
  try { fact = JSON.parse(node.fact.content); } catch { return { statement: node.fact.content }; }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { statement: node.fact.content };
  const coverage = Array.isArray(fact.coverage) ? fact.coverage : [];
  const unresolved = coverage.filter(item => item && !['confirmed', 'negative'].includes(item.status)).map(item => item.point).filter(Boolean);
  return {
    statement: typeof fact.statement === 'string' ? fact.statement : node.fact.content,
    ...(typeof fact.outcome === 'string' ? { outcome: fact.outcome } : {}),
    ...(coverage.length ? { coverage: { total: coverage.length, confirmed: coverage.filter(item => ['confirmed', 'negative'].includes(item?.status)).length } } : {}),
    ...(unresolved.length ? { gaps: unresolved } : {}),
    ...(Array.isArray(fact.limitations) ? { limitations: fact.limitations.filter(item => typeof item === 'string') } : {}),
    ...(Array.isArray(fact.nextSteps) ? { nextSteps: fact.nextSteps.filter(item => typeof item === 'string') } : {})
  };
}

const profileFor = detail => detail === 'full'
  ? { desc: 240, statement: 360, point: 120, list: 4, item: 160 }
  : detail === 'summary'
    ? { desc: 72, statement: 120, point: 40, list: 1, item: 64 }
    : { desc: 0, statement: 0, point: 0, list: 0, item: 0 };

function renderNode(node, index, detail, indexes) {
  const profile = profileFor(detail);
  const ref = refOf(index);
  const parents = (node.parentIds ?? []).map(id => {
    const parentIndex = indexes.get(id);
    return parentIndex === undefined ? '?' : refOf(parentIndex);
  });
  const parentText = parents.length ? ` <-${parents.join(',')}` : '';
  if (node.kind === 'root') {
    const goal = detail === 'topology-only' ? '' : ` "${clip(node.fact?.content, profile.statement)}"`;
    return `${ref} root${goal}`;
  }
  if (node.kind === 'fact') {
    const producerIndex = node.producerId ? indexes.get(node.producerId) : undefined;
    const producer = producerIndex === undefined ? '' : ` producer=${refOf(producerIndex)}`;
    if (detail === 'topology-only') {
      const outcome = typeof node.fact?.content === 'string' ? (() => { try { const parsed = JSON.parse(node.fact.content); return typeof parsed?.outcome === 'string' ? ` outcome=${parsed.outcome}` : ''; } catch { return ''; } })() : '';
      return `${ref} fact${parentText}${producer}${outcome} detail=omitted`;
    }
    const fields = factFields(node);
    const bits = [`${ref} fact${parentText}${producer}`];
    if (fields.outcome) bits.push(`outcome=${fields.outcome}`);
    if (fields.statement) bits.push(`statement="${clip(fields.statement, profile.statement)}"`);
    if (fields.coverage) bits.push(`coverage=${fields.coverage.confirmed}/${fields.coverage.total}`);
    if (fields.gaps?.length) bits.push(`gaps=[${fields.gaps.slice(0, profile.list).map(item => clip(item, profile.point)).join('|')}]`);
    if (fields.limitations?.length) bits.push(`limits=[${fields.limitations.slice(0, profile.list).map(item => clip(item, profile.item)).join('|')}]`);
    if (fields.nextSteps?.length) bits.push(`next=[${fields.nextSteps.slice(0, profile.list).map(item => clip(item, profile.point)).join('|')}]`);
    bits.push('detail=summary');
    return bits.join(' ');
  }
  const intent = node.intent ?? {};
  const bits = [`${ref} intent${parentText} status=${intent.status ?? 'unknown'}`];
  if (intent.priority) bits.push(`prio=${intent.priority}`);
  if (detail === 'topology-only') {
    if (node.resultId) {
      const resultIndex = indexes.get(node.resultId);
      if (resultIndex !== undefined) bits.push(`result=${refOf(resultIndex)}`);
    }
    bits.push('detail=omitted');
    return bits.join(' ');
  }
  // Completed Workers are archived to a single actionable line: their result
  // fact carries the evidence details, so repeating description/keyPoints/attempts
  // in every later review only bloats the context.
  if (intent.status === 'completed') {
    if (node.resultId) {
      const resultIndex = indexes.get(node.resultId);
      if (resultIndex !== undefined) bits.push(`result=${refOf(resultIndex)}`);
    }
    bits.push('detail=archived');
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

function render(snapshot, detail) {
  const index = indexOf(snapshot);
  const lines = [];
  let edges = 0;
  for (const node of snapshot.nodes) edges += node.parentIds?.length ?? 0;
  const intents = snapshot.nodes.filter(node => node.kind === 'intent').length;
  const facts = snapshot.nodes.filter(node => node.kind === 'fact').length;
  // Every fact body is on-demand: the graph carries summaries only, so count all
  // fact bodies as readable through exploration_graph read_fact.
  const factsOmitted = facts;
  lines.push('# Exploration graph (complete topology)');
  lines.push(`revision=${snapshot.revision} nodes=${snapshot.nodes.length} intents=${intents} facts=${facts} edges=${edges} root=${refOf(index.get(snapshot.rootId) ?? 0)} detail=${detail} omitted_fact_bodies=${factsOmitted}`);
  if (detail !== 'full') lines.push('Fact bodies are summarized/omitted; read exact content with exploration_graph action=read_fact ref=<nN>. Every node and parent edge is listed below.');
  for (const [position, node] of snapshot.nodes.entries()) lines.push(renderNode(node, position, detail, index));
  return { text: lines.join('\n'), index, intents, facts, edges, factsOmitted };
}

/**
 * Render the complete topology under a character budget. Topology is never
 * dropped: if even the terse form exceeds the budget the renderer returns it
 * anyway with over_budget=true so the host can surface the condition instead of
 * silently truncating branches.
 */
export function buildGraphView(snapshot, { maxChars = 80000, maxNodes = 0 } = {}) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes)) throw new TypeError('A blackboard snapshot is required');
  const limit = Number.isSafeInteger(maxChars) && maxChars > MIN_LINE_CHARS ? maxChars : 80000;
  const nodeLimit = Number.isSafeInteger(maxNodes) && maxNodes > 0 ? maxNodes : 0;
  let rendered;
  for (const detail of GRAPH_DETAIL_LEVELS) {
    rendered = render(snapshot, detail);
    if (rendered.text.length <= limit && (!nodeLimit || snapshot.nodes.length <= nodeLimit)) {
      return { ...graphResult(snapshot, rendered, detail, false), aliases: aliasMap(snapshot) };
    }
  }
  // A long campaign can grow the topology beyond any prompt budget. Keep the
  // complete topology contract for small/medium boards, but under an explicit
  // node budget render only the actionable frontier + recent tail. Decisions are
  // still validated against the full board; omitted nodes stay reachable through
  // exploration_graph search/node/read_fact.
  if (nodeLimit && snapshot.nodes.length > nodeLimit) {
    const bounded = renderBounded(snapshot, { nodeLimit });
    return { ...graphResult(snapshot, bounded, 'topology-only', false, true), aliases: aliasMap(snapshot) };
  }
  return { ...graphResult(snapshot, rendered, 'topology-only', true), aliases: aliasMap(snapshot) };
}

function renderBounded(snapshot, { nodeLimit }) {
  const index = indexOf(snapshot);
  const selected = new Set();
  const add = position => { if (position >= 0 && position < snapshot.nodes.length) selected.add(position); };
  const root = index.get(snapshot.rootId);
  add(root);
  const openStatuses = new Set(['pending', 'running', 'failed', 'interrupted', 'blocked']);
  for (const [position, node] of snapshot.nodes.entries()) {
    if (node.kind === 'intent' && openStatuses.has(node.intent?.status)) {
      add(position);
      for (const parentId of node.parentIds ?? []) add(index.get(parentId));
      if (node.resultId) add(index.get(node.resultId));
    }
  }
  // Recent tail keeps newly created facts/aliases visible even when they are not
  // attached to an open intent yet.
  for (let position = Math.max(0, snapshot.nodes.length - nodeLimit); position < snapshot.nodes.length; position++) add(position);
  // Keep direct parents for every selected node so parent edges never dangle.
  for (const position of [...selected]) {
    for (const parentId of snapshot.nodes[position].parentIds ?? []) add(index.get(parentId));
  }
  const positions = [...selected].sort((left, right) => left - right);
  const lines = [];
  let edges = 0;
  let intents = 0, facts = 0;
  for (const node of snapshot.nodes) {
    edges += node.parentIds?.length ?? 0;
    if (node.kind === 'intent') intents++;
    if (node.kind === 'fact') facts++;
  }
  lines.push('# Exploration graph (bounded topology)');
  lines.push(`revision=${snapshot.revision} nodes=${snapshot.nodes.length} intents=${intents} facts=${facts} edges=${edges} root=${refOf(root ?? 0)} detail=topology-only truncated=true listed_nodes=${positions.length} omitted_nodes=${snapshot.nodes.length - positions.length}`);
  lines.push('This view lists the root, open/failed branches, their direct parents/results and the recent tail. Other nodes and edges exist but are omitted from the prompt; locate them with exploration_graph action=overview/search, then node/children/parents/read_fact. Never invent an alias that is not returned by the graph tool.');
  for (const position of positions) lines.push(renderNode(snapshot.nodes[position], position, 'topology-only', index));
  return { text: lines.join('\n'), index, intents, facts, edges, factsOmitted: facts, listedNodes: positions.length };
}

function graphResult(snapshot, rendered, detail, overBudget, truncated = false) {
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
      root: refOf(rendered.index.get(snapshot.rootId) ?? 0),
      detail,
      omittedFacts: rendered.facts,
      overBudget,
      truncated,
      listedNodes: rendered.listedNodes ?? snapshot.nodes.length,
      chars: rendered.text.length
    }
  };
}

function aliasMap(snapshot) {
  return new Map(snapshot.nodes.map((node, index) => [refOf(index), node.id]));
}

/** Cheap completeness summary for the host/UI without rendering the full graph. */
export function graphStats(snapshot, { maxChars = 80000 } = {}) {
  return buildGraphView(snapshot, { maxChars }).stats;
}

export function graphNodeRef(snapshot, ref) {
  if (typeof ref !== 'string' || !/^n[1-9]\d*$/.test(ref.trim())) throw new TypeError('Graph ref must look like n3');
  const index = Number(ref.trim().slice(1)) - 1;
  const node = snapshot.nodes[index];
  if (!node) throw new Error(`Unknown graph ref: ${ref.trim()}`);
  return { node, index };
}

/** Compact one-node/edge listing used by subtree/children tool responses. */
export function renderGraphSubset(snapshot, ids, { detail = 'summary' } = {}) {
  const index = indexOf(snapshot);
  const wanted = new Set(ids);
  const lines = [];
  for (const [position, node] of snapshot.nodes.entries()) if (wanted.has(node.id)) lines.push(renderNode(node, position, detail, index));
  return lines.join('\n');
}

export function fullFactContent(snapshot, ref) {
  const { node } = graphNodeRef(snapshot, ref);
  return node.kind === 'fact' ? String(node.fact?.content ?? '') : '';
}
