import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const markerName = '.ubovm-python-runtime.json';
const lockId = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
const lockPath = `\\\\.\\pipe\\ubovm-python-build-${lockId}`;

// OS-owned locks release on process death, without stale PID files. On macOS
// use loopback because filesystem sockets survive a killed process.
export async function acquirePythonBuildLease(signal = AbortSignal.timeout(180000)) {
  const address = process.platform === 'win32' ? lockPath : process.platform === 'linux'
    ? `\0ubovm-python-build-${lockId}` : { host: '127.0.0.1', port: 20000 + parseInt(lockId.slice(0, 8), 16) % 40000, exclusive: true };
  while (true) {
    signal.throwIfAborted();
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
      return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE') throw error;
      await delay(100, undefined, { signal });
    }
  }
}
function managed(path) {
  path = resolve(path); const part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Python build path must be inside the project: ' + path);
  return path;
}
async function digest(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export function pythonAsset(manifest, platform = process.platform, arch = process.arch) {
  const asset = manifest.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`No bundled Python for ${platform}-${arch}`);
  const filename = `cpython-${manifest.version}+${manifest.release}-${asset.target}-install_only_stripped.tar.gz`;
  return { ...asset, version: manifest.version, platform, arch, filename,
    url: `https://github.com/${manifest.provider}/releases/download/${manifest.release}/${encodeURIComponent(filename)}` };
}
export async function verifyPythonRuntime(directory, asset, executeProbe = execute) {
  // Only fixed build-time code, never user/AI code. -I ignores host Python
  // configuration and -B avoids changing the runtime during verification.
  const { stdout } = await executeProbe(join(directory, asset.executable), ['-I', '-B', '-c',
    'import sys,ssl,sqlite3,venv;print(".".join(map(str,sys.version_info[:3])))'],
  { timeout: 30000, maxBuffer: 1 << 20, windowsHide: true, cwd: directory });
  if (stdout.trim() !== asset.version) throw new Error('Unexpected Python runtime version: ' + stdout.trim());
}
export async function completePythonRuntime(directory, asset, executeProbe = execute) {
  try {
    const marker = JSON.parse(await readFile(join(directory, markerName), 'utf8'));
    if (marker.sha256 !== asset.sha256) return false;
    await verifyPythonRuntime(directory, asset, executeProbe); return true;
  } catch { return false; }
}
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function recoverPythonRuntime(destination) {
  destination = managed(destination);
  const backup = managed(destination + '.previous');
  if (await exists(backup) && !await exists(destination)) await rename(backup, destination);
}
export async function replacePythonRuntime(staging, destination, renamePath = rename) {
  staging = managed(staging); destination = managed(destination);
  const backup = managed(destination + '.previous');
  await recoverPythonRuntime(destination);
  await mkdir(dirname(destination), { recursive: true });
  // A leftover backup means a prior promotion finished before its cleanup.
  await rm(backup, { recursive: true, force: true });
  const hadPrevious = await exists(destination);
  if (hadPrevious) await renamePath(destination, backup);
  try { await renamePath(staging, destination); }
  catch (error) {
    if (hadPrevious) {
      try { await renamePath(backup, destination); }
      catch (rollback) { throw new AggregateError([error, rollback], `Python runtime replacement failed; previous runtime retained at ${backup}`); }
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}
export async function preparePython(destination) {
  // Validate before downloads, copying, or locking; one project build at a time.
  if (destination) destination = managed(destination);
  const release = await acquirePythonBuildLease();
  try { return await preparePythonLocked(destination); } finally { await release(); }
}
async function preparePythonLocked(destination) {
  const manifest = JSON.parse(await readFile(join(root, 'resources/python-runtime.json'), 'utf8'));
  const asset = pythonAsset(manifest);
  const cached = managed(join(root, '.runtime', `python-${asset.platform}-${asset.arch}`));
  const cache = managed(join(root, '.cache/python'));
  await mkdir(cache, { recursive: true });
  await recoverPythonRuntime(cached);
  if (!await completePythonRuntime(cached, asset)) {
    const archive = managed(join(cache, asset.filename));
    let valid = false; try { valid = await digest(archive) === asset.sha256; } catch { /* download */ }
    if (!valid) {
      const partial = managed(archive + '.' + randomUUID() + '.partial');
      // Match build/build.ps1 archive downloads: allow slow GitHub links (no hard 3-minute cut).
      const downloadMs = 1_800_000;
      try {
        console.log(`[Python] Downloading CPython ${asset.version} (${asset.platform}-${asset.arch})`);
        let response;
        try {
          response = await fetch(asset.url, { signal: AbortSignal.timeout(downloadMs) });
        } catch (error) {
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
            throw new Error(`Python download timed out after ${downloadMs / 60000} minutes (${asset.url})`);
          throw error;
        }
        if (!response.ok || !response.body) throw new Error(`Python download failed: HTTP ${response.status}`);
        let bytes = 0, reported = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes - reported >= 1024 * 1024) {
            reported = bytes;
            console.log(`[Python] Downloaded ${(bytes / (1024 * 1024)).toFixed(1)} MiB`);
          }
          callback(bytes > 250 * 1024 * 1024 ? new Error('Python archive exceeds limit') : null, chunk);
        } }), createWriteStream(partial, { flags: 'wx' }));
        if (await digest(partial) !== asset.sha256) throw new Error('Python archive SHA-256 mismatch');
        await rm(archive, { force: true }); await rename(partial, archive);
      } finally { await rm(partial, { force: true }); }
    }
    const staging = managed(join(cache, 'extract-' + randomUUID())); await mkdir(staging);
    try {
      const { stdout } = await execute('tar', ['-tzf', archive], { maxBuffer: 16 << 20, timeout: 30000, windowsHide: true });
      if (stdout.split(/\r?\n/).filter(Boolean).some(name => !name.startsWith('python/') || name.split(/[\\/]/).includes('..')))
        throw new Error('Unsafe Python archive layout');
      await execute('tar', ['-xzf', archive, '-C', staging], { timeout: 120000, windowsHide: true });
      const extracted = managed(join(staging, 'python'));
      await verifyPythonRuntime(extracted, asset);
      await writeFile(join(extracted, markerName), JSON.stringify(asset, null, 2) + '\n');
      await replacePythonRuntime(extracted, cached);
    } finally { await rm(managed(staging), { recursive: true, force: true }); }
  }
  if (destination) {
    destination = managed(destination);
    await recoverPythonRuntime(destination);
    if (destination !== cached && !await completePythonRuntime(destination, asset)) {
      const staging = managed(destination + '.staging-' + randomUUID());
      try {
        await cp(cached, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
        await verifyPythonRuntime(staging, asset);
        await replacePythonRuntime(staging, destination);
      } finally { await rm(managed(staging), { recursive: true, force: true }); }
    }
  }
  console.log(`[Python] Ready: ${join(destination || cached, asset.executable)}`);
  return join(destination || cached, asset.executable);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await preparePython(process.argv[2]); } catch (error) { console.error('[Python] ' + error.message); process.exitCode = 1; }
}
