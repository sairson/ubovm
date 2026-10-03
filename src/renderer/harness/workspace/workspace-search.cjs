'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };

function createWorkspaceSearch(vscode, { executable, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [],
  maxConcurrent = 4, maxPerSession = 2, timeoutMs = 15000, stopTimeoutMs = 1000, spawnProcess = spawn } = {}) {
  for (const value of [maxConcurrent, maxPerSession]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid search capacity');
  for (const value of [timeoutMs, stopTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid search timeout');
  if (typeof workspaceFolders !== 'function' || typeof spawnProcess !== 'function') throw new TypeError('Invalid search callback');
  const active = new Set(), sessions = new Map();
  function release(ticket) {
    if (!active.delete(ticket)) return;
    const count = sessions.get(ticket.sessionId) - 1;
    if (count) sessions.set(ticket.sessionId, count); else sessions.delete(ticket.sessionId);
  }
  async function binary() {
    if (executable) return executable;
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep-universal/bin', `${process.platform}-${process.arch}`, name),
      path.join(vscode.env.appRoot, 'node_modules/@vscode/ripgrep/bin', name)
    ];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
    throw Object.assign(new Error('运行时缺少代码搜索引擎，请运行 npm run setup。reason=SEARCH_ENGINE_MISSING recovery=npm_run_setup'), { code: 'SEARCH_ENGINE_MISSING' });
  }
  async function performSearch(input, signal, sessionId, ticket) {
    signal?.throwIfAborted();
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const rootIndex = input.root ?? 0;
    if (!Number.isInteger(rootIndex) || rootIndex < 0 || !folders[rootIndex]) throw new Error('请选择工作区。');
    const requestedRoot = path.resolve(folders[rootIndex].uri.fsPath);
    const root = await fs.realpath(requestedRoot);
    const rootKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    function assertWorkspaceCurrent() {
      const current = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file')[rootIndex]?.uri.fsPath;
      if (!current || rootKey(path.resolve(current)) !== rootKey(requestedRoot)) {
        throw Object.assign(new Error('会话工作空间已变化，请在当前目录重新搜索。'), { code: 'SEARCH_WORKSPACE_CHANGED' });
      }
    }
    const mode = input.mode ?? 'text', offset = input.offset ?? 0, limit = input.limit ?? 50;
    const contextLines = input.contextLines ?? 2;
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) throw new Error('上下文行数必须在 0 至 10 之间。');
    if (!['text', 'files', 'matchingFiles', 'count'].includes(mode) || !Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('搜索模式或分页参数无效。');
    const patterns = input.patterns ?? [input.query];
    if (input.patterns !== undefined && input.query !== undefined) throw new Error('query 与 patterns 只能选择一个。');
    if (mode !== 'files' && (!Array.isArray(patterns) || !patterns.length || patterns.length > 20 || patterns.some(value => typeof value !== 'string' || !value || value.length > 2000 || /[\0\r\n]/.test(value)))) throw new Error('请提供 1 至 20 个最多 2000 字符的单行搜索表达式。');
    for (const key of ['regex', 'wholeWord', 'caseSensitive']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须为布尔值。`);
    const types = input.types ?? [];
    if (!Array.isArray(types) || types.length > 20 || types.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value))) throw new Error('语言类型必须为 rg 类型名，例如 js、ts、py、rust。');
    const globs = input.include ?? [], exclude = input.exclude ?? [];
    if (![globs, exclude].every(list => Array.isArray(list) && list.length <= 20 && list.every(value => typeof value === 'string' && value.length <= 500 && value && !value.includes('\0')))) throw new Error('文件匹配规则无效。');
    // Fixed executable and arguments only: no shell, user command, or Git subprocess.
    const args = ['--no-config', '--no-require-git', '--hidden', '--glob', '!.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.runtime/**', '--glob', '!**/.cache/**', '--sort', 'path'];
    for (const glob of globs) args.push('--glob', glob);
    for (const glob of exclude) args.push('--glob', '!' + glob.replace(/^!/, ''));
    // Mandatory exclusions win over caller globs, including broad **/* rules.
    for (const name of ['.git', 'node_modules', '.runtime', '.cache']) args.push('--glob', `!**/${name}/**`);
    for (const type of types) args.push('--type', type);
    const fileOutput = mode === 'files' || mode === 'matchingFiles';
    if (mode === 'files') args.push('--files', '--null');
    else {
      if (mode === 'matchingFiles') args.push('--files-with-matches', '--null');
      else args.push('--json', '--line-number', '--context', String(mode === 'text' ? contextLines : 0));
      args.push('--max-filesize', '4M');
      if (input.wholeWord) args.push('--word-regexp');
      if (!input.regex) args.push('--fixed-strings');
      if (!input.caseSensitive) args.push('--ignore-case');
      for (const pattern of patterns) args.push('--regexp', pattern);
    }
    args.push('--', '.');
    const program = await binary(); signal?.throwIfAborted();
    assertWorkspaceCurrent();
    const found = [], recent = [];
    let seen = 0, more = false, partial = false;
    await new Promise((resolve, reject) => {
      const child = spawnProcess(program, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      ticket.physical = true;
      const decoder = new StringDecoder('utf8');
      let buffered = '', stderr = '', failure, bytes = 0, done = false, stopped = false, stopTimer;
      const stop = () => {
        if (stopped || done) return;
        stopped = true;
        // A failed kill or a missing close event must not trap the caller. The
        // physical slot remains reserved until the process actually closes.
        stopTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* Preserve the original stop reason. */ }
          finish(failure ?? Object.assign(new Error('搜索进程未及时退出，请稍后重试。'), { code: 'SEARCH_TERMINATION_TIMEOUT' }));
        }, stopTimeoutMs);
        try { child.kill(); } catch (error) { failure ??= error; }
      };
      const cancel = () => { failure = signal.reason ?? new Error('搜索已取消'); stop(); };
      const timer = setTimeout(() => { partial = true; stop(); }, timeoutMs);
      function add(item) {
        if (seen++ < offset) return;
        if (found.length >= limit) { more = true; stop(); return; }
        found.push(item);
      }
      function line(value) {
        if (stopped || !value) return;
        if (fileOutput) { add({ path: value.replace(/^\.\//, '').replace(/^\.\\/, '') }); return; }
        const event = JSON.parse(value), data = event.data;
        if (mode === 'count') {
          if (event.type === 'end' && typeof data?.path?.text === 'string' && data.stats?.matches > 0) {
            add({ path: data.path.text.replace(/^\.\//, '').replace(/^\.\\/, ''), count: data.stats.matches, matchedLines: data.stats.matched_lines });
          }
          return;
        }
        if (!['match', 'context'].includes(event.type) || typeof data?.path?.text !== 'string' || typeof data.lines?.text !== 'string') return;
        const file = data.path.text.replace(/^\.\//, '').replace(/^\.\\/, '');
        const entry = { line: data.line_number, text: data.lines.text.replace(/\r?\n$/, '').slice(0, 1500) };
        for (const match of found.slice(-(contextLines + 1))) if (match.path === file && entry.line > match.line && entry.line <= match.line + contextLines) match.after.push(entry);
        if (event.type === 'match') {
          const source = Buffer.from(data.lines.text);
          const ranges = (data.submatches ?? []).slice(0, 200).map(match => ({ column: source.subarray(0, match.start).toString('utf8').length + 1, endColumn: source.subarray(0, match.end).toString('utf8').length + 1 }));
          add({ path: file, line: entry.line, column: ranges[0]?.column ?? 1, ranges, matchCount: data.submatches?.length ?? 0, rangesTruncated: (data.submatches?.length ?? 0) > ranges.length, text: entry.text, lineTruncated: data.lines.text.replace(/\r?\n$/, '').length > 1500,
            before: recent.filter(item => item.path === file && item.line >= entry.line - contextLines).map(({ path, ...item }) => item), after: [] });
        }
        recent.push({ path: file, ...entry }); if (recent.length > contextLines) recent.shift();
      }
      child.stdout.on('data', chunk => {
        if (stopped || done) return;
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { partial = true; stop(); return; }
        buffered += decoder.write(chunk);
        const separator = fileOutput ? '\0' : '\n';
        let at;
        try {
          while ((at = buffered.indexOf(separator)) >= 0 && !stopped) { const value = buffered.slice(0, at); buffered = buffered.slice(at + 1); line(value); }
          if (buffered.length > 8 * 1024 * 1024) { partial = true; stop(); }
        } catch (error) { failure = error; stop(); }
      });
      child.stderr.on('data', chunk => { if (!done && !stopped) stderr = (stderr + chunk.toString('utf8')).slice(0, 4000); });
      const finish = (error, code) => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', cancel);
        if (error || failure) reject(error ?? failure);
        else if (!stopped && code !== 0 && code !== 1) reject(new Error(stderr || `搜索失败：${code}`));
        else resolve();
      };
      child.on('error', error => { if (!child.pid) release(ticket); finish(error); });
      child.on('close', code => { release(ticket); finish(undefined, code); });
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    });
    signal?.throwIfAborted();
    assertWorkspaceCurrent();
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
    signal?.throwIfAborted(); assertWorkspaceCurrent();
    return result({ engine: 'ripgrep', root: rootIndex, mode, matches, offset, nextOffset: more ? offset + found.length : null,
      truncated: more || partial, partial, searched: 'saved workspace files; .gitignore/.ignore and include/exclude globs apply',
      ...(mode !== 'files' ? { maxFileBytes: 4 * 1024 * 1024 } : {}), ...(partial ? { warning: '搜索达到时间或输出上限，请缩小 include 范围后重试，结果不能证明没有其他匹配。' } : {}) });
  }
  async function search(input, signal, sessionId) {
    signal?.throwIfAborted();
    if (active.size >= maxConcurrent || (sessions.get(sessionId) || 0) >= maxPerSession) {
      throw Object.assign(new Error('搜索任务过多，请等待当前搜索结束后重试。reason=SEARCH_BUSY recovery=retry_after_current_search'), { code: 'SEARCH_BUSY' });
    }
    const ticket = { sessionId, physical: false };
    active.add(ticket); sessions.set(sessionId, (sessions.get(sessionId) || 0) + 1);
    try { return await performSearch(input, signal, sessionId, ticket); }
    finally { if (!ticket.physical) release(ticket); }
  }
  return { tools: sessionId => [{ name: 'search_workspace', recovery: 'retry-read-only', label: '搜索项目代码', description: 'Read-only ripgrep (rg) code search. mode=text returns matching lines, nearby context and up to 200 match ranges per line; files lists paths by glob; matchingFiles is rg -l (paths containing a pattern); count returns per-file occurrence counts and matchedLines. Supply query OR patterns (OR semantics, at most 20). Literal by default; regex=true enables Rust regex, wholeWord restricts words, caseSensitive defaults false. types filters rg language types such as js, ts, py, rust. Respects .gitignore/.ignore; mandatory .git/dependency/cache exclusions cannot be overridden; never follows links. Lines/UTF-16 columns are one-based, endColumn exclusive. Ranges refer to full lines even when displayed text is truncated. Use nextOffset for pagination (lines for text, files otherwise); counts cover returned files only. Partial results are not exhaustive. Unsaved buffers are not searched.',
    parameters: { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['files', 'text', 'matchingFiles', 'count'] }, query: { type: 'string', minLength: 1, maxLength: 2000 }, patterns: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } }, types: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$' } }, regex: { type: 'boolean' }, wholeWord: { type: 'boolean' }, contextLines: { type: 'integer', minimum: 0, maximum: 10 }, caseSensitive: { type: 'boolean' }, include: { type: 'array', items: { type: 'string' } }, exclude: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    execute: (_id, input, signal) => search(input, signal, sessionId) }] };
}
module.exports = { createWorkspaceSearch };
