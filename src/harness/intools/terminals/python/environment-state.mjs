import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contained } from '../../shared/common.mjs';

const folder = '.ubovm-python';
export const environmentPython = directory => join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const environmentMatchesBase = (state, python) => Boolean(state && state.baseExecutable === python.executable && state.baseTarget === python.executableTarget);

async function readBoundedFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed Python metadata must be a regular file');
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 65536)
      throw new Error('Managed Python metadata changed or exceeds 64 KiB');
    const buffer = Buffer.alloc(65537); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65536) throw new Error('Managed Python metadata exceeds 64 KiB');
    const after = await file.stat();
    if (after.size !== offset || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw new Error('Managed Python metadata changed while reading');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}

export async function validatePythonEnvironmentFiles(directory) {
  if (await realpath(directory) !== directory) throw new Error('Managed Python environment path changed');
  const executable = environmentPython(directory), target = await realpath(executable);
  if (!contained(directory, target)) throw new Error('Managed Python interpreter points outside its environment');
  const info = await lstat(target);
  if (!info.isFile() || !info.size) throw new Error('Managed Python interpreter is missing or empty');
  const config = await readBoundedFile(join(directory, 'pyvenv.cfg'));
  const homes = [...config.matchAll(/^home\s*=\s*(.+)$/gmi)];
  const site = [...config.matchAll(/^include-system-site-packages\s*=\s*(.+)$/gmi)];
  if (homes.length !== 1 || !isAbsolute(homes[0][1].trim()) || site.length !== 1 || site[0][1].trim().toLowerCase() !== 'false')
    throw new Error('Managed Python venv configuration is invalid or enables system packages');
  return { directory, executableTarget: target, configHash: createHash('sha256').update(config).digest('hex'),
    // ACL setup changes metadata timestamps on some filesystems; do not treat
    // that expected permission change as replacement of interpreter contents.
    executableIdentity: [info.dev, info.ino, info.size, info.mtimeMs] };
}

async function stateDirectory(workspace, create = false) {
  const directory = join(workspace, folder);
  if (create) await mkdir(directory, { recursive: true });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory)
      throw new Error('Managed Python state must be a real workspace directory');
  } catch (error) { if (!create && error.code === 'ENOENT') return; throw error; }
  return directory;
}

export async function readPythonEnvironment(workspace) {
  const directory = await stateDirectory(workspace); if (!directory) return null;
  let stateRead = false;
  try {
    const path = join(directory, 'environment.json');
    const data = await readBoundedFile(path); stateRead = true;
    const state = JSON.parse(data);
    if (state === null) return null;
    if (state.version !== 1 || typeof state.directory !== 'string' || typeof state.baseExecutable !== 'string' || typeof state.baseTarget !== 'string'
      || !isAbsolute(state.directory) || !isAbsolute(state.baseExecutable) || !isAbsolute(state.baseTarget)
      || !['pip', 'uv'].includes(state.manager) || !Array.isArray(state.packages) || state.packages.length > 100
      || state.packages.some(item => typeof item !== 'string' || item.length > 256))
      throw new Error('Invalid managed Python state; sync or reset the environment');
    const parts = relative(workspace, state.directory).split(sep);
    if (parts.length !== 3 || parts[0] !== '.ubovm-python-output' || !/^run-[a-f0-9-]{36}$/.test(parts[1]) || parts[2] !== 'environment')
      throw new Error('Managed Python environment escaped its owned output directory');
    if (await realpath(state.directory) !== state.directory || await realpath(join(workspace, '.ubovm-python-output')) !== join(workspace, '.ubovm-python-output'))
      throw new Error('Managed Python environment path changed');
    await validatePythonEnvironmentFiles(state.directory);
    return state;
  } catch (error) {
    if (error.code === 'ENOENT' && !stateRead) return null;
    throw Object.assign(new Error(`Managed Python environment is unavailable: ${error.message}. Use manage_python_environment sync or reset to recover.`, { cause: error }),
      { code: 'PYTHON_ENVIRONMENT_INVALID' });
  }
}

export async function publishPythonEnvironment(workspace, state, signal) {
  signal?.throwIfAborted();
  const directory = await stateDirectory(workspace, true), temporary = join(directory, randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state, null, 2) + '\n');
      // Flush the complete selection before publishing its name. A crash must
      // not expose a new environment.json whose data is still unwritten.
      await file.sync();
    } finally { await file.close(); }
    await stateDirectory(workspace);
    signal?.throwIfAborted();
    await rename(temporary, join(directory, 'environment.json'));
  } finally { await rm(temporary, { force: true }); }
}

// A separate lock from sandbox execution: environment creation invokes the
// sandbox while holding this lease. Readers keep using immutable generations.
export async function acquireEnvironmentLease(workspace, signal) {
  const id = createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ubovm-python-env-${id}` : process.platform === 'linux'
    ? `\0ubovm-python-env-${id}` : { host: '127.0.0.1', port: 20000 + parseInt(id.slice(0, 8), 16) % 40000, exclusive: true };
  while (true) {
    signal.throwIfAborted();
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
      return () => new Promise(resolve => server.close(resolve));
    } catch (error) {
      server.close(); if (error.code !== 'EADDRINUSE') throw error;
      await delay(100, undefined, { signal });
    }
  }
}
