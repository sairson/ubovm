'use strict';
// Compiler checks run in a bounded worker. Workspace code and package scripts are never executed.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
try {
  const ts = require(workerData.compiler);
  const root = workerData.root, library = fs.realpathSync(path.dirname(workerData.compiler));
  const overlays = new Map(workerData.files.map(file => [path.resolve(file.path).toLowerCase(), file.content]));
  const unavailable = new Set();
  const allowed = file => {
    try { const canonical = fs.realpathSync(file); return inside(root, canonical) || inside(library, canonical); } catch { return false; }
  };
  const readFile = file => {
    if (!allowed(file)) return undefined;
    const overlay = overlays.get(path.resolve(file).toLowerCase());
    if (overlay !== undefined) return overlay;
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) { unavailable.add(file); return undefined; }
      return fs.readFileSync(file, 'utf8');
    } catch { return undefined; }
  };
  const sys = { ...ts.sys, readFile, fileExists: file => allowed(file) && ts.sys.fileExists(file), directoryExists: file => allowed(file) && ts.sys.directoryExists(file),
    // Only validate explicitly selected files and their imports, not an unbounded project scan.
    readDirectory: () => [], getCurrentDirectory: () => root };
  const diagnostics = [], checks = [];
  const format = diagnostic => {
    const start = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    return { path: diagnostic.file?.fileName ? path.relative(root, diagnostic.file.fileName) : null, line: start ? start.line + 1 : null, column: start ? start.character + 1 : null,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning', source: 'typescript', code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, 3000) };
  };
  const groups = new Map();
  for (const file of workerData.files) {
    if (/\.json$/i.test(file.path)) {
      try {
        if (/^[tj]sconfig(?:\.[^.]+)*\.json$/i.test(path.basename(file.path))) {
          const parsed = ts.parseConfigFileTextToJson(file.path, file.content);
          if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
        } else JSON.parse(file.content.replace(/^\uFEFF/, ''));
        checks.push({ path: path.relative(root, file.path), check: 'json-syntax', status: 'passed' }); }
      catch (error) { diagnostics.push({ path: path.relative(root, file.path), severity: 'error', source: 'json', message: error.message }); checks.push({ path: path.relative(root, file.path), check: 'json-syntax', status: 'failed' }); }
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/i.test(file.path)) { checks.push({ path: path.relative(root, file.path), check: 'compiler', status: 'not_supported' }); continue; }
    let directory = path.dirname(file.path), config;
    while (inside(root, directory)) {
      config = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(directory, name)).find(file => sys.fileExists(file));
      if (config || directory === root) break;
      directory = path.dirname(directory);
    }
    const key = config ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file.path);
  }
  for (const [config, files] of groups) {
    let options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve, allowJs: true, checkJs: true, skipLibCheck: true };
    if (config) {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...sys, onUnRecoverableConfigFileDiagnostic: diagnostic => diagnostics.push(format(diagnostic)) });
      if (!parsed) { for (const file of files) checks.push({ path: path.relative(root, file), check: 'typescript', status: 'unavailable' }); continue; }
      options = parsed.options;
      diagnostics.push(...parsed.errors.filter(error => error.code !== 18003).map(format));
    }
    options = { ...options, noEmit: true, incremental: false, composite: false, allowJs: true };
    delete options.tsBuildInfoFile;
    const host = ts.createCompilerHost(options);
    Object.assign(host, { readFile, fileExists: sys.fileExists, directoryExists: sys.directoryExists, getCurrentDirectory: () => root, writeFile() { throw new Error('Validation must not emit files'); } });
    const program = ts.createProgram(files, options, host);
    const collected = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    for (const file of files) {
      const source = program.getSourceFile(file);
      if (!source) { checks.push({ path: path.relative(root, file), check: 'typescript', status: 'unavailable' }); continue; }
      const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
      collected.push(...errors);
      checks.push({ path: path.relative(root, file), check: 'typescript', config: config ? path.relative(root, config) : null,
        status: errors.some(error => error.category === ts.DiagnosticCategory.Error) ? 'failed' : 'passed',
        scope: 'selected file and imported type information; project references/build/tests are not run' });
    }
    diagnostics.push(...collected.map(format));
  }
  parentPort.postMessage({ diagnostics: diagnostics.slice(0, 200), diagnosticCount: diagnostics.length, errorCount: diagnostics.filter(item => item.severity === 'error').length, truncated: diagnostics.length > 200,
    checks, unavailableFiles: [...unavailable].map(file => path.relative(root, file)), compilerVersion: ts.version });
} catch (error) { parentPort.postMessage({ error: error.message }); }
