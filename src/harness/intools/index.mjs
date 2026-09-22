import { createLocalShellTool } from './local-shell.mjs';
export { createLocalShellTool } from './local-shell.mjs';
import { createHash } from 'node:crypto';
import { MemoryStore } from './memory-store.mjs';
import { createTodoTool } from './todo/index.mjs';
import { createNoteTool } from './note-knowledge/index.mjs';
import { BrowserManager, createBrowserTools } from './browser/index.mjs';
import { createWebSearchTool } from './websearch/index.mjs';
import { createFetchTool } from './fetch/index.mjs';
import { SkillRegistry, createSkillResourceTool } from './skill-resource-read.mjs';
import { createSkillScriptTool } from './skill-script-command.mjs';
import { SSHCommandsPool } from './ssh-commands-pool-manager.mjs';
import { createSFTPUploadTool, createRemoteDeployTool } from './ssh-deployment.mjs';
export { createSFTPUploadTool, createRemoteDeployTool, uploadSFTP } from './ssh-deployment.mjs';
import { requireText, preview } from './common.mjs';

export { MemoryStore, createTodoTool, createNoteTool, BrowserManager, createBrowserTools, createWebSearchTool, createFetchTool, SkillRegistry, createSkillResourceTool, createSkillScriptTool, SSHCommandsPool };
export { SSHCommands, createSSHTool, buildRemoteCommand, shellQuote, knownHostsVerifier } from './ssh-commands-execute.mjs';
export { BROWSER_ACTIONS } from './browser/index.mjs';
export const INTERNAL_TOOL_NAMES = Object.freeze(['browser_action', 'browser_connection_status', 'fetch_web_content', 'note', 'todo', 'web_search', 'read_skills_resource', 'run_local_skill_script', 'run_linux_ssh_command', 'run_local_shell_command', 'upload_sftp', 'deploy_remote_service']);

/** Build one session's services and the reliable hooks consumed by createPiWorker. */
export async function createInternalTools({
  sessionId, blackboard, memoryFile, store,
  browser = {}, browserManager, ssh, sshPool,
  webSearch = {}, fetchContent = {}, localShell = {},
  skills = [], skillResource = {}, skillScript = {},
  target = '', allowedTools = INTERNAL_TOOL_NAMES, canPromote = true
} = {}) {
  sessionId = requireText(sessionId ?? blackboard?.snapshot().sessionId, 'sessionId');
  if (blackboard && blackboard.snapshot().sessionId !== sessionId) throw new Error('Blackboard belongs to another session');
  if (!Array.isArray(allowedTools) || allowedTools.some(name => !INTERNAL_TOOL_NAMES.includes(name))) throw new Error('allowedTools must contain known internal tool names');
  const allowed = new Set(allowedTools);
  if (store && memoryFile) throw new Error('Provide store or memoryFile, not both');
  store ??= memoryFile ? await MemoryStore.open({ filePath: memoryFile, sessionId }) : new MemoryStore({ sessionId });
  if (!(store instanceof MemoryStore) || store.sessionId !== sessionId) throw new Error('MemoryStore belongs to another session');
  const useBrowser = browser !== false && (allowed.has('browser_action') || allowed.has('browser_connection_status'));
  const ownedBrowser = !browserManager && useBrowser;
  const manager = useBrowser ? browserManager ?? new BrowserManager(browser) : undefined;
  const useSSH = ['run_linux_ssh_command', 'upload_sftp', 'deploy_remote_service'].some(name => allowed.has(name));
  const ownedSSH = !sshPool && useSSH && Boolean(ssh);
  const pool = useSSH ? sshPool ?? (ssh ? new SSHCommandsPool(Array.isArray(ssh.profiles) ? ssh : { profiles: [ssh] }) : undefined) : undefined;
  const useResource = skillResource !== false && allowed.has('read_skills_resource');
  const useScript = skillScript !== false && allowed.has('run_local_skill_script');
  const registry = useResource || useScript ? new SkillRegistry(skills) : undefined;
  const shared = [
    ...(localShell === false || !allowed.has('run_local_shell_command') ? [] : [createLocalShellTool(localShell)]),
    ...(webSearch === false || !allowed.has('web_search') ? [] : [createWebSearchTool(webSearch)]),
    ...(fetchContent === false || !allowed.has('fetch_web_content') ? [] : [createFetchTool(fetchContent)]),
    ...(useResource ? [createSkillResourceTool({ ...skillResource, registry })] : []),
    ...(useScript ? [createSkillScriptTool({ ...skillScript, registry })] : []),
    ...(pool?.get() ? [pool.require().tool(), createSFTPUploadTool(pool.require()), createRemoteDeployTool(pool.require())] : [])
  ].filter(tool => allowed.has(tool.name));
  const workers = new Map();
  const lifetime = new AbortController();
  const activeCalls = new Set();
  let closed = false;
  let closing;
  function assertOpen() { if (closed) throw new Error('Internal tools runtime is closed'); }
  function checkLifetime(signal) { signal?.throwIfAborted(); assertOpen(); }
  // Include factories and host hooks: recovering a note can write both the
  // board and memory after its caller stops awaiting an aborted Worker.
  async function managedOperation(signal, invoke) {
    assertOpen();
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const operation = Promise.resolve().then(() => {
      checkLifetime(combined);
      return invoke(combined);
    }).then(result => { checkLifetime(combined); return result; });
    activeCalls.add(operation);
    try { return await operation; } finally { activeCalls.delete(operation); }
  }
  function managed(tool) {
    return { ...tool, execute(id, args, signal, onUpdate) {
      return managedOperation(signal, combined => tool.execute(id, args, combined, onUpdate));
    } };
  }
  function evidenceProvider({ workerId, toolCallId, sessionId: requestedSession }) {
    if (requestedSession !== sessionId) throw new Error('Evidence belongs to another session');
    return store.snapshot().toolEvidence?.find(entry => entry.workerId === workerId && entry.toolCallId === toolCallId);
  }
  async function forWorker(workerId, { rootWorkerId = workerId, signal } = {}) {
    checkLifetime(signal); workerId = requireText(workerId, 'workerId');
    // Register every request to detect a conflicting parent even after caching.
    await store.registerWorker(workerId, { rootWorkerId });
    checkLifetime(signal);
    if (!workers.has(workerId)) {
      const todo = createTodoTool({ store, sessionId, workerId });
      const note = createNoteTool({ store, sessionId, workerId, blackboard, canPromote, evidenceProvider });
      workers.set(workerId, { todo, note, tools: [
        ...shared, todo, note,
        ...(manager ? createBrowserTools({ manager, sessionId, workerId, target }) : [])
      ].filter(tool => allowed.has(tool.name)).map(managed) });
    }
    const worker = workers.get(workerId);
    if (blackboard) await worker.note.recoverPromotions();
    checkLifetime(signal);
    return worker;
  }
  const operations = {
    tools: async ({ node, signal }) => (await forWorker(node.id, { signal })).tools,
    async contextProvider({ node, signal }) {
      checkLifetime(signal); await store.flush();
      checkLifetime(signal);
      const worker = await forWorker(node.id, { signal });
      return worker.todo.summary(node.id);
    },
    async onProgress({ node, phase, plan, completed, signal }) {
      const worker = await forWorker(node.id, { signal });
      checkLifetime(signal);
      const items = completed.map(({ step }, index) => ({ id: String(index + 1), content: step.description, status: 'completed' }));
      items.push(...plan.map((step, index) => ({ id: String(completed.length + index + 1), content: step.description, status: phase === 'execute' && index === 0 ? 'in_progress' : 'pending' })));
      await worker.todo.syncPlan(node.id, items);
    },
    async onToolResult({ node, attempt, entry, signal }) {
      checkLifetime(signal);
      if (entry.status !== 'completed') throw new Error('Only completed tool calls can enter the evidence store');
      const digest = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      const record = {
        sessionId, workerId: node.id, attemptId: attempt.id, toolCallId: entry.toolCallId, toolName: entry.toolName,
        status: 'completed', isError: Boolean(entry.isError), digest,
        observations: preview((entry.result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n'), 16384),
        imageCount: (entry.result?.content ?? []).filter(item => item.type === 'image').length
      };
      await store.commit(state => {
        checkLifetime(signal);
        state.toolEvidence ??= [];
        const existing = state.toolEvidence.find(item => item.workerId === node.id && item.toolCallId === entry.toolCallId);
        if (existing) {
          if (existing.digest !== digest) throw new Error(`Ambiguous reused tool call ID: ${entry.toolCallId}`);
          return;
        }
        state.toolEvidence.push(record);
      });
    }
  };
  const hooks = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name,
    event => managedOperation(event?.signal, signal => operation({ ...event, signal }))
  ]));
  return {
    sessionId, store, browserManager: manager, sshPool: pool, ...hooks,
    /** Spread into createPiWorker; tool execution, progress and evidence stay connected. */
    workerOptions: hooks,
    forWorker: (workerId, options) => managedOperation(options?.signal, async signal => (await forWorker(workerId, { ...options, signal })).tools),
    close() {
      if (closing) return closing;
      closed = true;
      // Install the shared close promise before abort listeners can reenter.
      closing = Promise.resolve().then(async () => {
        lifetime.abort(new Error('Internal tools runtime is closed'));
        // A started cross-file promotion must settle before releasing session
        // ownership. Interrupting its await would leave late persistent writes.
        await Promise.allSettled([...activeCalls]);
        const settled = await Promise.allSettled([store.flush(), ownedBrowser ? manager.close() : undefined, ownedSSH ? pool.close() : undefined]);
        const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Failed to close internal tool services');
      });
      return closing;
    }
  };
}
