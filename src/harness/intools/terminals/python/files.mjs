import { lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { contained } from '../../shared/common.mjs';
import { validatePythonEnvironmentFiles } from './environment-state.mjs';

export async function validatePythonPaths(request, { requireOutput = false } = {}) {
  for (const [key, isDirectory] of [['workspace', true], ['cwd', true], ['script', false]]) {
    if (!request[key]) continue;
    const actual = await realpath(request[key]);
    const info = await stat(actual);
    if (actual !== request[key] || !contained(request.workspace, actual) || !(isDirectory ? info.isDirectory() : info.isFile()))
      throw Object.assign(new Error(`Python ${key} changed or escaped the workspace while queued`), { code: 'PYTHON_PATH_CHANGED' });
  }
  if (request.executableTarget && await realpath(request.executable) !== request.executableTarget)
    throw Object.assign(new Error('Python executable changed while queued'), { code: 'PYTHON_PATH_CHANGED' });
  if (request.environmentIdentity) {
    try {
      const current = await validatePythonEnvironmentFiles(request.environmentIdentity.directory);
      if (JSON.stringify(current) !== JSON.stringify(request.environmentIdentity)) throw new Error('Interpreter or venv configuration changed');
    } catch (cause) {
      throw Object.assign(new Error('Managed Python environment changed while queued or preparing; retry after syncing the environment', { cause }),
        { code: 'PYTHON_ENVIRONMENT_CHANGED' });
    }
  }
  const parent = join(request.workspace, '.ubovm-python-output');
  if (dirname(request.outputDirectory) !== parent || !/^run-[0-9a-f-]{36}$/.test(request.outputDirectory.slice(parent.length + 1)))
    throw new Error('Invalid Python output directory');
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== resolve(parent)) throw new Error('Python output directory must be a real directory inside the workspace');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (requireOutput) {
    const info = await lstat(request.outputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(request.outputDirectory) !== request.outputDirectory)
      throw Object.assign(new Error('Python output directory changed during sandbox setup'), { code: 'PYTHON_PATH_CHANGED' });
  }
}

export async function preparePythonOutput(request) {
  await validatePythonPaths(request);
  const parent = dirname(request.outputDirectory);
  try { await mkdir(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await validatePythonPaths(request);
  await mkdir(request.outputDirectory, { mode: 0o700 });
  if (await realpath(request.outputDirectory) !== request.outputDirectory) throw new Error('Python output directory changed during creation');
}

// Remove only an empty, newly owned run directory; never recursively delete code
// outputs or a possibly replaced link. A successful execution keeps its folder.
export async function removeEmptyPythonOutput(request) {
  const parent = dirname(request.outputDirectory);
  if (parent !== join(request.workspace, '.ubovm-python-output') || !contained(request.workspace, request.outputDirectory)) throw new Error('Invalid Python output cleanup path');
  try {
    const info = await lstat(request.outputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(request.outputDirectory) !== request.outputDirectory) return false;
    await rmdir(request.outputDirectory); return true;
  } catch (error) { if (error.code === 'ENOENT') return true; if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }
}
