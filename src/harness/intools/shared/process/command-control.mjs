import { randomUUID } from 'node:crypto';
import { textResult } from '../common.mjs';
import { shouldRetainShellCommand } from './long-running.mjs';

// This is a host capability, never a model-facing tool or an executable ID.
export function controlledCommand(tool, workerId, register) {
  if (!register || !['run_local_shell_command', 'run_linux_ssh_command'].includes(tool.name)) return tool;
  const pending = new Set(), controls = new Set();
  // Local and SSH share the same host-owned resident lifetime after retain / 放在一边.
  const retain = register.retainBackground === true;
  let closing = false, disposed;
  const dispose = () => disposed ??= Promise.resolve().then(() => tool.close?.());
  return { ...tool, async close() {
    if (!retain) { await tool.close?.(); await Promise.allSettled([...pending]); return; }
    closing = true;
    const foreground = [...controls].filter(control => !control.background);
    for (const control of foreground) control.abort();
    await Promise.allSettled(foreground.map(control => control.operation));
    if (!controls.size) await dispose();
  }, async execute(toolCallId, args, signal, onUpdate) {
    signal?.throwIfAborted();
    if (retain && closing) throw new Error('Command runtime is closed');
    const controller = new AbortController(), id = randomUUID();
    const combined = retain ? controller.signal : signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const forwardAbort = () => controller.abort(signal.reason);
    if (retain) signal?.addEventListener('abort', forwardAbort, { once: true });
    const owned = { background: false, abort: () => controller.abort(new Error('Command runtime is closed')) };
    controls.add(owned);
    let finished = false, started = false, release, background = false, stopping = false, executionState = 'running', output = '', observer, putAside, operation, cleanupFailure;
    const residentListeners = new Set();
    const lifecycle = retain ? {
      get resident() { return background; },
      stopping() { stopping = true; publish(); },
      subscribe(callback) { residentListeners.add(callback); if (background) callback(); return () => residentListeners.delete(callback); }
    } : undefined;
    const aside = new Promise(resolve => { putAside = resolve; });
    const inspectCleanup = details => {
      if (details?.process_closed === false || details?.cleanup_confirmed === false || details?.remote_termination_confirmed === false) {
        cleanupFailure = Object.assign(new Error('命令进程清理未确认，请检查服务状态。'), { code: 'COMMAND_CLEANUP_UNCONFIRMED' });
      }
    };
    const publish = (status = 'running') => {
      if (background) try { Promise.resolve(observer?.({ status, output, executionState: stopping ? 'stopping' : executionState })).catch(() => {}); } catch { /* Host observers cannot terminate commands. */ }
    };
    const backgroundCommand = () => {
      if (finished || combined.aborted || background || stopping || retain && register.canRetain?.() === false) return false;
      background = true;
      if (retain) {
        owned.background = true;
        signal?.removeEventListener('abort', forwardAbort); signal = undefined;
        for (const callback of residentListeners) callback();
      }
      publish();
      onUpdate = undefined;
      putAside(textResult(retain ? '命令已驻留，agent 结束后继续运行（本地与 SSH 相同）。不要重复启动。可手动停止；驻留后取消前台超时，日志只保留末尾；切换工作空间、删除会话或退出应用会清理任务。' : '命令已放在一边，仍在运行。不要重复启动；原有超时、取消及会话关闭仍生效。', { command_id: id, background: true }));
      return true;
    };
    const interrupt = () => {
      if (finished || combined.aborted) return false;
      controller.abort(Object.assign(new Error('用户手工中断了此命令。保留已有输出；请勿自动重试同一长时间运行命令。'), { code: 'COMMAND_INTERRUPTED' }));
      return true;
    };
    try {
      release = register({ id, workerId, toolCallId, name: tool.name, args, startedAt: Date.now(), get retained() { return retain && background && !finished; }, interrupt,
        done: async () => { await operation?.catch(() => {}); if (cleanupFailure) throw cleanupFailure; }, background: backgroundCommand, subscribe: callback => { observer = callback; } });
      try { Promise.resolve(onUpdate?.(textResult('', { command_id: id }))).catch(() => {}); } catch { /* observer */ }
      // Auto-retain host-managed long servers (retain:true or npm run dev heuristics)
      // so the agent turn is not blocked and cancel/close will not kill them.
      if (retain && shouldRetainShellCommand(args)) queueMicrotask(() => backgroundCommand());
      combined.throwIfAborted();
      operation = Promise.resolve().then(() => tool.execute(toolCallId, args, combined, update => {
        output = (output + (update.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')).slice(-12000);
        if (update.details?.execution_state) executionState = update.details.execution_state;
        if (background) publish(); else return onUpdate?.(update);
      }, lifecycle)).then(result => {
        finished = true; inspectCleanup(result.details);
        output = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n').slice(-12000);
        if (cleanupFailure) output = (output + '\n' + cleanupFailure.message).slice(-12000);
        publish(result.isError || cleanupFailure ? 'failed' : 'completed');
        return result;
      }, error => {
        finished = true; inspectCleanup(error.details);
        output = (output + '\n' + error.message).slice(-12000);
        if (cleanupFailure) output = (output + '\n' + cleanupFailure.message).slice(-12000);
        publish(error.code === 'COMMAND_INTERRUPTED' && !cleanupFailure ? 'interrupted' : 'failed');
        throw error;
      }).finally(() => {
        finished = true; signal?.removeEventListener('abort', forwardAbort); controls.delete(owned); residentListeners.clear(); try { release?.(); } catch { /* observer */ } pending.delete(operation);
        if (closing && !controls.size) return dispose().catch(error => { cleanupFailure = error; publish('failed'); throw error; });
      });
      pending.add(operation);
      owned.operation = operation;
      started = true;
      return await Promise.race([operation, aside]);
    } catch (error) { if (!started) { finished = true; signal?.removeEventListener('abort', forwardAbort); controls.delete(owned); release?.(); } throw error; }
  } };
}
