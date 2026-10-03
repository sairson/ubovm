export const DELIVERY_STAGES = Object.freeze(['develop', 'audit', 'security', 'deploy', 'operate']);
const nonempty = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 4000;

// Validate durable state before publication and on recovery, not just tool inputs.
export function validateDeliveryRecord(record) {
  if (record === undefined) return;
  const fail = () => { throw new Error('Invalid delivery snapshot'); };
  if (!record || record.projectType !== 'new-development' || !nonempty(record.objective) || !nonempty(record.artifact)
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Array.isArray(record.history)
    || record.history.length !== record.revision || !Array.isArray(record.findings) || record.findings.length > 200
    || !record.acceptance || typeof record.acceptance !== 'object' || Array.isArray(record.acceptance)) fail();
  if (record.evidenceFloor !== undefined && (!Number.isSafeInteger(record.evidenceFloor) || record.evidenceFloor < 0)) fail();
  if (record.staleEvidence !== undefined && (!Array.isArray(record.staleEvidence) || record.staleEvidence.some(item => !nonempty(item)))) fail();
  const refs = items => {
    if (!Array.isArray(items) || !items.length || items.length > 20) fail();
    const seen = new Set();
    for (const item of items) {
      if (!item || !['workerId', 'toolCallId', 'toolName', 'digest'].every(key => nonempty(item[key]))) fail();
      const key = JSON.stringify([item.workerId, item.toolCallId]);
      if (seen.has(key)) fail();
      seen.add(key);
    }
  };
  let pending = false;
  for (const stage of DELIVERY_STAGES) {
    const item = record.acceptance[stage];
    if (!item) { pending = true; continue; }
    if (pending || !nonempty(item.summary) || !nonempty(item.artifact)) fail();
    refs(item.evidence);
    // Legacy records may lack handoff fields; they remain visible as needing
    // supplementary acceptance rather than becoming proof of delivery.
    for (const key of ['scope', 'endpoint', 'vantage', 'rollback', 'monitoring', 'owner']) {
      if (item[key] !== undefined && !nonempty(item[key])) fail();
    }
  }
  if (Object.keys(record.acceptance).some(stage => !DELIVERY_STAGES.includes(stage))) fail();
  if (record.blocked !== undefined) {
    if (!record.blocked || typeof record.blocked !== 'object' || Array.isArray(record.blocked)) fail();
    for (const [stage, blocker] of Object.entries(record.blocked)) {
      if (!DELIVERY_STAGES.includes(stage) || record.acceptance[stage] || !nonempty(blocker?.summary) || !nonempty(blocker?.owner)) fail();
    }
  }
  const findingIds = new Set();
  for (const item of record.findings) {
    if (!item || !nonempty(item.id) || !nonempty(item.summary) || findingIds.has(item.id)
      || !['critical', 'high', 'medium', 'low'].includes(item.severity) || !['open', 'resolved'].includes(item.status)) fail();
    findingIds.add(item.id); refs(item.evidence);
    if (item.assessment) {
      if (!nonempty(item.assessment.summary) || !nonempty(item.assessment.artifact)) fail();
      refs(item.assessment.evidence);
    } else if (item.status === 'resolved') fail();
  }
  if (record.acceptance.deploy && record.findings.some(item => item.status === 'open' && ['critical', 'high'].includes(item.severity))) fail();
  record.history.forEach((item, index) => {
    if (!item || item.revision !== index + 1 || !nonempty(item.workerId) || !nonempty(item.artifact)
      || !['initialize', 'accept', 'block', 'invalidate', 'finding', 'resolve', 'reopen'].includes(item.action)) fail();
  });
}

export function hasStageAcceptance(record, stage) {
  const item = record.acceptance[stage];
  if (!item) return false;
  if (stage === 'security') return nonempty(item.scope);
  if (stage === 'deploy') return nonempty(item.endpoint) && nonempty(item.vantage);
  if (stage === 'operate') return ['rollback', 'monitoring', 'owner'].every(key => nonempty(item[key]));
  return true;
}
