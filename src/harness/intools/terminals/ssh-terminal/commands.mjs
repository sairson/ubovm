import { openPersistentTransport } from './persistent-transport.mjs';
import ssh2 from 'ssh2';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createProcessOutput } from '../../shared/process/process-output.mjs';
import { Type } from 'typebox';
import { requireText, integer, expandHome, textResult, abortError, errorFields } from '../../shared/common.mjs';
import { openInteractiveShell } from './interactive.mjs';
import { PersistentShell, namedShell } from '../../shared/process/persistent-shell.mjs';
import { abortableSetup } from '../../shared/process/abortable-setup.mjs';
import { bindShellSignal } from '../../shared/process/shell-signal.mjs';
const ignoreLateChannelError = () => {};
const protectLateChannelErrors = channel => {
  for (const target of [channel, channel.stderr]) {
    if (target && !target.listeners('error').includes(ignoreLateChannelError)) target.on('error', ignoreLateChannelError);
  }
};

export const shellQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
export const buildRemoteCommand = (command, seconds) => `timeout --signal=KILL ${integer(seconds, 120, 1, 86400, 'seconds')}s bash -lc ${shellQuote(command)}`;
function equal(a, b) { return a.length === b.length && timingSafeEqual(a, b); }
function hostPattern(pattern, host) {
  if (pattern.startsWith('|1|')) {
    const [, , salt, digest] = pattern.split('|');
    return salt && digest && equal(createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest(), Buffer.from(digest, 'base64'));
  }
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 'i').test(host);
}
export function knownHostsVerifier(contents, host, port = 22) {
  const address = port === 22 ? host : `[${host}]:${port}`;
  const entries = contents.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith('#')) return [];
    const marker = fields[0].startsWith('@') ? fields.shift() : '';
    const [hosts, , key] = fields;
    if (!hosts || !key || marker === '@cert-authority') return [];
    const patterns = hosts.split(',');
    if (patterns.some(value => value.startsWith('!') && hostPattern(value.slice(1), address)) || !patterns.some(value => !value.startsWith('!') && hostPattern(value, address))) return [];
    return [{ marker, key: Buffer.from(key, 'base64') }];
  });
  return key => !entries.some(entry => entry.marker === '@revoked' && equal(entry.key, key)) && entries.some(entry => !entry.marker && equal(entry.key, key));
}

/** A connection is pooled; an exec request is never retried after submission. */
export class SSHCommands {
  #client;
  #connecting;
  #pendingClient;
  #closed = false;
  #config;
  #sessions = new Map();
  #sessionGroups = new Set();
  #toolRefs = 0;
  #shutdown;
  constructor(config = {}) {
    this.#config = {
      ...config, host: requireText(config.host, 'SSH host'), username: requireText(config.username, 'SSH username'),
      port: integer(config.port, 22, 1, 65535, 'port'), connect_timeout_seconds: integer(config.connect_timeout_seconds, 10, 1, 300, 'connect_timeout_seconds'),
      max_command_timeout_seconds: integer(config.max_command_timeout_seconds, 1800, 1, 86400, 'max_command_timeout_seconds'),
      max_output_bytes: integer(config.max_output_bytes, 10 << 20, 1, 100 << 20, 'max_output_bytes')
    };
    this.#config.default_command_timeout_seconds = integer(config.default_command_timeout_seconds, Math.min(120, this.#config.max_command_timeout_seconds), 1, this.#config.max_command_timeout_seconds, 'default_command_timeout_seconds');
    if (!config.insecure_ignore_host_key && !config.known_hosts_file && !config.host_key_sha256) throw new Error('SSH requires known_hosts_file or host_key_sha256 (or explicit insecure_ignore_host_key)');
  }
  summary(isDefault = false) {
    const c = this.#config;
    return { id: c.id ?? 'default', name: c.name || `${c.username}@${c.host}`, host: c.host, port: c.port, username: c.username, default: isDefault };
  }
  get maxCommandTimeoutSeconds() { return this.#config.max_command_timeout_seconds; }
  async connect() {
    if (this.#closed) throw new Error('SSH connection is closed');
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const c = this.#config;
      let hostVerifier;
      if (c.host_key_sha256) {
        const expected = requireText(c.host_key_sha256, 'host_key_sha256').replace(/^SHA256:/, '').replace(/=+$/, '');
        hostVerifier = key => createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === expected;
      } else if (c.known_hosts_file) hostVerifier = knownHostsVerifier(await readFile(expandHome(c.known_hosts_file), 'utf8'), c.host, c.port);
      else hostVerifier = () => true;
      const privateKey = c.private_key_file ? await readFile(expandHome(c.private_key_file)) : c.privateKey;
      if (this.#closed) throw new Error('SSH connection is closed');
      return new Promise((resolve, reject) => {
        const client = new ssh2.Client();
        this.#pendingClient = client;
        let ready = false, failed = false;
        const fail = error => {
          if (this.#client === client) this.#client = undefined;
          if (ready || failed) return;
          failed = true;
          if (this.#pendingClient === client) this.#pendingClient = undefined;
          reject(error);
          client.destroy();
        };
        client.on('error', fail);
        client.once('ready', () => {
          if (failed) return;
          if (this.#pendingClient === client) this.#pendingClient = undefined;
          if (this.#closed) { fail(new Error('SSH connection is closed')); return; }
          ready = true;
          this.#client = client;
          resolve(client);
        });
        client.once('close', () => {
          if (this.#client === client) this.#client = undefined;
          if (this.#pendingClient === client) this.#pendingClient = undefined;
          fail(new Error('SSH connection closed before ready'));
        });
        try {
          client.connect({ host: c.host, port: c.port, username: c.username, password: c.password, privateKey, passphrase: c.private_key_passphrase, agent: c.agent ?? process.env.SSH_AUTH_SOCK, hostVerifier, readyTimeout: c.connect_timeout_seconds * 1000, keepaliveInterval: 15000, keepaliveCountMax: 3 });
        } catch (error) { fail(error); }
      });
    })();
    try { return await this.#connecting; } finally { this.#connecting = undefined; }
  }
  async waitForConnection(signal) {
    // Cancelling a waiter must release its listener immediately, while keeping
    // the shared handshake available to other tools.
    signal?.throwIfAborted();
    const pending = this.connect();
    // Observe an early rejection even if cancellation precedes setup's microtask.
    pending.catch(() => {});
    return abortableSetup(signal, () => pending);
  }
  async execute(input, signal, onUpdate, sessions = this.#sessions, lifecycle) {
    signal?.throwIfAborted();
    const command = requireText(input.command, 'command');
    const c = this.#config;
    const timeout = integer(input.timeout_seconds, c.default_command_timeout_seconds, 1, c.max_command_timeout_seconds, 'timeout_seconds');
    if (input.reset_session && !input.session) throw new Error('reset_session requires session');
    if (input.session !== undefined) {
      if (this.#closed) throw new Error('SSH connection is closed');
      const session = namedShell(sessions, input.session, () => new PersistentShell(signal => this.#openPersistent(signal)));
      return session.execute(command, { timeout, maxOutputBytes: c.max_output_bytes, reset: input.reset_session, lifecycle,
        details: { session: input.session, profile_id: c.id ?? 'default' } }, signal, onUpdate);
    }
    return this.#execOneShot(command, timeout, signal, onUpdate, false, lifecycle);
  }
  async #execOneShot(command, timeout, signal, onUpdate, retried, lifecycle) {
    const c = this.#config;
    let client = await this.waitForConnection(signal);
    signal?.throwIfAborted();
    // One reconnect before channel submit when the cached transport vanished.
    if (!this.#client) {
      if (retried) throw new Error('SSH transport is not ready');
      client = await this.waitForConnection(signal);
      signal?.throwIfAborted();
    }
    try {
      return await new Promise((resolve, reject) => {
        // Host-managed residents clear the local timer and must not be wrapped in
        // remote `timeout(1)`, or npm run dev-style tasks die at the foreground budget.
        const output = createProcessOutput(c.max_output_bytes, onUpdate, { rolling: () => lifecycle?.resident === true });
        const subscriptions = [];
        const listen = (target, name, handler) => { target.on(name, handler); subscriptions.push([target, name, handler]); };
        let stream, finished = false, exitCode, unsubscribe;
        const finish = (error, terminationUnconfirmed = false) => {
          if (finished) return; finished = true;
          try { unsubscribe?.(); } catch (cleanupError) { error ??= cleanupError; }
          unsubscribe = undefined;
          clearTimeout(timer); signal?.removeEventListener('abort', cancel); client.removeListener('close', disconnected);
          for (const [target, name, handler] of subscriptions.splice(0)) target.removeListener(name, handler);
          if (stream) protectLateChannelErrors(stream);
          const text = output.finish();
          if (error || terminationUnconfirmed) {
            // AbortSignal reasons may be shared between commands or frozen by their
            // caller. Attach this command's output without mutating that reason.
            const warning = terminationUnconfirmed ? '\nSSH remote process termination is unconfirmed; verify remote state before retrying.' : '';
            const fields = errorFields(error);
            const failure = new Error(`${fields.message}${warning}${text ? `\n${text}` : ''}`, { cause: error });
            failure.name = fields.name;
            if (fields.code !== undefined) failure.code = fields.code;
            failure.details = { exit_code: exitCode ?? null, profile_id: c.id ?? 'default', ...(terminationUnconfirmed ? { remote_termination_confirmed: false } : {}) };
            reject(failure);
          }
          else resolve(textResult(text, { exit_code: exitCode, profile_id: c.id ?? 'default' }));
        };
        const closeChannel = channel => {
          // Late channels and errors can arrive after timeout or cancellation.
          protectLateChannelErrors(channel);
          try { channel.signal('KILL'); } catch { /* transport closed */ }
          try { channel.close(); } catch { /* transport closed */ }
        };
        const stop = error => {
          if (finished) return;
          try { lifecycle?.stopping?.(); } catch { /* Status observers cannot prevent SSH cleanup. */ }
          // Record failure before channel.close can synchronously emit success.
          finish(error, true);
          if (stream) closeChannel(stream);
        };
        const cancel = () => stop(abortError(signal));
        const disconnected = () => stop(new Error('SSH transport closed during command; execution outcome is uncertain'));
        const timer = setTimeout(() => stop(new Error(`SSH command timed out after ${timeout} seconds`)), timeout * 1000 + 250);
        client.once('close', disconnected);
        signal?.addEventListener('abort', cancel, { once: true });
        try { unsubscribe = lifecycle?.subscribe(() => clearTimeout(timer)); }
        catch (error) { stop(error); return; }
        const remote = lifecycle ? `bash -lc ${shellQuote(command)}` : buildRemoteCommand(command, timeout);
        try {
          client.exec(remote, (error, channel) => {
            if (error) {
              if (!retried && !stream) {
                finished = true;
                try { unsubscribe?.(); } catch { /* ignore */ }
                unsubscribe = undefined;
                clearTimeout(timer); signal?.removeEventListener('abort', cancel); client.removeListener('close', disconnected);
                reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error.code ?? 'SSH_TRANSPORT', sshPreChannel: true }));
                return;
              }
              finish(error); return;
            }
            stream = channel;
            if (finished || signal?.aborted) { if (!finished) cancel(); else closeChannel(channel); return; }
            const collect = (chunk, stderr) => {
              if (finished) return;
              if (!output.write(chunk, stderr)) stop(new Error(`SSH output exceeds ${c.max_output_bytes} bytes`));
            };
            const end = stderr => {
              if (finished) return;
              output.end(stderr);
              if (output.truncated && !lifecycle?.resident) stop(new Error(`SSH output exceeds ${c.max_output_bytes} bytes`));
            };
            listen(channel, 'data', chunk => collect(chunk, false));
            listen(channel.stderr, 'data', chunk => collect(chunk, true));
            listen(channel, 'end', () => end(false));
            listen(channel.stderr, 'end', () => end(true));
            listen(channel, 'error', error => stop(error));
            listen(channel.stderr, 'error', error => stop(error));
            listen(channel, 'exit', (code, reason) => { exitCode = code; if (reason) exitCode = `signal ${reason}`; });
            listen(channel, 'close', code => { exitCode ??= code; finish(exitCode === 0 ? undefined : new Error(`SSH command exited with ${exitCode ?? 'unknown status'}`)); });
          });
        } catch (error) {
          finished = true;
          try { unsubscribe?.(); } catch { /* ignore */ }
          unsubscribe = undefined;
          clearTimeout(timer); signal?.removeEventListener('abort', cancel); client.removeListener('close', disconnected);
          reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error.code ?? 'SSH_TRANSPORT', sshPreChannel: true }));
        }
        if (signal?.aborted) cancel();
      });
    } catch (error) {
      if (!retried && error?.sshPreChannel) {
        if (this.#client === client) this.#client = undefined;
        try { client.end(); } catch { /* already closed */ }
        signal?.throwIfAborted();
        return this.#execOneShot(command, timeout, signal, onUpdate, true, lifecycle);
      }
      throw error;
    }
  }
  async #openPersistent(signal) {
    const client = await this.waitForConnection(signal);
    return openPersistentTransport(client, signal);
  }
  async openInteractive({ columns = 80, rows = 24, signal } = {}) {
    integer(columns, 80, 1, 65535, 'columns'); integer(rows, 24, 1, 65535, 'rows');
    signal?.throwIfAborted();
    const client = await this.waitForConnection(signal);
    signal?.throwIfAborted();
    return openInteractiveShell(client, { columns, rows, signal });
  }
  async #endClient() {
    if (this.#shutdown) return this.#shutdown;
    this.#shutdown = (async () => {
      await Promise.all([this.#sessions, ...this.#sessionGroups].flatMap(group => [...group.values()].map(session => session.close())));
      this.#sessionGroups.clear();
      this.#pendingClient?.destroy();
      this.#pendingClient = undefined;
      this.#client?.end();
      this.#client = undefined;
      try { await this.#connecting; } catch { /* a cancelled handshake rejects */ }
    })();
    return this.#shutdown;
  }
  async close() {
    this.#closed = true;
    this.#pendingClient?.destroy();
    this.#pendingClient = undefined;
    // Keep the shared client while host-owned resident tools still hold a ref
    // (e.g. npm run dev put aside). Direct close with no open tools still tears down.
    if (this.#toolRefs > 0) return;
    await this.#endClient();
  }
  tool() {
    const sessions = new Map();
    this.#sessionGroups.add(sessions);
    this.#toolRefs++;
    const lifetime = new AbortController(), active = new Set();
    let closed = false, closing;
    return {
      name: 'run_linux_ssh_command', label: 'Run SSH command', description: 'Preferred execution tool for CTF reconnaissance, enumeration, scanning, probing, vulnerability validation, exploitation, payload execution, and flag retrieval or verification within the challenge scope. Execute Linux commands and scripts on the host-selected remote Linux SSH profile, with streamed stdout/stderr and a remote timeout. Use Linux shell syntax and remote paths; local IDE files, dependencies and localhost services are not automatically available remotely. Check required remote prerequisites and transfer artifacts with supplied file-transfer tools when needed. The SSH host is the execution environment, not automatically the challenge target; use target addresses from task evidence. Prefer this tool over equivalent local shell execution or browser automation for these operations. Set retain=true for long-lived remote servers; the host also auto-retains common patterns like npm run dev. Nonzero exits are errors. The model cannot change the SSH profile.',
      parameters: Type.Object({
        command: Type.String(),
        session: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'Reuse a named bash shell, retaining cwd and environment. Requires Linux setsid and /proc for process-group cancellation. Calls serialize. A retained command frees the session for a fresh shell. Omit for isolated execution. No stdin reads, shell-native background jobs, or shell-wide output redirection.' })),
        reset_session: Type.Optional(Type.Boolean({ description: 'Force a fresh named shell. After exit, timeout, cancellation or disconnect the next call soft-resets automatically; use this to discard retained cwd/env deliberately.' })),
        retain: Type.Optional(Type.Boolean({ description: 'Host-retain this command after the tool returns so it survives agent end (for remote dev servers). Prefer this over shell background jobs.' })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: this.#config.max_command_timeout_seconds }))
      }, { additionalProperties: false }),
      execute: async (_id, input, signal, onUpdate, lifecycle) => {
        if (closed) throw new Error('SSH shell tool is closed');
        const bound = bindShellSignal(signal, lifetime.signal, lifecycle);
        const operation = (async () => {
          try { return await this.execute(input, bound.signal, onUpdate, sessions, lifecycle); }
          finally { bound.release(); }
        })();
        active.add(operation);
        try { return await operation; } finally { active.delete(operation); }
      },
      close: () => {
        if (closing) return closing;
        closed = true;
        closing = Promise.resolve().then(async () => {
          lifetime.abort(new Error('SSH shell tool is closed'));
          await Promise.allSettled([...active, ...[...sessions.values()].map(session => session.close())]);
          this.#sessionGroups.delete(sessions);
          this.#toolRefs = Math.max(0, this.#toolRefs - 1);
          if (this.#closed && this.#toolRefs === 0) await this.#endClient();
        });
        return closing;
      }
    };
  }
}
export function createSSHTool(options) {
  const owned = !(options instanceof SSHCommands);
  const commands = owned ? new SSHCommands(options) : options;
  const tool = commands.tool(), close = tool.close;
  tool.close = async () => { await close(); if (owned) await commands.close(); };
  return tool;
}
