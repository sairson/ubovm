/** Validate persisted structured results consistently at both decision boundaries.
 * Tool ledger authentication remains the Worker's responsibility at write time.
 */
export function completionEvidenceIssue(content, keyPoints = [], sourceType) {
  let fact;
  try { fact = JSON.parse(content); } catch { /* Legacy text facts remain supported. */ }
  const structured = fact?.version === 1;
  if (!structured && sourceType !== 'pi-worker') return;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const terminal = value => ['confirmed', 'negative'].includes(value);
  if (!structured || !text(fact.statement) || !terminal(fact.outcome) ||
      !Array.isArray(fact.evidence) || !fact.evidence.length ||
      fact.evidence.some(item => !item || !text(item.observation) ||
        (text(item.toolCallId) ? Object.hasOwn(item, 'nodeRef') : !text(item.nodeRef) || Object.hasOwn(item, 'toolCallId'))) ||
      !Array.isArray(fact.coverage) || fact.coverage.some(item => !item || !text(item.point) || !terminal(item.status) || !text(item.result)) ||
      ['failedChecks', 'limitations'].some(key => fact[key] !== undefined &&
        (!Array.isArray(fact[key]) || fact[key].some(item => !text(item)))) ||
      (fact.nextSteps !== undefined && (!Array.isArray(fact.nextSteps) || fact.nextSteps.length))) {
    return 'contains unresolved or malformed Worker evidence';
  }
  const covered = new Set(fact.coverage.map(item => item.point));
  if (covered.size !== fact.coverage.length || covered.size !== new Set(keyPoints).size || keyPoints.some(point => !covered.has(point))) {
    return 'does not cover every required key point exactly once';
  }
}

/** Resolve current independent results and legacy embedded results without accepting arbitrary notes. */
export function workerEvidence(nodes, id) {
  let node = nodes.find(node => node.id === id);
  if (node?.kind === 'intent' && node.resultId) node = nodes.find(item => item.id === node.resultId);
  if (node?.kind === 'intent' && node.intent?.status === 'completed' && node.fact) return { node, producer: node };
  if (node?.kind !== 'fact' || !node.fact || !node.producerId) return undefined;
  const producer = nodes.find(item => item.id === node.producerId);
  if (producer?.kind !== 'intent' || producer.intent?.status !== 'completed' || producer.resultId !== node.id ||
      node.fact.attemptId !== producer.attempts.at(-1)?.id) return undefined;
  return { node, producer };
}
