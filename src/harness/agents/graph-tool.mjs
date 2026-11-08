import { Type } from 'typebox';
import { graphNodeRef } from '../blackboard/graph-view.mjs';
import { createGraphIndex } from '../blackboard/graph-index.mjs';

const READ_CHUNK = 12000;
const MAX_NODES = 80;
const MAX_RESPONSE_CHARS = 16000;
const ACTIONS = new Set(['overview', 'node', 'children', 'parents', 'subtree', 'search', 'read_fact', 'find', 'page', 'dependents', 'sources', 'neighbors', 'path']);
const WHERE_FIELDS = new Set(['kind', 'status', 'outcome', 'priority', 'source', 'parent', 'has']);

const result = value => {
  const capped = capResponse(value);
  return { content: [{ type: 'text', text: JSON.stringify(capped) }], details: capped };
};
const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};

/** Keep tool payloads bounded so one call cannot flood the review context. */
function capResponse(value) {
  if (!value || typeof value !== 'object') return value;
  if (JSON.stringify(value).length <= MAX_RESPONSE_CHARS) return value;
  const bounded = { ...value };
  for (const key of ['nodes', 'matches', 'sources', 'dependents', 'neighbors', 'edges']) {
    if (!Array.isArray(bounded[key])) continue;
    while (Array.isArray(bounded[key]) && bounded[key].length > 1 && JSON.stringify(bounded).length > MAX_RESPONSE_CHARS) {
      bounded[key] = bounded[key].slice(0, Math.max(1, Math.floor(bounded[key].length / 2)));
    }
  }
  bounded.truncated_reason = 'response_budget';
  return bounded;
}

/**
 * Reason-only graph reader. The prompt already contains the complete topology;
 * this tool answers "what exactly is in this branch/evidence" without bloating
 * every plan review with all fact bodies.
 */
export function createExplorationGraphTool({ build, info } = {}) {
  if (typeof build !== 'function') throw new TypeError('createExplorationGraphTool requires a build function');
  const buildIndex = snapshot => createGraphIndex(snapshot);
  const refOf = (snapshot, node) => `n${snapshot.nodes.indexOf(node) + 1}`;
  const context = () => {
    const built = build();
    const snapshot = built.snapshot;
    if (!snapshot || !Array.isArray(snapshot.nodes)) throw new Error('The exploration graph is unavailable.');
    return { snapshot, index: built.index ?? buildIndex(snapshot) };
  };
  const resolve = (snapshot, ref) => {
    if (typeof ref !== 'string' || !/^n[1-9]\d*$/.test(ref.trim())) throw new TypeError('ref must look like n3');
    return graphNodeRef(snapshot, ref);
  };
  const describe = (snapshot, index, node, position) => {
    const ref = position === undefined ? refOf(snapshot, node) : `n${position + 1}`;
    const bits = [ref, node.kind];
    if (node.intent) bits.push(`status=${node.intent.status}`, `desc="${clip(node.intent.description, 240)}"`);
    const view = index.factViewOf(node.id);
    if (view && typeof view.outcome === 'string') bits.push(`outcome=${view.outcome}`);
    if (view && typeof view.statement === 'string' && view.statement !== node.fact?.content) bits.push(`statement="${clip(view.statement, 240)}"`);
    if (view && Array.isArray(view.coverage) && view.coverage.length) bits.push(`coverage=${view.coverage.filter(item => ['confirmed', 'negative'].includes(item?.status)).length}/${view.coverage.length}`);
    return bits.join(' ');
  };
  const line = (snapshot, index, id) => {
    const node = snapshot.nodes[index.positionById.get(id)];
    return describe(snapshot, index, node, index.positionById.get(id));
  };
  const parseWhere = (index, where) => {
    if (where === undefined) return [];
    if (typeof where !== 'string') throw new TypeError('where must be a string');
    const tokens = where.trim().split(/\s+/u).filter(Boolean);
    if (tokens.length > 16) throw new RangeError('where supports at most 16 terms');
    return tokens.map(token => {
      const colon = token.indexOf(':');
      if (colon < 0) return { kind: 'text', value: token.toLowerCase() };
      const field = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1);
      if (!WHERE_FIELDS.has(field) || !value) throw new Error(`Unknown filter field ${JSON.stringify(field)}. Allowed: ${[...WHERE_FIELDS].join(', ')}.`);
      if (field === 'parent') {
        const parentId = index.idByRef.get(value);
        if (parentId === undefined) throw new Error(`Unknown parent alias ${JSON.stringify(value)}. Use overview/find to list refs.`);
        return { kind: 'parent', value: parentId };
      }
      return { kind: field, value: value.toLowerCase() };
    });
  };
  const matchesWhere = (snapshot, index, node, terms) => {
    const view = index.factViewOf(node.id);
    const haystack = [
      node.intent?.description, ...(node.intent?.keyPoints ?? []), view?.statement, node.fact?.content
    ].filter(value => typeof value === 'string').join('\n').toLowerCase();
    for (const term of terms) {
      if (term.kind === 'text') { if (!haystack.includes(term.value)) return false; continue; }
      if (term.kind === 'kind') { if (node.kind !== term.value) return false; continue; }
      if (term.kind === 'status') { if (node.intent?.status !== term.value) return false; continue; }
      if (term.kind === 'outcome') { if (view?.outcome !== term.value) return false; continue; }
      if (term.kind === 'priority') { if (node.intent?.priority !== term.value) return false; continue; }
      if (term.kind === 'source') { if ((node.provenance?.sourceType ?? '').toLowerCase() !== term.value) return false; continue; }
      if (term.kind === 'parent') { if (!(node.parentIds ?? []).includes(term.value)) return false; continue; }
      if (term.kind === 'has') {
        if (term.value === 'cites' && !index.citesOf(node.id).length) return false;
        if (term.value === 'coverage' && !(view?.coverage?.length)) return false;
        if (term.value === 'hint' && !(node.intent?.hint ?? '').trim()) return false;
        if (term.value === 'result' && !node.resultId) return false;
        if (!['cites', 'coverage', 'hint', 'result'].includes(term.value)) throw new Error('has: allows cites, coverage, hint or result.');
        continue;
      }
      return false;
    }
    return true;
  };
  const closure = (index, id, direction, depth) => {
    const seen = new Set([id]);
    let frontier = [id];
    for (let step = 0; step < depth; step++) {
      const next = [];
      for (const current of frontier) {
        const targets = direction === 'dependents' ? index.citedByOf(current) : index.citesOf(current);
        for (const target of targets) if (!seen.has(target)) { seen.add(target); next.push(target); }
      }
      frontier = next;
    }
    return [...seen].filter(item => item !== id);
  };
  // Every read-only relationship the graph stores. `kind` describes how the
  // neighbour relates to the current node, so a path can explain each hop.
  const adjacency = (index, id) => {
    const edges = [];
    for (const parentId of index.parentsOf(id)) edges.push({ id: parentId, kind: 'parent' });
    for (const childId of index.childrenOf(id)) edges.push({ id: childId, kind: 'child' });
    for (const targetId of index.citesOf(id)) edges.push({ id: targetId, kind: 'cites' });
    for (const sourceId of index.citedByOf(id)) edges.push({ id: sourceId, kind: 'citedBy' });
    const resultId = index.resultOf(id);
    if (resultId) edges.push({ id: resultId, kind: 'result' });
    const producerId = index.producerOf(id);
    if (producerId) edges.push({ id: producerId, kind: 'producer' });
    return edges.filter(edge => index.positionById.has(edge.id));
  };
  const tool = {
    name: 'exploration_graph', label: 'Explore the complete graph',
    description: 'Read the complete exploration graph on demand. The plan review already includes every node and parent edge in compact form; use this tool for exact details the compact view omits. Actions: overview (counts/detail level), node (one node summary; large facts stay in read_fact), children/parents (direct neighbors), subtree (bounded descendants), search (text, paginated), find (field filters), page (enumerate omitted nodes), dependents/sources (cross-fact citations), neighbors (all direct relations), path (shortest chain between two nodes over parent/child/cites/result links), read_fact (chunked full fact content; supports offset/nextOffset). Refs are the n1, n2 aliases from the graph. Action may be omitted when the fields are unambiguous: from+to=path, where=find, query=search, ref=node. Recipes: locate with search/find; inspect one node before reading its full fact; use dependents/sources for impact, path for chains, page for omitted ranges. Read the exact fact before treating it as evidence.',
    parameters: Type.Object({
      action: Type.Optional(Type.String({ maxLength: 24, description: 'overview | node | children | parents | subtree | search | read_fact | find | page | dependents | sources | neighbors | path; omit to infer from the supplied fields.' })),
      ref: Type.Optional(Type.String({ maxLength: 32, description: 'Node alias such as n7.' })),
      from: Type.Optional(Type.String({ maxLength: 32, description: 'For action=path: start node alias.' })),
      to: Type.Optional(Type.String({ maxLength: 32, description: 'For action=path: end node alias.' })),
      query: Type.Optional(Type.String({ maxLength: 500, description: 'For action=search: text to look for.' })),
      where: Type.Optional(Type.String({ maxLength: 500, description: 'For action=find: field:value terms, e.g. "kind:fact outcome:confirmed" or free words.' })),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: 'For subtree (default 2), path (default 6, max 8), dependents/sources (default 1, max 2).' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'For search/find/page: zero-based result offset.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_CHUNK, description: 'For read_fact: character count; for search/find/page: result count.' }))
    }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('exploration_graph arguments must be an object');
      for (const key of Object.keys(input)) if (!['action', 'ref', 'from', 'to', 'query', 'depth', 'offset', 'limit', 'where'].includes(key)) throw new Error(`Unknown exploration_graph field: ${key}`);
      const action = typeof input.action === 'string' && input.action.trim()
        ? input.action.trim().toLowerCase()
        : input.from !== undefined && input.to !== undefined ? 'path'
          : input.where !== undefined ? 'find'
            : input.query !== undefined ? 'search'
              : input.ref !== undefined ? 'node' : 'overview';
      if (!ACTIONS.has(action)) throw new Error(`Unknown exploration_graph action: ${action || '(empty)'}; use ${[...ACTIONS].join(', ')}`);
      const { snapshot, index } = context();
      const graphInfo = typeof info === 'function' ? info() : undefined;
      if (action === 'overview') {
        const counts = {};
        for (const node of snapshot.nodes) {
          const status = node.intent?.status ?? node.kind;
          counts[status] = (counts[status] ?? 0) + 1;
        }
        return result({
          revision: snapshot.revision, nodes: snapshot.nodes.length, edges: snapshot.nodes.reduce((sum, node) => sum + node.parentIds.length, 0),
          root: refOf(snapshot, snapshot.nodes.find(node => node.id === snapshot.rootId) ?? snapshot.nodes[0]), counts,
          cites: index.stats.cites, dangling_cites: index.stats.danglingCites, malformed_facts: index.stats.malformedFacts,
          ...(graphInfo?.stats ? { view: graphInfo.stats } : {}),
          guidance: graphInfo?.stats?.truncated
            ? 'The compact evidence graph is truncated for a long campaign; use search/find/page/node/read_fact to inspect omitted nodes. Every stored node still exists and aliases follow the complete board order.'
            : 'Every node/edge is in the compact graph; use node/children/subtree/read_fact for details.'
        });
      }
      const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      if (action === 'search') {
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        if (!query) throw new TypeError('action=search requires query');
        const limit = Math.min(Number.isSafeInteger(input.limit) ? Math.max(1, input.limit) : 20, 50);
        const matched = [];
        for (const [position, node] of snapshot.nodes.entries()) {
          const view = index.factViewOf(node.id);
          const haystack = [node.intent?.description, ...(node.intent?.keyPoints ?? []), view?.statement, node.fact?.content]
            .filter(value => typeof value === 'string').join('\n').toLowerCase();
          if (haystack.includes(query)) matched.push(position);
        }
        const page = matched.slice(offset, offset + limit);
        return result({
          query, total: matched.length, offset, limit,
          matches: page.map(position => describe(snapshot, index, snapshot.nodes[position], position)),
          nextOffset: offset + page.length < matched.length ? offset + page.length : null,
          truncated: offset + page.length < matched.length
        });
      }
      if (action === 'find') {
        const terms = parseWhere(index, input.where);
        const limit = Math.min(Number.isSafeInteger(input.limit) ? Math.max(1, input.limit) : 20, MAX_NODES);
        const positions = [];
        for (const [position, node] of snapshot.nodes.entries()) if (matchesWhere(snapshot, index, node, terms)) positions.push(position);
        const page = positions.slice(offset, offset + limit);
        return result({
          where: input.where ?? '', total: positions.length, offset, limit,
          nodes: page.map(position => describe(snapshot, index, snapshot.nodes[position], position)),
          nextOffset: offset + page.length < positions.length ? offset + page.length : null,
          truncated: offset + page.length < positions.length
        });
      }
      if (action === 'page') {
        const limit = Math.min(Number.isSafeInteger(input.limit) ? Math.max(1, input.limit) : 40, 120);
        const total = snapshot.nodes.length;
        const page = snapshot.nodes.slice(offset, offset + limit);
        return result({
          total, offset, limit,
          nodes: page.map((node, position) => describe(snapshot, index, node, offset + position)),
          nextOffset: offset + page.length < total ? offset + page.length : null,
          truncated: offset + page.length < total
        });
      }
      if (action === 'path') {
        const fromRef = typeof input.from === 'string' ? input.from.trim() : '';
        const toRef = typeof input.to === 'string' ? input.to.trim() : '';
        if (!fromRef || !toRef) throw new TypeError('action=path requires from and to aliases');
        const fromNode = resolve(snapshot, fromRef).node;
        const toNode = resolve(snapshot, toRef).node;
        const maxDepth = Math.min(Math.max(Number.isSafeInteger(input.depth) ? input.depth : 6, 1), 8);
        const previous = new Map([[fromNode.id, null]]);
        const queue = [{ id: fromNode.id, depth: 0 }];
        let found = fromNode.id === toNode.id;
        for (let cursor = 0; cursor < queue.length && !found && queue[cursor].depth < maxDepth; cursor++) {
          for (const edge of adjacency(index, queue[cursor].id)) {
            if (previous.has(edge.id)) continue;
            previous.set(edge.id, { id: queue[cursor].id, kind: edge.kind });
            if (edge.id === toNode.id) { found = true; break; }
            queue.push({ id: edge.id, depth: queue[cursor].depth + 1 });
          }
        }
        if (!found) {
          return result({
            from: fromRef, to: toRef, found: false, depth: maxDepth,
            guidance: 'No path within the depth limit over parent/child/cites/result links. Try a larger depth, search for a shared ancestor, or inspect both branches separately.'
          });
        }
        const nodes = [], pathEdges = [];
        for (let id = toNode.id; id;) {
          nodes.unshift(index.refById.get(id));
          const step = previous.get(id);
          if (!step) break;
          const edge = { from: index.refById.get(step.id), to: index.refById.get(id), kind: step.kind };
          // Citation hops carry the original observation so the chain explains
          // why the dependency exists; other hops stay structural.
          const detail = step.kind === 'cites'
            ? index.citationsOf(step.id).find(item => item.targetId === id)
            : step.kind === 'citedBy' ? index.citationsOf(id).find(item => item.targetId === step.id) : undefined;
          if (detail?.observation) edge.observation = clip(detail.observation, 160);
          pathEdges.unshift(edge);
          id = step.id;
        }
        return result({
          from: fromRef, to: toRef, found: true, length: pathEdges.length, depth: maxDepth,
          nodes: nodes.slice(0, MAX_NODES), edges: pathEdges.slice(0, MAX_NODES),
          ...(nodes.length > MAX_NODES ? { truncated: true } : {})
        });
      }
      const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
      if (!ref) throw new TypeError(`action=${action} requires ref`);
      if (action === 'read_fact') {
        const { node } = resolve(snapshot, ref);
        let factNode = node;
        if (node.kind === 'intent') {
          if (!node.resultId) throw new Error(`Intent ${ref} has not produced a fact yet.`);
          factNode = snapshot.nodes.find(item => item.id === node.resultId);
        }
        if (!factNode || factNode.kind !== 'fact') throw new Error(`${ref} is not backed by a fact.`);
        const content = String(factNode.fact?.content ?? '');
        const limit = Number.isSafeInteger(input.limit) ? Math.min(input.limit, READ_CHUNK) : READ_CHUNK;
        const chunk = content.slice(offset, offset + limit);
        const nextOffset = offset + chunk.length < content.length ? offset + chunk.length : null;
        return result({
          ref: refOf(snapshot, factNode), kind: 'fact', source_intent: ref,
          offset, limit, total: content.length, nextOffset, truncated: nextOffset !== null,
          content: chunk,
          ...(typeof factNode.factArtifactId === 'string' ? { artifactId: factNode.factArtifactId } : {})
        });
      }
      if (action === 'dependents' || action === 'sources') {
        const { node } = resolve(snapshot, ref);
        const depth = Math.min(Number.isSafeInteger(input.depth) ? input.depth : 1, 2);
        const all = closure(index, node.id, action, depth);
        const ids = all.slice(0, MAX_NODES);
        const direct = action === 'dependents' ? index.citationsTo(node.id) : index.citationsOf(node.id);
        return result({
          ref, action, depth,
          nodes: ids.map(id => line(snapshot, index, id)),
          citations: direct.slice(0, 20).map(item => ({
            from: index.refById.get(action === 'dependents' ? item.sourceId : node.id),
            to: index.refById.get(action === 'dependents' ? node.id : item.targetId),
            observation: clip(item.observation, 160)
          })),
          truncated: all.length > MAX_NODES
        });
      }
      if (action === 'neighbors') {
        const { node } = resolve(snapshot, ref);
        const all = adjacency(index, node.id);
        const shown = all.slice(0, 40);
        return result({
          ref, neighbors: shown.map(edge => {
            const neighbour = index.byId.get(edge.id);
            return { ref: index.refById.get(edge.id), relation: edge.kind, ...(neighbour?.kind ? { node: neighbour.kind } : {}) };
          }),
          truncated: all.length > shown.length
        });
      }
      const { node } = resolve(snapshot, ref);
      if (action === 'node') {
        const view = index.factViewOf(node.id);
        const intent = node.intent ? {
          description: node.intent.description, hint: node.intent.hint, priority: node.intent.priority,
          keyPoints: [...node.intent.keyPoints], status: node.intent.status
        } : undefined;
        const factContent = node.kind === 'fact' ? String(node.fact?.content ?? '') : undefined;
        const fact = factContent !== undefined && factContent.length <= 2000
          ? (() => { try { return JSON.parse(factContent); } catch { return factContent; } })()
          : undefined;
        return result({
          ref, node: node.kind,
          ...(intent ? { intent, attempts: node.attempts?.map(attempt => ({ status: attempt.status, error: attempt.error })) } : {}),
          ...(fact !== undefined ? { fact } : {}),
          ...(factContent !== undefined ? {
            fact_chars: factContent.length,
            statement: view?.statement ? clip(view.statement, 240) : undefined,
            outcome: view?.outcome,
            coverage: view?.coverage?.length ? {
              confirmed: view.coverage.filter(item => ['confirmed', 'negative'].includes(item?.status)).length,
              total: view.coverage.length
            } : undefined
          } : {}),
          parents: node.parentIds.map(id => refOf(snapshot, snapshot.nodes.find(item => item.id === id))),
          children: index.childrenOf(node.id).map(id => index.refById.get(id)),
          cites: index.citesOf(node.id).map(id => index.refById.get(id)),
          citedBy: index.citedByOf(node.id).map(id => index.refById.get(id)),
          result: node.resultId ? index.refById.get(node.resultId) : undefined,
          producer: node.producerId ? index.refById.get(node.producerId) : undefined,
          guidance: factContent !== undefined && factContent.length > 2000 ? 'Use read_fact for the full fact body.' : undefined
        });
      }
      if (action === 'parents' || action === 'children') {
        const ids = action === 'parents'
          ? node.parentIds
          : index.childrenOf(node.id);
        return result({ ref, action, nodes: ids.slice(0, MAX_NODES).map(id => line(snapshot, index, id)), truncated: ids.length > MAX_NODES });
      }
      if (action === 'subtree') {
        const depthLimit = Number.isSafeInteger(input.depth) ? input.depth : 2;
        const seen = new Set([node.id]);
        let frontier = [node.id];
        for (let depth = 0; depth < depthLimit && frontier.length; depth++) {
          frontier = snapshot.nodes.filter(item => item.parentIds.some(id => frontier.includes(id))).map(item => item.id)
            .filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
        }
        const ids = [...seen].slice(0, MAX_NODES);
        // One representation: describe lines. The rendered subset duplicated the
        // same nodes in a second, larger payload.
        return result({ ref, depth: depthLimit, nodes: ids.map(id => line(snapshot, index, id)), truncated: seen.size > MAX_NODES });
      }
      throw new Error(`Unknown exploration_graph action: ${action || '(empty)'}`);
    }
  };
  return tool;
}
