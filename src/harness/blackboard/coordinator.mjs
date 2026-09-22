import { buildBlackboardContext } from './context.mjs';
import { normalizeKeyPoints } from './blackboard.mjs';
import { workerEvidence } from './evidence.mjs';

// All coordinators in this process share the lease. An isolated worker runtime
// may be concurrent with another worker, but a board has only one scheduler.
const runningBoards = new WeakSet();

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
    normalizeKeyPoints(intent.keyPoints).map(normalizeIntentText).sort(),
    [...new Set(parentIds)].sort(),
  ]);
}

function prepareIntents(proposals, snapshot, context) {
  const seen = new Set(snapshot.nodes.filter((node) => node.intent)
    .map((node) => intentKey(node.intent, node.parentIds)));
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
    parentIds = [...new Set(parentIds.map(id => snapshot.nodes.find(node => node.id === id)?.resultId || id))];
    if (parentIds.some(id => { const node = snapshot.nodes.find(node => node.id === id); return node.kind === 'intent' && !node.fact; })) {
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
      throw failure('INVALID_DECISION', 'Intent keyPoints must be an array of strings.', cause);
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
    runningBoards.add(this.blackboard);
    try {
      if (resume) {
        await this.blackboard.recoverInterrupted();
        for (const node of this.blackboard.snapshot().nodes) {
          checkAbort(signal);
          if (node.intent && node.intent.status !== 'completed' && node.attempts.length > 0 &&
              ['failed', 'interrupted'].includes(node.intent.status)) {
            await this.blackboard.retryIntent(node.id);
          }
        }
      }

      for (let round = 1; round <= this.maxRounds; round += 1) {
        checkAbort(signal);
        // Each completed Worker gets an immediate Reason pass. These passes
        // are observational while the batch is still draining; the final
        // pass below remains authoritative for creating intents/completion.
        await this.#dispatch(signal, () => this.#thinkAfterWorker(signal));
        checkAbort(signal);
        const snapshot = this.blackboard.snapshot();
        const context = buildBlackboardContext(snapshot);
        let decision;
        try {
          decision = await interruptible(() => this.reason({ context, signal }), signal);
        } catch (cause) {
          if (signal?.aborted) throw abortError(signal);
          throw failure('REASON_FAILED', `Reason callback failed: ${cause?.message ?? cause}`, cause);
        }
        checkAbort(signal);
        if (this.blackboard.snapshot().revision !== snapshot.revision) {
          throw failure('STALE_DECISION', 'The blackboard changed while Reason was evaluating its snapshot.');
        }
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
          throw failure('INVALID_DECISION', 'Reason must return a decision object.');
        }
        if (decision.complete === true) {
          const complete = this.#complete(decision, snapshot, context, round);
          // Queue the final validation behind already accepted host writes;
          // an in-flight persist is deliberately absent from snapshot().
          await this.blackboard.verifyRevision(snapshot.revision);
          checkAbort(signal);
          return complete;
        }
        if (decision.complete !== undefined && decision.complete !== false) {
          throw failure('INVALID_DECISION', 'complete must be a boolean.');
        }
        if (!Array.isArray(decision.intents)) {
          throw failure('INVALID_DECISION', 'An unfinished decision must contain an intents array.');
        }
        if (decision.intents.length === 0) {
          throw failure('STALLED', 'Reason supplied no new intents and no executable pending work remains.');
        }
        const intents = prepareIntents(decision.intents, snapshot, context);
        await this.blackboard.createIntents(intents, { expectedRevision: snapshot.revision });
        checkAbort(signal);
        await this.#dispatch(signal, () => this.#thinkAfterWorker(signal));
      }
      throw failure('MAX_ROUNDS', `Blackboard execution exceeded ${this.maxRounds} Reason rounds.`);
    } finally {
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
    if (snapshot.nodes.some((node) => node.intent && ['pending', 'running'].includes(node.intent.status))) {
      throw failure('INVALID_COMPLETION', 'Pending or running intents must finish before completion.');
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
      const { node } = evidence;
      // Worker lifecycle completion can still yield a blocked/partial finding.
      // Recognize the pi Worker's versioned fact format without making generic
      // blackboards depend on the model runtime or changing legacy text facts.
      let fact;
      try { fact = JSON.parse(node.fact.content); } catch { /* legacy text */ }
      const workerFact = fact?.version === 1 && typeof fact.statement === 'string' && typeof fact.outcome === 'string';
      if ((workerFact || node.provenance?.sourceType === 'pi-worker') &&
          (!workerFact || !['confirmed', 'negative'].includes(fact.outcome) ||
           !Array.isArray(fact.evidence) || !fact.evidence.length || !Array.isArray(fact.coverage) ||
           fact.coverage.some(item => !['confirmed', 'negative'].includes(item.status)))) {
        throw failure('INVALID_COMPLETION', `Node ${id} contains unresolved Worker evidence.`);
      }
    }
    return { complete: true, evidenceIds, summary: decision.summary.trim(), rounds: round, revision: snapshot.revision };
  }

  async #thinkAfterWorker(signal) {
    checkAbort(signal);
    const snapshot = this.blackboard.snapshot();
    const context = buildBlackboardContext(snapshot);
    let decision;
    try {
      // A Worker completion is a useful incremental observation even when
      // other Workers are still running. Apply only against the exact
      // snapshot that Reason saw; concurrent completions are handled by their
      // own Reason pass and must never be overwritten by a stale decision.
      decision = await interruptible(() => this.reason({ context, signal }), signal);
    } catch (cause) {
      if (signal?.aborted) throw abortError(signal);
      throw failure('REASON_FAILED', `Reason callback failed after Worker completion: ${cause?.message ?? cause}`, cause);
    }
    if (this.blackboard.snapshot().revision !== snapshot.revision || !decision || decision.complete === true) return;
    if (!Array.isArray(decision.intents) || decision.intents.length === 0) return;
    const intents = prepareIntents(decision.intents, snapshot, context);
    await this.blackboard.createIntents(intents, { expectedRevision: snapshot.revision });
  }

  async #dispatch(signal, onWorkerComplete) {
    const claimed = new Set();
    const consume = async () => {
      while (true) {
        checkAbort(signal);
        const node = this.blackboard.pendingIntents().find(item => !claimed.has(item.id));
        if (!node) return;
        claimed.add(node.id);
        const completed = await this.#execute(node, signal);
        if (completed && onWorkerComplete) await onWorkerComplete();
      }
    };
    // allSettled ensures every started worker is finished or has had its write
    // access revoked before the board lease is released after any error.
    const settled = await Promise.allSettled(
      Array.from({ length: this.maxConcurrency }, consume),
    );
    const errors = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
    // Do not hide failed interruption persistence behind the signal: the host
    // must learn when its durable state could not be updated.
    const persistenceErrors = errors.filter((error) => error?.code !== 'ABORT_ERR');
    if (persistenceErrors.length) throw new AggregateError(persistenceErrors, 'Blackboard worker persistence failed.');
    checkAbort(signal);
    if (errors.length) throw errors[0];
  }

  async #execute(node, signal) {
    checkAbort(signal);
    const previous = [...node.attempts].reverse().find((item) => item.checkpoint !== undefined);
    const attempt = await this.blackboard.beginAttempt(node.id);
    let active = true;
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
    return true;
  }
}
