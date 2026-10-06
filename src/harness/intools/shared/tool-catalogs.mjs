/** Progressive-disclosure catalogs and short descriptions for Agent tools. */

const helpMeta = (summary = 'Progressive catalog. Omit topic for core; topic=<tier|action|all> for more.') =>
  ({ action: 'help', tier: 'core', summary, params: ['topic?'] });

export const TODO_CATALOG = {
  description: 'Shared session progress board. Core: write (replace your manual items) or list. plan-* items are host mirrors—ignored updates must not be retried. Call action=help for update/clear_completed details.',
  tiers: ['core', 'manage'],
  tierBlurbs: { core: 'write and list', manage: 'update one item or clear your completed notes' },
  docs: [
    helpMeta(),
    { action: 'write', tier: 'core', summary: 'Replace your manual todos (1–100 items).', params: ['items'] },
    { action: 'list', tier: 'core', summary: 'List session todos; optional status filter.', params: ['status?'] },
    { action: 'update', tier: 'manage', summary: 'Patch one of your todos by todo_id.', params: ['todo_id', 'content?', 'status?'] },
    { action: 'clear_completed', tier: 'manage', summary: 'Remove only your completed manual notes.', params: [] },
  ],
};

export const NOTE_CATALOG = {
  description: 'Shared session notebook for discoveries. Core: write / list. Use action=help for get, delete, promote, and asset/vulnerability shapes.',
  tiers: ['core', 'read', 'lifecycle'],
  tierBlurbs: {
    core: 'write notes/assets/vulnerability candidates; list with filters',
    read: 'get one note by id',
    lifecycle: 'delete (audit reason) or promote fact/intent to the Blackboard',
  },
  docs: [
    helpMeta(),
    { action: 'write', tier: 'core', summary: 'Store a note, asset, or vulnerability candidate.', params: ['note_type?', 'content?', 'asset?', 'vulnerability?', 'tool_call_ids?'] },
    { action: 'list', tier: 'core', summary: 'Page shared notes with filters.', params: ['note_type?', 'query?', 'limit?', 'offset?'] },
    { action: 'get', tier: 'read', summary: 'Fetch one note by note_id.', params: ['note_id'] },
    { action: 'delete', tier: 'lifecycle', summary: 'Delete an unpromoted note with audit reason.', params: ['note_id', 'delete_reason'] },
    { action: 'promote', tier: 'lifecycle', summary: 'Owner-only: promote closed fact/intent to Blackboard.', params: ['note_id', 'promotion_kind', 'statement?', 'evidence?'], notes: 'Vulnerability candidates are not Findings.' },
  ],
};

export const DELIVERY_CATALOG = {
  description: 'Delivery ledger ONLY for new-development projects. Core: status then initialize/accept. Standalone audit/deploy work should not use this ledger. Call action=help for block/findings/history.',
  tiers: ['core', 'control', 'findings'],
  tierBlurbs: {
    core: 'status, history, initialize, accept',
    control: 'block, invalidate',
    findings: 'finding, resolve, reopen',
  },
  docs: [
    helpMeta(),
    { action: 'status', tier: 'core', summary: 'Current revision, stages, findings, coverage hooks.', params: [] },
    { action: 'history', tier: 'core', summary: 'Paged ledger history.', params: ['offset?', 'limit?'] },
    { action: 'initialize', tier: 'core', summary: 'Start ledger; projectType must be new-development.', params: ['projectType', 'objective', 'artifact', 'expectedRevision'] },
    { action: 'accept', tier: 'core', summary: 'Accept a stage with evidence + expectedRevision.', params: ['stage', 'summary', 'evidence', 'expectedRevision'] },
    { action: 'block', tier: 'control', summary: 'Mark a stage blocked.', params: ['stage', 'summary', 'expectedRevision', 'owner?'] },
    { action: 'invalidate', tier: 'control', summary: 'Invalidate from a stage forward after artifact change.', params: ['stage', 'artifact', 'summary', 'expectedRevision'] },
    { action: 'finding', tier: 'findings', summary: 'Open a severity-tagged finding.', params: ['findingId', 'severity', 'summary', 'evidence', 'expectedRevision'] },
    { action: 'resolve', tier: 'findings', summary: 'Resolve with new retest evidence.', params: ['findingId', 'summary', 'evidence', 'expectedRevision'] },
    { action: 'reopen', tier: 'findings', summary: 'Reopen a finding.', params: ['findingId', 'summary', 'evidence', 'expectedRevision'] },
  ],
};

export const DOMAIN_CATALOG = {
  description: 'Security domain coverage authority. Core: bootstrap seeds, upsert related hosts, coverage. Call action=help for relate/mark_tested/skip/list.',
  tiers: ['core', 'relate', 'status'],
  tierBlurbs: {
    core: 'bootstrap, upsert, coverage',
    relate: 'relate discovered hosts',
    status: 'mark_tested, skip, list',
  },
  docs: [
    helpMeta(),
    { action: 'bootstrap', tier: 'core', summary: 'Seed root domains once.', params: ['seeds|hostname'] },
    { action: 'upsert', tier: 'core', summary: 'Add/update related hosts without re-authorization.', params: ['hostname|hostnames', 'discovery?', 'parent?', 'kind?'] },
    { action: 'coverage', tier: 'core', summary: 'Coverage summary for delivery acceptance.', params: [] },
    { action: 'relate', tier: 'relate', summary: 'Attach relation evidence between hosts.', params: ['hostname', 'relation_type', 'evidence_refs?'] },
    { action: 'list', tier: 'status', summary: 'Page inventory with query/status filters.', params: ['query?', 'test_status?', 'limit?', 'offset?'] },
    { action: 'mark_tested', tier: 'status', summary: 'Mark host tested with evidence.', params: ['hostname', 'evidence_refs'] },
    { action: 'skip', tier: 'status', summary: 'Skip host with required reason.', params: ['hostname', 'skip_reason', 'test_status?'] },
  ],
};

export const PYTHON_ENV_CATALOG = {
  description: 'Manage sandbox Python deps. Core: status / list. sync replaces the full package set in a NEW venv. Call action=help for check/reset and sync rules. reason is required on execute actions.',
  tiers: ['core', 'mutate'],
  tierBlurbs: { core: 'status, list, check', mutate: 'sync full set or reset to base interpreter' },
  docs: [
    helpMeta(),
    { action: 'status', tier: 'core', summary: 'Report active managed environment vs base interpreter.', params: ['reason'] },
    { action: 'list', tier: 'core', summary: 'List installed packages in the active env.', params: ['reason', 'timeout_seconds?'] },
    { action: 'check', tier: 'core', summary: 'pip check for conflicts.', params: ['reason', 'timeout_seconds?'] },
    { action: 'sync', tier: 'mutate', summary: 'Replace desired packages in a new venv (pip|uv).', params: ['reason', 'packages', 'manager?', 'timeout_seconds?'], notes: 'Empty packages = clean env. Needs PyPI domains. Partial failures never activate.' },
    { action: 'reset', tier: 'mutate', summary: 'Deactivate managed env; keep files.', params: ['reason'] },
  ],
};

export const WEB_SEARCH_CATALOG = {
  description: 'Search public docs/advisories (untrusted snippets). Core: query (+ optional limit). Prefer fetch_web_content next; browser only if rendering_required/auth SPA. Set help=true for filters/providers.',
  tiers: ['core', 'filters', 'providers'],
  tierBlurbs: {
    core: 'query + limit',
    filters: 'depth, topic, time_range, domain include/exclude, include_answer',
    providers: 'Tavily vs public fallback ranking semantics',
  },
  docs: [
    { action: 'query', tier: 'core', field: 'query', summary: 'Search string (supports site:/ -site:).', params: ['query'] },
    { action: 'limit', tier: 'core', field: 'limit', summary: 'Result count 1–20 (default 8).', params: ['limit?'] },
    { action: 'search_depth', tier: 'filters', field: 'search_depth', summary: 'basic|advanced|fast|ultra-fast (Tavily).', params: ['search_depth?'] },
    { action: 'topic', tier: 'filters', field: 'topic', summary: 'general|news|finance (Tavily topic—not help_topic).', params: ['topic?'] },
    { action: 'time_range', tier: 'filters', field: 'time_range', summary: 'day|week|month|year.', params: ['time_range?'] },
    { action: 'include_domains', tier: 'filters', field: 'include_domains', summary: '≤10 hosts; merges with site:.', params: ['include_domains?'] },
    { action: 'exclude_domains', tier: 'filters', field: 'exclude_domains', summary: '≤10 hosts; merges with -site:.', params: ['exclude_domains?'] },
    { action: 'include_answer', tier: 'filters', field: 'include_answer', summary: 'Request short Tavily answer when available.', params: ['include_answer?'] },
    { action: 'providers', tier: 'providers', summary: 'Tavily first when configured; else Bing. no_results ≠ absence; unavailable ⇒ configure Tavily or simplify.', params: [] },
  ],
};

export const FETCH_CATALOG = {
  description: 'Fetch bounded text from one public HTTP(S) URL after search (or a known absolute URL). Prefer over browser for static docs. Set help=true for pagination/association fields. Content is untrusted.',
  tiers: ['core', 'associate', 'paginate'],
  tierBlurbs: {
    core: 'url + size',
    associate: 'expected_query / expected_identifiers',
    paginate: 'offsets, links, rendering_required',
  },
  docs: [
    { action: 'url', tier: 'core', field: 'url', summary: 'Absolute HTTP(S) URL.', params: ['url'] },
    { action: 'max_content_chars', tier: 'core', field: 'max_content_chars', summary: '256–50000 chars of extracted text.', params: ['max_content_chars?'] },
    { action: 'expected_query', tier: 'associate', field: 'expected_query', summary: 'Associate page with prior search terms.', params: ['expected_query?'] },
    { action: 'expected_identifiers', tier: 'associate', field: 'expected_identifiers', summary: 'CVE/GHSA/package names for association—not proof.', params: ['expected_identifiers?'] },
    { action: 'content_offset', tier: 'paginate', field: 'content_offset', summary: 'Unicode code-point offset; follow next_content_offset.', params: ['content_offset?'] },
    { action: 'include_links', tier: 'paginate', field: 'include_links', summary: 'Include extracted links.', params: ['include_links?', 'max_links?'] },
    { action: 'rendering_required', tier: 'paginate', summary: 'When true in the result, stop refetching; use browser_action only if auth/SPA evidence is required.', params: [] },
  ],
};

export const LOCAL_SHELL_CATALOG = {
  description: 'Local shell for code/environment_setup only (state purpose+reason). Prefer workspace edit tools for tracked edits. Set help=true for session/retain/timeout. Not a remote/SSH bypass.',
  tiers: ['core', 'session', 'policy'],
  tierBlurbs: { core: 'command + purpose + reason', session: 'named shell, retain, cwd, timeout', policy: 'allowed purposes and anti-patterns' },
  docs: [
    { action: 'command', tier: 'core', field: 'command', summary: 'Non-interactive shell command.', params: ['command', 'purpose', 'reason'] },
    { action: 'purpose', tier: 'core', field: 'purpose', summary: 'code | environment_setup only.', params: ['purpose'] },
    { action: 'session', tier: 'session', field: 'session', summary: 'Reuse named shell (serializes; soft-resets after failure).', params: ['session?', 'reset_session?'] },
    { action: 'retain', tier: 'session', field: 'retain', summary: 'Keep long-lived servers after the tool returns.', params: ['retain?'] },
    { action: 'cwd', tier: 'session', field: 'cwd', summary: 'Working directory (not a sandbox root).', params: ['cwd?', 'timeout_seconds?'] },
    { action: 'policy', tier: 'policy', summary: 'No browsing/office/remote bypass; no shell-native background jobs—use retain=true.', params: [] },
  ],
};

export const SSH_CATALOG = {
  description: 'Run Linux commands on the host-selected SSH profile (streamed I/O). Default budget ~120s; raise timeout_seconds for long recon. Use retain=true for long-lived remote servers. Prefer vs local shell/browser. Set help=true for session/retain. Profile is not model-selectable.',
  tiers: ['core', 'session', 'scope'],
  tierBlurbs: { core: 'command + timeout', session: 'named bash session / retain', scope: 'remote vs challenge target' },
  docs: [
    { action: 'command', tier: 'core', field: 'command', summary: 'Remote Linux command/script. Default timeout ~120s (profile may cap lower).', params: ['command', 'timeout_seconds?'] },
    { action: 'session', tier: 'session', field: 'session', summary: 'Named bash shell retaining cwd/env (setsid+/proc).', params: ['session?', 'reset_session?'] },
    { action: 'retain', tier: 'session', field: 'retain', summary: 'Host-retain long-lived remote servers; skips the remote timeout wrapper.', params: ['retain?'] },
    { action: 'scope', tier: 'scope', summary: 'SSH host is the execution env, not automatically the challenge target—use addresses from evidence. Transfer artifacts with upload_sftp when needed.', params: [] },
  ],
};

export const SFTP_CATALOG = {
  description: 'Upload local file/dir via host SSH profile (bounded size/concurrency, dry_run supported). Set help=true for excludes/limits. Prefer release artifacts over full trees.',
  tiers: ['core', 'filters', 'limits'],
  tierBlurbs: { core: 'paths + dry_run', filters: 'exclude / skip_unchanged / mode', limits: 'size and concurrency caps' },
  docs: [
    { action: 'local_path', tier: 'core', field: 'local_path', summary: 'Absolute local file or directory.', params: ['local_path', 'remote_path'] },
    { action: 'dry_run', tier: 'core', field: 'dry_run', summary: 'Plan without SFTP mutation.', params: ['dry_run?'] },
    { action: 'exclude', tier: 'filters', field: 'exclude', summary: 'Basenames to skip while walking.', params: ['exclude?', 'exclude_defaults?'] },
    { action: 'skip_unchanged', tier: 'filters', field: 'skip_unchanged', summary: 'Skip when remote size matches (best-effort).', params: ['skip_unchanged?', 'file_mode?', 'timeout_seconds?'] },
    { action: 'limits', tier: 'limits', summary: 'Per-file/total/entry caps and stall abort; no auto-retry; directory upload not atomic.', params: [] },
  ],
};

export const DEPLOY_CATALOG = {
  description: 'Remote deploy: upload artifacts → ordered commands → required health_check_command. dry_run validates fully. Set help=true for verification rules. Healthy ≠ user-facing proof.',
  tiers: ['core', 'upload', 'verify'],
  tierBlurbs: { core: 'uploads, remote_cwd, commands, health check', upload: 'shared SFTP options', verify: 'independent endpoint verification' },
  docs: [
    { action: 'uploads', tier: 'core', field: 'uploads', summary: '1–100 upload specs (same fields as upload_sftp).', params: ['uploads', 'remote_cwd', 'commands', 'health_check_command'] },
    { action: 'dry_run', tier: 'core', field: 'dry_run', summary: 'Validate plan without mutation.', params: ['dry_run?', 'timeout_seconds?'] },
    { action: 'upload_options', tier: 'upload', summary: 'exclude/skip_unchanged applied before any remote mutation.', params: [] },
    { action: 'verify', tier: 'verify', summary: 'After healthy=0, independently verify the user-facing endpoint (and browser flow for web apps). Failed verification ⇒ unverified, never success.', params: [] },
  ],
};

export const RUN_PYTHON_CATALOG = {
  description: 'Run sandboxed CPython (code XOR script) with reason. The sandbox cwd is this workspace and can read it (secrets still denied). Writes go to UBOVM_PYTHON_OUTPUT unless workspace writes enabled. Set help=true for argv/cwd/timeout. Use manage_python_environment for deps.',
  tiers: ['core', 'io', 'limits'],
  tierBlurbs: { core: 'code|script + reason', io: 'arguments, cwd, output_directory', limits: 'sandbox/network/size caps' },
  docs: [
    { action: 'code', tier: 'core', field: 'code', summary: 'Inline Python source (≤256 KiB).', params: ['code|script', 'reason'] },
    { action: 'script', tier: 'core', field: 'script', summary: 'Existing .py inside workspace.', params: ['code|script', 'reason'] },
    { action: 'arguments', tier: 'io', field: 'arguments', summary: 'sys.argv[1:].', params: ['arguments?', 'cwd?', 'timeout_seconds?'] },
    { action: 'limits', tier: 'limits', summary: 'Host-configured network/interpreter; do not bypass via shell/skills. Workspace files are readable at their real paths; secrets remain denied.', params: [] },
  ],
};

export const SKILL_RESOURCE_CATALOG = {
  description: 'Read a loaded skill resource (relative path) or accessible local file. Text UTF-8 / binary base64. Set help=true for path rules.',
  tiers: ['core', 'rules'],
  tierBlurbs: { core: 'skill + path', rules: 'relative paths, size, missing files' },
  docs: [
    { action: 'path', tier: 'core', field: 'path', summary: 'Relative to skill when skill set; else local path.', params: ['path', 'skill?'] },
    { action: 'rules', tier: 'rules', summary: 'No absolute escape; missing ⇒ not_found; oversized rejected.', params: [] },
  ],
};

export const SKILL_SCRIPT_CATALOG = {
  description: 'Run interpreter-backed file under a loaded skill scripts/ directory (no shell parsing). Set help=true for interpreters/timeouts.',
  tiers: ['core', 'runtime'],
  tierBlurbs: { core: 'skill + script + arguments', runtime: 'interpreters and limits' },
  docs: [
    { action: 'script', tier: 'core', field: 'script', summary: 'Must start with scripts/.', params: ['skill', 'script', 'arguments?', 'timeout_seconds?'] },
    { action: 'runtime', tier: 'runtime', summary: 'Supports .py/.js/.mjs/.cjs/.sh/.ps1; args size-capped; env minimized.', params: [] },
  ],
};

export const WORKSPACE_LIST_CATALOG = {
  description: 'List one workspace directory (≤500 entries/page). Follow nextOffset. Missing paths return exists:false without a tool error. Read-only. Set help=true for paging fields.',
  tiers: ['core', 'page'],
  tierBlurbs: { core: 'root + path', page: 'offset/limit/nextOffset' },
  docs: [
    { action: 'path', tier: 'core', field: 'path', summary: 'Directory relative to selected root.', params: ['path?', 'root?'] },
    { action: 'offset', tier: 'page', field: 'offset', summary: 'Continue until nextOffset is null.', params: ['offset?', 'limit?'] },
  ],
};

export const WORKSPACE_READ_CATALOG = {
  description: 'Read UTF-8 workspace file by 1-based lines (≤400 lines / 128 KiB / first 4 MiB). Follow nextLine. Missing files return exists:false without a tool error. Set help=true for truncation flags.',
  tiers: ['core', 'page'],
  tierBlurbs: { core: 'path + root', page: 'startLine/lineCount/nextLine/truncation' },
  docs: [
    { action: 'path', tier: 'core', field: 'path', summary: 'File path inside root.', params: ['path', 'root?'] },
    { action: 'startLine', tier: 'page', field: 'startLine', summary: '1-based start; continue with nextLine.', params: ['startLine?', 'lineCount?'] },
    { action: 'truncation', tier: 'page', summary: 'fileTruncated/lineTruncated mean omitted content cannot always be recovered by advancing.', params: [] },
  ],
};

export const HARNESS_PROJECT_CATALOG = {
  description: 'Harness profiles: validate/list/define/import/export. Profiles only narrow tools/limits. Call action=help for each verb. Use returned IDs with spawn_worker profile.',
  tiers: ['core', 'mutate'],
  tierBlurbs: { core: 'validate, list, export', mutate: 'define, import' },
  docs: [
    helpMeta(),
    { action: 'validate', tier: 'core', summary: 'Preview tools/limits without saving.', params: ['profiles?'] },
    { action: 'list', tier: 'core', summary: 'List saved versions.', params: [] },
    { action: 'export', tier: 'core', summary: 'Export version-1 JSON project.', params: [] },
    { action: 'define', tier: 'mutate', summary: 'Save immutable profiles (expectedRevision when editing).', params: ['profiles', 'expectedRevision?'] },
    { action: 'import', tier: 'mutate', summary: 'Import version-1 JSON project.', params: ['project', 'expectedRevision?'] },
  ],
};

export const SPAWN_WORKER_CATALOG = {
  description: 'Default assist path: start a Swarm worker and return worker_id immediately. Optional writes lists the only files that worker may edit; parallel workers need disjoint paths. Optional priority 0–9 (higher starts first when slots are full) and preempt=true to interrupt lower-priority runners. Optional profile + depends_on (≤8). Use wait_workers for results and manage_workers to reorder later. Set help=true for queue/slot rules.',
  tiers: ['core', 'deps'],
  tierBlurbs: { core: 'task + profile + priority', deps: 'depends_on / preempt / concurrency' },
  docs: [
    { action: 'task', tier: 'core', field: 'task', summary: 'Worker assignment text.', params: ['task', 'profile?', 'modelProfile?', 'priority?'] },
    { action: 'depends_on', tier: 'deps', field: 'depends_on', summary: 'Queue until listed descendants succeed. Required to edit a file another worker already owns.', params: ['depends_on?'] },
    { action: 'writes', tier: 'deps', field: 'writes', summary: 'Exclusive workspace-relative files this worker may edit. Disjoint across concurrent workers.', params: ['writes?'] },
    { action: 'preempt', tier: 'deps', field: 'preempt', summary: 'If true, interrupt lower-priority running descendants so this ready worker can start.', params: ['preempt?', 'reason?'] },
  ],
};

export const WAIT_WORKERS_CATALOG = {
  description: 'Wait for descendant workers (all|any). timeout_ms:0 = snapshot. Timeouts include admission and workers[].blocked. Set help=true for modes and persistence caveats.',
  tiers: ['core', 'modes'],
  tierBlurbs: { core: 'worker_ids + timeout', modes: 'all vs any' },
  docs: [
    { action: 'worker_ids', tier: 'core', field: 'worker_ids', summary: 'Omit to wait on current descendants.', params: ['worker_ids?', 'timeout_ms?'] },
    { action: 'mode', tier: 'modes', field: 'mode', summary: 'all waits for every selected; any returns on first terminal record.', params: ['mode?'] },
  ],
};

export const CANCEL_WORKERS_CATALOG = {
  description: 'Interrupt specified descendants and their subtrees. Prefer this (or manage_workers action=interrupt) when work is obsolete or a higher-priority worker needs a slot. Does not undo prior effects. Set help=true for slot/cleanup notes.',
  tiers: ['core'],
  tierBlurbs: { core: 'worker_ids' },
  docs: [
    { action: 'worker_ids', tier: 'core', field: 'worker_ids', summary: 'Targets to cancel; queued work never launches.', params: ['worker_ids'] },
  ],
};

export const MANAGE_WORKERS_CATALOG = {
  description: 'Coordinator-owned Swarm control. Core: prioritize queued/running descendants (0–9). Call action=help for interrupt and preempt. Does not undo tool effects.',
  tiers: ['core', 'control'],
  tierBlurbs: { core: 'prioritize', control: 'interrupt / preempt' },
  docs: [
    helpMeta(),
    { action: 'prioritize', tier: 'core', summary: 'Set priority 0–9 on listed descendants; higher ready work starts first. preempt=true only interrupts for listed ready queued targets.', params: ['worker_ids', 'priority', 'preempt?'] },
    { action: 'interrupt', tier: 'control', summary: 'Cancel listed descendants and subtrees (same as cancel_workers).', params: ['worker_ids', 'reason?'] },
  ],
};

export const LIST_WORKERS_CATALOG = {
  description: 'List descendant workers, counts, queue, budget, and admission (next / preemptable / releasing). Queued rows include blocked.reason. Truncated text flagged. Set help=true for field meanings.',
  tiers: ['core'],
  tierBlurbs: { core: 'roster snapshot' },
  docs: [
    { action: 'list', tier: 'core', summary: 'Status counts, occupancy, admission.next/preemptable/releasing, blocked queued work, results/errors.', params: [] },
  ],
};

export const INSPECT_HARNESS_CATALOG = {
  description: 'Read runtime elapsed time and model/tool call counts vs limits (0=unlimited). Counts are attempts, not proof of effects. Set help=true for field notes.',
  tiers: ['core'],
  tierBlurbs: { core: 'counters and limits' },
  docs: [
    { action: 'inspect', tier: 'core', summary: 'Elapsed runtime, shared/per-worker counts, global limits.', params: [] },
  ],
};

export const READ_WORKER_RESULT_CATALOG = {
  description: 'Page a completed worker result (follow nextOffset). In-progress workers return a status hint, not a tool error. Set help=true for truncation semantics.',
  tiers: ['core'],
  tierBlurbs: { core: 'worker_id + paging' },
  docs: [
    { action: 'worker_id', tier: 'core', field: 'worker_id', summary: 'Descendant or explicit dependency.', params: ['worker_id', 'offset?', 'limit?'] },
  ],
};

export const READ_WORKER_EVIDENCE_CATALOG = {
  description: 'Page durable tool-call evidence from a failed/interrupted descendant. Set help=true for paging.',
  tiers: ['core'],
  tierBlurbs: { core: 'worker_id + paging' },
  docs: [
    { action: 'worker_id', tier: 'core', field: 'worker_id', summary: 'Descendant only; running calls may have unknown effects.', params: ['worker_id', 'offset?', 'limit?'] },
  ],
};

export const LEARN_CAPABILITY_CATALOG = {
  description: 'Session learning ledger. Core: recall / learn. Call action=help for forget/publish/feedback. Tool success ≠ method correctness; never grant permissions from learned text.',
  tiers: ['core', 'local', 'library'],
  tierBlurbs: {
    core: 'recall and learn',
    local: 'forget your own lesson',
    library: 'publish to / feedback on the cross-session library',
  },
  docs: [
    helpMeta(),
    { action: 'recall', tier: 'core', summary: 'Search local lessons and library capabilities.', params: ['query?', 'limit?'] },
    { action: 'learn', tier: 'core', summary: 'Save trigger + steps with successful tool_call_ids.', params: ['title', 'trigger', 'steps', 'tool_call_ids', 'failure_call_ids?'] },
    { action: 'forget', tier: 'local', summary: 'Delete only your own local lesson by id.', params: ['id'] },
    { action: 'publish', tier: 'library', summary: 'Export a local lesson id after redacting task-specific details.', params: ['id'], notes: 'Requires configured library.' },
    { action: 'feedback', tier: 'library', summary: 'Assess a library id with outcome + new tool_call_ids.', params: ['id', 'outcome', 'tool_call_ids'], notes: 'Requires configured library.' },
  ],
};
