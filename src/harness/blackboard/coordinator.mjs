import { buildBlackboardContext } from './context.mjs';
import { normalizeKeyPoints } from './blackboard.mjs';
import { workerEvidence, completionEvidenceIssue } from './evidence.mjs';
import { fillIntentSlots, intentCapacity } from './intent-capacity.mjs';
import { EXPLORATION_STOP_MARKER } from './agenda.mjs';

// All coordinators in this process share the lease. An isolated worker runtime
// may be concurrent with another worker, but a board has only one scheduler.
const runningBoards = new WeakSet();
const priorityRank = { high: 0, medium: 1, low: 2 };
const frontierRank = { gap: 0, review: 1, unrelated: 2 };

/** Lower rank launches first: gap closure before unrelated pending work. */
export function frontierLaunchRank(node, context) {
  const exploration = context?.data?.exploration;
  if (!exploration || !node?.id) return frontierRank.unrelated;
  const alias = context.aliasFor(node.id);
  let rank = frontierRank.unrelated;
  for (const entry of exploration.frontier ?? []) {
    const linked = entry.activeRefs?.includes(alias)
      || exploration.gaps?.some(gap => gap.ref === entry.sourceRef && gap.followUpRefs?.includes(alias));
    if (!linked) continue;
    if (entry.status === 'unassigned' || entry.status === 'needs_replan' || entry.failedRefs?.length) rank = Math.min(rank, frontierRank.gap);
    else if (entry.status === 'review_results' || entry.resultRefs?.length) rank = Math.min(rank, frontierRank.review);
    else rank = Math.min(rank, frontierRank.gap);
  }
  if (rank === frontierRank.unrelated) {
    const gapRefs = new Set((exploration.gaps ?? []).map(gap => gap.ref));
    for (const parentId of node.parentIds ?? []) {
      const parentAlias = context.aliasFor(parentId);
      const parent = context.data.nodes.find(item => item.ref === parentAlias);
      if (gapRefs.has(parentAlias) || (parent?.result && gapRefs.has(parent.result))) rank = Math.min(rank, frontierRank.gap);
    }
  }
  return rank;
}

export function orderPendingIntents(pending, snapshot) {
  if (!Array.isArray(pending) || pending.length <= 1) return pending ?? [];
  const context = buildBlackboardContext(snapshot);
  const order = new Map(snapshot.nodes.map((node, index) => [node.id, index]));
  return [...pending].sort((left, right) => {
    const frontier = frontierLaunchRank(left, context) - frontierLaunchRank(right, context);
    if (frontier) return frontier;
    const priority = (priorityRank[left.intent?.priority] ?? 1) - (priorityRank[right.intent?.priority] ?? 1);
    if (priority) return priority;
    return (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0);
  });
}

function failure(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function abortError(signal) {
  const error = failure('ABORT_ERR', 'Blackboard execution was interrupted.', signal?.reason);
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

// A callback may ignore AbortSignal. Stop waiting and revoke its write helpers;
// Promise handlers remain attached so a late rejection is still consumed.
function interruptible(invoke, signal) {
  checkAbort(signal);
  if (!signal) return Promise.resolve().then(invoke);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      checkAbort(signal);
      return invoke();
    }).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative integer.`);
  }
  return value;
}

function resolveReferences(values, context, label) {
  if (!Array.isArray(values)) throw failure('INVALID_DECISION', `${label} must be an array.`);
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      throw failure('INVALID_DECISION', `${label} must contain nonempty node references.`);
    }
    let id;
    try {
      id = context.resolveId(value.trim());
    } catch (cause) {
      throw failure('INVALID_DECISION', `Unknown ${label} reference: ${value}`, cause);
    }
    if (!id) throw failure('INVALID_DECISION', `Unknown ${label} reference: ${value}`);
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

const normalizeIntentText = (value) => value.trim().replace(/\s+/gu, ' ').toLowerCase();

function intentKey(intent, parentIds) {
  return JSON.stringify([
    normalizeIntentText(intent.description),
    [...new Set(normalizeKeyPoints(intent.keyPoints).map(normalizeIntentText))].sort(),
    [...new Set(parentIds)].sort(),
  ]);
}

function prepareIntent(intent, snapshot, context, seen, byId, descriptions, extraDuplicates) {
  const canonicalParents = ids => [...new Set(ids.map(id => byId.get(id)?.resultId || id))];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw failure('INVALID_DECISION', 'Each intent must be an object.');
  }
  if (Object.hasOwn(intent, 'hint')) {
    throw failure('INVALID_DECISION', 'Reason cannot write authenticated human hints.');
  }
  if (typeof intent.description !== 'string' || !intent.description.trim()) {
    throw failure('INVALID_DECISION', 'Each intent requires a nonempty description.');
  }
  // Two intents that describe the same content would run the same investigation
  // twice. Compare normalized descriptions across every existing intent and any
  // Reason-authored agenda direction before creating another one.
  const descriptionKey = normalizeIntentText(intent.description);
  const existing = descriptions?.get(descriptionKey);
  if (existing) {
    throw failure('INVALID_DECISION', `The proposed intent duplicates ${existing.ref ?? 'existing work'} (${existing.status}): "${intent.description.trim().slice(0, 160)}". Reuse its result or extend its remaining gaps with a materially different method and description.`);
  }
  const duplicate = extraDuplicates?.get(descriptionKey);
  if (duplicate) {
    throw failure('INVALID_DECISION', `The proposed intent is already recorded on the shared agenda${duplicate.label ? ` as ${duplicate.label}` : ''}: "${intent.description.trim().slice(0, 160)}". Adopt or update that agenda item instead of dispatching a duplicate.`);
  }
  let parentIds = intent.parentIds === undefined
    ? [snapshot.rootId] : resolveReferences(intent.parentIds, context, 'parentIds');
  parentIds = canonicalParents(parentIds);
  if (parentIds.some(id => { const node = byId.get(id); return node.kind === 'intent' && !node.fact; })) {
    throw failure('INVALID_DECISION', 'New exploration must cite recorded facts or the root, not unfinished intents.');
  }
  if (parentIds.length === 0) throw failure('INVALID_DECISION', 'Each intent requires at least one parent.');
  const priority = intent.priority === undefined ? 'medium' : intent.priority;
  if (typeof priority !== 'string' || !['high', 'medium', 'low'].includes(priority.trim().toLowerCase())) {
    throw failure('INVALID_DECISION', 'Intent priority must be high, medium, or low.');
  }
  let keyPoints;
  try {
    keyPoints = normalizeKeyPoints(intent.keyPoints);
  } catch (cause) {
    throw failure('INVALID_DECISION', `Invalid intent keyPoints: ${cause.message}`, cause);
  }
  const prepared = { description: intent.description.trim(), parentIds, priority: priority.trim().toLowerCase(), keyPoints };
  const key = intentKey(prepared, parentIds);
  if (seen.has(key)) {
    throw failure('INVALID_DECISION', 'The proposed intent duplicates the same description, key points, and parent evidence. Resume failed work explicitly.');
  }
  seen.add(key);
  return prepared;
}

/** Provider-neutral Reason -> parallel Workers -> durable Blackboard loop. */
export class BlackboardCoordinator {
  #running = false;
  #completion;
  #listeners = new Set();
  // Control surface of the latest Reason review: the exploration sidebar reuses
  // the same alias-scoped Worker management callbacks instead of editing the
  // board directly.
  #control;

  constructor({ blackboard, reason, worker, maxConcurrency = 3, maxRounds = 0,
    workerTimeoutMs = 0, maxWorkerRetries = 0, reviewIntervalMs = 0, duplicateTexts } = {}) {
    if (!blackboard || typeof blackboard.snapshot !== 'function') {
      throw new TypeError('blackboard is required.');
    }
    if (typeof reason !== 'function' || typeof worker !== 'function') {
      throw new TypeError('reason and worker callbacks are required.');
    }
    if (duplicateTexts !== undefined && typeof duplicateTexts !== 'function') throw new TypeError('duplicateTexts must be a function returning agenda texts');
    this.blackboard = blackboard;
    this.reason = reason;
    this.worker = worker;
    this.duplicateTexts = duplicateTexts;
    this.maxConcurrency = positiveInteger(maxConcurrency, 'maxConcurrency');
    this.maxRounds = nonnegativeInteger(maxRounds, 'maxRounds');
    this.workerTimeoutMs = nonnegativeInteger(workerTimeoutMs, 'workerTimeoutMs');
    this.maxWorkerRetries = nonnegativeInteger(maxWorkerRetries, 'maxWorkerRetries');
    // A live review cadence: Reason re-reads the board and can steer/stop/start
    // running Workers even when nothing has settled yet. 0 disables the timer
    // (tests and embedded coordinators stay event-driven).
    this.reviewIntervalMs = nonnegativeInteger(reviewIntervalMs, 'reviewIntervalMs');
    if (Number.isSafeInteger(blackboard.openIntents) && this.maxConcurrency > blackboard.openIntents) {
      throw new TypeError('maxConcurrency cannot exceed the blackboard openIntents limit.');
    }
  }

  /**
   * resume explicitly retries interrupted/failed work with its latest saved
   * checkpoint. Workers implement their own checkpoint restore semantics.
   */
  async run({ signal, resume = false } = {}) {
    if (typeof resume !== 'boolean') throw new TypeError('resume must be a boolean.');
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    if (this.#running || runningBoards.has(this.blackboard)) {
      throw failure('BLACKBOARD_BUSY', 'This blackboard already has an active coordinator.');
    }
    checkAbort(signal);
    this.#running = true;
    this.#completion = undefined;
    runningBoards.add(this.blackboard);
    const controller = new AbortController();
    const workerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const active = new Map();
    const settled = [];
    const retryIds = [];
    // Reason-directed worker control stays inside the coordinator. Directives are
    // in-memory steering text injected into the next attempt's task description;
    // intentionalStops separates a host-requested interruption from a failure.
    const directives = new Map();
    // Last Reason correction per intent, for the next review's list_workers
    // output. It is host-only review context, not durable intent text.
    const corrections = new Map();
    // Worker settlement/status changes wake wait_worker_sleep early so a
    // completed Worker never leaves Reason sleeping on a stale wait.
    const activityWaiters = new Set();
    const bumpActivity = () => {
      for (const waiter of [...activityWaiters]) { activityWaiters.delete(waiter); waiter(); }
    };
    const waitForActivity = signal => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? abortError(signal)); return; }
      const waiter = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(signal.reason ?? abortError(signal)); };
      const cleanup = () => { activityWaiters.delete(waiter); signal?.removeEventListener('abort', onAbort); };
      activityWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const intentionalStops = new Set();
    const controlState = { directives, intentionalStops, corrections };
    let reviewedState;
    let wake;
    // Per-intent checkpoint progress across reviews. Periodic reviews use this to
    // distinguish "still working" from "ran two reviews without moving".
    const reviewProgress = new Map();
    // A live correction gets a shorter verification review so the next check can
    // confirm it reached the Worker instead of waiting a full cadence.
    let nextReviewAt = 0;
    const drainActive = () => Promise.all([...active.values()].map(entry => entry.operation));
    const launch = async () => {
      while (retryIds.length && intentCapacity(this.blackboard.snapshot({ clone: false }).nodes, this.blackboard.openIntents).available > 0) {
        checkAbort(signal);
        await this.blackboard.retryIntent(retryIds.shift());
      }
      const pending = orderPendingIntents(this.blackboard.pendingIntents({ clone: false }), this.blackboard.snapshot({ clone: false }));
      for (const node of pending) {
        if (active.size >= this.maxConcurrency) break;
        if (active.has(node.id)) continue;
        const entry = { operation: undefined, abort: undefined, startedAt: Date.now(), markReady: undefined };
        entry.ready = new Promise(resolve => { entry.markReady = resolve; });
        entry.operation = this.#execute(node, workerSignal, id => { retryIds.push(id); }, handle => {
          entry.handle = handle;
          entry.abort = handle.abort;
          entry.attemptId = handle.attemptId;
          entry.markReady();
        }, controlState).then(
          () => settled.push({ id: node.id, entry }),
          error => settled.push({ id: node.id, entry, error })
        ).then(() => { bumpActivity(); wake?.(); });
        active.set(node.id, entry);
        entry.operation.finally(() => {
          // A retried node may already have a newer entry; never delete it.
          if (active.get(node.id) === entry) active.delete(node.id);
        }).catch(() => {});
      }
    };
    const waitForWorker = async () => {
      if (!settled.length && !active.size) return false;
      if (!settled.length) {
        let timer;
        const periodic = await interruptible(() => new Promise(resolve => {
          let done = false;
          const finish = value => {
            if (done) return;
            done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); wake = undefined; resolve(value);
          };
          const onAbort = () => finish(false);
          wake = () => finish(false);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (this.reviewIntervalMs > 0) {
            const remaining = nextReviewAt > Date.now() ? nextReviewAt - Date.now() : this.reviewIntervalMs;
            nextReviewAt = 0;
            const delay = Math.max(500, Math.min(this.reviewIntervalMs, remaining));
            timer = setTimeout(() => finish(true), delay);
            timer.unref?.();
          }
        }), signal);
        if (periodic) {
          // A worker may have settled exactly when the timer fired. Prefer the
          // concrete completion over a speculative review; the next loop still
          // reviews the new fact immediately.
          if (!settled.length) return true;
        }
      }
      wake = undefined;
      const result = settled.shift();
      // Only retire the attempt that actually settled: a Reason action may have
      // already opened a newer attempt for the same intent while an older
      // notification was queued.
      if (active.get(result.id) === result.entry) active.delete(result.id);
      if (result.error) throw result.error;
      return false;
    };
    // Reason can control its own Workers through these callbacks. They only
    // accept aliases from the evidence snapshot that Reason is reviewing, so a
    // decision cannot address nodes it has not observed.
    const reasonControl = (context, progressHistory) => {
      const idOf = ref => {
        if (typeof ref !== 'string' || !/^n[1-9]\d*$/.test(ref.trim())) throw new TypeError('worker must be a node alias from the current context, such as n3.');
        try { return context.resolveId(ref.trim()); } catch { throw new Error(`Unknown worker alias ${ref.trim()}; call list_workers to see current aliases.`); }
      };
      const text = (value, name, limit) => {
        if (value === undefined || value === null) return '';
        if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
        if (value.trim().length > limit) throw new RangeError(`${name} must contain at most ${limit} characters.`);
        return value.trim();
      };
      const normalizeDirection = value => String(value).replace(/\s+/gu, ' ').trim().toLowerCase();
      const noteCorrectionReview = () => {
        if (this.reviewIntervalMs > 0) nextReviewAt = Date.now() + Math.max(1000, Math.min(30000, Math.floor(this.reviewIntervalMs / 2)));
      };
      const describe = id => {
        const node = this.blackboard.node(id);
        if (!node?.intent) throw new Error(`Node ${id} is not a worker intent.`);
        const latest = node.attempts.at(-1);
        const checkpoint = latest?.status === 'running' ? latest.checkpoint : undefined;
        const result = node.resultId ? context.aliasFor(node.resultId) : undefined;
        return {
          worker: context.aliasFor(id), status: node.intent.status, description: node.intent.description, priority: node.intent.priority,
          attempts: node.attempts.length,
          ...(latest ? { latest_attempt: latest.status } : {}),
          ...(node.attempts.some(attempt => attempt.status === 'failed' || attempt.status === 'interrupted') ? {
            failures: node.attempts.filter(attempt => ['failed', 'interrupted'].includes(attempt.status)).slice(-3)
              .map(attempt => ({ status: attempt.status, error: String(attempt.error ?? '').replace(/\s+/gu, ' ').trim().slice(0, 320) }))
          } : {}),
          ...(checkpoint && ['plan', 'execute', 'replan', 'conclude', 'done'].includes(checkpoint.phase) ? {
            progress: {
              phase: checkpoint.phase,
              completed_steps: Array.isArray(checkpoint.completed) ? checkpoint.completed.length : 0,
              remaining_steps: Array.isArray(checkpoint.plan) ? checkpoint.plan.length : 0,
              ...(progressHistory?.has(id) ? { unchanged_reviews: progressHistory.get(id).unchanged } : {})
            }
          } : {}),
          ...(result ? { result } : {}),
          ...(controlState.corrections?.get(id) ? { lastCorrection: controlState.corrections.get(id) } : {})
        };
      };
      const list = () => context.data.nodes.filter(node => node.intent).map(node => {
        try { return describe(context.resolveId(node.ref)); } catch { return undefined; }
      }).filter(Boolean);
      const stop = async (ref, reason) => {
        const id = idOf(ref);
        // A Reason-directed stop must always carry a concrete reason: it becomes
        // the interrupted attempt's recorded error / queued intent's cancel
        // reason, which the operator and later reviews rely on.
        const why = text(reason, 'reason', 1024);
        if (!why) throw new TypeError('Stopping a Worker requires a concrete reason.');
        let node = this.blackboard.node(id);
        if (!node?.intent) throw new Error(`Node ${ref} is not a worker intent.`);
        if (node.intent.status === 'running') {
          const entry = active.get(id);
          if (!entry) throw new Error(`Worker ${ref} is already finishing; stop it after it settles.`);
          await entry.ready;
          node = this.blackboard.node(id);
          if (!node?.intent || node.intent.status !== 'running') return { ...describe(id), status: node?.intent?.status ?? 'unknown', stopped: false, reason: why, note: 'The worker finished before the stop request was applied.' };
          intentionalStops.add(id);
          entry.abort(failure('WORKER_STOPPED', why));
          return { ...describe(id), status: 'stopping', stopped: true, reason: why, note: 'The current attempt is interrupted; its slot is released after cleanup and the board records an interrupted attempt. Tool effects are not rolled back.' };
        }
        if (node.intent.status === 'pending') {
          await this.blackboard.cancelIntent(id, EXPLORATION_STOP_MARKER + why);
          // Do not launch replacements synchronously: Reason may still be
          // applying directions to the remaining queued intents in this same
          // review. Launching here starts an un-directed worker and a later
          // prompt would have to restart it. The review loop fills slots.
          return { ...describe(id), stopped: true, reason: why, note: 'The queued intent was marked interrupted before it started.' };
        }
        throw new Error(`Worker ${ref} is ${node.intent.status}; only running or pending workers can be stopped.`);
      };
      const start = async ref => {
        const id = idOf(ref);
        let node = this.blackboard.node(id);
        if (!node?.intent) throw new Error(`Node ${ref} is not a worker intent.`);
        if (node.intent.status === 'running') throw new Error(`Worker ${ref} is already running.`);
        if (node.intent.status === 'completed') throw new Error(`Worker ${ref} already completed; create a new intent for additional work.`);
        if (node.intent.status === 'pending') {
          await launch();
          return { ...describe(id), started: this.blackboard.node(id).intent.status === 'running' };
        }
        // Reopen through the launch queue so capacity checks and persistence stay
        // in one place; retrying twice (here and in launch) would fail the commit.
        retryIds.push(id);
        await launch();
        return { ...describe(id), started: true, note: 'The intent was reopened and resumes from its latest checkpoint when a slot is available.' };
      };
      const prompt = async (ref, message) => {
        const id = idOf(ref);
        const direction = text(message, 'message', 1024);
        if (!direction) throw new TypeError('message must be a nonempty direction for the worker.');
        let node = this.blackboard.node(id);
        if (!node?.intent) throw new Error(`Node ${ref} is not a worker intent.`);
        if (node.intent.status === 'completed') throw new Error(`Worker ${ref} already completed; create a new intent instead of steering it.`);
        const previousCorrection = corrections.get(id);
        if (node.intent.status === 'running' && previousCorrection?.type === 'live' &&
            Date.now() - previousCorrection.at < Math.max(15000, this.reviewIntervalMs || 60000) &&
            normalizeDirection(previousCorrection.text) === normalizeDirection(direction)) {
          return { ...describe(id), directed: false, live: false, duplicate: true,
            note: 'An equivalent direction was already sent recently; let it reach the next model step before repeating it. If there is still no progress, escalate the method instead.' };
        }
        if (node.intent.status === 'running') {
          const entry = active.get(id);
          if (!entry) throw new Error(`Worker ${ref} is already finishing; steer it after it settles.`);
          // Prefer a live direction at the next model boundary: it preserves the
          // current reasoning and tool effects, matching a commander's nudge.
          let live = false;
          try { live = await entry.handle?.steer?.(direction) === true; } catch { live = false; }
          if (live) {
            directives.delete(id);
            corrections.set(id, { type: 'live', text: direction, at: Date.now() });
            noteCorrectionReview();
            return { ...describe(id), status: 'running', directed: true, live: true, note: 'The direction was injected for the next model step; completed tool effects are preserved and the Worker was not restarted.' };
          }
        }
        directives.set(id, direction);
        if (node.intent.status === 'pending') {
          await launch();
          corrections.set(id, { type: 'queued', text: direction, at: Date.now() });
          return { ...describe(id), directed: true, note: 'The direction is queued and will be included when the worker starts.' };
        }
        if (node.intent.status === 'running') {
          const entry = active.get(id);
          if (!entry) throw new Error(`Worker ${ref} is already finishing; steer it after it settles.`);
          await entry.ready;
          node = this.blackboard.node(id);
          if (!node?.intent || node.intent.status !== 'running') return { ...describe(id), directed: false, note: 'The worker finished before the new direction was applied.' };
          // The handler can register slightly after the attempt is created.
          let live = false;
          try { live = await entry.handle?.steer?.(direction) === true; } catch { live = false; }
          if (live) {
            directives.delete(id);
            corrections.set(id, { type: 'live', text: direction, at: Date.now() });
            noteCorrectionReview();
            return { ...describe(id), status: 'running', directed: true, live: true, note: 'The direction was injected for the next model step; completed tool effects are preserved and the Worker was not restarted.' };
          }
          intentionalStops.add(id);
          entry.abort(failure('WORKER_STEERED', 'Worker restarted by Reason with a new direction.'));
          corrections.set(id, { type: 'restart', text: direction, at: Date.now() });
          return { ...describe(id), status: 'restarting', directed: true, note: 'Live steering was unavailable; restarting from its checkpoint with the new direction.' };
        }
        retryIds.push(id);
        await launch();
        corrections.set(id, { type: 'reopen', text: direction, at: Date.now() });
        return { ...describe(id), directed: true, note: 'The intent was reopened with the new direction and resumes from its latest checkpoint.' };
      };
      return { list, stop, start, prompt, waitForActivity };
    };
    try {
      if (resume) {
        await this.blackboard.recoverInterrupted();
        for (const node of this.blackboard.snapshot({ clone: false }).nodes) {
          checkAbort(signal);
          if (node.intent && node.intent.status !== 'completed' && node.attempts.length > 0 &&
              ['failed', 'interrupted'].includes(node.intent.status)) {
            retryIds.push(node.id);
          }
        }
      }

      await launch();
      if (active.size) await waitForWorker();
      // wait_worker_sleep restarts the review with a fresh board; bound the number
      // of restarts so a model stuck in sleep cannot loop forever.
      let refreshes = 0;
      let periodicReview = false;
      for (let round = 1; this.maxRounds === 0 || round <= this.maxRounds;) {
        checkAbort(signal);
        let snapshot = this.blackboard.snapshot({ clone: false });
        const context = buildBlackboardContext(snapshot, { corrections, progressHistory: reviewProgress, recordProgress: true });
        const { revision: _revision, ...state } = context.data;
        const stateKey = JSON.stringify(state);
        // A timer-driven review is allowed even when the durable board is
        // unchanged: running Workers may have drifted while nothing settled.
        const forceReview = periodicReview;
        periodicReview = false;
        // Several workers can settle before one review sees their combined facts.
        // Consume their notifications without asking Reason to review the same
        // evidence again or charging another reasoning round for checkpoint traffic.
        if (reviewedState === stateKey && !forceReview) {
          await launch();
          if (!active.size) throw failure('STALLED', 'No new evidence or executable work remains.');
          if (await waitForWorker()) periodicReview = true;
          continue;
        }
        const currentRound = round++;
        let decision;
        // Publish the fresh control surface before the review: the sidebar chat
        // can list/stop/start/prompt workers with the same aliases Reason sees.
        this.#control = reasonControl(context, reviewProgress);
        try {
          decision = await interruptible(() => this.reason({ context, signal, control: this.#control, periodic: forceReview }), signal);
        } catch (cause) {
          if (signal?.aborted) throw abortError(signal);
          // wait_worker_sleep asks for a fresh review: Workers kept running while
          // Reason waited, so re-enter the loop with a rebuilt, current context.
          if (cause?.code === 'REVIEW_REFRESH') {
            if (++refreshes > 200) throw failure('STALLED', 'Reason requested too many fresh reviews after waiting for Workers.');
            continue;
          }
          // `terminated` is Node worker_threads aborting an in-flight promise
          // because the Agent backend thread died/was restarted. It is not a
          // model or planning failure; keep the checkpoint and say so clearly.
          if (/^terminated$/i.test(String(cause?.message ?? cause).trim()) || cause?.code === 'AGENT_THREAD_EXIT' ||
              cause?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
            throw failure('REASON_INTERRUPTED', '执行已中断：Agent 后端线程已终止（手动重启后端、窗口重载或后端崩溃）。黑板与检查点已保存，可继续执行。', cause);
          }
          throw failure('REASON_FAILED', `Reason callback failed: ${cause?.message ?? cause}`, cause);
        }
        checkAbort(signal);
        const latest = this.blackboard.snapshot({ clone: false });
        if (latest.revision !== snapshot.revision) {
          // Checkpoint-only writes do not change the facts Reason evaluated.
          const { revision: _oldRevision, ...before } = context.data;
          const { revision: _newRevision, ...after } = buildBlackboardContext(latest, { corrections, progressHistory: reviewProgress }).data;
          if (JSON.stringify(before) !== JSON.stringify(after)) continue;
          snapshot = latest;
        }
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
          throw failure('INVALID_DECISION', 'Reason must return a decision object.');
        }
        if (decision.complete === true) {
          const complete = this.#complete(decision, snapshot, context, currentRound);
          // Queue the final validation behind already accepted host writes;
          // an in-flight persist is deliberately absent from snapshot().
          try { await this.blackboard.verifyRevision(snapshot.revision); }
          catch (error) { if (error.code === 'STALE_DECISION') continue; throw error; }
          checkAbort(signal);
          this.#completion = { type: 'goal_completed', completion: complete };
          for (const listener of this.#listeners) { try { listener(structuredClone(this.#completion)); } catch {} }
          // Delivery is advisory: do not abort tools or override worker decisions.
          // Keep ownership until the running workers finish their own wrap-up.
          await drainActive();
          const errors = settled.filter(item => item.error && item.error.code !== 'ABORT_ERR').map(item => item.error);
          if (errors.length) throw new AggregateError(errors, 'Failed to persist remaining workers.');
          checkAbort(signal);
          return { ...complete, revision: this.blackboard.snapshot({ clone: false }).revision };
        }
        if (decision.complete !== undefined && decision.complete !== false) {
          throw failure('INVALID_DECISION', 'complete must be a boolean.');
        }
        if (decision.wait === true) {
          if (decision.intents !== undefined) throw failure('INVALID_DECISION', 'Waiting cannot also propose new intents.');
          reviewedState = stateKey;
          await launch();
          if (!active.size) throw failure('STALLED', 'No remaining workers to wait for.');
          if (await waitForWorker()) periodicReview = true;
          continue;
        }
        if (!Array.isArray(decision.intents)) {
          throw failure('INVALID_DECISION', 'An unfinished decision must contain an intents array.');
        }
        const capacity = intentCapacity(snapshot.nodes, this.blackboard.openIntents);
        const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
        const canonicalParents = ids => [...new Set(ids.map(id => byId.get(id)?.resultId || id))];
        const seen = new Set(snapshot.nodes.filter(node => node.intent)
          .map(node => intentKey(node.intent, canonicalParents(node.parentIds))));
        const descriptions = new Map();
        for (const node of snapshot.nodes) {
          if (!node.intent) continue;
          const key = normalizeIntentText(node.intent.description);
          if (!descriptions.has(key)) descriptions.set(key, { ref: context.aliasFor(node.id), status: node.intent.status });
        }
        let extraDuplicates = new Map();
        if (this.duplicateTexts) {
          try {
            const entries = await interruptible(() => this.duplicateTexts({ snapshot, context }), signal);
            if (Array.isArray(entries)) for (const entry of entries) {
              const text = typeof entry === 'string' ? entry : entry?.text ?? entry?.dedupeKey;
              if (typeof text !== 'string' || !text.trim()) continue;
              const key = normalizeIntentText(text);
              if (!extraDuplicates.has(key)) extraDuplicates.set(key, { label: typeof entry === 'object' && typeof entry?.label === 'string' ? entry.label : 'recorded direction' });
            }
          } catch (error) {
            if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError' || error?.code === 'COORDINATOR_STOPPED') throw error;
            // Agenda hints are advisory; a stale or unavailable board must not stop planning.
          }
        }
        const { admitted, wait, errors } = fillIntentSlots(decision.intents, {
          available: capacity.available,
          tryPrepare: item => {
            const prepared = prepareIntent(item, snapshot, context, seen, byId, descriptions, extraDuplicates);
            const key = normalizeIntentText(prepared.description);
            if (!descriptions.has(key)) descriptions.set(key, { ref: 'the current decision', status: 'planned' });
            return prepared;
          }
        });
        if (wait) {
          reviewedState = stateKey;
          await launch();
          if (!active.size) throw failure('STALLED', 'No remaining workers to wait for.');
          if (await waitForWorker()) periodicReview = true;
          continue;
        }
        if (admitted.length === 0) {
          if (errors[0]) throw errors[0];
          throw failure('STALLED', 'Reason supplied no new intents and no executable pending work remains.');
        }
        try { await this.blackboard.createIntents(admitted, { expectedRevision: snapshot.revision }); }
        catch (error) {
          if (error.code === 'STALE_DECISION') continue;
          if (error.code === 'OPEN_INTENT_LIMIT') {
            reviewedState = stateKey;
            await launch();
            if (active.size) {
              if (await waitForWorker()) periodicReview = true;
              continue;
            }
          }
          throw error;
        }
        checkAbort(signal);
        await launch();
        if (await waitForWorker()) periodicReview = true;
      }
      throw failure('MAX_ROUNDS', this.maxRounds > 0
        ? `Blackboard execution exceeded ${this.maxRounds} Reason rounds.`
        : 'Blackboard execution ended before the goal was completed.');
    } finally {
      controller.abort(failure('COORDINATOR_STOPPED', 'Coordinator stopped; no further work is authorized.'));
      await drainActive();
      directives.clear();
      intentionalStops.clear();
      this.#listeners.clear();
      this.#control = undefined;
      this.#running = false;
      runningBoards.delete(this.blackboard);
    }
  }

  /**
   * Latest alias-scoped Worker control surface. Undefined while no Reason review
   * is active, so embedded chats cannot address workers outside a review.
   */
  workerControl() { return this.#control; }

  #complete(decision, snapshot, context, round) {
    if (decision.intents !== undefined && (!Array.isArray(decision.intents) || decision.intents.length > 0)) {
      throw failure('INVALID_DECISION', 'Completion cannot also propose intents.');
    }
    if (typeof decision.summary !== 'string' || !decision.summary.trim()) {
      throw failure('INVALID_DECISION', 'Completion requires a nonempty summary.');
    }
    const evidenceIds = [...new Set(resolveReferences(decision.evidenceIds, context, 'evidenceIds').map(id => workerEvidence(snapshot.nodes, id)?.node.id || id))];
    if (evidenceIds.length === 0) {
      throw failure('INVALID_COMPLETION', 'Completion requires at least one completed fact as evidence.');
    }
    for (const id of evidenceIds) {
      const evidence = workerEvidence(snapshot.nodes, id);
      if (!evidence) {
        throw failure('INVALID_COMPLETION', `Node ${id} is not completed fact evidence.`);
      }
      const { node, producer } = evidence;
      const issue = completionEvidenceIssue(node.fact.content, producer.intent.keyPoints ?? [], node.provenance?.sourceType);
      if (issue) throw failure('INVALID_COMPLETION', `Node ${id} ${issue}.`);
    }
    return { complete: true, evidenceIds, summary: decision.summary.trim(), rounds: round, revision: snapshot.revision };
  }

  async #execute(node, signal, retry, onAttempt, controlState = {}) {
    checkAbort(signal);
    const previous = [...node.attempts].reverse().find((item) => item.checkpoint !== undefined);
    // One attempt owns one signal: coordinator stop propagates through it, and
    // an optional per-attempt deadline converts a hung worker into a failed
    // attempt instead of blocking the run's drain forever.
    const attemptController = new AbortController();
    const propagate = () => { if (!attemptController.signal.aborted) attemptController.abort(signal.reason); };
    if (signal.aborted) propagate();
    else signal.addEventListener('abort', propagate, { once: true });
    let deadline = null;
    if (this.workerTimeoutMs > 0) {
      deadline = setTimeout(() => attemptController.abort(failure('WORKER_TIMEOUT',
        `Worker attempt exceeded ${this.workerTimeoutMs}ms and was stopped.`)), this.workerTimeoutMs);
      deadline.unref?.();
    }
    let attempt;
    // A Worker implementation may accept live steering (next model boundary)
    // instead of being restarted from its checkpoint. Restart stays the
    // fallback for implementations that do not register a handler.
    let steeringHandler;
    const registerSteering = handler => {
      if (handler !== undefined && typeof handler !== 'function') throw new TypeError('registerSteering handler must be a function');
      steeringHandler = handler;
      return () => { if (steeringHandler === handler) steeringHandler = undefined; };
    };
    // Register the interrupt handle before the attempt commit so a Reason action
    // can never race an in-flight beginAttempt and leave an unstoppable Worker.
    const handle = {
      attemptId: undefined,
      abort: reason => { if (!attemptController.signal.aborted) attemptController.abort(reason); },
      steer: async message => {
        if (typeof steeringHandler !== 'function') return false;
        try { return (await steeringHandler({ text: String(message || '') })) !== false; } catch { return false; }
      }
    };
    onAttempt?.(handle);
    attempt = await this.blackboard.beginAttempt(node.id);
    handle.attemptId = attempt.id;
    const attemptSignal = attemptController.signal;
    let active = true;
    const subscriptions = new Set();
    const checkpointWrites = [];
    let checkpointFailure;
    const requireActive = () => {
      checkAbort(attemptSignal);
      if (!active) throw failure('ATTEMPT_CLOSED', `Worker attempt ${attempt.id} is no longer active.`);
    };
    // Reason's steering direction is host text attached to this attempt only; it
    // never rewrites the durable intent, so the board keeps the original plan.
    const directive = controlState.directives?.get(node.id);
    const current = this.blackboard.node(node.id);
    const workerNode = directive
      ? { ...current, intent: { ...current.intent, description: `${current.intent.description}\n\nReason direction (apply it to this attempt; it refines the task and never replaces the goal):\n${directive}` } }
      : current;
    let result;
    try {
      // A Worker's plan/execute/replan/conclude phases usually run without a board
      // revision change; rebuild the shared evidence projection once per revision
      // instead of once per model phase.
      let contextView, contextRevision = -1;
      result = await interruptible(() => {
        let returned;
        try {
          returned = this.worker({
        node: workerNode,
        attempt: structuredClone(attempt),
        checkpoint: previous ? structuredClone(previous.checkpoint) : undefined,
        signal: attemptSignal,
        registerSteering,
        getMessages: () => this.#completion ? [structuredClone(this.#completion)] : [],
        onMessage: listener => {
          requireActive();
          if (typeof listener !== 'function') throw new TypeError('Message listener must be a function');
          subscriptions.add(listener); this.#listeners.add(listener);
          if (this.#completion) listener(structuredClone(this.#completion));
          return () => { subscriptions.delete(listener); this.#listeners.delete(listener); };
        },
        getContext: () => {
          requireActive();
          const snapshot = this.blackboard.snapshot({ clone: false });
          if (!contextView || contextRevision !== snapshot.revision) {
            contextView = buildBlackboardContext(snapshot, { focusId: node.id });
            contextRevision = snapshot.revision;
          }
          return contextView;
        },
        saveCheckpoint: (data) => {
          let write;
          let accepted = false;
          let asynchronous = false;
          try {
            requireActive();
            accepted = true;
            // Admit and copy the checkpoint immediately, while this callback
            // still owns the attempt, even if it does not await the promise.
            write = Promise.resolve(this.blackboard.saveCheckpoint(node.id, attempt.id, data));
            asynchronous = true;
          } catch (error) {
            write = Promise.reject(error);
          }
          if (accepted) checkpointWrites.push(write);
          write.catch((error) => {
            // Input validation throws synchronously; every rejection from the
            // accepted storage operation must be surfaced as infrastructure.
            if (asynchronous) checkpointFailure ??= error;
          });
          return write;
        },
          });
        } catch (error) {
          active = false;
          throw error;
        }
        if (returned && typeof returned.then === 'function') {
          return Promise.resolve(returned).finally(() => { active = false; });
        }
        active = false;
        return returned;
      }, attemptSignal);
      // Freeze the accepted write set before draining it. Late helper calls
      // return handled rejections and cannot race fact writeback.
      active = false;
      await Promise.all(checkpointWrites);
      if (checkpointFailure) throw checkpointFailure;
      checkAbort(attemptSignal);
      const content = typeof result === 'string' ? result : result?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw failure('INVALID_WORKER_RESULT', 'Worker must return nonempty fact content.');
      }
    } catch (error) {
      active = false;
      await Promise.allSettled(checkpointWrites);
      // Prefer the attempt-local abort reason (deadline) over the generic
      // interruptible rejection when only this attempt was stopped.
      const reason = attemptSignal.aborted && !signal?.aborted && attemptSignal.reason instanceof Error
        ? attemptSignal.reason : error;
      const intentional = controlState.intentionalStops?.delete(node.id) === true;
      const detail = String(reason?.message ?? reason) || 'Worker failed without an error message.';
      await this.blackboard.failAttempt(node.id, attempt.id, intentional ? EXPLORATION_STOP_MARKER + detail : detail, {
        interrupted: Boolean(signal?.aborted) || intentional,
      });
      if (checkpointFailure) throw checkpointFailure;
      if (signal?.aborted) throw abortError(signal);
      // A Reason-directed stop stays interrupted for Reason to restart. A steer
      // restarts immediately so the queued direction reaches the next attempt.
      if (intentional) {
        if (controlState.directives?.has(node.id) && typeof retry === 'function') retry(node.id);
        return;
      }
      // Transient worker failures earn one in-run requeue per budget slot; the
      // attempt history stays on the board for Reason to review either way.
      if (this.maxWorkerRetries > 0 && typeof retry === 'function') {
        const current = this.blackboard.node(node.id);
        const terminations = current.attempts.filter(item => ['failed', 'interrupted'].includes(item.status)).length;
        if (terminations <= this.maxWorkerRetries) retry(node.id);
      }
      return;
    } finally {
      active = false;
      if (deadline !== null) clearTimeout(deadline);
      signal.removeEventListener('abort', propagate);
      controlState.intentionalStops?.delete(node.id);
      for (const listener of subscriptions) this.#listeners.delete(listener);
    }
    try {
      await this.blackboard.completeAttempt(node.id, attempt.id, typeof result === 'string' ? result : result.content, {
        provenance: typeof result === 'object' && result ? result.provenance : undefined,
      });
      controlState.directives?.delete(node.id);
    } catch (error) {
      try {
        await this.blackboard.failAttempt(node.id, attempt.id, String(error?.message ?? error) || 'Fact writeback failed.', {
          interrupted: Boolean(signal?.aborted),
        });
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], 'Fact writeback and failure persistence both failed.');
      }
      throw error;
    }
  }
}
