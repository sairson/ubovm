'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { createRPC } = require('./agent-backend.cjs').backendModule('thread-rpc.cjs');
const { interruptExecution } = require('./agent-backend.cjs').backendModule('projection.cjs');
const { serializeError } = require('./agent-backend.cjs').backendModule('errors.cjs');
const idle = () => ({ status: 'idle', busy: false, phase: null, workers: [], activities: [], parts: [], streamText: '', canResume: false, error: null });
const closedError = () => Object.assign(new Error('IDE agent service is closed'), { code: 'SERVICE_CLOSED' });
// Freeze once on arrival, instead of copying a growing timeline on every UI read.
function readonly(value) {
  const pending = [value], seen = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    Object.freeze(item);
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return value;
}

/** The host owns UI state; each runtime generation owns its transport and tools. */
function createHarnessService(options) {
  const states = new Map(), summaries = new Map(), launching = new Map(), stopping = new Map();
  const descriptors = new Map();
  const checkResponse = response => {
    if (response.failure) throw Object.assign(new Error(response.failure.message), response.failure);
    return response.result;
  };
  let runtime, restarting, closing, stopped = false;
  const notify = id => { if (stopped || closing) return; try { Promise.resolve(options.onChange?.(id)).catch(() => {}); } catch {} };
  function accept(owner, snapshot) {
    if (runtime !== owner || owner.failed || stopped || !snapshot?.id) return;
    const { id, revision, state, summary } = snapshot;
    // A delayed notification must not resurrect a removed/released session.
    // Initial snapshots are admitted by the live request; subsequent ones by
    // successful restoration. No growing tombstone set is needed.
    if (!owner.requests.has(id) && !owner.restored.has(id)) return;
    if (!Number.isSafeInteger(revision) || revision <= (owner.revisions.get(id) ?? 0)) return;
    const nextState = readonly(state), nextSummary = readonly(summary);
    owner.revisions.set(id, revision);
    states.set(id, nextState); summaries.set(id, nextSummary); notify(id);
  }
  function spawn() {
    const owner = { tools: new Map(), revisions: new Map(), requests: new Map(), restored: new Set() };
    const worker = owner.worker = new Worker(path.join(path.dirname(options.sdkPath), 'ide/runtime/harness-thread.cjs'), {
      workerData: { sdkPath: options.sdkPath, storageDirectory: options.storageDirectory }
    });
    runtime = owner;
    const rpc = owner.rpc = createRPC(worker, async (method, args, signal) => {
      const [id] = args;
      signal.throwIfAborted();
      if (owner.failed || runtime !== owner) throw closedError();
      switch (method) {
        case 'snapshot': accept(owner, id); return;
        case 'snapshotFailure': {
          const failure = id;
          const state = states.get(failure.id) ?? idle();
          accept(owner, { ...failure,
            state: { ...state, status: failure.summary.status, busy: failure.summary.busy, phase: failure.summary.phase, error: failure.error },
            summary: { ...failure.summary, error: failure.error } });
          return;
        }
        case 'roots': return typeof options.workspaceRoots === 'function' ? options.workspaceRoots(id) : options.workspaceRoots ?? [];
        case 'configuration': return options.readConfiguration();
        case 'approval':
          if (!options.requestToolApproval) throw new Error('人工审核界面不可用，工具未执行。');
          return options.requestToolApproval({ ...id, signal });
        case 'message': return options.onMessage?.(...args);
        case 'tools': {
          const list = await options.additionalTools?.(id) ?? [];
          signal.throwIfAborted();
          owner.tools.set(id, new Map(list.map(tool => [tool.name, tool])));
          return list.map(({ execute, ...metadata }) => JSON.parse(JSON.stringify(metadata)));
        }
        case 'execute': {
          const tool = owner.tools.get(id)?.get(args[1]);
          if (!tool) throw new Error('Host tool is no longer available');
          return tool.execute(args[2], args[3], signal);
        }
        default: throw new Error('Unknown host method');
      }
    }, { onClose: error => fail(error), heartbeatInterval: options.heartbeatInterval ?? 5000, heartbeatTimeout: options.heartbeatTimeout ?? 20000 });
    function fail(error) {
      if (runtime !== owner || stopped || owner.failed) return;
      owner.failed = error; rpc.close(error); owner.tools.clear();
      owner.terminated = worker.terminate();
      // Keep diagnostics even when no conversation is active; observer failures
      // must not become a second unhandled rejection in the IDE host.
      try { Promise.resolve(options.onError?.({ ...serializeError(error), threadId: worker.threadId })).catch(() => {}); } catch {}
      void owner.terminated.catch(() => {});
      // Completed/idle conversations survive an unrelated runtime failure.
      for (const id of new Set([...states.keys(), ...owner.requests.keys()])) {
        const state = states.get(id) ?? idle();
        if (!state.busy && !owner.requests.has(id)) continue;
        const failure = { message: error.message, code: error.code === 'AGENT_HEARTBEAT_TIMEOUT' ? error.code : 'AGENT_THREAD_EXIT' };
        states.set(id, readonly({ ...interruptExecution(state, failure), canResume: descriptors.get(id)?.mode === 'goal' }));
        summaries.set(id, readonly({ ...summaries.get(id), status: 'failed', busy: false, phase: null, activeWorkers: 0, error: failure }));
        notify(id);
      }
    }
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error('Agent thread exited (' + code + ')')));
    return owner;
  }
  async function ensure(method) {
    if (closing || stopped) throw closedError();
    if (!runtime) return spawn();
    if (!runtime.failed) return runtime;
    // A user operation may recreate the runtime, but never replay an execution.
    if (!['start', 'restore', 'resume', 'remove', 'releaseWorkspace'].includes(method)) throw runtime.failed;
    if (!restarting) restarting = (async () => {
      await runtime.terminated;
      if (closing || stopped) throw closedError();
      if (!runtime.rpc.isIdle()) throw Object.assign(new Error('上一次运行的工具仍在完成取消清理，请稍后重试。'), { code: 'AGENT_HOST_CLEANUP_PENDING' });
      return spawn();
    })().finally(() => { restarting = undefined; });
    return restarting;
  }
  async function invoke(method, args) {
    const release = ['start', 'restore', 'resume', 'remove', 'releaseWorkspace'].includes(method) ? await options.beforeSession?.() : undefined;
    try { return await invokeSession(method, args); }
    finally { release?.(); }
  }
  async function invokeSession(method, args) {
    const id = typeof args[0] === 'string' ? args[0] : args[0]?.conversationId;
    if (method === 'resume' && runtime?.failed && descriptors.get(id)?.mode !== 'goal') throw runtime.failed;
    const owner = await ensure(method);
    if (closing || stopped) throw closedError();
    owner.requests.set(id, (owner.requests.get(id) ?? 0) + 1);
    try {
      if (method === 'resume' && !owner.restored.has(id) && descriptors.get(id)?.mode === 'goal') {
        const recovered = await owner.rpc.call('restore', [descriptors.get(id)]);
        accept(owner, recovered.snapshot); checkResponse(recovered); owner.restored.add(id);
        if (closing || stopped) throw closedError();
        if (launching.get(id)?.cancelled) throw Object.assign(new Error('恢复执行已取消。'), { code: 'ABORT_ERR' });
      }
      const descriptor = method === 'start' || method === 'restore'
        ? structuredClone({ conversationId: id, mode: args[0]?.mode, goal: args[0]?.goal, executionBranch: args[0]?.executionBranch }) : undefined;
      const response = await owner.rpc.call(method, args);
      accept(owner, response.snapshot);
      const result = checkResponse(response);
      if (method === 'start' || method === 'restore') {
        descriptors.set(id, descriptor);
        owner.restored.add(id);
      }
      if (method === 'remove' || method === 'releaseWorkspace') { owner.tools.delete(id); owner.restored.delete(id); owner.revisions.delete(id); }
      if (method === 'remove') descriptors.delete(id);
      return result;
    } finally {
      const count = owner.requests.get(id) - 1;
      if (count) owner.requests.set(id, count); else owner.requests.delete(id);
    }
  }
  const busyError = () => Object.assign(new Error('该会话仍在启动或运行。'), { code: 'SESSION_BUSY' });
  function sessionRequest(method, input) {
    // Snapshot before launch observers or asynchronous workspace preparation.
    // Failed cloning must not reserve a session, spawn a worker, or acquire a lock.
    try {
      const request = structuredClone(input);
      return method === 'start' ? launch(method, [request], request?.conversationId) : invoke(method, [request]);
    } catch (error) { return Promise.reject(error); }
  }
  function stop(id, commandId) {
    const key = JSON.stringify([id, commandId ?? null]);
    if (stopping.has(key)) return stopping.get(key);
    const operation = (async () => {
      for (;;) {
        try { return await invoke(commandId === undefined ? 'cancel' : 'interruptCommand', commandId === undefined ? [id] : [id, commandId]); }
        catch (error) {
          if (error.code !== 'RPC_BUSY' || closing) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    })().finally(() => { stopping.delete(key); });
    stopping.set(key, operation);
    return operation;
  }
  function launch(method, args, id) {
    if (closing || stopped) return Promise.reject(closedError());
    if (launching.has(id) || states.get(id)?.busy) return Promise.reject(busyError());
    const reservation = { cancelled: false };
    launching.set(id, reservation); notify(id);
    return invoke(method, args).then(async result => {
      // A stop click can arrive before the worker has created its session.
      if (reservation.cancelled && !closing) {
        // An earlier stop may have found no session. Drain it, then stop again
        // now that start/resume has acknowledged creation of the execution.
        await stopping.get(JSON.stringify([id, null]))?.catch(() => {});
        await stop(id);
      }
      return result;
    }).finally(() => { launching.delete(id); notify(id); });
  }
  const state = id => {
    const value = states.get(id) ?? idle();
    return launching.has(id) && !value.busy ? { ...value, busy: true, status: 'starting' } : value;
  };
  return Object.freeze({
    connectionState: () => ({ status: stopped || closing ? 'closed' : runtime?.failed ? 'disconnected' : runtime ? 'connected' : 'idle', error: runtime?.failed?.message }),
    state,
    runtimeSummary: id => {
      const value = summaries.get(id) ?? { status: 'idle', busy: false, workerCount: 0, activeWorkers: 0 };
      return launching.has(id) && !value.busy ? { ...value, busy: true, status: 'starting' } : value;
    },
    isBusy: id => launching.has(id) || states.get(id)?.busy === true,
    start: input => sessionRequest('start', input),
    steer: (id, input) => {
      // Pin the request before async transport setup yields to its caller.
      try { return invoke('steer', [id, structuredClone(input)]); }
      catch (error) { return Promise.reject(error); }
    },
    restore: input => sessionRequest('restore', input),
    resume: id => launch('resume', [id], id),
    interruptCommand: (id, commandId) => {
      if (typeof commandId !== 'string' || !/^[a-f0-9-]{36}$/.test(commandId)) return Promise.reject(new Error('命令标识无效。'));
      return stop(id, commandId);
    },
    backgroundCommand: (id, commandId) => {
      if (typeof commandId !== 'string' || !/^[a-f0-9-]{36}$/.test(commandId)) return Promise.reject(new Error('命令标识无效。'));
      return invoke('backgroundCommand', [id, commandId]);
    },
    cancel(id) {
      const reservation = launching.get(id);
      if (reservation) reservation.cancelled = true;
      const busy = Boolean(reservation) || states.get(id)?.busy === true;
      if (busy && runtime && !runtime.failed && !closing) void stop(id).catch(() => {});
      return busy;
    },
    releaseWorkspace: id => launching.has(id) ? Promise.reject(busyError()) : invoke('releaseWorkspace', [id]),
    async remove(id) { if (launching.has(id)) throw busyError(); await invoke('remove', [id]); states.delete(id); summaries.delete(id); },
    close() {
      if (closing) return closing;
      // Set the barrier before scheduling shutdown: no new requests can enter.
      closing = Promise.resolve().then(async () => {
        await restarting?.catch(() => {});
        const owner = runtime;
        if (!owner) { stopped = true; return; }
        let timer;
        try {
          await Promise.race([(async () => {
            if (!owner.failed) checkResponse(await owner.rpc.call('close'));
            await owner.rpc.drain();
          })(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Agent thread shutdown timed out')), 10000);
          })]);
        } finally {
          clearTimeout(timer); stopped = true; owner.rpc.close();
          try { await (owner.terminated ?? owner.worker.terminate()); }
          finally {
            // The closed service can remain referenced by UI subscriptions.
            // Release its timelines and recovery metadata even if termination
            // rejects; preserve the rejected close promise for diagnostics.
            owner.tools.clear(); owner.revisions.clear(); owner.restored.clear(); owner.requests.clear();
            states.clear(); summaries.clear(); descriptors.clear(); launching.clear(); stopping.clear();
            runtime = undefined;
          }
        }
      });
      return closing;
    }
  });
}
module.exports = { createHarnessService };
