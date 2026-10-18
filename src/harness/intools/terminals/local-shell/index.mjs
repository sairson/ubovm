import { realpath, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Type } from 'typebox';
import { requireText, integer } from '../../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { LOCAL_SHELL_CATALOG } from '../../shared/tool-catalogs.mjs';
import { runLocalProcess } from '../../shared/process/local-process.mjs';
import { PersistentShell, namedShell } from '../../shared/process/persistent-shell.mjs';
import { openLocalShell } from '../../shared/process/local-shell-transport.mjs';
import { abortableSetup } from '../../shared/process/abortable-setup.mjs';
import { bindShellSignal } from '../../shared/process/shell-signal.mjs';

export const LOCAL_SHELL_POLICY = 'Local shell commands may be used ONLY for code operations (inspect, edit, build, test, debug, version control) and development environment configuration (dependencies, toolchains, project configuration). Every call must state purpose and a task-specific reason. Never use local shell for general browsing, office tasks, unrelated file management, remote operations, or to bypass another tool restriction. Prefer dedicated workspace editing tools for tracked edits. Commands run on the local host, not the SSH host; cwd is not a filesystem sandbox. Do not start shell-native detached jobs (& / Start-Process); for long-lived servers use retain=true or let the host auto-retain npm run dev-style commands. Shell edits are not recorded in the IDE change snapshots.';

export function createLocalShellTool({ cwd = process.cwd(), defaultTimeoutSeconds, maxTimeoutSeconds = 1800, maxOutputBytes = 1 << 20 } = {}) {
  cwd = resolve(requireText(cwd, 'cwd'));
  maxTimeoutSeconds = integer(maxTimeoutSeconds, 1800, 1, 86400, 'maxTimeoutSeconds');
  defaultTimeoutSeconds = integer(defaultTimeoutSeconds, Math.min(120, maxTimeoutSeconds), 1, maxTimeoutSeconds, 'defaultTimeoutSeconds');
  maxOutputBytes = integer(maxOutputBytes, 1 << 20, 1, 100 << 20, 'maxOutputBytes');
  const windows = process.platform === 'win32';
  const sessions = new Map();
  const lifetime = new AbortController(), active = new Set();
  let closed = false, closing;
  const executable = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
  // Windows PowerShell 5.1 rejects cmd/bash idioms (`&&`, `||`, `dir /s /b`,
  // `%VAR%`). A parse error means nothing executed, so the same text can be
  // retried safely under cmd.exe instead of failing with a confusing message.
  const POWER_SHELL_SYNTAX_ERROR = /ParserError|ParentContainsErrorRecordException|InvalidEndOfLine|UnexpectedToken|MissingEndCurlyBrace|MissingEndParenthesisInMethodCall|TerminatorExpectedAtEndOfString|MissingExpressionAfter|ExpressionsOnlyAsFirstElement/i;
  const powerShellSyntaxError = error => windows && POWER_SHELL_SYNTAX_ERROR.test(String(error?.message || ''));
  const tool = {
    name: 'run_local_shell_command', label: 'Run local shell command',
    description: LOCAL_SHELL_CATALOG.description,
    parameters: Type.Object({
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
      purpose: Type.Optional(Type.Union([Type.Literal('code'), Type.Literal('environment_setup')])),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      cwd: Type.Optional(Type.String({ description: 'Absolute path or path relative to default cwd.' })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      reset_session: Type.Optional(Type.Boolean()),
      retain: Type.Optional(Type.Boolean({ description: 'Host-retain this command after the tool returns so it survives agent end (for dev servers). Prefer this over shell background jobs.' })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutSeconds })),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate, lifecycle) {
      // Await the command before release(): `return promise` runs finally immediately
      // and would drop host abort listeners while the shell is still running.
      const bound = bindShellSignal(signal, lifetime.signal, lifecycle);
      const operation = (async () => {
        try {
          bound.signal.throwIfAborted();
          if (closed) throw new Error('Local shell tool is closed');
          if (input.reset_session && !input.session) throw new Error('reset_session requires session');
          if (!['code', 'environment_setup'].includes(input.purpose)) throw new Error('Local shell is restricted to code and environment_setup purposes');
          const reason = requireText(input.reason, 'reason');
          const command = requireText(input.command, 'command');
          if (command.length > 32768 || reason.length > 2048) throw new Error('Local shell command or reason exceeds size limit');
          const requestedDirectory = input.cwd === undefined ? cwd : resolve(cwd, requireText(input.cwd, 'cwd'));
          const directoryForCommand = () => abortableSetup(bound.signal, async () => {
            const directory = await realpath(requestedDirectory);
            if (!(await stat(directory)).isDirectory()) throw new Error('cwd must be a directory');
            bound.signal.throwIfAborted();
            if (closed) throw new Error('Local shell tool is closed');
            return directory;
          });
          const timeout = integer(input.timeout_seconds, defaultTimeoutSeconds, 1, maxTimeoutSeconds, 'timeout_seconds');
          const runCmdFallback = async directory => {
            bound.signal.throwIfAborted();
            // `cmd /u` emits UTF-16LE; PowerShell decodes it with the console set
            // to Unicode and re-emits UTF-8, so non-ASCII output survives instead
            // of being mangled by the UTF-8 decoder.
            const script = [
              "$ProgressPreference = 'SilentlyContinue'",
              '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
              '$OutputEncoding = [Console]::OutputEncoding',
              `$cmd = '${command.replace(/'/g, "''")}'`,
              '$prev = [Console]::OutputEncoding',
              '[Console]::OutputEncoding = [System.Text.Encoding]::Unicode',
              '$out = & $env:ComSpec /d /s /u /c $cmd',
              '$code = $LASTEXITCODE',
              '[Console]::OutputEncoding = $prev',
              '$out',
              'exit $code'
            ].join('\n');
            const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
            return await runLocalProcess({ lifecycle, executable, args, cwd: directory, env: process.env, timeout, maxOutputBytes, label: 'Local shell command (cmd fallback)',
              details: { cwd: directory, shell: 'cmd.exe', shell_fallback: 'cmd', purpose: input.purpose, reason } }, bound.signal, onUpdate);
          };
          if (input.session !== undefined) {
            const session = namedShell(sessions, input.session, () => new PersistentShell(async () => openLocalShell(executable,
              windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', '-'] : [], cwd), { windows }));
            try {
              return await session.execute(command, { timeout, maxOutputBytes, prepare: async () => {
                const directory = await directoryForCommand();
                return { cwd: input.cwd === undefined ? undefined : directory };
              },
                lifecycle, reset: input.reset_session, details: { session: input.session, shell: executable, purpose: input.purpose, reason } }, bound.signal, onUpdate);
            } catch (error) {
              // The named shell keeps its PowerShell state, so a cmd-style command
              // runs as a one-off cmd process in the requested directory.
              if (powerShellSyntaxError(error)) return await runCmdFallback(await directoryForCommand());
              throw error;
            }
          }
          const directory = await directoryForCommand();
          const script = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $global:LASTEXITCODE = 0;\n" + command + '\nexit $LASTEXITCODE';
          const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-c', command];
          try {
            return await runLocalProcess({ lifecycle, executable, args, cwd: directory, env: process.env, timeout, maxOutputBytes, label: 'Local shell command', details: { cwd: directory, shell: executable, purpose: input.purpose, reason } }, bound.signal, onUpdate);
          } catch (error) {
            if (powerShellSyntaxError(error)) return await runCmdFallback(directory);
            throw error;
          }
        } finally { bound.release(); }
      })();
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        lifetime.abort(new Error('Local shell tool is closed'));
        await Promise.allSettled([...active, ...[...sessions.values()].map(session => session.close())]);
      });
      return closing;
    }
  };
  const disclosed = withProgressiveDisclosure(tool, { ...LOCAL_SHELL_CATALOG, mode: 'flag' });
  disclosed.close = (...args) => tool.close(...args);
  return disclosed;
}
