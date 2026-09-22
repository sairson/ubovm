const ALIAS = /^n[1-9]\d*$/u;
const TERMINAL = new Set(['confirmed', 'negative']);
const normalize = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();

function invalid(message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: 'INVALID_REASON_DECISION' });
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value;
}

function fields(value, names, label) {
  record(value, label);
  const unknown = Object.keys(value).find(name => !names.includes(name));
  if (unknown !== undefined) throw invalid(`${label} contains unsupported field ${JSON.stringify(unknown)}. Human hints cannot be authored by Reason.`);
}

function text(value, label, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${label} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}

/** Validate the host's projection before sending its facts to a provider. */
export function validateReasonContext(context) {
  if (!context || typeof context.resolveId !== 'function' || !context.data ||
      typeof context.data.goal !== 'string' || !context.data.goal.trim() || !Array.isArray(context.data.nodes)) {
    throw new TypeError('Reason requires a Blackboard context with a goal, nodes and resolveId.');
  }
  const nodes = new Map();
  for (const node of context.data.nodes) {
    if (!node || !ALIAS.test(node.ref) || nodes.has(node.ref) || !Array.isArray(node.parents)) throw new TypeError('Reason context contains invalid node aliases.');
    context.resolveId(node.ref);
    nodes.set(node.ref, node);
  }
  if (nodes.get(context.data.root)?.kind !== 'root') throw new TypeError('Reason context requires its root node.');
  for (const node of nodes.values()) {
    if (node.parents.some(ref => !nodes.has(ref))) throw new TypeError('Reason context contains unknown parents.');
  }
  return nodes;
}

function refs(value, label, nodes, context) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw invalid(`${label} requires 1 to 64 current node aliases.`);
  const result = [];
  for (const ref of value) {
    if (typeof ref !== 'string' || !ALIAS.test(ref) || !nodes.has(ref)) throw invalid(`${label} contains an unknown node alias: ${String(ref)}.`);
    try { context.resolveId(ref); } catch (cause) { throw invalid(`${label} contains an unknown node alias: ${ref}.`, cause); }
    if (result.includes(ref)) throw invalid(`${label} contains duplicate node alias ${ref}.`);
    result.push(ref);
  }
  return result;
}

const intentKey = (intent, parents) => JSON.stringify([
  normalize(intent.description), [...new Set(intent.keyPoints.map(normalize))].sort(), [...parents].sort()
]);

function completionEvidence(node, nodes) {
  if (node.result) node = nodes.get(node.result);
  const producer = node?.kind === 'fact' ? nodes.get(node.producer) : node;
  if (!node || producer?.kind !== 'intent' || producer.intent?.status !== 'completed' ||
      (node.kind === 'fact' && producer.result !== node.ref) || typeof node.fact !== 'string' || !node.fact.trim()) {
    throw invalid('Evidence is not a completed Worker fact.');
  }
  let fact;
  try { fact = JSON.parse(node.fact); } catch { /* Legacy facts may be plain text. */ }
  const structured = fact?.version === 1 && typeof fact.statement === 'string' && typeof fact.outcome === 'string';
  if (!structured && node.evidence?.sourceType !== 'pi-worker') return;
  if (!structured || !fact.statement.trim() || !TERMINAL.has(fact.outcome) ||
      !Array.isArray(fact.evidence) || !fact.evidence.length || !Array.isArray(fact.coverage) ||
      fact.coverage.some(item => !item || typeof item.point !== 'string' || !TERMINAL.has(item.status) || typeof item.result !== 'string' || !item.result.trim())) {
    throw invalid(`${node.ref} contains unresolved or malformed Worker evidence; obtain decisive coverage before completion.`);
  }
  const covered = new Set(fact.coverage.map(item => item.point));
  if ((producer.intent.keyPoints ?? []).some(point => !covered.has(point))) throw invalid(`${node.ref} does not cover every required key point.`);
}

/** Parse exactly one JSON decision, retaining aliases for coordinator revision fencing. */
export function parseReasonDecision(source, { context, maxIntents = 8, maxResponseBytes = 32768 } = {}) {
  for (const [name, value] of Object.entries({ maxIntents, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  }
  const nodes = validateReasonContext(context);
  if (typeof source !== 'string' || !source.trim()) throw invalid('Reason must return one JSON object.');
  if (Buffer.byteLength(source, 'utf8') > maxResponseBytes) throw invalid(`Reason response exceeds ${maxResponseBytes} UTF-8 bytes.`);
  let value;
  try { value = JSON.parse(source); } catch (cause) { throw invalid('Reason must return one raw JSON object without commentary or code fences.', cause); }
  record(value, 'Decision');
  if (value.complete === true) {
    fields(value, ['complete', 'evidenceIds', 'summary'], 'Completion');
    if ([...nodes.values()].some(node => ['pending', 'running'].includes(node.intent?.status))) throw invalid('Pending or running intents must finish before completion.');
    const evidenceIds = [...new Set(refs(value.evidenceIds, 'evidenceIds', nodes, context).map(ref => nodes.get(ref).result || ref))];
    for (const ref of evidenceIds) completionEvidence(nodes.get(ref), nodes);
    return { complete: true, evidenceIds, summary: text(value.summary, 'summary') };
  }
  fields(value, ['complete', 'intents'], 'Decision');
  if (value.complete !== undefined && value.complete !== false) throw invalid('complete must be a boolean.');
  if (!Array.isArray(value.intents) || !value.intents.length || value.intents.length > maxIntents) throw invalid(`An unfinished decision requires 1 to ${maxIntents} intents.`);
  const seen = new Set([...nodes.values()].filter(node => node.intent).map(node => intentKey(node.intent, node.parents)));
  const intents = value.intents.map((item, index) => {
    const label = `intents[${index}]`;
    fields(item, ['description', 'parentIds', 'priority', 'keyPoints'], label);
    const description = text(item.description, `${label}.description`);
    const parentIds = [...new Set(refs(item.parentIds, `${label}.parentIds`, nodes, context).map(ref => nodes.get(ref).result || ref))];
    if (parentIds.some(ref => { const node = nodes.get(ref); return !node || node.kind === 'intent' && !node.fact; })) throw invalid('Exploration parents must be recorded facts or the root.');
    if (!['high', 'medium', 'low'].includes(item.priority)) throw invalid(`${label}.priority must be high, medium or low.`);
    if (!Array.isArray(item.keyPoints) || !item.keyPoints.length || item.keyPoints.length > 6) throw invalid(`${label}.keyPoints requires 1 to 6 auditable checkpoints.`);
    const keyPoints = item.keyPoints.map((point, number) => text(point, `${label}.keyPoints[${number}]`, 2048));
    if (new Set(keyPoints.map(normalize)).size !== keyPoints.length) throw invalid(`${label}.keyPoints contains duplicate coverage.`);
    const intent = { description, parentIds, priority: item.priority, keyPoints };
    const key = intentKey(intent, parentIds);
    if (seen.has(key)) throw invalid(`${label} repeats existing or newly proposed work; propose a materially different evidence gap, or have the host resume the existing intent.`);
    seen.add(key);
    return intent;
  });
  return { intents };
}
