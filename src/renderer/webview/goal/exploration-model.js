(() => {
  'use strict';
  // Project legacy intent+result records without changing durable IDs or scheduler semantics.
  window.projectExplorationGraph = snapshot => {
    const source = [...new Map((snapshot?.nodes || []).filter(n => n && typeof n.id === 'string').map(n => [n.id, n])).values()];
    const occupied = new Set(source.map(n => n.id)), results = new Map();
    for (const n of source) {
      if (n.kind !== 'intent' || n.resultId || n.intent?.status !== 'completed' || !n.fact?.content) continue;
      let id = `result:${n.id}`;
      while (occupied.has(id)) id = `result:${id}`;
      occupied.add(id); results.set(n.id, id);
    }
    const nodes = [];
    for (const n of source) {
      const parentIds = [...new Set(n.parentIds || [])].map(id => results.get(id) || id);
      nodes.push({ ...n, parentIds, sourceId: n.id, goal: n.kind === 'root' ? snapshot.goal : undefined,
        fact: n.kind === 'intent' ? null : n.fact, resultId: n.resultId || results.get(n.id) });
      if (results.has(n.id)) nodes.push({ id: results.get(n.id), sourceId: n.id, kind: 'fact', parentIds: [n.id],
        intent: null, fact: n.fact, attempts: [], producerId: n.id, provenance: n.provenance });
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    const graphNodes = nodes.filter(n => n.kind !== 'intent').map(n => ({ ...n, parentIds: [] })), edges = [];
    const resolveSource = id => byId.get(id)?.kind === 'intent' ? byId.get(id).resultId : id;
    for (const n of nodes) {
      if (n.kind === 'intent') {
        let target = n.resultId;
        if (!target || !byId.has(target)) {
          target = `frontier:${n.id}`;
          while (occupied.has(target)) target = `frontier:${target}`;
          occupied.add(target);
          graphNodes.push({ id: target, kind: 'frontier', intentId: n.id, parentIds: [], status: n.intent?.status });
        }
        for (const parent of new Set(n.parentIds.map(resolveSource).filter(Boolean))) {
          edges.push({ source: parent, target, intentId: n.id, status: n.intent?.status, description: n.intent?.description });
        }
      } else if (!n.producerId) {
        for (const parent of new Set(n.parentIds.map(resolveSource).filter(Boolean))) edges.push({ source: parent, target: n.id });
      }
    }
    const visible = new Map(graphNodes.map(n => [n.id, n]));
    const graphEdges = edges.filter(e => visible.has(e.source) && visible.has(e.target) && e.source !== e.target);
    for (const e of graphEdges) visible.get(e.target).parentIds.push(e.source);
    return { ...snapshot, nodes, graphNodes, edges: graphEdges, intentCount: source.filter(n => n.kind === 'intent').length,
      factCount: nodes.filter(n => n.kind === 'fact').length };
  };
})();
