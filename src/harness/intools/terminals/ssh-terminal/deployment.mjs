import { lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, posix, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { requireText, integer, expandHome, jsonResult, textResult, abortError } from '../../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { DEPLOY_CATALOG, SFTP_CATALOG } from '../../shared/tool-catalogs.mjs';
import { shellQuote } from './commands.mjs';

/** Basenames skipped when exclude_defaults is enabled. */
export const DEFAULT_UPLOAD_EXCLUDES = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', 'coverage', '.cache'
]);

/** Hard limits and transfer tuning for SFTP upload / remote deploy. */
export const UPLOAD_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  streamHighWaterMark: 256 * 1024,
  progressIntervalMs: 1000,
  progressBytes: 4 * 1024 * 1024,
  progressMinFileBytes: 1024 * 1024,
  stallTimeoutMs: 120_000,
  minBandwidthBps: 128 * 1024,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 86_400,
  largestSamples: 8,
  maxExcludes: 64,
  fileConcurrency: 4
});

export function formatUploadBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MiB`;
  return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
}

export function recommendedUploadTimeoutSeconds(totalBytes, limits = UPLOAD_LIMITS) {
  const bytes = Math.max(0, Number(totalBytes) || 0);
  const transfer = Math.ceil(bytes / limits.minBandwidthBps);
  return Math.min(limits.maxTimeoutSeconds, Math.max(limits.defaultTimeoutSeconds, 60 + transfer));
}

export function resolveUploadTimeoutSeconds(totalBytes, requested, limits = UPLOAD_LIMITS) {
  const recommended = recommendedUploadTimeoutSeconds(totalBytes, limits);
  if (requested === undefined) return recommended;
  const value = integer(requested, limits.defaultTimeoutSeconds, 1, limits.maxTimeoutSeconds, 'timeout_seconds');
  // Honor short explicit deadlines for small transfers; only reject when the
  // size-based budget rises above the default floor and the caller undershot it.
  if (recommended > limits.defaultTimeoutSeconds && value < recommended) {
    throw new Error(
      `timeout_seconds (${value}) is too short for ${formatUploadBytes(totalBytes)}; ` +
      `need at least ${recommended}s assuming ~${formatUploadBytes(limits.minBandwidthBps)}/s. ` +
      `Raise timeout_seconds, or upload a smaller build artifact/archive.`
    );
  }
  return value;
}

/** Reject no-op health checks that cannot detect a failed deployment. */
export function assertMeaningfulHealthCheck(command) {
  const text = requireText(command, 'health_check_command');
  const normalized = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^\\])#.*$/, '$1').trim())
    .filter(Boolean)
    .join('; ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) throw new Error('health_check_command is empty after removing comments');
  if (/^(true|:|exit 0)(\s*;\s*(true|:|exit 0))*\s*;?$/i.test(normalized)) {
    throw new Error(
      'health_check_command rejects no-op commands such as true / : / exit 0. ' +
      'Use a real HTTP/protocol/content check that exits nonzero on transport, status or content failure.'
    );
  }
  if (/^echo\b/i.test(normalized) && !/[|`]|\$\(|\bgrep\b|\btest\b|\bcurl\b|\bwget\b|\bnc\b|\bopenssl\b/.test(normalized)) {
    throw new Error(
      'health_check_command rejects echo-only checks. Pipe into a verifier or use curl/wget/test against the service.'
    );
  }
  return text;
}

export async function mapPool(items, concurrency, worker) {
  const list = [...items];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency, list.length));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
}

function remotePath(value) {
  const path = requireText(value, 'remote_path');
  if (!posix.isAbsolute(path) || posix.normalize(path) === '/' || path.split('/').includes('..')) {
    throw new Error('remote_path must be an absolute remote path other than /, without ..');
  }
  return posix.normalize(path);
}

function rememberLargest(samples, entry, limit) {
  samples.push({ remote: entry.remote, size: entry.size, directory: entry.directory });
  samples.sort((a, b) => b.size - a.size);
  if (samples.length > limit) samples.length = limit;
}

function sizeLimitError(kind, size, limit, samples) {
  const top = samples.length
    ? ` Largest paths: ${samples.map(item => `${item.remote} (${formatUploadBytes(item.size)}${item.directory ? ', dir' : ''})`).join('; ')}.`
    : '';
  return new Error(
    `${kind} ${formatUploadBytes(size)} exceeds ${formatUploadBytes(limit)}.` +
    `${top} Upload a build artifact or archive, split the transfer, or shrink the source tree (e.g. exclude node_modules/.git).`
  );
}

function normalizeExcludes(value, excludeDefaults, limits = UPLOAD_LIMITS) {
  if (value !== undefined && (!Array.isArray(value) || value.length > limits.maxExcludes)) {
    throw new Error(`exclude must be an array of at most ${limits.maxExcludes} basenames`);
  }
  const names = new Set(excludeDefaults ? DEFAULT_UPLOAD_EXCLUDES : []);
  for (const item of value ?? []) {
    const text = requireText(item, 'exclude');
    if (text.includes('\0') || text === '.' || text === '..' || text.includes('/') || text.includes('\\')) {
      throw new Error('exclude entries must be single path basenames without separators');
    }
    names.add(text);
  }
  if (names.size > limits.maxExcludes + DEFAULT_UPLOAD_EXCLUDES.length) {
    throw new Error(`exclude set exceeds ${limits.maxExcludes + DEFAULT_UPLOAD_EXCLUDES.length} basenames`);
  }
  return names;
}

// Inspect the entire source before touching the server. Symlinks and special
// files are rejected instead of silently uploading data outside the source tree.
export async function buildUploadManifest(input, signal, limits = UPLOAD_LIMITS) {
  const source = expandHome(requireText(input.local_path, 'local_path'));
  if (!isAbsolute(source)) throw new Error('local_path must be an absolute local path');
  const localRoot = resolve(source);
  const remoteRoot = remotePath(input.remote_path);
  const exclude = normalizeExcludes(input.exclude, input.exclude_defaults === true, limits);
  const entries = [];
  const largest = [];
  const skipped = [];
  let totalBytes = 0;
  let fileCount = 0;

  async function walk(local, remote) {
    signal?.throwIfAborted();
    const stat = await lstat(local);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Upload supports only regular files and directories: ${local}`);
    }
    const entry = { local, remote, directory: stat.isDirectory(), size: stat.size, mode: stat.mode & 0o777 };
    if (!entry.directory) {
      if (entry.size > limits.maxFileBytes) {
        rememberLargest(largest, entry, limits.largestSamples);
        throw sizeLimitError('File', entry.size, limits.maxFileBytes, largest);
      }
      totalBytes += entry.size;
      fileCount++;
      if (totalBytes > limits.maxTotalBytes) {
        rememberLargest(largest, entry, limits.largestSamples);
        throw sizeLimitError('Upload total', totalBytes, limits.maxTotalBytes, largest);
      }
    }
    entries.push(entry);
    if (!entry.directory) rememberLargest(largest, entry, limits.largestSamples);
    if (entries.length > limits.maxEntries) {
      throw new Error(`Upload exceeds ${limits.maxEntries} entries; upload a build artifact or archive`);
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(local)).sort()) {
        if (exclude.has(name)) {
          skipped.push(posix.join(remote, name));
          continue;
        }
        await walk(join(local, name), posix.join(remote, name));
      }
    }
  }

  await walk(localRoot, remoteRoot);
  return {
    localRoot, remoteRoot, entries, fileCount, totalBytes, largest, skipped,
    exclude: [...exclude].sort(),
    skip_unchanged: input.skip_unchanged === true,
    dry_run: input.dry_run === true
  };
}

function createProgressTransform(entry, onUpdate, limits, stall, onBytes) {
  let transferred = 0;
  let lastReportAt = 0;
  let lastReportBytes = 0;
  const report = force => {
    if (!onUpdate || entry.size < limits.progressMinFileBytes) return;
    const now = Date.now();
    if (!force && transferred - lastReportBytes < limits.progressBytes && now - lastReportAt < limits.progressIntervalMs) return;
    lastReportAt = now;
    lastReportBytes = transferred;
    const pct = entry.size ? Math.min(100, Math.floor((transferred / entry.size) * 100)) : 100;
    try {
      onUpdate(textResult(
        `Uploading ${entry.remote}: ${formatUploadBytes(transferred)} / ${formatUploadBytes(entry.size)} (${pct}%)\n`
      ));
    } catch { /* progress must never fail the transfer */ }
  };

  return new Transform({
    highWaterMark: limits.streamHighWaterMark,
    transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      onBytes?.(chunk.length);
      stall?.touch();
      report(false);
      callback(null, chunk);
    },
    flush(callback) {
      report(true);
      callback();
    }
  });
}

function createStallWatch(active, controller, limits) {
  let lastByteAt = Date.now();
  const timer = setInterval(() => {
    if (active.aborted) return;
    if (Date.now() - lastByteAt >= limits.stallTimeoutMs) {
      controller.abort(new Error(
        `SFTP upload stalled for ${Math.round(limits.stallTimeoutMs / 1000)}s with no bytes transferred; ` +
        'remote state may be partial. Retry with a smaller artifact or a more stable link.'
      ));
    }
  }, Math.min(5_000, Math.max(1_000, Math.floor(limits.stallTimeoutMs / 4))));
  if (typeof timer.unref === 'function') timer.unref();
  return {
    touch() { lastByteAt = Date.now(); },
    stop() { clearInterval(timer); }
  };
}

function emit(onUpdate, text) {
  try { onUpdate?.(textResult(text)); } catch { /* progress must never fail the transfer */ }
}

async function withSftpSession(commands, signal, limits, onUpdate, work) {
  const client = await commands.waitForConnection(signal);
  signal.throwIfAborted();
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  let sftp;
  const disconnected = () => controller.abort(new Error('SSH transport closed during upload; remote state may be partial'));
  const failed = error => controller.abort(error);
  client.once('close', disconnected);
  client.on('error', failed);
  // Race every protocol request against cancellation, including a server that
  // never replies. A late subsystem is closed without affecting pooled SSH.
  const call = invoke => new Promise((resolveCall, reject) => {
    const cancel = () => { cleanup(); reject(abortError(active)); };
    const cleanup = () => active.removeEventListener('abort', cancel);
    active.addEventListener('abort', cancel, { once: true });
    if (active.aborted) { cancel(); return; }
    try { invoke((error, value) => { cleanup(); error ? reject(error) : resolveCall(value); }); }
    catch (error) { cleanup(); reject(error); }
  });
  const stall = createStallWatch(active, controller, limits);
  stall.touch();
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
    return await work({ active, call, request, mkdir, stall, sftp, onUpdate, limits });
  } finally {
    stall.stop();
    client.removeListener('close', disconnected);
    client.removeListener('error', failed);
    if (sftp) { sftp.removeListener('close', disconnected); sftp.end(); }
  }
}

async function publishFile(session, entry, fileMode, onBytes) {
  const { active, call, request, stall, sftp, onUpdate, limits } = session;
  const temporary = posix.join(posix.dirname(entry.remote), `.ubovm-${randomUUID()}.upload`);
  stall.touch();
  try {
    // ssh2 stream destruction can itself wait for a remote CLOSE response.
    // Bound that wait too, so cancellation reaches finally and ends SFTP.
    await call(done => {
      const destination = sftp.createWriteStream(temporary, {
        flags: 'wx',
        mode: fileMode ?? (process.platform === 'win32' ? 0o644 : entry.mode),
        highWaterMark: limits.streamHighWaterMark
      });
      const source = createReadStream(entry.local, { highWaterMark: limits.streamHighWaterMark });
      const progress = createProgressTransform(entry, onUpdate, limits, stall, onBytes);
      pipeline(source, progress, destination, { signal: active }).then(() => done(), done);
    });
    const stat = await request('stat', temporary);
    if (stat.size !== entry.size) throw new Error(`Uploaded size mismatch (source may have changed): ${entry.local}`);
    try { await request('ext_openssh_rename', temporary, entry.remote); }
    catch (error) {
      // Only fall back when the server explicitly lacks this extension.
      if (error.code !== 8 && error.message !== 'Server does not support this extended request') throw error;
      try { await request('rename', temporary, entry.remote); }
      catch (renameError) {
        // Portable SFTP rename cannot replace an existing file; remove then retry once.
        active.throwIfAborted();
        try { await request('unlink', entry.remote); } catch { throw renameError; }
        await request('rename', temporary, entry.remote);
      }
    }
  } catch (error) {
    // Cleanup is best effort and bounded by the same transfer deadline.
    if (!active.aborted) { try { await request('unlink', temporary); } catch {} }
    const failure = new Error(`SFTP upload failed at ${entry.remote}; previous files may already be published and temporary files may remain: ${error.message}`, { cause: error });
    failure.name = error.name;
    throw failure;
  }
}

async function publishViaSession(session, manifest, fileMode) {
  const { active, request, mkdir, stall, onUpdate, limits } = session;
  if (manifest.skipped?.length) {
    emit(onUpdate, `Skipping ${manifest.skipped.length} excluded path(s): ${manifest.skipped.slice(0, 12).join(', ')}${manifest.skipped.length > 12 ? ', …' : ''}\n`);
  }
  const concurrency = Math.max(1, limits.fileConcurrency || 1);
  emit(onUpdate,
    `Starting SFTP upload: ${manifest.fileCount} file(s), ${formatUploadBytes(manifest.totalBytes)}, concurrency ${Math.min(concurrency, Math.max(1, manifest.fileCount))}` +
    (manifest.totalBytes >= limits.progressMinFileBytes
      ? `, budget ~${formatUploadBytes(limits.minBandwidthBps)}/s\n`
      : '\n')
  );

  // Create the full directory skeleton before parallel file transfers.
  for (const entry of manifest.entries) {
    active.throwIfAborted();
    stall.touch();
    if (entry.directory) await mkdir(entry.remote);
    else await mkdir(posix.dirname(entry.remote));
  }

  const files = manifest.entries.filter(entry => !entry.directory);
  let settledFiles = 0;
  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let skippedUnchanged = 0;
  let transferredBytes = 0;
  let lastAggregateAt = 0;
  const onBytes = count => {
    transferredBytes += count;
    stall.touch();
    if (!onUpdate || manifest.totalBytes < limits.progressMinFileBytes) return;
    const now = Date.now();
    if (now - lastAggregateAt < limits.progressIntervalMs) return;
    lastAggregateAt = now;
    const pct = manifest.totalBytes ? Math.min(99, Math.floor((transferredBytes / manifest.totalBytes) * 100)) : 0;
    emit(onUpdate, `Upload progress: ${formatUploadBytes(transferredBytes)} / ${formatUploadBytes(manifest.totalBytes)} (${pct}%), ${settledFiles}/${files.length} file(s)\n`);
  };

  await mapPool(files, concurrency, async entry => {
    active.throwIfAborted();
    stall.touch();
    if (manifest.skip_unchanged) {
      try {
        const remote = await request('stat', entry.remote);
        const isFile = typeof remote.isFile === 'function' ? remote.isFile() : Boolean(remote.isFile);
        if (isFile && remote.size === entry.size) {
          skippedUnchanged++;
          settledFiles++;
          emit(onUpdate, `Skipped unchanged ${entry.remote} (${formatUploadBytes(entry.size)}) · ${settledFiles}/${files.length}\n`);
          return;
        }
      } catch {
        // Missing or inaccessible remote file → upload.
      }
    }
    await publishFile(session, entry, fileMode, onBytes);
    uploadedFiles++;
    uploadedBytes += entry.size;
    settledFiles++;
    stall.touch();
    emit(onUpdate, `Uploaded ${entry.remote} (${formatUploadBytes(entry.size)}) · ${settledFiles}/${files.length}\n`);
  });

  if (manifest.totalBytes >= limits.progressMinFileBytes) {
    emit(onUpdate, `Upload progress: ${formatUploadBytes(uploadedBytes)} transferred, ${skippedUnchanged} unchanged, ${files.length}/${files.length} file(s)\n`);
  }

  return {
    profile_id: undefined,
    remote_path: manifest.remoteRoot,
    files: uploadedFiles,
    bytes: uploadedBytes,
    skipped: manifest.skipped?.length ?? 0,
    skipped_unchanged: skippedUnchanged,
    concurrency: Math.min(concurrency, Math.max(1, files.length || 1))
  };
}

function planFromManifest(manifest, timeoutSeconds) {
  return {
    dry_run: true,
    remote_path: manifest.remoteRoot,
    files: manifest.fileCount,
    bytes: manifest.totalBytes,
    skipped: manifest.skipped?.length ?? 0,
    exclude: manifest.exclude,
    skip_unchanged: manifest.skip_unchanged === true,
    timeout_seconds: timeoutSeconds,
    largest: manifest.largest.slice(0, 5)
  };
}

export async function uploadSFTP(commands, input, signal, onUpdate, limits = UPLOAD_LIMITS) {
  const manifest = input.manifest ?? await buildUploadManifest(input, signal, limits);
  const seconds = resolveUploadTimeoutSeconds(manifest.totalBytes, input.timeout_seconds, limits);
  if (manifest.dry_run || input.dry_run === true) {
    emit(onUpdate, `Dry run: ${manifest.fileCount} file(s), ${formatUploadBytes(manifest.totalBytes)}, timeout ${seconds}s\n`);
    return jsonResult({ ...planFromManifest(manifest, seconds), profile_id: commands.summary().id });
  }
  const fileMode = input.file_mode === undefined ? undefined : integer(input.file_mode, 0o644, 0, 0o777, 'file_mode');
  const timeout = AbortSignal.timeout(seconds * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const details = await withSftpSession(commands, combined, limits, onUpdate, session => publishViaSession(session, {
    ...manifest,
    skip_unchanged: manifest.skip_unchanged || input.skip_unchanged === true
  }, fileMode));
  return jsonResult({
    ...details,
    profile_id: commands.summary().id,
    timeout_seconds: seconds
  });
}

const uploadFields = {
  // Optional in schema so help=true can be sent alone; execute still requires paths.
  local_path: Type.Optional(Type.String({ description: 'Absolute local file or directory path. Directory contents are copied to remote_path. Symlinks are rejected. Prefer a build artifact or archive over full source trees with node_modules/.git.' })),
  remote_path: Type.Optional(Type.String({ description: 'Exact absolute destination on the selected SSH host.' })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
    maxItems: UPLOAD_LIMITS.maxExcludes,
    description: 'Basenames to skip while walking directories (e.g. node_modules, .git, .venv). Not applied to the root path itself.'
  })),
  exclude_defaults: Type.Optional(Type.Boolean({ description: `Also skip common bulky basenames: ${DEFAULT_UPLOAD_EXCLUDES.join(', ')}.` })),
  skip_unchanged: Type.Optional(Type.Boolean({ description: 'Skip remote files whose size already matches the local source. Best-effort only (same size can differ in content).' })),
  dry_run: Type.Optional(Type.Boolean({ description: 'Validate and report the upload plan without opening SFTP or mutating the remote host.' })),
  file_mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 511, description: 'POSIX permissions as decimal (493 = 0755, 384 = 0600). Default: source permissions on POSIX, 0644 on Windows.' })),
  timeout_seconds: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 86400,
    description: 'Upload deadline. Default scales with total bytes (min 300s, assuming ~128 KiB/s). Explicit values below the size-based budget are rejected.'
  }))
};

export function createSFTPUploadTool(commands) {
  return withProgressiveDisclosure({
    name: 'upload_sftp', label: 'Upload via SFTP',
    description: SFTP_CATALOG.description,
    parameters: Type.Object({ ...uploadFields, ...flagHelpProperties() }, { additionalProperties: false }),
    execute: (_id, input, signal, onUpdate) => uploadSFTP(commands, input, signal, onUpdate)
  }, { ...SFTP_CATALOG, mode: 'flag' });
}

function resolveDeployUploadDeadline(uploads, manifests, limits) {
  const totalBytes = manifests.reduce((sum, item) => sum + item.totalBytes, 0);
  const explicit = uploads.map(item => item.timeout_seconds).filter(value => value !== undefined);
  if (!explicit.length) return resolveUploadTimeoutSeconds(totalBytes, undefined, limits);
  return resolveUploadTimeoutSeconds(totalBytes, Math.max(...explicit), limits);
}

export function createRemoteDeployTool(commands, limits = UPLOAD_LIMITS) {
  return withProgressiveDisclosure({
    name: 'deploy_remote_service', label: 'Deploy remote service',
    description: DEPLOY_CATALOG.description,
    parameters: Type.Object({
      uploads: Type.Optional(Type.Array(Type.Object(uploadFields, { additionalProperties: false }), { maxItems: 100 })),
      remote_cwd: Type.Optional(Type.String()),
      commands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
      health_check_command: Type.Optional(Type.String({ minLength: 1, description: 'A real protocol/HTTP request that checks expected status and meaningful content, and exits nonzero on any mismatch or connection failure. No true/echo-only checks or ignored errors. Use bounded readiness retries. A server-local check must be followed by independent verification of the actual user-facing endpoint.' })),
      dry_run: Type.Optional(Type.Boolean({ description: 'Validate uploads, excludes, timeouts and health_check_command without mutating the remote host or running deploy commands.' })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: commands.maxCommandTimeoutSeconds, description: 'Timeout per deploy/health command, bounded by the SSH profile limit.' })),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      const started = Date.now();
      const cwd = remotePath(input.remote_cwd);
      if (!Array.isArray(input.uploads) || input.uploads.length > 100) throw new Error('uploads must be an array of at most 100 items');
      if (!Array.isArray(input.commands) || !input.commands.length || input.commands.length > 100) throw new Error('commands must contain 1 to 100 commands');
      const steps = input.commands.map(command => requireText(command, 'command'));
      const health = assertMeaningfulHealthCheck(input.health_check_command);
      // Validate all local sources, sizes and timeouts before any remote mutation.
      if (input.timeout_seconds !== undefined) integer(input.timeout_seconds, 120, 1, commands.maxCommandTimeoutSeconds, 'timeout_seconds');
      const manifests = [];
      let deployBytes = 0;
      const largest = [];
      for (const upload of input.uploads) {
        if (upload.file_mode !== undefined) integer(upload.file_mode, 0o644, 0, 0o777, 'file_mode');
        if (upload.dry_run === true) throw new Error('Per-upload dry_run is invalid inside deploy_remote_service; set top-level dry_run instead');
        const manifest = await buildUploadManifest(upload, signal, limits);
        resolveUploadTimeoutSeconds(manifest.totalBytes, upload.timeout_seconds, limits);
        deployBytes += manifest.totalBytes;
        if (deployBytes > limits.maxTotalBytes) {
          for (const sample of manifest.largest) rememberLargest(largest, sample, limits.largestSamples);
          throw sizeLimitError('Deploy upload total', deployBytes, limits.maxTotalBytes, largest);
        }
        for (const sample of manifest.largest) rememberLargest(largest, sample, limits.largestSamples);
        manifests.push(manifest);
      }
      const uploadDeadline = resolveDeployUploadDeadline(input.uploads, manifests, limits);
      const fileCount = manifests.reduce((sum, item) => sum + item.fileCount, 0);
      emit(onUpdate,
        `Deploy plan: ${manifests.length} transfer(s), ${fileCount} file(s), ${formatUploadBytes(deployBytes)}, ` +
        `${steps.length} command(s), upload timeout ${uploadDeadline}s, concurrency ${limits.fileConcurrency}` +
        (input.dry_run === true ? ' (dry run)\n' : '\n')
      );
      if (input.dry_run === true) {
        return jsonResult({
          dry_run: true,
          status: 'planned',
          profile_id: commands.summary().id,
          remote_cwd: cwd,
          uploads: manifests.map((manifest, index) => planFromManifest(manifest, resolveUploadTimeoutSeconds(manifest.totalBytes, input.uploads[index].timeout_seconds, limits))),
          commands: steps,
          health_check_command: health,
          upload_bytes: deployBytes,
          upload_files: fileCount,
          upload_timeout_seconds: uploadDeadline,
          concurrency: limits.fileConcurrency,
          elapsed_ms: Date.now() - started
        });
      }
      const completed = [];
      const phases = [];
      let phase = 'upload';
      try {
        if (manifests.length) {
          const uploadStarted = Date.now();
          const timeout = AbortSignal.timeout(uploadDeadline * 1000);
          const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          await withSftpSession(commands, combined, limits, onUpdate, async session => {
            for (const [index, manifest] of manifests.entries()) {
              phase = `upload ${index + 1}/${manifests.length}`;
              emit(onUpdate, `Deploy ${phase}: ${manifest.remoteRoot}\n`);
              const fileMode = input.uploads[index].file_mode === undefined
                ? undefined
                : integer(input.uploads[index].file_mode, 0o644, 0, 0o777, 'file_mode');
              const details = await publishViaSession(session, {
                ...manifest,
                skip_unchanged: manifest.skip_unchanged || input.uploads[index].skip_unchanged === true
              }, fileMode);
              completed.push({
                ...details,
                profile_id: commands.summary().id,
                timeout_seconds: uploadDeadline
              });
            }
          });
          phases.push({
            phase: 'upload',
            status: 'ok',
            files: completed.reduce((n, item) => n + item.files, 0),
            bytes: completed.reduce((n, item) => n + item.bytes, 0),
            skipped_unchanged: completed.reduce((n, item) => n + (item.skipped_unchanged || 0), 0),
            elapsed_ms: Date.now() - uploadStarted
          });
        } else {
          phases.push({ phase: 'upload', status: 'skipped', files: 0, bytes: 0, elapsed_ms: 0 });
        }
        for (const [index, command] of steps.entries()) {
          phase = `command ${index + 1}`;
          emit(onUpdate, `Deploy ${phase}/${steps.length}\n`);
          const commandStarted = Date.now();
          await commands.execute({ command: `cd -- ${shellQuote(cwd)} && (\nset -e -o pipefail\n${command}\n)`, timeout_seconds: input.timeout_seconds }, signal, onUpdate);
          phases.push({ phase, status: 'ok', elapsed_ms: Date.now() - commandStarted });
        }
        phase = 'health check';
        emit(onUpdate, 'Deploy health check\n');
        const healthStarted = Date.now();
        const check = await commands.execute({ command: `cd -- ${shellQuote(cwd)} && (\nset -e -o pipefail\n${health}\n)`, timeout_seconds: input.timeout_seconds }, signal, onUpdate);
        phases.push({ phase: 'health check', status: 'ok', elapsed_ms: Date.now() - healthStarted });
        return jsonResult({
          profile_id: commands.summary().id,
          status: 'healthy',
          uploads: completed,
          commands_completed: steps.length,
          health_check: check,
          upload_bytes: deployBytes,
          upload_files: fileCount,
          upload_timeout_seconds: uploadDeadline,
          concurrency: limits.fileConcurrency,
          phases,
          elapsed_ms: Date.now() - started,
          note: 'Remote health check passed. Confirm user-facing accessibility separately before calling deployment successful.'
        });
      } catch (error) {
        const failure = new Error(
          `Deployment failed during ${phase}; remote changes may already be applied. No rollback was performed. ` +
          `Completed uploads: ${completed.length}/${manifests.length}. ${error.message}`,
          { cause: error }
        );
        failure.name = error.name;
        failure.details = {
          phase,
          uploads_completed: completed.length,
          uploads_planned: manifests.length,
          upload_bytes: deployBytes,
          phases,
          elapsed_ms: Date.now() - started
        };
        throw failure;
      }
    }
  }, { ...DEPLOY_CATALOG, mode: 'flag' });
}
