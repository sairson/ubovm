import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from 'typebox';
import { flagHelpProperties, withProgressiveDisclosure } from '../intools/shared/disclosure.mjs';
import { detectImageMime, MAX_IMAGE_BYTES } from '../intools/shared/image-info.mjs';
import { WORKSPACE_LIST_CATALOG, WORKSPACE_READ_CATALOG } from '../intools/shared/tool-catalogs.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, path) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

/** Read-only workspace capabilities. Canonical paths prevent traversal through symlinks.
 * Path note: ubovm/src/renderer/workbench/ and ubovm/src/renderer/webview/ are siblings;
 * startup.html/workbench.css live under workbench/, not webview/. If a webview/... lookup misses,
 * did-you-mean: retry under workbench/. Large files (e.g. workbench.css ~1715 lines,
 * message-view.css 300+ lines): page read_workspace_file via nextLine loop; code to edit pages
 * via read_workspace_code nextOffset loop; on tool_defect re-read with the other read tool. */
export async function createWorkspaceTools(workspaceRoots = [], { unbounded = false } = {}) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.some(root => typeof root !== 'string')) throw new TypeError('workspaceRoots must be an array of paths');
  const roots = [...new Set(await Promise.all(workspaceRoots.map(root => realpath(resolve(root)))))];
  async function locate(input = {}, signal) {
    signal?.throwIfAborted();
    const index = input.root ?? 0, requested = input.path ?? '.';
    const root = roots[index];
    if (!Number.isInteger(index) || (!root && !unbounded)) throw failure('WORKSPACE_REQUIRED', 'Select an open workspace root before reading files');
    if (typeof requested !== 'string' || requested.includes('\0') || requested.replace(/^[A-Za-z]:/, '').includes(':')) throw failure('INVALID_WORKSPACE_PATH', 'Invalid workspace path');
    // 完全模式 resolves against the workspace root when there is one, but accepts
    // absolute and escaping paths and never enforces the boundary.
    const origin = root ?? process.cwd();
    const candidate = resolve(origin, requested);
    if (!unbounded && !inside(origin, candidate)) throw failure('WORKSPACE_BOUNDARY', 'Path is outside the selected workspace');
    let canonical;
    try { canonical = await realpath(candidate); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        signal?.throwIfAborted();
        return { path: candidate, root: index, missing: true, missingCode: error.code, display: (root ? relative(root, candidate) : candidate) || requested || '.' };
      }
      throw error;
    }
    if (!unbounded && !inside(origin, canonical)) throw failure('WORKSPACE_BOUNDARY', 'Resolved path is outside the selected workspace');
    signal?.throwIfAborted();
    return { path: canonical, root: index, display: (root && inside(root, canonical) ? relative(root, canonical) : canonical) || '.' };
  }
  const base = { root: Type.Optional(Type.Integer({ minimum: 0 })), path: Type.Optional(Type.String()) };
  return [
    withProgressiveDisclosure({
      name: 'list_workspace_files', recovery: 'retry-read-only', label: 'List workspace files',
      description: `${WORKSPACE_LIST_CATALOG.description} Roots: ${JSON.stringify(roots.map((path, root) => ({ root, path })))}${unbounded ? ' 完全模式 is active: root/path may be any absolute path on this machine, not only the roots listed.' : ''}`,
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
        if (target.missing) {
          return result({
            root: target.root, path: target.display, exists: false, entries: [], offset, totalEntries: 0, nextOffset: null, truncated: false,
            reason: target.missingCode === 'ENOTDIR' ? 'not_directory' : 'missing',
            guidance: 'This path is not a directory that can be listed. Create it if needed; a missing path is not a tool failure.'
          });
        }
        let entries;
        try { entries = (await readdir(target.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
        catch (error) {
          if (error.code === 'ENOTDIR' || error.code === 'ENOENT') {
            return result({
              root: target.root, path: target.display, exists: error.code !== 'ENOENT', entries: [], offset, totalEntries: 0, nextOffset: null, truncated: false,
              reason: error.code === 'ENOENT' ? 'missing' : 'not_directory',
              guidance: error.code === 'ENOENT'
                ? 'This directory does not exist. Create it if needed; a missing path is not a tool failure.'
                : 'This path is a file, not a directory. Listing it is not a tool failure.'
            });
          }
          throw error;
        }
        signal?.throwIfAborted();
        const page = entries.slice(offset, offset + limit), nextOffset = offset + page.length < entries.length ? offset + page.length : null;
        return result({ root: target.root, path: target.display, exists: true, entries: page.map(item => ({ name: item.name, type: item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' })), offset, totalEntries: entries.length, nextOffset, truncated: nextOffset !== null });
      }
    }, { ...WORKSPACE_LIST_CATALOG, mode: 'flag' }),
    withProgressiveDisclosure({
      name: 'read_workspace_file', recovery: 'retry-read-only', label: 'Read workspace file',
      description: `${WORKSPACE_READ_CATALOG.description} Path: ubovm/src/renderer/workbench/ and ubovm/src/renderer/webview/ are siblings; startup.html/workbench.css are under workbench/. Large files page via nextLine; editable code via read_workspace_code nextOffset; on tool_defect use the other read tool.${unbounded ? ' 完全模式 is active: path may be any absolute path on this machine.' : ''}`,
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
        if (target.missing) {
          return result({
            exists: false, path: target.display, root: target.root, content: null,
            startLine: input.startLine ?? 1, endLine: null, truncated: false, fileTruncated: false, lineTruncated: false, accessibleLines: 0, nextLine: null,
            guidance: 'This file does not exist. Create it if needed; a missing path is not a tool failure.'
          });
        }
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
          return result({ exists: true, path: target.display, root: target.root, startLine, endLine: count ? startLine + count - 1 : null, content,
            truncated: fileTruncated || lineTruncated || nextLine !== null, fileTruncated, lineTruncated, accessibleLines: lines.length, nextLine });
        } finally { await handle.close(); }
      }
    }, { ...WORKSPACE_READ_CATALOG, mode: 'flag' }),
    {
      name: 'read_image', recovery: 'retry-read-only', label: '读取图片',
      description: `Read one image file from the workspace and return it to the model. Supports PNG, JPEG, WebP and GIF up to ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB. Use this for screenshots, diagrams, design references, OCR or visual checks. The path follows the same workspace boundary as read_workspace_file; 完全模式 accepts any absolute path. The returned metadata includes path, MIME type and byte size.`,
      parameters: Type.Object({
        root: Type.Optional(Type.Integer({ minimum: 0 })),
        path: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        requirePath(input.path);
        const target = await locate(input, signal);
        if (target.missing) {
          return result({ exists: false, path: target.display, root: target.root, mimeType: null, bytes: 0,
            guidance: 'This image does not exist. Check the path before reading it again.' });
        }
        const info = await stat(target.path);
        if (!info.isFile()) throw failure('WORKSPACE_NOT_FILE', 'Path must be a regular image file');
        if (info.size > MAX_IMAGE_BYTES) throw failure('IMAGE_TOO_LARGE', `Image exceeds ${MAX_IMAGE_BYTES} bytes (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB). Use a smaller image or a screenshot crop.`);
        signal?.throwIfAborted();
        const buffer = await readFile(target.path);
        signal?.throwIfAborted();
        const mimeType = detectImageMime(buffer);
        if (!mimeType) throw failure('IMAGE_UNSUPPORTED', 'Unsupported image bytes. Use PNG, JPEG, WebP or GIF.');
        const metadata = { exists: true, path: target.display, root: target.root, mimeType, bytes: buffer.length };
        return {
          content: [
            { type: 'image', data: buffer.toString('base64'), mimeType },
            { type: 'text', text: JSON.stringify(metadata) }
          ],
          details: metadata
        };
      }
    }
  ];
}

function requirePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw failure('INVALID_WORKSPACE_PATH', 'path is required');
}
