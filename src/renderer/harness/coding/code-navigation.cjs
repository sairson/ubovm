'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };

// VS Code commands have no cancellation token. Bound our wait and consume late
// completions without reporting them as the result of a cancelled request.
function bounded(action, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => finish(signal.reason ?? new Error('Navigation cancelled'));
    const timer = setTimeout(() => finish(new Error('语言服务超时，请重试或使用 search_workspace。')), 10000);
    function finish(error, value) { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); }
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return action(); }).then(value => finish(null, value), finish);
  });
}

function createCodeNavigation(vscode, { locate, workspaceFolders }) {
  return sessionId => ({
    name: 'navigate_workspace_code', recovery: 'retry-read-only', label: '代码符号与引用导航',
    description: 'Use installed language providers to list document symbols or find definitions/references at a one-based line and UTF-16 column. Results are limited to this session’s workspace roots. Empty results do not prove absence: the language provider may be unavailable or still indexing; fall back to search_workspace. Unsaved source documents are rejected.',
    parameters: { type: 'object', properties: {
      root: { type: 'integer', minimum: 0 }, path: { type: 'string' },
      action: { type: 'string', enum: ['symbols', 'definition', 'references', 'implementation', 'typeDefinition'] },
      line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }
    }, required: ['path', 'action'], additionalProperties: false },
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const commands = { symbols: 'vscode.executeDocumentSymbolProvider', definition: 'vscode.executeDefinitionProvider', references: 'vscode.executeReferenceProvider', implementation: 'vscode.executeImplementationProvider', typeDefinition: 'vscode.executeTypeDefinitionProvider' };
      if (!Object.hasOwn(commands, input.action)) throw new Error('无效的导航操作。');
      const offset = input.offset ?? 0, limit = input.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('无效的导航分页。');
      const target = await locate(input, sessionId);
      const info = await fs.stat(target.file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('导航仅支持不超过 1 MiB 的文件。');
      const document = await bounded(() => vscode.workspace.openTextDocument(vscode.Uri.file(target.file)), signal);
      if (document.isDirty) throw new Error('文件有未保存的编辑，请先保存后重试。');
      const version = document.version;
      const args = [document.uri];
      if (input.action !== 'symbols') {
        if (!Number.isSafeInteger(input.line) || input.line < 1 || input.line > document.lineCount || !Number.isSafeInteger(input.column) || input.column < 1 || input.column > document.lineAt(input.line - 1).text.length + 1) throw new Error('导航位置超出文件范围。');
        args.push(new vscode.Position(input.line - 1, input.column - 1));
      }
      const raw = await bounded(() => vscode.commands.executeCommand(commands[input.action], ...args), signal);
      signal?.throwIfAborted();
      if (document.isDirty || document.version !== version) throw new Error('导航期间文件已变化，请重新读取后重试。');
      const roots = await Promise.all(workspaceFolders(sessionId).filter(f => f.uri.scheme === 'file').map(f => fs.realpath(f.uri.fsPath)));
      const results = [], seen = new Set(), canonical = new Map();
      let visited = 0, omitted = 0, capped = false;
      const pending = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(item => ({ item, container: '' })).reverse();
      while (pending.length) {
        signal?.throwIfAborted();
        if (++visited > 10000) { capped = true; break; }
        const { item, container } = pending.pop();
        if (input.action === 'symbols' && Array.isArray(item.children)) for (let i = item.children.length - 1; i >= 0; i--) pending.push({ item: item.children[i], container: String(item.name ?? '').slice(0, 500) });
        const uri = item.targetUri ?? item.location?.uri ?? item.uri ?? (input.action === 'symbols' ? document.uri : undefined);
        const range = item.targetSelectionRange ?? item.selectionRange ?? item.location?.range ?? item.range ?? item.targetRange;
        if (uri?.scheme !== 'file' || !range?.start || !range?.end) { omitted++; continue; }
        if (!canonical.has(uri.fsPath)) canonical.set(uri.fsPath, await fs.realpath(uri.fsPath).catch(() => null));
        const file = canonical.get(uri.fsPath), root = file ? roots.findIndex(r => inside(r, file)) : -1;
        if (root < 0) { omitted++; continue; }
        const value = { root, path: path.relative(roots[root], file), line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 };
        if (input.action === 'symbols') Object.assign(value, { name: String(item.name ?? '').slice(0, 500), kind: item.kind, container: String(item.containerName ?? container).slice(0, 500) });
        const id = JSON.stringify(value);
        if (!seen.has(id)) { seen.add(id); results.push(value); }
      }
      signal?.throwIfAborted();
      const nextOffset = offset + limit < results.length ? offset + limit : null;
      const value = { action: input.action, results: results.slice(offset, offset + limit), total: results.length, nextOffset, omitted, truncated: capped || nextOffset !== null, providerResult: raw == null ? 'unavailable_or_empty' : 'returned', scope: 'session workspace; language provider results may be incomplete' };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  });
}

module.exports = { createCodeNavigation, bounded };
