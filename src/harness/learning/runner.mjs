import { abortable } from './cancellation.mjs';
import { enqueueLearningWork, jobEvidence, learningQueue, recoverLearningJobs } from './queue.mjs';
import { LearningValidationError, validateReflectionCandidates } from './validation.mjs';
import { classifyOutcome, prerequisiteFor } from './attribution.mjs';

const recipes = [
  [/timeout|timed out|超时/iu, 'Prior timeout: reduce request scope or check readiness before retrying.'],
  [/ENOENT|not found|不存在|file missing|exists\s*[:=]\s*false/iu, 'Prior missing resource: confirm the path exists, then retry. A missing path is a prerequisite, not a tool defect.'],
  [/permission|denied|forbidden|权限/iu, 'Prior access failure: verify authorized access and prerequisites before retrying.'],
  [/invalid|syntax|schema|参数/iu, 'Prior invalid input: recheck the current tool schema and input format.']
];

/** Durable, single-session scheduler. The host must hold the session's storage lease. */
export function createBackgroundLearning({ knowledge, store, reflect, reflection = Boolean(reflect), onEvent,
  maxPending = 32, maxReflections = 2, reflectionTimeoutMs = 15000,
  reflectionIntervalMs = 30000, maxAttempts = 3, retryBaseMs = 1000 } = {}) {
  for (const [name, value] of Object.entries({ maxPending, maxReflections, reflectionTimeoutMs, reflectionIntervalMs, maxAttempts, retryBaseMs })) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxReflections' ? 0 : 1) || value > 60000) throw new RangeError(`Invalid ${name}`);
  }
  if (reflect !== undefined && typeof reflect !== 'function') throw new TypeError('reflect must be a function');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  const controller = new AbortController();
  let running, timer, closing = false, closingPromise, requested = false;
  let processed = 0, failures = 0, reflections = 0, budgetUsed = 0, storageRetryAt = 0, budgetResetAt = Date.now() + reflectionIntervalMs;
  const report = (type, detail = {}) => {
    try { Promise.resolve(onEvent?.({ type: `knowledge.${type}`, ...detail })).catch(() => {}); } catch {}
  };
  const jobs = () => store.learningJobs();
  const mutate = (id, change) => store.commit(state => {
    const job = learningQueue(state).jobs.find(item => item.id === id);
    if (!job) throw new Error('Learning job disappeared');
    return change(job, state);
  });
  async function base(job, records) {
    const record = records.at(-1), tool = knowledge.tool(job.workerId);
    const learningClass = classifyOutcome(record);
    if (learningClass === 'caller_error' || learningClass === 'probe' || learningClass === 'unknown') return;
    if ((learningClass === 'env_prereq' || learningClass === 'env_timing') && !record.isError) return;
    const title = `Tool practice: ${record.toolName}`;
    const fields = ((record.learningInputKeys ?? []).filter(name => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u.test(name)).slice(0, 24).sort().join(', ') || '(none)').slice(0, 350);
    const trigger = `Use ${record.toolName} with input fields ${fields}`;
    const priorFailures = records.filter(item => item.toolName === record.toolName && item.isError);
    const methods = knowledge.methods?.({ title, trigger }) ?? knowledge.inspect({ query: record.toolName, limit: 32 }).lessons
      .filter(item => item.title === title && item.trigger === trigger);
    const shared = methods.filter(item => item.scope === 'library');
    // Preserve only known host remedies, never arbitrary learned instructions.
    // Once an observation leaves the eight-record window, it must not undo a
    // previously learned prerequisite and start crediting the failed baseline.
    const remedies = recipes.filter(([pattern, remedy]) => priorFailures.some(item => pattern.test(item.observations ?? '')) ||
      methods.some(item => item.steps.includes(remedy))).map(([, remedy]) => remedy);
    if (!record.isError) {
      const result = await tool.execute('background', { action: 'learn', title, trigger, tool_call_ids: [record.toolCallId],
        ...(priorFailures.length ? { failure_call_ids: priorFailures.map(item => item.toolCallId) } : {}), steps: [
        `Check the current ${record.toolName} schema and task prerequisites.`,
        `Provide the input fields observed in prior execution: ${fields}; consult the current schema for requirements.`, ...remedies,
        'Validate the returned result against the task; successful execution alone is not proof of task completion.'
      ] });
      for (const lesson of shared.filter(item => JSON.stringify(item.steps) === JSON.stringify(result.details.steps))) {
        await tool.execute('background', { action: 'feedback', id: lesson.id,
          outcome: 'success', tool_call_ids: [record.toolCallId] });
      }
      if (knowledge.libraryAvailable ?? knowledge.inspect().libraryAvailable) await tool.execute('background', { action: 'publish', id: result.details.id });
    } else if (learningClass === 'tool_defect' || record.isError) {
      const latest = shared.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latest) await tool.execute('background', { action: 'feedback', id: latest.id,
        outcome: 'failure', tool_call_ids: [record.toolCallId] });
    }
  }
  async function reflectionJob(job, records) {
    const tool = knowledge.tool(job.workerId);
    let candidates = job.candidates;
    if (candidates === undefined) {
      reflections++; budgetUsed++; report('reflection_start');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(reflectionTimeoutMs)]);
      const previousLessons = knowledge.inspect({ query: [...new Set(records.map(record => record.toolName))].join(' ').slice(0, 4096) }).lessons;
      candidates = await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return reflect({ records: structuredClone(records), previousLessons: structuredClone(previousLessons), signal }); }), signal);
      signal.throwIfAborted();
      validateReflectionCandidates(candidates, records);
      // Save the model result before applying it. A crash cannot require paying for the same result twice.
      await mutate(job.id, item => { signal.throwIfAborted(); item.candidates = structuredClone(candidates); });
    }
    // Checkpointed output is subject to exactly the same evidence boundary.
    validateReflectionCandidates(candidates, records);
    for (const candidate of candidates) {
      controller.signal.throwIfAborted();
      const result = await tool.execute('background', { ...candidate, action: 'learn' }, controller.signal);
      if (candidate.portable === true && (knowledge.libraryAvailable ?? knowledge.inspect().libraryAvailable)) await tool.execute('background', { action: 'publish', id: result.details.id }, controller.signal);
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (closing) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const job of jobs()) {
      if (job.status !== 'pending' || !(job.kind === 'base' || job.hasCandidates || reflect && maxReflections > 0)) continue;
      earliest = Math.min(earliest, Math.max(storageRetryAt, job.nextAttemptAt,
        job.kind === 'reflection' && !job.hasCandidates && budgetUsed >= maxReflections ? budgetResetAt : now));
    }
    if (!Number.isFinite(earliest)) return;
    timer = setTimeout(wake, Math.max(1, earliest - now)); timer.unref?.();
  }
  async function run() {
    do {
      requested = false;
      if (Date.now() < storageRetryAt) return;
      if (Date.now() >= budgetResetAt) { budgetUsed = 0; budgetResetAt = Date.now() + reflectionIntervalMs; }
      // maxPending bounds each in-memory batch, never the durable backlog.
      const baseReady = [], reflectionReady = [], now = Date.now();
      for (const job of jobs()) {
        if (job.status !== 'pending' || job.nextAttemptAt > now) continue;
        if (job.kind === 'base') {
          baseReady.push(job);
          if (baseReady.length === maxPending) break;
        } else if (reflectionReady.length < maxPending && (job.hasCandidates || reflect && maxReflections > 0 && budgetUsed < maxReflections)) reflectionReady.push(job);
      }
      const ready = baseReady.concat(reflectionReady.slice(0, maxPending - baseReady.length));
      for (const selected of ready) {
        if (closing) break;
        if (selected.kind === 'reflection' && !selected.hasCandidates && budgetUsed >= maxReflections) continue;
        let job;
        try {
          job = await mutate(selected.id, item => { item.status = 'running'; item.attempts++; return item; });
          const records = jobEvidence(store, job);
          if (job.kind === 'base') await base(job, records); else await reflectionJob(job, records);
          await mutate(job.id, (item, state) => {
            item.status = 'completed'; item.completedAt = Date.now(); delete item.error; delete item.errorCode; delete item.candidates;
            if (item.kind === 'reflection') state.agentKnowledge.reflectionKeys = [...new Set([...(state.agentKnowledge.reflectionKeys ?? []), item.id.slice('reflection:'.length)])].slice(-128);
          });
          if (job.kind === 'base') { processed++; report('learned', { workerId: job.workerId }); }
          else report('reflection_end');
        } catch (error) {
          const interrupted = closing && error === controller.signal.reason;
          try {
            await mutate(selected.id, item => {
              if (interrupted) { item.status = 'pending'; item.attempts = Math.max(0, item.attempts - 1); item.nextAttemptAt = 0; }
              else {
                item.status = error instanceof LearningValidationError || item.attempts >= maxAttempts ? 'failed' : 'pending';
                item.nextAttemptAt = Date.now() + Math.min(60000, retryBaseMs * 2 ** Math.min(item.attempts - 1, 6));
                item.error = 'Background learning failed; original evidence retained.';
                if (error instanceof LearningValidationError) item.errorCode = error.code;
              }
            });
          } catch { /* The durable running job is recoverable after the store becomes writable. */ }
          if (interrupted) report('deferred'); else { failures++; report('failed', { message: 'Background learning failed; queued work is retained.',
            ...(error instanceof LearningValidationError ? { code: error.code } : {}) }); }
          if (!job) { storageRetryAt = Date.now() + retryBaseMs; return; }
        }
      }
      if (ready.length && !closing) {
        await new Promise(resolve => setImmediate(resolve));
        requested = true;
      }
    } while (requested && !closing);
  }
  function wake() {
    if (closing) return;
    requested = true;
    if (running) return;
    running = Promise.resolve().then(run).catch(() => { failures++; report('failed'); }).finally(() => {
      running = undefined; schedule();
    });
  }
  const initializing = store.commit(state => {
    enqueueLearningWork(state, { reflection, finalize: true }); recoverLearningJobs(state);
  }).then(wake).catch(() => { failures++; report('failed'); });
  return {
    enqueue(state) {
      try { enqueueLearningWork(state, { reflection }); }
      catch { failures++; report('failed', { message: 'Learning queue needs repair; execution evidence is still retained.' }); }
    },
    observe() { wake(); },
    status() {
      let pending = 0, completed = 0, failed = 0;
      for (const job of jobs()) {
        if (job.status === 'pending' || job.status === 'running') pending++;
        else if (job.status === 'completed') completed++;
        else if (job.status === 'failed') failed++;
      }
      return { pending, running: Boolean(running), processed, failures, dropped: 0, reflections, completed, failed };
    },
    async flush() { await initializing; wake(); while (running) await running; },
    close() {
      if (closingPromise) return closingPromise;
      closing = true; clearTimeout(timer); controller.abort(new Error('Background learning runtime is closing'));
      closingPromise = Promise.resolve().then(async () => {
        await initializing; while (running) await running;
        await store.commit(state => { enqueueLearningWork(state, { reflection, finalize: true }); });
      });
      return closingPromise;
    }
  };
}
