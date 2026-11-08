import { Type } from 'typebox';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const alias = description => Type.String({ minLength: 1, maxLength: 32, description });

function sleepFor(ms, signal, sleep) {
  if (typeof sleep === 'function') return sleep(ms, signal);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Reason wait was interrupted.')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Reason wait was interrupted.')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * Host-side Worker management tools exposed to the Reason planner during one
 * exploration review. Every call goes through the coordinator's control surface;
 * the tools never touch the Blackboard or another Worker's transcript directly.
 */
export function createReasonWorkerTools({
  control, maxActions = 12, onSleep, sleep,
  maxSleeps = 24, defaultSleepSeconds = 30, maxSleepSeconds = 300
} = {}) {
  if (!control || typeof control.list !== 'function' || typeof control.stop !== 'function'
    || typeof control.start !== 'function' || typeof control.prompt !== 'function') {
    throw new TypeError('createReasonWorkerTools requires a worker control surface');
  }
  if (!Number.isSafeInteger(maxActions) || maxActions < 1) throw new TypeError('maxActions must be a positive integer');
  for (const [name, value] of Object.entries({ maxSleeps, defaultSleepSeconds, maxSleepSeconds })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (onSleep !== undefined && typeof onSleep !== 'function') throw new TypeError('onSleep must be a function');
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  let actions = 0;
  let sleeps = 0;
  const budget = () => {
    if (++actions > maxActions) throw new Error(`Worker action budget exhausted (${maxActions} per review). Return the JSON decision now; the host applies already executed actions.`);
  };
  const sleepBudget = () => {
    if (++sleeps > maxSleeps) throw new Error(`Wait budget exhausted (${maxSleeps} per review). Return a decision now.`);
  };
  return [
    {
      name: 'wait_worker_sleep', label: 'Wait for Workers, then re-check',
      description: 'Pause this review for the requested number of seconds while running Workers keep working. When the wait ends, the host restarts the review with the current Blackboard, so newly recorded facts, Worker status and any failed attempts are visible; choose new intents or manage Workers then. Use only while at least one Worker is pending or running. Prefer this over repeatedly calling list_workers while nothing can be decided.',
      parameters: Type.Object({
        seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSleepSeconds,
          description: `Seconds to wait before re-reviewing; defaults to ${defaultSleepSeconds}.` })),
        reason: Type.Optional(Type.String({ maxLength: 512, description: 'Short note about what this wait is observing.' }))
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        sleepBudget();
        const before = control.list();
        const waitable = () => control.list().filter(worker => ['pending', 'running'].includes(worker.status));
        if (!waitable().length) {
          // Nothing to wait for: return guidance instead of a failed tool call so
          // the model can finish its decision in this same review.
          return result({
            slept_seconds: 0,
            workers: before.filter(worker => ['pending', 'running', 'failed', 'interrupted'].includes(worker.status)),
            completed: before.filter(worker => worker.status === 'completed').length,
            note: 'No pending or running Workers; nothing to wait for. Submit the JSON decision now (intents, wait:true, or completion).'
          });
        }
        const seconds = Number.isSafeInteger(input?.seconds)
          ? Math.min(maxSleepSeconds, Math.max(1, input.seconds))
          : defaultSleepSeconds;
        const reason = typeof input?.reason === 'string' ? input.reason : '';
        const started = Date.now();
        let interrupted = false;
        if (typeof control.waitForActivity === 'function') {
          const controller = new AbortController();
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const activity = control.waitForActivity(combined).then(() => true, () => false);
          const timer = sleepFor(seconds * 1000, combined, sleep).then(() => false).catch(error => {
            if (controller.signal.aborted && !signal?.aborted) return false;
            throw error;
          });
          // Close the tiny race where all Workers finish between the initial
          // list and registering the activity waiter.
          if (!waitable().length) {
            controller.abort();
            return result({
              slept_seconds: 0,
              interrupted_by_activity: true,
              workers: control.list().filter(worker => ['pending', 'running', 'failed', 'interrupted'].includes(worker.status)),
              completed: control.list().filter(worker => worker.status === 'completed').length,
              note: 'All pending/running Workers finished before the wait began; return the JSON decision now.'
            });
          }
          interrupted = await Promise.race([activity, timer]);
          controller.abort();
        } else {
          await sleepFor(seconds * 1000, signal, sleep);
        }
        onSleep?.({ seconds, reason, ...(interrupted ? { interrupted: true } : {}) });
        const after = control.list();
        return result({
          slept_seconds: typeof control.waitForActivity === 'function' ? Math.max(0, Math.round((Date.now() - started) / 1000)) : seconds,
          interrupted_by_activity: interrupted,
          workers: after.filter(worker => ['pending', 'running', 'failed', 'interrupted'].includes(worker.status)),
          completed: after.filter(worker => worker.status === 'completed').length,
          note: interrupted
            ? 'A Worker settled during the wait; the fresh review should run now using the current board.'
            : 'A fresh review will start with the current board; re-evaluate intents and Worker state.'
        });
      }
    },
    {
      name: 'list_workers', label: 'List exploration Workers',
      description: 'List active Workers for this review: node alias (nX), status, task description, attempt history, progress phase and result alias. A running Worker progress may include unchanged_reviews, meaning its checkpoint step has not advanced across that many reviews. Completed Workers are omitted by default (their result facts are in the evidence graph); pass include_completed=true only when you explicitly need the archived roster. Worker aliases from this output are the only addresses stop_worker/start_worker/prompt_worker accept. A running Worker may include lastCorrection {type, text, at}; read it before sending another direction so a fresh correction gets at least one review to take effect.',
      parameters: Type.Object({
        include_completed: Type.Optional(Type.Boolean({ description: 'Include completed Workers from earlier rounds; default false.' }))
      }, { additionalProperties: false }),
      async execute(_id, input) {
        const workers = control.list();
        if (input?.include_completed === true) return result({ workers, completed: workers.filter(worker => worker.status === 'completed').length });
        const active = workers.filter(worker => ['pending', 'running', 'failed', 'interrupted'].includes(worker.status));
        const completed = workers.filter(worker => worker.status === 'completed');
        return result({
          workers: active,
          completed: {
            count: completed.length,
            result_aliases: completed.map(worker => worker.result).filter(Boolean).slice(-20),
            note: 'Completed Workers are archived; read their result facts from the evidence graph or pass include_completed=true.'
          }
        });
      }
    },
    {
      name: 'stop_worker', label: 'Stop an exploration Worker',
      description: 'Stop one Worker now. A running attempt is interrupted after cleanup, its slot is released and the board keeps an interrupted attempt that can be reopened; a queued intent is marked interrupted before it starts. Tool effects are never rolled back. A concrete reason is mandatory: it is recorded on the interrupted attempt, shown to the operator and preserved when the Worker is reopened. Use start_worker to reopen stopped or failed work.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".'),
        reason: Type.String({ minLength: 1, maxLength: 1024,
          description: 'REQUIRED concrete stop reason for the operator and the audit trail, for example "stuck in a retry loop", "duplicate of n3", "off-goal branch" or "blocking a higher-value check".' })
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        if (typeof input?.reason !== 'string' || !input.reason.trim()) {
          throw new Error('stop_worker requires a concrete reason; state why this Worker is being stopped.');
        }
        return result({ ...await control.stop(input.worker, input.reason.trim()), reason: input.reason.trim() });
      }
    },
    {
      name: 'start_worker', label: 'Start an exploration Worker',
      description: 'Start or reopen one Worker. A pending Worker is dispatched now when a concurrency slot is available; a failed or interrupted Worker is reopened and resumes from its latest checkpoint. Completed Workers cannot be restarted: create a new intent instead.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".')
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        return result(await control.start(input.worker));
      }
    },
    {
      name: 'prompt_worker', label: 'Send a direction to an exploration Worker',
      description: 'Send a new direction to one Worker. A running Worker usually receives it live at its next model boundary, preserving current reasoning and completed tool effects; only when live delivery is unavailable does it restart from its checkpoint. A pending, failed or interrupted Worker carries it into the next attempt. Use this to correct course, narrow evidence requirements or stop unproductive recursion, never to replace the goal.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".'),
        message: Type.String({ minLength: 1, maxLength: 1024, description: 'Concrete additional direction for this Worker.' })
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        return result(await control.prompt(input.worker, input.message));
      }
    }
  ];
}
