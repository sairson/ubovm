import { spawn } from 'node:child_process';
import { textResult, abortError } from './common.mjs';

// Shared bounded execution and process-tree cancellation for local tools.
export function runLocalProcess({ executable, args, cwd, env, timeout, maxOutputBytes, label, details }, signal, onUpdate) {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, failure, done = false, killTimer;
    const finish = (error, code) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
      const output = Buffer.concat(chunks).toString('utf8');
      error ??= failure;
      if (!error && code !== 0) error = new Error(`${label} exited with code ${code}`);
      if (error) {
        // AbortSignal.reason belongs to the caller and may be shared or
        // frozen. Preserve it rather than appending output to that Error.
        const failure = new Error(`${error.message}${output ? `\n${output}` : ''}`, { cause: error });
        failure.name = error.name;
        failure.details = { ...details, exit_code: code ?? null };
        reject(failure);
      }
      else resolveResult(textResult(output, { ...details, exit_code: code }));
    };
    const terminate = error => {
      if (done || failure) return; failure = error;
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1000, killSignal: 'SIGKILL' });
          killer.on('error', () => child.kill('SIGKILL'));
          // taskkill reports access failures through its exit status rather
          // than its error event. The process we spawned remains killable
          // through its retained handle even in a restricted Windows host.
          killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      killTimer = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); finish(failure); }, 2000);
    };
    const cancel = () => terminate(abortError(signal));
    const timer = setTimeout(() => terminate(new Error(`${label} timed out after ${timeout} seconds`)), timeout * 1000);
    const collect = (chunk, stderr) => {
      if (done || failure) return;
      const bytes = stderr ? Buffer.concat([Buffer.from('[stderr] '), chunk]) : chunk;
      const bounded = bytes.subarray(0, Math.max(0, maxOutputBytes - size));
      if (bounded.length) { chunks.push(bounded); size += bounded.length; try { onUpdate?.(textResult(bounded.toString('utf8'))); } catch { /* observer */ } }
      if (bounded.length < bytes.length) terminate(new Error(`${label} output exceeds ${maxOutputBytes} bytes`));
    };
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.on('error', error => finish(error));
    child.on('close', code => finish(undefined, code));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
