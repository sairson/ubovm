'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createRPC } = require('./thread-rpc.cjs');
const { createHarnessService } = require('./harness-service.cjs');
const { createSnapshotQueue } = require('./snapshot-queue.cjs');
const { serializeError } = require('./errors.cjs');
let revision = 0;
function snapshot(id) {
  return { id, revision: ++revision, state: service.state(id), summary: service.runtimeSummary(id) };
}
const methods = new Set(['start', 'steer', 'resume', 'cancel', 'interruptCommand', 'backgroundCommand', 'restore', 'releaseWorkspace', 'remove', 'close']);
const rpc = createRPC(parentPort, async (method, args) => {
  if (!methods.has(method)) throw new Error('Unknown agent method');
  if (method === 'close') snapshots.close();
  const id = typeof args[0] === 'string' ? args[0] : args[0]?.conversationId;
  let result;
  try { result = await service[method](...args); }
  catch (error) {
    let current;
    if (method !== 'close' && typeof id === 'string' && id) {
      try { current = snapshot(id); snapshots.forget(id); }
      catch { snapshots.schedule(id); }
    }
    // A rejected command may still have restored a checkpoint or settled a
    // reservation. Return that authoritative state along with the failure.
    return { failure: serializeError(error), snapshot: current };
  }
  if (method === 'close') return { result };
  snapshots.forget(id);
  // Commands carry their current projection so callers observe the new state
  // before their promise resolves, independently of the streaming queue.
  const current = snapshot(id);
  // Structured clone preserves this shared reference: a command transports one
  // timeline rather than separate copies for its return value and UI cache.
  return { result: ['start', 'resume', 'restore'].includes(method) ? current.state : result, snapshot: current };
}, { onClose: async () => {
  // A run outlives the RPC that started it. Losing the host must also cancel
  // local model/tool work and release storage, not only pending RPC calls.
  snapshots.close();
  try { await service.close(); }
  finally { parentPort.close(); }
} });
const snapshots = createSnapshotQueue({ delay: 75, read: snapshot, send: async (value, isCurrent) => {
  // Model/tool calls may briefly fill the request budget. A UI snapshot waits
  // for capacity instead of permanently losing the streaming subscription.
  while (isCurrent()) {
    try { return await rpc.call('snapshot', [value]); }
    catch (error) {
      if (error.code !== 'RPC_BUSY') throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}, onError: (error, id) => {
  const failure = serializeError(error);
  let summary;
  try { summary = service.runtimeSummary(id); }
  catch { summary = { status: 'failed', busy: service.isBusy(id), phase: null }; }
  return rpc.call('snapshotFailure', [{ id, revision: ++revision, summary, error: failure }]).catch(() => {});
} });
const service = createHarnessService({
  ...workerData,
  workspaceRoots: id => rpc.call('roots', [id]),
  readConfiguration: () => rpc.call('configuration'),
  requestToolApproval: ({ signal, ...request }) => rpc.call('approval', [request], signal),
  additionalTools: async id => (await rpc.call('tools', [id])).map(tool => ({ ...tool,
    execute: (callId, input, signal) => rpc.call('execute', [id, tool.name, callId, input], signal)
  })),
  onChange: id => snapshots.schedule(id),
  onMessage: (id, message) => rpc.call('message', [id, message])
});
