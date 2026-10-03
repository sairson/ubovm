import { access, lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { contained } from '../../shared/common.mjs';
import { bundledPythonCandidates } from './runtime.mjs';

// Resolve without launching an interpreter outside the sandbox.
export async function resolvePython(executable, env = process.env, signal, { bundled = bundledPythonCandidates() } = {}) {
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  if (executable !== undefined && executable !== '' && (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0'))) throw new Error('Python executable must be an absolute path');
  const candidates = executable ? [executable] : [...bundled, ...(env.PATH ?? env.Path ?? '').split(delimiter)
    .filter(path => isAbsolute(path)).flatMap(path => names.map(name => join(path, name)))];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      // Keep the venv's entry path: resolving its symlink would select base Python.
      const path = resolve(candidate), target = await realpath(path);
      const roots = new Set([dirname(path), dirname(target)]);
      if (process.platform !== 'win32' && basename(dirname(target)) === 'bin') roots.add(dirname(dirname(target)));
      const venv = dirname(dirname(path));
      try {
        const file = await open(join(venv, 'pyvenv.cfg'), 'r');
        let config;
        try {
          const bytes = Buffer.alloc(65537);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > 65536) throw new Error('pyvenv.cfg exceeds 64 KiB');
          config = bytes.subarray(0, bytesRead).toString('utf8');
        } finally { await file.close(); }
        roots.add(venv);
        const home = /^home\s*=\s*(.+)$/mi.exec(config)?.[1].trim();
        if (home && isAbsolute(home)) roots.add(await realpath(home));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      signal?.throwIfAborted();
      return { executable: path, executableTarget: target, readRoots: [...roots] };
    } catch (error) {
      signal?.throwIfAborted();
      if (executable) throw new Error(`Python interpreter unavailable: ${executable}`, { cause: error });
    }
  }
  throw new Error('Bundled Python runtime is missing and no host Python was found. Run npm run setup (or npm run setup:python in a source checkout), or set an absolute interpreter path in IDE Python settings. No code was executed.');
}

export function pythonEnvironment(env = process.env) {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase()))), ELECTRON_RUN_AS_NODE: '1' };
}

// Default IDE workspaces and portable temp files live under ~/.ubovm. Denying
// that ancestor on Windows also denies the explicitly allowed child. Partition
// only the ancestor chain, protecting siblings without scanning file contents.
export async function privatePythonPaths(allowedPaths, root = join(homedir(), '.ubovm'), { signal, maxEntries = 2048 } = {}) {
  const result = []; let visited = 0;
  async function visit(path, depth) {
    signal?.throwIfAborted();
    if (++visited > maxEntries || depth > 64) throw Object.assign(new Error('Python private-directory policy exceeds traversal budget'), { code: 'PYTHON_POLICY_LIMIT' });
    if (allowedPaths.some(allowed => contained(allowed, path))) return;
    if (!allowedPaths.some(allowed => contained(path, allowed))) { result.push(path); return; }
    let directory;
    try { directory = await opendir(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // Sequential iteration bounds memory even for a large private directory.
    for await (const entry of directory) await visit(join(path, entry.name), depth + 1);
  }
  await visit(root, 0); return result;
}

export async function workspacePrivatePythonPaths(workspace, { signal, maxEntries = 20000 } = {}) {
  const paths = []; let visited = 0;
  const names = new Set(['.env', '.git', '.agents', '.codex', '.ssh', '.aws', '.azure', '.ubovm-python']);
  signal?.throwIfAborted();
  for await (const entry of await opendir(workspace)) {
    signal?.throwIfAborted();
    if (++visited > maxEntries) throw Object.assign(new Error('Python workspace permission scan exceeds its entry budget'), { code: 'PYTHON_POLICY_LIMIT' });
    const name = entry.name.toLowerCase();
    if (names.has(name) || name.startsWith('.env.')) paths.push(join(workspace, entry.name));
  }
  return paths;
}

export function pythonPolicy({ workspace, outputDirectory, controlDirectory, readRoots, protectedRuntimePaths = [], privatePaths = [join(homedir(), '.ubovm')], workspacePrivatePaths = [], allowedDomains = [], allowWorkspaceWrite = false }, platform = process.platform, home = homedir()) {
  const protectedPaths = [join(home, '.ssh'), join(home, '.aws'), join(home, '.azure'), join(home, '.config', 'gcloud'),
    ...privatePaths, ...workspacePrivatePaths, join(home, '.codex'), ...['.git', '.env', '.agents', '.codex', '.ubovm-python'].map(name => join(workspace, name))];
  const allowRead = [workspace, controlDirectory, ...readRoots];
  const allowWrite = [outputDirectory, ...(allowWorkspaceWrite ? [workspace] : [])];
  const denyWrite = [...new Set([...protectedPaths, controlDirectory, ...protectedRuntimePaths, ...readRoots])];
  const overlaps = (path, roots) => roots.some(root => contained(root, path) || contained(path, root));
  return {
    network: { allowedDomains, deniedDomains: [], allowLocalBinding: false },
    filesystem: {
      // Windows uses a separate account, with explicit grants only for these
      // roots. Stamp exceptions within those grants, not huge unrelated host
      // profiles/runtime trees. Outside them the account's normal NTFS access
      // applies; this is not a VM or an absolute read allowlist.
      denyRead: platform === 'win32' ? protectedPaths.filter(path => overlaps(path, [...allowRead, ...allowWrite])) : [home, ...protectedPaths],
      allowRead,
      allowWrite,
      denyWrite: platform === 'win32' ? denyWrite.filter(path => overlaps(path, allowWrite)) : denyWrite
    }
  };
}

// Native Windows ACL deny stamping creates missing paths. Submit only existing
// targets so applying policy does not manufacture .env/.codex/etc. Read-only
// snapshots already omit secrets and their workspace cannot be written to.
export async function omitMissingPythonDenyPaths(policy, platform = process.platform, { signal } = {}) {
  if (platform !== 'win32') return policy;
  const validated = new Map();
  const normalized = path => resolve(path).toLowerCase();
  async function existsWithoutRedirect(path) {
    signal?.throwIfAborted();
    if (validated.has(path)) return validated.get(path);
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      // Even a missing leaf may sit behind a junction or dangling link. Do
      // not classify it as harmlessly absent until its ancestors are checked.
      const parent = dirname(path);
      if (parent !== path) await existsWithoutRedirect(parent);
      validated.set(path, false); return false;
    }
    if (info.isSymbolicLink() || normalized(await realpath(path)) !== normalized(path))
      throw Object.assign(new Error(`Python permission target is redirected by a link: ${path}. Use a real file or directory before retrying.`), { code: 'PYTHON_POLICY_PATH_REDIRECTED' });
    validated.set(path, true); return true;
  }
  const filtered = {};
  for (const key of ['denyRead', 'denyWrite']) {
    const existing = [];
    for (const path of policy.filesystem[key]) {
      if (await existsWithoutRedirect(resolve(path))) existing.push(path);
    }
    filtered[key] = existing;
  }
  // In the pinned Windows backend denyRead stamps NO_ACCESS. Stamping the
  // same path again as denyWrite replaces it with a weaker write-only mask.
  // Keep the stronger rule once, including case-insensitive path aliases.
  const unreadable = new Set(filtered.denyRead.map(normalized));
  filtered.denyWrite = filtered.denyWrite.filter(path => !unreadable.has(normalized(path)));
  signal?.throwIfAborted();
  Object.assign(policy.filesystem, filtered);
  return policy;
}

export function normalizePythonDomains(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid Python allowedDomains');
  return [...new Set(value.map(domain => {
    if (typeof domain !== 'string') throw new Error('Invalid Python allowedDomains');
    domain = domain.trim().toLowerCase();
    const match = /^(?:\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/.exec(domain);
    if (!match || domain.length > 253 || match[1].split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
      || match[2] && (+match[2] < 1 || +match[2] > 65535)) throw new Error('Invalid Python allowedDomains; use hostnames with optional wildcard prefix and port 1–65535');
    return domain;
  }))];
}

export function pythonCommand(executable, payloadPath, platform = process.platform) {
  // Only trusted bootstrap source enters the shell. AI code/arguments live in JSON.
  const bootstrap = `import json,os,sys,runpy,tempfile\np=json.load(open(${JSON.stringify(payloadPath)},encoding='utf-8'))\nos.environ['UBOVM_PYTHON_OUTPUT']=p['outputDirectory']\nos.environ['TMPDIR']=os.environ['TEMP']=os.environ['TMP']=p['outputDirectory']\ntempfile.tempdir=p['outputDirectory']\nsys.argv=[p.get('script') or p['codeFile']]+p['arguments']\nsys.path.insert(0,os.path.dirname(p['script']) if p.get('script') else p['cwd'])\nrunpy.run_path(p.get('script') or p['codeFile'],run_name='__main__')`;
  const code = `import base64;exec(base64.b64decode('${Buffer.from(bootstrap).toString('base64')}'))`;
  const quote = platform === 'win32' ? value => "'" + value.replaceAll("'", "''") + "'" : value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [executable, '-I', '-B', '-u', '-X', 'utf8', '-c', code].map(quote).join(' ');
  return platform === 'win32' ? `& ${command}; exit $LASTEXITCODE` : `exec ${command}`;
}
