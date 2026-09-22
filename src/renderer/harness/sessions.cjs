'use strict';

const { randomUUID } = require('node:crypto');

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
const REDACTED = '[REDACTED]';
const secretField = key => /^(?:token|auth|cookie|setcookie)$/i.test(key.replace(/[^a-z0-9]/gi, '')) || /api.?key|authorization|password|passwd|private.?key|secret|credential|access.?token|refresh.?token|session.?token/i.test(key);
function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g, REDACTED)
    .replace(/(https?:\/\/[^\s/:]+:)[^\s/@]+(@)/g, `$1${REDACTED}$2`)
    .replace(/\b(authorization|proxy-authorization)["']?\s*[:=]\s*(?:["']?)(?:Bearer|Basic)?\s*[^\r\n,;"'}]+/gi, `$1: ${REDACTED}`)
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|token)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, `$1=${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_~.=-]{8,}/gi, `$1 ${REDACTED}`);
}
function safeDisplay(value, depth = 0, seen = new Set()) {
  if (depth > 8) return '[Nested content omitted]';
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return safeDisplay(parsed, depth + 1, seen); } catch {}
    return redactText(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (seen.has(value)) return '[Circular content omitted]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 100).map(item => safeDisplay(item, depth + 1, seen));
    if (value.length > 100) result.push('[Additional items omitted]');
  } else {
    result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (['thinking', 'thoughtSignature', 'thinkingSignature'].includes(key)) continue;
      result[key.slice(0, 200)] = secretField(key) ? REDACTED : safeDisplay(item, depth + 1, seen);
    }
    if (Object.keys(value).length > 100) result['[truncated]'] = 'Additional fields omitted';
  }
  seen.delete(value); return result;
}
function clipped(value, maximum, marker = '\n[内容已截断]') { return value.length <= maximum ? value : value.slice(0, Math.max(0, maximum - marker.length)) + marker.slice(0, maximum); }
function formatToolValue(value, maximum = 12000) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) value = value.content.flatMap(part => part?.type === 'text' ? [safeDisplay(part.text)] : part?.type === 'image' ? ['[Image result]'] : []).map(part => typeof part === 'string' ? part : JSON.stringify(part, null, 2)).join('\n');
  const safe = safeDisplay(value), text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
  return { text: clipped(text, maximum), truncated: text.length > maximum };
}
function redactDisplayObject(value, depth = 0) {
  if (typeof value === 'string') return formatToolValue(value, 64000).text;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 10) return '[Nested content omitted]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactDisplayObject(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).filter(([key]) => !['thinking', 'thoughtSignature', 'thinkingSignature'].includes(key)).map(([key, item]) => [key, secretField(key) ? REDACTED : redactDisplayObject(item, depth + 1)]));
}
/** Bounded, detached and credential-redacted UI projections only; never model context. */
function cleanTimelineParts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(); let parts = [];
  for (const part of value) {
    if (!part || typeof part.id !== 'string' || !part.id || part.id.length > 200 || seen.has(part.id)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ id: part.id, type: 'text', text: clipped(redactText(part.text), MAX_ASSISTANT_MESSAGE_LENGTH), status: part.status === 'streaming' ? 'streaming' : 'completed' });
    } else if (['thinking', 'summary'].includes(part.type) && typeof part.text === 'string' && (part.text.trim() || part.type === 'summary') && part.redacted !== true && (part.type === 'summary' ? ['running', 'completed', 'interrupted', 'failed'] : ['running', 'completed', 'interrupted']).includes(part.status) && ['assistant', 'reason', 'worker'].includes(part.source)) {
      const text = redactText(part.text), startedAt = Number.isFinite(part.startedAt) && part.startedAt >= 0 ? part.startedAt : 0;
      // This whitelist persists only the provider's displayable plaintext.
      // Provider signatures and encrypted/redacted blocks never enter the UI.
      parts.push({ id: part.id, type: part.type, text: clipped(text, 12000), status: part.status, source: part.source, startedAt,
        ...(part.type === 'summary' ? { fallback: part.fallback === true,
          ...Object.fromEntries(['beforeTokens', 'afterTokens'].filter(key => Number.isSafeInteger(part[key]) && part[key] >= 0).map(key => [key, part[key]])) } : {}),
        ...(Number.isFinite(part.endedAt) && part.endedAt >= startedAt ? { endedAt: part.endedAt } : {}),
        ...(typeof part.workerId === 'string' && part.workerId ? { workerId: part.workerId.slice(0, 200) } : {}),
        ...(part.truncated || text.length > 12000 ? { truncated: true } : {}) });
    } else if (part.type === 'tool' && typeof part.name === 'string' && part.name && ['running', 'completed', 'failed', 'interrupted'].includes(part.status)) {
      const args = formatToolValue(part.args ?? '', 4000), output = formatToolValue(part.output ?? '', 12000);
      const startedAt = Number.isFinite(part.startedAt) && part.startedAt >= 0 ? part.startedAt : 0;
      parts.push({ id: part.id, type: 'tool', name: redactText(part.name).slice(0, 128), status: part.status, args: args.text, output: output.text, startedAt,
        ...(Number.isFinite(part.endedAt) && part.endedAt >= startedAt ? { endedAt: part.endedAt } : {}),
        ...(typeof part.workerId === 'string' && part.workerId ? { workerId: part.workerId.slice(0, 200) } : {}),
        ...(part.truncated || args.truncated || output.truncated ? { truncated: true } : {}) });
    } else continue;
    seen.add(part.id);
  }
  return parts.filter(part => part.type !== 'thinking' || part.text.trim());
}

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
        ? text.slice(0, limit - marker.length) + marker : text.slice(0, limit), ...(parts.length ? { parts } : {}) };
    });
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_SESSION_MESSAGE_BYTES) messages.shift();
  return messages;
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
  return { ...session, messages: session.messages.map(message => ({ ...message, ...(message.parts ? { parts: message.parts.map(part => ({ ...part })) } : {}) })), goal: goalSnapshot(session.goal) };
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
    const messages = cleanMessages(session.messages);
    const goal = cleanGoal(session.goal);
    const mode = session.mode === 'goal' ? 'goal' : 'assist';
    const title = typeof session.title === 'string' && session.title.trim() ? session.title.slice(0, 60)
      : mode === 'goal' ? goalTitle(goal, titleFrom(messages, '新探索')) : titleFrom(messages);
    const base = {
      id: session.id, title, messages, placeholder: session.placeholder === true && messages.length === 0 && !goal,
      ...(typeof session.workspace === 'string' && session.workspace.trim() ? { workspace: session.workspace.trim() } : {}),
      ...(session.historyTruncated === true ? { historyTruncated: true } : {}),
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
  return { version: STORAGE_VERSION, activeMode, currentIds, sessions };
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
    if (createWorkspace) {
      const sessions = [];
      for (const session of next.sessions) {
        sessions.push(session.workspace ? session : { ...session, workspace: await createWorkspace(session.id) });
      }
      next = { ...next, sessions };
    }
    let messageBytes = next.sessions.reduce((total, session) => total + Buffer.byteLength(JSON.stringify(session.messages)), 0);
    if (messageBytes > MAX_ALL_MESSAGE_BYTES) {
      const sessions = next.sessions.map(snapshot);
      for (const session of [...sessions].reverse()) {
        while (session.messages.length && messageBytes > MAX_ALL_MESSAGE_BYTES) { const old = session.messages.shift(); messageBytes -= Buffer.byteLength(JSON.stringify(old)) + 1; session.historyTruncated = true; }
        if (messageBytes <= MAX_ALL_MESSAGE_BYTES) break;
      }
      next = { ...next, sessions };
    }
    await context.workspaceState.update(STORAGE_KEY, { ...next, currentIds: { ...next.currentIds }, sessions: next.sessions.map(snapshot) });
    state = next;
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
    getChildren(element) { return element ? [] : history(); },
    getTreeItem(session) {
      const selected = session.mode === state.activeMode && session.id === state.currentIds[state.activeMode];
      const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
      item.id = session.id;
      item.iconPath = new vscode.ThemeIcon(selected ? 'circle-filled' : session.mode === 'goal' ? 'target' : 'comment');
      item.contextValue = selected ? 'ubovm.currentConversation' : 'ubovm.conversation';
      const modeLabel = session.mode === 'goal' ? '探索模式' : '协助模式';
      item.tooltip = `${session.title}\n${selected ? '当前会话 · ' : ''}${modeLabel} · ${session.messages.length} 条消息`;
      item.accessibilityInformation = { label: `${session.title}${selected ? '，当前会话' : ''}，${modeLabel}，${session.messages.length} 条消息` };
      item.command = { command: 'ubovm.selectConversation', title: '打开会话', arguments: [session.id] };
      return item;
    }
  };

  // Keep the legacy key as a fallback until the new state has been persisted.
  // New sessions always read from STORAGE_KEY once migration has completed.
  const ready = enqueue(() => commit(state));

  return {
    ready,
    current,
    summary,
    goalSummaries: () => state.sessions.filter(session => session.mode === 'goal' && session.goal).map(session => ({ id: session.id, title: session.goal.objective || session.title })),
    ids: () => state.sessions.map(session => session.id),
    get(id) {
      const session = state.sessions.find(item => item.id === id);
      return session ? snapshot(session) : undefined;
    },
    list,
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
        if (isBusy(session.id)) throw new Error('请先停止当前会话，再切换工作空间。');
        if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('请选择工作空间。');
        return commitSession({ ...session, workspace: workspace.trim(), updatedAt: Date.now() });
      });
    },
    provider,
    create(mode) {
      return enqueue(() => {
        const requestedMode = requireMode(mode === undefined ? state.activeMode : mode);
        if (requestedMode !== state.activeMode) throw new Error('请先切换模式，再新建该模式的会话。');
        const session = newSession([], state.activeMode);
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
    select(id) {
      return enqueue(() => {
        const session = state.sessions.find(item => item.id === id);
        if (!session) throw new Error('此会话已不存在。');
        if (session.mode !== state.activeMode) throw new Error('请先切换到此会话所属的模式。');
        return commit({ ...state, currentIds: { ...state.currentIds, [state.activeMode]: id } });
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
      emitter.dispose();
    }
  };
}

module.exports = { createSessions, cleanTimelineParts, formatToolValue, redactDisplayObject };
