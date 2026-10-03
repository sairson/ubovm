import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Best-effort termination request, not proof that descendants have exited.
// Never let an OS error thrown from an asynchronous callback crash the IDE.
export function terminateProcessTree(child, exited = () => child.exitCode !== null || child.signalCode !== null,
  { platform = process.platform, spawnProcess = spawn, killGroup = process.kill } = {}) {
  const killDirect = () => {
    if (exited()) return;
    try { child.kill('SIGKILL'); } catch { /* the caller's watchdog still settles */ }
  };
  if (!child.pid) return;
  if (platform !== 'win32') {
    try { killGroup(-child.pid, 'SIGKILL'); } catch { killDirect(); }
    return;
  }
  // Never look up an exited Windows process by a potentially recycled PID.
  if (exited()) return;
  try {
    const killer = spawnProcess(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1000, killSignal: 'SIGKILL' });
    killer.on('error', killDirect);
    killer.on('close', code => { if (code !== 0) killDirect(); });
    // A stuck termination helper must not keep the host alive on shutdown.
    killer.unref();
  } catch { killDirect(); }
}
