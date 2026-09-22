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
