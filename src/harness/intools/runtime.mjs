import { createHash } from 'node:crypto';
import { learningFingerprint, learningRequestFingerprint } from '../learning/fingerprint.mjs';
import { classifyOutcome } from '../learning/attribution.mjs';
import { evaluateLearningGate, gateRecords } from '../learning/gate.mjs';
import { createKnowledge } from '../learning/index.mjs';
import { LearningLibrary } from '../learning/library.mjs';
import { createBackgroundLearning } from '../learning/runner.mjs';
import { MemoryStore } from './shared/store/memory-store.mjs';
import { requireText, preview } from './shared/common.mjs';
import { controlledCommand } from './shared/process/command-control.mjs';
import { createLocalShellTool } from './terminals/local-shell/index.mjs';
import { createPythonTool } from './terminals/python/index.mjs';
import { createPythonEnvironmentTool } from './terminals/python/environment.mjs';
import { createTodoTool } from './todo/index.mjs';
import { createDeliveryTool } from './delivery/index.mjs';
import { createNoteTool } from './note/index.mjs';
import { createDomainInventoryTool } from './domain-inventory/index.mjs';
import { BrowserManager, createBrowserTools } from './network/browser/index.mjs';
import { createWebSearchTool } from './network/websearch/index.mjs';
import { createFetchTool } from './network/fetch/index.mjs';
import { SkillRegistry, createSkillResourceTool } from './skills/resources.mjs';
import { createSkillScriptTool } from './skills/scripts.mjs';
import { SSHCommandsPool } from './terminals/ssh-terminal/pool.mjs';
import { createSFTPUploadTool, createRemoteDeployTool } from './terminals/ssh-terminal/deployment.mjs';

export const INTERNAL_TOOL_NAMES = Object.freeze(['delivery_workflow', 'browser_action', 'browser_connection_status', 'fetch_web_content', 'note', 'todo', 'domain_inventory', 'web_search', 'read_skills_resource', 'run_local_skill_script', 'run_linux_ssh_command', 'run_local_shell_command', 'run_python', 'manage_python_environment', 'upload_sftp', 'deploy_remote_service', 'learn_capability']);

/** Build one session's services and the reliable hooks consumed by createPiWorker. */
export async function createInternalTools({
  sessionId, blackboard, memoryFile, store, knowledge = {}, learningSource,
  browser = {}, browserManager, ssh, sshPool,
  webSearch = {}, fetchContent = {}, localShell = {}, python = {},
  skills = [], skillResource = {}, skillScript = {},
  target = '', allowedTools = INTERNAL_TOOL_NAMES.filter(name => name !== 'learn_capability'), canPromote = true, onCommand
} = {}) {
  sessionId = requireText(sessionId ?? blackboard?.snapshot().sessionId, 'sessionId');
  if (blackboard && blackboard.snapshot().sessionId !== sessionId) throw new Error('Blackboard belongs to another session');
  if (!Array.isArray(allowedTools) || allowedTools.some(name => !INTERNAL_TOOL_NAMES.includes(name))) throw new Error('allowedTools must contain known internal tool names');
  const allowed = new Set(allowedTools);
  if (store && memoryFile) throw new Error('Provide store or memoryFile, not both');
  store ??= memoryFile ? await MemoryStore.open({ filePath: memoryFile, sessionId }) : new MemoryStore({ sessionId });
  if (!(store instanceof MemoryStore) || store.sessionId !== sessionId) throw new Error('MemoryStore belongs to another session');
  let learning = knowledge === false ? undefined : createKnowledge({ ...knowledge, store, sessionId });
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
    ...(python === false || !allowed.has('run_python') ? [] : [createPythonTool(python)]),
    ...(python === false || !allowed.has('manage_python_environment') ? [] : [createPythonEnvironmentTool(python)]),
    ...(webSearch === false || !allowed.has('web_search') ? [] : [createWebSearchTool(webSearch)]),
    ...(fetchContent === false || !allowed.has('fetch_web_content') ? [] : [createFetchTool(fetchContent)]),
    ...(useResource ? [createSkillResourceTool({ ...skillResource, registry })] : []),
    ...(useScript ? [createSkillScriptTool({ ...skillScript, registry })] : []),
    ...(pool?.get() ? [createSFTPUploadTool(pool.require()), createRemoteDeployTool(pool.require())] : [])
  ].filter(tool => allowed.has(tool.name));
  let library;
  const reportLearningFailure = () => {
    try { Promise.resolve(knowledge?.onEvent?.({ type: 'knowledge.failed', message: 'Learning storage unavailable; task execution continues.' })).catch(() => {}); } catch {}
  };
  if (knowledge && knowledge.libraryFile) {
    try { library = await LearningLibrary.open({ filePath: knowledge.libraryFile, maxLessons: knowledge.maxSharedLessons }); }
    catch { reportLearningFailure(); }
  }
  if (library) {
    if (learningSource && learningSource !== ':memory:') {
      try { library.registerSource({ filePath: learningSource, sessionId, reflection: knowledge.reflection === true || Boolean(knowledge.reflect), enabled: knowledge.background !== false }); }
      catch { reportLearningFailure(); }
    }
    try { learning = createKnowledge({ ...knowledge, store, sessionId, library }); }
    catch (error) { library.close(); throw error; }
  }
  let background;
  try { background = learning && knowledge.background !== false ? createBackgroundLearning({ ...knowledge, knowledge: learning, store }) : undefined; }
  catch (error) { library?.close(); throw error; }
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
  function managed(tool, workerId) {
    return { ...tool, execute(id, args, signal, onUpdate) {
      return managedOperation(signal, combined => {
        const decision = learning && evaluateLearningGate(gateRecords(store, workerId), {
          workerId, toolName: tool.name, args, shared: library?.toolConclusions?.()
        });
        if (decision) throw Object.assign(new Error(decision.message), { code: decision.code, attribution: decision.attribution });
        return tool.execute(id, args, combined, onUpdate);
      });
    } };
  }
  function evidenceProvider({ workerId, toolCallId, sessionId: requestedSession }) {
    if (requestedSession !== sessionId) throw new Error('Evidence belongs to another session');
    return store.toolEvidence(workerId, toolCallId);
  }
  async function forWorker(workerId, { rootWorkerId = workerId, signal } = {}) {
    checkLifetime(signal); workerId = requireText(workerId, 'workerId');
    // Register every request to detect a conflicting parent even after caching.
    await store.registerWorker(workerId, { rootWorkerId });
    checkLifetime(signal);
    if (!workers.has(workerId)) {
      const todo = createTodoTool({ store, sessionId, workerId });
      const delivery = createDeliveryTool({ store, sessionId, workerId });
      const note = createNoteTool({ store, sessionId, workerId, blackboard, canPromote, evidenceProvider });
      const domains = createDomainInventoryTool({ store, sessionId, workerId });
      const shells = [
        ...(localShell !== false && allowed.has('run_local_shell_command') ? [createLocalShellTool(localShell)] : []),
        ...(pool?.get() && allowed.has('run_linux_ssh_command') ? [pool.require().tool()] : [])
      ];
      workers.set(workerId, { todo, note, delivery, domains, tools: [
        ...shared, ...shells, todo, note, delivery, domains, ...(learning ? [learning.tool(workerId)] : []),
        ...(manager ? createBrowserTools({ manager, sessionId, workerId, target }) : [])
      ].filter(tool => allowed.has(tool.name)).map(tool => managed(controlledCommand(tool, workerId, onCommand), workerId)) });
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
      let learned;
      try { learned = await learning?.context({ query: (node.intent?.description ?? '').slice(0, 4096), signal }); }
      catch { checkLifetime(signal); reportLearningFailure(); }
      return [worker.todo.summary(node.id), allowed.has('delivery_workflow') ? worker.delivery.summary() : '', allowed.has('domain_inventory') ? worker.domains.summary() : '', learned].filter(Boolean).join('\n\n');
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
      const learningClass = entry.probe === true ? 'probe' : classifyOutcome(entry);
      const record = {
        sessionId, workerId: node.id, attemptId: attempt.id, toolCallId: entry.toolCallId, toolName: entry.toolName,
        status: 'completed', isError: Boolean(entry.isError), digest, learningFingerprint: learningFingerprint(entry),
        learningRequestFingerprint: learningRequestFingerprint(entry),
        ...(entry.probe === true ? { probe: true } : {}),
        ...(learningClass ? { learningClass } : {}),
        observations: preview((entry.result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n'), 16384),
        learningInputKeys: Object.keys(entry.args ?? {}).filter(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u.test(key)).sort().slice(0, 24),
        imageCount: (entry.result?.content ?? []).filter(item => item.type === 'image').length
      };
      await store.commit(state => {
        checkLifetime(signal);
        state.toolEvidence ??= [];
        const existing = state.toolEvidence.find(item => item.workerId === node.id && item.toolCallId === entry.toolCallId);
        if (existing) {
          if (existing.digest !== digest) throw new Error(`Ambiguous reused tool call ID: ${entry.toolCallId}`);
          background?.enqueue(state);
          return;
        }
        state.toolEvidence.push(record);
        background?.enqueue(state);
      });
      background?.observe(record);
    }
  };
  const hooks = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name,
    event => managedOperation(event?.signal, signal => operation({ ...event, signal }))
  ]));
  return {
    sessionId, store, browserManager: manager, sshPool: pool, library, ...hooks,
    learningStatus: () => background?.status(),
    flushLearning: async () => { await background?.flush(); },
    /** Spread into createPiWorker; tool execution, progress and evidence stay connected. */
    workerOptions: hooks,
    forWorker: (workerId, options) => managedOperation(options?.signal, async signal => (await forWorker(workerId, { ...options, signal })).tools),
    close() {
      if (closing) return closing;
      closed = true;
      // Install the shared close promise before abort listeners can reenter.
      closing = Promise.resolve().then(async () => {
        // Close shell tools first so retain wrappers can detach residents from
        // lifetime.abort before the shared runtime signal fires.
        const toolClosed = await Promise.allSettled([...workers.values()]
          .flatMap(worker => worker.tools.filter(tool => tool.close).map(tool => () => tool.close()))
          .map(dispose => Promise.resolve().then(dispose)));
        lifetime.abort(new Error('Internal tools runtime is closed'));
        // A started cross-file promotion must settle before releasing session
        // ownership. Interrupting its await would leave late persistent writes.
        await Promise.allSettled([...activeCalls]);
        const learningClosed = await Promise.allSettled([Promise.resolve().then(() => background?.close())]);
        // Retained SSH tools still hold pool refs; pool.close soft-returns until they finish.
        const settled = await Promise.allSettled([
          () => store.flush(), () => ownedBrowser ? manager.close() : undefined,
          () => ownedSSH ? pool.close() : undefined
        ].map(dispose => Promise.resolve().then(dispose)));
        const failures = [...toolClosed, ...learningClosed, ...settled].filter(result => result.status === 'rejected').map(result => result.reason);
        try { await library?.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Failed to close internal tool services');
      });
      return closing;
    }
  };
}
