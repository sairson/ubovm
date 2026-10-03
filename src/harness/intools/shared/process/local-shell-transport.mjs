import { spawn } from 'node:child_process';
import { terminateProcessTree } from './process-tree.mjs';

export function openLocalShell(executable, args, cwd, { spawnProcess = spawn, closeGraceMs = 2000 } = {}) {
  const child = spawnProcess(executable, args, { cwd, env: process.env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false, closing;
  child.on('error', () => {});
  child.once('close', () => { closed = true; });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', error => child.emit('error', error));
  return { stdout: child.stdout, stderr: child.stderr, events: child, write: data => child.stdin.write(data),
    close() {
      if (closing) return closing;
      closing = new Promise(resolve => {
        let timer, settled = false;
        const finish = () => {
          if (settled) return; settled = true; clearTimeout(timer); child.removeListener('close', finish);
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          resolve({ process_closed: closed });
        };
        if (closed) { finish(); return; }
        child.once('close', finish);
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, closeGraceMs);
        terminateProcessTree(child);
        child.stdin.destroy();
      });
      return closing;
    }
  };
}
