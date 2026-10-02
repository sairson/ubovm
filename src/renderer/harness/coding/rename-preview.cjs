'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { bounded } = require('./code-navigation.cjs');
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };

function createRenamePreview(vscode, { locate, read, assertClean, workspaceFolders, hash }) {
  return sessionId => ({
    name: 'preview_workspace_rename', recovery: 'retry-read-only', label: '预览符号重命名',
    description: 'Ask the installed language provider for cross-file symbol rename TEXT edits without applying them. Returns versioned ranges suitable for preview_workspace_edits then edit_workspace_files. Read affected files and project instructions before applying. Only text edits are represented; resource/file operations are not applied or represented. This is not a file rename tool or a guarantee of exhaustive references. Fails if any returned text edit is outside the session workspace, dirty, stale or too large; never returns a silently filtered text-edit subset.',
    parameters: { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, newName: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['path', 'line', 'column', 'newName'], additionalProperties: false },
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (typeof input.newName !== 'string' || !input.newName.trim() || input.newName.length > 256 || /[\x00-\x1f]/.test(input.newName)) throw new Error('重命名名称无效。');
      const target = await locate(input, sessionId), source = await read(target.file);
      if (source === null) throw new Error('源文件不存在。');
      await assertClean(target.file);
      const document = await bounded(() => vscode.workspace.openTextDocument(vscode.Uri.file(target.file)), signal);
      const sourceText = source.startsWith('\uFEFF') ? source.slice(1) : source;
      if (document.isDirty || document.getText() !== sourceText) throw new Error('编辑器与磁盘内容不一致。');
      if (!Number.isSafeInteger(input.line) || input.line < 1 || input.line > document.lineCount || !Number.isSafeInteger(input.column) || input.column < 1 || input.column > document.lineAt(input.line - 1).text.length + 1) throw new Error('重命名位置超出文件范围。');
      const version = document.version;
      const observed = new Map(vscode.workspace.textDocuments.map(doc => [doc.uri.toString(), doc.version]));
      const result = await bounded(() => vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, new vscode.Position(input.line - 1, input.column - 1), input.newName), signal);
      if (document.isDirty || document.version !== version || await read(target.file) !== source) throw new Error('重命名期间源文件已变化。');
      if (!result || typeof result.entries !== 'function') throw new Error('语言服务未提供重命名方案，请检查语言扩展或使用引用搜索。');
      const entries = result.entries();
      if (!entries.length || entries.length > 20) throw new Error('重命名方案必须包含 1 至 20 个文本文件。');
      const roots = await Promise.all(workspaceFolders(sessionId).filter(f => f.uri.scheme === 'file').map(f => fs.realpath(f.uri.fsPath)));
      const files = [], seen = new Set();
      for (const [uri, edits] of entries) {
        signal?.throwIfAborted();
        if (uri.scheme !== 'file') throw new Error('重命名方案包含非工作区文件。');
        const file = await fs.realpath(uri.fsPath), root = roots.findIndex(r => inside(r, file));
        if (root < 0) throw new Error('重命名方案超出会话工作区。');
        const resolved = await locate({ root, path: path.relative(roots[root], uri.fsPath) }, sessionId);
        const key = process.platform === 'win32' ? resolved.file.toLowerCase() : resolved.file;
        if (seen.has(key)) throw new Error('重命名方案包含重复文件。');
        seen.add(key);
        const before = await read(resolved.file);
        if (before === null) throw new Error('重命名目标不存在。');
        await assertClean(resolved.file);
        const doc = await bounded(() => vscode.workspace.openTextDocument(uri), signal);
        if (observed.has(doc.uri.toString()) && observed.get(doc.uri.toString()) !== doc.version) throw new Error('重命名期间目标文档已变化。');
        const bom = before.startsWith('\uFEFF') ? 1 : 0;
        if (doc.isDirty || doc.getText() !== before.slice(bom)) throw new Error('重命名目标的编辑器与磁盘内容不一致。');
        if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('每个文件的重命名修改必须在 1 至 100 项之间。');
        const offset = position => {
          if (!position || !Number.isSafeInteger(position.line) || position.line < 0 || position.line >= doc.lineCount || !Number.isSafeInteger(position.character) || position.character < 0 || position.character > doc.lineAt(position.line).text.length) throw new Error('语言服务返回了无效编辑范围。');
          return doc.offsetAt(position) + bom;
        };
        const ranges = edits.map(edit => {
          if (typeof edit.newText !== 'string') throw new Error('语言服务返回了无效替换内容。');
          return { start: offset(edit.range?.start), end: offset(edit.range?.end), newText: edit.newText };
        });
        files.push({ root, path: resolved.path, operation: 'ranges', expectedHash: hash(before), edits: ranges });
      }
      // Check all versions again: a provider or another editor may have changed
      // an earlier file while later documents were opened.
      for (const item of files) {
        signal?.throwIfAborted();
        const target = await locate(item, sessionId); await assertClean(target.file);
        if (hash(await read(target.file)) !== item.expectedHash) throw new Error('重命名目标已变化，请重新生成方案。');
      }
      const value = { status: 'text_edits_proposed', files, saved: false, scope: 'language-provider text edits only; file/resource operations excluded', next: 'Read affected files/instructions, preview_workspace_edits, then edit_workspace_files and validate.' };
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 65536) throw new Error('重命名方案超过 64 KiB，请缩小重构范围。');
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text }], details: value };
    }
  });
}
module.exports = { createRenamePreview };
