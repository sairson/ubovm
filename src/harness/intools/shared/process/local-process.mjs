import { spawn } from 'node:child_process';
import { createProcessOutput } from './process-output.mjs';
import { textResult, abortError, errorFields } from '../common.mjs';
import { terminateProcessTree } from './process-tree.mjs';
const ignoreLateProcessError = () => {};

// Shared bounded execution and process-tree cancellation for local tools.
export function runLocalProcess({ executable, args, cwd, env, timeout, maxOutputBytes, label, details, lifecycle, captureOutput = true }, signal, onUpdate,
  { closeGraceMs = 2000, spawnProcess = spawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawnProcess(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createProcessOutput(maxOutputBytes, onUpdate, { captureOutput, rolling: () => lifecycle?.resident === true });
    const subscriptions = [];
    const listen = (target, name, handler) => { target.on(name, handler); subscriptions.push([target, name, handler]); };
    let failure, done = false, killTimer, exitTimer, exited = false, unsubscribe;
    const finish = (error, code, processClosed = true) => {
      if (done) return; done = true;
      try { unsubscribe?.(); } catch (cleanupError) { error ??= failure ?? cleanupError; }
      unsubscribe = undefined;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(exitTimer); signal?.removeEventListener('abort', cancel);
      for (const [target, name, handler] of subscriptions.splice(0)) target.removeListener(name, handler);
      for (const target of [child, child.stdout, child.stderr]) {
        if (!target.listeners('error').includes(ignoreLateProcessError)) target.on('error', ignoreLateProcessError);
      }
      const text = output.finish();
      error ??= failure;
      if (!error && code !== 0) error = new Error(`${label} exited with code ${code}`);
      if (error) {
        // AbortSignal.reason belongs to the caller and may be shared or
        // frozen. Preserve it rather than appending output to that Error.
        const fields = errorFields(error);
        const failure = new Error(`${fields.message}${text ? `\n${text}` : ''}`, { cause: error });
        failure.name = fields.name;
        if (fields.code !== undefined) failure.code = fields.code;
        failure.details = { ...details, exit_code: code ?? null, process_closed: processClosed };
        reject(failure);
      }
      else resolveResult(textResult(text, { ...details, exit_code: code, process_closed: processClosed }));
    };
    const terminate = error => {
      if (done || failure) return; failure = error || new Error(errorFields(error).message);
      try { lifecycle?.stopping?.(); } catch { /* Status observers cannot prevent process termination. */ }
      // Arm the fallback before requesting termination: OS calls may fail.
      killTimer = setTimeout(() => {
        if (!exited) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(failure, child.exitCode, false);
      }, closeGraceMs);
      terminateProcessTree(child, () => exited || child.exitCode !== null || child.signalCode !== null);
    };
    const cancel = () => terminate(abortError(signal));
    const timer = setTimeout(() => terminate(new Error(`${label} timed out after ${timeout} seconds`)), timeout * 1000);
    const collect = (chunk, stderr) => {
      if (done || failure) return;
      if (!output.write(chunk, stderr)) terminate(new Error(`${label} output exceeds ${maxOutputBytes} bytes`));
    };
    const end = stderr => {
      if (done || failure) return;
      output.end(stderr);
      if (output.truncated && !lifecycle?.resident) terminate(new Error(`${label} output exceeds ${maxOutputBytes} bytes`));
    };
    listen(child.stdout, 'data', chunk => collect(chunk, false));
    listen(child.stderr, 'data', chunk => collect(chunk, true));
    listen(child.stdout, 'end', () => end(false));
    listen(child.stderr, 'end', () => end(true));
    for (const stream of [child.stdout, child.stderr]) listen(stream, 'error', error => terminate(error));
    listen(child, 'error', error => { if (child.pid) terminate(error); else finish(error); });
    listen(child, 'exit', () => {
      exited = true;
      if (!done && !failure) exitTimer = setTimeout(() => terminate(Object.assign(new Error(`${label} exited but output pipes remained open`),
        { code: 'PROCESS_PIPE_TIMEOUT' })), closeGraceMs);
    });
    listen(child, 'close', code => finish(undefined, code));
    signal?.addEventListener('abort', cancel, { once: true });
    // Install exit/error handling before calling lifecycle code: the process
    // already exists, so failed subscription must follow termination cleanup.
    try { unsubscribe = lifecycle?.subscribe(() => clearTimeout(timer)); }
    catch (error) { terminate(error); }
    if (signal?.aborted) cancel();
  });
}
