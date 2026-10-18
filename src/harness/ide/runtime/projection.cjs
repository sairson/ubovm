'use strict';
const MAX_ASSISTANT_MESSAGE_LENGTH = 64000;
const REDACTED = '[REDACTED]';
const STREAMING_TOOLS = new Set(['run_linux_ssh_command', 'run_local_skill_script', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service']);
const secretField = key => /^(?:token|auth|cookie|setcookie)$/i.test(key.replace(/[^a-z0-9]/gi, '')) || /api.?key|authorization|password|passwd|private.?key|secret|credential|access.?token|refresh.?token|session.?token/i.test(key);
function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g, REDACTED)
    .replace(/(https?:\/\/[^\s/:]+:)[^\s/@]+(@)/g, `$1${REDACTED}$2`)
    .replace(/\b(authorization|proxy-authorization)["']?\s*[:=]\s*(?:["']?)(?:Bearer|Basic)?\s*[^\r\n,;"'}]+/gi, `$1: ${REDACTED}`)
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|token)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, `$1=${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_~.=-]{8,}/gi, `$1 ${REDACTED}`);
}
function safeDisplay(value, depth = 0, seen = new Set()) {
  if (depth > 8) return '[Nested content omitted]';
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return safeDisplay(parsed, depth + 1, seen); } catch {}
    return redactText(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (seen.has(value)) return '[Circular content omitted]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 100).map(item => safeDisplay(item, depth + 1, seen));
    if (value.length > 100) result.push('[Additional items omitted]');
  } else {
    result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (['thinking', 'thoughtSignature', 'thinkingSignature'].includes(key)) continue;
      result[key.slice(0, 200)] = secretField(key) ? REDACTED : safeDisplay(item, depth + 1, seen);
    }
    if (Object.keys(value).length > 100) result['[truncated]'] = 'Additional fields omitted';
  }
  seen.delete(value); return result;
}
function clipped(value, maximum, marker = '\n[内容已截断]') { return value.length <= maximum ? value : value.slice(0, Math.max(0, maximum - marker.length)) + marker.slice(0, maximum); }
function formatToolValue(value, maximum = 12000, tail = false) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) value = value.content.flatMap(part => part?.type === 'text' ? [safeDisplay(part.text)] : part?.type === 'image' ? ['[Image result]'] : []).map(part => typeof part === 'string' ? part : JSON.stringify(part, null, 2)).join('\n');
  const safe = safeDisplay(value), text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
  // Live process logs must keep advancing after the display budget is reached.
  // Redact before trimming so a credential crossing the boundary stays hidden.
  let start = Math.max(0, text.length - maximum);
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  return { text: tail ? text.slice(start) : clipped(text, maximum), truncated: text.length > maximum };
}
function redactDisplayObject(value, depth = 0) {
  if (typeof value === 'string') return formatToolValue(value, 64000).text;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 10) return '[Nested content omitted]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactDisplayObject(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).filter(([key]) => !['thinking', 'thoughtSignature', 'thinkingSignature'].includes(key)).map(([key, item]) => [key, secretField(key) ? REDACTED : redactDisplayObject(item, depth + 1)]));
}
// Summary telemetry is host-authored, but it still crosses into persisted UI
// state, so only the known kinds/reasons and bounded counters survive.
const SUMMARY_KINDS = ['transcript', 'tool-result', 'tool-arguments', 'blackboard-fact'];
const SUMMARY_FALLBACK_REASONS = ['summary_output_limit', 'source_call_limit', 'timeout', 'summary_unavailable'];
function sanitizeSummaryKinds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of SUMMARY_KINDS) {
    const stat = value[key];
    if (!stat || typeof stat !== 'object' || Array.isArray(stat)) continue;
    out[key] = { summaries: Number.isSafeInteger(stat.summaries) && stat.summaries > 0 ? Math.min(stat.summaries, 1000) : 0,
      fallback: stat.fallback === true, truncated: stat.truncated === true };
  }
  return Object.keys(out).length ? out : undefined;
}
function sanitizeSummaryFallbackReasons(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of SUMMARY_FALLBACK_REASONS) if (Number.isSafeInteger(value[key]) && value[key] > 0) out[key] = Math.min(value[key], 1000);
  return Object.keys(out).length ? out : undefined;
}
/** Bounded, detached and credential-redacted UI projections only; never model context. */
function cleanTimelineParts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(); let parts = [];
  for (const part of value) {
    if (!part || typeof part.id !== 'string' || !part.id || part.id.length > 200 || seen.has(part.id)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const startedAt = Number.isFinite(part.startedAt) && part.startedAt >= 0 ? part.startedAt : undefined;
      parts.push({ id: part.id, type: 'text', text: clipped(redactText(part.text), MAX_ASSISTANT_MESSAGE_LENGTH), status: part.status === 'streaming' ? 'streaming' : 'completed',
        ...(part.source === 'reason' ? { source: 'reason' } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}) });
    } else if (['thinking', 'summary'].includes(part.type) && typeof part.text === 'string' && (part.text.trim() || part.type === 'summary') && part.redacted !== true && (part.type === 'summary' ? ['running', 'completed', 'interrupted', 'failed'] : ['running', 'completed', 'interrupted']).includes(part.status) && ['assistant', 'reason', 'worker'].includes(part.source)) {
      const text = redactText(part.text), startedAt = Number.isFinite(part.startedAt) && part.startedAt >= 0 ? part.startedAt : 0;
      const kinds = part.type === 'summary' ? sanitizeSummaryKinds(part.kinds) : undefined;
      const fallbackReasons = part.type === 'summary' ? sanitizeSummaryFallbackReasons(part.fallbackReasons) : undefined;
      // This whitelist persists only the provider's displayable plaintext.
      // Provider signatures and encrypted/redacted blocks never enter the UI.
      parts.push({ id: part.id, type: part.type, text: clipped(text, 12000), status: part.status, source: part.source, startedAt,
        ...(part.type === 'summary' ? { fallback: part.fallback === true,
          ...Object.fromEntries(['beforeTokens', 'afterTokens'].filter(key => Number.isSafeInteger(part[key]) && part[key] >= 0).map(key => [key, part[key]])),
          ...(kinds ? { kinds } : {}),
          ...(fallbackReasons ? { fallbackReasons } : {}) } : {}),
        ...(Number.isFinite(part.endedAt) && part.endedAt >= startedAt ? { endedAt: part.endedAt } : {}),
        ...(typeof part.workerId === 'string' && part.workerId ? { workerId: part.workerId.slice(0, 200) } : {}),
        ...(part.truncated || text.length > 12000 ? { truncated: true } : {}) });
    } else if (part.type === 'tool' && typeof part.name === 'string' && part.name && ['running', 'completed', 'failed', 'interrupted'].includes(part.status)) {
      const args = formatToolValue(part.args ?? '', 4000), output = formatToolValue(part.output ?? '', 12000, STREAMING_TOOLS.has(part.name));
      const startedAt = Number.isFinite(part.startedAt) && part.startedAt >= 0 ? part.startedAt : 0;
      parts.push({ id: part.id, type: 'tool', name: redactText(part.name).slice(0, 128), status: part.status, args: args.text, output: output.text, startedAt,
        ...(part.background === true ? { background: true } : {}),
        ...(part.status === 'running' && part.commandId && ['queued', 'starting', 'running', 'stopping'].includes(part.executionState) ? { executionState: part.executionState } : {}),
        ...(['run_local_shell_command', 'run_linux_ssh_command'].includes(part.name) && typeof part.commandId === 'string' && /^[a-f0-9-]{36}$/.test(part.commandId) ? { commandId: part.commandId, ...(part.interruptRequested === true ? { interruptRequested: true } : {}) } : {}),
        ...(Number.isFinite(part.endedAt) && part.endedAt >= startedAt ? { endedAt: part.endedAt } : {}),
        ...(typeof part.workerId === 'string' && part.workerId ? { workerId: part.workerId.slice(0, 200) } : {}),
        ...(STREAMING_TOOLS.has(part.name) && (part.outputTail || output.truncated) ? { outputTail: true } : {}),
        ...(part.truncated || args.truncated || output.truncated ? { truncated: true } : {}) });
    } else continue;
    seen.add(part.id);
  }
  return parts.filter(part => part.type !== 'thinking' || part.text.trim());
}


/** Goal Worker prose for the panel; withhold plan/replan JSON and surface conclude statements. */
function workerDisplayText(value) {
  if (typeof value !== 'string' || !value) return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
    if (typeof parsed.statement === 'string' && parsed.statement.trim()) return parsed.statement;
    if ('steps' in parsed || 'done' in parsed || 'outcome' in parsed || 'intents' in parsed || 'coverage' in parsed) return '';
    return value;
  } catch {
    // Incomplete protocol JSON mid-stream must not flash as a conclusion.
    return '';
  }
}

/** Human-readable Reason decision for the goal planning log; never the raw protocol JSON. */
function reasonConclusion(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return '';
  if (decision.complete === true) {
    const summary = typeof decision.summary === 'string' ? decision.summary.trim() : '';
    return summary ? `目标已完成。\n${summary}` : '目标已完成。';
  }
  if (decision.wait === true) return '等待进行中的任务返回结果后再规划。';
  if (!Array.isArray(decision.intents) || !decision.intents.length) return '';
  const lines = decision.intents.map((intent, index) => {
    const description = typeof intent?.description === 'string' ? intent.description.trim() : '';
    const priority = typeof intent?.priority === 'string' && intent.priority ? `（优先级：${intent.priority}）` : '';
    const points = Array.isArray(intent?.keyPoints)
      ? intent.keyPoints.filter(point => typeof point === 'string' && point.trim()).map(point => point.trim())
      : [];
    const checkpoints = points.length ? `\n  - ${points.join('\n  - ')}` : '';
    return `${index + 1}. ${description || '未命名任务'}${priority}${checkpoints}`;
  });
  return `派发 ${decision.intents.length} 项任务。\n${lines.join('\n')}`;
}

/** Finish host-cached progress when its runtime is gone, retaining partial output. */
function interruptExecution(state, error, now = Date.now()) {
  const active = status => ['queued', 'running', 'waiting'].includes(status);
  const parts = values => (values ?? []).map(part => {
    if (part.type === 'text' && part.status === 'streaming') return { ...part, status: 'completed' };
    if (active(part.status)) return { ...part, status: 'interrupted', endedAt: Math.max(part.startedAt ?? 0, now) };
    return part;
  });
  return { ...state, status: error ? 'failed' : 'interrupted', busy: false, canSteer: false, phase: null, error: error ?? null,
    parts: parts(state.parts),
    activities: (state.activities ?? []).map(item => active(item.status) ? { ...item, status: 'interrupted' } : item),
    workers: (state.workers ?? []).map(worker => ({ ...worker,
      ...(active(worker.status) ? { status: 'interrupted', phase: null, finishedAt: Math.max(worker.startedAt ?? 0, now) } : {}),
      parts: parts(worker.parts)
    })) };
}

/** Bounded nonnegative model usage for UI/history; never provider billing secrets. */
function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (!Number.isFinite(value[key]) || value[key] < 0) continue;
    usage[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value[key]));
  }
  if (!Object.keys(usage).length) return undefined;
  if (value.cost && typeof value.cost === 'object' && !Array.isArray(value.cost)) {
    const cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (Number.isFinite(value.cost[key]) && value.cost[key] >= 0) cost[key] = value.cost[key];
    }
    if (Object.keys(cost).length) usage.cost = cost;
  }
  return usage;
}

/** Stable fingerprint for value equality without object-identity churn. */
function usageSignature(value) {
  const usage = sanitizeUsage(value);
  if (!usage) return '';
  const tokens = [usage.input || 0, usage.output || 0, usage.cacheRead || 0, usage.cacheWrite || 0, usage.totalTokens || 0];
  const cost = usage.cost?.total || 0;
  // An all-zero report carries nothing to show; keep it out of the UI.
  if (!tokens.some(Boolean) && !cost) return '';
  return [...tokens, cost].join('|');
}

function accumulateUsage(current, next) {
  const addition = sanitizeUsage(next);
  if (!addition) return current;
  const base = current ? { ...current, ...(current.cost ? { cost: { ...current.cost } } : {}) } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (addition[key] !== undefined) base[key] = (base[key] || 0) + addition[key];
  }
  if (addition.cost) {
    base.cost ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (addition.cost[key] !== undefined) base.cost[key] = (base.cost[key] || 0) + addition.cost[key];
    }
  }
  return base;
}

module.exports = { cleanTimelineParts, formatToolValue, redactDisplayObject, interruptExecution, workerDisplayText, reasonConclusion, sanitizeUsage, usageSignature, accumulateUsage, STREAMING_TOOLS };
