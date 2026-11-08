import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from 'typebox';
import { flagHelpProperties, withProgressiveDisclosure } from '../intools/shared/disclosure.mjs';
import { detectImageMime, imageDimensions, imageFormat, MAX_IMAGE_BYTES } from '../intools/shared/image-info.mjs';
import { WORKSPACE_LIST_CATALOG } from '../intools/shared/tool-catalogs.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, path) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

/** Read-only workspace capabilities. Canonical paths prevent traversal through symlinks.
 * Path note: ubovm/src/renderer/workbench/ and ubovm/src/renderer/webview/ are siblings;
 * startup.html/workbench.css live under workbench/, not webview/. If a webview/... lookup misses,
 * did-you-mean: retry under workbench/. read_workspace_code is the canonical file read
 * (line paging via startLine/lineCount); these base tools stay read-only. */
export async function createWorkspaceTools(workspaceRoots = [], { unbounded = false, externalImages = true } = {}) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.some(root => typeof root !== 'string')) throw new TypeError('workspaceRoots must be an array of paths');
  const roots = [...new Set(await Promise.all(workspaceRoots.map(root => realpath(resolve(root)))))];
  async function locate(input = {}, signal, { external = false } = {}) {
    signal?.throwIfAborted();
    const index = input.root ?? 0, requested = input.path ?? '.';
    const root = roots[index];
    if (!Number.isInteger(index) || (!root && !unbounded && !(external && typeof requested === 'string' && isAbsolute(requested)))) throw failure('WORKSPACE_REQUIRED', 'Select an open workspace root before reading files');
    if (typeof requested !== 'string' || requested.includes('\0') || requested.replace(/^[A-Za-z]:/, '').includes(':')) throw failure('INVALID_WORKSPACE_PATH', 'Invalid workspace path');
    // 完全模式 resolves against the workspace root when there is one, but accepts
    // absolute and escaping paths and never enforces the boundary.
    const origin = root ?? process.cwd();
    const candidate = resolve(origin, requested);
    // read_image may inspect absolute local images outside the roots (read-only).
    // Relative traversal keeps the workspace boundary: only an explicit absolute
    // path can widen the image read.
    const outsideRequested = !inside(origin, candidate);
    const externalPath = external && outsideRequested && isAbsolute(requested);
    if (!unbounded && outsideRequested && !externalPath) throw failure('WORKSPACE_BOUNDARY', 'Path is outside the selected workspace');
    let canonical;
    try { canonical = await realpath(candidate); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        signal?.throwIfAborted();
        return { path: candidate, root: index, external: Boolean(externalPath || outsideRequested), missing: true, missingCode: error.code, display: (root && inside(root, candidate) ? relative(root, candidate) : candidate) || requested || '.' };
      }
      throw error;
    }
    if (!unbounded && !inside(origin, canonical) && !externalPath) throw failure('WORKSPACE_BOUNDARY', 'Resolved path is outside the selected workspace');
    signal?.throwIfAborted();
    const externalRead = !root || !inside(root, canonical);
    return { path: canonical, root: index, external: externalRead, display: (root && inside(root, canonical) ? relative(root, canonical) : canonical) || '.' };
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
    {
      name: 'read_image', recovery: 'retry-read-only', label: '读取图片',
      description: `Read one local image file and return it to the model as an image plus bounded metadata. Supports PNG, JPEG, WebP and GIF up to ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB; metadata includes path, MIME type, format, byte size and pixel dimensions. Use this for screenshots, diagrams, design references, OCR or visual checks instead of describing an image from its name. A relative path follows the workspace boundary; an absolute local path outside the workspace is also allowed read-only (external=true) and non-image files are rejected. ${unbounded ? '完全模式 is active: any absolute path on this machine is accepted.' : ''}`,
      parameters: Type.Object({
        root: Type.Optional(Type.Integer({ minimum: 0 })),
        path: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        requirePath(input.path);
        const target = await locate(input, signal, { external: externalImages });
        const external = target.external === true;
        if (target.missing) {
          return result({ exists: false, path: target.display, root: target.root, mimeType: null, format: null, bytes: 0, width: null, height: null, external,
            guidance: 'This image does not exist. Check the path before reading it again.' });
        }
        const info = await stat(target.path);
        if (!info.isFile()) throw failure('WORKSPACE_NOT_FILE', 'Path must be a regular image file');
        signal?.throwIfAborted();
        // Read the header first so an external non-image path is rejected without
        // loading or returning its full contents.
        const header = Buffer.alloc(Math.min(info.size, 32));
        const handle = await open(target.path, 'r');
        try { await handle.read(header, 0, header.length, 0); }
        finally { await handle.close(); }
        signal?.throwIfAborted();
        const headerMime = detectImageMime(header);
        if (!headerMime) throw failure('IMAGE_UNSUPPORTED', 'Unsupported image bytes. Use PNG, JPEG, WebP or GIF.');
        if (info.size > MAX_IMAGE_BYTES) throw failure('IMAGE_TOO_LARGE', `Image exceeds ${MAX_IMAGE_BYTES} bytes (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB). Use a smaller image or a screenshot crop.`);
        const buffer = await readFile(target.path);
        signal?.throwIfAborted();
        const mimeType = detectImageMime(buffer);
        if (!mimeType) throw failure('IMAGE_UNSUPPORTED', 'Unsupported image bytes. Use PNG, JPEG, WebP or GIF.');
        const dimensions = imageDimensions(buffer);
        const metadata = { exists: true, path: target.display, root: target.root, mimeType, format: imageFormat(mimeType) ?? null, bytes: buffer.length,
          width: dimensions?.width ?? null, height: dimensions?.height ?? null, external };
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
