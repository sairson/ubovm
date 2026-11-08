import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { requireText, integer } from '../../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { LOCAL_SHELL_CATALOG } from '../../shared/tool-catalogs.mjs';
import { runLocalProcess } from '../../shared/process/local-process.mjs';
import { PersistentShell, namedShell } from '../../shared/process/persistent-shell.mjs';
import { openLocalShell } from '../../shared/process/local-shell-transport.mjs';
import { abortableSetup } from '../../shared/process/abortable-setup.mjs';
import { bindShellSignal } from '../../shared/process/shell-signal.mjs';
import { normalizeShellFailure, resolveLocalShell } from './windows-shell.mjs';

export const LOCAL_SHELL_POLICY = 'Local shell commands may be used ONLY for code operations (inspect, edit, build, test, debug, version control) and development environment configuration (dependencies, toolchains, project configuration). Every call must state purpose and a task-specific reason. Never use local shell for general browsing, office tasks, unrelated file management, remote operations, or to bypass another tool restriction. Prefer dedicated workspace editing tools for tracked edits. Commands run on the local host, not the SSH host; cwd is not a filesystem sandbox. Do not start shell-native detached jobs (& / Start-Process); for long-lived servers use retain=true (or let the host auto-retain npm run dev-style commands), then inspect or stop them with background_commands instead of starting a duplicate. Shell edits are not recorded in the IDE change snapshots.';

export function createLocalShellTool({ cwd = process.cwd(), defaultTimeoutSeconds, maxTimeoutSeconds = 1800, maxOutputBytes = 1 << 20 } = {}) {
  cwd = resolve(requireText(cwd, 'cwd'));
  maxTimeoutSeconds = integer(maxTimeoutSeconds, 1800, 1, 86400, 'maxTimeoutSeconds');
  defaultTimeoutSeconds = integer(defaultTimeoutSeconds, Math.min(120, maxTimeoutSeconds), 1, maxTimeoutSeconds, 'defaultTimeoutSeconds');
  maxOutputBytes = integer(maxOutputBytes, 1 << 20, 1, 100 << 20, 'maxOutputBytes');
  const windows = process.platform === 'win32';
  const sessions = new Map();
  const lifetime = new AbortController(), active = new Set();
  let closed = false, closing;
  // DSH pwsh semantics: prefer PowerShell 7 from well-known roots/PATH, fall
  // back to Windows PowerShell 5.1. A fresh non-interactive -Command process is
  // used per call, so profile state never leaks and stderr stays plain text.
  const shell = windows ? resolveLocalShell() : { executable: '/bin/sh', kind: 'sh' };
  const executable = shell.executable;
  const WINDOWS_PREAMBLE = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    "$env:PYTHONUTF8 = '1'",
    "$env:PYTHONIOENCODING = 'utf-8'",
    '$global:LASTEXITCODE = 0'
  ].join('; ');
  // Encoding the script avoids Windows command-line quoting damage for model
  // commands containing quotes/backslashes/newlines. Windows PowerShell then
  // serializes stderr as CLIXML, which the shared decoder turns back into text.
  const commandArguments = script => windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-c', script];
  const oneShotScript = command => windows ? `${WINDOWS_PREAMBLE}\n${command}\nexit $LASTEXITCODE` : command;
  const sessionCommand = command => windows
    ? `$env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'\n${command}`
    : command;
  // Windows PowerShell 5.1 rejects cmd/bash idioms (`&&`, `||`, `dir /s /b`,
  // `%VAR%`). A parse error means nothing executed, so the same text can be
  // retried safely under cmd.exe instead of failing with a confusing message.
  const POWER_SHELL_SYNTAX_ERROR = /ParserError|ParentContainsErrorRecordException|InvalidEndOfLine|UnexpectedToken|MissingEndCurlyBrace|MissingEndParenthesisInMethodCall|TerminatorExpectedAtEndOfString|MissingExpressionAfter|ExpressionsOnlyAsFirstElement|ParameterBindingException|A positional parameter cannot be found/i;
  const powerShellSyntaxError = error => windows && POWER_SHELL_SYNTAX_ERROR.test(String(error?.message || ''));
  const tool = {
    name: 'run_local_shell_command', label: 'Run local shell command',
    description: LOCAL_SHELL_CATALOG.description,
    parameters: Type.Object({
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
      purpose: Type.Optional(Type.Union([Type.Literal('code'), Type.Literal('environment_setup')], {
        description: 'Required at runtime: code for inspect/edit/build/test/debug/version-control work, environment_setup for dependencies, toolchains or project configuration.'
      })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: 'Required at runtime: one concrete, task-specific sentence explaining why this command is needed.' })),
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
          if (input.purpose === undefined) throw new Error('purpose is required and local shell is restricted to code and environment_setup purposes');
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
          const run = async options => {
            try { return await runLocalProcess(options, bound.signal, onUpdate); }
            catch (error) { throw normalizeShellFailure(error, options.details); }
          };
          const runCmdFallback = async directory => {
            bound.signal.throwIfAborted();
            // PowerShell decodes cmd's UTF-16LE output and re-emits UTF-8 so
            // non-ASCII output survives instead of being mangled.
            const script = [
              WINDOWS_PREAMBLE,
              `$cmd = '${command.replace(/'/g, "''")}'`,
              '$prev = [Console]::OutputEncoding',
              '[Console]::OutputEncoding = [System.Text.Encoding]::Unicode',
              '$out = & $env:ComSpec /d /s /u /c $cmd',
              '$code = $LASTEXITCODE',
              '[Console]::OutputEncoding = $prev',
              '$out',
              'exit $code'
            ].join('\n');
            return await run({ lifecycle, executable, args: commandArguments(script), cwd: directory, env: process.env, timeout, maxOutputBytes,
              label: 'Local shell command (cmd fallback)',
              details: { cwd: directory, shell: 'cmd.exe', shell_kind: 'cmd', shell_fallback: 'cmd', purpose: input.purpose, reason } });
          };
          if (input.session !== undefined) {
            const session = namedShell(sessions, input.session, () => new PersistentShell(async () => openLocalShell(executable,
              windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] : [], cwd), { windows }));
            try {
              return await session.execute(sessionCommand(command), { timeout, maxOutputBytes, prepare: async () => {
                const directory = await directoryForCommand();
                return { cwd: input.cwd === undefined ? undefined : directory };
              },
                lifecycle, reset: input.reset_session, details: { session: input.session, shell: executable, shell_kind: shell.kind, purpose: input.purpose, reason } }, bound.signal, onUpdate);
            } catch (error) {
              const failure = normalizeShellFailure(error, { session: input.session, shell: executable, shell_kind: shell.kind, purpose: input.purpose, reason });
              // The named shell keeps its PowerShell state, so a cmd-style command
              // runs as a one-off cmd process in the requested directory.
              if (powerShellSyntaxError(failure)) return await runCmdFallback(await directoryForCommand());
              throw failure;
            }
          }
          const directory = await directoryForCommand();
          const args = commandArguments(oneShotScript(command));
          try {
            return await run({ lifecycle, executable, args, cwd: directory, env: process.env, timeout, maxOutputBytes, label: 'Local shell command',
              details: { cwd: directory, shell: executable, shell_kind: shell.kind, purpose: input.purpose, reason } });
          } catch (error) {
            // Decode CLIXML before syntax classification so the fallback message is
            // readable; run() already throws a normalized failure.
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
