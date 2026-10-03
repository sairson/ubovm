import { Type } from 'typebox';
import { assertSession, checkAbort, required, toolResult } from '../shared/store/memory-store.mjs';
import { withActionHelp, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { DELIVERY_CATALOG } from '../shared/tool-catalogs.mjs';

import { DELIVERY_STAGES, hasStageAcceptance } from './record.mjs';
import { assertCoverageComplete, coverageSummary, emptyInventory } from '../domain-inventory/record.mjs';
export { DELIVERY_STAGES } from './record.mjs';
const bounded = (value, name) => {
  const result = required(value, name);
  if (result.length > 4000) throw new Error(`${name} exceeds 4000 characters`);
  return result;
};
function stageIndex(stage) {
  const index = DELIVERY_STAGES.indexOf(stage);
  if (index < 0) throw new Error('Unknown delivery stage');
  return index;
}
function projection(record, inventory) {
  if (!record) return { initialized: false, stages: DELIVERY_STAGES };
  const openFindings = record.findings.filter(item => item.status === 'open');
  const blockers = openFindings.filter(item => ['critical', 'high'].includes(item.severity));
  const nextStage = DELIVERY_STAGES.find(stage => !hasStageAcceptance(record, stage));
  const { history, historyCount, staleEvidence, evidenceFloor, ...current } = record;
  const domainCoverage = coverageSummary(inventory ?? emptyInventory());
  return { ...structuredClone(current), stages: DELIVERY_STAGES.map(stage => ({ stage,
    status: hasStageAcceptance(record, stage) ? 'accepted' : record.blocked?.[stage] ? 'blocked' : 'pending' })),
    historyCount: historyCount ?? history.length, recentActivity: structuredClone(history.slice(-8)), initialized: true, nextStage: nextStage ?? null,
    releaseReady: !blockers.length && DELIVERY_STAGES.slice(0, 3).every(stage => hasStageAcceptance(record, stage)),
    complete: !nextStage && !blockers.length, blockers, residualRisks: openFindings,
    domainCoverage: {
      seedRoots: domainCoverage.seedRoots,
      total: domainCoverage.total,
      counts: domainCoverage.counts,
      incomplete: domainCoverage.incomplete.slice(0, 40),
      coverageRate: domainCoverage.coverageRate,
      complete: domainCoverage.complete
    } };
}
function evidence(state, refs, record) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 20) throw new Error('Provide 1 to 20 evidence references');
  const seen = new Set();
  return refs.map(ref => {
    if (!ref || Object.keys(ref).some(key => !['workerId', 'toolCallId'].includes(key))) throw new Error('Invalid evidence reference');
    const workerId = required(ref.workerId, 'workerId'), toolCallId = required(ref.toolCallId, 'toolCallId');
    const key = JSON.stringify([workerId, toolCallId]);
    if (seen.has(key)) throw new Error('Duplicate evidence reference');
    seen.add(key);
    const index = state.toolEvidence?.findIndex(item => item.workerId === workerId && item.toolCallId === toolCallId) ?? -1;
    const entry = state.toolEvidence?.[index];
    if (!entry || entry.status !== 'completed' || entry.isError || !entry.digest ||
      ['delivery_workflow', 'todo', 'note', 'domain_inventory', 'spawn_worker', 'wait_workers', 'list_workers'].includes(entry.toolName)) throw new Error('Evidence must reference an actual successful execution, not progress metadata');
    if (index < (record.evidenceFloor ?? 0) || record.staleEvidence?.includes(entry.digest)) throw new Error('Evidence predates artifact invalidation; rerun the check');
    return { workerId, toolCallId, toolName: entry.toolName, digest: entry.digest };
  });
}

function acceptanceDetails(stage, input, inventory) {
  const details = {};
  if (stage === 'security') {
    const coverage = assertCoverageComplete(inventory);
    const provided = typeof input.scope === 'string' ? input.scope.trim() : '';
    details.scope = bounded(provided || coverage.scopeSummary, 'authorized security scope');
    details.domainCoverage = {
      seedRoots: coverage.seedRoots,
      total: coverage.total,
      counts: coverage.counts,
      coverageRate: coverage.coverageRate,
      complete: true
    };
  }
  if (stage === 'deploy') {
    details.endpoint = bounded(input.endpoint, 'deployed endpoint');
    let endpoint;
    try { endpoint = new URL(details.endpoint); } catch { throw new Error('Deployed endpoint must be an absolute protocol URL'); }
    if (!endpoint.hostname || endpoint.username || endpoint.password || ['javascript:', 'data:', 'file:'].includes(endpoint.protocol)) throw new Error('Endpoint must identify a network service without embedded credentials');
    details.vantage = bounded(input.vantage, 'verification client/network vantage');
  }
  if (stage === 'operate') {
    details.rollback = bounded(input.rollback, 'rollback procedure');
    details.monitoring = bounded(input.monitoring, 'monitoring and health checks');
    details.owner = bounded(input.owner, 'operations owner');
  }
  return details;
}

export function createDeliveryTool({ store, sessionId, workerId = 'worker' } = {}) {
  assertSession(store, sessionId);
  const tool = {
    name: 'delivery_workflow', label: '交付闭环',
    description: DELIVERY_CATALOG.description,
    parameters: Type.Object(withActionHelp({
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      projectType: Type.Optional(Type.Literal('new-development')),
      objective: Type.Optional(Type.String()), artifact: Type.Optional(Type.String()), stage: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()), findingId: Type.Optional(Type.String()),
      severity: Type.Optional(Type.Union(['critical', 'high', 'medium', 'low'].map(Type.Literal))),
      scope: Type.Optional(Type.String()), endpoint: Type.Optional(Type.String()), vantage: Type.Optional(Type.String()),
      rollback: Type.Optional(Type.String()), monitoring: Type.Optional(Type.String()), owner: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      evidence: Type.Optional(Type.Array(Type.Object({ workerId: Type.String(), toolCallId: Type.String() }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }))
    }), { additionalProperties: false }),
    async execute(_id, input, signal) {
      checkAbort(signal);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'expectedRevision', 'projectType', 'objective', 'artifact', 'stage', 'summary', 'findingId', 'severity', 'evidence', 'scope', 'endpoint', 'vantage', 'rollback', 'monitoring', 'owner', 'offset', 'limit'].includes(key))) throw new Error('Invalid delivery arguments');
      if (['status', 'history'].includes(input.action)) {
        await store.flush(); checkAbort(signal);
        if (input.action === 'status') return toolResult(projection(store.deliverySnapshot(), store.snapshot(['domainInventory']).domainInventory));
        return toolResult(store.deliveryHistory(input));
      }
      const result = await store.commit(state => {
        checkAbort(signal);
        let record = state.delivery;
        if (input.expectedRevision !== (record?.revision ?? 0)) {
          return {
            status: 'revision_conflict',
            expectedRevision: record?.revision ?? 0,
            providedRevision: input.expectedRevision,
            message: 'Delivery revision conflict; call status and retry with expectedRevision from that response.',
            ...projection(record, state.domainInventory)
          };
        }
        if (input.action === 'initialize') {
          if (input.projectType !== 'new-development') throw new Error('Full delivery workflow is only for new development projects; use standalone tools for existing projects');
          if (record) throw new Error('Delivery already initialized; invalidate to revise artifact');
          record = state.delivery = { revision: 0, projectType: 'new-development', objective: bounded(input.objective, 'objective'), artifact: bounded(input.artifact, 'artifact'), acceptance: {}, blocked: {}, findings: [], history: [], evidenceFloor: 0 };
        } else {
          if (!record) throw new Error('Initialize delivery first');
          if (input.action === 'accept') {
            const index = stageIndex(input.stage);
            if (record.acceptance[input.stage]) throw new Error('Stage already accepted; invalidate before revising acceptance');
            if (DELIVERY_STAGES.slice(0, index).some(stage => !hasStageAcceptance(record, stage))) throw new Error('Preceding delivery stages are incomplete');
            if (index >= 3 && record.findings.some(item => item.status === 'open' && ['critical', 'high'].includes(item.severity))) throw new Error('Open high/critical findings block release');
            record.acceptance[input.stage] = { artifact: record.artifact, summary: bounded(input.summary, 'summary'), evidence: evidence(state, input.evidence, record), ...acceptanceDetails(input.stage, input, state.domainInventory) };
            if (record.blocked) delete record.blocked[input.stage];
          } else if (input.action === 'block') {
            stageIndex(input.stage);
            if (record.acceptance[input.stage]) throw new Error('Invalidate accepted stage before marking it blocked');
            (record.blocked ??= {})[input.stage] = { summary: bounded(input.summary, 'blocker summary'), owner: input.owner ? bounded(input.owner, 'owner') : workerId };
          } else if (input.action === 'invalidate') {
            const index = stageIndex(input.stage);
            record.artifact = bounded(input.artifact, 'artifact');
            bounded(input.summary, 'summary');
            for (const stage of DELIVERY_STAGES.slice(index)) {
              delete record.acceptance[stage];
              if (record.blocked) delete record.blocked[stage];
            }
            record.evidenceFloor = state.toolEvidence?.length ?? 0;
            delete record.staleEvidence;
          } else if (['finding', 'resolve', 'reopen'].includes(input.action)) {
            const id = bounded(input.findingId, 'findingId');
            const summary = bounded(input.summary, 'summary');
            const refs = evidence(state, input.evidence, record);
            let finding = record.findings.find(item => item.id === id);
            if (input.action === 'finding') {
              if (finding) throw new Error('Finding already exists');
              if (!['critical', 'high', 'medium', 'low'].includes(input.severity)) throw new Error('Invalid finding severity');
              if (record.findings.length >= 200) throw new Error('Finding capacity reached');
              finding = { id, severity: input.severity, summary, evidence: refs, status: 'open' };
              record.findings.push(finding);
            } else {
              if (!finding) throw new Error('Finding not found');
              if (input.action === 'resolve' && refs.some(ref => finding.evidence.some(old => old.digest === ref.digest))) throw new Error('Resolution requires new retest evidence, not the original finding evidence');
              finding.status = input.action === 'resolve' ? 'resolved' : 'open';
              finding.assessment = { summary, evidence: refs, artifact: record.artifact };
            }
            for (const stage of DELIVERY_STAGES.slice(1)) delete record.acceptance[stage];
          } else throw new Error('Unknown delivery action');
        }
        record.revision++;
        record.history.push({ revision: record.revision, action: input.action, workerId, artifact: record.artifact, stage: input.stage ?? null, findingId: input.findingId ?? null, summary: input.summary ?? null, evidence: structuredClone(input.evidence ?? []),
          acceptance: input.action === 'accept' ? structuredClone(record.acceptance[input.stage]) : null, at: new Date().toISOString() });
        return projection(record, state.domainInventory);
      });
      return toolResult(result);
    },
    summary() {
      const record = store.deliverySnapshot();
      if (!record) return '';
      const inventory = store.snapshot(['domainInventory']).domainInventory;
      const current = projection(record, inventory);
      const compact = { revision: record.revision, objective: record.objective.slice(0, 1000), artifact: record.artifact.slice(0, 400),
        nextStage: current.nextStage, complete: current.complete, releaseReady: current.releaseReady, stages: current.stages,
        blocked: Object.fromEntries(Object.entries(record.blocked ?? {}).map(([stage, item]) => [stage, { summary: item.summary.slice(0, 500), owner: item.owner.slice(0, 200) }])),
        openFindings: current.residualRisks.length, blockingFindings: current.blockers.length,
        findingRefs: current.residualRisks.slice(0, 20).map(item => ({ id: item.id.slice(0, 200), severity: item.severity })),
        domainCoverage: current.domainCoverage };
      return '# New development project delivery ledger\nOnly applies to this new project, never standalone tasks. Agent assessments, not independent certification. Compact index: use delivery_workflow status/history to read full scope, findings and evidence before acceptance or completion. Security acceptance requires complete domain_inventory coverage.\n' + JSON.stringify(compact);
    }
  };
  const disclosed = withProgressiveDisclosure(tool, DELIVERY_CATALOG);
  disclosed.summary = tool.summary.bind(tool);
  disclosed.promptSummary = tool.summary.bind(tool);
  return disclosed;
}
