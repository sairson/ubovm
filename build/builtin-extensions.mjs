#!/usr/bin/env node
// Keep the VS Code extension host limited to the harness extension and the
// language services it actually uses. This runs against the packaged VSCodium
// tree; it is deliberately separate from Sync-Application so it can be tested
// without downloading a runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = path.join(here, '..', 'resources', 'builtin-extensions.json');

function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

export async function loadBuiltinAllowlist(file = DEFAULT_ALLOWLIST) {
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(manifest.keep) || !manifest.keep.length || manifest.keep.some(name => !safeName(name))) {
    throw new Error(`Invalid builtin extension allowlist: ${file}`);
  }
  return Object.freeze([...new Set(manifest.keep)]);
}

export async function pruneBuiltinExtensions(root, keep) {
  if (!root || !Array.isArray(keep)) throw new TypeError('extensions root and keep list are required');
  const carried = new Set(keep);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { removed: [], kept: [] }; throw error; }
  const removed = [];
  const kept = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!safeName(entry.name)) throw new Error(`Unsafe extension directory name: ${entry.name}`);
    if (carried.has(entry.name)) { kept.push(entry.name); continue; }
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, kept };
}

export const ALLOWED_EXTENSION_IDS = Object.freeze([
  'ubovm.ubovm-core',
  'vscode.bat',
  'vscode.configuration-editing',
  'vscode.css',
  'vscode.css-language-features',
  'vscode.diff',
  'vscode.html',
  'vscode.html-language-features',
  'vscode.javascript',
  'vscode.json',
  'vscode.json-language-features',
  'vscode.markdown',
  'vscode.markdown-language-features',
  'vscode.media-preview',
  'vscode.powershell',
  'vscode.python',
  'vscode.shellscript',
  'vscode.sql',
  'vscode.theme-defaults',
  'vscode.vscode-theme-seti',
  'vscode.typescript',
  'vscode.typescript-language-features',
  'vscode.xml',
  'vscode.yaml'
]);

export const PRODUCT_KEYS_TO_REMOVE = Object.freeze([
  'extensionsGallery',
  'extensionsGalleryHeader',
  'extensionsGalleryFooter'
]);

export async function cleanProductMetadata(productFile) {
  let raw;
  try { raw = await fs.readFile(productFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const product = JSON.parse(raw);
  const before = JSON.stringify(product);
  for (const key of PRODUCT_KEYS_TO_REMOVE) delete product[key];
  // Removing the gallery is enough to disable marketplace discovery. Do not
  // delete builtInExtensions/builtInExtensionsEnabledWithAutoUpdates or
  // defaultChatAgent here: the extension and chat services dereference those
  // fields during startup and a missing field leaves the splash screen waiting.
  if (Object.hasOwn(product, 'updateUrl')) product.updateUrl = '';
  product.updateUrl = '';
  product.sharedDataFolderName = '.ubovm-shared';
  product.darwinBundleIdentifier = 'com.ubovm.ide';
  if (JSON.stringify(product) === before) return false;
  await fs.writeFile(productFile, JSON.stringify(product, null, 2) + '\n');
  return true;
}

// Kept as a named export for callers/tests that only care about the marketplace.
export async function stripExtensionGallery(productFile) {
  return cleanProductMetadata(productFile);
}

const REQUIRED_BUILTINS = new Set(['ubovm-core', 'typescript-language-features', 'json-language-features']);

function safeFolderNames(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(name => typeof name === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(name)))]
    : [];
}

function readBuiltinDisabledState(portable) {
  if (!portable) return { disabled: new Set(), stateFile: '', disabledRoot: '' };
  const stateFile = path.join(portable, 'extension-state.json');
  let names = [];
  try {
    const value = JSON.parse(readFileSync(stateFile, 'utf8'));
    names = safeFolderNames(value?.disabledBuiltin);
  } catch { /* missing or corrupt state means nothing is disabled */ }
  return {
    stateFile,
    disabledRoot: path.join(portable, 'disabled-builtin-extensions'),
    disabled: new Set(names.filter(name => !REQUIRED_BUILTINS.has(name)))
  };
}

async function moveBuiltinState(extensionsRoot, disabledRoot, disabled) {
  await fs.mkdir(extensionsRoot, { recursive: true });
  await fs.mkdir(disabledRoot, { recursive: true });
  const result = { disabled: [], enabled: [] };
  for (const name of disabled) {
    const source = path.join(extensionsRoot, name);
    const target = path.join(disabledRoot, name);
    if (!existsSync(source)) continue;
    try { await fs.rename(source, target); result.disabled.push(name); }
    catch { /* a locked or read-only installation keeps the extension enabled */ }
  }
  for (const entry of await fs.readdir(disabledRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !safeName(entry.name) || disabled.has(entry.name)) continue;
    const source = path.join(disabledRoot, entry.name);
    const target = path.join(extensionsRoot, entry.name);
    if (existsSync(target)) continue;
    try { await fs.rename(source, target); result.enabled.push(entry.name); }
    catch { /* restore fallback below can copy a fresh version */ }
  }
  return result;
}

export async function restoreBuiltinExtensions(root, keep, sourceRoot, skip = new Set()) {
  if (!root || !sourceRoot || !Array.isArray(keep)) return { restored: [] };
  const restored = [];
  for (const name of keep) {
    if (name === 'node_modules' || skip.has(name)) continue;
    const target = path.join(root, name);
    if (existsSync(target)) continue;
    const source = path.join(sourceRoot, name);
    if (!existsSync(source)) continue;
    await fs.mkdir(root, { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true });
    restored.push(name);
  }
  return { restored };
}

export async function applyBuiltinExtensionPolicy({ appRoot, allowlist = DEFAULT_ALLOWLIST, sourceRoot, stateFile, disabledRoot, logger = console }) {
  if (!appRoot || typeof appRoot !== 'string') throw new TypeError('appRoot is required');
  const keep = await loadBuiltinAllowlist(allowlist);
  const extensionsRoot = path.join(appRoot, 'extensions');
  const state = stateFile
    ? { ...readBuiltinDisabledState(path.dirname(stateFile)), stateFile }
    : { disabled: new Set(), stateFile: '', disabledRoot: disabledRoot || '' };
  if (disabledRoot) state.disabledRoot = disabledRoot;
  const removedBuiltins = state.disabledRoot ? await moveBuiltinState(extensionsRoot, state.disabledRoot, state.disabled) : { disabled: [], enabled: [] };
  // Expanding the allowlist must also repair runtimes pruned by an older build:
  // copy missing kept extensions from an explicit pristine source when supplied.
  const repaired = await restoreBuiltinExtensions(extensionsRoot, keep, sourceRoot, state.disabled);
  const result = await pruneBuiltinExtensions(extensionsRoot, keep);
  const missing = ['typescript-language-features', 'json-language-features'].filter(name => !result.kept.includes(name));
  if (missing.length) throw new Error(`Required builtin extensions are missing: ${missing.join(', ')}`);
  const stripped = [];
  for (const name of ['product.json', 'product.ubovm-base.json']) {
    if (await stripExtensionGallery(path.join(appRoot, name))) stripped.push(name);
  }
  logger.log?.(`[UBOVM] Builtin extensions: kept ${result.kept.length}, removed ${result.removed.length}${repaired.restored.length ? `, restored ${repaired.restored.length}` : ''}${removedBuiltins.disabled.length ? `, disabled ${removedBuiltins.disabled.length}` : ''}; product metadata cleaned in ${stripped.join(', ') || 'none'}.`);
  return { ...result, ...repaired, builtinState: removedBuiltins, stripped, keep };
}

async function main(argv) {
  const options = argv.slice(2);
  let stateFile = '';
  const positional = [];
  for (let index = 0; index < options.length; index++) {
    const argument = options[index];
    if (argument === '--state') { stateFile = options[++index] || ''; continue; }
    if (argument.startsWith('--state=')) { stateFile = argument.slice('--state='.length); continue; }
    if (argument.startsWith('--')) continue;
    positional.push(argument);
  }
  const appRoot = positional[0];
  const sourceRoot = positional[1];
  if (!appRoot) {
    console.error('Usage: node build/builtin-extensions.mjs <resources/app> [pristine-extensions-dir] [--state extension-state.json] [--dry-run]');
    process.exitCode = 2;
    return;
  }
  if (options.includes('--dry-run')) {
    const keep = await loadBuiltinAllowlist();
    const extensionsRoot = path.join(appRoot, 'extensions');
    const entries = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const carried = new Set(keep);
    const remove = entries.filter(entry => entry.isDirectory() && !carried.has(entry.name)).map(entry => entry.name);
    console.log(JSON.stringify({ keep, remove }, null, 2));
    return;
  }
  await applyBuiltinExtensionPolicy({ appRoot, sourceRoot, stateFile });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv); }
  catch (error) { console.error(`[UBOVM] Builtin extension policy failed: ${error.message}`); process.exitCode = 1; }
}
