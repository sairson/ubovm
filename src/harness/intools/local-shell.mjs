import { realpath, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Type } from 'typebox';
import { requireText, integer } from './common.mjs';
import { runLocalProcess } from './local-process.mjs';

export const LOCAL_SHELL_POLICY = 'Local shell commands may be used ONLY for code operations (inspect, edit, build, test, debug, version control) and development environment configuration (dependencies, toolchains, project configuration). Every call must state purpose and a task-specific reason. Never use local shell for general browsing, office tasks, unrelated file management, remote operations, or to bypass another tool restriction. Prefer dedicated workspace editing tools for tracked edits. Commands run on the local host, not the SSH host; cwd is not a filesystem sandbox. Do not start detached/background jobs. Shell edits are not recorded in the IDE change snapshots.';

export function createLocalShellTool({ cwd = process.cwd(), defaultTimeoutSeconds = 120, maxTimeoutSeconds = 1800, maxOutputBytes = 1 << 20 } = {}) {
  cwd = resolve(requireText(cwd, 'cwd'));
  maxTimeoutSeconds = integer(maxTimeoutSeconds, 1800, 1, 86400, 'maxTimeoutSeconds');
  defaultTimeoutSeconds = integer(defaultTimeoutSeconds, Math.min(120, maxTimeoutSeconds), 1, maxTimeoutSeconds, 'defaultTimeoutSeconds');
  maxOutputBytes = integer(maxOutputBytes, 1 << 20, 1, 100 << 20, 'maxOutputBytes');
  const windows = process.platform === 'win32';
  return {
    name: 'run_local_shell_command', label: 'Run local shell command',
    description: `${LOCAL_SHELL_POLICY} Shell: ${windows ? 'Windows PowerShell' : '/bin/sh'}. Default cwd: ${cwd}. Non-interactive; stdout/stderr stream, nonzero exits are errors.`,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 32768 }),
      purpose: Type.Union([Type.Literal('code'), Type.Literal('environment_setup')]),
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
      cwd: Type.Optional(Type.String({ description: 'Absolute path or path relative to default cwd.' })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutSeconds }))
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      signal?.throwIfAborted();
      if (!['code', 'environment_setup'].includes(input.purpose)) throw new Error('Local shell is restricted to code and environment_setup purposes');
      const reason = requireText(input.reason, 'reason');
      const command = requireText(input.command, 'command');
      if (command.length > 32768 || reason.length > 2048) throw new Error('Local shell command or reason exceeds size limit');
      const directory = await realpath(input.cwd === undefined ? cwd : resolve(cwd, requireText(input.cwd, 'cwd')));
      if (!(await stat(directory)).isDirectory()) throw new Error('cwd must be a directory');
      const timeout = integer(input.timeout_seconds, defaultTimeoutSeconds, 1, maxTimeoutSeconds, 'timeout_seconds');
      const executable = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
      const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $global:LASTEXITCODE = 0;\n" + command + '\nexit $LASTEXITCODE';
      const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-c', command];
      return runLocalProcess({ executable, args, cwd: directory, env: process.env, timeout, maxOutputBytes, label: 'Local shell command', details: { cwd: directory, shell: executable, purpose: input.purpose, reason } }, signal, onUpdate);
    }
  };
}
