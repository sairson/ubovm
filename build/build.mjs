import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildCommand({ platform = process.platform, args = process.argv.slice(2), env = process.env } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (args.length > 2) throw new Error('Usage: node build/build.mjs ACTION [folder or source action]');
  return {
    command: platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: ['-NoLogo', '-NoProfile', ...(platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
      '-File', path.join(import.meta.dirname, 'build.ps1')],
    env: { ...env, UBOVM_ACTION: args[0] || 'start', UBOVM_ARGUMENT: args[1] || '',
      UBOVM_SOURCE_DESKTOP: '', UBOVM_SOURCE_WORKSPACE: '', UBOVM_SOURCE_SMOKE: '' }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = buildCommand();
    const child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'inherit', shell: false });
    child.once('error', error => {
      console.error(error.code === 'ENOENT'
        ? `[UBOVM] ${plan.command} is required. macOS/Linux: install PowerShell 7 and put pwsh on PATH.`
        : `[UBOVM] ${error.message}`);
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
  } catch (error) {
    console.error(`[UBOVM] ${error.message}`);
    process.exitCode = 1;
  }
}
