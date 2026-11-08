// Declarative extension enable/disable state.
//
// VS Code has no public API to toggle extensions and renaming extension
// directories while the extension host holds them is unreliable (especially on
// Windows). UBOVM therefore records the desired state before the window reloads
// and reconciles the two directories in the Electron main process, before Code
// OSS scans extensions.
import fs from 'node:fs';
import path from 'node:path';

const FOLDER_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
// The harness extension is the IDE itself; it must never be moved out by state.
const PROTECTED_EXTENSIONS = new Set(['ubovm-core']);

function safeDisabledList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(name => typeof name === 'string' && FOLDER_PATTERN.test(name) && !PROTECTED_EXTENSIONS.has(name)))]
    : [];
}

export function extensionStatePaths(paths) {
  const extensions = paths?.extensions || path.join(paths?.portable || '', 'extensions');
  const portable = paths?.portable || path.dirname(extensions);
  return {
    extensions,
    disabled: path.join(portable, 'disabled-extensions'),
    stateFile: path.join(portable, 'extension-state.json')
  };
}

export function readExtensionState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { disabled: safeDisabledList(value?.disabled) };
  } catch {
    return { disabled: [] };
  }
}

export function writeExtensionState(file, state) {
  const disabled = safeDisabledList(state?.disabled);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ disabled: disabled.slice(0, 2000) }, null, 2) + '\n');
  return { disabled };
}

/**
 * Move folders between `extensions/` and `disabled-extensions/` to match the
 * recorded state. Runs before Code OSS imports its main process, so no
 * extension file is in use.
 */
export function reconcileExtensionState(paths, logger = console) {
  const { extensions, disabled, stateFile } = extensionStatePaths(paths);
  const state = readExtensionState(stateFile);
  const desired = new Set(state.disabled);
  const result = { disabled: [], enabled: [], missing: [] };
  try {
    fs.mkdirSync(extensions, { recursive: true });
    fs.mkdirSync(disabled, { recursive: true });
  } catch (error) {
    logger.warn?.('[UBOVM] Extension state directories are unavailable:', error?.message || error);
    return result;
  }
  const move = (from, to) => {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      logger.warn?.(`[UBOVM] Unable to move extension folder ${path.basename(from)}: ${error?.message || error}`);
      return false;
    }
  };
  // Apply the recorded disabled list.
  for (const name of desired) {
    const source = path.join(extensions, name);
    if (!fs.existsSync(source)) continue;
    if (move(source, path.join(disabled, name))) result.disabled.push(name);
  }
  // Everything in disabled-extensions/ that is no longer recorded becomes enabled.
  for (const name of fs.readdirSync(disabled)) {
    if (!FOLDER_PATTERN.test(name) || desired.has(name)) continue;
    const source = path.join(disabled, name);
    const target = path.join(extensions, name);
    try {
      if (!fs.statSync(source).isDirectory()) continue;
    } catch { continue; }
    if (fs.existsSync(target)) { result.missing.push(name); continue; }
    if (move(source, target)) result.enabled.push(name);
  }
  return result;
}
