import { randomUUID } from 'node:crypto';
import { createProcessOutput } from './process-output.mjs';
import { abortError, textResult, errorFields } from '../common.mjs';
import { ShellQueue } from './shell-queue.mjs';
import { abortableSetup } from './abortable-setup.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const ignoreTransportError = () => {};
const notifyStopping = lifecycle => {
  try { lifecycle?.stopping?.(); } catch { /* Status observers cannot prevent shell cleanup. */ }
};

// Each stream has its own completion frame: stdout can finish before stderr.
// Frames are random, byte-delimited, and never depend on prompts or newlines.
export function shellScript(command, token, windows = false, cwd) {
  if (windows) {
    const source = `${cwd === undefined ? '' : `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}';\n`}${command}`;
    const encoded = Buffer.from(source, 'utf8').toString('base64');
    return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $global:LASTEXITCODE=0; $${token}=0; try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) | Out-String -Stream | ForEach-Object { [Console]::WriteLine($_) }; $${token}=$global:LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); $${token}=1 }; [Console]::Out.Write(([char]30)+'${token}:'+$${token}+([char]31)); [Console]::Error.Write(([char]30)+'${token}:'+$${token}+([char]31)); Remove-Variable ${token} -ErrorAction SilentlyContinue\n`;
  }
  const source = `${cwd === undefined ? '' : `cd ${quote(cwd)} && `}eval ${quote(command)}`;
  return `${source}\n${token}=$?\nprintf '\\036${token}:%s\\037' "$${token}"\nprintf '\\036${token}:%s\\037' "$${token}" >&2\nunset ${token}\n`;
}

export class PersistentShell {
  #open; #windows; #transport; #detachTransport; #queue = new ShellQueue(); #cleanup = Promise.resolve({}); #active; #closed = false; #broken = false;
  constructor(open, { windows = false } = {}) { this.#open = open; this.#windows = windows; }
  execute(command, options, signal, onUpdate) {
    signal?.throwIfAborted();
    if (this.#closed) return Promise.reject(new Error('Shell session is closed'));
    const phase = value => {
      try { Promise.resolve(onUpdate?.(textResult('', { execution_state: value }))).catch(() => {}); } catch { /* observer */ }
    };
    return this.#queue.run((waitMs, control) => this.#execute(command, options, signal, onUpdate, phase, waitMs, control), {
      signal, waitSeconds: options.timeout, onQueued: () => phase('queued')
    });
  }
  async #execute(command, { timeout, maxOutputBytes, details = {}, cwd, reset = false, prepare, lifecycle }, signal, onUpdate, phase, waitMs, { park } = {}) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error('Shell session is closed');
    // One soft auto-reset after timeout/cancel/disconnect so callers need not
    // remember reset_session; explicit reset_session still forces a fresh shell.
    const autoReset = this.#broken && !reset;
    if (reset || this.#broken) { await this.#dispose(); this.#broken = false; signal?.throwIfAborted(); }
    if (this.#closed) throw new Error('Shell session is closed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Shell command timed out after ${timeout} seconds`)), timeout * 1000);
    let unsubscribe, transport;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const cancel = () => { notifyStopping(lifecycle); phase('stopping'); this.#broken = true; this.#active?.(abortError(combined)); this.#dispose(); };
    this.#active = error => controller.abort(error);
    combined.addEventListener('abort', cancel, { once: true });
    let opening = false;
    const detachForResident = () => {
      // Hand the live transport to this command only and free the named session
      // so later calls can open a fresh shell without waiting on npm run dev.
      this.#broken = true;
      if (this.#transport && this.#transport === transport) {
        this.#detachTransport?.();
        this.#detachTransport = undefined;
        this.#transport = undefined;
      }
      park?.();
    };
    try {
      unsubscribe = lifecycle?.subscribe(() => { clearTimeout(timer); detachForResident(); });
      phase('starting');
      if (prepare) cwd = (await abortableSetup(combined, () => prepare(combined))).cwd;
      combined.throwIfAborted();
      if (!this.#transport) {
        opening = true;
        transport = await abortableSetup(combined, () => this.#open(combined), value => value.close());
        this.#transport = transport;
        opening = false;
        const lost = error => {
          if (this.#transport !== transport && transport) {
            // Orphaned resident transport: surface to the active command only.
            this.#active?.(error ?? new Error('Shell exited; session lost'));
            return;
          }
          if (this.#transport !== transport) return;
          this.#broken = true;
          this.#active?.(error ?? new Error('Shell exited; session lost'));
          this.#dispose();
        };
        const closed = () => lost();
        this.#detachTransport = () => {
          transport.events.removeListener('close', closed);
          transport.events.removeListener('error', lost);
          transport.events.on('error', ignoreTransportError);
        };
        transport.events.once('close', closed);
        transport.events.on('error', lost);
        if (lifecycle?.resident) detachForResident();
      } else {
        transport = this.#transport;
        if (lifecycle?.resident) detachForResident();
      }
      combined.throwIfAborted();
      phase('running');
      combined.throwIfAborted();
      return await this.#run(command, { maxOutputBytes, lifecycle, details: { ...details, queue_wait_ms: Math.round(waitMs), ...(autoReset ? { session_auto_reset: true } : {}) }, cwd }, combined, onUpdate, transport);
    } catch (error) {
      if (opening || combined.aborted) { this.#broken = true; await this.#dispose(); }
      throw error;
    } finally {
      try { unsubscribe?.(); }
      finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); this.#active = undefined; }
    }
  }
  #run(command, { maxOutputBytes, details, cwd, lifecycle }, signal, onUpdate, transport) {
    return new Promise((resolve, reject) => {
      const token = `ubovm_${randomUUID().replaceAll('-', '')}`;
      const prefix = Buffer.from(`\x1e${token}:`);
      const buffers = [Buffer.alloc(0), Buffer.alloc(0)], codes = [undefined, undefined];
      const output = createProcessOutput(maxOutputBytes, onUpdate, { rolling: () => lifecycle?.resident === true });
      let finished = false;
      const finish = (error, broken = false) => {
        if (finished) return; finished = true;
        transport.stdout.removeListener('data', out); transport.stderr.removeListener('data', err);
        transport.events.removeListener('close', closed);
        transport.events.removeListener('error', failed);
        signal.removeEventListener('abort', cancelled);
        if (broken) { notifyStopping(lifecycle); this.#broken = true; }
        const orphaned = this.#transport !== transport;
        const cleanup = orphaned
          ? Promise.resolve().then(() => transport.close()).then(result => result ?? {}, () => ({ cleanup_confirmed: false }))
          : broken ? this.#dispose() : Promise.resolve({});
        const text = output.finish();
        const metadata = { ...details, exit_code: codes[0] ?? null, session_lost: broken };
        cleanup.then(result => {
          Object.assign(metadata, result);
          if (error || broken) {
            const warning = result.remote_termination_confirmed === false ? '\nSSH remote process termination is unconfirmed; verify remote state before retrying.' : result.process_closed === false || result.cleanup_confirmed === false ? '\nShell process cleanup is unconfirmed; verify local state before retrying.' : '';
            const fields = errorFields(error);
            const failure = new Error(`${fields.message}${warning}${text ? `\n${text}` : ''}`, { cause: error });
            failure.name = fields.name; if (fields.code !== undefined) failure.code = fields.code;
            failure.details = metadata; reject(failure);
          } else resolve(textResult(text, metadata));
        });
      };
      const publish = (data, index) => {
        if (data.length && !output.write(data, Boolean(index))) finish(new Error(`Shell output exceeds ${maxOutputBytes} bytes`), true);
      };
      const collect = (chunk, index) => {
        if (finished || codes[index] !== undefined) return;
        let data = Buffer.concat([buffers[index], Buffer.from(chunk)]);
        const start = data.indexOf(prefix);
        if (start !== -1) {
          publish(data.subarray(0, start), index);
          data = data.subarray(start);
          const end = data.indexOf(31, prefix.length);
          if (end !== -1) {
            const status = data.subarray(prefix.length, end).toString();
            if (!/^-?\d{1,10}$/.test(status)) { finish(new Error('Invalid shell completion frame'), true); return; }
            codes[index] = Number(status); buffers[index] = Buffer.alloc(0); output.end(Boolean(index));
            if (output.truncated && !lifecycle?.resident) { finish(new Error(`Shell output exceeds ${maxOutputBytes} bytes`), true); return; }
            if (codes.every(code => code !== undefined)) {
              if (codes[0] !== codes[1]) finish(new Error('Shell completion frames disagree; session lost'), true);
              else finish(codes[0] === 0 ? undefined : new Error(`Shell command exited with code ${codes[0]}`));
            }
            return;
          }
          if (data.length > prefix.length + 12) { finish(new Error('Invalid shell completion frame'), true); return; }
          buffers[index] = data; return;
        }
        // Only retain a possible frame prefix, so short output streams promptly.
        let keep = Math.min(prefix.length - 1, data.length);
        while (keep && !data.subarray(data.length - keep).equals(prefix.subarray(0, keep))) keep--;
        publish(data.subarray(0, data.length - keep), index);
        buffers[index] = data.subarray(data.length - keep);
      };
      const out = chunk => collect(chunk, 0), err = chunk => collect(chunk, 1);
      const closed = () => finish(new Error('Shell exited before command completion; session lost'), true);
      const failed = error => finish(error, true);
      const cancelled = () => finish(abortError(signal), true);
      this.#active = failed;
      transport.stdout.on('data', out); transport.stderr.on('data', err);
      transport.events.once('close', closed); transport.events.on('error', failed);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      try {
        // SSH startup pauses while handing buffered initial output to us.
        transport.stdout.resume?.();
        if (!finished) transport.write(shellScript(command, token, this.#windows, cwd));
      } catch (error) { failed(error); }
      if (signal.aborted) cancelled();
    });
  }
  #dispose() {
    const transport = this.#transport; this.#transport = undefined;
    if (!transport) return this.#cleanup;
    this.#detachTransport?.(); this.#detachTransport = undefined;
    this.#cleanup = new Promise(resolve => {
      const timer = setTimeout(() => resolve({ cleanup_confirmed: false }), 2500);
      Promise.resolve().then(() => transport.close()).then(result => { clearTimeout(timer); resolve(result ?? {}); }, () => { clearTimeout(timer); resolve({ cleanup_confirmed: false }); });
    });
    return this.#cleanup;
  }
  async close() {
    this.#closed = true;
    this.#active?.(new Error('Shell session is closed'));
    await Promise.all([this.#dispose(), this.#queue.close()]);
  }
}

export function namedShell(sessions, name, create) {
  if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) throw new Error('session must contain 1-64 letters, digits, underscores, dots or hyphens');
  if (!sessions.has(name)) {
    if (sessions.size >= 16) throw new Error('Shell session limit reached (16); reuse an existing session with reset_session=true');
    sessions.set(name, create());
  }
  return sessions.get(name);
}
