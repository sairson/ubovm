/**
 * Runtime wrappers shared by the collaboration tool loop:
 *
 * - `createParallelGate`: a small abort-aware semaphore. Pi Agent starts every
 *   allowed call in a parallel batch at once and has no concurrency cap, so a
 *   model that emits twenty reads would otherwise open twenty file handles or
 *   LSP requests at once.
 * - `withToolTimeout`: cooperative per-call deadline. It aborts the call's
 *   signal and returns a structured timeout error; it never aborts the turn.
 *   Tools that own a process-level timeout (shell, Python, SSH) are not wrapped
 *   again, so their cleanup and exit semantics stay authoritative.
 */
const SECOND = 1000;

/** Per-tool deadlines for tools that do not enforce their own timeout. */
export const TOOL_TIMEOUTS = Object.freeze({
  read_workspace_file: 30 * SECOND,
  read_image: 60 * SECOND,
  list_workspace_files: 30 * SECOND,
  read_workspace_code: 30 * SECOND,
  read_workspace_change: 30 * SECOND,
  list_workspace_changes: 30 * SECOND,
  search_workspace: 60 * SECOND,
  navigate_workspace_code: 30 * SECOND,
  analyze_workspace_call_chain: 30 * SECOND,
  preview_workspace_rename: 60 * SECOND,
  preview_workspace_edits: 60 * SECOND,
  inspect_workspace_project: 30 * SECOND,
  get_workspace_diagnostics: 30 * SECOND,
  read_context_evidence: 30 * SECOND,
  read_worker_result: 30 * SECOND,
  read_worker_evidence: 30 * SECOND,
  list_workers: 30 * SECOND,
  inspect_harness: 30 * SECOND,
  list_assist_evidence: 15 * SECOND,
  list_linked_goals: 15 * SECOND,
  read_skills_resource: 15 * SECOND,
  web_search: 60 * SECOND,
  fetch_web_content: 60 * SECOND,
});

/** Tools whose own execution path already owns cancellation and process cleanup. */
const SKIP_TIMEOUT = new Set([
  'run_local_shell_command',
  'run_linux_ssh_command',
  'run_python',
  'manage_python_environment',
  'upload_sftp',
  'deploy_remote_service',
  'run_local_skill_script',
  'wait_workers',
  'ask_human',
  'install_skill',
  'install_mcp_server',
  'load_skill',
  'todo',
  'note',
  'delivery_workflow',
  'domain_inventory',
  'learn_capability',
  'browser_action',
  'browser_connection_status',
]);

const MCP_PREFIX = 'mcp_';
const MCP_TIMEOUT_MS = 60 * SECOND;

export function timeoutMsFor(name) {
  if (typeof name !== 'string' || !name) return undefined;
  if (SKIP_TIMEOUT.has(name)) return undefined;
  const configured = TOOL_TIMEOUTS[name];
  if (configured) return configured;
  return name.startsWith(MCP_PREFIX) ? MCP_TIMEOUT_MS : undefined;
}

function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('Tool call aborted'), { code: 'ABORT_ERR' });
}

function timeoutError(name, timeoutMs) {
  return Object.assign(new Error(
    `[TOOL_TIMEOUT] ${name} exceeded ${timeoutMs}ms. The request was cancelled and cleanup was requested; ` +
    'narrow the request, check the environment, or retry once it is responsive.'
  ), { code: 'TOOL_TIMEOUT', details: { tool: name, timeoutMs, cleanup: 'requested' } });
}

/**
 * Cooperative per-call deadline. The wrapped tool still receives the caller's
 * abort signal; on expiry we abort a child controller and reject immediately.
 * A tool that ignores cancellation may finish later, but its result is ignored
 * by the agent loop once this promise has settled.
 */
export function withToolTimeout(tool, timeoutMs) {
  if (!tool || typeof tool.execute !== 'function') throw new TypeError('tool.execute must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer;
      let abortListener;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError(tool.name, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      const aborted = signal ? new Promise((_, reject) => {
        if (signal.aborted) { reject(abortReason(signal)); return; }
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener('abort', abortListener, { once: true });
      }) : undefined;
      aborted?.catch(() => {});
      const running = Promise.resolve().then(() => tool.execute(toolCallId, args, combined, onUpdate));
      // A timeout or parent abort settles the race first; the underlying tool
      // may still reject later. Keep that late rejection from becoming an
      // unhandled rejection in the harness process.
      running.catch(() => {});
      try {
        return await Promise.race(aborted ? [running, timeout, aborted] : [running, timeout]);
      } finally {
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
    },
  };
}

/**
 * Abort-aware parallel gate. `acquire()` resolves with an idempotent release
 * function. Waiters removed by an abort never consume a slot.
 */
export function createParallelGate(limit = 4) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  let active = 0;
  const queue = [];

  function grant() {
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      drain();
    };
  }

  function drain() {
    while (active < limit && queue.length) {
      const waiter = queue.shift();
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) { waiter.reject(abortReason(waiter.signal)); continue; }
      waiter.resolve(grant());
    }
  }

  const acquire = signal => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < limit) return Promise.resolve(grant());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined };
      waiter.onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(abortReason(signal));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      queue.push(waiter);
    });
  };

  return {
    acquire,
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

export function withParallelGate(tool, gate) {
  if (!tool || typeof tool.execute !== 'function') throw new TypeError('tool.execute must be a function');
  if (!gate || typeof gate.acquire !== 'function') throw new TypeError('gate.acquire must be a function');
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      const release = await gate.acquire(signal);
      try {
        return await tool.execute(toolCallId, args, signal, onUpdate);
      } finally {
        release();
      }
    },
  };
}

/**
 * Apply timeouts and the shared gate to a resolved tool array. `executionMode`
 * must already be attached (see `applyExecutionModes`); only tools explicitly
 * marked `parallel` take a gate slot.
 */
export function applyToolRuntime(tools, { gate = createParallelGate(), timeouts = TOOL_TIMEOUTS } = {}) {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
  return tools.map(tool => {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new TypeError('Every tool requires a nonempty name');
    let wrapped = tool;
    const configured = typeof timeouts === 'function' ? timeouts(tool.name) : timeouts[tool.name];
    const timeoutMs = configured ?? (tool.name.startsWith(MCP_PREFIX) ? MCP_TIMEOUT_MS : undefined);
    if (timeoutMs && !SKIP_TIMEOUT.has(tool.name)) wrapped = withToolTimeout(wrapped, timeoutMs);
    if (tool.executionMode === 'parallel') wrapped = withParallelGate(wrapped, gate);
    return wrapped;
  });
}
