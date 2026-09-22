import { lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, join, posix, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { requireText, integer, expandHome, jsonResult, textResult, abortError } from './common.mjs';
import { shellQuote } from './ssh-commands-execute.mjs';

function remotePath(value) {
  const path = requireText(value, 'remote_path');
  if (!posix.isAbsolute(path) || posix.normalize(path) === '/' || path.split('/').includes('..')) throw new Error('remote_path must be an absolute remote path other than /, without ..');
  return posix.normalize(path);
}

// Inspect the entire source before touching the server. Symlinks and special
// files are rejected instead of silently uploading data outside the source tree.
async function manifest(input, signal) {
  const source = expandHome(requireText(input.local_path, 'local_path'));
  if (!isAbsolute(source)) throw new Error('local_path must be an absolute local path');
  const local = resolve(source);
  const remote = remotePath(input.remote_path);
  const entries = [];
  async function walk(local, remote) {
    signal?.throwIfAborted();
    const stat = await lstat(local);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Upload supports only regular files and directories: ${local}`);
    entries.push({ local, remote, directory: stat.isDirectory(), size: stat.size, mode: stat.mode & 0o777 });
    if (entries.length > 10000) throw new Error('Upload exceeds 10000 entries; upload a build artifact or archive');
    if (stat.isDirectory()) {
      for (const name of (await readdir(local)).sort()) await walk(join(local, name), posix.join(remote, name));
    }
  }
  await walk(local, remote);
  return entries;
}

export async function uploadSFTP(commands, input, signal, onUpdate) {
  const seconds = integer(input.timeout_seconds, 300, 1, 86400, 'timeout_seconds');
  const fileMode = input.file_mode === undefined ? undefined : integer(input.file_mode, 0o644, 0, 0o777, 'file_mode');
  const timeout = AbortSignal.timeout(seconds * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const entries = await manifest(input, combined);
  const client = await commands.waitForConnection(combined);
  combined.throwIfAborted();
  const controller = new AbortController();
  const active = AbortSignal.any([combined, controller.signal]);
  let sftp;
  const disconnected = () => controller.abort(new Error('SSH transport closed during upload; remote state may be partial'));
  const failed = error => controller.abort(error);
  client.once('close', disconnected);
  client.on('error', failed);
  // Race every protocol request against cancellation, including a server that
  // never replies. A late subsystem is closed without affecting pooled SSH.
  const call = invoke => new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(abortError(active)); };
    const cleanup = () => active.removeEventListener('abort', cancel);
    active.addEventListener('abort', cancel, { once: true });
    if (active.aborted) { cancel(); return; }
    try { invoke((error, value) => { cleanup(); error ? reject(error) : resolve(value); }); }
    catch (error) { cleanup(); reject(error); }
  });
  try {
    sftp = await call(done => client.sftp((error, channel) => {
      if (channel) {
        channel.on('error', failed);
        if (active.aborted) { channel.end(); return; }
      }
      done(error, channel);
    }));
    sftp.once('close', disconnected);
    const request = (method, ...args) => call(done => sftp[method](...args, done));
    const directories = new Set(['/']);
    async function mkdir(path) {
      if (directories.has(path)) return;
      await mkdir(posix.dirname(path));
      try { await request('mkdir', path); }
      catch (error) {
        active.throwIfAborted();
        const stat = await request('stat', path);
        if (!stat.isDirectory()) throw error;
      }
      directories.add(path);
    }
    let files = 0, bytes = 0;
    for (const entry of entries) {
      active.throwIfAborted();
      if (entry.directory) { await mkdir(entry.remote); continue; }
      await mkdir(posix.dirname(entry.remote));
      const temporary = posix.join(posix.dirname(entry.remote), `.ubovm-${randomUUID()}.upload`);
      try {
        // ssh2 stream destruction can itself wait for a remote CLOSE response.
        // Bound that wait too, so cancellation reaches finally and ends SFTP.
        await call(done => {
          const destination = sftp.createWriteStream(temporary, { flags: 'wx', mode: fileMode ?? (process.platform === 'win32' ? 0o644 : entry.mode) });
          pipeline(createReadStream(entry.local), destination, { signal: active }).then(() => done(), done);
        });
        const stat = await request('stat', temporary);
        if (stat.size !== entry.size) throw new Error(`Uploaded size mismatch (source may have changed): ${entry.local}`);
        try { await request('ext_openssh_rename', temporary, entry.remote); }
        catch (error) {
          // Only fall back when the server explicitly lacks this extension.
          // Standard SFTP rename can fail if the destination already exists.
          if (error.code !== 8 && error.message !== 'Server does not support this extended request') throw error;
          await request('rename', temporary, entry.remote);
        }
      } catch (error) {
        // Cleanup is best effort and bounded by the same transfer deadline.
        if (!active.aborted) { try { await request('unlink', temporary); } catch {} }
        const failure = new Error(`SFTP upload failed at ${entry.remote}; previous files may already be published and temporary files may remain: ${error.message}`, { cause: error });
        failure.name = error.name;
        throw failure;
      }
      files++; bytes += entry.size;
      try { onUpdate?.(textResult(`Uploaded ${entry.remote} (${entry.size} bytes)\n`)); } catch {}
    }
    return jsonResult({ profile_id: commands.summary().id, remote_path: remotePath(input.remote_path), files, bytes });
  } finally {
    client.removeListener('close', disconnected);
    client.removeListener('error', failed);
    if (sftp) { sftp.removeListener('close', disconnected); sftp.end(); }
  }
}

const uploadFields = {
  local_path: Type.String({ description: 'Absolute local file or directory path. Directory contents are copied to remote_path. Symlinks are rejected.' }),
  remote_path: Type.String({ description: 'Exact absolute destination on the selected SSH host.' }),
  file_mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 511, description: 'POSIX permissions as decimal (493 = 0755, 384 = 0600). Default: source permissions on POSIX, 0644 on Windows.' })),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400, description: 'Upload deadline, default 300 seconds.' }))
};

export function createSFTPUploadTool(commands) {
  return {
    name: 'upload_sftp', label: 'Upload via SFTP',
    description: 'Upload a local file or directory through the host-selected SSH profile. Creates parent directories; publishes each file with rename after checking byte size. Existing files are replaced on OpenSSH; other servers may reject overwrites. Does not delete stale remote files. A directory upload is not atomic. Use a fresh release directory for deployments. No automatic retries.',
    parameters: Type.Object(uploadFields, { additionalProperties: false }),
    execute: (_id, input, signal, onUpdate) => uploadSFTP(commands, input, signal, onUpdate)
  };
}

export function createRemoteDeployTool(commands) {
  return {
    name: 'deploy_remote_service', label: 'Deploy remote service',
    description: 'Deploy to the host-selected Linux SSH profile: upload artifacts, execute deployment commands in order, then run a required health-check command. Commands run in remote_cwd using bash and must return zero. Use a service manager (systemd or Docker) for persistent services. Stops on first failure, never retries or rolls back automatically; inspect remote state before retrying. A healthy result only means the supplied remote check exited zero; it does not prove user-facing accessibility. Before reporting deployment success, independently verify the actual service endpoint from its intended client network with meaningful response/content checks; for web apps also load the page and verify a core flow using the browser. Failed or unavailable verification means deployment is unverified, never successful.',
    parameters: Type.Object({
      uploads: Type.Array(Type.Object(uploadFields, { additionalProperties: false }), { maxItems: 100 }),
      remote_cwd: Type.String(),
      commands: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
      health_check_command: Type.String({ minLength: 1, description: 'A real protocol/HTTP request that checks expected status and meaningful content, and exits nonzero on any mismatch or connection failure. No true/echo-only checks or ignored errors. Use bounded readiness retries. A server-local check must be followed by independent verification of the actual user-facing endpoint.' }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: commands.maxCommandTimeoutSeconds, description: 'Timeout per command, bounded by the SSH profile limit.' }))
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      const cwd = remotePath(input.remote_cwd);
      if (!Array.isArray(input.uploads) || input.uploads.length > 100) throw new Error('uploads must be an array of at most 100 items');
      if (!Array.isArray(input.commands) || !input.commands.length || input.commands.length > 100) throw new Error('commands must contain 1 to 100 commands');
      const steps = input.commands.map(command => requireText(command, 'command'));
      const health = requireText(input.health_check_command, 'health_check_command');
      // Validate all local sources and timeouts before any remote mutation.
      if (input.timeout_seconds !== undefined) integer(input.timeout_seconds, 120, 1, commands.maxCommandTimeoutSeconds, 'timeout_seconds');
      for (const upload of input.uploads) {
        integer(upload.timeout_seconds, 300, 1, 86400, 'timeout_seconds');
        if (upload.file_mode !== undefined) integer(upload.file_mode, 0o644, 0, 0o777, 'file_mode');
        await manifest(upload, signal);
      }
      const completed = [];
      let phase = 'upload';
      try {
        for (const upload of input.uploads) completed.push((await uploadSFTP(commands, upload, signal, onUpdate)).details);
        for (const [index, command] of steps.entries()) {
          phase = `command ${index + 1}`;
          await commands.execute({ command: `cd -- ${shellQuote(cwd)} && (\nset -e -o pipefail\n${command}\n)`, timeout_seconds: input.timeout_seconds }, signal, onUpdate);
        }
        phase = 'health check';
        const check = await commands.execute({ command: `cd -- ${shellQuote(cwd)} && (\nset -e -o pipefail\n${health}\n)`, timeout_seconds: input.timeout_seconds }, signal, onUpdate);
        return jsonResult({ profile_id: commands.summary().id, status: 'healthy', uploads: completed, commands_completed: steps.length, health_check: check });
      } catch (error) {
        const failure = new Error(`Deployment failed during ${phase}; remote changes may already be applied. No rollback was performed. ${error.message}`, { cause: error });
        failure.name = error.name;
        throw failure;
      }
    }
  };
}
