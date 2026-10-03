import { buildBlackboardContext } from './context.mjs';
import { normalizeKeyPoints } from './blackboard.mjs';
import { workerEvidence, completionEvidenceIssue } from './evidence.mjs';
import { assertIntentCapacity, intentCapacity } from './intent-capacity.mjs';

// All coordinators in this process share the lease. An isolated worker runtime
// may be concurrent with another worker, but a board has only one scheduler.
const runningBoards = new WeakSet();
const priorityRank = { high: 0, medium: 1, low: 2 };

/** Lower rank launches first: gap closure before unrelated pending work. */
export function frontierLaunchRank(node, context) {
  const exploration = context?.data?.exploration;
  if (!exploration || !node?.id) return 3;
  const alias = context.aliasFor(node.id);
  let rank = 3;
  for (const entry of exploration.frontier ?? []) {
    const linked = entry.activeRefs?.includes(alias)
      || exploration.gaps?.some(gap => gap.ref === entry.sourceRef && gap.followUpRefs?.includes(alias));
    if (!linked) continue;
    if (entry.status === 'unassigned' || entry.status === 'needs_replan' || entry.failedRefs?.length) rank = Math.min(rank, 0);
    else if (entry.status === 'review_results' || entry.resultRefs?.length) rank = Math.min(rank, 1);
    else rank = Math.min(rank, 0);
  }
  if (rank === 3) {
    const gapRefs = new Set((exploration.gaps ?? []).map(gap => gap.ref));
    for (const parentId of node.parentIds ?? []) {
      const parentAlias = context.aliasFor(parentId);
      const parent = context.data.nodes.find(item => item.ref === parentAlias);
      if (gapRefs.has(parentAlias) || (parent?.result && gapRefs.has(parent.result))) rank = Math.min(rank, 0);
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

function prepareIntents(proposals, snapshot, context) {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const canonicalParents = ids => [...new Set(ids.map(id => byId.get(id)?.resultId || id))];
  const seen = new Set(snapshot.nodes.filter((node) => node.intent)
    .map((node) => intentKey(node.intent, canonicalParents(node.parentIds))));
  return proposals.map((intent) => {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      throw failure('INVALID_DECISION', 'Each intent must be an object.');
    }
    if (Object.hasOwn(intent, 'hint')) {
      throw failure('INVALID_DECISION', 'Reason cannot write authenticated human hints.');
    }
    if (typeof intent.description !== 'string' || !intent.description.trim()) {
      throw failure('INVALID_DECISION', 'Each intent requires a nonempty description.');
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
  });
}

/** Provider-neutral Reason -> parallel Workers -> durable Blackboard loop. */
export class BlackboardCoordinator {
  #running = false;
  #completion;
  #listeners = new Set();

  constructor({ blackboard, reason, worker, maxConcurrency = 3, maxRounds = 20 } = {}) {
    if (!blackboard || typeof blackboard.snapshot !== 'function') {
      throw new TypeError('blackboard is required.');
    }
    if (typeof reason !== 'function' || typeof worker !== 'function') {
      throw new TypeError('reason and worker callbacks are required.');
    }
    this.blackboard = blackboard;
    this.reason = reason;
    this.worker = worker;
    this.maxConcurrency = positiveInteger(maxConcurrency, 'maxConcurrency');
    this.maxRounds = positiveInteger(maxRounds, 'maxRounds');
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
    let reviewedState;
    let wake;
    const launch = async () => {
      while (retryIds.length && intentCapacity(this.blackboard.snapshot().nodes, this.blackboard.openIntents).available > 0) {
        checkAbort(signal);
        await this.blackboard.retryIntent(retryIds.shift());
      }
      const pending = orderPendingIntents(this.blackboard.pendingIntents(), this.blackboard.snapshot());
      for (const node of pending) {
        if (active.size >= this.maxConcurrency) break;
        if (active.has(node.id)) continue;
        const operation = this.#execute(node, workerSignal).then(
          () => settled.push({ id: node.id }),
          error => settled.push({ id: node.id, error })
        ).then(() => { wake?.(); });
        active.set(node.id, operation);
      }
    };
    const waitForWorker = async () => {
      if (!settled.length) await interruptible(() => new Promise(resolve => { if (settled.length) resolve(); else wake = resolve; }), signal);
      wake = undefined;
      const result = settled.shift();
      active.delete(result.id);
      if (result.error) throw result.error;
    };
    try {
      if (resume) {
        await this.blackboard.recoverInterrupted();
        for (const node of this.blackboard.snapshot().nodes) {
          checkAbort(signal);
          if (node.intent && node.intent.status !== 'completed' && node.attempts.length > 0 &&
              ['failed', 'interrupted'].includes(node.intent.status)) {
            retryIds.push(node.id);
          }
        }
      }

      await launch();
      if (active.size) await waitForWorker();
      for (let round = 1; round <= this.maxRounds;) {
        checkAbort(signal);
        let snapshot = this.blackboard.snapshot();
        const context = buildBlackboardContext(snapshot);
        const { revision: _revision, ...state } = context.data;
        const stateKey = JSON.stringify(state);
        // Several workers can settle before one review sees their combined facts.
        // Consume their notifications without asking Reason to review the same
        // evidence again or charging another reasoning round for checkpoint traffic.
        if (reviewedState === stateKey) {
          await launch();
          if (!active.size) throw failure('STALLED', 'No new evidence or executable work remains.');
          await waitForWorker();
          continue;
        }
        const currentRound = round++;
        let decision;
        try {
          decision = await interruptible(() => this.reason({ context, signal }), signal);
        } catch (cause) {
          if (signal?.aborted) throw abortError(signal);
          throw failure('REASON_FAILED', `Reason callback failed: ${cause?.message ?? cause}`, cause);
        }
        checkAbort(signal);
        const latest = this.blackboard.snapshot();
        if (latest.revision !== snapshot.revision) {
          // Checkpoint-only writes do not change the facts Reason evaluated.
          const { revision: _oldRevision, ...before } = context.data;
          const { revision: _newRevision, ...after } = buildBlackboardContext(latest).data;
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
          await Promise.all(active.values());
          const errors = settled.filter(item => item.error && item.error.code !== 'ABORT_ERR').map(item => item.error);
          if (errors.length) throw new AggregateError(errors, 'Failed to persist remaining workers.');
          checkAbort(signal);
          return { ...complete, revision: this.blackboard.snapshot().revision };
        }
        if (decision.complete !== undefined && decision.complete !== false) {
          throw failure('INVALID_DECISION', 'complete must be a boolean.');
        }
        if (decision.wait === true) {
          if (decision.intents !== undefined) throw failure('INVALID_DECISION', 'Waiting cannot also propose new intents.');
          reviewedState = stateKey;
          await launch();
          if (!active.size) throw failure('STALLED', 'No remaining workers to wait for.');
          await waitForWorker();
          continue;
        }
        if (!Array.isArray(decision.intents)) {
          throw failure('INVALID_DECISION', 'An unfinished decision must contain an intents array.');
        }
        if (decision.intents.length === 0) {
          throw failure('STALLED', 'Reason supplied no new intents and no executable pending work remains.');
        }
        assertIntentCapacity(snapshot.nodes, decision.intents.length, this.blackboard.openIntents);
        const intents = prepareIntents(decision.intents, snapshot, context);
        try { await this.blackboard.createIntents(intents, { expectedRevision: snapshot.revision }); }
        catch (error) { if (error.code === 'STALE_DECISION') continue; throw error; }
        checkAbort(signal);
        await launch();
        await waitForWorker();
      }
      throw failure('MAX_ROUNDS', `Blackboard execution exceeded ${this.maxRounds} Reason rounds.`);
    } finally {
      controller.abort(failure('COORDINATOR_STOPPED', 'Coordinator stopped; no further work is authorized.'));
      await Promise.all(active.values());
      this.#listeners.clear();
      this.#running = false;
      runningBoards.delete(this.blackboard);
    }
  }

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

  async #execute(node, signal) {
    checkAbort(signal);
    const previous = [...node.attempts].reverse().find((item) => item.checkpoint !== undefined);
    const attempt = await this.blackboard.beginAttempt(node.id);
    let active = true;
    const subscriptions = new Set();
    const checkpointWrites = [];
    let checkpointFailure;
    const requireActive = () => {
      checkAbort(signal);
      if (!active) throw failure('ATTEMPT_CLOSED', `Worker attempt ${attempt.id} is no longer active.`);
    };
    let result;
    try {
      result = await interruptible(() => {
        let returned;
        try {
          returned = this.worker({
        node: this.blackboard.node(node.id),
        attempt: structuredClone(attempt),
        checkpoint: previous ? structuredClone(previous.checkpoint) : undefined,
        signal,
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
          return buildBlackboardContext(this.blackboard.snapshot(), { focusId: node.id });
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
      }, signal);
      // Freeze the accepted write set before draining it. Late helper calls
      // return handled rejections and cannot race fact writeback.
      active = false;
      await Promise.all(checkpointWrites);
      if (checkpointFailure) throw checkpointFailure;
      checkAbort(signal);
      const content = typeof result === 'string' ? result : result?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw failure('INVALID_WORKER_RESULT', 'Worker must return nonempty fact content.');
      }
    } catch (error) {
      active = false;
      await Promise.allSettled(checkpointWrites);
      await this.blackboard.failAttempt(node.id, attempt.id, String(error?.message ?? error) || 'Worker failed without an error message.', {
        interrupted: Boolean(signal?.aborted),
      });
      if (checkpointFailure) throw checkpointFailure;
      if (signal?.aborted) throw abortError(signal);
      return;
    } finally {
      active = false;
      for (const listener of subscriptions) this.#listeners.delete(listener);
    }
    try {
      await this.blackboard.completeAttempt(node.id, attempt.id, typeof result === 'string' ? result : result.content, {
        provenance: typeof result === 'object' && result ? result.provenance : undefined,
      });
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
