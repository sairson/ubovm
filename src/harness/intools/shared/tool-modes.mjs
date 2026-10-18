/**
 * Execution-mode classification for model-facing tools.
 *
 * Pi Agent executes a batch concurrently only when *every* call in the batch
 * opts into `executionMode: 'parallel'`; a single `'sequential'` call makes the
 * whole batch sequential. That built-in barrier is why this module can stay a
 * small allowlist: unknown, mixed-action, remote, and process tools default to
 * sequential, and any mixed read/write batch falls back to source order.
 *
 * Keep this list conservative. A tool belongs here only when it cannot mutate
 * local state, spawn/stop work, change configuration, or answer a human.
 */
export const PARALLEL_READ_TOOLS = Object.freeze([
  'read_workspace_file',
  'read_image',
  'list_workspace_files',
  'read_workspace_code',
  'read_workspace_change',
  'list_workspace_changes',
  'search_workspace',
  'navigate_workspace_code',
  'analyze_workspace_call_chain',
  'preview_workspace_rename',
  'preview_workspace_edits',
  'inspect_workspace_project',
  'get_workspace_diagnostics',
  'read_context_evidence',
  'read_worker_result',
  'read_worker_evidence',
  'list_workers',
  'inspect_harness',
  'list_assist_evidence',
  'list_linked_goals',
  'read_skills_resource',
  'web_search',
  'fetch_web_content',
]);

const PARALLEL = new Set(PARALLEL_READ_TOOLS);

if (PARALLEL.size !== PARALLEL_READ_TOOLS.length) {
  throw new TypeError('PARALLEL_READ_TOOLS contains duplicate names');
}

export function isParallelReadTool(name) {
  return typeof name === 'string' && PARALLEL.has(name);
}

/**
 * Pi Agent's per-tool execution mode. Unknown names stay sequential so a new
 * tool is safe by default until someone reviews its side effects.
 */
export function executionModeFor(name) {
  return isParallelReadTool(name) ? 'parallel' : 'sequential';
}

/** Attach `executionMode` to a resolved tool array without mutating it. */
export function applyExecutionModes(tools) {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
  return tools.map(tool => {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new TypeError('Every tool requires a nonempty name');
    return { ...tool, executionMode: executionModeFor(tool.name) };
  });
}
