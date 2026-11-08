/**
 * Read-only projection indexes for the blackboard DAG.
 *
 * The graph renderer, the exploration graph tool and the navigation brief all
 * need the same derived relationships (refs, children, result/producer links,
 * parsed facts and cross-fact citations). Building them once per snapshot
 * revision avoids re-scanning the node array and re-parsing every fact body in
 * each consumer, and gives the renderers one consistent fact view.
 *
 * The index never mutates the snapshot and never owns graph state.
 */
import { completionEvidenceIssue } from './evidence.mjs';

const REF = /^n[1-9]\d*$/u;

/** Parse one fact body once. `parsed` only means "a JSON object was decoded". */
function parseFactContent(content) {
  const view = {
    content: typeof content === 'string' ? content : '',
    parsed: false,
    structured: false,
    malformed: false,
    statement: typeof content === 'string' ? content : ''
  };
  if (typeof content !== 'string' || !content.trim()) return view;
  let fact;
  try {
    fact = JSON.parse(content);
  } catch {
    view.malformed = true;
    return view;
  }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    view.malformed = true;
    return view;
  }
  view.parsed = true;
  view.version = fact.version;
  view.structured = fact.version === 1;
  if (typeof fact.schema === 'string') view.schema = fact.schema;
  if (typeof fact.outcome === 'string') view.outcome = fact.outcome;
  if (typeof fact.statement === 'string') view.statement = fact.statement;
  view.coverage = Array.isArray(fact.coverage) ? fact.coverage : [];
  view.evidence = Array.isArray(fact.evidence) ? fact.evidence : [];
  view.failedChecks = Array.isArray(fact.failedChecks) ? fact.failedChecks : [];
  view.limitations = Array.isArray(fact.limitations) ? fact.limitations : [];
  view.nextSteps = Array.isArray(fact.nextSteps) ? fact.nextSteps : [];
  return view;
}

/**
 * Build all read-only indexes for one snapshot.
 * `navigationNodes()` mirrors the projection shape consumed by
 * `buildExplorationIndex` (ref/parents/result/producer/intent/fact/assessment).
 */
export function createGraphIndex(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes)) {
    throw new TypeError('A blackboard snapshot with nodes is required');
  }
  const nodes = snapshot.nodes;
  const refById = new Map();
  const idByRef = new Map();
  const positionById = new Map();
  const byId = new Map();
  for (const [position, node] of nodes.entries()) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id)) {
      throw new TypeError('Blackboard nodes must have unique, nonempty string IDs');
    }
    const ref = `n${position + 1}`;
    refById.set(node.id, ref);
    idByRef.set(ref, node.id);
    positionById.set(node.id, position);
    byId.set(node.id, node);
  }
  const children = new Map(nodes.map(node => [node.id, []]));
  let edges = 0;
  for (const node of nodes) {
    for (const parentId of node.parentIds ?? []) {
      edges += 1;
      const siblings = children.get(parentId);
      if (siblings) siblings.push(node.id);
    }
  }

  const factViews = new Map();
  function factViewOf(id) {
    if (factViews.has(id)) return factViews.get(id);
    const node = byId.get(id);
    const content = node?.fact?.content;
    const view = typeof content === 'string' ? parseFactContent(content) : undefined;
    if (view) factViews.set(id, view);
    return view;
  }

  // Cross-fact citations come from already-validated evidence nodeRef items.
  // Dangling references are counted but never thrown: legacy/custom facts may
  // still name a node that the current projection cannot resolve.
  const citesOut = new Map();
  const citesIn = new Map(nodes.map(node => [node.id, []]));
  // Citation details keep the literal observation so impact/path queries can say
  // *why* one fact depends on another, not only that it does.
  const citations = new Map();
  const citedByDetails = new Map(nodes.map(node => [node.id, []]));
  let cites = 0;
  let danglingCites = 0;
  const factNodes = nodes.filter(node => node.kind === 'fact' && typeof node.fact?.content === 'string');
  for (const node of factNodes) {
    const view = factViewOf(node.id);
    const targets = new Map();
    for (const item of view?.evidence ?? []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const raw = typeof item.nodeRef === 'string' ? item.nodeRef.trim() : '';
      if (!raw) continue;
      const targetId = REF.test(raw) ? idByRef.get(raw) : undefined;
      const target = targetId ? byId.get(targetId) : undefined;
      if (!targetId || !target || target.kind === 'root' || typeof target.fact?.content !== 'string' || targetId === node.id) {
        danglingCites += 1;
        continue;
      }
      if (!targets.has(targetId)) targets.set(targetId, typeof item.observation === 'string' ? item.observation : '');
    }
    citesOut.set(node.id, [...targets.keys()]);
    citations.set(node.id, [...targets].map(([targetId, observation]) => ({ targetId, observation })));
    for (const [targetId, observation] of targets) {
      cites += 1;
      citesIn.get(targetId)?.push(node.id);
      citedByDetails.get(targetId)?.push({ sourceId: node.id, observation });
    }
  }

  let navigation;
  function navigationNodes() {
    if (navigation) return navigation;
    navigation = nodes.map(node => {
      const projected = {
        ref: refById.get(node.id),
        kind: node.kind,
        parents: (node.parentIds ?? []).map(id => refById.get(id))
      };
      if (node.resultId) projected.result = refById.get(node.resultId);
      if (node.producerId) projected.producer = refById.get(node.producerId);
      if (node.intent) {
        projected.intent = {
          description: node.intent.description,
          hint: node.intent.hint,
          priority: node.intent.priority,
          keyPoints: [...(node.intent.keyPoints ?? [])],
          status: node.intent.status
        };
      }
      if (typeof node.fact?.content === 'string') {
        const view = factViewOf(node.id);
        projected.fact = node.fact.content;
        const producer = node.producerId ? byId.get(node.producerId) : node.intent ? node : undefined;
        if (producer?.intent && view?.version === 1) {
          const points = producer.intent.keyPoints ?? [];
          const coverage = view.coverage;
          const unresolved = points.filter(point => {
            const entries = coverage.filter(item => item?.point === point);
            return entries.length !== 1 || !['confirmed', 'negative'].includes(entries[0].status) ||
              typeof entries[0].result !== 'string' || !entries[0].result.trim();
          });
          projected.assessment = {
            unresolvedKeyPoints: unresolved,
            completionIssue: completionEvidenceIssue(node.fact.content, points, node.provenance?.sourceType) ?? null
          };
        }
      }
      return projected;
    });
    return navigation;
  }

  const malformedFacts = factNodes.filter(node => factViewOf(node.id)?.malformed).length;

  return {
    revision: snapshot.revision,
    nodes,
    refById,
    idByRef,
    positionById,
    byId,
    childrenOf: id => children.get(id) ?? [],
    parentsOf: id => byId.get(id)?.parentIds ?? [],
    resultOf: id => byId.get(id)?.resultId,
    producerOf: id => byId.get(id)?.producerId,
    factViewOf,
    citesOf: id => citesOut.get(id) ?? [],
    citedByOf: id => citesIn.get(id) ?? [],
    citationsOf: id => citations.get(id) ?? [],
    citationsTo: id => citedByDetails.get(id) ?? [],
    navigationNodes,
    stats: Object.freeze({ nodes: nodes.length, edges, facts: factNodes.length, cites, danglingCites, malformedFacts })
  };
}

/**
 * Nodes whose completed results are still relevant to open work: parents and
 * result facts of pending/running intents, plus the exploration frontier and
 * gap references. Used by the graph renderer to keep a compact, searchable
 * one-line index for those branches instead of archiving them unconditionally.
 */
export function collectRelevantRefs({ snapshot, index, exploration }) {
  const relevant = new Set();
  const add = ref => { if (typeof ref === 'string' && REF.test(ref)) relevant.add(ref); };
  for (const node of snapshot.nodes) {
    if (!['pending', 'running'].includes(node.intent?.status)) continue;
    for (const parentId of node.parentIds ?? []) add(index.refById.get(parentId));
    if (node.resultId) add(index.refById.get(node.resultId));
    add(index.refById.get(node.id));
  }
  for (const ref of exploration?.activeIntents ?? []) add(ref);
  for (const ref of exploration?.failedIntents ?? []) add(ref);
  for (const gap of exploration?.gaps ?? []) {
    add(gap.ref);
    for (const ref of gap.followUpRefs ?? []) add(ref);
  }
  for (const entry of exploration?.frontier ?? []) {
    add(entry.sourceRef);
    for (const ref of [...(entry.activeRefs ?? []), ...(entry.resultRefs ?? []), ...(entry.failedRefs ?? [])]) add(ref);
  }
  return relevant;
}
