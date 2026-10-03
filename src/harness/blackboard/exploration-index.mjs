/** A navigation index, not a second source of truth or a goal-completion decision. */
export function buildExplorationIndex(nodes) {
  const byRef = new Map(nodes.map(node => [node.ref, node]));
  const followUps = new Map();
  const activeIntents = [], failedIntents = [], findings = [], gaps = [];
  for (const node of nodes) {
    if (!node.intent) continue;
    if (['pending', 'running'].includes(node.intent.status)) activeIntents.push(node.ref);
    if (['failed', 'interrupted'].includes(node.intent.status)) failedIntents.push(node.ref);
    for (const parent of new Set(node.parents.map(ref => byRef.get(ref)?.result || ref))) {
      if (!followUps.has(parent)) followUps.set(parent, []);
      followUps.get(parent).push(node.ref);
    }
  }
  for (const node of nodes) {
    if (!node.fact) continue;
    const producer = node.kind === 'fact' ? byRef.get(node.producer) : node;
    if (producer?.kind !== 'intent' || producer.intent?.status !== 'completed' ||
        (node.kind === 'fact' && producer.result !== node.ref)) continue;
    let fact;
    try { fact = JSON.parse(node.fact); } catch { /* Legacy evidence stays in the graph. */ }
    if (fact?.version !== 1 || !node.assessment) continue;
    const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
    const nextSteps = strings(fact.nextSteps);
    if (typeof fact.statement === 'string' && fact.statement.trim()) {
      findings.push({ ref: node.ref, statement: fact.statement, outcome: typeof fact.outcome === 'string' ? fact.outcome : 'unknown',
        completionEligible: node.assessment.completionIssue === null });
    }
    if (node.assessment.completionIssue !== null || nextSteps.length) {
      gaps.push({ ref: node.ref, unresolvedKeyPoints: [...node.assessment.unresolvedKeyPoints],
        nextSteps, followUpRefs: followUps.get(node.ref) ?? [] });
    }
  }
  const frontier = gaps.map(gap => {
    const activeRefs = [], resultRefs = [], failedRefs = [];
    for (const ref of gap.followUpRefs) {
      const node = byRef.get(ref);
      if (['pending', 'running'].includes(node?.intent?.status)) activeRefs.push(ref);
      else if (['failed', 'interrupted'].includes(node?.intent?.status)) failedRefs.push(ref);
      else if (node?.intent?.status === 'completed') {
        const result = node.result ? byRef.get(node.result) : node.fact ? node : undefined;
        if (result?.fact) resultRefs.push(result.ref);
      }
    }
    // A completed follow-up needs review, never automatic closure: its result
    // can be partial, contradictory, or cover only one part of the source gap.
    const status = resultRefs.length ? 'review_results' : activeRefs.length ? 'in_progress'
      : failedRefs.length ? 'needs_replan' : 'unassigned';
    return { sourceRef: gap.ref, status, activeRefs, resultRefs, failedRefs };
  });
  return { findings, gaps, frontier, activeIntents, failedIntents };
}
