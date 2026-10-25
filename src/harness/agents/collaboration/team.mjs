import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';

import {
  SPAWN_TEAMMATE_CATALOG, SEND_MESSAGE_CATALOG, LIST_AGENTS_CATALOG, WAIT_AGENT_CATALOG,
  INTERRUPT_AGENT_CATALOG, TEAM_TASK_CREATE_CATALOG, TEAM_TASK_LIST_CATALOG,
  TEAM_TASK_GET_CATALOG, TEAM_TASK_UPDATE_CATALOG,
} from '../../intools/shared/tool-catalogs.mjs';

// Agent Teams: the Lead is the running assist conversation; teammates are
// durable named runs over their own transcripts, coordinated through a
// persisted roster, per-member inboxes and a compare-and-set task board.
const MEMBER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TASK_ID = /^task-(0|[1-9][0-9]*)$/;
const TASK_ACTIONS = new Set(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']);
const DEFAULT_LIMITS = { maxMembers: 16, maxTasks: 256, maxMessageBytes: 65536 };
const MAX_PENDING_MESSAGES = 256;
const MAX_DESCRIPTION = 200;
const MAX_PROMPT = 16384;
const MAX_SUBJECT = 200;
const MAX_TASK_DESCRIPTION = 16384;
const MAX_WRITE_SCOPE = 1024;
const MAX_WRITE_SCOPES = 32;
const MAX_ACTIVITY_LABEL = 200;
const MAX_RESTORED_MEMBERS = 64;
const MAX_RESTORED_TASKS = 512;
const WAIT_MIN_MS = 10000;
const WAIT_MAX_MS = 3600000;
const WAIT_DEFAULT_MS = 30000;
const DISPOSAL_TIMEOUT_MS = 5000;
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.';

const failure = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

function resolveLimits(value) {
  const limits = { ...DEFAULT_LIMITS };
  if (value === undefined || value === null) return limits;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('team limits must be an object');
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new TypeError(`${key} must be a positive integer`);
    limits[key] = value[key];
  }
  return limits;
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw failure('TEAM_INVALID_ARGUMENT', `${field} must be a non-empty string`);
  const text = value.trim();
  if (text.length > maximum) throw failure('TEAM_INVALID_ARGUMENT', `${field} exceeds ${maximum} characters`);
  return text;
}

function optionalTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function taskNumber(id) {
  const match = TASK_ID.exec(id);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function writeScope(value) {
  if (typeof value !== 'string' || value.length > MAX_WRITE_SCOPE) throw failure('TEAM_INVALID_WRITE_SCOPE', 'write scopes must be workspace-relative path prefixes');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw failure('TEAM_INVALID_WRITE_SCOPE', `invalid workspace-relative write scope ${JSON.stringify(value)}`);
  }
  return normalized;
}

function writeScopes(value, field = 'write_scopes') {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WRITE_SCOPES) throw failure('TEAM_INVALID_ARGUMENT', `${field} must be an array of at most ${MAX_WRITE_SCOPES} strings`);
  return [...new Set(value.map(writeScope))];
}

function scopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function formatMessage(from, text) {
  return `Team message from ${from}:\n${text}`;
}

function errorText(error) {
  try {
    return String(error?.message ?? error).slice(0, 500) || 'Agent Team operation failed';
  } catch {
    return 'Agent Team operation failed';
  }
}

function plainText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n');
}

// Streaming partials are UI-only and enormous; Team member events are compact
// activity records, not a second transcript. Tool arguments/results are already
// durable evidence, so they are not duplicated into the Team event stream.
function compactMemberEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return undefined;
  const type = event.type;
  if (type === 'message_update' || type === 'tool_execution_update') return undefined;
  const value = { type };
  for (const key of ['toolCallId', 'toolName', 'role', 'stopReason', 'workerId', 'action']) {
    if (typeof event[key] === 'string') value[key] = event[key].slice(0, 200);
  }
  for (const key of ['isError', 'approved', 'attempt', 'maxAttempts']) {
    if (typeof event[key] === 'boolean' || Number.isSafeInteger(event[key])) value[key] = event[key];
  }
  if (type === 'message_start' || type === 'message_end') {
    const message = event.message;
    if (message && typeof message === 'object') {
      if (typeof message.role === 'string') value.role = message.role.slice(0, 40);
      if (typeof message.stopReason === 'string') value.stopReason = message.stopReason.slice(0, 40);
      const text = plainText(message);
      if (text) value.text = text.slice(0, 500);
    }
  }
  if (event.error && typeof event.error === 'object') {
    value.error = {
      message: boundedText(event.error.message, 500) || 'unknown error',
      ...(typeof event.error.code === 'string' ? { code: event.error.code.slice(0, 80) } : {}),
    };
  } else if (typeof event.errorMessage === 'string') value.errorMessage = event.errorMessage.slice(0, 500);
  return value;
}

function activityFor(event) {
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') return { label: event.toolName.slice(0, MAX_ACTIVITY_LABEL), status: 'running' };
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') return { label: event.toolName.slice(0, MAX_ACTIVITY_LABEL), status: event.isError === true ? 'failed' : 'completed' };
  if (event.type === 'message_start') return { label: '正在回复', status: 'running' };
  if (event.type === 'message_end') return { label: '已回复', status: 'completed' };
  return undefined;
}

/**
 * Durable Agent Team service for one assist conversation turn.
 *
 * `load`/`save` are the session context persistence callbacks; the team state is
 * stored under `team:state`. Teammate transcripts and pending turns are stored
 * by the host run adapter under `team:member:<name>:transcript` and
 * `team:member:<name>:pending-turn`.
 */
export function createTeam({ sessionId, directory, signal, limits = {}, onEvent, onLiveEvent, runMember, load, save, state } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('team requires sessionId');
  if (typeof runMember !== 'function') throw new TypeError('team requires runMember');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (typeof onEvent !== 'undefined' && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  if (typeof onLiveEvent !== 'undefined' && typeof onLiveEvent !== 'function') throw new TypeError('onLiveEvent must be a function');
  if (typeof save !== 'undefined' && typeof save !== 'function') throw new TypeError('save must be a function');
  if (typeof load !== 'undefined' && typeof load !== 'function') throw new TypeError('load must be a function');
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) throw new TypeError('directory must be a non-empty string when supplied');
  const teamLimits = resolveLimits(limits);

  let revision = 0;
  let nextTaskNumber = 1;
  let leadStatus = 'inactive';
  let leadCreatedAt = Date.now();
  let leadUpdatedAt = leadCreatedAt;
  let leadSteering;
  const members = new Map();
  const tasks = [];
  const leadInbox = [];
  const waiters = new Set();
  let closed = false;
  let closePromise;
  let persistTail = Promise.resolve();

  restoreState(state);

  function restoreState(saved) {
    if (saved === undefined || saved === null) return;
    if (typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('Saved team state must be an object');
    if (typeof saved.sessionId === 'string' && saved.sessionId !== sessionId) throw new TypeError('Saved team belongs to another session');
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) revision = saved.revision;
    const leadRow = (Array.isArray(saved.roster) ? saved.roster : []).find(row => row && typeof row === 'object' && row.role === 'lead');
    if (leadRow) {
      leadCreatedAt = optionalTimestamp(leadRow.createdAt) ?? leadCreatedAt;
      leadUpdatedAt = optionalTimestamp(leadRow.updatedAt) ?? leadUpdatedAt;
    }
    for (const row of Array.isArray(saved.roster) ? saved.roster : []) {
      if (!row || typeof row !== 'object' || row.role === 'lead') continue;
      if (members.size >= Math.max(teamLimits.maxMembers, MAX_RESTORED_MEMBERS)) break;
      if (typeof row.name !== 'string' || !MEMBER_NAME.test(row.name) || members.has(row.name)) continue;
      const status = row.status === 'failed' ? 'failed' : 'inactive';
      members.set(row.name, {
        name: row.name,
        role: 'teammate',
        description: boundedText(row.description, MAX_DESCRIPTION) || 'restored teammate',
        context: row.context === 'fork' ? 'fork' : 'fresh',
        status,
        ...(status === 'failed' ? { error: boundedText(row.error, 500) || 'member creation failed' } : {}),
        createdAt: optionalTimestamp(row.createdAt) ?? Date.now(),
        updatedAt: optionalTimestamp(row.updatedAt) ?? Date.now(),
        inbox: [],
        runCount: 0,
      });
    }
    const records = [...(Array.isArray(saved.tasks) ? saved.tasks : []), ...(Array.isArray(saved.tombstones) ? saved.tombstones : [])];
    for (const raw of records) {
      if (!raw || typeof raw !== 'object' || tasks.length >= Math.max(teamLimits.maxTasks, MAX_RESTORED_TASKS)) continue;
      if (typeof raw.id !== 'string' || !TASK_ID.test(raw.id) || tasks.some(task => task.id === raw.id)) continue;
      const status = raw.status === 'deleted' ? 'deleted' : raw.status === 'in_progress' ? 'in_progress' : raw.status === 'completed' ? 'completed' : 'pending';
      const subject = boundedText(raw.subject, MAX_SUBJECT);
      if (!subject) continue;
      const scopes = [];
      for (const value of Array.isArray(raw.writeScopes) ? raw.writeScopes : []) {
        try { if (scopes.length < MAX_WRITE_SCOPES) scopes.push(writeScope(value)); } catch { /* drop damaged scope */ }
      }
      tasks.push({
        id: raw.id,
        revision: Number.isSafeInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
        subject,
        description: boundedText(raw.description, MAX_TASK_DESCRIPTION) || 'Restored task',
        status,
        ...(typeof raw.ownerName === 'string' && raw.ownerName.trim() ? { ownerName: boundedText(raw.ownerName.trim(), 80) } : {}),
        blockedBy: [...new Set((Array.isArray(raw.blockedBy) ? raw.blockedBy : []).filter(id => typeof id === 'string'))],
        writeScopes: [...new Set(scopes)],
      });
    }
    tasks.sort((left, right) => taskNumber(left.id) - taskNumber(right.id));
    // Recover from damaged dependency data instead of bricking every mutation:
    // drop unknown/self blockers, then break any remaining cycle.
    for (const task of tasks) task.blockedBy = task.blockedBy.filter(id => id !== task.id && tasks.some(other => other.id === id && other.status !== 'deleted'));
    for (let guard = 0; guard <= tasks.length; guard++) {
      const cycle = findDependencyCycle();
      if (!cycle) break;
      const first = tasks.find(task => task.id === cycle[0]);
      if (!first) break;
      first.blockedBy = [];
    }
    const savedNext = Number.isSafeInteger(saved.nextTaskNumber) && saved.nextTaskNumber >= 1 ? saved.nextTaskNumber : 1;
    nextTaskNumber = savedNext;
    for (const task of tasks) {
      const number = taskNumber(task.id);
      if (number === Number.MAX_SAFE_INTEGER) { nextTaskNumber = Number.MAX_SAFE_INTEGER; continue; }
      nextTaskNumber = Math.max(nextTaskNumber, number + 1);
    }
    const inboxes = saved.inbox && typeof saved.inbox === 'object' ? saved.inbox : {};
    restoreInbox(inboxes.lead, leadInbox);
    const memberInboxes = inboxes.members && typeof inboxes.members === 'object' ? inboxes.members : {};
    for (const member of members.values()) restoreInbox(memberInboxes[member.name], member.inbox);
  }

  function restoreInbox(value, inbox) {
    if (!Array.isArray(value)) return;
    for (const raw of value.slice(0, MAX_PENDING_MESSAGES)) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.from !== 'string' || !raw.from.trim() || raw.from.length > 80 || typeof raw.text !== 'string' || !raw.text.trim()) continue;
      const text = raw.text.slice(0, teamLimits.maxMessageBytes);
      try {
        if (Buffer.byteLength(formatMessage(raw.from, text), 'utf8') > teamLimits.maxMessageBytes) continue;
      } catch { continue; }
      inbox.push({
        id: typeof raw.id === 'string' && raw.id.length <= 160 ? raw.id : `team-message-${randomUUID()}`,
        from: raw.from.trim(),
        text,
        at: optionalTimestamp(raw.at) ?? Date.now(),
      });
    }
  }

  function findDependencyCycle(list = tasks) {
    const visiting = new Set(), visited = new Set(), path = [];
    const visit = id => {
      if (visiting.has(id)) return [...path, id];
      if (visited.has(id)) return undefined;
      const task = list.find(candidate => candidate.id === id);
      if (!task || task.status === 'deleted') return undefined;
      visiting.add(id); path.push(id);
      for (const blocker of task.blockedBy) {
        const cycle = visit(blocker);
        if (cycle) return cycle;
      }
      path.pop(); visiting.delete(id); visited.add(id);
      return undefined;
    };
    for (const task of list) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
    return undefined;
  }

  function observeEvent(callback, event) {
    try {
      const outcome = callback?.(event);
      if (outcome && typeof outcome.then === 'function') outcome.catch(() => {});
    } catch { /* Observers never control Team execution. */ }
  }

  function emit(event) {
    observeEvent(onEvent, event);
  }

  // The live channel is un-audited and best-effort: streaming events are
  // presentation-only, so a slow, throwing or rejecting live observer must
  // never delay or fail a teammate run.
  function emitLive(event) {
    observeEvent(onLiveEvent, event);
  }

  function publicMember(member) {
    return {
      name: member.name,
      role: 'teammate',
      status: member.status,
      description: member.description,
      context: member.context,
      ...(member.error === undefined ? {} : { error: member.error }),
      ...(member.activity === undefined ? {} : { activity: { ...member.activity } }),
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    };
  }

  function leadRow() {
    return { name: 'lead', role: 'lead', status: leadStatus, createdAt: leadCreatedAt, updatedAt: leadUpdatedAt };
  }

  function modelMember(row) {
    return {
      target: row.name,
      name: row.name,
      role: row.role,
      status: row.status,
      ...(row.description === undefined ? {} : { description: row.description }),
      ...(row.context === undefined ? {} : { context: row.context }),
      ...(row.error === undefined ? {} : { error: row.error }),
      ...(row.activity === undefined ? {} : { activity: { ...row.activity } }),
    };
  }

  function taskReady(task) {
    return task.blockedBy.every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed');
  }

  function taskView(task) {
    const warnings = new Set();
    if (task.status !== 'deleted') {
      for (const other of tasks) {
        if (other.id === task.id || other.status !== 'in_progress') continue;
        if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) warnings.add(`write scopes overlap with ${other.id}`);
      }
    }
    return {
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }),
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
      ready: task.status === 'pending' && taskReady(task),
      writeScopeWarnings: [...warnings],
    };
  }

  function snapshot() {
    return {
      revision,
      roster: [leadRow(), ...[...members.values()].map(publicMember)],
      tasks: tasks.filter(task => task.status !== 'deleted').map(taskView),
    };
  }

  function durableState() {
    const facts = snapshot();
    const inboxes = { lead: leadInbox.map(message => ({ ...message })), members: {} };
    for (const member of members.values()) if (member.inbox.length) inboxes.members[member.name] = member.inbox.map(message => ({ ...message }));
    return {
      version: 1,
      sessionId,
      revision,
      nextTaskNumber,
      // `roster`/`tasks` are the host projection fields; `tombstones` and
      // `inbox` keep internal state that the UI never presents.
      roster: facts.roster.map(row => {
        const { activity: _activity, ...durable } = row;
        return durable;
      }),
      tasks: facts.tasks,
      tombstones: tasks.filter(task => task.status === 'deleted').map(task => ({ ...task })),
      inbox: inboxes,
    };
  }

  async function persist() {
    if (!save) return;
    try {
      await save('team:state', durableState());
    } catch (error) {
      throw failure('TEAM_PERSISTENCE_FAILED', 'Agent Team state could not be persisted', error);
    }
  }

  function emitStatus() {
    emit({ type: 'team.status', team: snapshot() });
  }

  function notifyWaiters() {
    for (const waiter of [...waiters]) waiter.resolve();
  }

  function transact(operation) {
    const run = persistTail.then(operation, operation);
    persistTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function commit() {
    revision += 1;
    await persist();
    emitStatus();
    notifyWaiters();
  }

  function ensureOpen() {
    if (closed) throw failure('TEAM_CLOSED', 'Agent Team is closed');
  }

  // Serialize every durable mutation: revision increments, persistence and the
  // change event are committed in one order, never interleaved.
  function applyChange(operation) {
    return transact(async () => {
      ensureOpen();
      const value = await operation();
      await commit();
      return value;
    });
  }

  function requireActor(actor) {
    if (actor === undefined || actor === null || actor === 'lead') return 'lead';
    const member = members.get(actor);
    if (!member || member.status === 'failed') throw failure('TEAM_MEMBER_NOT_FOUND', `active teammate "${String(actor)}" not found`);
    return member;
  }

  function requireSender(actor) {
    if (actor === 'lead') return { name: 'lead' };
    const member = members.get(actor);
    if (!member || member.status === 'failed') throw failure('TEAM_MEMBER_NOT_FOUND', `active teammate "${String(actor)}" not found`);
    return member;
  }

  function resolveTarget(name) {
    if (name === 'lead') return undefined;
    const member = members.get(name);
    if (!member) throw failure('TEAM_MEMBER_NOT_FOUND', `active teammate "${name}" not found`);
    if (member.status === 'failed') throw failure('TEAM_MEMBER_FAILED', `teammate "${name}" failed during creation; choose a new teammate name`);
    return member;
  }

  function takeInboxPrompt(member) {
    if (!member.inbox.length) return undefined;
    const selected = [];
    let bytes = 0;
    for (const message of member.inbox) {
      const framed = formatMessage(message.from, message.text);
      const size = Buffer.byteLength(framed, 'utf8');
      if (selected.length && bytes + size > teamLimits.maxMessageBytes) break;
      selected.push(message);
      bytes += size;
    }
    if (!selected.length) return undefined;
    member.inbox.splice(0, selected.length);
    return selected.map(message => formatMessage(message.from, message.text)).join('\n\n');
  }

  function hasActivePeer(actor) {
    if (actor !== 'lead' && leadStatus === 'running') return true;
    return [...members.values()].some(member => member.name !== actor && (member.status === 'running' || member.status === 'provisioning'));
  }

  async function setLeadStatus(status) {
    if (status !== 'running' && status !== 'inactive') throw new TypeError('lead status must be running or inactive');
    if (closed) return;
    if (leadStatus === status) return;
    await applyChange(async () => {
      leadStatus = status;
      leadUpdatedAt = Date.now();
    });
  }

  function setLeadSteering(handler) {
    if (handler !== undefined && handler !== null && typeof handler !== 'function') throw new TypeError('lead steering handler must be a function or undefined');
    leadSteering = handler ?? undefined;
  }

  async function consumeLeadInbox() {
    if (closed || !leadInbox.length) return [];
    const messages = await applyChange(async () => leadInbox.splice(0, leadInbox.length));
    return messages.map(message => formatMessage(message.from, message.text));
  }

  async function spawnTeammate(actor, input = {}) {
    ensureOpen();
    if (actor !== 'lead') throw failure('TEAM_LEAD_REQUIRED', 'Only the Team Lead can create teammates');
    if (typeof input?.name !== 'string' || !MEMBER_NAME.test(input.name) || input.name === 'lead') {
      throw failure('TEAM_INVALID_MEMBER_NAME', 'teammate name must be lower-kebab-case (1-32 characters, starting with a letter) and not "lead"');
    }
    const name = input.name;
    const description = requiredText(input.description, 'description', MAX_DESCRIPTION);
    const prompt = requiredText(input.prompt, 'prompt', MAX_PROMPT);
    const context = input.context ?? 'fresh';
    if (context !== 'fresh' && context !== 'fork') throw failure('TEAM_INVALID_ARGUMENT', 'context must be fresh or fork');
    let row;
    let member;
    await applyChange(async () => {
      if (members.has(name)) throw failure('TEAM_MEMBER_NAME_TAKEN', `teammate name "${name}" was already used in this Team`);
      if (members.size >= teamLimits.maxMembers) throw failure('TEAM_MEMBER_LIMIT', `Team member limit ${teamLimits.maxMembers} reached`);
      const now = Date.now();
      member = {
        name, role: 'teammate', description, context, status: 'provisioning',
        createdAt: now, updatedAt: now, inbox: [], runCount: 0,
      };
      members.set(name, member);
      row = publicMember(member);
    });
    // Reserve first, then start the run without awaiting completion.
    startDrive(member, prompt);
    return row;
  }

  function startDrive(member, prompt) {
    const run = drive(member, prompt);
    member.run = run;
    run.catch(() => {});
    return run;
  }

  async function drive(member, initialPrompt) {
    let prompt = initialPrompt;
    for (;;) {
      if (closed) {
        await finalize(member, member.status === 'failed' ? 'failed' : 'inactive');
        return;
      }
      const controller = new AbortController();
      member.controller = controller;
      member.steering = undefined;
      member.runCount += 1;
      member.status = 'running';
      member.updatedAt = Date.now();
      const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        await transact(async () => {
          if (!closed) await commit();
        });
      } catch {
        if (member.controller === controller) { member.controller = undefined; member.steering = undefined; }
        await finalize(member, member.runCount === 1 ? 'failed' : 'inactive', 'Agent Team run could not start');
        return;
      }
      let outcome = 'completed', runError;
      // Run lifecycle events bracket every drive iteration (including inbox
      // wake-ups) and stay tiny so they can be audited.
      emit({ type: 'team.member.run', member: member.name, phase: 'start' });
      try {
        await runMember({
          name: member.name,
          prompt,
          context: member.context,
          signal: runSignal,
          registerSteering: handler => {
            if (closed || member.controller !== controller) return;
            if (handler === undefined || handler === null) member.steering = undefined;
            else if (typeof handler === 'function') member.steering = handler;
          },
          onEvent: event => forwardMemberEvent(member, event),
        });
      } catch (error) {
        if (controller.signal.aborted || closed || signal?.aborted) outcome = 'aborted';
        else { outcome = 'error'; runError = error; }
      } finally {
        if (member.controller === controller) { member.controller = undefined; member.steering = undefined; }
      }
      if (closed) {
        await finalize(member, member.status === 'failed' ? 'failed' : 'inactive');
        emitRunEnd(member);
        return;
      }
      if (outcome === 'aborted') {
        await finalize(member, 'inactive');
        emitRunEnd(member);
        return;
      }
      if (outcome === 'error') {
        await finalize(member, member.runCount === 1 ? 'failed' : 'inactive', runError);
        emitRunEnd(member);
        return;
      }
      if (member.error !== undefined) delete member.error;
      const next = takeInboxPrompt(member);
      if (next !== undefined) {
        emitRunEnd(member);
        prompt = next;
        continue;
      }
      await finalize(member, 'inactive');
      emitRunEnd(member);
      return;
    }
  }

  // Every start has exactly one end, emitted after the run settled and the
  // member status the roster presents (inactive or failed) is known. Runs that
  // drain a queued inbox end before their next start.
  function emitRunEnd(member) {
    emit({
      type: 'team.member.run',
      member: member.name,
      phase: 'end',
      status: member.status === 'failed' ? 'failed' : 'inactive',
    });
  }

  async function finalize(member, status, error) {
    const nextError = error === undefined ? undefined : errorText(error);
    if (member.status === status && member.error === nextError) return;
    member.status = status;
    member.updatedAt = Date.now();
    if (nextError === undefined) delete member.error;
    else member.error = nextError;
    try {
      await transact(async () => {
        if (closed) return;
        await commit();
      });
    } catch { /* The close path persists final state; a failed write must not crash a run. */ }
  }

  function memberEvent(member, event) {
    if (closed) return;
    const compact = compactMemberEvent(event);
    if (!compact) return;
    const activity = activityFor(compact);
    if (!activity) return;
    const at = Date.now();
    member.activity = { ...activity, at };
    // Activity is presentation state, not durable state: bump the observed
    // revision so the panel refreshes without writing the transcript.
    revision += 1;
    emit({ type: 'team.member.activity', member: member.name, activity: { ...member.activity } });
    emitStatus();
  }

  // Every raw runConversation event also reaches the un-audited live channel
  // (teammate conversation view), after the compact activity bookkeeping.
  function forwardMemberEvent(member, event) {
    memberEvent(member, event);
    emitLive({ type: 'team.member.event', member: member.name, event });
  }

  async function removeDelivered(target, id) {
    try {
      await transact(async () => {
        if (closed) return;
        const inbox = target ? target.inbox : leadInbox;
        const index = inbox.findIndex(message => message.id === id);
        if (index < 0) return;
        inbox.splice(index, 1);
        await commit();
      });
    } catch { /* Delivery already succeeded; a failed dequeue stays queued for the next wake. */ }
  }

  function wakeMember(member) {
    if (closed || member.status !== 'inactive' || member.controller) return;
    const prompt = takeInboxPrompt(member);
    if (prompt === undefined) return;
    startDrive(member, prompt);
  }

  async function sendMessage(actor, input = {}, callSignal) {
    ensureOpen();
    callSignal?.throwIfAborted();
    const sender = requireSender(actor);
    const targetName = requiredText(input?.target, 'target', 80);
    if (typeof input?.message !== 'string' || !input.message.trim()) throw failure('TEAM_INVALID_ARGUMENT', 'message must be a non-empty string');
    const text = input.message;
    const framed = formatMessage(sender.name, text);
    if (Buffer.byteLength(framed, 'utf8') > teamLimits.maxMessageBytes) {
      throw failure('TEAM_MESSAGE_TOO_LARGE', `team message exceeds ${teamLimits.maxMessageBytes} bytes`);
    }
    if (targetName === sender.name) throw failure('TEAM_SELF_MESSAGE', 'a Team member cannot message itself');
    const target = resolveTarget(targetName);
    const message = { id: `team-message-${randomUUID()}`, from: sender.name, text, at: Date.now() };
    await applyChange(async () => {
      const inbox = target ? target.inbox : leadInbox;
      if (inbox.length >= MAX_PENDING_MESSAGES) {
        throw failure('TEAM_MAILBOX_FULL', `${target ? `teammate "${target.name}"` : 'the Team Lead'} has ${inbox.length} pending messages`);
      }
      inbox.push({ ...message });
    });
    // The message is durably queued; best-effort immediate delivery follows.
    if (!target) {
      if (leadStatus === 'running' && typeof leadSteering === 'function') {
        try {
          await leadSteering({ text, teamMessage: { from: sender.name } });
          await removeDelivered(null, message.id);
        } catch { /* keep queued for the next Lead turn */ }
      }
      return { sent: true };
    }
    if (target.status === 'running' && typeof target.steering === 'function') {
      try {
        await target.steering({ text, teamMessage: { from: sender.name } });
        await removeDelivered(target, message.id);
      } catch { /* keep queued; the next wake delivers it */ }
      return { sent: true };
    }
    if (target.status === 'inactive') wakeMember(target);
    return { sent: true };
  }

  async function listMembers(actor = 'lead') {
    requireActor(actor);
    return snapshot().roster;
  }

  function waitForChange(actor, timeoutMs, waitSignal) {
    requireActor(actor);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < WAIT_MIN_MS || timeoutMs > WAIT_MAX_MS) {
      return Promise.reject(failure('TEAM_INVALID_TIMEOUT', `timeout must be an integer from ${WAIT_MIN_MS} through ${WAIT_MAX_MS} milliseconds`));
    }
    if (waitSignal !== undefined && !(waitSignal instanceof AbortSignal)) return Promise.reject(new TypeError('signal must be an AbortSignal'));
    waitSignal?.throwIfAborted();
    if (closed) return Promise.resolve({ timedOut: false });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = settle => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waitSignal?.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        settle();
      };
      const onAbort = () => finish(() => {
        const reason = waitSignal.reason;
        reject(reason instanceof Error ? reason : failure('TEAM_WAIT_ABORTED', `wait_agent aborted: ${errorText(reason)}`));
      });
      const waiter = { resolve: () => finish(() => resolve({ timedOut: false })) };
      const timer = setTimeout(() => finish(() => resolve({ timedOut: true })), timeoutMs);
      waiters.add(waiter);
      waitSignal?.addEventListener('abort', onAbort, { once: true });
      // AbortSignal does not replay an abort between the pre-check and listener registration.
      if (waitSignal?.aborted) onAbort();
    });
  }

  async function interrupt(actor, target) {
    ensureOpen();
    if (actor !== 'lead') throw failure('TEAM_LEAD_REQUIRED', 'Only the Team Lead can interrupt teammates');
    const name = requiredText(target, 'target', 80);
    if (name === 'lead') throw failure('TEAM_INVALID_TARGET', 'the Team Lead cannot interrupt itself');
    const member = members.get(name);
    if (!member) throw failure('TEAM_MEMBER_NOT_FOUND', `active teammate "${name}" not found`);
    if (member.status === 'failed') throw failure('TEAM_MEMBER_FAILED', `teammate "${name}" failed`);
    const previousStatus = member.status === 'running' || (member.status === 'provisioning' && member.controller) ? 'running' : 'inactive';
    const controller = member.controller;
    if (controller && !controller.signal.aborted) {
      try { controller.abort(failure('TEAM_INTERRUPTED', `teammate "${name}" was interrupted by the Team Lead`)); } catch { /* already aborted */ }
      if (member.run) {
        try { await withTimeout(member.run, DISPOSAL_TIMEOUT_MS, 'TEAM_DISPOSAL_TIMEOUT'); } catch { /* force-inactive below */ }
      }
    }
    if (member.status === 'running' || member.status === 'provisioning') {
      // A run that ignored cancellation must not leave a phantom live member.
      try {
        await applyChange(async () => {
          if (member.status === 'running' || member.status === 'provisioning') {
            member.status = 'inactive';
            member.updatedAt = Date.now();
          }
        });
      } catch { /* close persists the final roster */ }
    }
    return { previousStatus };
  }

  function findTask(id) {
    return tasks.find(task => task.id === id);
  }

  function assertTaskGraph(candidate) {
    // Validate the graph as it will look after `candidate` is applied.
    const view = candidate ? [...tasks.filter(task => task.id !== candidate.id), candidate] : tasks;
    for (const task of view) {
      if (task.status === 'deleted') continue;
      const seen = new Set();
      for (const blockerId of task.blockedBy) {
        if (blockerId === task.id) throw failure('TEAM_TASK_DEPENDENCY_CYCLE', `team task "${task.id}" cannot block itself`);
        if (seen.has(blockerId)) throw failure('TEAM_INVALID_ARGUMENT', `team task "${task.id}" repeats blocker "${blockerId}"`);
        const blocker = view.find(other => other.id === blockerId);
        if (!blocker || blocker.status === 'deleted') throw failure('TEAM_TASK_NOT_FOUND', `blocker task "${blockerId}" for "${task.id}" is missing or deleted`);
        seen.add(blockerId);
      }
    }
    if (findDependencyCycle(view)) throw failure('TEAM_TASK_DEPENDENCY_CYCLE', 'task dependencies contain a cycle');
  }

  function dependencies(values, selfId) {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 32) throw failure('TEAM_INVALID_ARGUMENT', 'blocked_by must be an array of at most 32 task ids');
    const result = [];
    for (const raw of values) {
      if (typeof raw !== 'string' || !raw.trim()) throw failure('TEAM_INVALID_ARGUMENT', 'blocked_by must contain task ids');
      const id = raw.trim();
      if (id === selfId) throw failure('TEAM_TASK_DEPENDENCY_CYCLE', `team task "${id}" cannot block itself`);
      if (result.includes(id)) throw failure('TEAM_INVALID_ARGUMENT', `duplicate blocker "${id}"`);
      const blocker = findTask(id);
      if (!blocker || blocker.status === 'deleted') throw failure('TEAM_TASK_NOT_FOUND', `blocker task "${id}" not found`);
      result.push(id);
    }
    return result;
  }

  async function createTask(actor, input = {}) {
    requireActor(actor);
    return applyChange(async () => {
      if (tasks.filter(task => task.status !== 'deleted').length >= teamLimits.maxTasks) {
        throw failure('TEAM_TASK_LIMIT', `Team task limit ${teamLimits.maxTasks} reached`);
      }
      if (nextTaskNumber >= Number.MAX_SAFE_INTEGER) throw failure('TEAM_TASK_LIMIT', 'Team task id space exhausted');
      const id = `task-${nextTaskNumber}`;
      if (findTask(id)) throw failure('TEAM_TASK_LIMIT', 'Team task id space exhausted');
      const task = {
        id,
        revision: 1,
        subject: requiredText(input.subject, 'subject', MAX_SUBJECT),
        description: requiredText(input.description, 'description', MAX_TASK_DESCRIPTION),
        status: 'pending',
        blockedBy: dependencies(input.blockedBy),
        writeScopes: writeScopes(input.writeScopes),
      };
      assertTaskGraph(task);
      nextTaskNumber += 1;
      tasks.push(task);
      return taskView(task);
    });
  }

  async function getTask(actor, id) {
    requireActor(actor);
    if (typeof id !== 'string' || !id.trim()) throw failure('TEAM_INVALID_ARGUMENT', 'task_id must be a non-empty string');
    const task = findTask(id.trim());
    if (!task) throw failure('TEAM_TASK_NOT_FOUND', `team task "${id}" not found`);
    return taskView(task);
  }

  async function listTasks(actor = 'lead') {
    requireActor(actor);
    return tasks.filter(task => task.status !== 'deleted').map(taskView);
  }

  async function updateTask(actor, input = {}) {
    const caller = requireActor(actor);
    const isLead = caller === 'lead';
    const taskId = typeof input.taskId === 'string' && input.taskId.trim() ? input.taskId.trim() : undefined;
    if (!taskId) throw failure('TEAM_INVALID_ARGUMENT', 'task_id must be a non-empty string');
    if (!Number.isSafeInteger(input.expectedRevision)) throw failure('TEAM_INVALID_ARGUMENT', 'expected_revision must be an integer');
    const action = input.action;
    if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) throw failure('TEAM_INVALID_ARGUMENT', `unsupported task action ${String(action)}`);
    return applyChange(async () => {
      const current = findTask(taskId);
      if (!current) throw failure('TEAM_TASK_NOT_FOUND', `team task "${taskId}" not found`);
      if (current.revision !== input.expectedRevision) {
        throw failure('TEAM_TASK_STALE_REVISION', `stale team task "${current.id}" revision ${input.expectedRevision}; current revision is ${current.revision}`);
      }
      if (current.status === 'deleted') throw failure('TEAM_TASK_DELETED', `team task "${current.id}" is deleted`);
      const owner = current.ownerName === (isLead ? 'lead' : caller.name);
      const authorizeOwner = () => {
        if (!isLead && !owner) throw failure('TEAM_TASK_UNAUTHORIZED', 'task mutation requires its owner or Team Lead');
      };
      const withoutOwner = task => {
        const { ownerName: _ownerName, ...rest } = task;
        return rest;
      };
      let next;
      switch (action) {
        case 'claim':
          if (current.ownerName !== undefined && current.ownerName !== (isLead ? 'lead' : caller.name)) {
            throw failure('TEAM_TASK_ALREADY_CLAIMED', `team task "${current.id}" is owned by another member`);
          }
          if (current.status !== 'pending' || !taskReady(current)) throw failure('TEAM_TASK_BLOCKED', `team task "${current.id}" is not ready to claim`);
          next = { ...current, status: 'in_progress', ownerName: isLead ? 'lead' : caller.name };
          break;
        case 'release':
          authorizeOwner();
          if (current.status !== 'in_progress') throw failure('TEAM_TASK_INVALID_TRANSITION', 'only an in-progress task can be released');
          next = withoutOwner({ ...current, status: 'pending' });
          break;
        case 'edit':
          authorizeOwner();
          if (input.subject === undefined && input.description === undefined && input.writeScopes === undefined) {
            throw failure('TEAM_INVALID_ARGUMENT', 'task edit requires subject, description, or write_scopes');
          }
          next = {
            ...current,
            ...(input.subject === undefined ? {} : { subject: requiredText(input.subject, 'subject', MAX_SUBJECT) }),
            ...(input.description === undefined ? {} : { description: requiredText(input.description, 'description', MAX_TASK_DESCRIPTION) }),
            ...(input.writeScopes === undefined ? {} : { writeScopes: writeScopes(input.writeScopes) }),
          };
          break;
        case 'set_dependencies':
          authorizeOwner();
          if (input.blockedBy === undefined) throw failure('TEAM_INVALID_ARGUMENT', 'set_dependencies requires blocked_by');
          next = { ...current, blockedBy: dependencies(input.blockedBy, current.id) };
          break;
        case 'complete':
          authorizeOwner();
          if (current.status !== 'in_progress') throw failure('TEAM_TASK_INVALID_TRANSITION', 'only an in-progress task can complete');
          next = { ...current, status: 'completed' };
          break;
        case 'reopen':
          authorizeOwner();
          if (current.status !== 'completed') throw failure('TEAM_TASK_INVALID_TRANSITION', 'only a completed task can reopen');
          next = withoutOwner({ ...current, status: 'pending' });
          break;
        case 'reassign': {
          if (!isLead) throw failure('TEAM_LEAD_REQUIRED', 'only the Team Lead can reassign tasks');
          if (current.status !== 'pending' && current.status !== 'in_progress') throw failure('TEAM_TASK_INVALID_TRANSITION', 'only a pending or in-progress task can be reassigned');
          if (input.owner === undefined || (typeof input.owner === 'string' && !input.owner.trim())) {
            next = withoutOwner({ ...current, status: 'pending' });
            break;
          }
          if (typeof input.owner !== 'string' || input.owner.trim().length > 80) throw failure('TEAM_INVALID_ARGUMENT', 'owner must be a member target');
          if (!taskReady(current)) throw failure('TEAM_TASK_BLOCKED', `team task "${current.id}" is blocked`);
          const ownerName = input.owner.trim();
          if (ownerName !== 'lead' && !members.has(ownerName)) throw failure('TEAM_MEMBER_NOT_FOUND', `active teammate "${ownerName}" not found`);
          next = { ...current, status: 'in_progress', ownerName };
          break;
        }
        case 'delete': {
          authorizeOwner();
          const dependent = tasks.find(task => task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id));
          if (dependent) throw failure('TEAM_TASK_HAS_DEPENDENTS', `team task "${current.id}" still blocks "${dependent.id}"`);
          next = { ...current, status: 'deleted' };
          break;
        }
        default:
          throw failure('TEAM_INVALID_ARGUMENT', `unsupported task action ${String(action)}`);
      }
      assertTaskGraph(next);
      const revision = current.revision + 1;
      // Apply the transition by replacement semantics: optional fields such as
      // ownerName must disappear when the next snapshot omits them.
      for (const key of Object.keys(current)) if (!(key in next)) delete current[key];
      Object.assign(current, next, { revision });
      return taskView(current);
    });
  }

  function withTimeout(promise, timeoutMs, code) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure(code, `Agent Team operation exceeded ${timeoutMs}ms`)), timeoutMs);
      Promise.resolve(promise).then(value => {
        clearTimeout(timer);
        resolve(value);
      }, error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    signal?.removeEventListener('abort', aborted);
    for (const waiter of [...waiters]) waiter.resolve();
    waiters.clear();
    for (const member of members.values()) {
      if (member.controller && !member.controller.signal.aborted) {
        try { member.controller.abort(failure('TEAM_CLOSED', 'Agent Team closed')); } catch { /* already aborted */ }
      }
    }
    closePromise = (async () => {
      const failures = [];
      const runs = [...members.values()].map(member => member.run).filter(Boolean);
      const outcomes = await Promise.allSettled(runs.map(run => withTimeout(run, DISPOSAL_TIMEOUT_MS, 'TEAM_DISPOSAL_TIMEOUT')));
      for (const outcome of outcomes) {
        if (outcome.status !== 'rejected') continue;
        if (outcome.reason?.code === 'TEAM_DISPOSAL_TIMEOUT') { failures.push(outcome.reason); continue; }
        if (outcome.reason?.code === 'TEAM_CLOSED' || outcome.reason?.code === 'TEAM_INTERRUPTED') continue;
        failures.push(outcome.reason);
      }
      for (const member of members.values()) {
        member.controller = undefined;
        member.steering = undefined;
        if (member.status === 'running' || member.status === 'provisioning') {
          member.status = 'inactive';
          member.updatedAt = Date.now();
        }
      }
      await persistTail;
      try {
        await transact(async () => { await commit(); });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw Object.assign(new AggregateError(failures, 'Agent Team could not close cleanly'), { code: 'TEAM_CLOSE_FAILED' });
    })();
    closePromise.catch(() => {});
    return closePromise;
  }

  function aborted() {
    close().catch(() => {});
  }
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();

  function toolsFor(actor = 'lead') {
    requireActor(actor);
    const spawnTool = {
      name: 'spawn_teammate', label: 'Spawn teammate', executionMode: 'sequential',
      description: SPAWN_TEAMMATE_CATALOG.description,
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 32, description: 'Unique lower-kebab-case teammate name.' }),
        description: Type.String({ minLength: 1, maxLength: MAX_DESCRIPTION, description: 'Short description of the delegated responsibility.' }),
        prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT, description: 'Complete initial task for the teammate.' }),
        context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')], { description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.' })),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        return result({ member: modelMember(await spawnTeammate(actor, input ?? {})) });
      },
    };
    const sendTool = {
      name: 'send_message', label: 'Send team message', executionMode: 'sequential',
      description: SEND_MESSAGE_CATALOG.description,
      parameters: Type.Object({
        target: Type.String({ minLength: 1, maxLength: 80, description: 'Member target returned by spawn_teammate or list_agents, including lead.' }),
        message: Type.String({ minLength: 1, maxLength: teamLimits.maxMessageBytes, description: 'Self-contained message for the target.' }),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => result(await sendMessage(actor, input ?? {}, callSignal)),
    };
    const listTool = {
      name: 'list_agents', label: 'List team members', executionMode: 'sequential',
      description: LIST_AGENTS_CATALOG.description,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _input, callSignal) => {
        callSignal?.throwIfAborted();
        return result((await listMembers(actor)).map(modelMember));
      },
    };
    const waitTool = {
      name: 'wait_agent', label: 'Wait for team progress', executionMode: 'sequential',
      description: WAIT_AGENT_CATALOG.description,
      parameters: Type.Object({
        timeout_ms: Type.Optional(Type.Integer({ minimum: WAIT_MIN_MS, maximum: WAIT_MAX_MS, description: `Wait duration in milliseconds, from ${WAIT_MIN_MS} through ${WAIT_MAX_MS}. Defaults to ${WAIT_DEFAULT_MS}.` })),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        const timeoutMs = input?.timeout_ms ?? WAIT_DEFAULT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < WAIT_MIN_MS || timeoutMs > WAIT_MAX_MS) {
          return result(await waitForChange(actor, timeoutMs, callSignal));
        }
        if (!hasActivePeer(actor)) {
          return result({ timedOut: false, noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } });
        }
        return result(await waitForChange(actor, timeoutMs, callSignal));
      },
    };
    const interruptTool = {
      name: 'interrupt_agent', label: 'Interrupt teammate', executionMode: 'sequential',
      description: INTERRUPT_AGENT_CATALOG.description,
      parameters: Type.Object({
        target: Type.String({ minLength: 1, maxLength: 80, description: 'Teammate target returned by spawn_teammate or list_agents.' }),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        return result(await interrupt(actor, input?.target));
      },
    };
    const createTaskTool = {
      name: 'team_task_create', label: 'Create team task', executionMode: 'sequential',
      description: TEAM_TASK_CREATE_CATALOG.description,
      parameters: Type.Object({
        subject: Type.String({ minLength: 1, maxLength: MAX_SUBJECT, description: 'Concise task title.' }),
        description: Type.String({ minLength: 1, maxLength: MAX_TASK_DESCRIPTION, description: 'Complete task details and acceptance criteria.' }),
        blocked_by: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 32, description: 'Task ids that must complete first.' })),
        write_scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_WRITE_SCOPE }), { maxItems: MAX_WRITE_SCOPES, description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.' })),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        return result(await createTask(actor, { subject: input?.subject, description: input?.description, blockedBy: input?.blocked_by, writeScopes: input?.write_scopes }));
      },
    };
    const listTasksTool = {
      name: 'team_task_list', label: 'List team tasks', executionMode: 'sequential',
      description: TEAM_TASK_LIST_CATALOG.description,
      parameters: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], { description: 'Optional exact status filter.' })),
        owner: Type.Optional(Type.String({ maxLength: 80, description: 'Optional member target; use unowned for tasks without an owner.' })),
        ready: Type.Optional(Type.Boolean({ description: 'Optional readiness filter.' })),
        cursor: Type.Optional(Type.Integer({ minimum: 0, description: 'Zero-based result offset. Defaults to 0.' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Number of rows, 1 through 100. Defaults to 50.' })),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        const status = input?.status;
        const cursor = input?.cursor ?? 0;
        const limit = input?.limit ?? 50;
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure('TEAM_INVALID_ARGUMENT', 'cursor must be a non-negative safe integer');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('TEAM_INVALID_ARGUMENT', 'limit must be an integer from 1 through 100');
        const owner = input?.owner;
        const filtered = (await listTasks(actor)).filter(task =>
          (status === undefined || task.status === status)
          && (owner === undefined || (owner === 'unowned' ? task.ownerName === undefined : task.ownerName === owner))
          && (input?.ready === undefined || task.ready === input.ready));
        return result({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        });
      },
    };
    const getTaskTool = {
      name: 'team_task_get', label: 'Get team task', executionMode: 'sequential',
      description: TEAM_TASK_GET_CATALOG.description,
      parameters: Type.Object({ task_id: Type.String({ minLength: 1, maxLength: 80, description: 'Shared task id.' }) }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        return result(await getTask(actor, input?.task_id));
      },
    };
    const updateTaskTool = {
      name: 'team_task_update', label: 'Update team task', executionMode: 'sequential',
      description: TEAM_TASK_UPDATE_CATALOG.description,
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1, maxLength: 80, description: 'Shared task id.' }),
        expected_revision: Type.Integer({ minimum: 1, description: 'Current task revision used as the CAS precondition.' }),
        action: Type.Union(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'].map(action => Type.Literal(action)), { description: 'Task transition to apply.' }),
        subject: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SUBJECT, description: 'Replacement title for edit.' })),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_DESCRIPTION, description: 'Replacement details for edit.' })),
        blocked_by: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 32, description: 'Complete blocker list for set_dependencies.' })),
        write_scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_WRITE_SCOPE }), { maxItems: MAX_WRITE_SCOPES, description: 'Replacement advisory write scopes for edit.' })),
        owner: Type.Optional(Type.String({ maxLength: 80, description: 'Member target for Lead-only reassign; omit to unassign.' })),
      }, { additionalProperties: false }),
      execute: async (_id, input, callSignal) => {
        callSignal?.throwIfAborted();
        return result(await updateTask(actor, {
          taskId: input?.task_id,
          expectedRevision: input?.expected_revision,
          action: input?.action,
          ...(input?.subject === undefined ? {} : { subject: input.subject }),
          ...(input?.description === undefined ? {} : { description: input.description }),
          ...(input?.blocked_by === undefined ? {} : { blockedBy: input.blocked_by }),
          ...(input?.write_scopes === undefined ? {} : { writeScopes: input.write_scopes }),
          ...(input?.owner === undefined ? {} : { owner: input.owner }),
        }));
      },
    };
    const tools = [spawnTool, sendTool, listTool, waitTool];
    if (actor === 'lead') tools.push(interruptTool);
    tools.push(createTaskTool, listTasksTool, getTaskTool, updateTaskTool);
    return tools;
  }

  return {
    toolsFor, snapshot, close, spawnTeammate, sendMessage, listMembers, waitForChange, interrupt,
    setLeadStatus, setLeadSteering, consumeLeadInbox, createTask, getTask, listTasks, updateTask,
  };
}
