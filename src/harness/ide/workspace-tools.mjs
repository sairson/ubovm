import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from 'typebox';
import { flagHelpProperties, withProgressiveDisclosure } from '../intools/shared/disclosure.mjs';
import { WORKSPACE_LIST_CATALOG, WORKSPACE_READ_CATALOG } from '../intools/shared/tool-catalogs.mjs';

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
    withProgressiveDisclosure({
      name: 'list_workspace_files', recovery: 'retry-read-only', label: 'List workspace files',
      description: `${WORKSPACE_LIST_CATALOG.description} Roots: ${JSON.stringify(roots.map((path, root) => ({ root, path })))}`,
      parameters: Type.Object({
        ...base,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        ...flagHelpProperties()
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        const offset = input.offset ?? 0, limit = input.limit ?? 500;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid directory page');
        const target = await locate(input, signal);
        const entries = (await readdir(target.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        signal?.throwIfAborted();
        const page = entries.slice(offset, offset + limit), nextOffset = offset + page.length < entries.length ? offset + page.length : null;
        return result({ root: target.root, path: relative(roots[target.root], target.path) || '.', entries: page.map(item => ({ name: item.name, type: item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' })), offset, totalEntries: entries.length, nextOffset, truncated: nextOffset !== null });
      }
    }, { ...WORKSPACE_LIST_CATALOG, mode: 'flag' }),
    withProgressiveDisclosure({
      name: 'read_workspace_file', recovery: 'retry-read-only', label: 'Read workspace file',
      description: WORKSPACE_READ_CATALOG.description,
      parameters: Type.Object({
        ...base,
        path: Type.Optional(Type.String()),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
        ...flagHelpProperties()
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        requirePath(input.path);
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
          const fileTruncated = info.size > bytes;
          let text;
          try {
            // A byte cap may bisect a valid character; with streaming decode
            // only that unfinished suffix is omitted. Invalid interior bytes
            // must never silently become replacement characters in evidence.
            text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes), { stream: fileTruncated });
          } catch { throw failure('WORKSPACE_BINARY_FILE', 'Only valid UTF-8 text files are supported'); }
          if (text.includes('\0')) throw failure('WORKSPACE_BINARY_FILE', 'Only UTF-8 text files are supported');
          const lines = text ? text.split(/\r?\n/) : [];
          if (text.endsWith('\n')) lines.pop();
          const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
          let content = '', count = 0, outputBytes = 0, lineTruncated = false;
          for (const line of selected) { const next = `${startLine + count}: ${line}\n`, size = Buffer.byteLength(next); if (outputBytes + size > 128 << 10) break; content += next; count++; outputBytes += size; }
          if (!count && selected.length) { content = `${startLine}: ${Array.from(selected[0]).slice(0, 30000).join('')}\n[line truncated]\n`; count = 1; lineTruncated = true; }
          const nextLine = count && startLine - 1 + count < lines.length ? startLine + count : null;
          return result({ path: relative(roots[target.root], target.path), root: target.root, startLine, endLine: count ? startLine + count - 1 : null, content,
            truncated: fileTruncated || lineTruncated || nextLine !== null, fileTruncated, lineTruncated, accessibleLines: lines.length, nextLine });
        } finally { await handle.close(); }
      }
    }, { ...WORKSPACE_READ_CATALOG, mode: 'flag' })
  ];
}

function requirePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw failure('INVALID_WORKSPACE_PATH', 'path is required');
}
