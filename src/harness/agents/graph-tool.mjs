import { Type } from 'typebox';
import { graphNodeRef, renderGraphSubset } from '../blackboard/graph-view.mjs';

const READ_CHUNK = 12000;
const MAX_NODES = 80;
const ACTIONS = new Set(['overview', 'node', 'children', 'parents', 'subtree', 'search', 'read_fact']);

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};

/**
 * Reason-only graph reader. The prompt already contains the complete topology;
 * this tool answers "what exactly is in this branch/evidence" without bloating
 * every plan review with all fact bodies.
 */
export function createExplorationGraphTool({ build, info } = {}) {
  if (typeof build !== 'function') throw new TypeError('createExplorationGraphTool requires a build function');
  const refOf = (snapshot, node) => `n${snapshot.nodes.indexOf(node) + 1}`;
  const resolve = (snapshot, ref) => {
    if (typeof ref !== 'string' || !/^n[1-9]\d*$/.test(ref.trim())) throw new TypeError('ref must look like n3');
    return graphNodeRef(snapshot, ref);
  };
  const describe = (snapshot, node, index) => {
    const ref = `n${index + 1}`;
    const bits = [ref, node.kind];
    if (node.intent) bits.push(`status=${node.intent.status}`, `desc="${clip(node.intent.description, 240)}"`);
    if (node.fact) {
      let fact;
      try { fact = JSON.parse(node.fact.content); } catch { fact = undefined; }
      if (fact?.outcome) bits.push(`outcome=${fact.outcome}`);
      if (typeof fact?.statement === 'string') bits.push(`statement="${clip(fact.statement, 240)}"`);
    }
    return bits.join(' ');
  };
  const tool = {
    name: 'exploration_graph', label: 'Explore the complete graph',
    description: 'Read the complete exploration graph on demand. The plan review already includes every node and parent edge in compact form; use this tool for exact details the compact view omits. Actions: overview (counts/detail level), node (one node summary), children/parents (direct neighbors), subtree (bounded descendants), search (find nodes by description/statement), read_fact (chunked full fact content; supports offset/nextOffset). Refs are the n1, n2 aliases from the graph. Read the exact fact before treating it as evidence.',
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 24, description: 'overview | node | children | parents | subtree | search | read_fact' }),
      ref: Type.Optional(Type.String({ maxLength: 32, description: 'Node alias such as n7.' })),
      query: Type.Optional(Type.String({ maxLength: 500, description: 'For action=search: text to look for.' })),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: 'For action=subtree: depth limit (default 2).' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'For action=read_fact: character offset (default 0).' })),
      limit: Type.Optional(Type.Integer({ minimum: 100, maximum: READ_CHUNK, description: 'For action=read_fact: character count (default 12000).' }))
    }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('exploration_graph arguments must be an object');
      for (const key of Object.keys(input)) if (!['action', 'ref', 'query', 'depth', 'offset', 'limit'].includes(key)) throw new Error(`Unknown exploration_graph field: ${key}`);
      const action = String(input.action ?? '').trim().toLowerCase();
      if (!ACTIONS.has(action)) throw new Error(`Unknown exploration_graph action: ${action || '(empty)'}; use overview, node, children, parents, subtree, search or read_fact`);
      const { snapshot } = build();
      if (!snapshot || !Array.isArray(snapshot.nodes)) throw new Error('The exploration graph is unavailable.');
      const graphInfo = typeof info === 'function' ? info() : undefined;
      if (action === 'overview') {
        const counts = {};
        for (const node of snapshot.nodes) {
          const status = node.intent?.status ?? node.kind;
          counts[status] = (counts[status] ?? 0) + 1;
        }
        return result({
          revision: snapshot.revision, nodes: snapshot.nodes.length, edges: snapshot.nodes.reduce((sum, node) => sum + node.parentIds.length, 0),
          root: refOf(snapshot, snapshot.nodes.find(node => node.id === snapshot.rootId) ?? snapshot.nodes[0]),
          counts, ...(graphInfo?.stats ? { view: graphInfo.stats } : {}),
          guidance: 'Every node/edge is in the compact graph; use node/children/subtree/read_fact for details.'
        });
      }
      if (action === 'search') {
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        if (!query) throw new TypeError('action=search requires query');
        const matches = [];
        for (const [index, node] of snapshot.nodes.entries()) {
          const haystack = [
            node.intent?.description, ...(node.intent?.keyPoints ?? []),
            node.fact?.content
          ].filter(value => typeof value === 'string').join('\n').toLowerCase();
          if (!haystack.includes(query)) continue;
          matches.push(describe(snapshot, node, index));
          if (matches.length >= 20) break;
        }
        return result({ query, matches, truncated: matches.length >= 20 });
      }
      const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
      if (!ref) throw new TypeError(`action=${action} requires ref`);
      if (action === 'read_fact') {
        const { node, index } = resolve(snapshot, ref);
        let factNode = node;
        if (node.kind === 'intent') {
          if (!node.resultId) throw new Error(`Intent ${ref} has not produced a fact yet.`);
          factNode = snapshot.nodes.find(item => item.id === node.resultId);
        }
        if (!factNode || factNode.kind !== 'fact') throw new Error(`${ref} is not backed by a fact.`);
        const content = String(factNode.fact?.content ?? '');
        const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
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
      const { node, index } = resolve(snapshot, ref);
      if (action === 'node') {
        return result({ ref, node: node.kind, ...(node.intent ? { intent: node.intent, attempts: node.attempts?.map(attempt => ({ status: attempt.status, error: attempt.error })) } : {}),
          ...(node.fact ? { fact: (() => { try { return JSON.parse(node.fact.content); } catch { return node.fact.content; } })(), fact_chars: String(node.fact.content).length } : {}),
          parents: node.parentIds.map(id => refOf(snapshot, snapshot.nodes.find(item => item.id === id))),
          result: node.resultId ? refOf(snapshot, snapshot.nodes.find(item => item.id === node.resultId)) : undefined,
          guidance: node.fact ? 'Use read_fact for chunked full content.' : undefined });
      }
      if (action === 'parents' || action === 'children') {
        const ids = action === 'parents'
          ? node.parentIds
          : snapshot.nodes.filter(item => item.parentIds.includes(node.id)).map(item => item.id);
        return result({ ref, action, nodes: ids.slice(0, MAX_NODES).map(id => describe(snapshot, snapshot.nodes.find(item => item.id === id), snapshot.nodes.findIndex(item => item.id === id))), truncated: ids.length > MAX_NODES });
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
        return result({ ref, depth: depthLimit, nodes: ids.map(id => describe(snapshot, snapshot.nodes.find(item => item.id === id), snapshot.nodes.findIndex(item => item.id === id))), truncated: seen.size > MAX_NODES, compact: renderGraphSubset(snapshot, ids, { detail: 'summary' }) });
      }
      throw new Error(`Unknown exploration_graph action: ${action || '(empty)'}`);
    }
  };
  return tool;
}
