import { Type } from 'typebox';
import { abortError, integer } from '../shared/common.mjs';
import { withActionHelp, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { BACKGROUND_CATALOG } from '../shared/tool-catalogs.mjs';

const ACTIONS = new Set(['list', 'read', 'stop']);
const MAX_TAIL_LINES = 400;
const MAX_WAIT_SECONDS = 30;

function safeCommandId(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value.trim().replace(/^#/, '').slice(0, 128);
}

function elapsed(startedAt, endedAt, now = Date.now()) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return '';
  const end = Number.isFinite(endedAt) ? endedAt : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function taskLine(task) {
  const bits = [`#${task.command_id}`, task.transport || task.name, task.status];
  if (task.status === 'running') bits.push('已运行 ' + task.elapsed);
  else if (task.elapsed) bits.push('耗时 ' + task.elapsed);
  if (task.worker_id) bits.push(task.worker_id);
  return `- ${bits.join(' · ')} · ${task.command || '(no command preview)'}`;
}

function tailOf(text, lines) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return { text: '', omitted: 0, bytes: 0 };
  const source = value.split(/\r?\n/);
  const tail = source.slice(-lines).join('\n');
  return { text: tail, omitted: Math.max(0, source.length - lines), bytes: Buffer.byteLength(value) };
}

export function createBackgroundCommandsTool({ registry } = {}) {
  if (!registry || typeof registry.list !== 'function' || typeof registry.read !== 'function' || typeof registry.stop !== 'function') {
    throw new TypeError('createBackgroundCommandsTool requires a background task registry');
  }
  const tool = {
    name: 'background_commands', label: 'Background commands',
    description: BACKGROUND_CATALOG.description,
    parameters: Type.Object(withActionHelp({
      command_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Command id from a retained/put-aside shell call or from action=list.' })),
      tail_lines: Type.Optional(Type.Integer({ minimum: 20, maximum: MAX_TAIL_LINES, description: 'For action=read: output tail size (default 120 lines).' })),
      wait_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'For action=read: wait up to this many seconds for new output or completion.' }))
    }), { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('background_commands arguments must be an object');
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
      if (!ACTIONS.has(action)) throw new Error(`Unknown background_commands action: ${action || '(empty)'}; use list, read or stop`);
      if (action === 'list') {
        const tasks = registry.list();
        const running = tasks.filter(task => task.status === 'running');
        const message = tasks.length
          ? [running.length ? `${running.length} 个后台任务运行中，共 ${tasks.length} 条记录：` : `${tasks.length} 个后台任务（均已结束）：`, ...tasks.slice(0, 32).map(taskLine)].join('\n')
          : '当前没有后台任务。使用 run_local_shell_command / run_linux_ssh_command 并传 retain=true（或由用户在界面“放在一边”）启动长任务。';
        return { content: [{ type: 'text', text: message }], details: { action, tasks } };
      }
      const commandId = safeCommandId(input.command_id);
      if (!commandId) throw new Error(`action=${action} requires command_id (from action=list or the retain result)`);
      if (action === 'stop') {
        const result = registry.stop(commandId);
        if (result.reason === 'missing') throw new Error(`Unknown background command: #${commandId}. Call action=list to refresh ids.`);
        if (result.reason === 'finished') {
          const task = registry.read(commandId);
          return { content: [{ type: 'text', text: `#${commandId} 已经结束（${task?.status ?? 'unknown'}），无需停止。` }], details: { action, command_id: commandId, stopped: false, task } };
        }
        const task = registry.read(commandId);
        const message = result.ok
          ? `已请求停止 #${commandId}${task?.command ? '：' + task.command : ''}。进程仍会走完清理流程，随后可在 list 中看到最终状态。`
          : `停止请求未被接受：#${commandId} 可能已进入停止流程。`;
        return { content: [{ type: 'text', text: message }], details: { action, command_id: commandId, stopped: result.ok, task } };
      }
      // action=read: optionally wait for new output or a terminal status.
      const wait = integer(input.wait_seconds, 0, 0, MAX_WAIT_SECONDS, 'wait_seconds');
      const lines = integer(input.tail_lines, 120, 20, MAX_TAIL_LINES, 'tail_lines');
      let task = registry.read(commandId);
      if (!task) throw new Error(`Unknown background command: #${commandId}. Call action=list to refresh ids.`);
      const initialOutput = task.output, initialStatus = task.status;
      const deadline = wait > 0 ? Date.now() + wait * 1000 : 0;
      let waited = 0;
      while (wait > 0 && task.status === 'running' && Date.now() < deadline) {
        if (signal?.aborted) throw abortError(signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
        task = registry.read(commandId);
        if (!task) throw new Error(`Background command #${commandId} disappeared while waiting.`);
        if (task.output !== initialOutput) break;
      }
      waited = wait > 0 ? Math.max(0, Math.min(wait, Math.ceil((Date.now() - (deadline - wait * 1000)) / 1000))) : 0;
      const tail = tailOf(task.output, lines);
      const header = `#${commandId} · ${task.transport || task.name} · ${task.status} · ${elapsed(task.started_at, task.ended_at)}`
        + (task.worker_id ? ` · ${task.worker_id}` : '') + (task.command ? `\n${task.command}` : '');
      const body = tail.text
        ? header + (tail.omitted ? `\n… 省略前 ${tail.omitted} 行，以下为最后 ${lines} 行` : '') + '\n' + tail.text
        : header + '\n(暂无输出)';
      const waitedNote = wait > 0 && task.output === initialOutput && task.status === initialStatus
        ? `\n（等待 ${wait}s 未出现新输出，任务仍在${task.status === 'running' ? '运行' : '结束'}）`
        : '';
      return {
        content: [{ type: 'text', text: body + waitedNote }],
        details: { action, command_id: commandId, status: task.status, elapsed: task.elapsed,
          output_bytes: tail.bytes, output_tail_lines: lines, omitted_lines: tail.omitted,
          waited_seconds: waited, task: { ...task, output: undefined } }
      };
    }
  };
  return withProgressiveDisclosure(tool, BACKGROUND_CATALOG);
}
