'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const SKIP_DIRS = new Set(['.git', 'node_modules', '.runtime', '.cache', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__']);
const MANIFEST_NAMES = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']);
const REQUIREMENTS_RE = /^requirements(?:[-_].+)?\.txt$/i;

const SECRET_PATTERNS = Object.freeze([
  { id: 'private_key', severityHint: 'critical', regex: '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' },
  { id: 'aws_access_key', severityHint: 'high', regex: 'AKIA[0-9A-Z]{16}' },
  { id: 'github_token', severityHint: 'high', regex: 'gh[pousr]_[A-Za-z0-9_]{20,}' },
  { id: 'slack_token', severityHint: 'high', regex: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  { id: 'generic_api_key', severityHint: 'medium', regex: '(?i)(?:api[_-]?key|secret[_-]?key|access[_-]?token)\\s*[:=]\\s*[\'"][^\'"\\s]{8,}[\'"]' },
  { id: 'jwt_like', severityHint: 'medium', regex: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}' },
]);

function clip(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) : value;
}

function parsePackageJson(text, relative) {
  const pkg = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must contain an object');
  const deps = (section, kind) => Object.entries(pkg[section] && typeof pkg[section] === 'object' && !Array.isArray(pkg[section]) ? pkg[section] : {})
    .filter(([, version]) => typeof version === 'string')
    .map(([name, version]) => ({ name: clip(name, 256), version: clip(version, 256), kind }));
  return { ecosystem: 'npm', manifest: relative, name: clip(pkg.name, 256), dependencies: [...deps('dependencies', 'runtime'), ...deps('devDependencies', 'dev'), ...deps('optionalDependencies', 'optional'), ...deps('peerDependencies', 'peer')] };
}

function parseCargoToml(text, relative) {
  const dependencies = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1].trim(); continue; }
    if (!/^dependencies$|^dev-dependencies$|^build-dependencies$/.test(section)) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const kind = section === 'dependencies' ? 'runtime' : section === 'dev-dependencies' ? 'dev' : 'build';
    let version = match[2].trim();
    const quoted = version.match(/^"([^"]*)"/) || version.match(/^'([^']*)'/);
    if (quoted) version = quoted[1];
    else {
      const nested = version.match(/version\s*=\s*"([^"]*)"/);
      version = nested ? nested[1] : clip(version, 256);
    }
    dependencies.push({ name: clip(match[1], 256), version: clip(version, 256), kind });
  }
  return { ecosystem: 'cargo', manifest: relative, dependencies };
}

function parseGoMod(text, relative) {
  const dependencies = [];
  let inRequire = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('require (')) { inRequire = true; continue; }
    if (inRequire && trimmed === ')') { inRequire = false; continue; }
    const single = trimmed.match(/^require\s+(\S+)\s+(\S+)/);
    if (single) { dependencies.push({ name: clip(single[1], 256), version: clip(single[2], 256), kind: 'runtime' }); continue; }
    if (!inRequire) continue;
    const item = trimmed.match(/^(\S+)\s+(\S+)/);
    if (item) dependencies.push({ name: clip(item[1], 256), version: clip(item[2], 256), kind: 'runtime' });
  }
  return { ecosystem: 'go', manifest: relative, dependencies };
}

function parsePyproject(text, relative) {
  const dependencies = [];
  let section = '', inArray = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1].trim(); inArray = false; continue; }
    if (section === 'project' || section === 'tool.poetry.dependencies') {
      if (/^\s*dependencies\s*=\s*\[/.test(line) || section === 'tool.poetry.dependencies') inArray = true;
      if (!inArray && section !== 'tool.poetry.dependencies') continue;
      if (section === 'tool.poetry.dependencies') {
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
        if (match && match[1] !== 'python') dependencies.push({ name: clip(match[1], 256), version: clip(match[2].replace(/^["']|["']$/g, ''), 256), kind: 'runtime' });
      } else {
        for (const match of line.matchAll(/["']([^"']+)["']/g)) {
          const spec = match[1].trim();
          const name = spec.split(/[<>=!~;\s\[]/)[0];
          if (name) dependencies.push({ name: clip(name, 256), version: clip(spec.slice(name.length).trim() || '*', 256), kind: 'runtime' });
        }
        if (line.includes(']')) inArray = false;
      }
    }
  }
  return { ecosystem: 'python', manifest: relative, dependencies };
}

function parseRequirements(text, relative) {
  const dependencies = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const name = trimmed.split(/[<>=!~;\s\[]/)[0];
    if (name) dependencies.push({ name: clip(name, 256), version: clip(trimmed.slice(name.length).trim() || '*', 256), kind: 'runtime' });
  }
  return { ecosystem: 'pip', manifest: relative, dependencies };
}

function parseManifest(name, text, relative) {
  if (name === 'package.json') return parsePackageJson(text, relative);
  if (name === 'Cargo.toml') return parseCargoToml(text, relative);
  if (name === 'go.mod') return parseGoMod(text, relative);
  if (name === 'pyproject.toml') return parsePyproject(text, relative);
  if (REQUIREMENTS_RE.test(name)) return parseRequirements(text, relative);
  throw new Error('Unsupported manifest');
}

async function walkManifests(root, signal, { maxFiles = 200, maxBytes = 512 * 1024 } = {}) {
  const found = [];
  let bytes = 0, truncated = false, visited = 0;
  async function visit(directory, relative) {
    signal?.throwIfAborted();
    if (truncated || found.length >= maxFiles) { truncated = true; return; }
    if (++visited > 10000) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (truncated || found.length >= maxFiles) { truncated = true; return; }
      if (entry.name === '.' || entry.name === '..') continue;
      const childRel = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await visit(childPath, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MANIFEST_NAMES.has(entry.name) && !REQUIREMENTS_RE.test(entry.name)) continue;
      let handle;
      try {
        handle = await fs.open(childPath, 'r');
        const info = await handle.stat();
        if (!info.isFile() || info.size > 256 * 1024) continue;
        const buffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        if (text.includes('\0')) continue;
        bytes += bytesRead;
        if (bytes > maxBytes) { truncated = true; return; }
        found.push({ name: entry.name, relative: childRel, text });
      } catch { /* Skip unreadable manifests. */ }
      finally { await handle?.close(); }
    }
  }
  await visit(root, '');
  return { found, truncated };
}

function createWorkspaceAudit(vscode, { workspaceFolders = () => vscode.workspace.workspaceFolders ?? [],
  executable, spawnProcess = spawn, timeoutMs = 15000, stopTimeoutMs = 1000 } = {}) {
  if (typeof workspaceFolders !== 'function' || typeof spawnProcess !== 'function') throw new TypeError('Invalid audit callbacks');
  for (const value of [timeoutMs, stopTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid audit timeout');

  async function resolveRoot(input, sessionId) {
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const rootIndex = input.root ?? 0;
    if (!Number.isInteger(rootIndex) || rootIndex < 0 || !folders[rootIndex]) throw new Error('请选择工作区。');
    const requestedRoot = path.resolve(folders[rootIndex].uri.fsPath);
    const root = await fs.realpath(requestedRoot);
    return { root, rootIndex, requestedRoot };
  }

  async function binary() {
    if (executable) return executable;
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep/bin', name)
    ];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch { /* try next */ } }
    throw new Error('运行时缺少代码搜索引擎，请运行 npm run setup。');
  }

  async function inventory(sessionId, input, signal) {
    signal?.throwIfAborted();
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('分页参数无效。');
    const { root, rootIndex } = await resolveRoot(input, sessionId);
    const walked = await walkManifests(root, signal);
    const packages = [], issues = [];
    for (const item of walked.found) {
      signal?.throwIfAborted();
      try { packages.push(parseManifest(item.name, item.text, item.relative)); }
      catch (error) { issues.push({ path: item.relative, error: String(error.message).slice(0, 500) }); }
    }
    const dependencies = [];
    for (const pkg of packages) {
      for (const dep of pkg.dependencies) {
        dependencies.push({ ecosystem: pkg.ecosystem, manifest: pkg.manifest, packageName: pkg.name ?? null, ...dep });
      }
    }
    const slice = dependencies.slice(offset, offset + limit);
    const nextOffset = offset + limit < dependencies.length ? offset + limit : null;
    return result({
      root: rootIndex,
      packages: packages.map(pkg => ({ ecosystem: pkg.ecosystem, manifest: pkg.manifest, name: pkg.name ?? null, dependencyCount: pkg.dependencies.length })),
      dependencies: slice,
      totalDependencies: dependencies.length,
      nextOffset,
      truncated: walked.truncated || nextOffset !== null,
      partial: walked.truncated,
      issues,
      note: 'Heuristic manifest inventory only; not a resolved dependency graph. Install commands were not executed.'
    });
  }

  async function scanSecrets(sessionId, input, signal) {
    signal?.throwIfAborted();
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('分页参数无效。');
    const patternIds = input.patternIds ?? SECRET_PATTERNS.map(item => item.id);
    if (!Array.isArray(patternIds) || !patternIds.length || patternIds.length > SECRET_PATTERNS.length || patternIds.some(id => !SECRET_PATTERNS.some(item => item.id === id))) {
      throw new Error('patternIds 必须是已知密钥模式标识。');
    }
    const selected = SECRET_PATTERNS.filter(item => patternIds.includes(item.id));
    const { root, rootIndex, requestedRoot } = await resolveRoot(input, sessionId);
    const rootKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    function assertWorkspaceCurrent() {
      const current = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file')[rootIndex]?.uri.fsPath;
      if (!current || rootKey(path.resolve(current)) !== rootKey(requestedRoot)) {
        throw Object.assign(new Error('会话工作空间已变化，请在当前目录重新扫描。'), { code: 'AUDIT_WORKSPACE_CHANGED' });
      }
    }
    const args = ['--no-config', '--no-require-git', '--hidden', '--json', '--line-number', '--max-filesize', '1M', '--sort', 'path'];
    for (const name of ['.git', 'node_modules', '.runtime', '.cache', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__']) {
      args.push('--glob', `!**/${name}/**`);
    }
    for (const pattern of selected) args.push('--regexp', pattern.regex);
    args.push('--', '.');
    const program = await binary();
    signal?.throwIfAborted();
    assertWorkspaceCurrent();
    const matches = [];
    let seen = 0, more = false, partial = false;
    await new Promise((resolve, reject) => {
      const child = spawnProcess(program, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      let buffered = '', stderr = '', failure, done = false, stopped = false, stopTimer;
      const stop = () => {
        if (stopped || done) return;
        stopped = true;
        stopTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* keep original failure */ }
          finish(failure ?? Object.assign(new Error('密钥扫描进程未及时退出，请稍后重试。'), { code: 'AUDIT_TERMINATION_TIMEOUT' }));
        }, stopTimeoutMs);
        try { child.kill(); } catch (error) { failure ??= error; }
      };
      const cancel = () => { failure = signal.reason ?? new Error('密钥扫描已取消'); stop(); };
      const timer = setTimeout(() => { partial = true; stop(); }, timeoutMs);
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(stopTimer);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      }
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('error', error => { failure = error; stop(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 4000); });
      child.stdout.on('data', chunk => {
        buffered += decoder.write(chunk);
        let index;
        while ((index = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch (error) { failure = error; stop(); return; }
          if (event.type !== 'match') continue;
          const data = event.data, filePath = data?.path?.text;
          if (typeof filePath !== 'string' || !filePath) continue;
          const absolute = path.resolve(root, filePath);
          if (!inside(root, absolute)) continue;
          const text = data.lines?.text ?? '';
          const pattern = selected.find(item => {
            try { return new RegExp(item.regex).test(text); } catch { return false; }
          }) ?? selected[0];
          if (seen++ < offset) continue;
          if (matches.length >= limit) { more = true; stop(); return; }
          matches.push({
            path: path.relative(root, absolute).split(path.sep).join('/'),
            line: data.line_number ?? null,
            patternId: pattern.id,
            severityHint: pattern.severityHint,
            preview: clip(String(text).replace(/\s+/g, ' ').trim(), 160)
          });
        }
      });
      child.on('close', code => {
        if (failure) return finish(failure);
        if (stopped && (more || partial)) return finish();
        if (code && code !== 0 && code !== 1) return finish(new Error(stderr.trim() || `密钥扫描失败（退出码 ${code}）。`));
        finish();
      });
    });
    assertWorkspaceCurrent();
    return result({
      root: rootIndex,
      matches,
      totalReturned: matches.length,
      nextOffset: more ? offset + matches.length : null,
      truncated: more || partial,
      partial,
      patterns: selected.map(item => item.id),
      note: 'Heuristic secret-pattern scan only; results are incomplete and may include false positives. Not a certificate of absence.'
    });
  }

  return {
    tools: sessionId => [
      {
        name: 'inventory_workspace_dependencies', recovery: 'retry-read-only', label: '盘点工作区依赖清单',
        description: 'Read-only inventory of declared dependencies from common manifests (package.json, Cargo.toml, go.mod, pyproject.toml, requirements*.txt) under the session workspace root. Skips .git/node_modules and similar directories. Paginate with offset/limit. truncated/partial means discovery was capped; this is not a resolved install graph and executes no package manager.',
        parameters: { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
        execute: (_id, input, signal) => inventory(sessionId, input ?? {}, signal)
      },
      {
        name: 'scan_workspace_secrets', recovery: 'retry-read-only', label: '扫描疑似密钥与凭据',
        description: 'Read-only heuristic ripgrep scan for common secret patterns (private keys, cloud tokens, generic api_key assignments, JWT-like strings). Mandatory ignores for .git/dependency/cache dirs. Results include path, line, patternId and severityHint. truncated/partial means incomplete; never treat an empty result as proof that secrets are absent.',
        parameters: { type: 'object', properties: {
          root: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
          patternIds: { type: 'array', items: { type: 'string', enum: SECRET_PATTERNS.map(item => item.id) }, minItems: 1, maxItems: SECRET_PATTERNS.length }
        }, additionalProperties: false },
        execute: (_id, input, signal) => scanSecrets(sessionId, input ?? {}, signal)
      }
    ]
  };
}

module.exports = { createWorkspaceAudit, SECRET_PATTERNS, parseManifest };
