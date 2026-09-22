'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { access, mkdir, open, readFile, rename, unlink, rm } = require('node:fs/promises');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { cleanTimelineParts, formatToolValue, redactDisplayObject } = require('./sessions.cjs');

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const { normalize: normalizeError, text: errorText } = require('../webview/errors.js');
const errorData = error => ({ ...normalizeError(error), name: error?.name ?? 'Error', message: errorText(error) });
const idle = () => ({ status: 'idle', busy: false, phase: null, workers: [], activities: [], parts: [], streamText: '', canResume: false, error: null });
const contentText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const REQUEST_LIMIT = 1 << 20;
async function atomicRecord(destination, record) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    await mkdir(dirname(destination), { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, destination);
  } finally { await handle?.close(); try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function goalText(goal) {
  if (typeof goal?.objective !== 'string' || !goal.objective.trim()) throw failure('GOAL_REQUIRED', '请先填写目标。');
  const criteria = (goal.criteria ?? []).map(item => typeof item === 'string' ? item : item.text).filter(item => typeof item === 'string' && item.trim());
  return `${goal.objective.trim()}${criteria.length ? '\n\n验收标准：\n' + criteria.map((item, index) => `${index + 1}. ${item.trim()}`).join('\n') : ''}`;
}
function projectBoard(snapshot) {
  return { sessionId: snapshot.sessionId, goal: snapshot.goal, revision: snapshot.revision, rootId: snapshot.rootId, nodes: snapshot.nodes.map(node => ({
    id: node.id, kind: node.kind, parentIds: node.parentIds, childIds: node.childIds, resultId: node.resultId, producerId: node.producerId,
    intent: node.intent, fact: node.fact ? { ...node.fact, content: node.fact.content.slice(0, 12000) } : null,
    attempts: node.attempts.map(attempt => ({ id: attempt.id, status: attempt.status, startedAt: attempt.startedAt, completedAt: attempt.completedAt, error: attempt.error }))
  })) };
}

/** VS Code-independent adapter. Models and credentials remain in the extension host. */
function createHarnessService({ sdkPath, storageDirectory, workspaceRoots = [], additionalTools = () => [], requestToolApproval, readConfiguration, onChange, onMessage } = {}) {
  if (typeof sdkPath !== 'string' || typeof storageDirectory !== 'string' || typeof readConfiguration !== 'function') throw new TypeError('sdkPath, storageDirectory and readConfiguration are required');
  const sessions = new Map(), workspaceScopes = new Map(), root = resolve(storageDirectory);
  let modules, closed = false, closing;
  const load = () => modules ??= Promise.all([
    import(pathToFileURL(resolve(sdkPath)).href),
    import(pathToFileURL(join(dirname(resolve(sdkPath)), 'agents', 'collaboration', 'index.mjs')).href),
    import(pathToFileURL(join(dirname(resolve(sdkPath)), 'ide', 'workspace-tools.mjs')).href)
  ]).then(([sdk, collaboration, workspace]) => ({ ...sdk, ...collaboration, ...workspace })).catch(error => { modules = undefined; throw error; });
  const roots = id => typeof workspaceRoots === 'function' ? workspaceRoots(id) : workspaceRoots;
  const assertOpen = () => { if (closed) throw failure('SERVICE_CLOSED', 'IDE agent service is closed'); };
  function notify(entry, immediate = false) {
    if (closed) return;
    if (immediate) { clearTimeout(entry.notification); entry.notification = undefined; try { onChange?.(entry.id); } catch {} return; }
    if (!entry.notification) entry.notification = setTimeout(() => { entry.notification = undefined; if (!closed) try { onChange?.(entry.id); } catch {} }, 40);
  }
  function descriptor(input) {
    if (typeof input?.conversationId !== 'string' || !input.conversationId.trim()) throw new TypeError('conversationId is required');
    if (!['assist', 'goal'].includes(input.mode)) throw new TypeError('mode must be assist or goal');
    const objective = input.mode === 'goal' && input.goal?.objective?.trim() ? goalText(input.goal) : undefined;
    const initialFacts = typeof input.goal?.initialFacts === 'string' ? input.goal.initialFacts.trim() : '';
    const key = input.mode === 'goal' ? objective ? `goal-${hash(initialFacts ? JSON.stringify([objective, initialFacts]) : objective)}` : 'goal-draft' : 'assist';
    return { id: input.conversationId, mode: input.mode, objective, key, directory: join(root, hash(input.conversationId), key), sessionId: `ide_${hash(input.conversationId + ':' + key)}`, goal: copy(input.goal) };
  }
  async function entryFor(input) {
    const info = descriptor(input);
    // Bind the original execution directory once, preserving legacy records.
    // Other workspaces get separate checkpoints under the same conversation.
    const workspaceKey = hash(JSON.stringify(roots(info.id).map(folder => {
      const absolute = resolve(folder);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    })));
    const scopeFile = info.directory + '-workspace.json';
    if (!workspaceScopes.has(scopeFile)) {
      const scope = (async () => {
        try {
          const record = JSON.parse(await readFile(scopeFile, 'utf8'));
          if (record.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(record.workspaceKey)) throw failure('INVALID_WORKSPACE_SCOPE', '工作空间执行记录无效，请检查会话存储。');
          return record.workspaceKey;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await atomicRecord(scopeFile, { schemaVersion: 1, workspaceKey });
          return workspaceKey;
        }
      })();
      workspaceScopes.set(scopeFile, scope);
      void scope.catch(() => { workspaceScopes.delete(scopeFile); });
    }
    if (await workspaceScopes.get(scopeFile) !== workspaceKey) info.directory += '-workspace-' + workspaceKey;
    let entry = sessions.get(info.id);
    if (entry?.busy || entry?.active) {
      if (entry.key !== info.key || entry.mode !== info.mode || entry.directory !== info.directory) throw failure('SESSION_BUSY', '运行中不能更改目标、工作空间或对话模式。');
      return entry;
    }
    if (entry && (entry.key !== info.key || entry.mode !== info.mode || entry.directory !== info.directory)) { await entry.session?.close(); await entry.timelineWrite; await saveWorkers(entry); clearTimeout(entry.notification); sessions.delete(info.id); entry = undefined; }
    if (!entry) { entry = { ...info, ...idle(), restored: false }; sessions.set(info.id, entry); }
    else entry.goal = info.goal;
    return entry;
  }
  function updateBoard(entry, snapshot) {
    entry.blackboard = projectBoard(snapshot);
    const old = new Map(entry.workers.map(worker => [worker.id, worker]));
    entry.workers = snapshot.nodes.filter(node => node.kind === 'intent').map(node => ({ id: node.id, description: node.intent.description, status: node.intent.status, phase: old.get(node.id)?.phase ?? null, attemptId: node.attempts.at(-1)?.id ?? null }));
  }
  function activity(entry, label, status, key) {
    const existing = key && entry.activities.find(item => item.key === key);
    if (existing) Object.assign(existing, { label, status, timestamp: Date.now() });
    else entry.activities.push({ label, status, timestamp: Date.now(), ...(key ? { key } : {}) });
    entry.activities = entry.activities.slice(-30);
  }
  function workerEntry(entry, id, metadata = {}) {
    const views = entry.workerViews ??= new Map();
    let view = views.get(id);
    if (!view) {
      view = { ...idle(), mode: 'assist', timelineRun: `${entry.timelineRun ?? 'restored'}:${hash(id)}`, textMessageSequence: 0,
        metadata: { id, description: 'Worker', status: 'running' } };
      views.set(id, view);
    }
    Object.assign(view.metadata, metadata);
    return view;
  }
  function projectWorkers(entry) {
    const metadata = new Map((entry.workers ?? []).map(worker => [worker.id, worker]));
    for (const [id, view] of entry.workerViews ?? []) {
      flushAssistantText(view);
      metadata.set(id, { ...view.metadata, ...metadata.get(id), parts: view.parts, streamText: view.streamText });
    }
    return [...metadata.values()];
  }
  function saveWorkers(entry) {
    clearTimeout(entry.workerSaveTimer); entry.workerSaveTimer = undefined;
    if (!entry.workerViews?.size) return entry.workerWrite ?? Promise.resolve();
    const workers = redactDisplayObject(projectWorkers(entry)).slice(-100);
    const record = { schemaVersion: 1, sessionId: entry.sessionId, workers, omittedWorkers: Math.max(0, entry.workerViews.size - workers.length) };
    while (Buffer.byteLength(JSON.stringify(record)) > 8 << 20 && workers.length > 1) { workers.shift(); record.omittedWorkers++; }
    const operation = (entry.workerWrite ?? Promise.resolve()).catch(() => {}).then(() => atomicRecord(join(entry.directory, 'worker-views.json'), record));
    entry.workerWrite = operation; return operation;
  }
  function queueWorkers(entry) {
    if (!entry.workerSaveTimer) entry.workerSaveTimer = setTimeout(() => { void saveWorkers(entry).catch(error => { entry.workerViewError = errorData(error); notify(entry); }); }, 750);
  }
  async function restoreWorkers(entry) {
    let handle;
    try {
      handle = await open(join(entry.directory, 'worker-views.json'), 'r');
      if ((await handle.stat()).size > 8 << 20) throw new Error('Worker views exceed the storage limit');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record.schemaVersion !== 1 || record.sessionId !== entry.sessionId || !Array.isArray(record.workers)) throw new Error('Invalid worker views identity');
      entry.workers = record.workers.slice(-100).filter(worker => typeof worker?.id === 'string' && typeof worker.description === 'string').map(worker => {
        const { parts, streamText, ...metadata } = worker;
        if (['queued', 'running', 'waiting', 'pending'].includes(metadata.status)) metadata.status = 'interrupted';
        const view = workerEntry(entry, worker.id, metadata);
        view.parts = cleanTimelineParts(parts);
        for (const part of view.parts) if (part.type === 'summary' && part.status === 'running') part.status = 'interrupted';
        finishParts(view);
        const last = view.parts.findLast(part => part.type === 'text');
        view.lastAssistantText = last?.text; view.textPartIds = last ? [last.id] : [];
        return metadata;
      });
    } catch (error) { if (error.code !== 'ENOENT') entry.workerViewError = errorData(error); }
    finally { await handle?.close(); }
  }
  function workerPiEvent(entry, id, event, metadata = {}, stream = true) {
    const view = workerEntry(entry, id, metadata);
    piEvent(view, event, id, stream, { workerId: id, timestamp: metadata.timestamp });
    queueWorkers(entry);
  }
  function summaryEvent(entry, event) {
    if (!event?.type?.startsWith('context.')) return false;
    if (!['context.summary_start', 'context.summary_end'].includes(event.type)) return true;
    if (typeof event.operationId !== 'string' || !event.operationId || typeof event.scope !== 'string') return true;
    const workerId = event.scope.startsWith('worker:') ? event.scope.slice(7) : null;
    const child = workerId && workerId !== entry.sessionId;
    const target = child ? workerEntry(entry, workerId) : entry;
    flushAssistantText(target);
    const id = `summary:${hash(event.operationId)}`;
    let part = target.parts.find(part => part.id === id);
    if (!part) {
      part = { id, type: 'summary', text: '', status: 'running', startedAt: Number.isFinite(event.startedAt) ? event.startedAt : 0,
        source: child ? 'worker' : event.scope === 'reason' ? 'reason' : 'assistant', ...(child ? { workerId } : {}) };
      target.parts.push(part);
    }
    if (event.type === 'context.summary_end' && ['completed', 'failed', 'interrupted'].includes(event.status)) {
      Object.assign(part, { status: event.status, text: typeof event.text === 'string' ? event.text : '', endedAt: event.endedAt,
        fallback: event.fallback === true, truncated: event.truncated === true, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens });
    }
    target.parts = cleanTimelineParts(target.parts);
    if (child) queueWorkers(entry);
    else if (entry.mode === 'goal') void saveTimeline(entry, 'running').catch(() => {});
    return true;
  }
  function flushAssistantText(entry) {
    const pending = entry.pendingAssistantText;
    if (!pending) return;
    entry.pendingAssistantText = undefined;
    applyPiEvent(entry, pending.event, pending.identity, pending.stream, pending.metadata);
  }
  function piEvent(entry, event, identity = '', stream = true, metadata = {}) {
    // Assistant updates contain the whole text so far. Projecting and redacting
    // every token repeatedly scans all earlier parts, even with no visible UI.
    // Retain one latest update until publication or an ordering boundary.
    metadata = { ...metadata, timestamp: Number.isFinite(metadata.timestamp) ? metadata.timestamp : Date.now() };
    const assistant = event.message?.role === 'assistant';
    const delta = event.assistantMessageEvent;
    if (event.type === 'message_update' && assistant && !['thinking_start', 'thinking_end', 'text_start', 'toolcall_start'].includes(delta?.type)) {
      // A worker's snapshot must never overwrite a pending root snapshot.
      // Changing identities is also an ordering boundary in the timeline.
      if (entry.pendingAssistantText && entry.pendingAssistantText.identity !== identity) flushAssistantText(entry);
      entry.pendingAssistantText = { event, identity, stream, metadata };
      return;
    }
    flushAssistantText(entry);
    applyPiEvent(entry, event, identity, stream, metadata);
  }
  function applyPiEvent(entry, event, identity = '', stream = true, metadata = {}) {
    const timestamp = metadata.timestamp ?? Date.now();
    const assistant = event.message?.role === 'assistant';
    const tracks = entry.messageTracks ??= new Map();
    let track = tracks.get(identity);
    if (event.type === 'message_start' && assistant) {
      if (track) for (const part of entry.parts) if (part.type === 'thinking' && part.id.startsWith(`thinking:${track.id}:`) && part.status === 'running') { part.status = 'interrupted'; part.endedAt = Math.max(part.startedAt, timestamp); }
      track = { id: `${entry.timelineRun}:${++entry.textMessageSequence}:${hash(identity)}`, thinking: new Map() }; tracks.set(identity, track);
      if (stream) { entry.streamText = ''; entry.textMessageId = `text:${track.id}`; entry.textPartIds = []; }
    }
    if (['message_update', 'message_end'].includes(event.type) && assistant) {
      if (!track) { track = { id: `${entry.timelineRun}:${++entry.textMessageSequence}:${hash(identity)}`, thinking: new Map() }; tracks.set(identity, track); }
      const delta = event.assistantMessageEvent;
      const contents = typeof event.message.content === 'string' ? [{ type: 'text', text: event.message.content }] : event.message.content ?? [];
      const ended = event.type === 'message_end';
      const interrupted = ['aborted', 'error'].includes(event.message.stopReason);
      let withheld = false;
      if (delta?.type === 'thinking_start' && Number.isInteger(delta.contentIndex) && delta.contentIndex >= 0 && !track.thinking.has(delta.contentIndex)) track.thinking.set(delta.contentIndex, { startedAt: timestamp });
      if (stream) {
        entry.textMessageId = `text:${track.id}`;
        entry.lastAssistantText = contentText(event.message);
        entry.streamText = formatToolValue(entry.lastAssistantText, 32000).text;
      }
      for (const [index, content] of contents.entries()) {
        if (content.type === 'thinking' && content.redacted === true) {
          track.thinking.set(index, { ...track.thinking.get(index), redacted: true });
          entry.parts = entry.parts.filter(part => part.id !== `thinking:${track.id}:${index}`);
          withheld = true;
          continue;
        }
        if (content.type === 'thinking' && !track.thinking.get(index)?.redacted && typeof content.thinking === 'string' && content.thinking.trim()) {
          const id = `thinking:${track.id}:${index}`;
          let timing = track.thinking.get(index);
          if (!timing) { timing = { startedAt: timestamp }; track.thinking.set(index, timing); }
          let part = entry.parts.find(part => part.id === id);
          if (!part) { part = { id, type: 'thinking', text: '', status: 'running', startedAt: timing.startedAt, source: metadata.workerId ? 'worker' : stream ? 'assistant' : 'reason', ...(metadata.workerId ? { workerId: metadata.workerId } : {}) }; entry.parts.push(part); }
          part.text = content.thinking;
          const progressed = Number.isInteger(delta?.contentIndex) && delta.contentIndex > index && ['text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'thinking_start'].includes(delta.type)
            || contents.slice(index + 1).some(value => value.type === 'text' && value.text || value.type === 'toolCall');
          if (part.status === 'running' && (ended || delta?.type === 'thinking_end' && delta.contentIndex === index || progressed)) { part.status = interrupted ? 'interrupted' : 'completed'; part.endedAt = Math.max(part.startedAt, timestamp); }
        } else if (stream && content.type === 'text' && typeof content.text === 'string' && content.text) {
          const id = `${entry.textMessageId}:${index}`;
          let part = entry.parts.find(part => part.id === id);
          if (!part) { part = { id, type: 'text', text: '', status: 'streaming' }; entry.parts.push(part); (entry.textPartIds ??= []).push(id); }
          part.text = content.text; part.status = ended ? 'completed' : 'streaming';
        }
      }
      // End/start boundaries can omit earlier content from their snapshot.
      // Freeze its timer at the boundary instead of waiting for the answer.
      for (const part of entry.parts) if (part.type === 'thinking' && part.id.startsWith(`thinking:${track.id}:`) && part.status === 'running') {
        const index = Number(part.id.slice(part.id.lastIndexOf(':') + 1));
        if (ended || delta?.type === 'thinking_end' && delta.contentIndex === index || Number.isInteger(delta?.contentIndex) && delta.contentIndex > index && ['text_start', 'toolcall_start', 'thinking_start'].includes(delta.type)) { part.status = interrupted ? 'interrupted' : 'completed'; part.endedAt = Math.max(part.startedAt, timestamp); }
      }
      entry.parts = cleanTimelineParts(entry.parts);
      if (entry.mode === 'goal' && (ended || delta?.type === 'thinking_end' || withheld)) void saveTimeline(entry, 'running').catch(() => {});
    }
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
      const id = `tool:${entry.timelineRun}:${hash(`${identity}:${event.toolCallId}`)}`;
      const timestamp = metadata.timestamp ?? Date.now();
      let part = entry.parts.find(part => part.id === id);
      if (!part) {
        const args = formatToolValue(event.args ?? '', 4000);
        part = { id, type: 'tool', name: event.toolName, status: 'running', args: args.text, output: '', startedAt: timestamp, ...(metadata.workerId ? { workerId: metadata.workerId } : {}), ...(args.truncated ? { truncated: true } : {}) };
        entry.parts.push(part);
      }
      if (event.type === 'tool_execution_start') { entry.phase = 'execute'; activity(entry, event.toolName, 'running', `${identity}:${event.toolCallId}`); }
      else {
        // These two tools emit text deltas; other tools (including MCP progress)
        // emit snapshots. Accumulate only known deltas and let the final result
        // replace the preview, so completed output is never appended twice.
        const delta = event.type === 'tool_execution_update' && ['run_linux_ssh_command', 'run_local_skill_script', 'run_local_shell_command', 'upload_sftp', 'deploy_remote_service'].includes(part.name);
        const output = formatToolValue(delta ? part.output + contentText(event.partialResult)
          : event.type === 'tool_execution_update' ? event.partialResult : event.result, 12000);
        part.output = output.text; if (output.truncated) part.truncated = true;
        if (event.type === 'tool_execution_end') { part.status = event.isError ? 'failed' : 'completed'; part.endedAt = Math.max(part.startedAt, timestamp); activity(entry, event.toolName, part.status, `${identity}:${event.toolCallId}`); }
      }
      entry.parts = cleanTimelineParts(entry.parts);
      if (entry.mode === 'goal' && event.type !== 'tool_execution_update') void saveTimeline(entry, 'running').catch(() => {});
    }
  }
  function finishParts(entry, text, id) {
    flushAssistantText(entry);
    for (const part of entry.parts) {
      if (part.type === 'text') part.status = 'completed';
      else if (part.status === 'running') { part.status = 'interrupted'; part.endedAt = Date.now(); }
    }
    if (text !== undefined) {
      const matching = entry.mode === 'assist' && entry.lastAssistantText?.trim() === text.trim() ? new Set(entry.textPartIds) : new Set();
      const existing = entry.parts.find(part => matching.has(part.id)) ?? entry.parts.find(part => part.id === id);
      if (existing) { existing.text = text; existing.status = 'completed'; entry.parts = entry.parts.filter(part => !matching.has(part.id) || part === existing); }
      else entry.parts.push({ id, type: 'text', text, status: 'completed' });
    }
    entry.parts = cleanTimelineParts(entry.parts);
  }
  function saveTimeline(entry, status, revision = null) {
    if (entry.mode !== 'goal' || !entry.timelineRun) return Promise.resolve();
    const record = { schemaVersion: 1, sessionId: entry.sessionId, requestId: entry.request?.requestId ?? null, runId: entry.timelineRun, status, revision, parts: cleanTimelineParts(entry.parts) };
    const operation = (entry.timelineWrite ?? Promise.resolve()).catch(() => {}).then(() => atomicRecord(join(entry.directory, 'goal-timeline.json'), record));
    entry.timelineWrite = operation; return operation;
  }
  async function restoreTimeline(entry) {
    let record;
    try { const text = await readFile(join(entry.directory, 'goal-timeline.json'), 'utf8'); record = JSON.parse(text); }
    catch (error) { if (error.code === 'ENOENT') return; throw failure('INVALID_GOAL_TIMELINE', '目标执行时间线记录损坏。'); }
    if (record.schemaVersion !== 1 || record.sessionId !== entry.sessionId || typeof record.runId !== 'string' || !Array.isArray(record.parts) || !['running', 'completed', 'interrupted', 'failed'].includes(record.status) || !(record.revision === null || Number.isSafeInteger(record.revision) && record.revision >= 0)) throw failure('INVALID_GOAL_TIMELINE', '目标执行时间线不属于当前会话或版本无效。');
    if (record.requestId !== (entry.request?.requestId ?? null) || record.status === 'completed' && record.revision !== entry.result?.revision) return;
    entry.parts = cleanTimelineParts(record.parts); entry.timelineRun = record.runId;
    for (const part of entry.parts) { if (part.type === 'text') part.status = 'completed'; else if (part.status === 'running') part.status = 'interrupted'; }
  }
  function goalEvent(entry, event) {
    if (closed || entry.controller?.signal.aborted) return;
    if (event.type === 'reason.start') { entry.phase = 'reason'; entry.streamText = ''; activity(entry, 'Reason', 'running', 'reason'); }
    if (event.type === 'reason.decision') activity(entry, 'Reason', 'completed', 'reason');
    if (event.type === 'worker.event') {
      const value = event.event;
      if (value.phase) { entry.phase = value.phase; const worker = entry.workers.find(worker => worker.id === value.intentId); if (worker) worker.phase = value.phase; }
      if (value.type === 'pi_event') workerPiEvent(entry, value.intentId, value.event, { attemptId: value.attemptId, timestamp: Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : Date.now() }, false);
    }
    if (event.type === 'worker.start') workerEntry(entry, event.intentId, { status: 'running', startedAt: Date.now() });
    if (event.type === 'worker.result' || event.type === 'worker.error') {
      const view = workerEntry(entry, event.intentId, { status: event.type === 'worker.error' ? 'failed' : 'completed', error: event.error?.message, finishedAt: Date.now() });
      let result = event.result?.fact?.content ?? event.result?.fact ?? event.result;
      if (typeof result === 'string') { try { result = JSON.parse(result).statement ?? result; } catch {} }
      finishParts(view, typeof result === 'string' ? result : undefined, `result:${entry.timelineRun}:${hash(event.intentId)}`); queueWorkers(entry);
    }
    if (event.type === 'reason.event' && event.event?.type === 'pi_event') piEvent(entry, event.event.event, 'reason', false);
    if (event.type === 'middleware.event' && !summaryEvent(entry, event.event)) activity(entry, event.event.type, 'completed');
    if (entry.session) {
      if (event.type === 'blackboard.changed' || event.type === 'session.state') updateBoard(entry, entry.session.snapshot());
      if (event.type === 'memory.changed' || event.type === 'worker.result' || event.type === 'session.state') entry.memory = entry.session.memory();
    }
    notify(entry);
  }
  function collaborationEvent(entry, event) {
    if (closed || entry.controller?.signal.aborted) return;
    if (summaryEvent(entry, event)) { notify(entry); return; }
    if (event.type === 'middleware.status') entry.middleware = event.status;
    else if (event.type === 'memory.status') entry.memory = event.memory;
    else if (event.type === 'swarm.status') {
      entry.workers = event.workers.map(worker => {
        const metadata = { id: worker.id, parentId: worker.parentId, name: worker.name, description: worker.task,
          status: worker.status, phase: worker.status === 'running' ? 'execute' : null, depth: worker.depth,
          result: worker.result, error: worker.error, createdAt: worker.createdAt, startedAt: worker.startedAt, finishedAt: worker.finishedAt };
        const view = workerEntry(entry, worker.id, metadata);
        if (['completed', 'failed', 'interrupted'].includes(worker.status)) finishParts(view, worker.result, `result:${hash(worker.id)}`);
        return metadata;
      });
      const retained = new Set(entry.workers.map(worker => worker.id));
      for (const id of entry.workerViews?.keys() ?? []) if (!retained.has(id)) entry.workerViews.delete(id);
      queueWorkers(entry);
    } else if (event.type === 'swarm.worker.event') {
      workerPiEvent(entry, event.workerId, event.event, { parentId: event.parentId });
    } else {
      piEvent(entry, event);
      if (event.type.startsWith('context.') || event.type === 'skill.loaded') activity(entry, event.type, 'completed');
    }
    notify(entry);
  }
  async function restore(input) {
    assertOpen();
    const entry = await entryFor(input);
    if (entry.restored || entry.active) return state(entry.id);
    entry.restored = true;
    await restoreWorkers(entry);
    if (entry.mode !== 'goal' || !entry.objective) return state(entry.id);
    let database;
    try {
      const request = await readRequest(entry);
      const filePath = join(entry.directory, 'harness.sqlite');
      let present = true;
      try { await access(filePath); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
      let saved;
      if (present) { const { HarnessDatabase } = await load(); database = await HarnessDatabase.open({ filePath }); saved = database.loadSession(entry.sessionId); }
      if (request && request.status !== 'accepted' && (!saved?.blackboard || saved.blackboard.revision < request.appliedRevision)) throw failure('GOAL_REQUEST_STATE_MISMATCH', '待执行输入引用的数据库状态不可用，请检查会话存储。');
      entry.request = request;
      if (saved?.blackboard) updateBoard(entry, saved.blackboard);
      entry.memory = saved?.memory;
      entry.status = saved?.record?.status ?? 'idle';
      if (entry.status === 'running' || entry.workers.some(worker => worker.status === 'running')) entry.status = 'interrupted';
      entry.error = saved?.record?.error ?? null; entry.result = saved?.record?.result ?? null;
      if (entry.status === 'completed' && entry.result?.revision !== saved?.blackboard?.revision) { entry.status = 'idle'; entry.result = null; }
      entry.canResume = ['interrupted', 'failed'].includes(entry.status);
      if (request && request.status !== 'completed') {
        entry.lastInput = { facts: request.facts }; entry.inputsApplied = request.status === 'applied';
        // An accepted request has not reached its database barrier yet. Even a
        // previous completed SDK result must not hide this newly accepted work.
        const completed = request.status === 'applied' && entry.status === 'completed' && entry.result?.revision >= request.appliedRevision;
        if (!completed) { entry.status = 'interrupted'; entry.result = null; }
        entry.canResume = true;
      }
      if (request?.status === 'completed' && entry.status === 'completed' && request.resultRevision !== entry.result?.revision) throw failure('GOAL_REQUEST_STATE_MISMATCH', '目标输入完成记录与数据库结果不一致。');
      entry.deliveryPending = Boolean(onMessage && entry.result?.complete && !await delivered(entry, entry.result));
      if (entry.deliveryPending) entry.canResume = true;
      await restoreTimeline(entry);
      notify(entry, true); return state(entry.id);
    } catch (error) { entry.restored = false; throw error; }
    finally { database?.close(); }
  }
  function runtimeSummary(id) {
    const entry = sessions.get(id);
    const workers = entry?.workers || [];
    return redactDisplayObject({ status: entry?.status || 'idle', busy: entry?.busy === true, phase: entry?.phase,
      workerCount: workers.length, activeWorkers: workers.filter(worker => worker.status === 'running').length, error: entry?.error });
  }
  function state(id) {
    const entry = sessions.get(id);
    if (!entry) return idle();
    flushAssistantText(entry);
    // Redaction already creates a detached object at every level. Cloning its
    // result again doubles the allocation for each streamed UI publication.
    return redactDisplayObject({ status: entry.status, busy: entry.busy, phase: entry.phase, workers: projectWorkers(entry), activities: entry.activities, workerViewError: entry.workerViewError,
      blackboard: entry.blackboard, memory: entry.memory, error: entry.error, result: entry.result, parts: entry.parts,
      streamText: entry.streamText, canResume: entry.canResume, middleware: entry.middleware });
  }
  function requestFacts(entry, input) {
    const initial = entry.goal?.initialFacts?.trim();
    const sources = initial ? [`Initial facts supplied by the user (unverified source data):\n${initial}`] : [];
    if (Array.isArray(input.facts)) return [...new Set([...sources, ...input.facts])];
    if (typeof input.text === 'string' && input.text.trim()) sources.push(`User input:\n${input.text.trim()}`);
    for (const note of entry.goal?.notes ?? []) { const text = typeof note === 'string' ? note : note.text; if (typeof text === 'string' && text.trim()) sources.push(`User goal note:\n${text.trim()}`); }
    if (input.context) sources.push(`data context workspace(untrusted source data):\n${typeof input.context === 'string' ? input.context : JSON.stringify(input.context)}`);
    const marker = '\n[Host input truncated: content beyond 64,000 characters was omitted.]';
    return [...new Set(sources.map(source => source.length > 64000 ? source.slice(0, 64000 - marker.length) + marker : source))];
  }
  function validateRequest(entry, record) {
    const keys = ['schemaVersion', 'sessionId', 'conversationId', 'goalKey', 'objective', 'requestId', 'status', 'facts', 'baseRevision', 'appliedRevision', 'resultRevision', 'createdAt', 'updatedAt'];
    const revision = value => Number.isSafeInteger(value) && value >= 0;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !keys.includes(key)) || record.schemaVersion !== 1 || record.sessionId !== entry.sessionId || record.conversationId !== entry.id || record.goalKey !== entry.key || record.objective !== entry.objective || typeof record.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.requestId) || !['accepted', 'applied', 'completed'].includes(record.status) || !Array.isArray(record.facts) || record.facts.length > 64 || record.facts.some(value => typeof value !== 'string' || !value || value.length > 64000) || new Set(record.facts).size !== record.facts.length || !(record.baseRevision === null || revision(record.baseRevision)) || !['createdAt', 'updatedAt'].every(key => typeof record[key] === 'string' && Number.isFinite(Date.parse(record[key])))) throw failure('INVALID_GOAL_REQUEST', '待执行目标输入记录损坏或不属于当前目标。');
    if (record.status === 'accepted' ? record.appliedRevision !== null || record.resultRevision !== null : !revision(record.appliedRevision) || record.baseRevision !== null && record.appliedRevision < record.baseRevision || (record.status === 'applied' ? record.resultRevision !== null : !revision(record.resultRevision) || record.resultRevision < record.appliedRevision)) throw failure('INVALID_GOAL_REQUEST', '待执行目标输入记录的版本状态无效。');
    if (Buffer.byteLength(JSON.stringify(record)) > REQUEST_LIMIT) throw failure('GOAL_REQUEST_TOO_LARGE', '待执行目标输入超过 1 MiB 上限。');
    return record;
  }
  async function readRequest(entry) {
    let handle;
    try {
      handle = await open(join(entry.directory, 'goal-request.json'), 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > REQUEST_LIMIT) throw failure('INVALID_GOAL_REQUEST', '待执行目标输入记录不是有效的有界文件。');
      const bytes = Buffer.alloc(REQUEST_LIMIT + 1); let size = 0;
      while (size < bytes.length) { const part = await handle.read(bytes, size, bytes.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
      if (size > REQUEST_LIMIT) throw failure('INVALID_GOAL_REQUEST', '待执行目标输入记录超过大小上限。');
      let record;
      try { record = JSON.parse(bytes.subarray(0, size).toString('utf8')); } catch { throw failure('INVALID_GOAL_REQUEST', '待执行目标输入记录不是有效 JSON。'); }
      return validateRequest(entry, record);
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { await handle?.close(); }
  }
  async function saveRequest(entry, record, { initial = false } = {}) {
    validateRequest(entry, record);
    // The SDK lease uses SQLite transactions plus process liveness fencing. A
    // separate database keeps this short intake lease independent of the live
    // Worker lease, and safely reclaims ownership after a host process dies.
    const { HarnessDatabase } = await load();
    let database, lease;
    try {
      database = await HarnessDatabase.open({ filePath: join(entry.directory, 'goal-request-lock.sqlite') });
      database.ensureSession({ sessionId: entry.sessionId, goal: entry.objective });
      try { lease = database.acquireSession(entry.sessionId); }
      catch (error) { if (error.code === 'SESSION_LOCKED') throw failure('GOAL_REQUEST_CONFLICT', '目标输入正被另一个会话宿主保存，请稍后重新打开会话。'); throw error; }
      const current = await readRequest(entry);
      if (initial ? current && (current.status !== 'completed' || current.requestId !== entry.request?.requestId) : !current || current.requestId !== record.requestId || current.baseRevision !== record.baseRevision || JSON.stringify(current.facts) !== JSON.stringify(record.facts)) throw failure('GOAL_REQUEST_CONFLICT', '目标输入已被另一执行更新，请重新打开会话。');
      const progress = ['accepted', 'applied', 'completed'];
      if (!initial && progress.indexOf(current.status) > progress.indexOf(record.status)) { entry.request = current; return; }
      if (!initial && current.status === 'completed' && record.resultRevision !== current.resultRevision) throw failure('GOAL_REQUEST_CONFLICT', '目标输入已绑定另一完成结果。');
      await atomicRecord(join(entry.directory, 'goal-request.json'), record);
      entry.request = copy(record);
    } finally { try { lease?.release(); } finally { database?.close(); } }
  }
  async function markRequestApplied(entry) {
    if (entry.request?.status !== 'accepted') return;
    await saveRequest(entry, { ...entry.request, status: 'applied', appliedRevision: entry.session.snapshot().revision, updatedAt: new Date().toISOString() });
  }
  async function markRequestCompleted(entry, result) {
    if (!entry.request || entry.request.status === 'completed') return;
    if (entry.request.status !== 'applied' || result.revision < entry.request.appliedRevision) throw failure('GOAL_REQUEST_STATE_MISMATCH', '目标结果未包含待执行输入。');
    await saveRequest(entry, { ...entry.request, status: 'completed', resultRevision: result.revision, updatedAt: new Date().toISOString() });
  }
  async function delivered(entry, result) {
    try {
      const record = JSON.parse(await readFile(join(entry.directory, 'delivery.json'), 'utf8'));
      return record.schemaVersion === 1 && record.sessionId === entry.sessionId && record.revision === result.revision;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function deliverGoal(entry, result) {
    entry.controller?.signal.throwIfAborted();
    finishParts(entry, result.summary, `goal:${entry.sessionId}:${result.revision}:answer`);
    await saveTimeline(entry, 'completed', result.revision);
    if (!onMessage || await delivered(entry, result)) { entry.deliveryPending = false; return; }
    entry.controller?.signal.throwIfAborted();
    entry.deliveryPending = true;
    await onMessage(entry.id, { role: 'assistant', text: result.summary, id: `goal:${entry.sessionId}:${result.revision}`, parts: cleanTimelineParts(entry.parts) });
    await atomicRecord(join(entry.directory, 'delivery.json'), { schemaVersion: 1, sessionId: entry.sessionId, revision: result.revision, deliveredAt: new Date().toISOString() });
    entry.deliveryPending = false;
  }
  async function openGoal(entry, config) {
    if (entry.session) return entry.session;
    const { createHarness, createWorkspaceTools } = await load();
    entry.controller.signal.throwIfAborted();
    const tools = [...await createWorkspaceTools(await roots(entry.id)), ...await additionalTools(entry.id)];
    const session = await createHarness({ ...config, sessionId: entry.sessionId, goal: entry.objective, directory: entry.directory,
      ...(config.mcp ? { mcp: { ...config.mcp, signal: entry.controller.signal } } : {}),
      intools: config.intools === false ? false : { allowedTools: ['note', 'todo'], ...config.intools, localShell: config.intools?.localShell === false ? false : { ...config.intools?.localShell, cwd: (await roots(entry.id))[0] } },
      tools, onEvent: event => goalEvent(entry, event) });
    entry.session = session; entry.middleware = session.middlewareStatus();
    updateBoard(entry, session.snapshot()); entry.memory = session.memory();
    entry.controller.signal.throwIfAborted();
    return session;
  }
  async function addContext(entry, input) {
    const sources = entry.request?.facts ?? requestFacts(entry, input);
    const existing = new Set(entry.session.snapshot().nodes.map(node => node.fact?.content));
    for (const source of sources) {
      const content = source.slice(0, 64000);
      if (!existing.has(content)) { entry.controller.signal.throwIfAborted(); await entry.session.addFact({ content, parentIds: [entry.session.snapshot().rootId] }); existing.add(content); }
    }
    updateBoard(entry, entry.session.snapshot());
  }
  async function execute(entry, input, resume) {
    try {
      entry.controller.signal.throwIfAborted();
      // A completed model run can outlive a failed host-message commit. Retry
      // delivery separately, without calling a model or replaying a Worker.
      if (resume && entry.result?.complete && (entry.deliveryPending || entry.request?.status === 'applied')) {
        await markRequestCompleted(entry, entry.result);
        await deliverGoal(entry, entry.result);
        entry.controller.signal.throwIfAborted();
        entry.status = 'completed'; entry.error = null; entry.canResume = false; entry.phase = null; entry.streamText = '';
        return;
      }
      const config = await readConfiguration(); entry.controller.signal.throwIfAborted();
      const api = await load(); entry.controller.signal.throwIfAborted();
      await mkdir(entry.directory, { recursive: true });
      let answer;
      if (entry.mode === 'goal') {
        const session = await openGoal(entry, config);
        if (!resume || session.status === 'idle' || entry.inputsApplied === false || entry.request?.status === 'accepted') { await addContext(entry, input); await markRequestApplied(entry); entry.inputsApplied = true; }
        entry.status = 'running'; entry.phase = 'reason'; notify(entry, true);
        const result = await (resume ? session.resume({ signal: entry.controller.signal }) : session.run({ signal: entry.controller.signal }));
        entry.controller.signal.throwIfAborted();
        entry.result = result;
        updateBoard(entry, session.snapshot()); entry.memory = session.memory();
        await markRequestCompleted(entry, result);
        await deliverGoal(entry, result);
      } else {
        entry.status = 'running'; entry.phase = 'chat'; notify(entry, true);
        const codingTools = await additionalTools(entry.id);
        const configuration = { ...config,
          intools: config.intools === false ? false : { ...config.intools, localShell: config.intools?.localShell === false ? false : { ...config.intools?.localShell, cwd: (await roots(entry.id))[0] } },
          tools: async binding => [...(typeof config.tools === 'function' ? await config.tools(binding) : config.tools ?? []), ...codingTools] };
        answer = await api.runCollaboration({ configuration, requestToolApproval: (input.approvalMode === 'auto' || input.approvalMode === undefined && config.worker?.requireToolApproval === false) ? undefined : request => {
          if (!requestToolApproval) throw new Error('人工审核界面不可用，工具未执行。');
          return requestToolApproval({ ...request, conversationId: entry.id });
        }, sessionId: entry.sessionId, directory: entry.directory,
          workspaceRoots: await roots(entry.id), text: input.text, messages: input.messages, context: input.context, signal: entry.controller.signal,
          onEvent: event => collaborationEvent(entry, event) });
      }
      entry.controller.signal.throwIfAborted();
      if (answer !== undefined) { finishParts(entry, answer, `answer:${entry.timelineRun}`); await onMessage?.(entry.id, { role: 'assistant', text: answer, parts: cleanTimelineParts(entry.parts) }); }
      entry.status = 'completed'; entry.error = null; entry.canResume = false; entry.streamText = ''; entry.phase = null;
    } catch (error) {
      const cancelled = entry.controller.signal.aborted;
      entry.status = cancelled ? 'interrupted' : 'failed';
      entry.error = cancelled ? null : errorData(error);
      entry.canResume = entry.mode === 'goal'; entry.phase = null;
      if (entry.session) { updateBoard(entry, entry.session.snapshot()); entry.memory = entry.session.memory(); }
    } finally {
      if (entry.session) {
        try { await entry.session.close(); }
        catch (error) { entry.status = 'failed'; entry.error = errorData(error); entry.canResume = entry.mode === 'goal'; }
        entry.session = undefined;
      }
      finishParts(entry);
      try { await saveTimeline(entry, entry.result?.complete && entry.request?.status === 'completed' ? 'completed' : entry.status, entry.result?.revision ?? null); }
      catch (error) { entry.status = 'failed'; entry.error = errorData(error); entry.canResume = entry.mode === 'goal'; }
      if (entry.mode === 'assist') for (const worker of entry.workers) {
        if (!['queued', 'running', 'waiting'].includes(worker.status)) continue;
        worker.status = entry.status === 'failed' ? 'failed' : 'interrupted'; worker.phase = null;
        const item = entry.activities.find(item => item.key === `swarm:${worker.id}`);
        if (item) item.status = worker.status;
      }
      for (const item of entry.activities) if (['queued', 'running', 'waiting'].includes(item.status)) item.status = entry.status === 'completed' ? 'completed' : entry.status;
      for (const view of entry.workerViews?.values() ?? []) {
        if (['queued', 'running', 'waiting'].includes(view.metadata.status)) view.metadata.status = entry.status === 'failed' ? 'failed' : 'interrupted';
        finishParts(view);
      }
      try { await saveWorkers(entry); } catch (error) { entry.workerViewError = errorData(error); }
      entry.busy = false; entry.active = undefined;
      notify(entry, true);
    }
  }
  function schedule(entry, input, resume, reserved = false) {
    if (!reserved && (entry.busy || entry.active)) throw failure('SESSION_BUSY', '该会话仍在运行。');
    entry.busy = true; entry.status = 'starting'; entry.error = null; entry.streamText = ''; entry.canResume = false;
    if (!reserved) entry.controller = new AbortController(); entry.activities = [];
    const deliveryOnly = resume && entry.result?.complete && (entry.deliveryPending || entry.request?.status === 'applied');
    if (!deliveryOnly) { entry.parts = []; entry.pendingAssistantText = undefined; entry.messageTracks = new Map(); entry.timelineRun = randomUUID(); entry.textMessageSequence = 0; entry.textMessageId = undefined; entry.textPartIds = []; entry.lastAssistantText = undefined; }
    else entry.timelineRun ??= randomUUID();
    if (entry.mode === 'goal' && !deliveryOnly) void saveTimeline(entry, 'running').catch(() => {});
    if (!resume) { entry.lastInput = input; entry.inputsApplied = false; entry.result = null; entry.deliveryPending = false; }
    entry.active = Promise.resolve().then(() => execute(entry, input, resume));
    notify(entry, true); return state(entry.id);
  }
  async function acceptGoal(entry, input) {
    if (entry.busy || entry.active) throw failure('SESSION_BUSY', '该会话仍在运行。');
    entry.busy = true; entry.status = 'starting'; entry.error = null; entry.controller = new AbortController();
    let release;
    const reservation = new Promise(resolve => { release = resolve; }); entry.active = reservation;
    notify(entry, true);
    try {
      const now = new Date().toISOString();
      const record = { schemaVersion: 1, sessionId: entry.sessionId, conversationId: entry.id, goalKey: entry.key, objective: entry.objective, requestId: randomUUID(), status: 'accepted', facts: requestFacts(entry, input), baseRevision: entry.blackboard?.revision ?? null, appliedRevision: null, resultRevision: null, createdAt: now, updatedAt: now };
      await saveRequest(entry, record, { initial: true });
      entry.lastInput = { facts: record.facts }; entry.inputsApplied = false; entry.result = null; entry.deliveryPending = false;
      if (entry.controller.signal.aborted || closed) {
        entry.status = 'interrupted'; entry.canResume = true; entry.busy = false; entry.active = undefined; release(); notify(entry, true); return state(entry.id);
      }
      const result = schedule(entry, entry.lastInput, false, true); release(entry.active); return result;
    } catch (error) {
      entry.status = entry.controller.signal.aborted ? 'interrupted' : 'failed'; entry.error = errorData(error);
      entry.canResume = Boolean(entry.request && entry.request.status !== 'completed'); entry.busy = false; entry.active = undefined; release(); notify(entry, true); throw error;
    }
  }
  async function start(input) {
    assertOpen();
    if (input.approvalMode !== undefined && !['auto', 'manual'].includes(input.approvalMode)) throw failure('INVALID_APPROVAL_MODE', '无效的工具执行方式。');
    if (input.mode === 'goal') goalText(input.goal);
    if (input.mode === 'assist' && (typeof input.text !== 'string' || !input.text.trim())) throw failure('MESSAGE_REQUIRED', '请输入消息。');
    await restore(input); const entry = sessions.get(input.conversationId);
    if (entry.busy) throw failure('SESSION_BUSY', '该会话仍在运行。');
    if (entry.mode === 'goal' && entry.canResume) throw failure('RESUME_REQUIRED', '此目标上次执行已中断，请点击继续。');
    if (entry.mode === 'goal' && entry.status === 'completed' && !input.text && !input.context && !(entry.goal?.notes?.length)) return state(entry.id);
    return entry.mode === 'goal' ? acceptGoal(entry, input) : schedule(entry, input, false);
  }
  async function resume(id) {
    assertOpen();
    const previous = sessions.get(id);
    // Re-resolve the workspace before resuming, including after a failed UI
    // restoration. Never execute an old checkpoint against newly selected files.
    if (previous?.mode === 'goal') await restore({ conversationId: id, mode: previous.mode, goal: previous.goal });
    const entry = sessions.get(id);
    if (!entry || entry.mode !== 'goal' || !entry.canResume) throw failure('RESUME_UNAVAILABLE', '该目标没有可继续的执行。');
    return schedule(entry, entry.lastInput ?? {}, true);
  }
  function cancel(id) {
    const entry = sessions.get(id);
    if (!entry?.busy || entry.controller.signal.aborted) return false;
    entry.controller.abort(failure('ABORT_ERR', '用户停止了执行。')); entry.session?.cancel('用户停止了执行。');
    activity(entry, '停止请求已发送', 'interrupted'); notify(entry, true); return true;
  }
  async function releaseWorkspace(id) {
    assertOpen();
    const entry = sessions.get(id);
    if (entry?.busy || entry?.active) throw failure('SESSION_BUSY', '请先停止当前会话，再切换工作空间。');
    await entry?.session?.close();
    await entry?.timelineWrite;
    if (entry) await saveWorkers(entry);
    if (entry) entry.session = undefined;
  }
  async function remove(id) {
    assertOpen();
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('conversationId is required');
    const entry = sessions.get(id);
    if (entry?.busy || entry?.active) throw failure('SESSION_BUSY', '此会话正在运行，请先停止后再删除。');
    await entry?.session?.close();
    // Final timeline writes must settle before removing the saved execution.
    await entry?.timelineWrite?.catch(() => {});
    clearTimeout(entry?.workerSaveTimer); await entry?.workerWrite?.catch(() => {});
    clearTimeout(entry?.notification); sessions.delete(id);
    const directory = resolve(root, hash(id));
    if (dirname(directory) !== root) throw failure('INVALID_STORAGE_PATH', '会话存储路径无效。');
    await rm(directory, { recursive: true, force: true });
    for (const key of workspaceScopes.keys()) if (dirname(key) === directory) workspaceScopes.delete(key);
  }
  function close() {
    if (closing) return closing;
    closed = true;
    for (const entry of sessions.values()) { clearTimeout(entry.notification); cancel(entry.id); }
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...sessions.values()].map(entry => entry.active));
      await Promise.allSettled([...sessions.values()].map(entry => saveWorkers(entry)));
      const results = await Promise.allSettled([...sessions.values()].map(entry => entry.session?.close()));
      sessions.clear(); workspaceScopes.clear(); const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'IDE agent service could not close cleanly');
    }); return closing;
  }
  return Object.freeze({ state, runtimeSummary, isBusy: id => sessions.get(id)?.busy === true, start, resume, cancel, restore, releaseWorkspace, remove, close });
}

module.exports = { createHarnessService };
