'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };

function createWorkspaceSearch(vscode, { executable, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [] } = {}) {
  async function binary() {
    if (executable) return executable;
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep/bin', name)
    ];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
    throw new Error('运行时缺少代码搜索引擎，请运行 npm run setup。');
  }
  async function search(input, signal, sessionId) {
    signal?.throwIfAborted();
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const rootIndex = input.root ?? 0;
    if (!Number.isInteger(rootIndex) || rootIndex < 0 || !folders[rootIndex]) throw new Error('请选择工作区。');
    const root = await fs.realpath(folders[rootIndex].uri.fsPath);
    const mode = input.mode ?? 'text', offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!['text', 'files'].includes(mode) || !Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('搜索模式或分页参数无效。');
    if (mode === 'text' && (typeof input.query !== 'string' || !input.query || input.query.length > 2000 || /[\0\r\n]/.test(input.query))) throw new Error('请输入最多 2000 字符的单行搜索表达式。');
    const globs = input.include ?? [], exclude = input.exclude ?? [];
    if (![globs, exclude].every(list => Array.isArray(list) && list.length <= 20 && list.every(value => typeof value === 'string' && value.length <= 500 && value && !value.includes('\0')))) throw new Error('文件匹配规则无效。');
    // Fixed executable and arguments only: no shell, user command, or Git subprocess.
    const args = ['--no-config', '--no-require-git', '--hidden', '--glob', '!.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.runtime/**', '--glob', '!**/.cache/**', '--sort', 'path'];
    for (const glob of globs) args.push('--glob', glob);
    for (const glob of exclude) args.push('--glob', '!' + glob.replace(/^!/, ''));
    args.push('--glob', '!**/.git/**');
    if (mode === 'files') args.push('--files', '--null');
    else {
      args.push('--json', '--line-number', '--context', '2', '--max-filesize', '4M');
      if (!input.regex) args.push('--fixed-strings');
      if (!input.caseSensitive) args.push('--ignore-case');
      args.push('--regexp', input.query);
    }
    args.push('--', '.');
    const program = await binary(); signal?.throwIfAborted();
    const found = [], recent = [];
    let seen = 0, more = false, partial = false;
    await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      let buffered = '', stderr = '', failure, bytes = 0, done = false, stopped = false;
      const stop = () => { stopped = true; child.kill(); };
      const cancel = () => { failure = signal.reason ?? new Error('搜索已取消'); stop(); };
      const timer = setTimeout(() => { partial = true; stop(); }, 15000);
      function add(item) {
        if (seen++ < offset) return;
        if (found.length >= limit) { more = true; stop(); return; }
        found.push(item);
      }
      function line(value) {
        if (stopped || !value) return;
        if (mode === 'files') { add({ path: value.replace(/^\.\//, '').replace(/^\.\\/, '') }); return; }
        const event = JSON.parse(value), data = event.data;
        if (!['match', 'context'].includes(event.type) || typeof data?.path?.text !== 'string' || typeof data.lines?.text !== 'string') return;
        const file = data.path.text.replace(/^\.\//, '').replace(/^\.\\/, '');
        const entry = { line: data.line_number, text: data.lines.text.replace(/\r?\n$/, '').slice(0, 1500) };
        for (const match of found.slice(-3)) if (match.path === file && entry.line > match.line && entry.line <= match.line + 2) match.after.push(entry);
        if (event.type === 'match') {
          const prefix = Buffer.from(data.lines.text).subarray(0, data.submatches?.[0]?.start ?? 0).toString('utf8');
          add({ path: file, line: entry.line, column: prefix.length + 1, text: entry.text, lineTruncated: data.lines.text.length > 1500,
            before: recent.filter(item => item.path === file && item.line >= entry.line - 2).map(({ path, ...item }) => item), after: [] });
        }
        recent.push({ path: file, ...entry }); if (recent.length > 2) recent.shift();
      }
      child.stdout.on('data', chunk => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { partial = true; stop(); return; }
        buffered += decoder.write(chunk);
        const separator = mode === 'files' ? '\0' : '\n';
        let at;
        try {
          while ((at = buffered.indexOf(separator)) >= 0 && !stopped) { const value = buffered.slice(0, at); buffered = buffered.slice(at + 1); line(value); }
          if (buffered.length > 8 * 1024 * 1024) { partial = true; stop(); }
        } catch (error) { failure = error; stop(); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4000); });
      const finish = (error, code) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error || failure) reject(error ?? failure);
        else if (!stopped && code !== 0 && code !== 1) reject(new Error(stderr || `搜索失败：${code}`));
        else resolve();
      };
      child.on('error', error => finish(error)); child.on('close', code => finish(undefined, code));
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    });
    signal?.throwIfAborted();
    // rg does not follow symlinks; verify result paths again before exposing them.
    const matches = [], verifiedPaths = new Map();
    for (const item of found) {
      signal?.throwIfAborted();
      const requested = path.resolve(root, item.path);
      if (!inside(root, requested)) continue;
      if (!verifiedPaths.has(requested)) {
        const canonical = await fs.realpath(requested).catch(() => null);
        verifiedPaths.set(requested, canonical !== null && inside(root, canonical));
      }
      if (verifiedPaths.get(requested)) matches.push(item);
    }
    return result({ root: rootIndex, mode, matches, offset, nextOffset: more ? offset + found.length : null,
      truncated: more || partial, partial, searched: 'saved workspace files; .gitignore/.ignore and include/exclude globs apply',
      ...(mode === 'text' ? { maxFileBytes: 4 * 1024 * 1024 } : {}), ...(partial ? { warning: '搜索达到时间或输出上限，请缩小 include 范围后重试，结果不能证明没有其他匹配。' } : {}) });
  }
  return { tools: sessionId => [{ name: 'search_workspace', recovery: 'retry-read-only', label: '搜索项目代码', description: 'Search saved workspace file names (mode=files with include globs) or text (literal or Rust regex). Respects .gitignore/.ignore, excludes dependencies/caches and never follows links. Results have one-based lines/UTF-16 columns and nearby context. Use nextOffset to paginate; partial results are not exhaustive. Unsaved buffers are not searched.',
    parameters: { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['files', 'text'] }, query: { type: 'string' }, regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, include: { type: 'array', items: { type: 'string' } }, exclude: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    execute: (_id, input, signal) => search(input, signal, sessionId) }] };
}
module.exports = { createWorkspaceSearch };
