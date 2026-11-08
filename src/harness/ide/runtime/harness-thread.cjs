'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createRPC } = require('./thread-rpc.cjs');
const { createHarnessService } = require('./harness-service.cjs');
const { createSnapshotQueue } = require('./snapshot-queue.cjs');
const { serializeError } = require('./errors.cjs');
let revision = 0;
const sentBoards = new Map();
const HEAVY_SNAPSHOT_INTERVAL_MS = 1000;
function snapshot(id) {
  // Board/logHistory clone cost scales with graph size. During fact storms the
  // revision can change many times per second; stream light snapshots and send a
  // full projection at most once per second, while the host reuses the previous
  // projection. This prevents multi-hour runs from allocating several MB of
  // board state per UI tick.
  const heavyRevision = service.heavyRevision(id);
  const previous = sentBoards.get(id);
  const now = Date.now();
  const stale = !previous || previous.revision !== heavyRevision;
  const due = !previous || now - previous.at >= HEAVY_SNAPSHOT_INTERVAL_MS;
  const light = !(stale && due);
  if (!light) sentBoards.set(id, { revision: heavyRevision, at: now });
  return { id, revision: ++revision, state: service.state(id, { omitHeavy: light }), summary: service.runtimeSummary(id) };
}
const methods = new Set(['start', 'steer', 'resume', 'cancel', 'interruptCommand', 'backgroundCommand', 'restore', 'authoritative', 'watchTeamMember', 'goalChatSend', 'goalChatCancel', 'goalChatNewThread', 'goalChatSelectThread', 'goalChatDeleteThread', 'goalChatRewind', 'releaseWorkspace', 'remove', 'close']);
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
// Pace UI projections above the per-entry notify coalesce so thinking streams
// do not flood the host bridge while heartbeats still share the same RPC lane.
const snapshots = createSnapshotQueue({ delay: 120, read: snapshot, send: async (value, isCurrent) => {
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
  readConfiguration: id => rpc.call('configuration', [id]),
  // The sidebar conversation only needs model credentials; it must not inherit
  // the goal run's SSH/workspace readiness gate.
  readChatConfiguration: id => rpc.call('chatConfiguration', [id]),
  requestToolApproval: ({ signal, ...request }) => rpc.call('approval', [request], signal),
  askHuman: ({ signal, ...request }) => rpc.call('question', [request], signal),
  additionalTools: async id => (await rpc.call('tools', [id])).map(tool => ({ ...tool,
    execute: (callId, input, signal) => rpc.call('execute', [id, tool.name, callId, input], signal)
  })),
  ideBrowserCall: (op, payload, signal) => rpc.call('ideBrowser', [op, payload], signal),
  onChange: id => snapshots.schedule(id),
  onMessage: (id, message) => rpc.call('message', [id, message])
});

// Keep the harness thread alive across stray async failures: one lost listener
// must not take down every live session it serves. Durable state stays on disk,
// so the worst case is a session the host restores from its checkpoint.
const crashLog = path.join(workerData.storageDirectory || process.cwd(), 'backend-crash.log');
function recordCrash(kind, value) {
  const detail = value instanceof Error ? value.stack || value.message : String(value);
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
  try { fs.mkdirSync(path.dirname(crashLog), { recursive: true }); fs.appendFileSync(crashLog, line.slice(0, 32768)); } catch { /* diagnostics only */ }
  try { process.stderr.write(`[harness] ${kind}: ${detail}\n`); } catch { /* stderr unavailable */ }
}
process.on('uncaughtException', error => recordCrash('uncaughtException', error));
process.on('unhandledRejection', reason => recordCrash('unhandledRejection', reason));
// Long exploration runs are memory-sensitive. Emit a low-noise diagnostic before
// the V8 heap hits the process limit so a host crash can be traced to growth
// rather than an opaque worker exit.
const memoryWatch = setInterval(() => {
  const usage = process.memoryUsage();
  if (usage.rss < 1.5 * 1024 ** 3) return;
  try {
    process.stderr.write(`[harness] memory rss=${Math.round(usage.rss / 1024 ** 2)}MiB heapUsed=${Math.round(usage.heapUsed / 1024 ** 2)}MiB heapTotal=${Math.round(usage.heapTotal / 1024 ** 2)}MiB\n`);
  } catch { /* stderr unavailable */ }
}, 120000);
memoryWatch.unref?.();
