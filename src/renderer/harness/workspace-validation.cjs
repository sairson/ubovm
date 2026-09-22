'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const fingerprint = item => createHash('sha256').update(JSON.stringify([item.path, item.source, item.code, item.severity, item.message])).digest('hex');

function createWorkspaceValidation(vscode, context, { changes = async () => [], compiler, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [] } = {}) {
  let revision = 0, baselineQueue = Promise.resolve();
  const lifetime = new AbortController();
  const observers = new Set();
  const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const active = new Set();
  const key = 'ubovm.validationBaselines.v1';
  let baselines = context.workspaceState.get(key, {});
  const listener = vscode.languages?.onDidChangeDiagnostics?.(event => {
    revision++;
    for (const observer of observers) if (!event?.uris || event.uris.some(uri => uri.scheme === 'file' && observer.files.has(pathKey(uri.fsPath)))) observer.updatedAt = Date.now();
  });
  const diagnostics = (file, relative) => (vscode.languages?.getDiagnostics(vscode.Uri.file(file)) ?? []).map(item => ({ path: relative,
    line: item.range.start.line + 1, column: item.range.start.character + 1, endLine: item.range.end.line + 1, endColumn: item.range.end.character + 1,
    severity: ['error', 'warning', 'information', 'hint'][item.severity] ?? 'information', source: item.source ?? 'editor',
    code: typeof item.code === 'object' ? item.code.value : item.code, message: item.message.slice(0, 3000) }));
  async function targets(input, sessionId) {
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const requested = input.paths?.map(file => ({ root: input.root ?? 0, path: file })) ?? (await changes(sessionId)).map(item => ({ root: item.root, path: item.path }));
    if (!Array.isArray(requested) || requested.length > 30) throw new Error('一次最多验证 30 个文件，请用 paths 指定范围。');
    const found = [], seen = new Set(), roots = new Map();
    for (const request of requested) {
      if (!Number.isInteger(request.root) || request.root < 0 || !folders[request.root] || typeof request.path !== 'string' || !request.path || /[\0:]/.test(request.path) || path.isAbsolute(request.path)) throw new Error('验证文件路径或工作区索引无效。');
      if (!roots.has(request.root)) roots.set(request.root, await fs.realpath(folders[request.root].uri.fsPath));
      const root = roots.get(request.root), file = path.resolve(root, request.path);
      if (!inside(root, file)) throw new Error('验证文件超出工作区。');
      let canonical;
      try { canonical = await fs.realpath(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (canonical && !inside(root, canonical)) throw new Error('验证文件链接超出工作区。');
      const identity = pathKey(canonical ?? file);
      if (seen.has(identity)) continue; seen.add(identity);
      found.push({ root, rootIndex: request.root, file: canonical ?? file, relative: path.relative(root, canonical ?? file), missing: !canonical });
    }
    return found;
  }
  async function capture(sessionId, file, { reset = false } = {}) {
    const operation = baselineQueue.then(async () => {
      lifetime.signal.throwIfAborted();
      const id = createHash('sha256').update(sessionId + '\0' + file).digest('hex');
      if (baselines[id] && !reset) return;
      const items = diagnostics(file, file).slice(0, 200).map(fingerprint);
      const next = { ...baselines, [id]: { sessionId, file, items, capturedAt: Date.now() } };
      const entries = Object.entries(next).sort((a, b) => b[1].capturedAt - a[1].capturedAt).slice(0, 300);
      while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024) entries.pop();
      const bounded = Object.fromEntries(entries);
      await context.workspaceState.update(key, bounded); baselines = bounded;
    });
    baselineQueue = operation.catch(() => {}); return operation;
  }
  async function waitForDiagnostics(files, signal) {
    const started = Date.now(), observer = { files: new Set(files.map(target => pathKey(target.file))), updatedAt: started };
    observers.add(observer);
    const documents = new Map(), existing = new Map(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file').map(doc => [pathKey(doc.uri.fsPath), doc]));
    try {
      for (const target of files) {
        if (target.missing) continue;
        signal?.throwIfAborted();
        const info = await fs.stat(target.file);
        if (info.isFile() && info.size <= 1024 * 1024) documents.set(target.file, existing.get(pathKey(target.file)) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(target.file)));
      }
      // Unrelated diagnostics cannot extend this request's settling window.
      // There is still no language-provider completion barrier in the API.
      const openedAt = Date.now();
      while (documents.size && Date.now() - openedAt < 4000) {
        signal?.throwIfAborted();
        if (Date.now() - openedAt >= 1200 && Date.now() - observer.updatedAt >= 500) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { documents, observation: { observedRevision: revision, waitedMs: Date.now() - started, completeness: 'provider completion is not guaranteed' } };
    } finally { observers.delete(observer); }
  }
  async function compile(root, files, signal, timeout = 30000) {
    const entry = compiler ?? path.join(vscode.env.appRoot, 'extensions/node_modules/typescript/lib/typescript.js');
    try { await fs.access(entry); } catch { return { checks: [], diagnostics: [], error: '运行时没有内置 TypeScript 编译器，未执行编译检查。' }; }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'validation-worker.cjs'), { workerData: { compiler: entry, root, files }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      active.add(worker);
      let finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); active.delete(worker); void worker.terminate();
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(signal.reason ?? new Error('验证已取消'));
      const timer = setTimeout(() => finish(undefined, { error: '编译检查达到时间上限，未完成。', checks: [], diagnostics: [] }), timeout);
      worker.once('message', value => finish(undefined, value)); worker.once('error', error => finish(undefined, { error: error.message, checks: [], diagnostics: [] }));
      worker.once('exit', code => { if (!finished) finish(undefined, { error: `验证进程提前结束：${code}`, checks: [], diagnostics: [] }); });
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    });
  }
  async function inspect(sessionId, input, signal, validate) {
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区再验证代码。');
    const files = await targets(input, sessionId);
    if (!files.length) return output({ status: 'not_run', reason: '当前没有修改记录，请用 paths 指定文件。', files: [], tests: 'not_run', build: 'not_run' });
    const { observation, documents } = await waitForDiagnostics(files, signal);
    const reports = [], groups = new Map();
    for (const target of files) {
      signal?.throwIfAborted();
      if (target.missing) { reports.push({ root: target.rootIndex, path: target.relative, status: 'missing_or_deleted', diagnostics: [] }); continue; }
      const items = diagnostics(target.file, target.relative);
      const id = createHash('sha256').update(sessionId + '\0' + target.file).digest('hex'), baseline = baselines[id];
      const prior = [...baseline?.items ?? []];
      const introduced = items.filter(item => { const key = fingerprint({ ...item, path: target.file }), index = prior.indexOf(key); if (index < 0) return true; prior.splice(index, 1); return false; });
      reports.push({ root: target.rootIndex, path: target.relative, diagnostics: items.slice(0, 200), diagnosticCount: items.length, errorCount: items.filter(item => item.severity === 'error').length,
        baselineAvailable: Boolean(baseline), ...(baseline ? { newDiagnostics: introduced.slice(0, 100), newDiagnosticCount: introduced.length, resolvedCount: prior.length } : {}) });
      if (validate) {
        const stat = await fs.stat(target.file);
        if (!stat.isFile() || stat.size > 1024 * 1024) { reports.at(-1).compiler = 'not_run_file_too_large'; continue; }
        const document = documents.get(target.file) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
        const content = document.getText();
        if (content.length > 1024 * 1024) { reports.at(-1).compiler = 'not_run_buffer_too_large'; continue; }
        reports.at(-1).documentVersion = document.version; reports.at(-1).unsaved = document.isDirty;
        if (!groups.has(target.root)) groups.set(target.root, []);
        const diskHash = createHash('sha256').update(await fs.readFile(target.file)).digest('hex');
        groups.get(target.root).push({ path: target.file, content, version: document.version, diskHash });
      }
    }
    const compilerResults = [], deadline = Date.now() + 30000;
    if (validate) for (const [root, entries] of groups) {
      const result = Date.now() >= deadline ? { error: '本次验证的 30 秒预算已用完。', checks: [], diagnostics: [] } : await compile(root, entries, signal, deadline - Date.now());
      const changed = (await Promise.all(entries.map(async entry => {
        const diskHash = await fs.readFile(entry.path).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
        return diskHash !== entry.diskHash || vscode.workspace.textDocuments.find(doc => doc.uri.fsPath.toLowerCase() === entry.path.toLowerCase())?.version !== entry.version;
      }))).filter(Boolean);
      compilerResults.push({ root: files.find(file => file.root === root).rootIndex, ...result, stale: changed.length > 0 });
    }
    signal.throwIfAborted();
    const hasErrors = reports.some(report => report.errorCount > 0) || compilerResults.some(result => result.errorCount > 0 || result.diagnostics?.some(item => item.severity === 'error'));
    const incomplete = !validate || reports.some(report => report.compiler || report.status) || compilerResults.some(result => result.error || result.stale || result.unavailableFiles?.length || result.truncated || result.checks?.some(check => !['passed', 'failed'].includes(check.status))) || !compilerResults.length;
    let budget = 100, deltaBudget = 20, outputTruncated = false;
    for (const report of [...reports, ...compilerResults]) {
      const items = report.diagnostics ?? [];
      report.diagnostics = items.slice(0, budget).map(item => ({ ...item, message: item.message.slice(0, 1000) }));
      if ((report.diagnosticCount ?? items.length) > budget) outputTruncated = true;
      budget = Math.max(0, budget - report.diagnostics.length);
      if (report.newDiagnostics) {
        report.newDiagnosticCount ??= report.newDiagnostics.length;
        if (report.newDiagnosticCount > deltaBudget) outputTruncated = true;
        report.newDiagnostics = report.newDiagnostics.slice(0, deltaBudget).map(item => ({ ...item, message: item.message.slice(0, 1000) }));
        deltaBudget -= report.newDiagnostics.length;
      }
    }
    return output({ status: hasErrors ? 'issues_found' : incomplete || outputTruncated ? 'incomplete' : 'selected_checks_passed', observation, files: reports, compilerResults, outputTruncated,
      tests: 'not_run', build: 'not_run', lint: 'only diagnostics published by installed language/lint extensions',
      note: '检查只覆盖指定文件；未运行项目命令、测试或构建。没有编辑器诊断不代表所有语言服务均已完成。' });
  }
  const parameters = { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, paths: { type: 'array', maxItems: 30, items: { type: 'string' } } }, additionalProperties: false };
  async function reviewOnce(sessionId, signal) {
    const report = (await inspect(sessionId, {}, signal, true)).details;
    if (report.status === 'not_run') { await vscode.window.showInformationMessage(report.reason); return report; }
    const labels = { issues_found: '发现问题', incomplete: '检查未完整完成', selected_checks_passed: '所选文件检查通过' };
    const issues = [...report.files.flatMap(file => file.diagnostics.map(item => ({ ...item, root: file.root }))),
      ...report.compilerResults.flatMap(group => (group.diagnostics ?? []).map(item => ({ ...item, root: group.root })))];
    const items = issues.map(item => ({ label: `${item.severity === 'error' ? '$(error)' : '$(warning)'} ${item.message.replace(/\s+/g, ' ')}`,
      description: `${item.path || '配置'}${item.line ? ':' + item.line : ''} · ${item.source}`, item }));
    for (const group of report.compilerResults) {
      if (group.error || group.stale) items.push({ label: '$(info) ' + (group.error || '验证期间文件发生变化，请重新验证。') });
      for (const check of group.checks ?? []) if (!['passed', 'failed'].includes(check.status)) items.push({ label: `$(info) ${check.path}：未完成 ${check.check} 检查` });
    }
    if (!items.length) items.push({ label: labels[report.status], description: '仅文件级检查；没有执行测试或项目构建。' });
    const selected = await vscode.window.showQuickPick(items, { title: `代码验证 · ${labels[report.status]}`, placeHolder: '选择问题定位代码；未运行项目测试/构建，编辑器诊断可能仍在更新' });
    if (selected?.item?.path) {
      const item = selected.item;
      const [target] = await targets({ root: item.root, paths: [item.path] }, sessionId);
      if (!target.missing) await vscode.window.showTextDocument(vscode.Uri.file(target.file), { viewColumn: vscode.ViewColumn.Two, preview: false,
        selection: new vscode.Range(Math.max(0, (item.line ?? 1) - 1), Math.max(0, (item.column ?? 1) - 1), Math.max(0, (item.line ?? 1) - 1), Math.max(0, (item.column ?? 1) - 1)) });
    }
    return report;
  }
  const reviews = new Map();
  function review(sessionId) {
    if (reviews.has(sessionId)) return reviews.get(sessionId);
    const controller = new AbortController();
    const run = () => reviewOnce(sessionId, controller.signal);
    const operation = (vscode.window.withProgress ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在验证代码修改', cancellable: true }, async (_progress, token) => {
      const listener = token.onCancellationRequested(() => controller.abort(new Error('验证已取消。')));
      try { return await run(); } finally { listener.dispose(); }
    }) : run()).finally(() => reviews.delete(sessionId));
    reviews.set(sessionId, operation); return operation;
  }
  function remove(sessionId) {
    const next = baselineQueue.then(async () => {
      const retained = Object.fromEntries(Object.entries(baselines).filter(([, value]) => value.sessionId !== sessionId));
      await context.workspaceState.update(key, retained); baselines = retained;
    }); baselineQueue = next.catch(() => {}); return next;
  }
  return { capture, review, remove, tools: sessionId => [
    { name: 'get_workspace_diagnostics', label: '读取代码诊断', description: 'Open selected workspace files, wait briefly for language/lint diagnostics and return actual errors/warnings and differences from the pre-edit baseline. Defaults to this conversation’s changed files. Empty diagnostics do not prove checks completed.', parameters, execute: (_id, input, signal) => inspect(sessionId, input, signal, false) },
    { name: 'validate_workspace_changes', label: '验证代码修改', description: 'Validate changed files (or explicit paths) with editor diagnostics plus isolated no-emit TypeScript/JavaScript type/syntax checks and JSON syntax checks. Reads nearest tsconfig/jsconfig, validates selected files and imported types, never executes project scripts. Check incomplete/stale/error flags. Build and tests are explicitly not run. Call after edits, fix reported issues and repeat.', parameters, execute: (_id, input, signal) => inspect(sessionId, input, signal, true) }
  ], dispose() { lifetime.abort(new Error('代码验证服务已关闭。')); listener?.dispose(); observers.clear(); for (const worker of active) void worker.terminate(); active.clear(); } };
}
module.exports = { createWorkspaceValidation };
