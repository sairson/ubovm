import { learningRequestFingerprint } from './fingerprint.mjs';
import { classifyOutcome, prerequisiteFor } from './attribution.mjs';

const ungated = new Set(['learn_capability', 'note', 'todo', 'inspect_harness', 'load_skill', 'read_skills_resource']);
const blocking = new Set(['caller_error', 'tool_defect', 'env_prereq', 'env_timing']);

export function gateRecords(store, workerId) {
  if (typeof store?.learningGateRecords === 'function') return store.learningGateRecords(workerId);
  return (store?.snapshot?.().toolEvidence ?? []).filter(record => record.workerId === workerId);
}

/** Refuse a repeated identical call. A missing path may be retried once, in case it was created. */
export function evaluateLearningGate(records, { workerId, toolName, args, shared } = {}) {
  if (!workerId || !toolName || ungated.has(toolName)) return null;
  const fingerprint = learningRequestFingerprint({ toolName, args: args ?? {} });
  const mine = (records ?? []).filter(record => record?.workerId === workerId && record.learningRequestFingerprint === fingerprint && record.probe !== true && record.learningClass !== 'probe');
  let streak = 0;
  let attribution;
  for (let index = mine.length - 1; index >= 0; index--) {
    const kind = classifyOutcome(mine[index]);
    if (!blocking.has(kind)) break;
    streak++;
    attribution ??= kind;
  }
  if (!attribution) {
    const sharedHit = (shared ?? []).find(item => item.tool === toolName && item.fingerprint === fingerprint && item.class === 'tool_defect');
    if (!sharedHit) return null;
    attribution = 'tool_defect';
    streak = 1;
  }
  const limit = attribution === 'env_prereq' || attribution === 'env_timing' ? 2 : 1;
  if (streak < limit) return null;
  return {
    code: 'LEARNING_GATE', attribution,
    message: `LEARNING_GATE ${attribution}: ${prerequisiteFor({ toolName, isError: true }, attribution)} The identical call was not executed.`
  };
}
