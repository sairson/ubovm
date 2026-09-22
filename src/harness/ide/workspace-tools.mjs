import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from 'typebox';

const failure = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, path) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

/** Read-only workspace capabilities. Canonical paths prevent traversal through symlinks. */
export async function createWorkspaceTools(workspaceRoots = []) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.some(root => typeof root !== 'string')) throw new TypeError('workspaceRoots must be an array of paths');
  const roots = [...new Set(await Promise.all(workspaceRoots.map(root => realpath(resolve(root)))))];
  async function locate(input = {}, signal) {
    signal?.throwIfAborted();
    const index = input.root ?? 0, path = input.path ?? '.';
    if (!Number.isInteger(index) || !roots[index]) throw failure('WORKSPACE_REQUIRED', 'Select an open workspace root before reading files');
    if (typeof path !== 'string' || path.includes('\0') || path.replace(/^[A-Za-z]:/, '').includes(':')) throw failure('INVALID_WORKSPACE_PATH', 'Invalid workspace path');
    const candidate = resolve(roots[index], path);
    if (!inside(roots[index], candidate)) throw failure('WORKSPACE_BOUNDARY', 'Path is outside the selected workspace');
    const canonical = await realpath(candidate);
    if (!inside(roots[index], canonical)) throw failure('WORKSPACE_BOUNDARY', 'Resolved path is outside the selected workspace');
    signal?.throwIfAborted();
    return { path: canonical, root: index };
  }
  const base = { root: Type.Optional(Type.Integer({ minimum: 0 })), path: Type.Optional(Type.String()) };
  return [
    {
      name: 'list_workspace_files', recovery: 'retry-read-only', label: 'List workspace files',
      description: `List one directory inside an open workspace, up to 500 entries per page. Continue with nextOffset until it is null. Read only; no shell access. Roots: ${JSON.stringify(roots.map((path, root) => ({ root, path })))}`,
      parameters: Type.Object({ ...base, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        const offset = input.offset ?? 0, limit = input.limit ?? 500;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid directory page');
        const target = await locate(input, signal);
        const entries = (await readdir(target.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        signal?.throwIfAborted();
        const page = entries.slice(offset, offset + limit), nextOffset = offset + page.length < entries.length ? offset + page.length : null;
        return result({ root: target.root, path: relative(roots[target.root], target.path) || '.', entries: page.map(item => ({ name: item.name, type: item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' })), offset, totalEntries: entries.length, nextOffset, truncated: nextOffset !== null });
      }
    },
    {
      name: 'read_workspace_file', recovery: 'retry-read-only', label: 'Read workspace file',
      description: 'Read UTF-8 text from an open workspace file. Uses one-based line numbers and returns at most 400 lines / 128 KiB. Continue with nextLine until it is null. Only the first 4 MiB are accessible; fileTruncated or lineTruncated indicate omitted content that cannot be recovered by advancing lines. Read only; no shell access.',
      parameters: Type.Object({ ...base, path: Type.String(), startLine: Type.Optional(Type.Integer({ minimum: 1 })), lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })) }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        const target = await locate(input, signal);
        const startLine = input.startLine ?? 1, lineCount = input.lineCount ?? 200;
        if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 400) throw new TypeError('Invalid line range');
        if (!(await stat(target.path)).isFile()) throw failure('WORKSPACE_NOT_FILE', 'Path must be a regular file');
        const handle = await open(target.path, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw failure('WORKSPACE_NOT_FILE', 'Path must be a regular file');
          const maximum = 4 << 20, buffer = Buffer.alloc(Math.min(info.size, maximum));
          let bytes = 0;
          while (bytes < buffer.length) { signal?.throwIfAborted(); const read = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!read.bytesRead) break; bytes += read.bytesRead; }
          signal?.throwIfAborted();
          const text = buffer.subarray(0, bytes).toString('utf8');
          if (text.includes('\0')) throw failure('WORKSPACE_BINARY_FILE', 'Only UTF-8 text files are supported');
          const lines = text ? text.split(/\r?\n/) : [];
          if (text.endsWith('\n')) lines.pop();
          const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
          let content = '', count = 0, outputBytes = 0, lineTruncated = false;
          for (const line of selected) { const next = `${startLine + count}: ${line}\n`, size = Buffer.byteLength(next); if (outputBytes + size > 128 << 10) break; content += next; count++; outputBytes += size; }
          if (!count && selected.length) { content = `${startLine}: ${selected[0].slice(0, 30000)}\n[line truncated]\n`; count = 1; lineTruncated = true; }
          const fileTruncated = info.size > bytes, nextLine = count && startLine - 1 + count < lines.length ? startLine + count : null;
          return result({ path: relative(roots[target.root], target.path), root: target.root, startLine, endLine: count ? startLine + count - 1 : null, content,
            truncated: fileTruncated || lineTruncated || nextLine !== null, fileTruncated, lineTruncated, accessibleLines: lines.length, nextLine });
        } finally { await handle.close(); }
      }
    }
  ];
}
