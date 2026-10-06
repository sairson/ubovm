/** Classify a tool outcome from structured details, then from an error string. A clean success has no class. */
const CALLER = /additional propert|unexpected propert|unknown (?:field|propert)|must NOT have additional|regex parse|invalid regex|unrecognized type|required property/i;
const DEFECT = /sandbox-runtime|engine missing|internal error|\bEPIPE\b|tool defect|unhandled exception/i;
const ENV = /ENOENT|ENOTDIR|no such file|not found|不存在|file missing|missing (?:path|file|director)|directory (?:does not exist|not found)|working directory|\bcwd\b/i;
const GATE = /LEARNING_GATE (caller_error|env_prereq|env_timing|tool_defect)/u;

function outcomeDetails(entry) {
  const direct = entry?.result?.details;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const text = String(entry?.observations ?? '');
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function outcomeText(entry, details) {
  if (details && (details.guidance || details.message || details.error)) return String(details.guidance ?? details.message ?? details.error ?? '');
  const content = entry?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
    if (text) return text;
  }
  return String(entry?.observations ?? '');
}

export function classifyOutcome(entry) {
  if (entry?.probe === true || entry?.learningClass === 'probe') return 'probe';
  if (['caller_error', 'env_prereq', 'env_timing', 'tool_defect', 'unknown'].includes(entry?.learningClass)) return entry.learningClass;
  const details = outcomeDetails(entry);
  const text = outcomeText(entry, details);
  const marked = GATE.exec(text);
  if (marked) return marked[1];
  if (details?.exists === false || details?.reason === 'missing' || details?.reason === 'not_directory') return 'env_prereq';
  if (details?.cannotSearch === true) return 'caller_error';
  if (details?.code === 'WRITE_OWNERSHIP') return 'caller_error';
  if (CALLER.test(text)) return 'caller_error';
  if (!entry?.isError && !details) return undefined;
  if (DEFECT.test(text)) return 'tool_defect';
  if (/not yet created|before (?:it|the path) existed/i.test(text)) return 'env_timing';
  if (ENV.test(text)) return 'env_prereq';
  return entry?.isError ? 'unknown' : undefined;
}

export function attributeFailure(record) {
  return classifyOutcome(record) || 'unknown';
}

/** Actionable next check. Caller errors must not tell the agent to distrust the tool. */
export function prerequisiteFor(record, attribution = attributeFailure(record)) {
  const tool = record?.toolName || 'the tool';
  if (attribution === 'caller_error') return `Fix the ${tool} arguments against its current schema. This is a caller error, not a tool defect.`;
  if (attribution === 'env_prereq' || attribution === 'env_timing') {
    if (/list_workspace/i.test(tool)) return 'Prior missing resource: confirm the directory exists, then list it. A missing path is a prerequisite, not a tool defect.';
    if (/search_workspace/i.test(tool)) return 'Prior missing resource: search an existing path with a valid pattern. An illegal query or missing path is not a tool defect.';
    if (/run_python/i.test(tool)) return 'Prior wrong cwd: use the workspace directory or an absolute path. A relative path from the wrong directory is a prerequisite, not a tool defect.';
    return 'Prior missing resource: confirm the path exists, then retry. A missing path is a prerequisite, not a tool defect.';
  }
  if (attribution === 'tool_defect') return `The ${tool} failure is inside the tool. Change method before repeating the same call.`;
  return `The ${tool} failure is unclassified. Do not treat the tool as defective without a tool_defect attribution.`;
}

const behaviorClaim = /\b(?:ENOENT|ENOTDIR|exists\s*[:=]\s*false|isError|throws|hard error|已证实)\b/i;

/** A tool-behavior claim must quote raw evidence. Otherwise it stays inferred. */
export function citesRawOutput(lesson, records) {
  const claim = `${lesson?.title ?? ''} ${lesson?.trigger ?? ''} ${(lesson?.steps ?? []).join(' ')}`;
  if (!behaviorClaim.test(claim)) return true;
  return records.some(record => {
    const observation = String(record?.observations ?? '').trim();
    if (observation.length < 12) return false;
    const size = Math.min(48, observation.length);
    for (let index = 0; index + size <= observation.length; index += 8) {
      if (claim.includes(observation.slice(index, index + size))) return true;
    }
    return claim.includes(observation.slice(0, size));
  });
}

/** Consecutive caller-error bursts are probes and stay out of capability statistics. */
export function probeKeys(records) {
  const keys = new Set();
  const key = record => `${record.workerId}\0${record.toolCallId}`;
  const byWorker = new Map();
  for (const record of records) {
    if (record?.probe === true) keys.add(key(record));
    const list = byWorker.get(record.workerId) ?? [];
    list.push(record);
    byWorker.set(record.workerId, list);
  }
  for (const list of byWorker.values()) {
    let run = [];
    const flush = () => {
      const tools = new Set(run.map(item => item.toolName));
      if (run.length >= 3 && tools.size >= 2 && run.every(item => item.probe === true || attributeFailure(item) === 'caller_error')) {
        for (const item of run) keys.add(key(item));
      }
      run = [];
    };
    for (const record of list) {
      if (record.isError && (record.probe === true || attributeFailure(record) === 'caller_error')) run.push(record);
      else flush();
    }
    flush();
  }
  return keys;
}
