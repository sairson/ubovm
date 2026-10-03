(() => {
  'use strict';
  // Frame-local spatial index. Oversized rectangles use a bounded fallback so
  // unusual canvas dimensions cannot allocate millions of grid buckets.
  window.createGraphCollisionIndex = () => {
    const cells = new Map(), all = [], oversized = [];
    const range = (box, padding) => {
      const values = [box.left - padding, box.top - padding, box.right + padding, box.bottom + padding];
      if (!values.every(Number.isFinite)) return null;
      const [left, top, right, bottom] = values.map(value => Math.floor(value / 256));
      if (![left, top, right, bottom].every(Number.isSafeInteger) || right < left || bottom < top ||
          (right - left + 1) * (bottom - top + 1) > 256) return null;
      return { left, top, right, bottom };
    };
    const intersects = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;
    return {
      add(box) {
        all.push(box);
        const area = range(box, 0);
        if (!area) { oversized.push(box); return; }
        for (let x = area.left; x <= area.right; x++) for (let y = area.top; y <= area.bottom; y++) {
          const key = `${x}:${y}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(box);
        }
      },
      intersects(box) {
        const area = range(box, 4);
        if (!area) return all.some(other => intersects(box, other));
        if (oversized.some(other => intersects(box, other))) return true;
        const seen = new Set();
        for (let x = area.left; x <= area.right; x++) for (let y = area.top; y <= area.bottom; y++) {
          for (const other of cells.get(`${x}:${y}`) || []) {
            if (seen.has(other)) continue;
            seen.add(other);
            if (intersects(box, other)) return true;
          }
        }
        return false;
      }
    };
  };
  // Directional traversal keeps unrelated sibling branches out of evidence traces.
  window.traceExplorationGraph = (graph, selected, direction) => {
    const seeds = graph.graphNodes.filter(n => n.id === selected || n.intentId === selected).map(n => n.id);
    for (const e of graph.edges) if (e.intentId === selected) seeds.push(direction === 'upstream' ? e.source : e.target);
    const adjacent = new Map();
    for (const edge of graph.edges) {
      const from = direction === 'upstream' ? edge.target : edge.source;
      const to = direction === 'upstream' ? edge.source : edge.target;
      if (!adjacent.has(from)) adjacent.set(from, []);
      adjacent.get(from).push(to);
    }
    const visited = new Set(seeds), queue = [...visited];
    for (let i = 0; i < queue.length; i++) for (const id of adjacent.get(queue[i]) || []) {
      if (!visited.has(id)) { visited.add(id); queue.push(id); }
    }
    return visited;
  };
  // Longest-parent layering in O(nodes + edges), including reverse-ordered chains.
  // Cycles and their blocked descendants retain the previous rank-zero fallback.
  window.rankExplorationGraph = nodes => {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const ranks = new Map(), remaining = new Map(), children = new Map(), depth = new Map(), queue = [];
    for (const [id, node] of byId) {
      const parents = [...new Set(node.parentIds || [])].filter(parent => byId.has(parent));
      remaining.set(id, parents.length);
      if (!parents.length) queue.push(id);
      for (const parent of parents) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(id);
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index], rank = depth.get(id) || 0;
      ranks.set(id, rank);
      for (const child of children.get(id) || []) {
        depth.set(child, Math.max(depth.get(child) || 0, rank + 1));
        const count = remaining.get(child) - 1; remaining.set(child, count);
        if (!count) queue.push(child);
      }
    }
    for (const id of byId.keys()) if (!ranks.has(id)) ranks.set(id, 0);
    return ranks;
  };
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
