'use strict';

const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
function workspaceKey(value) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
  const normalized = (windows ? path.win32 : path).normalize(value);
  const trimmed = normalized.replace(/[\\/]+$/, '') || normalized;
  return windows ? trimmed.toLowerCase() : trimmed;
}
const goalRequestFingerprint = (objective, initialFacts, criteria) => createHash('sha256').update(JSON.stringify([objective, initialFacts, criteria])).digest('hex');
const inputMessageId = (messages, index) => messages[index].id ?? 'legacy-' + createHash('sha256').update(JSON.stringify(messages.slice(0, index + 1))).digest('hex');

// Match legacy prefix hashes exactly, but serialize each record only once.
// Hash.copy() forks the current digest without rehashing the saved prefix.
function inputMessageIds(messages, role) {
  const ids = messages.map(message => message.id);
  const needsId = message => message.id == null && (role === undefined || message.role === role);
  const lastMissing = messages.findLastIndex(needsId);
  if (lastMissing < 0) return ids;
  const prefix = createHash('sha256').update('[');
  for (let index = 0; index <= lastMissing; index++) {
    if (index) prefix.update(',');
    prefix.update(JSON.stringify(messages[index]));
    if (needsId(messages[index])) ids[index] = 'legacy-' + prefix.copy().update(']').digest('hex');
  }
  return ids;
}

const STORAGE_KEY = 'conversations';
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_ASSISTANT_MESSAGE_LENGTH = 64000;
const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_CRITERIA = 20;
const MAX_CRITERION_LENGTH = 300;
const MAX_NOTES = 50;
const MAX_NOTE_LENGTH = 2000;
const STORAGE_VERSION = 3;
const MAX_SESSION_MESSAGE_BYTES = 2 << 20;
const MAX_ALL_MESSAGE_BYTES = 12 << 20;
const { cleanTimelineParts, formatToolValue, redactDisplayObject } = require('../../host/agent/agent-backend.cjs').backendModule('projection.cjs');

function requireMode(mode) {
  if (mode !== 'assist' && mode !== 'goal') throw new Error('请选择协助模式或探索模式。');
  return mode;
}

function requireText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符。`);
  return text;
}

function cleanGoal(value) {
  if (!value || typeof value.objective !== 'string' || !value.objective.trim()) return null;
  const seenCriteria = new Set();
  const criteria = (Array.isArray(value.criteria) ? value.criteria : [])
    .filter(item => {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) return false;
      if (typeof item.id === 'string' && item.id.trim()) {
        if (seenCriteria.has(item.id)) return false;
        seenCriteria.add(item.id);
      }
      return true;
    })
    .slice(0, MAX_CRITERIA)
    .map(item => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
      text: item.text.trim().slice(0, MAX_CRITERION_LENGTH),
      done: item.done === true
    }));
  const seenNotes = new Set();
  const notes = (Array.isArray(value.notes) ? value.notes : [])
    .filter(item => {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) return false;
      if (typeof item.id === 'string' && item.id.trim()) {
        if (seenNotes.has(item.id)) return false;
        seenNotes.add(item.id);
      }
      return true;
    })
    .slice(-MAX_NOTES)
    .map(item => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
      text: item.text.trim().slice(0, MAX_NOTE_LENGTH),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    }));
  return {
    objective: value.objective.trim().slice(0, MAX_OBJECTIVE_LENGTH), criteria, notes,
    initialFacts: typeof value.initialFacts === 'string' ? value.initialFacts.trim().slice(0, 8000) : '',
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
  };
}

function goalSnapshot(goal) {
  return goal ? { ...goal, criteria: goal.criteria.map(item => ({ ...item })), notes: goal.notes.map(item => ({ ...item })) } : null;
}

function cleanMessages(value) {
  if (!Array.isArray(value)) return [];
  const messages = value.filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
    .slice(-MAX_MESSAGES)
    .map(message => {
      const limit = message.role === 'assistant' ? MAX_ASSISTANT_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH;
      const marker = '\n\n[回复超出显示上限；完整输出保存在本地执行记录中。]';
      const parts = message.role === 'assistant' ? cleanTimelineParts(message.parts) : [];
      const text = message.role === 'assistant' ? formatToolValue(message.text, Number.MAX_SAFE_INTEGER).text : message.text;
      return { role: message.role, ...(typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 200 ? { id: message.id } : {}), text: message.role === 'assistant' && text.length > limit
        ? text.slice(0, limit - marker.length) + marker : text.slice(0, limit), ...(parts.length ? { parts } : {}),
        ...(message.role === 'user' && ['sending', 'accepted', 'uncertain'].includes(message.steeringStatus) ? { steeringStatus: message.steeringStatus } : {}) };
    });
  // Array JSON adds brackets and one comma between each serialized message.
  // Budget each message once instead of re-serializing every remaining suffix.
  const sizes = messages.map(message => Buffer.byteLength(JSON.stringify(message)));
  let bytes = 2 + Math.max(0, messages.length - 1) + sizes.reduce((total, size) => total + size, 0);
  let first = 0;
  while (messages.length - first > 1 && bytes > MAX_SESSION_MESSAGE_BYTES) bytes -= sizes[first++] + 1;
  return first ? messages.slice(first) : messages;
}

function titleFrom(messages, fallback = '新对话') {
  const first = messages.find(message => message.role === 'user' && message.text.trim());
  if (!first) return fallback;
  const characters = Array.from(first.text.trim().replace(/\s+/g, ' '));
  return characters.length > 30 ? characters.slice(0, 30).join('') + '…' : characters.join('');
}

function goalTitle(goal, fallback = '新对话') {
  return goal ? titleFrom([{ role: 'user', text: goal.objective.split(/\r?\n/, 1)[0] }], fallback) : fallback;
}

function newSession(messages = [], mode = 'assist') {
  const now = Date.now();
  return { id: randomUUID(), title: titleFrom(messages, mode === 'goal' ? '新探索' : '新对话'), messages, mode, goal: null, placeholder: messages.length === 0, createdAt: now, updatedAt: now };
}

function snapshot(session) {
  return { ...session, inputQueue: structuredClone(session.inputQueue ?? []), messages: session.messages.map(message => ({ ...message, ...(message.parts ? { parts: message.parts.map(part => ({ ...part })) } : {}) })), goal: goalSnapshot(session.goal) };
}

function restoreState(stored, legacyMessages) {
  const modern = Number(stored?.version) >= STORAGE_VERSION;
  const seen = new Set();
  const original = (Array.isArray(stored?.sessions) ? stored.sessions : []).filter(session => {
    if (!session || typeof session.id !== 'string' || !session.id || seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
  const migratedIds = { assist: new Map(), goal: new Map() };
  const candidates = [];
  for (const session of original) {
    const messages = cleanMessages(session.messages).map(message => message.steeringStatus === 'sending' ? { ...message, steeringStatus: 'uncertain' } : message);
    const goal = cleanGoal(session.goal);
    const mode = session.mode === 'goal' ? 'goal' : 'assist';
    const title = typeof session.title === 'string' && session.title.trim() ? session.title.slice(0, 60)
      : mode === 'goal' ? goalTitle(goal, titleFrom(messages, '新探索')) : titleFrom(messages);
    const base = {
      inputQueue: (Array.isArray(session.inputQueue) ? session.inputQueue : []).filter(item => typeof item?.id === 'string' && typeof item.text === 'string' && item.text.trim() && item.text.length <= 8000).slice(0, 20)
        .map(item => ({ ...item, ...(item.delivery ? { delivery: 'uncertain' } : {}) })),
      ...(session.inputQueue?.length || session.queuePaused !== undefined ? { queuePaused: true } : {}),
      ...(typeof session.executionBranch === 'string' ? { executionBranch: session.executionBranch } : {}),
      id: session.id, title, messages, placeholder: session.placeholder === true && messages.length === 0 && !goal,
      ...(typeof session.projectId === 'string' ? { projectId: session.projectId } : {}),
      ...(typeof session.workspace === 'string' && session.workspace.trim() ? { workspace: session.workspace.trim() } : {}),
      ...(session.historyTruncated === true ? { historyTruncated: true } : {}),
      ...(typeof session.sourceConversationId === 'string' && mode === 'goal' ? { sourceConversationId: session.sourceConversationId } : {}),
      ...(typeof session.goalRequestKey === 'string' && mode === 'goal' ? { goalRequestKey: session.goalRequestKey } : {}),
      ...(mode === 'goal' && typeof session.goalRequestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(session.goalRequestFingerprint)
        ? { goalRequestFingerprint: session.goalRequestFingerprint }
        : mode === 'goal' && goal && typeof session.goalRequestKey === 'string'
          ? { goalRequestFingerprint: goalRequestFingerprint(goal.objective, goal.initialFacts, goal.criteria.map(item => item.text)) } : {}),
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
      updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now()
    };
    if (modern) {
      candidates.push({
        ...base, mode, goal: mode === 'goal' ? goal : null,
        ...(typeof session.legacyDraftId === 'string' && session.legacyDraftId ? { legacyDraftId: session.legacyDraftId } : {})
      });
      continue;
    }

    // Earlier versions could put chat and a goal on the same session. Keep the
    // old ID with its chat, but give the goal a separate, independently selectable
    // session. The old ID also lets the webview recover a saved local goal draft.
    const preserveGoalId = mode === 'goal' && messages.length === 0;
    if (!preserveGoalId) {
      candidates.push({ ...base, mode: 'assist', goal: null });
      migratedIds.assist.set(session.id, session.id);
    }
    if (goal || mode === 'goal') {
      const id = preserveGoalId ? session.id : randomUUID();
      candidates.push({
        ...base, id, title: goalTitle(goal, preserveGoalId ? title : '新探索'),
        mode: 'goal', messages: [], goal, legacyDraftId: session.id
      });
      migratedIds.goal.set(session.id, id);
    }
  }

  const counts = { assist: 0, goal: 0 };
  const sessions = candidates.filter(session => ++counts[session.mode] <= MAX_SESSIONS);
  const oldCurrent = original.find(session => session.id === stored?.currentId);
  const activeMode = modern ? (stored.activeMode === 'goal' ? 'goal' : 'assist') : (oldCurrent?.mode === 'goal' ? 'goal' : 'assist');
  if (sessions.length === 0) sessions.push(newSession(modern ? [] : cleanMessages(legacyMessages), activeMode));

  const currentIds = {};
  for (const mode of ['assist', 'goal']) {
    const remembered = modern ? stored?.currentIds?.[mode] : migratedIds[mode].get(stored?.currentId);
    currentIds[mode] = sessions.some(session => session.mode === mode && session.id === remembered)
      ? remembered : sessions.find(session => session.mode === mode)?.id ?? null;
  }
  if (!currentIds[activeMode]) {
    const session = newSession([], activeMode);
    sessions.unshift(session);
    currentIds[activeMode] = session.id;
  }
  const projects = (Array.isArray(stored?.projects) ? stored.projects : []).filter((project, index, all) =>
    project && typeof project.id === 'string' && project.id && typeof project.name === 'string' && project.name.trim()
    && typeof project.workspace === 'string' && project.workspace.trim() && all.findIndex(item => item?.id === project.id) === index)
    .map(project => ({ id: project.id, name: project.name.trim().slice(0, 60), workspace: project.workspace.trim(),
      ...(typeof project.assistSessionId === 'string' ? { assistSessionId: project.assistSessionId } : {}),
      ...(typeof project.goalSessionId === 'string' ? { goalSessionId: project.goalSessionId } : {}) }));
  for (const session of sessions) {
    let project = projects.find(item => item.id === session.projectId);
    if (!project && session.workspace) {
      project = projects.find(item => item.workspace === session.workspace);
      if (!project) { project = { id: randomUUID(), name: require('node:path').basename(session.workspace) || '项目', workspace: session.workspace }; projects.push(project); }
    }
    if (project) { session.projectId = project.id; session.workspace = project.workspace; }
    else delete session.projectId;
  }
  return { version: STORAGE_VERSION, activeMode, currentIds, sessions, projects };
}

/**
 * Workspace-local conversation store and native session tree.
 * Mutations are serialized and exposed only after persistence succeeds.
 * @param {typeof import('vscode')} vscode
 * @param {import('vscode').ExtensionContext} context
 * @param {(session: object) => (void | Promise<void>)} [onDidChange]
 */
function createSessions(vscode, context, onDidChange, { isBusy = () => false, createWorkspace } = {}) {
  const emitter = new vscode.EventEmitter();
  const stored = context.workspaceState.get(STORAGE_KEY);
  let state = restoreState(stored, context.workspaceState.get('conversation', []));
  let queue = Promise.resolve();
  let disposed = false;
  const runningSessions = new Set();
  // History arrays are replaced by mutations; identity is a safe budget cache.
  // A WeakMap drops old history when neither state nor snapshots retain it.
  const messageBudgets = new WeakMap();
  function messageBytes(messages) {
    let bytes = messageBudgets.get(messages);
    if (bytes === undefined) { bytes = Buffer.byteLength(JSON.stringify(messages)); messageBudgets.set(messages, bytes); }
    return bytes;
  }

  function current() {
    return snapshot(selected());
  }

  function list(mode = state.activeMode) {
    requireMode(mode);
    return state.sessions.filter(session => session.mode === mode).map(snapshot);
  }

  function history() { return list().filter(session => !session.placeholder); }

  // UI headers and streaming notifications only need identity and a count.
  // Avoid copying every message in every conversation just to read these.
  function summary() {
    const session = selected();
    return { id: session.id, title: session.title, mode: session.mode,
      ...(session.workspace ? { workspace: session.workspace } : {}), ...(session.projectId ? { projectId: session.projectId } : {}),
      historyCount: state.sessions.reduce((count, item) => count + Number(item.mode === state.activeMode && !item.placeholder), 0) };
  }

  function selected(expectedSessionId) {
    const currentId = state.currentIds[state.activeMode];
    if (expectedSessionId !== undefined && expectedSessionId !== currentId) {
      throw new Error('会话已切换，请在当前会话中重新操作。');
    }
    return state.sessions.find(session => session.mode === state.activeMode && session.id === currentId);
  }

  function selectedGoal(expectedSessionId) {
    const session = selected(expectedSessionId);
    if (session.mode !== 'goal') throw new Error('目标操作仅可在探索模式中进行。');
    return session;
  }

  function enqueue(operation) {
    const pending = queue.then(() => {
      if (disposed) throw new Error('会话列表已关闭。');
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  async function commit(next) {
    next = { ...next, projects: next.projects.map(project => ({ ...project })) };
    if (createWorkspace) {
      const projectsById = new Map(next.projects.map(project => [project.id, project]));
      const sessions = [];
      for (const session of next.sessions) {
        const project = projectsById.get(session.projectId);
        sessions.push(project ? session.workspace === project.workspace ? session : { ...session, workspace: project.workspace } : session.workspace ? session : { ...session, workspace: await createWorkspace(session.id) });
      }
      next = { ...next, sessions };
    }
    next = { ...next, sessions: next.sessions.map(session => {
      if (session.projectId || !session.workspace) return session;
      let project = next.projects.find(item => item.workspace === session.workspace);
      if (!project) {
        project = { id: randomUUID(), name: require('node:path').basename(session.workspace) || '项目', workspace: session.workspace };
        next.projects.push(project);
      }
      return { ...session, projectId: project.id };
    }) };
    const sessionsById = new Map(next.sessions.map(session => [session.id, session]));
    next = { ...next, projects: next.projects.map(project => {
      const remembered = { ...project };
      for (const mode of ['assist', 'goal']) {
        const key = mode + 'SessionId', session = sessionsById.get(next.currentIds[mode]);
        if (session?.projectId === project.id) remembered[key] = session.id;
        const saved = sessionsById.get(remembered[key]);
        if (!saved || saved.mode !== mode || saved.projectId !== project.id) delete remembered[key];
      }
      return remembered;
    }) };
    let totalMessageBytes = next.sessions.reduce((total, session) => total + messageBytes(session.messages), 0);
    if (totalMessageBytes > MAX_ALL_MESSAGE_BYTES) {
      const sessions = next.sessions.map(snapshot);
      for (const session of [...sessions].reverse()) {
        while (session.messages.length && totalMessageBytes > MAX_ALL_MESSAGE_BYTES) {
          const old = session.messages.shift();
          // Removing the last item leaves []: there is no comma to subtract.
          totalMessageBytes -= Buffer.byteLength(JSON.stringify(old)) + (session.messages.length ? 1 : 0);
          session.historyTruncated = true;
        }
        if (totalMessageBytes <= MAX_ALL_MESSAGE_BYTES) break;
      }
      next = { ...next, sessions };
    }
    await context.workspaceState.update(STORAGE_KEY, { ...next, currentIds: { ...next.currentIds }, sessions: next.sessions.map(snapshot) });
    state = next;
    for (const id of runningSessions) if (!state.sessions.some(session => session.id === id)) runningSessions.delete(id);
    if (!disposed) {
      emitter.fire(undefined);
      await onDidChange?.(current());
    }
    return current();
  }

  function commitSession(session) {
    return commit({ ...state, sessions: [{ ...session, placeholder: false }, ...state.sessions.filter(item => item.id !== session.id)] });
  }

  const provider = {
    onDidChangeTreeData: emitter.event,
    getParent(element) {
      if (!element || element.kind === 'project' || !element.projectId) return undefined;
      const project = state.projects.find(item => item.id === element.projectId);
      return project ? { ...project, kind: 'project' } : undefined;
    },
    getChildren(element) {
      if (element) {
        if (element.kind !== 'project') return [];
        const modeRank = mode => mode === state.activeMode ? 0 : 1;
        return state.sessions.filter(session => session.projectId === element.id && !session.placeholder)
          .sort((left, right) => modeRank(left.mode) - modeRank(right.mode) || (right.updatedAt || 0) - (left.updatedAt || 0))
          .map(session => ({ id: session.id, title: session.title, mode: session.mode, projectId: session.projectId, messageCount: session.messages.length, updatedAt: session.updatedAt }));
      }
      const currentProjectId = selected().projectId;
      const projectActivity = id => state.sessions.reduce((latest, session) => session.projectId === id && !session.placeholder
        ? Math.max(latest, session.updatedAt || 0) : latest, 0);
      const projects = state.projects.map(project => ({ ...project, kind: 'project' }))
        .sort((left, right) => {
          const activeDelta = (right.id === currentProjectId ? 1 : 0) - (left.id === currentProjectId ? 1 : 0);
          if (activeDelta) return activeDelta;
          return projectActivity(right.id) - projectActivity(left.id) || String(left.name).localeCompare(String(right.name), 'zh');
        });
      return [...projects,
        ...state.sessions.filter(session => session.mode === state.activeMode && !session.projectId && !session.placeholder).map(snapshot)];
    },
    getTreeItem(session) {
      if (session.kind === 'project') {
        const members = state.sessions.filter(entry => entry.projectId === session.id);
        const visible = members.filter(entry => !entry.placeholder);
        const active = members.some(entry => entry.id === state.currentIds[state.activeMode]);
        const busy = members.filter(entry => isBusy(entry.id)).length;
        const assist = members.filter(entry => entry.mode === 'assist' && !entry.placeholder).length;
        const goal = members.filter(entry => entry.mode === 'goal' && !entry.placeholder).length;
        const folder = path.basename(session.workspace) || session.workspace;
        const item = new vscode.TreeItem(session.name, active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = 'project-' + session.id; item.contextValue = 'ubovm.project';
        item.iconPath = new vscode.ThemeIcon(active ? 'folder-opened' : 'folder');
        item.tooltip = `${session.name}\n${session.workspace}\n${assist} 个协助会话 · ${goal} 个探索会话${busy ? `\n${busy} 个会话运行中` : ''}\n点击切换到此项目`;
        item.description = `${folder} · ${visible.length} 个会话${active ? ' · 当前' : ''}${busy ? ` · ${busy} 运行中` : ''}`;
        item.accessibilityInformation = { label: `${session.name}${active ? '，当前项目' : ''}，${visible.length} 个会话${busy ? `，${busy} 个运行中` : ''}，${session.workspace}` };
        item.command = { command: 'ubovm.openProject', title: '打开项目', arguments: [session.id] };
        return item;
      }
      const selected = session.mode === state.activeMode && session.id === state.currentIds[state.activeMode];
      const running = isBusy(session.id);
      // Remember what the tree actually displayed, including an initial read
      // that preceded the first execution notification.
      if (running) runningSessions.add(session.id); else runningSessions.delete(session.id);
      const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
      item.id = session.id;
      item.iconPath = new vscode.ThemeIcon(running ? 'loading~spin' : selected ? 'circle-filled' : session.mode === 'goal' ? 'target' : 'comment');
      item.contextValue = selected ? 'ubovm.currentConversation' : 'ubovm.conversation';
      const modeLabel = session.mode === 'goal' ? '探索' : '协助';
      const modeTitle = modeLabel + '模式';
      const messageCount = session.messageCount ?? session.messages.length;
      item.description = `${modeLabel} · ${messageCount}`;
      item.tooltip = `${session.title}\n${selected ? '当前会话 · ' : ''}${running ? '运行中 · ' : ''}${modeTitle} · ${messageCount} 条消息`;
      item.accessibilityInformation = { label: `${session.title}${selected ? '，当前会话' : ''}${running ? '，运行中' : ''}，${modeTitle}，${messageCount} 条消息` };
      item.command = { command: 'ubovm.selectConversation', title: '打开会话', arguments: [session.id] };
      return item;
    }
  };

  // Keep the legacy key as a fallback until the new state has been persisted.
  // New sessions always read from STORAGE_KEY once migration has completed.
  const ready = enqueue(() => commit(state));

  return {
    ready,
    refreshRunning(id) {
      if (disposed || !state.sessions.some(session => session.id === id)) return;
      const running = isBusy(id);
      if (runningSessions.has(id) === running) return;
      if (running) runningSessions.add(id); else runningSessions.delete(id);
      // Refresh on transitions only, not on every streamed token. This also
      // updates background sessions without publishing the active chat again.
      emitter.fire();
    },
    current,
    summary,
    goalSummaries: () => state.sessions.filter(session => session.mode === 'goal' && session.goal).map(session => ({ id: session.id, title: session.goal.objective || session.title })),
    ids: () => state.sessions.map(session => session.id),
    get(id) {
      const session = state.sessions.find(item => item.id === id);
      return session ? snapshot(session) : undefined;
    },
    list,
    related(id) {
      const source = state.sessions.find(item => item.id === id);
      if (!source) return [];
      return state.sessions.filter(item => source.mode === 'assist'
        ? item.mode === 'goal' && item.sourceConversationId === id
        : item.mode === 'assist' && item.id === source.sourceConversationId)
        .map(item => ({ id: item.id, title: item.title, mode: item.mode }));
    },
    createLinkedGoal(sourceId, input, signal) {
      const draft = structuredClone(input);
      return enqueue(async () => {
        signal?.throwIfAborted();
        const source = state.sessions.find(item => item.id === sourceId && item.mode === 'assist');
        if (!source) throw new Error('来源聊天已不存在。');
        const key = requireText(draft?.request_key, 200, '请求标识');
        const objective = requireText(draft.objective, MAX_OBJECTIVE_LENGTH, '目标');
        const initialFacts = draft.context === undefined ? '' : requireText(draft.context, 8000, '目标背景');
        if (!Array.isArray(draft.criteria) || draft.criteria.length > MAX_CRITERIA) throw new Error('验收标准必须为数组，最多 20 条。');
        const texts = draft.criteria.map(text => requireText(text, MAX_CRITERION_LENGTH, '验收标准'));
        const fingerprint = goalRequestFingerprint(objective, initialFacts, texts);
        const existing = state.sessions.find(item => item.mode === 'goal' && item.sourceConversationId === sourceId && item.goalRequestKey === key);
        if (existing) {
          const original = existing.goalRequestFingerprint ?? goalRequestFingerprint(existing.goal.objective, existing.goal.initialFacts, existing.goal.criteria.map(item => item.text));
          if (original !== fingerprint) throw new Error('请求标识已用于不同目标，请使用新的标识。');
          return snapshot(existing);
        }
        if (state.sessions.filter(item => item.mode === 'goal').length >= MAX_SESSIONS) throw new Error('目标数量已达到上限，请先清理不再需要的目标。');
        const session = newSession([], 'goal');
        session.goal = { objective, initialFacts, criteria: texts.map(text => ({ id: randomUUID(), text, done: false })), notes: [], createdAt: session.createdAt, updatedAt: session.updatedAt };
        Object.assign(session, { title: goalTitle(session.goal), placeholder: false, sourceConversationId: sourceId, goalRequestKey: key, goalRequestFingerprint: fingerprint,
          ...(source.workspace ? { workspace: source.workspace } : {}), ...(source.projectId ? { projectId: source.projectId } : {}) });
        await commit({ ...state, sessions: [session, ...state.sessions.map(item => item.id === sourceId ? { ...item, placeholder: false } : item)] });
        return snapshot(session);
      });
    },
    openRelated(sourceId, targetId) {
      return enqueue(() => {
        selected(sourceId);
        const source = state.sessions.find(item => item.id === sourceId);
        const target = state.sessions.find(item => item.id === targetId);
        if (!target || !(source.mode === 'assist' && target.sourceConversationId === sourceId || target.mode === 'assist' && source.sourceConversationId === targetId)) throw new Error('关联会话已不存在。');
        return commit({ ...state, activeMode: target.mode, currentIds: { ...state.currentIds, [target.mode]: target.id } });
      });
    },
    history,
    search(query = '') {
      const terms = String(query).normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      return history().filter(session => {
        const text = [session.title, ...session.messages.map(message => message.text), session.goal?.objective, session.goal?.initialFacts,
          ...(session.goal?.criteria || []).map(item => item.text), ...(session.goal?.notes || []).map(item => item.text)]
          .filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase();
        return terms.every(term => text.includes(term));
      });
    },
    activeMode: () => state.activeMode,
    setWorkspace(workspace, expectedSessionId) {
      return enqueue(() => {
        const session = selected(expectedSessionId);
        if (state.sessions.some(item => (item.id === session.id || session.projectId && item.projectId === session.projectId) && isBusy(item.id))) throw new Error('请先停止项目中运行的会话，再切换工作空间。');
        if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('请选择工作空间。');
        const existing = state.projects.find(project => project.id !== session.projectId && workspaceKey(project.workspace) === workspaceKey(workspace.trim()));
        if (existing) throw new Error(`该目录已属于项目“${existing.name}”，请在该项目中创建会话。`);
        if (session.workspace && workspaceKey(session.workspace) === workspaceKey(workspace.trim())) return current();
        if (session.projectId) return commit({ ...state,
          projects: state.projects.map(item => item.id === session.projectId ? { ...item, workspace: workspace.trim() } : item),
          sessions: state.sessions.map(item => item.projectId === session.projectId ? { ...item, workspace: workspace.trim(), updatedAt: Date.now() } : item) });
        return commitSession({ ...session, workspace: workspace.trim(), updatedAt: Date.now() });
      });
    },
    provider,
    projects: () => state.projects.map(project => ({ ...project })),
    projectForWorkspace(workspace) {
      if (typeof workspace !== 'string' || !workspace.trim()) return undefined;
      const project = state.projects.find(project => workspaceKey(project.workspace) === workspaceKey(workspace.trim()));
      return project ? { ...project } : undefined;
    },
    projectSessions: id => state.sessions.filter(session => session.projectId === id).map(session => ({ id: session.id, title: session.title, mode: session.mode, updatedAt: session.updatedAt })),
    selectProject(id) {
      return enqueue(() => {
        const project = state.projects.find(project => project.id === id);
        if (!project) throw new Error('项目已不存在。');
        if (selected().projectId === id) return current();
        let session = state.sessions.find(session => session.id === project[state.activeMode + 'SessionId'] && session.mode === state.activeMode && session.projectId === id)
          || state.sessions.find(session => session.mode === state.activeMode && session.projectId === id);
        let sessions = state.sessions;
        if (!session) {
          if (sessions.filter(session => session.mode === state.activeMode).length >= MAX_SESSIONS) throw new Error('会话数量已达到上限，请先清理会话。');
          session = { ...newSession([], state.activeMode), placeholder: false, projectId: id, workspace: project.workspace };
          sessions = [session, ...sessions];
        } else {
          const openedAt = Date.now();
          sessions = sessions.map(item => item.id === session.id ? { ...item, updatedAt: openedAt } : item);
          session = sessions.find(item => item.id === session.id);
        }
        return commit({ ...state, sessions, currentIds: { ...state.currentIds, [state.activeMode]: session.id } });
      });
    },
    createProject(name, workspace) {
      return enqueue(() => {
        name = requireText(name, 60, '项目名称'); workspace = requireText(workspace, 32000, '项目目录');
        if (!path.isAbsolute(workspace) && !path.win32.isAbsolute(workspace)) throw new Error('请选择项目目录的完整路径。');
        const existing = state.projects.find(project => workspaceKey(project.workspace) === workspaceKey(workspace));
        if (existing) throw new Error(`该目录已属于项目“${existing.name}”，请在该项目中创建会话。`);
        const project = { id: randomUUID(), name, workspace };
        const session = { ...newSession([], state.activeMode), placeholder: false, projectId: project.id, workspace };
        if (state.sessions.filter(session => session.mode === state.activeMode).length >= MAX_SESSIONS) throw new Error('会话数量已达到上限，请先清理会话。');
        return commit({ ...state, projects: [project, ...state.projects], sessions: [session, ...state.sessions], currentIds: { ...state.currentIds, [state.activeMode]: session.id } });
      });
    },
    renameProject(id, name) {
      return enqueue(() => {
        const project = state.projects.find(project => project.id === id);
        if (!project) throw new Error('项目已不存在。');
        name = requireText(name, 60, '项目名称');
        if (project.name === name) return current();
        return commit({ ...state, projects: state.projects.map(project => project.id === id ? { ...project, name } : project) });
      });
    },
    removeProject(id, { expectedSessionIds } = {}) {
      return enqueue(() => {
        if (!state.projects.some(project => project.id === id)) throw new Error('项目已不存在。');
        const removed = state.sessions.filter(session => session.projectId === id);
        if (expectedSessionIds && (expectedSessionIds.length !== removed.length || removed.some(session => !expectedSessionIds.includes(session.id)))) throw new Error('项目会话已变化，请重新确认删除。');
        if (removed.some(session => isBusy(session.id))) throw new Error('项目中有会话正在运行，请先停止后再删除。');
        const removedIds = new Set(removed.map(session => session.id));
        const remaining = state.sessions.filter(session => !removedIds.has(session.id));
        const currentIds = { ...state.currentIds };
        for (const mode of ['assist', 'goal']) {
          if (!removedIds.has(currentIds[mode])) continue;
          let next = remaining.find(session => session.mode === mode);
          if (!next && mode === state.activeMode) { next = newSession([], mode); remaining.unshift(next); }
          currentIds[mode] = next?.id ?? null;
        }
        return commit({ ...state, projects: state.projects.filter(project => project.id !== id), sessions: remaining, currentIds });
      });
    },
    create(mode, projectId) {
      return enqueue(() => {
        const requestedMode = requireMode(mode === undefined ? state.activeMode : mode);
        if (requestedMode !== state.activeMode) throw new Error('请先切换模式，再新建该模式的会话。');
        const session = newSession([], state.activeMode);
        const targetProject = projectId === undefined ? selected().projectId : projectId;
        if (targetProject) {
          const project = state.projects.find(item => item.id === targetProject);
          if (!project) throw new Error('项目已不存在。');
          session.projectId = project.id; session.workspace = project.workspace;
        }
        session.placeholder = false;
        const sameMode = [session, ...state.sessions.filter(item => item.mode === state.activeMode)];
        while (sameMode.length > MAX_SESSIONS) {
          const removable = sameMode.findLastIndex(item => item.id !== session.id && !isBusy(item.id));
          if (removable < 0) throw new Error('运行中的会话已达到上限，请先停止或完成一个会话。');
          sameMode.splice(removable, 1);
        }
        const otherMode = state.sessions.filter(item => item.mode !== state.activeMode);
        return commit({
          ...state,
          currentIds: { ...state.currentIds, [state.activeMode]: session.id },
          sessions: [...sameMode, ...otherMode]
        });
      });
    },
    select(id, { crossMode = false } = {}) {
      return enqueue(() => {
        const session = state.sessions.find(item => item.id === id);
        if (!session) throw new Error('此会话已不存在。');
        if (session.mode !== state.activeMode && !crossMode) throw new Error('请先切换到此会话所属的模式。');
        if (session.mode === state.activeMode && state.currentIds[session.mode] === id) return current();
        return commit({ ...state, activeMode: session.mode, currentIds: { ...state.currentIds, [session.mode]: id } });
      });
    },
    remove(id) {
      return enqueue(() => {
        const removed = state.sessions.find(item => item.id === id);
        if (!removed) throw new Error('此会话已不存在。');
        if (isBusy(id)) throw new Error('此会话正在运行，请先停止后再删除。');
        const remaining = state.sessions.filter(item => item.id !== id);
        const currentIds = { ...state.currentIds };
        if (currentIds[removed.mode] === id) {
          let next = remaining.find(item => item.mode === removed.mode);
          if (!next && removed.mode === state.activeMode) { next = newSession([], removed.mode); remaining.unshift(next); }
          currentIds[removed.mode] = next?.id ?? null;
        }
        return commit({ ...state, currentIds, sessions: remaining });
      });
    },
    saveMessages(messages) {
      const normalized = cleanMessages(messages);
      return enqueue(() => {
        const existing = selected();
        // Goals keep their objective as the title, independently of their own
        // discussion. Assist titles survive messages rolling out of history.
        const hasUserMessage = existing.messages.some(message => message.role === 'user' && message.text.trim());
        const updated = {
          ...existing,
          title: existing.mode === 'goal' && existing.goal ? goalTitle(existing.goal, '新探索')
            : hasUserMessage ? existing.title : titleFrom(normalized, existing.title),
          messages: normalized,
          updatedAt: Date.now()
        };
        return commitSession(updated);
      });
    },
    beginSteering(id, inputId) {
      return enqueue(() => {
        const existing = state.sessions.find(session => session.id === id);
        const item = existing?.inputQueue?.find(input => input.id === inputId);
        if (existing?.mode !== 'assist' || !item || item.delivery) throw new Error('该输入已开始发送或已从队列移除。');
        const previous = existing.messages.find(message => message.id === inputId);
        if (previous && (previous.role !== 'user' || previous.text !== item.text)) throw new Error('重复消息标识对应不同内容。');
        return commitSession({ ...existing, updatedAt: Date.now(),
          messages: previous ? existing.messages.map(message => message.id === inputId ? { ...message, steeringStatus: 'sending' } : message)
            : cleanMessages([...existing.messages, { id: inputId, role: 'user', text: item.text, steeringStatus: 'sending' }]),
          inputQueue: existing.inputQueue.map(input => input.id === inputId ? { ...input, delivery: 'sending', steeringAddedMessage: !previous } : input) });
      });
    },
    finishSteering(id, inputId, outcome) {
      return enqueue(() => {
        if (!['accepted', 'rejected', 'uncertain'].includes(outcome)) throw new Error('无效的引导状态。');
        const existing = state.sessions.find(session => session.id === id);
        const item = existing?.inputQueue?.find(input => input.id === inputId);
        if (!item || item.delivery !== 'sending') throw new Error('引导发送状态已变化。');
        const { delivery, steeringAddedMessage, ...restored } = item;
        return commitSession({ ...existing, updatedAt: Date.now(),
          ...(outcome !== 'accepted' ? { queuePaused: true } : {}),
          messages: outcome === 'rejected' && steeringAddedMessage ? existing.messages.filter(message => message.id !== inputId)
            : existing.messages.map(message => {
              if (message.id !== inputId) return message;
              const { steeringStatus, ...plain } = message;
              return outcome === 'rejected' ? plain : { ...plain, steeringStatus: outcome };
            }),
          inputQueue: outcome === 'accepted' ? existing.inputQueue.filter(input => input.id !== inputId)
            : existing.inputQueue.map(input => input.id === inputId ? { ...restored, ...(outcome === 'uncertain' ? { delivery: 'uncertain' } : {}) } : input) });
      });
    },
    updateInputQueue(id, mutation) {
      return enqueue(() => {
        const existing = state.sessions.find(session => session.id === id);
        if (!existing || existing.mode !== 'assist') throw new Error('协助会话已不存在。');
        const changes = mutation(snapshot(existing));
        return commitSession({ ...existing, ...changes, updatedAt: Date.now() });
      });
    },
    rewindInput(id, messageId) {
      return enqueue(() => {
        const existing = state.sessions.find(session => session.id === id);
        if (!existing || existing.mode !== 'assist' || isBusy(id)) throw new Error('请等待 Agent 停止后再回退。');
        const messageIds = inputMessageIds(existing.messages, 'user');
        const index = existing.messages.findIndex((message, index) => message.role === 'user' && messageIds[index] === messageId);
        if (index < 0) throw new Error('该用户消息已不存在。');
        return commitSession({ ...existing, messages: existing.messages.slice(0, index), queuePaused: true,
          executionBranch: randomUUID(), updatedAt: Date.now() });
      });
    },
    appendMessage(id, message) {
      const normalized = cleanMessages([message]);
      if (normalized.length !== 1) return Promise.reject(new Error('消息格式无效。'));
      return enqueue(() => {
        // Background replies belong to their original conversation, even after
        // the user navigates to a different mode or creates another session.
        const existing = state.sessions.find(session => session.id === id);
        if (!existing) throw new Error('回复所属的会话已不存在。');
        if (normalized[0].id) {
          const previous = existing.messages.find(message => message.id === normalized[0].id);
          if (previous) {
            if (previous.role !== normalized[0].role || previous.text !== normalized[0].text || JSON.stringify(previous.parts ?? []) !== JSON.stringify(normalized[0].parts ?? [])) throw new Error('重复消息标识对应不同内容。');
            return current();
          }
        }
        const messages = cleanMessages([...existing.messages, normalized[0]]);
        const hasUser = existing.messages.some(item => item.role === 'user' && item.text.trim());
        return commitSession({ ...existing, messages, updatedAt: Date.now(),
          title: existing.mode === 'goal' && existing.goal ? goalTitle(existing.goal, '新探索')
            : hasUser ? existing.title : titleFrom(messages, existing.title)
        });
      });
    },
    setMode(mode, expectedSessionId) {
      return enqueue(() => {
        selected(expectedSessionId);
        requireMode(mode);
        if (mode === state.activeMode) return current();
        const remembered = state.currentIds[mode];
        let session = state.sessions.find(item => item.mode === mode && item.id === remembered);
        session ||= state.sessions.find(item => item.mode === mode);
        const sessions = [...state.sessions];
        if (!session) {
          session = newSession([], mode);
          sessions.unshift(session);
        }
        return commit({ ...state, activeMode: mode, currentIds: { ...state.currentIds, [mode]: session.id }, sessions });
      });
    },
    saveGoal(value, expectedSessionId) {
      // Capture editable fields before this operation waits for earlier saves.
      const draft = value && {
        objective: value.objective,
        initialFacts: value.initialFacts,
        criteria: Array.isArray(value.criteria) ? value.criteria.map(item => item && ({ id: item.id, text: item.text })) : value.criteria
      };
      return enqueue(() => {
        const existing = selectedGoal(expectedSessionId);
        const objective = requireText(draft?.objective, MAX_OBJECTIVE_LENGTH, '目标');
        const facts = draft.initialFacts === undefined ? existing.goal?.initialFacts ?? '' : draft.initialFacts;
        if (typeof facts !== 'string' || facts.trim().length > 8000) throw new Error('初始事实必须为文本，最多 8000 字。');
        const initialFacts = facts.trim();
        const items = draft.criteria === undefined ? [] : draft.criteria;
        if (!Array.isArray(items) || items.length > MAX_CRITERIA) throw new Error(`验收标准最多 ${MAX_CRITERIA} 条。`);
        const seen = new Set();
        const criteria = items.map(item => {
          const text = requireText(item?.text, MAX_CRITERION_LENGTH, '验收标准');
          if (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim())) throw new Error('验收标准标识无效。');
          const id = item.id === undefined ? randomUUID() : item.id;
          if (seen.has(id)) throw new Error('验收标准标识不能重复。');
          seen.add(id);
          const previous = existing.goal?.criteria.find(criterion => criterion.id === id && criterion.text === text);
          return { id, text, done: previous?.done === true };
        });
        const now = Date.now();
        const goal = {
          objective, initialFacts, criteria, notes: existing.goal?.notes.map(note => ({ ...note })) || [],
          createdAt: existing.goal?.createdAt ?? now, updatedAt: now
        };
        return commitSession({
          ...existing, goal, updatedAt: now,
          title: goalTitle(goal, '新探索')
        });
      });
    },
    toggleGoalCriterion(id, done, expectedSessionId) {
      return enqueue(() => {
        const existing = selectedGoal(expectedSessionId);
        if (typeof done !== 'boolean') throw new Error('验收标准完成状态必须为布尔值。');
        if (!existing.goal?.criteria.some(criterion => criterion.id === id)) throw new Error('此验收标准已不存在。');
        const now = Date.now();
        const goal = {
          ...existing.goal, updatedAt: now,
          criteria: existing.goal.criteria.map(criterion => criterion.id === id ? { ...criterion, done } : { ...criterion })
        };
        return commitSession({ ...existing, goal, updatedAt: now });
      });
    },
    addGoalNote(text, expectedSessionId) {
      return enqueue(() => {
        const existing = selectedGoal(expectedSessionId);
        if (!existing.goal) throw new Error('请先保存目标，再添加备注。');
        const note = { id: randomUUID(), text: requireText(text, MAX_NOTE_LENGTH, '备注'), createdAt: Date.now() };
        const goal = { ...existing.goal, updatedAt: note.createdAt, notes: [...existing.goal.notes, note].slice(-MAX_NOTES) };
        return commitSession({ ...existing, goal, updatedAt: note.createdAt });
      });
    },
    dispose() {
      disposed = true;
      runningSessions.clear();
      emitter.dispose();
    }
  };
}

module.exports = { createSessions, cleanTimelineParts, formatToolValue, redactDisplayObject, inputMessageId, inputMessageIds };
