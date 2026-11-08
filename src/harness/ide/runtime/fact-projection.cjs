'use strict';

// A blackboard fact body travels in every execution snapshot, so the host keeps
// each one bounded. Slicing a structured Worker envelope mid-JSON made the UI
// fall back to a wall of raw JSON; instead, rebuild a smaller but still valid
// envelope with the same display fields and explicit omission counts. The full
// body stays in the Blackboard database and can be paged from Worker logs.
const FACT_CONTENT_LIMIT = 12000;
const OUTCOMES = new Set(['confirmed', 'negative', 'partial', 'blocked']);
const STATUS_FALLBACK = 'unknown';

const clip = (value, maximum) => typeof value === 'string' && value.length > maximum
  ? value.slice(0, maximum).trimEnd() + '…'
  : value;

function stringList(values, maximum, itemCap) {
  if (!Array.isArray(values)) return [];
  return values.filter(value => typeof value === 'string' && value.trim())
    .map(value => clip(value.trim(), itemCap))
    .slice(0, maximum);
}

function coverageList(values, maximum) {
  if (!Array.isArray(values)) return [];
  return values.filter(item => item && typeof item === 'object' && typeof item.point === 'string' && typeof item.result === 'string')
    .map(item => {
      const status = typeof item.status === 'string' && item.status.trim() ? item.status.trim().slice(0, 40) : STATUS_FALLBACK;
      return { point: clip(item.point.trim(), 200), status, result: clip(item.result.trim(), 260) };
    })
    .slice(0, maximum);
}

function evidenceList(values, maximum) {
  if (!Array.isArray(values)) return [];
  return values.filter(item => item && typeof item === 'object' && typeof item.observation === 'string')
    .map(item => ({
      observation: clip(item.observation.trim(), 260),
      ...(typeof item.toolCallId === 'string' && item.toolCallId ? { toolCallId: item.toolCallId.slice(0, 128) } : {}),
      ...(typeof item.nodeRef === 'string' && item.nodeRef ? { nodeRef: item.nodeRef.slice(0, 128) } : {})
    }))
    .slice(0, maximum);
}

function isEnvelope(fact) {
  return fact && typeof fact === 'object' && !Array.isArray(fact) && fact.version === 1 &&
    typeof fact.statement === 'string' && fact.statement.trim();
}

/**
 * Bound one fact body for projection into the UI snapshot.
 * Short or non-structured bodies keep their original bytes; only an oversized
 * structured envelope is compacted into a smaller, still parseable envelope.
 * @returns {{ content: string, clipped: boolean }}
 */
function projectFactContent(content, limit = FACT_CONTENT_LIMIT) {
  if (typeof content !== 'string') return { content: '', clipped: false };
  if (content.length <= limit) return { content, clipped: false };
  let fact;
  try { fact = JSON.parse(content); } catch {
    // Plain or malformed bodies stay readable as truncated text, as before.
    return { content: content.slice(0, limit), clipped: true };
  }
  if (!isEnvelope(fact)) return { content: content.slice(0, limit), clipped: true };

  const allCoverage = coverageList(fact.coverage, 64);
  const allEvidence = evidenceList(fact.evidence, 64);
  const allFailed = stringList(fact.failedChecks, 32, 240);
  const allLimitations = stringList(fact.limitations, 32, 240);
  const allNext = stringList(fact.nextSteps, 32, 240);
  let statement = clip(fact.statement.trim(), 6000);
  let coverageCount = Math.min(allCoverage.length, 10);
  let evidenceCount = Math.min(allEvidence.length, 10);
  let failedCount = Math.min(allFailed.length, 5);
  let limitationsCount = Math.min(allLimitations.length, 5);
  let nextCount = Math.min(allNext.length, 5);

  const build = () => ({
    version: 1,
    ...(OUTCOMES.has(fact.outcome) ? { outcome: fact.outcome } : {}),
    statement,
    coverage: allCoverage.slice(0, coverageCount),
    evidence: allEvidence.slice(0, evidenceCount),
    failedChecks: allFailed.slice(0, failedCount),
    limitations: allLimitations.slice(0, limitationsCount),
    nextSteps: allNext.slice(0, nextCount),
    truncated: true,
    omitted: {
      coverage: Math.max(0, allCoverage.length - coverageCount),
      evidence: Math.max(0, allEvidence.length - evidenceCount),
      failedChecks: Math.max(0, allFailed.length - failedCount),
      limitations: Math.max(0, allLimitations.length - limitationsCount),
      nextSteps: Math.max(0, allNext.length - nextCount)
    }
  });

  let text = JSON.stringify(build());
  // Shrink lowest-value detail first; the conclusion keeps the most room.
  while (text.length > limit) {
    if (nextCount > 0) nextCount--;
    else if (limitationsCount > 0) limitationsCount--;
    else if (failedCount > 0) failedCount--;
    else if (evidenceCount > 0) evidenceCount--;
    else if (coverageCount > 0) coverageCount--;
    else if (statement.length > 160) statement = statement.slice(0, Math.floor(statement.length * .75)).replace(/…$/u, '') + '…';
    else break;
    text = JSON.stringify(build());
  }
  if (text.length > limit) {
    // Pathological envelope (e.g. one enormous single paragraph): keep the
    // conclusion only, still valid JSON so the UI can render it normally.
    text = JSON.stringify({
      version: 1,
      ...(OUTCOMES.has(fact.outcome) ? { outcome: fact.outcome } : {}),
      statement: clip(fact.statement.trim(), Math.max(2000, limit - 700)),
      coverage: [], evidence: [], failedChecks: [], limitations: [], nextSteps: [],
      truncated: true,
      omitted: {
        coverage: allCoverage.length, evidence: allEvidence.length, failedChecks: allFailed.length,
        limitations: allLimitations.length, nextSteps: allNext.length
      }
    });
  }
  return { content: text, clipped: true };
}

module.exports = { FACT_CONTENT_LIMIT, projectFactContent };
