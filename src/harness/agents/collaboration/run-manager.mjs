import { Type } from 'typebox';

/** Per-turn limits shared by the coordinator and every descendant. */
export function createRunManager({ limits = {}, signal, now, monotonicNow } = {}) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('runLimits must be an object');
  const configured = {};
  for (const key of Object.keys(limits)) if (!['maxModelCalls', 'maxToolCalls', 'maxDurationMs'].includes(key)) throw new TypeError(`Unknown run limit: ${key}`);
  for (const key of ['maxModelCalls', 'maxToolCalls', 'maxDurationMs']) {
    const value = limits[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || key === 'maxDurationMs' && value > 2147483647) throw new TypeError(`Invalid run limit: ${key}`);
    configured[key] = value;
  }
  const wallClock = now ?? Date.now;
  // Preserve the injectable test clock while using monotonic time in production.
  const elapsedClock = monotonicNow ?? now ?? (() => performance.now());
  if (typeof wallClock !== 'function' || typeof elapsedClock !== 'function') throw new TypeError('Invalid run clock');
  const startedAt = wallClock(), elapsedStart = elapsedClock();
  if (!Number.isFinite(startedAt) || !Number.isFinite(elapsedStart)) throw new TypeError('Invalid run clock value');
  const controller = new AbortController(), workers = new Map();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let modelCalls = 0, toolCalls = 0, timer, closed = false, finishedElapsed;
  const elapsed = () => finishedElapsed ?? Math.max(0, elapsedClock() - elapsedStart);
  const stop = (code, message) => {
    const error = Object.assign(new Error(message), { code });
    controller.abort(error);
    return error;
  };
  const timeout = () => stop('HARNESS_TIME_LIMIT', 'Harness 总运行时限已到，正在取消任务并保留执行记录。');
  if (configured.maxDurationMs) {
    timer = setTimeout(timeout, configured.maxDurationMs);
    timer.unref?.();
  }
  function reserve(kind, workerId) {
    combined.throwIfAborted();
    if (closed) throw new Error('Harness run manager is closed');
    if (configured.maxDurationMs && elapsed() >= configured.maxDurationMs) throw timeout();
    const used = kind === 'model' ? modelCalls : toolCalls;
    const maximum = configured[kind === 'model' ? 'maxModelCalls' : 'maxToolCalls'];
    if (maximum && used >= maximum) throw stop('HARNESS_CALL_LIMIT', `Harness 全局 ${kind} 调用预算已耗尽，执行记录已保留。`);
    const counts = workers.get(workerId) ?? { modelCalls: 0, toolCalls: 0 };
    if (kind === 'model') { modelCalls++; counts.modelCalls++; }
    else { toolCalls++; counts.toolCalls++; }
    workers.set(workerId, counts);
  }
  const snapshot = () => ({ startedAt, elapsedMs: elapsed(),
    status: combined.aborted ? 'interrupted' : closed ? 'closed' : 'running',
    limits: { ...configured }, modelCalls, toolCalls,
    workers: [...workers].map(([workerId, counts]) => ({ workerId, ...counts })) });
  return {
    signal: combined, beforeModel: id => reserve('model', id), beforeTool: id => reserve('tool', id), snapshot,
    tool: { name: 'inspect_harness', label: 'Inspect Harness runtime',
      description: 'Read elapsed runtime, shared model/tool call counts, per-worker counts and global limits (0 means unlimited). Counts include attempted calls, not proof of successful effects. Auxiliary summary model calls are governed separately by context-summary limits.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _input, callSignal) => { callSignal?.throwIfAborted(); const value = snapshot(); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } },
    close() { if (closed) return; finishedElapsed = elapsed(); closed = true; clearTimeout(timer); }
  };
}
