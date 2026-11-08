'use strict';

const { access, mkdir, rename } = require('node:fs/promises');
const { dirname, join } = require('node:path');

// SQLite on Windows uses the Win32 path API, so the full database file path
// (including its `-journal`/`-wal` sidecar) must stay below MAX_PATH. Node's fs
// API handles long paths, which is why the directory itself can be created and
// only the SQLite open fails with SQLITE_CANTOPEN ("unable to open database
// file"). Keep directory names short enough for the longest sidecar suffix.
const SQLITE_SIDECAR_BUDGET = 22; // separator + "assist.sqlite-journal"
const SQLITE_MAX_PATH = 250;
const DEFAULT_MAX_DIRECTORY = SQLITE_MAX_PATH - SQLITE_SIDECAR_BUDGET;

async function exists(target) {
  try { await access(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Pick the on-disk directory for one conversation/workspace scope.
 *
 * Historical layout appended the full 32-char workspace key to the directory
 * (`<base>-workspace-<key>`), which pushed SQLite files past MAX_PATH on Windows.
 * New scopes use `<base>-w<16 hex>`; existing long legacy directories are
 * migrated by rename so sessions keep their database and chat history. When
 * even the short directory is too long the directory is replaced by a compact
 * hash under the storage root.
 *
 * @returns {Promise<{ directory: string, migrated: boolean, shortcut: boolean }>}
 */
async function resolveStorageDirectory({ root, base, workspaceKey, mismatched, compactDirectory, maxDirectory = DEFAULT_MAX_DIRECTORY } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('root is required');
  if (typeof base !== 'string' || !base) throw new TypeError('base is required');
  if (typeof workspaceKey !== 'string' || !/^[a-f0-9]{32}$/.test(workspaceKey)) throw new TypeError('workspaceKey must be a 32-char hex string');
  if (typeof mismatched !== 'boolean') throw new TypeError('mismatched must be a boolean');
  const compact = compactDirectory || join(root, 'w-' + workspaceKey.slice(0, 16));
  const short = mismatched ? `${base}-w${workspaceKey.slice(0, 16)}` : base;
  const legacy = mismatched ? `${base}-workspace-${workspaceKey}` : base;
  const risky = target => target.length > maxDirectory;

  // Already migrated / already short.
  if (await exists(short)) {
    if (!risky(short)) return { directory: short, migrated: false, shortcut: shortcutOf(short, base) };
    if (await exists(compact)) return { directory: compact, migrated: false, shortcut: true };
    try {
      await mkdir(dirname(compact), { recursive: true });
      await rename(short, compact);
      return { directory: compact, migrated: true, shortcut: true };
    } catch {
      return { directory: short, migrated: false, shortcut: shortcutOf(short, base) };
    }
  }
  if (await exists(compact)) return { directory: compact, migrated: false, shortcut: true };

  if (legacy !== short && await exists(legacy)) {
    if (!risky(legacy)) return { directory: legacy, migrated: false, shortcut: false };
    const target = risky(short) ? compact : short;
    try {
      await mkdir(dirname(target), { recursive: true });
      await rename(legacy, target);
      return { directory: target, migrated: true, shortcut: true };
    } catch {
      return { directory: legacy, migrated: false, shortcut: false };
    }
  }

  return { directory: risky(short) ? compact : short, migrated: false, shortcut: risky(short) };
}

function shortcutOf(directory, base) {
  return directory !== base;
}

module.exports = { resolveStorageDirectory, DEFAULT_MAX_DIRECTORY };
