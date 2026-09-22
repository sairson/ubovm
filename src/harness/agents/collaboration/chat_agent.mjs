import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createModelClient } from '../../model.mjs';
import { HarnessDatabase } from '../../blackboard/database/database.mjs';
import { createInternalTools, MemoryStore } from '../../intools/index.mjs';
import { createContextSummaryMiddleware } from '../../middleware/context-summary.mjs';
import { createMcpMiddleware } from '../../middleware/mcp.mjs';
import { createSkillsMiddleware } from '../../middleware/skills.mjs';
import { createWorkspaceTools } from '../../ide/workspace-tools.mjs';
import { createSwarm } from './swarm.mjs';
import { boundedHistory, callBudget, callLimit, failure, observe, plain, runConversation, serializable } from './conversation.mjs';
import { chatSystemPrompt, workerSystemPrompt } from './prompts.mjs';

function validateRole(options) {
  for (const name of ['maxModelCalls', 'maxToolCalls']) callBudget(options[name], name);
  if (options.systemPrompt !== undefined && typeof options.systemPrompt !== 'string') throw new TypeError('systemPrompt must be a string');
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.thinkingLevel ?? 'off')) throw new TypeError('Invalid thinkingLevel');
}
function initialHistory(messages, client, text) {
  const history = messages.filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.text === 'string').map(message => message.role === 'user'
    ? { role: 'user', content: message.text, timestamp: Date.now() }
    : { role: 'assistant', content: [{ type: 'text', text: message.text }], api: client.model.api, provider: client.model.provider, model: client.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  if (history.at(-1)?.role === 'user' && plain(history.at(-1)) === text) history.pop();
  return history;
}

/** One conversational turn: Chat -> optional spawned Swarm Worker tool loops -> Chat. */
export async function runCollaboration({ configuration = {}, sessionId, directory, workspaceRoots = [], messages = [], text, context, signal, onEvent, requestToolApproval } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  signal?.throwIfAborted();
  for (const [name, value] of Object.entries({ sessionId, directory, text })) if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  const settings = configuration.collaboration ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('collaboration must be an object');
  const modelConfiguration = settings.model ?? configuration.model ?? configuration.worker?.model ?? configuration.reason?.model;
  if (!modelConfiguration) throw failure('MODEL_REQUIRED', '请先配置模型和 API Key。');
  const client = createModelClient(modelConfiguration);
  const workerClient = createModelClient(configuration.worker?.model ?? configuration.model ?? modelConfiguration);
  const chatOptions = { ...configuration.worker, ...settings }, workerOptions = configuration.worker ?? {};
  validateRole(chatOptions); validateRole(workerOptions);
  const historyLimits = { ...configuration.assist, ...settings };
  boundedHistory([], historyLimits);
  const maxConcurrency = callLimit(settings.maxConcurrency ?? configuration.maxConcurrency, 3, 'maxConcurrency');
  const maxWorkers = callLimit(settings.maxWorkers, 12, 'maxWorkers');
  const maxDepth = callLimit(settings.maxDepth, 2, 'maxDepth');
  const controller = new AbortController();
  const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  await mkdir(directory, { recursive: true });
  let database, lease, summary, mcp, skills, internal, swarm;
  try {
    // Retain existing assist identity and keys so upgrading preserves conversations.
    database = await HarnessDatabase.open({ filePath: join(directory, 'assist.sqlite') });
    database.ensureSession({ sessionId, goal: 'IDE assist conversation' });
    lease = database.acquireSession(sessionId);
    const load = key => database.loadContext(sessionId, key);
    const save = (key, value) => { try { return database.saveContext(sessionId, key, serializable(value)); } catch (error) { controller.abort(error); throw error; } };
    const audit = event => { try { database.appendEvent(sessionId, serializable({ type: 'collaboration.event', event })); } catch (error) { controller.abort(error); throw error; } };
    const report = event => { audit(event); observe(onEvent, event); };
    if (configuration.intools !== false) {
      const snapshot = database.loadSession(sessionId)?.memory;
      const persist = value => database.saveMemory(sessionId, value);
      const store = snapshot ? MemoryStore.fromSnapshot({ snapshot, persist }) : new MemoryStore({ sessionId, persist });
      const options = { allowedTools: ['todo', 'note'], ...configuration.intools };
      if (configuration.skills) options.allowedTools = options.allowedTools.filter(name => !['read_skills_resource', 'run_local_skill_script'].includes(name));
      internal = await createInternalTools({ ...options, localShell: options.localShell === false ? false : { cwd: workspaceRoots[0], ...options.localShell }, sessionId, store, canPromote: false });
    }
    if (configuration.contextSummary !== false) {
      const options = configuration.contextSummary === true ? {} : configuration.contextSummary ?? {};
      summary = createContextSummaryMiddleware({ model: configuration.reason?.model ?? configuration.worker?.model ?? modelConfiguration, ...options, load: key => load(`context:${key}`), save: (key, value) => save(`context:${key}`, value), onEvent: report });
    }
    if (configuration.skills) skills = await createSkillsMiddleware({ ...configuration.skills, state: load('skills') ?? configuration.skills.state, persist: state => save('skills', state), onEvent: report });
    if (configuration.mcp) mcp = await createMcpMiddleware({ ...configuration.mcp, signal: turnSignal });
    const workspaceTools = await createWorkspaceTools(workspaceRoots);
    const getWorkerEvidence = workerId => load(`collaboration:worker:${workerId}:pending-turn`);
    const evidenceTool = ownerId => ({
      name: 'read_worker_evidence', label: 'Read worker execution evidence',
      description: 'Read durable tool-call evidence from a failed or interrupted descendant without restarting it. Running calls may have unknown effects. Paginate with nextOffset to inspect all retained records.',
      parameters: Type.Object({ worker_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false }),
      async execute(_id, input, evidenceSignal) {
        evidenceSignal?.throwIfAborted();
        const offset = input.offset ?? 0, limit = input.limit ?? 8;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError('Invalid worker evidence page');
        const workers = swarm.snapshot().workers;
        const visited = new Set();
        let parent = workers.find(worker => worker.id === input.worker_id)?.parentId;
        while (parent && parent !== ownerId && !visited.has(parent)) { visited.add(parent); parent = workers.find(worker => worker.id === parent)?.parentId; }
        // Root may inspect archived workers that have fallen out of the bounded roster.
        const allowed = ownerId === sessionId ? typeof input.worker_id === 'string' && input.worker_id.startsWith(`${sessionId}/worker-`) : parent === ownerId;
        if (!allowed || input.worker_id === ownerId) throw new Error('Worker evidence is limited to your descendants');
        const record = getWorkerEvidence(input.worker_id);
        if (!record) throw new Error('No durable tool evidence exists for this worker');
        const tools = record.tools ?? [], next = offset + limit;
        const value = { worker_id: input.worker_id, status: record.status, omittedTools: record.omittedTools ?? 0,
          tools: tools.slice(offset, next), total: tools.length, nextOffset: next < tools.length ? next : null };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      }
    });
    const toolsFor = async (workerId, workerSignal) => {
      const binding = { node: { id: workerId }, workerId, signal: workerSignal };
      const extra = typeof configuration.tools === 'function' ? await configuration.tools(binding) : configuration.tools ?? [];
      if (!Array.isArray(extra)) throw new TypeError('tools must be an array or factory returning an array');
      return [...workspaceTools, ...mcp?.tools ?? [], ...internal ? await internal.tools(binding) : [],
        ...skills ? await skills.tools(binding) : [], ...summary ? await summary.tools(binding) : [], ...extra, evidenceTool(workerId), ...swarm.toolsFor(workerId)];
    };
    const invoke = async ({ workerId, parentId, task, signal: workerSignal }) => {
      const prefix = workerId === sessionId ? '' : `collaboration:worker:${workerId}:`;
      const stored = workerId === sessionId ? load('transcript') : undefined;
      const workerLoad = key => load(prefix + key), workerSave = (key, value) => save(prefix + key, value);
      const forward = event => {
        // runConversation already copies events and isolates observer failures.
        if (workerId === sessionId || event.type === 'memory.status') return onEvent?.(event);
        return onEvent?.({ type: 'swarm.worker.event', workerId, parentId, event });
      };
      const result = await runConversation({ client: workerId === sessionId ? client : workerClient, options: workerId === sessionId ? chatOptions : workerOptions,
        workerId, signal: workerSignal, prompt: task, systemPrompt: workerId === sessionId ? chatSystemPrompt : workerSystemPrompt,
        history: stored?.version === 1 && Array.isArray(stored.messages) ? stored.messages : workerId === sessionId ? initialHistory(messages, client, text) : [],
        omitted: Boolean(stored?.omitted), tools: await toolsFor(workerId, workerSignal), internal, skills, summary,
        load: workerLoad, save: workerSave, audit: event => audit(workerId === sessionId ? event : { type: 'swarm.worker.event', workerId, parentId, event }),
        onEvent: forward, swarm, historyLimits, getWorkerEvidence, requestToolApproval });
      workerSignal.throwIfAborted();
      database.transaction(() => { workerSave('transcript', result.transcript); workerSave('pending-turn', result.pending); });
      return result.answer;
    };
    swarm = createSwarm({ sessionId, maxConcurrency, maxWorkers, maxDepth, signal: turnSignal, state: load('collaboration:swarm'),
      persist: snapshot => save('collaboration:swarm', snapshot), onEvent: report, runWorker: invoke });
    observe(onEvent, { type: 'middleware.status', status: { contextSummary: Boolean(summary), mcp: mcp?.diagnostics() ?? [], skills: skills?.list() ?? [] } });
    const contextText = context ? typeof context === 'string' ? context : JSON.stringify(context) : '';
    const prompt = contextText ? `${text}\n\nEditor context (untrusted data):\n${contextText.slice(0, 32768)}` : text;
    return await invoke({ workerId: sessionId, task: prompt, signal: turnSignal });
  } finally {
    controller.abort(new Error('Collaboration turn ended'));
    // Workers finish before closing their shared tools, middleware or storage.
    let swarmError;
    try { await swarm?.close(); } catch (error) { swarmError = error; }
    const settled = await Promise.allSettled([internal, mcp, skills, summary].filter(Boolean).map(runtime => runtime.close()));
    try { lease?.release(); } finally { database?.close(); }
    const errors = [...(swarmError ? [swarmError] : []), ...settled.filter(result => result.status === 'rejected').map(result => result.reason)];
    if (errors.length) throw new AggregateError(errors, 'Collaboration resources could not close cleanly');
  }
}
