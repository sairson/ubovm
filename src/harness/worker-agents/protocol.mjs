import { commentaryBudget, extractedJSONBytes, readJSONObject } from '../json-object.mjs';

const OUTCOMES = new Set(['confirmed', 'negative', 'partial', 'blocked']);
const MAX_ITEMS = 64;
const MAX_TEXT = 8192;

function invalid(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function record(value, label, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(code, `${label} must be a JSON object.`);
  }
  return value;
}

function fields(value, allowed, label, code) {
  record(value, label, code);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(code, `${label} contains unknown field ${JSON.stringify(unknown)}.`);
}

function required(value, label, code, { exact = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(code, `${label} must be a nonempty string.`);
  }
  if (value.length > MAX_TEXT) throw invalid(code, `${label} exceeds ${MAX_TEXT} characters.`);
  return exact ? value : value.trim();
}

function coverageKey(value) {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function uniqueContainmentMatch(raw, unused) {
  const fingerprint = coverageKey(raw);
  if (fingerprint.length < 8) return undefined;
  const matches = unused.filter((point) => {
    const key = coverageKey(point);
    const [shorter, longer] = fingerprint.length <= key.length ? [fingerprint, key] : [key, fingerprint];
    return longer.includes(shorter) && shorter.length * 5 >= longer.length * 2;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function bindCoveragePoint(raw, points, used, index, alignByIndex) {
  const unused = points.filter((point) => !used.has(point));
  const fingerprint = unused.find((point) => coverageKey(point) === coverageKey(raw));
  if (fingerprint) return fingerprint;
  const contained = uniqueContainmentMatch(raw, unused);
  if (contained) return contained;
  const positional = points[index];
  if (alignByIndex && positional && !used.has(positional)) return positional;
  return undefined;
}

function list(value, label, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(code, `${label} must be an array.`);
  if (value.length > MAX_ITEMS) throw invalid(code, `${label} cannot contain more than ${MAX_ITEMS} items.`);
  return value;
}

function positiveInteger(value, label, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(code, `${label} must be a positive integer.`);
}

function parseObject(text, code, maxBytes) {
  if (typeof text !== 'string' || !text.trim()) throw invalid(code, 'The model response must contain a JSON object.');
  const rawLimit = commentaryBudget(maxBytes);
  if (rawLimit !== undefined && Buffer.byteLength(text, 'utf8') > rawLimit) {
    throw invalid(code, `The model response exceeds ${rawLimit} UTF-8 bytes.`);
  }
  const decoded = readJSONObject(text);
  if (!decoded.value) throw invalid(code, 'The model response must be one valid JSON object, without surrounding commentary.');
  if (maxBytes !== undefined && extractedJSONBytes(decoded.value) > maxBytes) {
    throw invalid(code, `The model response exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return record(decoded.value, 'The model response', code);
}

/** Validate a bounded plan or the explicit replanning completion decision. */
export function parsePlan(text, { maxSteps = 8, replan = false } = {}) {
  const code = 'INVALID_PLAN';
  positiveInteger(maxSteps, 'maxSteps', code);
  if (typeof replan !== 'boolean') throw invalid(code, 'replan must be a boolean.');
  const value = parseObject(text, code, 65536);
  fields(value, replan ? ['done', 'steps'] : ['steps'], 'Plan', code);
  if (replan) {
    if (typeof value.done !== 'boolean') throw invalid(code, 'A replanning decision must contain a boolean done.');
    if (value.done) {
      if (Object.hasOwn(value, 'steps')) throw invalid(code, 'A completed replanning decision must not contain steps.');
      return { done: true, steps: [] };
    }
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw invalid(code, 'An unfinished plan requires a nonempty steps array.');
  }
  if (value.steps.length > maxSteps) throw invalid(code, `Plan contains ${value.steps.length} steps; the limit is ${maxSteps}.`);
  const seen = new Set();
  const steps = value.steps.map((step, index) => {
    const label = `steps[${index}]`;
    fields(step, ['description', 'doneWhen'], label, code);
    const description = required(step.description, `${label}.description`, code);
    const doneWhen = required(step.doneWhen, `${label}.doneWhen`, code);
    const key = description.replace(/\s+/gu, ' ').toLowerCase();
    if (seen.has(key)) throw invalid(code, `${label}.description duplicates another plan step.`);
    seen.add(key);
    return { description, doneWhen };
  });
  return { done: false, steps };
}

function outcome(value, label) {
  if (!OUTCOMES.has(value)) {
    throw invalid('INVALID_FACT', `${label} must be confirmed, negative, partial, or blocked.`);
  }
  return value;
}

function stringList(value, label) {
  return [...new Set(list(value, label, 'INVALID_FACT').flatMap((item, index) => {
    // Empty model-generated placeholders carry no information. Keep validating
    // non-string entries and text limits rather than silently dropping data.
    if (typeof item === 'string' && item.length <= MAX_TEXT && !item.trim()) return [];
    return [required(item, `${label}[${index}]`, 'INVALID_FACT')];
  }))];
}

function validateNodeRef(nodeRef, context, label) {
  const code = 'INVALID_FACT';
  const nodes = context?.data?.nodes;
  const node = Array.isArray(nodes) ? nodes.find((item) => item?.ref === nodeRef) : undefined;
  if (!node || nodeRef === context.data.root || node.kind === 'root' ||
      typeof node.fact !== 'string' || !node.fact.trim()) {
    throw invalid(code, `${label} must reference a non-root blackboard node with a recorded fact.`);
  }
  try {
    const resolved = context.resolveId(nodeRef);
    if (typeof resolved !== 'string' || !resolved) throw new Error('The reference did not resolve to a node ID.');
  } catch (cause) {
    throw invalid(code, `${label} cannot be resolved in the current blackboard context.`, cause);
  }
}

/** Host ledger success: completed, not marked failed, and result is not an explicit tool error. */
function isSuccessfulLedgerEntry(entry) {
  return entry?.status === 'completed' && entry.isError === false && entry.result?.isError !== true;
}

function successfulToolCallIds(ledger) {
  return ledger.filter(isSuccessfulLedgerEntry).map(entry => entry.toolCallId);
}

function evidenceSourceHint(ledger) {
  const valid = successfulToolCallIds(ledger);
  if (valid.length) return ` Successful ledger toolCallIds: ${valid.join(', ')}.`;
  return ' The ledger has no successful tool calls; use nodeRef evidence or a partial/blocked outcome.';
}

/** Validate facts against host-owned key points, completed tools, and the current blackboard. */
export function parseWorkerFact(text, { keyPoints = [], ledger = [], context, maxBytes = 24576 } = {}) {
  const code = 'INVALID_FACT';
  positiveInteger(maxBytes, 'maxBytes', code);
  const value = parseObject(text, code, maxBytes);
  fields(value, ['version', 'outcome', 'statement', 'coverage', 'evidence', 'failedChecks', 'limitations', 'nextSteps'], 'Fact', code);
  if (value.version !== undefined && value.version !== 1) throw invalid(code, 'Fact.version must be 1.');
  const status = outcome(value.outcome, 'Fact.outcome');
  const statement = required(value.statement, 'Fact.statement', code);
  if (!Array.isArray(keyPoints)) throw invalid(code, 'keyPoints must be an array.');
  const points = list(keyPoints, 'keyPoints', code).map((point, index) =>
    required(point, `keyPoints[${index}]`, code, { exact: true }));
  const allowedPoints = new Set(points);
  if (allowedPoints.size !== points.length) throw invalid(code, 'keyPoints cannot contain duplicates.');
  const reported = new Map();
  const droppedCoverage = [];
  const coverageItems = list(value.coverage, 'Fact.coverage', code);
  const alignByIndex = coverageItems.length === points.length;
  for (const [index, item] of coverageItems.entries()) {
    const label = `coverage[${index}]`;
    fields(item, ['point', 'status', 'result'], label, code);
    const raw = required(item.point, `${label}.point`, code);
    const point = bindCoveragePoint(raw, points, reported, index, alignByIndex);
    if (!point) {
      droppedCoverage.push(raw);
      continue;
    }
    if (reported.has(point)) {
      droppedCoverage.push(raw);
      continue;
    }
    reported.set(point, {
      point,
      status: outcome(item.status, `${label}.status`),
      result: required(item.result, `${label}.result`, code),
    });
  }
  const coverage = points.map((point) => reported.get(point) ?? {
    point,
    status: 'partial',
    result: 'No conclusive result was recorded.',
  });
  if (!Array.isArray(ledger)) throw invalid(code, 'ledger must be an array.');
  const evidence = [];
  const droppedToolIds = [];
  for (const [index, item] of list(value.evidence, 'Fact.evidence', code).entries()) {
    const label = `evidence[${index}]`;
    fields(item, ['toolCallId', 'nodeRef', 'observation'], label, code);
    const hasTool = Object.hasOwn(item, 'toolCallId');
    const hasNode = Object.hasOwn(item, 'nodeRef');
    if (hasTool === hasNode) throw invalid(code, `${label} requires exactly one source: toolCallId or nodeRef.`);
    const observation = required(item.observation, `${label}.observation`, code);
    if (hasTool) {
      const toolCallId = required(item.toolCallId, `${label}.toolCallId`, code);
      const entries = ledger.filter((entry) => entry?.toolCallId === toolCallId);
      // Keep valid citations; drop unknown/failed IDs so one bad item cannot
      // discard an otherwise grounded conclusion (models often mix both).
      if (entries.length !== 1 || !isSuccessfulLedgerEntry(entries[0])) {
        droppedToolIds.push(toolCallId);
        continue;
      }
      evidence.push({ toolCallId, observation });
      continue;
    }
    const nodeRef = required(item.nodeRef, `${label}.nodeRef`, code);
    validateNodeRef(nodeRef, context, `${label}.nodeRef`);
    evidence.push({ nodeRef, observation });
  }
  if (['confirmed', 'negative'].includes(status) && evidence.length === 0) {
    const detail = droppedToolIds.length
      ? ` Dropped invalid toolCallId citation(s): ${droppedToolIds.join(', ')}.${evidenceSourceHint(ledger)}`
      : '';
    throw invalid(code, `A confirmed or negative fact requires at least one valid evidence item.${detail}`);
  }
  const nextSteps = value.nextSteps === undefined ? undefined : stringList(value.nextSteps, 'Fact.nextSteps');
  const limitations = stringList(value.limitations, 'Fact.limitations');
  if (droppedToolIds.length) {
    limitations.push(`Dropped ${droppedToolIds.length} evidence citation(s) that were not successful host ledger tool calls.`);
  }
  if (droppedCoverage.length) {
    limitations.push(`Dropped ${droppedCoverage.length} coverage item(s) that did not match a required key point.`);
  }
  const fact = {
    version: 1,
    outcome: ['confirmed', 'negative'].includes(status) && (nextSteps?.length || coverage.some((item) => ['partial', 'blocked'].includes(item.status)))
      ? 'partial' : status,
    statement,
    coverage,
    evidence: [...new Map(evidence.map(item => [JSON.stringify(item), item])).values()],
    failedChecks: stringList(value.failedChecks, 'Fact.failedChecks'),
    limitations,
    ...(nextSteps === undefined ? {} : { nextSteps }),
  };
  if (Buffer.byteLength(JSON.stringify(fact), 'utf8') > maxBytes) {
    throw invalid(code, `The normalized fact exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return fact;
}
