/**
 * Agent-facing background command registry.
 *
 * The host owns the real process lifetime (`command-control`); this registry
 * only keeps a bounded, read-only mirror of commands that entered the resident
 * (后台任务) state. It mirrors BOTH shell transports: local shell and SSH are
 * registered through the same host hook, so the model can list, read and stop
 * either kind by command id, exactly like a DeepSeek Harness background job.
 */

export const BACKGROUND_PREVIEW_LIMIT = 160;
export const BACKGROUND_OUTPUT_LIMIT = 12000;
export const BACKGROUND_TASK_LIMIT = 32;

function previewCommand(args) {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  try {
    const parsed = JSON.parse(raw);
    const command = parsed?.command;
    if (typeof command === 'string' && command.trim()) return command.replace(/\s+/g, ' ').trim().slice(0, BACKGROUND_PREVIEW_LIMIT);
  } catch { /* Malformed arguments still get a readable preview. */ }
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, BACKGROUND_PREVIEW_LIMIT);
}

function transportName(name) {
  if (name === 'run_linux_ssh_command') return 'ssh';
  if (name === 'run_local_shell_command') return 'local';
  return typeof name === 'string' ? name : '';
}

function elapsedLabel(startedAt, endedAt, now) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return '';
  const end = Number.isFinite(endedAt) ? endedAt : now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

export function createBackgroundTaskRegistry({
  limit = BACKGROUND_TASK_LIMIT,
  maxOutput = BACKGROUND_OUTPUT_LIMIT,
  now = () => Date.now()
} = {}) {
  const tasks = new Map();
  const numericLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : BACKGROUND_TASK_LIMIT;
  const outputLimit = Number.isSafeInteger(maxOutput) && maxOutput > 0 ? maxOutput : BACKGROUND_OUTPUT_LIMIT;

  function trim() {
    const ended = [...tasks.values()].filter(task => task.status !== 'running');
    // Keep the newest terminal logs; running tasks are never evicted.
    for (const task of ended.slice(numericLimit)) tasks.delete(task.id);
  }

  function view(task) {
    return {
      command_id: task.id,
      name: task.name,
      transport: transportName(task.name),
      worker_id: task.workerId,
      tool_call_id: task.toolCallId,
      command: task.commandLine,
      status: task.status,
      execution_state: task.executionState,
      started_at: task.startedAt,
      ended_at: task.endedAt,
      elapsed: elapsedLabel(task.startedAt, task.endedAt, now),
      stop_requested: task.stopRequested === true,
      output_bytes: Buffer.byteLength(task.output)
    };
  }

  /** Track one host-registered command. Returns an unsubscribe function. */
  function track(command) {
    if (!command || typeof command.id !== 'string' || !command.id) return () => {};
    const task = {
      id: command.id,
      name: command.name,
      workerId: typeof command.workerId === 'string' ? command.workerId : '',
      toolCallId: typeof command.toolCallId === 'string' ? command.toolCallId : '',
      args: typeof command.args === 'string' ? command.args.slice(0, 32768) : '',
      commandLine: previewCommand(command.args),
      // Host handle used only for interrupt/ownership; never serialized.
      process: command,
      startedAt: Number.isFinite(command.startedAt) ? command.startedAt : now(),
      status: 'running',
      executionState: '',
      output: '',
      // A command only becomes a background task after it is retained/put aside.
      background: command.retained === true,
      endedAt: undefined,
      stopRequested: false
    };
    tasks.set(task.id, task);
    trim();
    let unsubscribe;
    try {
      unsubscribe = command.subscribe?.(update => {
        if (!update || typeof update !== 'object') return;
        if (!task.background) task.background = true;
        if (typeof update.output === 'string') task.output = update.output.slice(-outputLimit);
        const status = typeof update.status === 'string' && update.status ? update.status : 'running';
        task.status = status === 'streaming' ? 'running' : status;
        if (typeof update.executionState === 'string') task.executionState = update.executionState;
        if (task.status === 'running') task.endedAt = undefined;
        else if (!Number.isFinite(task.endedAt)) task.endedAt = now();
      });
    } catch { /* A broken observer must not fail the command registration. */ }
    return () => {
      try { unsubscribe?.(); } catch { /* Teardown is best effort. */ }
      task.unsubscribe = undefined;
      // Foreground commands never entered the background list; drop the mirror
      // immediately instead of keeping an immortal "running" placeholder.
      if (!task.background) tasks.delete(task.id);
    };
  }

  function list({ workerId = '' } = {}) {
    return [...tasks.values()]
      .filter(task => task.background)
      .filter(task => !workerId || task.workerId === workerId)
      .sort((a, b) => {
        const running = Number(b.status === 'running') - Number(a.status === 'running');
        return running || b.startedAt - a.startedAt;
      })
      .map(view);
  }

  function read(commandId) {
    const task = typeof commandId === 'string' ? tasks.get(commandId) : undefined;
    if (!task) return undefined;
    return { ...view(task), output: task.output };
  }

  function stop(commandId) {
    const task = typeof commandId === 'string' ? tasks.get(commandId) : undefined;
    if (!task) return { ok: false, reason: 'missing' };
    if (task.status !== 'running') return { ok: false, reason: 'finished' };
    const accepted = task.process?.interrupt?.() === true;
    if (accepted) task.stopRequested = true;
    return { ok: accepted, reason: accepted ? 'stopping' : 'rejected' };
  }

  /** Running background tasks as context lines for the next model boundary. */
  function summary({ workerId = '', maxItems = 8 } = {}) {
    const running = [...tasks.values()].filter(task => task.background && task.status === 'running' && (!workerId || task.workerId === workerId));
    if (!running.length) return '';
    const failed = [...tasks.values()].filter(task => task.background && task.status === 'failed').slice(-2);
    const line = task => `- #${task.id} · ${task.commandLine || task.name} · 运行 ${elapsedLabel(task.startedAt, undefined, now)}${task.workerId ? ` · ${task.workerId}` : ''} · ${task.output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 120) || '暂无输出'}`;
    return ['# Background commands', 'Long-running commands are still running in the background. Do not start them again; inspect or stop them with background_commands (action=read|stop command_id=#<id>). A running job is not the end of the task: continue the remaining work and verify the outcome before the final answer.',
      ...running.slice(0, maxItems).map(line),
      ...failed.map(task => `- #${task.id} · ${task.commandLine || task.name} · 失败 · ${task.output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 120) || ''}`)
    ].join('\n');
  }

  function close() {
    for (const task of tasks.values()) { try { task.unsubscribe?.(); } catch { /* best effort */ } }
    tasks.clear();
  }

  return { track, list, read, stop, summary, close, get size() { return tasks.size; } };
}
