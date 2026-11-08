#!/usr/bin/env node
// Packaging-time source protection for the standalone installer/portable payload.
//
// The development tree stays readable so the app can be debugged from source;
// only a staged payload is transformed: docs/tests are removed, code is minified
// in place (same module graph, no bundling), then both code trees are packed into
// ASAR archives and encrypted with AES-256-GCM. The payload keeps only a small
// plaintext stub + loader that decrypts the archive into a versioned cache at
// startup, so the installed files themselves contain no readable source.
import { readdir, readFile, rm, stat, writeFile, access, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildAsar, encryptAsar } from './asar.mjs';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTECTED_MARKER = '.ubovm-protected.json';

function esbuildModule() {
  try { return require('esbuild'); } catch { /* Fall through to a clear build error. */ }
  try { return require(path.join(PROJECT_ROOT, 'node_modules', 'esbuild')); } catch { /* Same. */ }
  throw new Error('esbuild is required to protect the packaged sources; run npm install.');
}

const MINIFY = { minify: true, legalComments: 'none', charset: 'utf8', sourcemap: false, logLevel: 'silent' };

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function walk(root, accept) {
  const output = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && accept(target)) output.push(target);
    }
  }
  await visit(root);
  return output;
}

async function walkDirectories(root) {
  const output = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      output.push(target);
      await visit(target);
    }
  }
  await visit(root);
  return output;
}

const DOC = /\.(?:md|markdown|d\.mts|d\.cts)$/i;
const MAP = /\.map$/i;
// Test sources describe internals as precisely as the implementation itself.
const TEST_FILE = /\.(?:test|spec)\.(?:mjs|cjs|js)$/i;
const TEST_DIRECTORY = /^(?:tests?|__tests__)$/i;

// Files that must not reach a customer: docs, type declarations, tests, source
// maps and build stamps. Bundled agent skills are runtime data (SKILL.md) and
// stay; third-party notices stay for licence compliance.
const REMOVE_FILES = [
  'extensions/ubovm-core/README.md',
  'extensions/ubovm-core/host/plugins/ubovm-plugin-api.d.ts',
  'ubovm/harness/README.md',
  'ubovm/harness/index.d.mts',
  'ubovm/.harness-source.json',
  'ubovm/package-lock.json'
];
const REMOVE_DIRECTORIES = [
  'extensions/ubovm-core/test',
  'extensions/ubovm-core/workbench',
  'ubovm/harness/test'
];// Agent skills are loaded from disk at runtime; every other markdown file in
// the harness is internal documentation. Vendor/themes notices are licence
// material and must ship with their assets.
const KEEP_MARKDOWN = [/[\\/]agents[\\/]skills[\\/]/i, /[\\/]vendor[\\/]/i, /[\\/]themes[\\/]/i];

function minifyTargets(appRoot) {
  return [
    { directory: path.join(appRoot, 'ubovm', 'main'), target: 'node20' },
    { directory: path.join(appRoot, 'ubovm', 'harness'), target: 'node20' },
    { directory: path.join(appRoot, 'extensions', 'ubovm-core', 'host'), target: 'node20' },
    { directory: path.join(appRoot, 'extensions', 'ubovm-core', 'harness'), target: 'node20' },
    // Browser scripts: no module wrapper, they run in the webview global scope.
    { directory: path.join(appRoot, 'extensions', 'ubovm-core', 'webview'), target: 'es2022' },
    { directory: path.join(appRoot, 'extensions', 'ubovm-core', 'webview'), loader: 'css', target: 'es2022' }
  ];
}

// Keep each file's own module kind: converting a .cjs worker/runtime module to
// ESM would break dynamic require and node --check.
function formatFor(file) {
  return file.endsWith('.mjs') ? 'esm' : file.endsWith('.cjs') ? 'cjs' : undefined;
}

function wanted(file, loader) {
  if (file.includes(`${path.sep}vendor${path.sep}`)) return false;
  return loader === 'js' ? file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs') : file.endsWith('.css');
}

const ARCHIVE_MAIN = 'ubovm/ubovm.pak';
const ARCHIVE_CORE = 'extensions/ubovm-core/core.pak';
const LOADER_MAIN_STUB = 'ubovm/main/index.mjs';
const LOADER_CORE_STUB = 'extensions/ubovm-core/extension.cjs';
const LOADER_RUNTIME = 'protected/runtime.cjs';
// Reserved files stay readable on disk because Code OSS scans them before any
// extension code runs (contributes, localization, theme/media assets).
const CORE_RESERVED = [/^package\.json$/i, /^package\.nls\.[^/]+\.json$/i, /^l10n\//i, /^themes\//i, /^core\.pak$/i, /^protected\//i];

function mainStubSource() {
  return `import { createRequire } from 'node:module';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { materialize } = require('../protected/runtime.cjs');
const appUbovm = path.join(import.meta.dirname, '..');
const root = materialize(path.join(appUbovm, 'ubovm.pak'), 'main');
// The decrypted harness is outside the app tree; expose the production
// node_modules folder next to it so bare ESM/CJS imports resolve normally.
try {
  const link = path.join(root, 'node_modules');
  if (!existsSync(link)) symlinkSync(path.join(appUbovm, 'node_modules'), link, 'junction');
} catch (error) { console.warn('[UBOVM] Protected harness dependency link failed:', error?.message || error); }
process.env.UBOVM_HARNESS_ENTRY = path.join(root, 'ubovm', 'harness', 'index.mjs');
await import(pathToFileURL(path.join(root, 'ubovm', 'main', 'index.mjs')).href);
`;
}

function extensionStubSource() {
  return `'use strict';
const path = require('node:path');
const { materialize } = require('./protected/runtime.cjs');
let implementation;
exports.activate = async context => {
  const root = materialize(path.join(__dirname, 'core.pak'), 'core', path.join(__dirname, '.protected'));
  implementation = require(path.join(root, 'extension.cjs'));
  return implementation.activate(context);
};
exports.deactivate = async () => implementation && implementation.deactivate ? implementation.deactivate() : undefined;
`;
}

async function loaderSource(esbuild, key) {
  const template = await readFile(path.join(PROJECT_ROOT, 'build', 'protected-runtime.cjs'), 'utf8');
  const replaced = template.replace('__UBOVM_ASAR_KEY__', key.toString('hex'));
  return (await esbuild.transform(replaced, { loader: 'js', format: 'cjs', target: 'node20', ...MINIFY })).code;
}

function relativeName(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// Pack one component into an authenticated, encrypted ASAR archive and replace
// its readable tree with a tiny plaintext loader/stub pair.
async function packComponent({ appRoot, archiveRelative, files, removePaths, stubs, key, loaderText, dryRun, report }) {
  const entries = new Map();
  for (const [file, name] of files) entries.set(name, await readFile(file));
  const asar = buildAsar(entries);
  const container = encryptAsar(asar, key);
  const archivePath = path.join(appRoot, archiveRelative);
  if (!dryRun) {
    await rm(archivePath, { force: true });
    await writeFile(archivePath, container);
    for (const relative of removePaths) await rm(path.join(appRoot, relative), { recursive: true, force: true });
    for (const [relative, content] of stubs) {
      const target = path.join(appRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { force: true });
      await writeFile(target, content);
    }
  }
  report.archives.push({ archive: archiveRelative, entries: entries.size, asarBytes: asar.length, bytes: container.length });
}

async function packProtectedPayload(appRoot, { dryRun, key, loaderText, report }) {
  const ubovmRoot = path.join(appRoot, 'ubovm');
  const coreRoot = path.join(appRoot, 'extensions', 'ubovm-core');
  const pack = async (archiveRelative, files, removePaths, stubs) =>
    packComponent({ appRoot, archiveRelative, files, removePaths, stubs, key, loaderText, dryRun, report });

  const mainFiles = [];
  for (const directory of ['main', 'harness']) {
    const root = path.join(ubovmRoot, directory);
    if (!(await exists(root))) continue;
    for (const file of await walk(root, () => true)) mainFiles.push([file, 'ubovm/' + directory + '/' + relativeName(root, file)]);
  }
  const appJson = path.join(ubovmRoot, 'app.json');
  if (await exists(appJson)) mainFiles.push([appJson, 'ubovm/app.json']);
  // The Electron main resolves its window/tray icon from the app-root media
  // folder; keep those buffers inside the encrypted main archive as well.
  for (const directory of ['media']) {
    const root = path.join(coreRoot, directory);
    if (!(await exists(root))) continue;
    for (const file of await walk(root, () => true)) mainFiles.push([file, 'extensions/ubovm-core/' + directory + '/' + relativeName(root, file)]);
  }
  await pack(ARCHIVE_MAIN, mainFiles, ['ubovm/main', 'ubovm/harness'], [
    [LOADER_MAIN_STUB, mainStubSource()],
    ['ubovm/protected/runtime.cjs', loaderText]
  ]);

  if (await exists(coreRoot)) {
    const coreFiles = [];
    for (const file of await walk(coreRoot, () => true)) {
      const relative = relativeName(coreRoot, file);
      if (CORE_RESERVED.some(pattern => pattern.test(relative))) continue;
      coreFiles.push([file, relative]);
    }
    await pack(ARCHIVE_CORE, coreFiles, [
      'extensions/ubovm-core/host',
      'extensions/ubovm-core/harness',
      'extensions/ubovm-core/webview',
      'extensions/ubovm-core/extension.cjs'
    ], [
      [LOADER_CORE_STUB, extensionStubSource()],
      [path.join('extensions', 'ubovm-core', LOADER_RUNTIME), loaderText]
    ]);
  }
}

async function protectPayload(payload, { appDirectory = 'resources/app', dryRun = false, logger = console } = {}) {
  const appRoot = path.join(payload, appDirectory);
  if (!(await exists(appRoot))) throw new Error(`Packaged application root not found: ${appRoot}`);
  if (!(await exists(path.join(appRoot, 'package.json')))) throw new Error(`Not an application root (missing package.json): ${appRoot}`);
  const esbuild = esbuildModule();
  const report = { appRoot, removed: [], minified: [], archives: [], alreadyProtected: false, bytesBefore: 0, bytesAfter: 0 };
  const markerPath = path.join(appRoot, PROTECTED_MARKER);
  if (await exists(markerPath)) {
    report.alreadyProtected = true;
    if (logger?.log) logger.log('[UBOVM] Packaged payload is already protected; skipping.');
    return report;
  }

  const remove = async relative => {
    const target = path.join(appRoot, relative);
    if (!(await exists(target))) return;
    if (!dryRun) await rm(target, { recursive: true, force: true });
    report.removed.push(relative);
  };
  for (const relative of REMOVE_FILES) await remove(relative);
  for (const relative of REMOVE_DIRECTORIES) await remove(relative);

  // Documentation, source maps and declaration files that sit next to code.
  const docRoots = [
    path.join(appRoot, 'ubovm', 'main'),
    path.join(appRoot, 'ubovm', 'harness'),
    path.join(appRoot, 'extensions', 'ubovm-core')
  ];
  for (const root of docRoots) {
    for (const file of await walk(root, target => DOC.test(target) || MAP.test(target))) {
      const relative = path.relative(appRoot, file);
      if (KEEP_MARKDOWN.some(pattern => pattern.test(file))) continue;
      if (/[\\/]themes[\\/](?:NOTICE\.md|LICENSE-vscode\.txt)$/i.test(file)) continue;
      await remove(relative);
    }
  }

  for (const root of docRoots) {
    for (const directory of await walkDirectories(root)) {
      if (!TEST_DIRECTORY.test(path.basename(directory))) continue;
      if (directory.includes(`${path.sep}vendor${path.sep}`)) continue;
      await remove(path.relative(appRoot, directory));
    }
    for (const file of await walk(root, target => TEST_FILE.test(target))) {
      if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
      await remove(path.relative(appRoot, file));
    }
  }

  // Minify in place: import/require specifiers, worker paths, __dirname reads
  // and dynamically imported module files all keep their original locations.
  for (const entry of minifyTargets(appRoot)) {
    if (!(await exists(entry.directory))) continue;
    const loader = entry.loader || 'js';
    for (const file of await walk(entry.directory, target => wanted(target, loader))) {
      const code = await readFile(file, 'utf8');
      let transformed;
      try {
        transformed = await esbuild.transform(code, {
          loader, format: loader === 'css' ? undefined : formatFor(file), target: entry.target, ...MINIFY
        });
      } catch (error) {
        throw new Error(`Unable to protect ${path.relative(appRoot, file)}: ${error.message}`);
      }
      report.bytesBefore += Buffer.byteLength(code);
      report.bytesAfter += Buffer.byteLength(transformed.code);
      if (dryRun) { report.minified.push(path.relative(appRoot, file)); continue; }
      await writeFile(file, transformed.code, 'utf8');
      report.minified.push(path.relative(appRoot, file));
    }
  }
  // The extension entry point is not inside host/ or harness/.
  const entry = path.join(appRoot, 'extensions', 'ubovm-core', 'extension.cjs');
  if (await exists(entry)) {
    const code = await readFile(entry, 'utf8');
    const transformed = await esbuild.transform(code, { loader: 'js', format: 'cjs', target: 'node20', ...MINIFY });
    report.bytesBefore += Buffer.byteLength(code);
    report.bytesAfter += Buffer.byteLength(transformed.code);
    if (!dryRun) await writeFile(entry, transformed.code, 'utf8');
    report.minified.push(path.relative(appRoot, entry));
  }

  // Bundle the protected trees into authenticated, encrypted ASAR archives and
  // leave only a tiny loader + stub in plaintext. The archive is decrypted into
  // a per-build cache directory by the loader at runtime.
  const key = randomBytes(32);
  const loaderText = await loaderSource(esbuild, key);
  await packProtectedPayload(appRoot, { dryRun, key, loaderText, report });
  if (!dryRun) {
    await writeFile(markerPath, JSON.stringify({
      format: 'asar-aes-256-gcm',
      keyFingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
      archives: report.archives.map(entry => entry.archive)
    }, null, 2) + '\n', 'utf8');
  }

  if (!dryRun && logger?.log) {
    const saved = report.bytesBefore - report.bytesAfter;
    logger.log(`[UBOVM] Protected packaged sources: ${report.minified.length} minified, ${report.removed.length} removed, ${(saved / 1024).toFixed(0)} KiB smaller JS, ${report.archives.length} encrypted ASAR archive(s).`);
  }
  return report;
}

// A protected payload must not contain any readable development material.
async function verifyPayload(payload, { appDirectory = 'resources/app' } = {}) {
  const appRoot = path.join(payload, appDirectory);
  const violations = [];
  const ubovmRoot = path.join(appRoot, 'ubovm');
  const coreRoot = path.join(appRoot, 'extensions', 'ubovm-core');
  for (const relative of REMOVE_FILES) {
    if (await exists(path.join(appRoot, relative))) violations.push(relative);
  }
  // Both code trees must be reduced to an encrypted archive + plaintext stub.
  for (const archive of [ARCHIVE_MAIN, ARCHIVE_CORE]) {
    if (!(await exists(path.join(appRoot, archive)))) violations.push('missing encrypted archive: ' + archive);
  }
  if (!(await exists(path.join(appRoot, PROTECTED_MARKER)))) violations.push('missing protection marker: ' + PROTECTED_MARKER);
  if (await exists(path.join(ubovmRoot, 'main'))) {
    for (const file of await walk(path.join(ubovmRoot, 'main'), () => true)) {
      const relative = relativeName(appRoot, file);
      if (relative !== LOADER_MAIN_STUB) violations.push(relative);
    }
    const stub = await readFile(path.join(appRoot, LOADER_MAIN_STUB), 'utf8').catch(() => '');
    if (!stub.includes('materialize')) violations.push('readable main entry: ' + LOADER_MAIN_STUB);
  }
  if (await exists(path.join(ubovmRoot, 'harness'))) violations.push('readable harness tree: ubovm/harness');
  const coreStub = path.join(coreRoot, 'extension.cjs');
  if (await exists(coreStub)) {
    const stub = await readFile(coreStub, 'utf8');
    if (!stub.includes('materialize') || stub.length > 4000) violations.push('readable extension entry: extensions/ubovm-core/extension.cjs');
  }
  for (const directory of ['host', 'harness', 'webview']) {
    if (await exists(path.join(coreRoot, directory))) violations.push('readable extension tree: extensions/ubovm-core/' + directory);
  }
  // Stray documentation/test files directly under ubovm/ are caught here too.
  let ubovmEntries = [];
  try { ubovmEntries = await readdir(ubovmRoot, { withFileTypes: true }); } catch { /* Missing ubovm tree is reported above. */ }
  for (const entry of ubovmEntries) {
    if (!entry.isFile()) continue;
    if (DOC.test(entry.name) || MAP.test(entry.name) || TEST_FILE.test(entry.name)) violations.push('ubovm/' + entry.name);
  }  const roots = [path.join(ubovmRoot, 'main'), path.join(ubovmRoot, 'harness'), coreRoot];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for (const directory of await walkDirectories(root)) {
      const relative = path.relative(appRoot, directory);
      if (TEST_DIRECTORY.test(path.basename(directory)) && !relative.includes(`${path.sep}vendor${path.sep}`)) violations.push(relative + path.sep);
    }
    for (const file of await walk(root, target => DOC.test(target) || MAP.test(target) || TEST_FILE.test(target))) {
      const relative = relativeName(appRoot, file);
      if (KEEP_MARKDOWN.some(pattern => pattern.test(file))) continue;
      violations.push(relative);
    }
  }
  return violations;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const payload = args.find(argument => !argument.startsWith('--'));
  if (!payload) {
    console.error('Usage: node build/protect.mjs <payload> [--app=<appDirectory>] [--dry-run] [--verify] [--report=<file>]');
    process.exit(2);
  }
  const option = name => {
    const match = args.find(argument => argument.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : undefined;
  };
  const appDirectory = option('app') || 'resources/app';
  const reportFile = option('report');
  if (args.includes('--verify')) {
    verifyPayload(path.resolve(payload), { appDirectory }).then(violations => {
      if (!violations.length) return;
      for (const violation of violations) console.error('[UBOVM] Unprotected source in payload: ' + violation);
      process.exitCode = 1;
    }).catch(error => {
      console.error('[UBOVM] Source protection verification failed: ' + error.message);
      process.exitCode = 1;
    });
  } else {
    protectPayload(path.resolve(payload), { appDirectory, dryRun: args.includes('--dry-run') }).then(report => {
      if (reportFile) return writeFile(path.resolve(reportFile), JSON.stringify(report, null, 2) + '\n', 'utf8');
    }).catch(error => {
      console.error('[UBOVM] Source protection failed: ' + error.message);
      process.exit(1);
    });
  }
}

export { protectPayload, verifyPayload };
