import ssh2 from 'ssh2';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Type } from 'typebox';
import { requireText, integer, expandHome, textResult, abortError } from './common.mjs';
import { openInteractiveShell } from './ssh-interactive.mjs';

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
    signal?.throwIfAborted();
    const pending = this.connect();
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError(signal));
      signal.addEventListener('abort', cancel, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    });
  }
  async execute(input, signal, onUpdate) {
    signal?.throwIfAborted();
    const command = requireText(input.command, 'command');
    const c = this.#config;
    const timeout = integer(input.timeout_seconds, c.default_command_timeout_seconds, 1, c.max_command_timeout_seconds, 'timeout_seconds');
    const client = await this.waitForConnection(signal);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const chunks = [];
      let stream, size = 0, finished = false, exitCode;
      const finish = error => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); client.removeListener('close', disconnected);
        const output = Buffer.concat(chunks).toString('utf8');
        if (error) {
          // AbortSignal reasons may be shared between commands or frozen by their
          // caller. Attach this command's output without mutating that reason.
          const failure = new Error(`${error.message ?? String(error)}${output ? `\n${output}` : ''}`, { cause: error });
          failure.name = error.name ?? 'Error';
          if (error.code !== undefined) failure.code = error.code;
          reject(failure);
        }
        else resolve(textResult(output, { exit_code: exitCode, profile_id: c.id ?? 'default' }));
      };
      const stop = error => { try { stream?.signal('KILL'); stream?.close(); } catch { /* transport closed */ } finish(error); };
      const cancel = () => stop(abortError(signal));
      const disconnected = () => finish(new Error('SSH transport closed during command; execution outcome is uncertain'));
      const timer = setTimeout(() => stop(new Error(`SSH command timed out after ${timeout} seconds`)), timeout * 1000 + 250);
      client.once('close', disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      client.exec(buildRemoteCommand(command, timeout), (error, channel) => {
        if (error) { finish(error); return; }
        stream = channel;
        if (finished || signal?.aborted) { try { channel.signal('KILL'); channel.close(); } catch {} if (!finished) cancel(); return; }
        const collect = (chunk, stderr) => {
          if (finished) return;
          const bytes = stderr ? Buffer.concat([Buffer.from('[stderr] '), chunk]) : chunk;
          const bounded = bytes.subarray(0, Math.max(0, c.max_output_bytes - size));
          if (bounded.length) { chunks.push(bounded); size += bounded.length; try { onUpdate?.(textResult(bounded.toString('utf8'))); } catch {} }
          if (bounded.length < bytes.length) stop(new Error(`SSH output exceeds ${c.max_output_bytes} bytes`));
        };
        channel.on('data', chunk => collect(chunk, false));
        channel.stderr.on('data', chunk => collect(chunk, true));
        channel.on('error', error => finish(error));
        channel.on('exit', (code, reason) => { exitCode = code; if (reason) exitCode = `signal ${reason}`; });
        channel.on('close', code => { exitCode ??= code; finish(exitCode === 0 ? undefined : new Error(`SSH command exited with ${exitCode ?? 'unknown status'}`)); });
      });
      if (signal?.aborted) cancel();
    });
  }
  async openInteractive({ columns = 80, rows = 24, signal } = {}) {
    integer(columns, 80, 1, 65535, 'columns'); integer(rows, 24, 1, 65535, 'rows');
    signal?.throwIfAborted();
    const client = await this.waitForConnection(signal);
    signal?.throwIfAborted();
    return openInteractiveShell(client, { columns, rows, signal });
  }
  async close() {
    this.#closed = true;
    this.#pendingClient?.destroy();
    this.#pendingClient = undefined;
    this.#client?.end();
    this.#client = undefined;
    try { await this.#connecting; } catch { /* a cancelled handshake rejects */ }
  }
  tool() {
    return {
      name: 'run_linux_ssh_command', label: 'Run SSH command', description: 'Execute a command on the host-selected Linux SSH profile, with streamed stdout/stderr and a remote timeout. Nonzero exits are errors. The model cannot change the SSH profile.',
      parameters: Type.Object({ command: Type.String(), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: this.#config.max_command_timeout_seconds })) }, { additionalProperties: false }),
      execute: (_id, input, signal, onUpdate) => this.execute(input, signal, onUpdate)
    };
  }
}
export function createSSHTool(options) { const commands = options instanceof SSHCommands ? options : new SSHCommands(options); return commands.tool(); }
