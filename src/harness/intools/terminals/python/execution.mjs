import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { textResult, abortError } from '../../shared/common.mjs';
import { pythonEnvironment } from './policy.mjs';
import { createPythonOutput } from './output.mjs';
import { pythonQueue } from './queue.mjs';
import { terminateProcessTree } from '../../shared/process/process-tree.mjs';
import { setupPythonSandbox } from './setup.mjs';
import { waitForPythonSetup } from './setup-core.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const phases = new Set(['queued', 'preflight', 'preparing', 'running', 'cleanup']);

export async function runPythonSandbox(request, signal, onUpdate, runner = new URL('./runner.mjs', import.meta.url), timings = {}) {
  // Provision once before admission. Queue wait uses the caller signal only so
  // timeout_seconds covers script execution, matching local/SSH shell behavior.
  if (!signal?.aborted && process.platform === 'win32' && runner.href === new URL('./runner.mjs', import.meta.url).href) {
    const preparing = performance.now();
    try { await waitForPythonSetup(setupPythonSandbox, signal); }
    catch (caught) {
      const source = signal?.aborted ? abortError(signal) : caught instanceof Error ? caught : new Error(String(caught));
      const error = new Error(source.message, { cause: source }); error.name = source.name;
      error.code = source.code ?? (signal?.aborted ? 'PYTHON_CANCELLED' : 'PYTHON_SANDBOX_UNAVAILABLE');
      error.details = { error_code: error.code, phase: 'preflight', output_directory: null, exit_code: null, duration_ms: Math.round(performance.now() - preparing) };
      throw error;
    }
  }
  const queuedAt = performance.now();
  let release, combined, started;
  try {
    if (signal?.aborted) throw abortError(signal);
    release = await pythonQueue.acquire(signal);
    signal?.throwIfAborted();
    started = performance.now();
    const timeout = new AbortController();
    combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const deadline = setTimeout(() => timeout.abort(failure('PYTHON_TIMEOUT', `Python execution timed out after ${request.timeout} seconds`)), request.timeout * 1000);
    try {
      return await execute(request, combined, onUpdate, runner, started, timings);
    } finally { clearTimeout(deadline); }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    if (error.details) throw error;
    const wrapped = new Error(error.message, { cause: error }); wrapped.name = error.name;
    const cancelled = Boolean(signal?.aborted || combined?.aborted);
    wrapped.code = error.code ?? (cancelled ? 'PYTHON_CANCELLED' : 'PYTHON_RUNNER_ERROR');
    wrapped.details = { error_code: wrapped.code, phase: started === undefined ? 'queued' : 'running', output_directory: null, exit_code: null, duration_ms: Math.round(performance.now() - (started ?? queuedAt)) };
    throw wrapped;
  } finally { release?.(); }
}

function execute(request, signal, onUpdate, runner, started, { stopGraceMs = 10000, closeGraceMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(runner), [], { cwd: request.cwd, env: pythonEnvironment(), execArgv: [], windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
    const output = createPythonOutput(request.maxOutputBytes, onUpdate);
    let status, problem, hardStop, settleTimer, finished = false, stopping = false, phase = 'preflight', outputDirectory = null;
    let forced = false, exited = false;
    function finish(code, cleanupConfirmed = true) {
      if (finished) return; finished = true;
      clearTimeout(hardStop); clearTimeout(settleTimer); signal.removeEventListener('abort', cancel);
      const text = output.finish();
      const error = problem ?? (status?.error ? failure(status.errorCode ?? 'PYTHON_EXECUTION_FAILED', status.error)
        : code !== 0 || !status || status.exitCode !== 0 ? failure('PYTHON_RUNNER_LOST', 'Python sandbox runner exited without a successful result')
        : status.cleanupConfirmed !== true ? failure('PYTHON_CLEANUP_FAILED', 'Python sandbox cleanup was not confirmed') : undefined);
      const details = { cwd: request.cwd, output_directory: status ? status.outputDirectory ?? null : outputDirectory,
        sandbox: 'anthropic-sandbox-runtime', python: request.executable, script: request.script, reason: request.reason,
        exit_code: status?.exitCode ?? null, phase: status?.phase ?? phase, duration_ms: Math.round(performance.now() - started),
        output_bytes: output.bytes, output_truncated: output.truncated, forced_termination: forced, cleanup_confirmed: cleanupConfirmed && !forced && Boolean(status?.cleanupConfirmed) };
      if (error) {
        const errorCode = error.code ?? (signal.aborted ? 'PYTHON_CANCELLED' : 'PYTHON_RUNNER_ERROR');
        const message = `[${errorCode}] ${error.message}${text ? `\n${text}` : ''}${details.output_directory ? `\noutput_directory: ${details.output_directory}` : ''}`;
        const wrapped = new Error(message, { cause: error }); wrapped.name = error.name; wrapped.code = errorCode;
        wrapped.details = { ...details, error_code: errorCode }; reject(wrapped);
      } else resolve(textResult(`${text}\nexit_code: 0${details.output_directory ? `\noutput_directory: ${details.output_directory}` : ''}`, details));
    }
    function forceStop() {
      if (finished || forced) return; forced = true;
      // A pipe can outlive a crashed runner. Bound waiting without claiming
      // that all descendants or temporary ACL grants were cleaned up.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        if (child.connected) { try { child.disconnect(); } catch { /* IPC already closed */ } }
        child.unref(); finish(null, false);
      }, closeGraceMs);
      terminateProcessTree(child, () => exited);
    }
    function stop(error, immediate = false) {
      if (finished) return;
      problem ??= error;
      if (stopping) {
        if (immediate) { clearTimeout(hardStop); forceStop(); }
        return;
      }
      stopping = true;
      if (child.connected) {
        try { child.send({ type: 'cancel' }, () => {}); } catch { /* IPC is already gone */ }
      }
      hardStop = setTimeout(forceStop, immediate ? 0 : stopGraceMs);
    }
    const cancel = () => stop(abortError(signal));
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('data', chunk => {
        if (finished || stopping) return;
        if (!output.write(chunk, index === 1)) stop(failure('PYTHON_OUTPUT_LIMIT', `Python output exceeds ${request.maxOutputBytes} bytes`));
      });
      stream.on('end', () => {
        if (!finished && !stopping) {
          output.end(index === 1);
          if (output.truncated) stop(failure('PYTHON_OUTPUT_LIMIT', `Python output exceeds ${request.maxOutputBytes} bytes`));
        }
      });
      stream.on('error', error => stop(failure('PYTHON_STREAM_ERROR', error.message)));
    }
    child.on('message', message => {
      if (finished) return;
      if (message?.type === 'phase' && phases.has(message.phase)) { phase = message.phase; return; }
      if (message?.type === 'prepared' && message.outputDirectory === request.outputDirectory) { outputDirectory = message.outputDirectory; return; }
      if (message?.type !== 'result' || status || !(message.exitCode === null || Number.isSafeInteger(message.exitCode))
        || typeof message.cleanupConfirmed !== 'boolean'
        || message.phase !== undefined && !phases.has(message.phase)
        || message.errorCode !== undefined && (typeof message.errorCode !== 'string' || message.errorCode.length > 128)
        || message.error !== undefined && (typeof message.error !== 'string' || message.error.length > 8192)
        || message.outputDirectory != null && message.outputDirectory !== request.outputDirectory) {
        stop(failure('PYTHON_PROTOCOL_ERROR', 'Invalid or duplicate Python runner response')); return;
      }
      status = message;
      settleTimer ??= setTimeout(() => stop(failure('PYTHON_RUNNER_LOST', 'Python runner reported completion but did not exit'), true), closeGraceMs);
    });
    child.on('disconnect', () => {
      if (!finished && !status) stop(failure('PYTHON_RUNNER_LOST', 'Python runner disconnected before reporting completion'), true);
    });
    child.on('error', error => stop(failure('PYTHON_RUNNER_ERROR', error.message), true));
    child.on('exit', () => {
      exited = true;
      if (!finished) settleTimer ??= setTimeout(() => stop(failure('PYTHON_RUNNER_LOST', 'Python runner exited but its output pipes remained open'), true), closeGraceMs);
    });
    child.on('close', code => finish(code));
    try { child.send({ type: 'run', request }, error => { if (error) stop(failure('PYTHON_IPC_ERROR', error.message), true); }); }
    catch (error) { stop(failure('PYTHON_IPC_ERROR', error.message), true); }
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
