import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contained } from '../../shared/common.mjs';

// Never stamp inherited account permissions across a user's large source tree.
// Snapshot read-only inputs into the private control directory instead. Runtime
// dependencies come from the selected interpreter, not workspace virtualenvs.
const excluded = new Set(['.git', '.hg', '.svn', '.runtime', '.cache', '.ubovm-python-output', '.ubovm-python', 'node_modules',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', 'vendor']);
const secrets = new Set(['.env', '.agents', '.codex', '.ssh', '.aws', '.azure', '.ubovm-python']);
const fail = message => Object.assign(new Error(message), { code: 'PYTHON_INPUT_SNAPSHOT_FAILED' });

export async function snapshotPythonWorkspace(request, controlDirectory, signal, { maxFiles = 10000, maxBytes = 64 << 20, maxEntries = 20000 } = {}) {
  signal.throwIfAborted();
  const workspace = join(controlDirectory, 'workspace'); await mkdir(workspace, { mode: 0o700 });
  let files = 0, bytes = 0, scanned = 0, skipped = 0;
  const cwdRelative = relative(request.workspace, request.cwd);
  const scriptRelative = request.script && relative(request.workspace, request.script);
  const isOutput = path => contained(request.outputDirectory, path);
  const inputArguments = request.arguments.map(value => resolve(request.cwd, value)).filter(path => contained(request.workspace, path) && !isOutput(path)).map(path => relative(request.workspace, path));
  const required = [cwdRelative, scriptRelative, ...inputArguments].filter(Boolean);
  const needed = path => required.some(target => target === path || target.startsWith(path + sep));
  // Copy from one opened file with a fixed byte budget. A growing input must
  // not turn preparation into an unbounded copy or delay cancellation.
  async function copyInput(from, to, info) {
    const source = await open(from, 'r');
    let target;
    const sameFile = value => value.isFile() && value.dev === info.dev && value.ino === info.ino
      && value.size === info.size && value.mtimeMs === info.mtimeMs && value.ctimeMs === info.ctimeMs;
    try {
      if (!sameFile(await source.stat()) || !sameFile(await lstat(from))
        || !contained(request.workspace, await realpath(from))) throw fail('Python input changed during snapshot');
      target = await open(to, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, info.size + 1));
      let copied = 0;
      while (true) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - copied + 1), null);
        if (!bytesRead) break;
        copied += bytesRead;
        if (copied > info.size) throw fail('Python input grew during snapshot; retry with stable files');
        let written = 0;
        while (written < bytesRead) {
          signal.throwIfAborted();
          const result = await target.write(buffer, written, bytesRead - written, null);
          if (!result.bytesWritten) throw fail('Python input copy made no progress');
          written += result.bytesWritten;
        }
      }
      if (copied !== info.size || !sameFile(await source.stat()) || !sameFile(await lstat(from)))
        throw fail('Python input changed during snapshot; retry with stable files');
    } finally {
      try { await target?.close(); } finally { await source.close(); }
    }
  }
  async function copy(source, destination, depth, selectedOnly = false) {
    signal.throwIfAborted();
    if (depth > 64) throw fail('Python input directory exceeds 64 levels');
    const directory = await opendir(source);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++scanned > maxEntries) throw fail(`Python input scan exceeds ${maxEntries} entries; select a smaller workspace`);
      const from = join(source, entry.name), to = join(destination, entry.name), local = relative(request.workspace, from);
      const name = entry.name.toLowerCase();
      if (selectedOnly && !needed(local)) { skipped++; continue; }
      if (secrets.has(name) || name.startsWith('.env.')) {
        // Omit sensitive inputs entirely; do not create empty stand-ins.
        skipped++; continue;
      }
      if (excluded.has(name) && !needed(local)) { skipped++; continue; }
      const info = await lstat(from);
      if (info.isSymbolicLink()) { skipped++; continue; }
      if (!contained(request.workspace, await realpath(from))) throw fail('Python input path changed during snapshot');
      if (info.isDirectory()) {
        await mkdir(to, { mode: 0o700 });
        // When a script/data argument explicitly selects an excluded tree,
        // copy only the path leading to it, not all sibling build artifacts.
        const selected = (selectedOnly || excluded.has(name)) && !required.includes(local);
        await copy(from, to, depth + 1, selected);
      }
      else if (info.isFile()) {
        if (++files > maxFiles || (bytes += info.size) > maxBytes) throw fail(`Python inputs exceed ${maxFiles} files or ${maxBytes} bytes; select a smaller workspace`);
        await copyInput(from, to, info);
      } else skipped++;
    }
  }
  await copy(request.workspace, workspace, 0);
  signal.throwIfAborted();
  const map = path => join(workspace, relative(request.workspace, path));
  const cwd = map(request.cwd), script = request.script && map(request.script);
  if (!(await lstat(cwd)).isDirectory() || script && !(await lstat(script)).isFile()) throw fail('Python cwd or script was omitted from the input snapshot');
  // Preserve common absolute input arguments pointing into the workspace.
  const args = request.arguments.map(value => {
    const path = resolve(request.cwd, value);
    if (isOutput(path)) return path;
    return isAbsolute(value) && contained(request.workspace, path) ? map(path) : value;
  });
  return { request: { ...request, workspace, cwd, script, arguments: args }, metadata: { files, bytes, skipped } };
}
