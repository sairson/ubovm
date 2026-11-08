'use strict';

const path = require('node:path');
const { readFile, mkdir, writeFile, access, unlink, readdir, rename, cp, rm, open, stat } = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { homedir, tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readArchive } = require('../../harness/config/archive.cjs');
const runFile = promisify(execFile);

/**
 * Extension binaries inherit their file integrity label. When the extensions
 * directory lives under a low-integrity user-data root, a bundled CLI such as
 * Kilo's `kilo.exe` starts at Low IL and every write to the user profile fails
 * with EPERM. Relabel only executable files back to Medium; keep source/data
 * files untouched. Best-effort and bounded so a large extension tree never
 * delays the extension host.
 */
async function repairExecutableIntegrity(root) {
  if (process.platform !== 'win32' || !root) return 0;
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  // Only lower-to-medium is needed for a low-integrity user-data root. Do not
  // downgrade executables that are already at a normal or elevated label.
  try {
    const probe = await runFile(icacls, [root], { windowsHide: true, timeout: 10000 });
    if (!/Low Mandatory Level/i.test(String(probe.stdout || '') + String(probe.stderr || ''))) return 0;
  } catch { return 0; }
  let visited = 0, changed = 0;
  async function walk(directory, depth) {
    if (depth > 4 || visited > 1200 || changed >= 48) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (visited++ > 1200 || changed >= 48) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        await walk(target, depth + 1);
      } else if (entry.isFile() && /\.(?:exe|com)$/i.test(entry.name)) {
        try {
          await runFile(icacls, [target, '/setintegritylevel', 'Medium', '/C', '/Q'], { windowsHide: true, timeout: 10000 });
          changed++;
        } catch { /* A user without relabel rights keeps the original label. */ }
      }
    }
  }
  await walk(root, 0);
  return changed;
}

/**
 * Minimal plugin (VS Code extension) manager for a build without a marketplace.
 *
 * - installs a local `.vsix` through the workbench install command;
 * - lists installed extensions in a self-contained manager panel (the workbench
 *   extensions view is not guaranteed to exist after marketplace removal);
 * - never installs from a remote gallery.
 */
function createPluginManager({ vscode, context, registry, log = () => {} } = {}) {
  if (!vscode?.commands || !vscode?.window) throw new TypeError('plugin manager requires vscode');
  let managerPanel;
  let marketplacePanel;
  let managerRefreshTimer;
  let managerFingerprint = '';
  let managerView = { scrollTop: 0, filter: '' };
  let extensionRowsCache;
  let extensionRowsAt = 0;
  let marketplaceSearchRevision = 0;

  function extensionsDirectory() {
    const fromEnvironment = process.env.VSCODE_EXTENSIONS;
    if (fromEnvironment) return fromEnvironment;
    const extensionPath = context?.extensionPath || '';
    const parent = path.dirname(extensionPath);
    // Production installs ubovm-core inside the extensions directory; a
    // development launch points at src/renderer instead.
    if (path.basename(extensionPath) === 'ubovm-core' && parent && parent !== extensionPath) return parent;
    return path.join(vscode.env.appRoot || '', 'extensions');
  }

  function isBuiltin(extension) {
    const root = String(vscode.env.appRoot || '');
    const target = String(extension?.extensionPath || '');
    if (!root || !target) return false;
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function userExtensionsDirectory() {
    const fromEnvironment = process.env.VSCODE_EXTENSIONS;
    if (fromEnvironment) return fromEnvironment;
    const extensionPath = context?.extensionPath || '';
    if (path.basename(extensionPath) === 'ubovm-core') return path.dirname(extensionPath);
    return path.join(homedir(), '.vscode', 'extensions');
  }

  function builtinExtensionsDirectory() {
    const extensionPath = context?.extensionPath || '';
    if (path.basename(extensionPath) === 'ubovm-core') return path.dirname(extensionPath);
    return path.join(vscode.env.appRoot || '', 'extensions');
  }

  async function moveExtensionFolder(source, target) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(source, target);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await cp(source, target, { recursive: true });
      await rm(source, { recursive: true, force: true });
    }
  }

  function extensionStateRoot() {
    return process.env.VSCODE_PORTABLE || path.dirname(userExtensionsDirectory());
  }

  function disabledExtensionsDirectory() {
    return path.join(extensionStateRoot(), 'disabled-extensions');
  }

  function disabledBuiltinExtensionsDirectory() {
    return path.join(extensionStateRoot(), 'disabled-builtin-extensions');
  }

  function extensionStateFile() {
    return path.join(extensionStateRoot(), 'extension-state.json');
  }

  function safeFolderNames(value) {
    return Array.isArray(value) ? [...new Set(value.filter(name => typeof name === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(name)))] : [];
  }

  async function readExtensionState() {
    try {
      const value = JSON.parse(await readFile(extensionStateFile(), 'utf8'));
      return { disabled: safeFolderNames(value?.disabled), disabledBuiltin: safeFolderNames(value?.disabledBuiltin) };
    } catch {
      return { disabled: [], disabledBuiltin: [] };
    }
  }

  async function writeExtensionState(state) {
    const file = extensionStateFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      disabled: safeFolderNames(state.disabled).slice(0, 2000),
      disabledBuiltin: safeFolderNames(state.disabledBuiltin).slice(0, 2000)
    }, null, 2) + '\n');
  }

  async function listDisabledDirectory(directory, builtin) {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const list = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const pkg = JSON.parse(await readFile(path.join(directory, entry.name, 'package.json'), 'utf8'));
        if (!pkg.publisher || !pkg.name) continue;
        list.push({
          id: `${pkg.publisher}.${pkg.name}`,
          name: pkg.displayName || pkg.name,
          version: pkg.version || '',
          extensionPath: path.join(directory, entry.name),
          folderName: entry.name,
          builtin,
          active: false,
          disabled: true,
          core: false,
          engines: pkg.engines?.vscode || '',
          dependencies: Array.isArray(pkg.extensionDependencies) ? pkg.extensionDependencies : [],
          missingDependencies: [],
          ubovm: false
        });
      } catch { /* ignore incomplete disabled folders */ }
    }
    return list;
  }

  async function listDisabledExtensions() {
    return [
      ...await listDisabledDirectory(disabledExtensionsDirectory(), false),
      ...await listDisabledDirectory(disabledBuiltinExtensionsDirectory(), true)
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  const PROTECTED_BUILTIN_FOLDERS = new Set(['ubovm-core', 'typescript-language-features', 'json-language-features']);
  function protectedBuiltin(folderName) {
    return PROTECTED_BUILTIN_FOLDERS.has(String(folderName || ''));
  }

  async function promptReload(message) {
    const reload = await vscode.window.showInformationMessage(message, '立即重新加载');
    if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async function reloadWindow() {
    await promptReload('重新加载窗口后生效。');
  }

  async function setExtensionEnabled(id, enabled) {
    if (enabled) {
      const disabled = (await listDisabledExtensions()).find(item => item.id === id);
      if (!disabled) throw new Error('找不到已禁用的扩展');
      const state = await readExtensionState();
      if (disabled.builtin) state.disabledBuiltin = state.disabledBuiltin.filter(name => name !== disabled.folderName);
      else state.disabled = state.disabled.filter(name => name !== disabled.folderName);
      await writeExtensionState(state);
      const target = disabled.builtin
        ? path.join(builtinExtensionsDirectory(), disabled.folderName)
        : path.join(userExtensionsDirectory(), disabled.folderName);
      try {
        await access(target);
        throw new Error(`目标扩展目录已存在：${target}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await moveExtensionFolder(disabled.extensionPath, target);
      } catch (error) {
        log('立即移动扩展目录失败：' + (error?.message || error));
        throw new Error(`已记录启用状态，但扩展目录被占用；请完全退出并重启应用后生效（${error?.message || error}）。`);
      }
      log(`已启用扩展 ${id}`);
      await reloadWindow();
      return { enabled: true };
    }
    const extension = vscode.extensions.getExtension(id);
    if (!extension) throw new Error('扩展未安装或已禁用');
    const folderName = path.basename(extension.extensionPath || '');
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(folderName)) throw new Error('扩展目录名无效');
    if (extension.id === 'ubovm.ubovm-core') throw new Error('UBOVM 核心扩展始终启用，不能禁用');
    const builtin = isBuiltin(extension);
    if (builtin && protectedBuiltin(folderName)) throw new Error('该内置扩展是 IDE 运行必需的，不能禁用');
    const state = await readExtensionState();
    if (builtin) {
      if (!state.disabledBuiltin.includes(folderName)) state.disabledBuiltin.push(folderName);
    } else if (!state.disabled.includes(folderName)) {
      state.disabled.push(folderName);
    }
    await writeExtensionState(state);
    const target = builtin
      ? path.join(disabledBuiltinExtensionsDirectory(), folderName)
      : path.join(disabledExtensionsDirectory(), folderName);
    try {
      await moveExtensionFolder(extension.extensionPath, target);
    } catch (error) {
      log('立即移动扩展目录失败：' + (error?.message || error));
      throw new Error(`已记录禁用状态，但扩展目录被占用；请完全退出并重启应用后生效（${error?.message || error}）。`);
    }
    log(`已禁用扩展 ${id}（${folderName}）`);
    await reloadWindow();
    return { enabled: false };
  }

  function safeExtensionEntry(name) {
    const normalized = String(name || '').replace(/\\/g, '/');
    if (!normalized.startsWith('extension/')) return undefined;
    const relative = normalized.slice('extension/'.length);
    if (!relative || relative.endsWith('/')) return undefined;
    const cleaned = path.posix.normalize(relative);
    if (!cleaned || cleaned.startsWith('..') || path.posix.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) return undefined;
    return cleaned;
  }

  /**
   * Built-in VSIX extraction fallback for builds where the workbench extension
   * install command was removed together with the marketplace metadata.
   */
  async function extractVsix(filePath) {
    const buffer = await readFile(filePath);
    const files = readArchive(buffer, {
      maxEntryBytes: 512 * 1024 * 1024,
      maxTotalBytes: 1536 * 1024 * 1024,
      maxEntries: 50000
    });
    const manifestEntry = [...files.entries()].find(([name]) => /^extension\/package\.json$/i.test(String(name).replace(/\\/g, '/')));
    if (!manifestEntry) throw new Error('VSIX 中没有 extension/package.json');
    let manifest;
    try { manifest = JSON.parse(manifestEntry[1].toString('utf8')); }
    catch { throw new Error('VSIX 的 extension/package.json 不是有效 JSON'); }
    const publisher = String(manifest.publisher || '');
    const name = String(manifest.name || '');
    const version = String(manifest.version || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(publisher) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name) || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) {
      throw new Error('VSIX publisher/name/version 无效');
    }
    const extensionId = `${publisher}.${name}`;
    if (extensionId === 'ubovm.ubovm-core') throw new Error('不能通过插件安装覆盖 UBOVM 核心扩展');
    const root = userExtensionsDirectory();
    const target = path.join(root, `${extensionId}-${version}`);
    const relativeTarget = path.relative(root, target);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error('VSIX 目标目录越界');
    try { await access(target); throw new Error(`扩展目录已存在：${target}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let written = 0;
    for (const [entryName, content] of files) {
      const relative = safeExtensionEntry(entryName);
      if (!relative) continue;
      const destination = path.join(target, relative);
      const guard = path.relative(target, destination);
      if (!guard || guard.startsWith('..') || path.isAbsolute(guard)) throw new Error('VSIX 条目路径越界');
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
      written += 1;
    }
    if (!written) throw new Error('VSIX 中没有可安装的扩展文件');
    log(`已解压安装扩展 ${extensionId}@${version} 到 ${target}`);
    return { id: extensionId, version, target, files: written };
  }

  async function manualInstall(filePath) {
    const result = await extractVsix(filePath);
    await repairExecutableIntegrity(result.target).catch(() => {});
    refreshManagerPanel();
    await promptReload(`插件 ${result.id}@${result.version} 已重新安装完成。需要重新加载窗口后生效。`);
  }

  async function openFolder() {
    const directory = extensionsDirectory();
    try { await vscode.env.openExternal(vscode.Uri.file(directory)); }
    catch (error) {
      log('打开扩展目录失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('无法打开扩展目录：' + directory);
    }
  }

  async function showExtensionView() {
    // The workbench extensions view is removed with the marketplace metadata in
    // this build, so use a self-contained panel instead of a command that may
    // silently do nothing.
    return showManagerPanel();
  }

  async function extensionRows(force = false) {
    const now = Date.now();
    if (!force && extensionRowsCache && now - extensionRowsAt < 500) return extensionRowsCache;
    const tools = new Map((registry?.uiState?.().tools || []).map(item => [item.pluginId, item]));
    const installed = (vscode.extensions.all || []).map(extension => {
      const pkg = extension.packageJSON || {};
      const dependencies = Array.isArray(pkg.extensionDependencies) ? pkg.extensionDependencies : [];
      const missingDependencies = dependencies.filter(id => !vscode.extensions.getExtension(id));
      return {
        id: extension.id,
        name: pkg.displayName || pkg.name || extension.id,
        version: pkg.version || '',
        extensionPath: extension.extensionPath || '',
        engines: pkg.engines?.vscode || '',
        dependencies,
        missingDependencies,
        builtin: isBuiltin(extension),
        protected: extension.id === 'ubovm.ubovm-core' || (isBuiltin(extension) && protectedBuiltin(path.basename(extension.extensionPath || ''))),
        active: extension.isActive === true,
        disabled: false,
        core: extension.id === 'ubovm.ubovm-core',
        ubovm: tools.has(extension.id)
      };
    });
    extensionRowsCache = [...installed, ...await listDisabledExtensions()].sort((a, b) => {
      const recent = recentPluginIds();
      const leftRank = recent.indexOf(a.id);
      const rightRank = recent.indexOf(b.id);
      return Number(b.id === 'ubovm.ubovm-core') - Number(a.id === 'ubovm.ubovm-core')
        || Number(a.disabled) - Number(b.disabled)
        || (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank)
        || a.name.localeCompare(b.name);
    });
    extensionRowsAt = now;
    return extensionRowsCache;
  }

  async function openExtensionFolder(id) {
    const target = (vscode.extensions.all || []).find(extension => extension.id === id)
      || (await listDisabledExtensions()).find(item => item.id === id);
    if (!target?.extensionPath) {
      await vscode.window.showErrorMessage('找不到该扩展目录。');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.file(target.extensionPath));
  }

  async function showManagerMore() {
    const items = [
      { label: '从 URL 安装…', id: 'install-url' },
      { label: '重装当前平台包…', id: 'repair-platform' },
      { label: '检查 Open VSX 更新…', id: 'check-updates' },
      { label: '扩展功能…', id: 'extension-actions' },
      { label: '兼容性检查', id: 'diagnose' },
      { label: '扩展日志目录', id: 'logs' },
      { label: '日志内容', id: 'log-content' },
      { label: 'Webview 控制台', id: 'webview-devtools' },
      { label: '显示/隐藏 VS Code 状态栏（插件状态项）', id: 'statusbar' },
      { label: '显示/隐藏活动栏', id: 'activitybar' },
      { label: '打开扩展目录', id: 'folder' },
      { label: '重新加载窗口', id: 'reload' },
      { label: '刷新', id: 'refresh' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '更多插件操作' });
    if (!picked) return;
    const actions = {
      'install-url': installFromUrl,
      'repair-platform': () => repairPlatformExtension(),
      'check-updates': checkExtensionUpdates,
      'extension-actions': showExtensionActions,
      diagnose: diagnoseExtensions,
      logs: openLogsFolder,
      'log-content': openExtensionHostLog,
      'webview-devtools': async () => { await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools'); },
      statusbar: async () => { await vscode.commands.executeCommand('workbench.action.toggleStatusbarVisibility'); },
      activitybar: async () => { await vscode.commands.executeCommand('workbench.action.toggleActivityBarVisibility'); },
      folder: openFolder,
      reload: async () => { await vscode.commands.executeCommand('workbench.action.reloadWindow'); },
      refresh: async () => refreshManagerPanel()
    };
    await actions[picked.id]?.();
  }

  async function showExtensionMenu(id) {
    const row = (await extensionRows()).find(item => item.id === id);
    if (!row) {
      await vscode.window.showErrorMessage('找不到该扩展。');
      return;
    }
    const items = [];
    if (!row.disabled && !row.core) items.push({ label: '打开', id: 'open' });
    if (!row.disabled) items.push({ label: '重新打开（刷新界面）', id: 'reopen' });
    if (!row.core && !row.protected) items.push({ label: row.disabled ? '启用' : '禁用', id: 'toggle' });
    if (!row.disabled && !row.active) items.push({ label: '激活', id: 'activate' });
    items.push({ label: '打开目录', id: 'folder' });
    if (!row.builtin) items.push({ label: row.disabled ? '删除扩展' : '卸载扩展', id: 'uninstall', destructive: true });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: row.name });
    if (!picked) return;
    try {
      if (picked.id === 'open') return openExtension(id);
      if (picked.id === 'reopen') {
        await vscode.commands.executeCommand('workbench.action.closeSidebar').catch(() => {});
        return openExtension(id);
      }
      if (picked.id === 'toggle') return setExtensionEnabled(id, row.disabled);
      if (picked.id === 'activate') {
        const extension = vscode.extensions.getExtension(id);
        if (extension) await extension.activate();
        refreshManagerPanel();
        return;
      }
      if (picked.id === 'folder') return openExtensionFolder(id);
      if (picked.id === 'uninstall') return uninstallExtension(id);
    } catch (error) {
      log('扩展操作失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('扩展操作失败：' + (error?.message || error));
    }
  }

  function marketplaceItem(item) {
    const namespace = String(item?.namespace || '');
    const name = String(item?.name || '');
    const version = String(item?.version || '');
    if (!namespace || !name) return undefined;
    const icon = typeof item?.files?.icon === 'string' && /^https:\/\//i.test(item.files.icon)
      ? item.files.icon
      : `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version || 'latest')}/file/icon.png`;
    return {
      id: `${namespace}.${name}`,
      namespace,
      name,
      version,
      displayName: String(item?.displayName || name),
      description: String(item?.description || '').slice(0, 220),
      downloadCount: Number(item?.downloadCount || 0),
      icon
    };
  }

  function marketplaceHtml(nonce, platform) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 16px 20px 28px; color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); font-family: var(--vscode-font-family, system-ui, sans-serif); }
        h1 { font-size: 17px; margin: 0 0 4px; }
        p.sub { margin: 0 0 14px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
        form { display: flex; gap: 8px; position: sticky; top: 0; padding: 4px 0 12px; background: var(--vscode-editor-background, #1e1e1e); z-index: 2; }
        input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444)); border-radius: 6px; background: var(--vscode-input-background, #2d2d2d); color: var(--vscode-input-foreground, #ddd); font: inherit; font-size: 13px; }
        button { padding: 6px 12px; border: 0; border-radius: 6px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font: inherit; font-size: 12px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        button:disabled { opacity: .55; cursor: default; }
        #status { min-height: 18px; margin: 0 0 8px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
        .grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
        .card { display: flex; gap: 12px; padding: 11px 12px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%); }
        .icon { width: 38px; height: 38px; flex: none; border-radius: 7px; object-fit: contain; background: var(--vscode-input-background, #2d2d2d); }
        .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .title strong { font-size: 13px; }
        .title small { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
        .desc { margin: 0; color: var(--vscode-descriptionForeground, #aaa); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .meta { color: var(--vscode-descriptionForeground, #888); font-size: 11px; }
        .actions { flex: none; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 8px; }
        .actions button { white-space: nowrap; }
        #more { margin: 14px auto 0; display: block; }
        .empty { padding: 22px 0; color: var(--vscode-descriptionForeground, #999); font-size: 13px; text-align: center; }
        @media (max-width: 560px) {
          body { padding: 12px; }
          .card { flex-wrap: wrap; }
          .actions { width: 100%; flex-direction: row; justify-content: space-between; align-items: center; }
        }
      </style></head><body>
      <h1>插件市场</h1>
      <p class="sub">搜索并安装 VS Code 扩展 · 当前平台 ${escapeHtml(platform)} · 来源 Open VSX</p>
      <form id="search"><input id="query" type="search" placeholder="搜索插件，例如 python、git、security…" autocomplete="off"><button id="submit" type="submit">搜索</button></form>
      <div id="status" role="status"></div>
      <div id="results" class="grid"></div>
      <button id="more" type="button" hidden>加载更多</button>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const state = { query: '', offset: 0, busy: false, items: 0 };
        const results = document.getElementById('results');
        const status = document.getElementById('status');
        const form = document.getElementById('search');
        const query = document.getElementById('query');
        const submit = document.getElementById('submit');
        const more = document.getElementById('more');
        function text(value) { return String(value == null ? '' : value); }
        function setBusy(value) {
          state.busy = value;
          submit.disabled = value;
          more.disabled = value;
          status.textContent = value ? '正在搜索…' : '';
        }
        function search(reset) {
          if (state.busy) return;
          if (reset) { state.offset = 0; state.items = 0; results.replaceChildren(); }
          state.query = query.value.trim();
          setBusy(true);
          vscode.postMessage({ type: 'marketplace-search', query: state.query, offset: state.offset });
        }
        function render(items) {
          for (const item of items) {
            const card = document.createElement('article');
            card.className = 'card';
            const icon = document.createElement('img');
            icon.className = 'icon'; icon.alt = ''; icon.src = item.icon;
            icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; }, { once: true });
            const main = document.createElement('div'); main.className = 'main';
            const title = document.createElement('div'); title.className = 'title';
            const strong = document.createElement('strong'); strong.textContent = item.displayName;
            const small = document.createElement('small'); small.textContent = item.id + (item.version ? ' · v' + item.version : '');
            title.append(strong, small);
            const desc = document.createElement('p'); desc.className = 'desc'; desc.textContent = item.description || '暂无描述';
            const meta = document.createElement('span'); meta.className = 'meta';
            meta.textContent = item.downloadCount ? item.downloadCount.toLocaleString() + ' 次下载' : '';
            main.append(title, desc, meta);
            const actions = document.createElement('div'); actions.className = 'actions';
            const install = document.createElement('button'); install.type = 'button';
            install.textContent = item.installedVersion ? '已安装' : '安装';
            install.disabled = Boolean(item.installedVersion);
            install.addEventListener('click', () => {
              install.disabled = true; install.textContent = '安装中…';
              vscode.postMessage({ type: 'marketplace-install', item: { namespace: item.namespace, name: item.name, version: item.version } });
            });
            actions.append(install);
            card.append(icon, main, actions);
            results.append(card);
          }
          state.items += items.length;
          status.textContent = state.items ? '已显示 ' + state.items + ' 个结果' : '没有找到插件';
        }
        form.addEventListener('submit', event => { event.preventDefault(); search(true); });
        more.addEventListener('click', () => { state.offset = state.items; search(false); });
        window.addEventListener('message', event => {
          const message = event.data || {};
          if (message.type === 'marketplace-results') {
            setBusy(false);
            render(Array.isArray(message.items) ? message.items : []);
            more.hidden = !message.items || message.items.length < 20;
          } else if (message.type === 'marketplace-status') {
            status.textContent = message.message || '';
            if (message.state === 'installed') {
              for (const button of document.querySelectorAll('.actions button')) {
                if (button.textContent === '安装中…') { button.textContent = '已安装'; button.disabled = true; }
              }
            }
          }
        });
        search(true);
      </script>
    </body></html>`;
  }

  async function openPluginMarketplace() {
    if (marketplacePanel) {
      marketplacePanel.reveal();
      return;
    }
    const platform = `${process.platform}-${process.arch}`;
    const nonce = randomUUID().replaceAll('-', '');
    marketplacePanel = vscode.window.createWebviewPanel(
      'ubovm.pluginMarketplace',
      '插件市场',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    marketplacePanel.onDidDispose(() => { marketplacePanel = undefined; });
    marketplacePanel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'marketplace-search') {
        await runMarketplaceSearch(message.query, message.offset, platform);
      } else if (message.type === 'marketplace-install') {
        try {
          await installMarketplaceItem(message.item, platform);
        } catch (error) {
          log('插件市场安装失败：' + (error?.message || error));
          marketplacePanel?.webview.postMessage({ type: 'marketplace-status', state: 'error', message: '安装失败：' + (error?.message || error) });
          await vscode.window.showErrorMessage('安装失败：' + (error?.message || error));
        }
      }
    });
    marketplacePanel.webview.html = marketplaceHtml(nonce, platform);
  }

  async function runMarketplaceSearch(query, offset, platform) {
    const revision = ++marketplaceSearchRevision;
    if (!marketplacePanel) return;
    try {
      const params = new URLSearchParams({
        query: String(query || ''),
        size: '20',
        offset: String(Number(offset) || 0),
        includeAllVersions: 'false',
        sortBy: 'downloadCount',
        sortOrder: 'desc',
        targetPlatform: platform
      });
      const response = await fetch(`https://open-vsx.org/api/-/search?${params.toString()}`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (revision !== marketplaceSearchRevision || !marketplacePanel) return;
      const items = (Array.isArray(data?.extensions) ? data.extensions : [])
        .map(marketplaceItem)
        .filter(Boolean)
        .map(item => ({ ...item, installedVersion: vscode.extensions.getExtension(item.id)?.packageJSON?.version || '' }));
      marketplacePanel.webview.postMessage({ type: 'marketplace-results', items, total: Number(data?.totalSize || 0), hasMore: items.length >= 20 });
    } catch (error) {
      if (revision !== marketplaceSearchRevision || !marketplacePanel) return;
      marketplacePanel.webview.postMessage({ type: 'marketplace-results', items: [], total: 0, hasMore: false });
      marketplacePanel.webview.postMessage({ type: 'marketplace-status', state: 'error', message: '搜索失败：' + (error?.message || error) });
    }
  }

  async function installMarketplaceItem(item, platform) {
    const namespace = String(item?.namespace || '');
    const name = String(item?.name || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(namespace) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) {
      throw new Error('无效的扩展标识');
    }
    marketplacePanel?.webview.postMessage({ type: 'marketplace-status', state: 'downloading', message: `正在解析 ${namespace}.${name}…` });
    const version = String(item?.version || 'latest');
    const detailResponse = await fetch(`https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
      headers: { accept: 'application/json' }
    });
    if (!detailResponse.ok) throw new Error(`HTTP ${detailResponse.status}`);
    const detail = await detailResponse.json();
    const download = detail?.downloads?.[platform] || detail?.downloads?.universal || detail?.files?.download;
    if (typeof download !== 'string' || !/^https:\/\//i.test(download)) throw new Error(`没有 ${platform} 平台的安装包`);
    marketplacePanel?.webview.postMessage({ type: 'marketplace-status', state: 'downloading', message: `正在下载 ${detail?.displayName || name}…` });
    await downloadAndInstall(download, 'marketplace');
    marketplacePanel?.webview.postMessage({ type: 'marketplace-status', state: 'installed', message: '安装完成，重新加载窗口后生效。' });
  }

  const RECENT_PLUGINS_KEY = 'ubovm.recentPlugins';

  function recentPluginIds() {
    try {
      const value = context?.globalState?.get(RECENT_PLUGINS_KEY, []);
      return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  async function rememberPlugin(id) {
    try {
      const next = [id, ...recentPluginIds().filter(value => value !== id)].slice(0, 12);
      await context?.globalState?.update(RECENT_PLUGINS_KEY, next);
    } catch { /* recent list is a convenience only */ }
  }

  async function openPluginPicker() {
    const recent = recentPluginIds();
    const items = (vscode.extensions.all || [])
      .filter(extension => !isBuiltin(extension) && extension.id !== 'ubovm.ubovm-core')
      .map(extension => {
        const pkg = extension.packageJSON || {};
        const icon = typeof pkg.icon === 'string' && /^[^\\/]+\.(?:png|svg|jpe?g|webp)$/i.test(pkg.icon)
          ? vscode.Uri.file(path.join(extension.extensionPath || '', pkg.icon))
          : new vscode.ThemeIcon('extensions');
        return {
          label: pkg.displayName || pkg.name || extension.id,
          description: `${extension.id}@${pkg.version || '?'}${recent.includes(extension.id) ? ' · 最近使用' : ''}`,
          detail: `${extension.isActive ? '已激活' : '未激活'} · ${extension.extensionPath}`,
          iconPath: icon,
          id: extension.id
        };
      });
    items.sort((left, right) => {
      const leftRank = recent.indexOf(left.id);
      const rightRank = recent.indexOf(right.id);
      if (leftRank !== rightRank) return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
      return left.label.localeCompare(right.label);
    });
    if (!items.length) {
      await vscode.window.showInformationMessage('还没有安装第三方插件。可先通过 VSIX、URL 或 Open VSX 安装。');
      return;
    }
    if (items.length === 1) {
      await openExtension(items[0].id);
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要打开的插件',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (picked) await openExtension(picked.id);
  }

  /** Open a plugin's own UI: view container first, contributed commands otherwise. */
  async function openExtension(id) {
    const extension = vscode.extensions.getExtension(id);
    if (!extension) {
      await vscode.window.showErrorMessage(`找不到扩展 ${id}。`);
      return;
    }
    try {
      if (!extension.isActive) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `正在激活 ${id}…` },
          () => extension.activate()
        );
      }
    } catch (error) {
      log(`激活扩展失败 ${id}：` + (error?.message || error));
      await vscode.window.showErrorMessage(`激活 ${id} 失败：${error?.message || error}`);
      return;
    }
    const pkg = extension.packageJSON || {};
    await rememberPlugin(id);
    const containerGroups = pkg.contributes?.viewsContainers && typeof pkg.contributes.viewsContainers === 'object'
      ? Object.entries(pkg.contributes.viewsContainers)
      : [];
    const priority = { secondarySidebar: 0, activitybar: 1, panel: 2 };
    const containers = containerGroups
      .flatMap(([location, items]) => (Array.isArray(items) ? items : [])
        .filter(item => item && typeof item === 'object' && item.id)
        .map(item => ({ ...item, location })))
      .sort((left, right) => (priority[left.location] ?? 3) - (priority[right.location] ?? 3));
    const registered = new Set(await vscode.commands.getCommands(true));
    const commands = (Array.isArray(pkg.contributes?.commands) ? pkg.contributes.commands : [])
      .filter(command => command?.command && registered.has(command.command));
    // Prefer the extension's own "Open" command. It creates the UI the plugin
    // intended (often a tab) instead of swapping the active sidebar container.
    const openCommand = commands.find(command => {
      const title = String(command.title || '');
      return /(?:^|[.:])open(?:chat|conversation|code|tab)?$/i.test(command.command)
        || /^open\b/i.test(title) && !/\b(logs?|file|diff|browser|settings|notices?)\b/i.test(title);
    });
    if (openCommand) {
      try {
        await vscode.commands.executeCommand(openCommand.command);
        return;
      } catch { /* fall through to view containers */ }
    }
    // Opening should feel like a single action: try the extension's view
    // containers in preference order before ever showing a command list.
    for (const container of containers) {
      const command = `workbench.view.extension.${container.id}`;
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch { /* container may be hidden by its when-clause; try the next one */ }
    }
    const commandChoices = commands.map(command => ({
      label: `$(terminal) ${command.title || command.command}`,
      description: '命令',
      command: command.command
    }));
    let target;
    if (commandChoices.length === 1) target = commandChoices[0];
    else if (commandChoices.length > 1) {
      target = await vscode.window.showQuickPick(commandChoices, {
        placeHolder: `${pkg.displayName || id} 的命令`,
        matchOnDescription: true,
        matchOnDetail: true
      });
    }
    if (!target) {
      await vscode.window.showInformationMessage(`${pkg.displayName || id} 没有可打开的视图或命令（可能只提供语言/主题能力，或激活失败）。`);
      return;
    }
    try {
      await vscode.commands.executeCommand(target.command);
    } catch (error) {
      log(`打开扩展界面失败 ${target.command}：` + (error?.message || error));
      await vscode.window.showErrorMessage(`打开扩展界面失败：${error?.message || error}`);
    }
  }

  async function showExtensionActions() {
    const items = [];
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const extension of vscode.extensions.all || []) {
      const pkg = extension.packageJSON || {};
      if (isBuiltin(extension) || extension.id === 'ubovm.ubovm-core') continue;
      const name = pkg.displayName || pkg.name || extension.id;
      const addCommand = (command, title, detail) => {
        const available = registered.has(command);
        items.push({
          label: `${available ? '$(terminal)' : '$(warning)'} ${title}`,
          description: name,
          detail: available ? `${detail} · ${command}` : `${detail} · 未注册（扩展可能未激活）· ${command}`,
          action: {
            kind: available ? 'command' : 'activate-command',
            command,
            extensionId: extension.id
          }
        });
      };
      for (const command of Array.isArray(pkg.contributes?.commands) ? pkg.contributes.commands : []) {
        if (!command?.command) continue;
        addCommand(command.command, command.title || command.command, '命令');
      }
      const containers = pkg.contributes?.viewsContainers && typeof pkg.contributes.viewsContainers === 'object'
        ? Object.values(pkg.contributes.viewsContainers).flat().filter(item => item && typeof item === 'object')
        : [];
      for (const container of containers) {
        if (!container?.id) continue;
        addCommand(`workbench.view.extension.${container.id}`, container.title || container.id, '视图容器');
      }
    }
    if (!items.length) {
      await vscode.window.showInformationMessage('当前没有可显示的扩展命令或视图。请先安装插件并重新加载窗口。');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要打开的扩展命令或视图（警告图标表示命令尚未注册）',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;
    try {
      if (picked.action.kind === 'activate-command') {
        const extension = vscode.extensions.getExtension(picked.action.extensionId);
        if (!extension) throw new Error('找不到该扩展');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `正在激活 ${picked.action.extensionId}…` },
          () => extension.activate()
        );
        const available = await vscode.commands.getCommands(true);
        if (!available.includes(picked.action.command)) {
          throw new Error('扩展已激活，但没有注册这个命令；请查看“扩展日志”中的 activate 错误');
        }
      }
      await vscode.commands.executeCommand(picked.action.command);
    } catch (error) {
      log(`执行扩展命令失败 ${picked.action.command}：` + (error?.message || error));
      await vscode.window.showErrorMessage(`打开扩展界面失败：${error?.message || error}`);
    }
  }

  const NATIVE_MAGIC = {
    win32: Buffer.from([0x4d, 0x5a]), // MZ
    linux: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
    darwin: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) // Mach-O 64
  };
  const DARWIN_UNIVERSAL = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

  async function readMagic(file) {
    let handle;
    try {
      handle = await open(file, 'r');
      const buffer = Buffer.alloc(4);
      const { bytesRead } = await handle.read(buffer, 0, 4, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function findNativeMismatches(root) {
    const expected = NATIVE_MAGIC[process.platform];
    if (!expected) return [];
    const mismatches = [];
    let visited = 0;
    async function walk(directory, depth) {
      if (depth > 7 || visited > 4000) return;
      let entries = [];
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (visited++ > 4000) return;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'src' || entry.name === 'webview-ui') continue;
          await walk(full, depth + 1);
        } else if (/\.node$/i.test(entry.name)) {
          const magic = await readMagic(full);
          const expectedMagic = expected.subarray(0, magic?.length || 0);
          const nativeOk = magic && (magic.equals(expectedMagic) || (process.platform === 'darwin' && magic.equals(DARWIN_UNIVERSAL)));
          if (magic && magic.length >= 2 && !nativeOk) {
            mismatches.push(full);
          }
        }
      }
    }
    await walk(root, 0);
    return mismatches;
  }

  async function diagnoseExtensions() {
    const version = String(vscode.version || '?');
    const platform = `${process.platform}-${process.arch}`;
    const lines = [
      '# 扩展兼容性检查',
      '',
      `- IDE：${version}`,
      `- 平台：${platform}`,
      `- 时间：${new Date().toISOString()}`,
      ''
    ];
    const problems = [];
    const notes = [];
    const extensions = (vscode.extensions.all || []).filter(extension => !isBuiltin(extension) && extension.id !== 'ubovm.ubovm-core');
    for (const extension of extensions) {
      const pkg = extension.packageJSON || {};
      const name = `${pkg.displayName || extension.id}（${extension.id}@${pkg.version || '?'}）`;
      const dependencies = Array.isArray(pkg.extensionDependencies) ? pkg.extensionDependencies : [];
      const missing = dependencies.filter(id => !vscode.extensions.getExtension(id));
      const issues = [];
      if (missing.length) issues.push(`缺少依赖：${missing.join(', ')}`);
      if (!engineCompatible(pkg.engines?.vscode)) issues.push(`engines.vscode ${pkg.engines?.vscode || '?'} 与当前 ${version} 不兼容`);
      const nativeMismatches = await findNativeMismatches(extension.extensionPath || '');
      if (nativeMismatches.length) {
        issues.push(`原生模块平台不匹配（当前 ${platform}）：${nativeMismatches.slice(0, 5).join(', ')}${nativeMismatches.length > 5 ? ' …' : ''}`);
      }
      if (issues.length) problems.push({ name, issues });
      else notes.push(`${name}：未发现明显的引擎/依赖/原生模块问题，未激活时请查看扩展日志。`);
    }
    if (!problems.length) {
      lines.push('## 结果', '', '没有发现明显的兼容性问题。如果插件仍无法使用，请查看“日志内容”和“Webview 控制台”。', '');
    } else {
      lines.push('## 需要处理', '');
      for (const item of problems) {
        lines.push(`### ${item.name}`, '');
        for (const issue of item.issues) lines.push(`- ${issue}`);
        lines.push('');
      }
    }
    if (notes.length) {
      lines.push('## 其他已安装插件', '');
      for (const note of notes) lines.push(`- ${note}`);
      lines.push('');
    }
    lines.push('> 修复平台包：插件管理 → 重装平台包…；修复依赖：激活提示/扩展日志。');
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: lines.join('\n')
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async function openLogsFolder() {
    try { await vscode.commands.executeCommand('workbench.action.openLogsFolder'); }
    catch (error) {
      log('打开扩展日志失败：' + (error?.message || error));
      await vscode.window.showInformationMessage('可通过命令面板执行 “Developer: Open Logs Folder” 查看扩展宿主日志。');
    }
  }

  async function findLatestExtensionHostLog() {
    const root = path.join(extensionStateRoot(), 'user-data', 'logs');
    const candidates = [];
    async function walk(directory, depth) {
      if (depth > 4) return;
      let entries = [];
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (/^(?:exthost|remoteexthost)\.log$/i.test(entry.name)) candidates.push(full);
      }
    }
    await walk(root, 0);
    // Log folder names are timestamps, so a reverse lexical sort gives the
    // newest window; keep searching if the newest file cannot be read.
    candidates.sort().reverse();
    for (const file of candidates) {
      try { return { file, text: await readFile(file, 'utf8') }; }
      catch { /* try an older window */ }
    }
    return undefined;
  }

  async function openExtensionHostLog() {
    const latest = await findLatestExtensionHostLog();
    if (!latest) {
      await vscode.window.showInformationMessage('没有找到扩展宿主日志。请先重新加载窗口，或点“扩展日志”打开日志目录。');
      return;
    }
    const text = latest.text.split(/\r?\n/).slice(-400).join('\n');
    const document = await vscode.workspace.openTextDocument({
      language: 'log',
      content: `日志：${latest.file}\n\n${text || '(空日志)'}`
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function settingFieldHtml(section, field) {
    const value = section.values?.[field.key];
    const base = `data-setting-plugin="${escapeHtml(section.pluginId)}" data-setting-section="${escapeHtml(section.id)}" data-setting-key="${escapeHtml(field.key)}"`;
    let control;
    if (field.type === 'boolean') {
      control = `<input type="checkbox" ${base} ${value === true ? 'checked' : ''}>`;
    } else if (field.type === 'select') {
      control = `<select ${base}>${field.options.map(option => `<option value="${escapeHtml(option.value)}" ${String(value) === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`;
    } else {
      control = `<input type="${field.type === 'number' ? 'number' : 'text'}" ${base} value="${escapeHtml(value ?? '')}">`;
    }
    return `<label class="setting-field"><span>${escapeHtml(field.label)}</span>${control}${field.description ? `<small>${escapeHtml(field.description)}</small>` : ''}</label>`;
  }

  function settingsHtml(sections) {
    if (!sections.length) return '';
    return `<section class="plugin-settings"><h2>插件设置</h2>${sections.map(section => `
      <div class="setting-section">
        <h3>${escapeHtml(section.title)} <small>${escapeHtml(section.pluginId)}</small></h3>
        ${section.description ? `<p>${escapeHtml(section.description)}</p>` : ''}
        ${section.fields.map(field => settingFieldHtml(section, field)).join('')}
      </div>`).join('')}</section>`;
  }

  function managerHtml(rows, sections = [], view = {}) {
    const nonce = randomUUID().replaceAll('-', '');
    const pluginRows = rows.filter(row => !row.builtin && !row.core);
    const builtinRows = rows.filter(row => row.builtin || row.core);
    const searchText = row => escapeHtml(`${row.name} ${row.id}`.toLowerCase());
    const pluginCards = pluginRows.map(row => `
      <li class="plugin-card${row.disabled ? ' disabled' : ''}" data-search="${searchText(row)}">
        <div class="plugin-card-main">
          <div class="plugin-card-title">
            <strong>${escapeHtml(row.name)}</strong>
            <span class="state ${row.disabled ? 'off' : row.active ? 'on' : ''}">${row.disabled ? '已禁用' : row.active ? '已激活' : '未激活'}</span>
          </div>
          <span class="meta">${escapeHtml(row.id)} · v${escapeHtml(row.version || '?')}${row.engines ? ` · engines ${escapeHtml(row.engines)}` : ''}${row.ubovm ? ' · 已注册 UBOVM 工具' : ''}</span>
          ${row.missingDependencies.length ? `<span class="meta warn">缺少依赖：${escapeHtml(row.missingDependencies.join(', '))}</span>` : ''}
        </div>
        <div class="plugin-card-actions">
          ${row.disabled
            ? `<button type="button" data-action="enable-extension" data-id="${escapeHtml(row.id)}">启用</button>
               <button type="button" class="icon-only" data-action="extension-menu" data-id="${escapeHtml(row.id)}" title="更多操作" aria-label="更多操作">⋯</button>`
            : `<button type="button" data-action="open-extension" data-id="${escapeHtml(row.id)}">打开</button>
               <button type="button" class="icon-only" data-action="extension-menu" data-id="${escapeHtml(row.id)}" title="更多操作" aria-label="更多操作">⋯</button>`}
        </div>
      </li>`).join('');
    const BUILTIN_PREVIEW = 10;
    const builtinRowsHtml = builtinRows.map((row, index) => `
      <li class="row${row.disabled ? ' disabled' : ''}${index >= BUILTIN_PREVIEW ? ' builtin-extra' : ''}" ${index >= BUILTIN_PREVIEW ? 'data-builtin-extra hidden' : ''} data-search="${searchText(row)}">
        <div class="row-main">
          <strong>${escapeHtml(row.name)}</strong>
          <span class="meta">${escapeHtml(row.id)} · v${escapeHtml(row.version || '?')} · ${row.disabled ? '已禁用' : row.active ? '已激活' : '未激活'}</span>
          ${row.missingDependencies.length ? `<span class="meta warn">缺少依赖：${escapeHtml(row.missingDependencies.join(', '))}</span>` : ''}
        </div>
        <div class="row-actions">
          ${row.core ? '<span class="badge core">核心</span>' : ''}
          <button type="button" class="icon-only" data-action="extension-menu" data-id="${escapeHtml(row.id)}" title="操作" aria-label="操作">⋯</button>
        </div>
      </li>`).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">
        :root { color-scheme: light dark; }
        body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 18px 22px; }
        h1 { font-size: 16px; margin: 0 0 4px; }
        h2 { font-size: 13px; margin: 18px 0 8px; color: var(--vscode-descriptionForeground, #999); font-weight: 600; }
        h2 small { font-weight: 400; opacity: .8; }
        p.hint { margin: 0 0 14px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
        .toolbar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
        button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 5px 11px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        button:active { transform: translateY(1px); }
        button:focus-visible { outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: 1px; }
        button.ghost { background: transparent; color: var(--vscode-foreground, #ccc); border-color: var(--vscode-panel-border, #444); }
        button.ghost:hover { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
        button.primary { font-weight: 600; }
        button.icon-only { width: 28px; min-width: 28px; min-height: 28px; padding: 0; background: transparent; border-color: transparent; color: var(--vscode-descriptionForeground, #aaa); font-size: 16px; line-height: 1; }
        button.icon-only:hover { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); color: var(--vscode-foreground, #ddd); }
        button.danger { background: transparent; color: var(--vscode-errorForeground, #f48771); border-color: var(--vscode-errorForeground, #f48771); }
        .filter { width: 100%; max-width: 360px; margin: 0 0 14px; padding: 6px 9px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444)); border-radius: 4px; background: var(--vscode-input-background, #2d2d2d); color: var(--vscode-input-foreground, #ddd); font: inherit; font-size: 12px; }
        ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        [hidden] { display: none !important; }
        li.plugin-card { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 11px 13px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
        li.plugin-card.disabled { opacity: .7; }
        li.plugin-card.disabled strong { text-decoration: line-through; }
        .plugin-card-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .plugin-card-title { display: flex; align-items: center; gap: 8px; }
        .plugin-card-title strong { font-size: 13px; font-weight: 600; }
        .state { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #444); color: var(--vscode-descriptionForeground, #999); }
        .state.on { color: var(--vscode-testing-iconPassed, #73c991); border-color: currentColor; }
        .state.off { color: var(--vscode-errorForeground, #f48771); border-color: currentColor; }
        .plugin-card-actions { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
        .empty { color: var(--vscode-descriptionForeground, #999); font-size: 12px; margin: 6px 0; }
        li.row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; }
        li.row.disabled { opacity: .72; }
        li.row.disabled strong { text-decoration: line-through; }
        .row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .row-main strong { font-size: 13px; font-weight: 600; }
        .meta, .path { color: var(--vscode-descriptionForeground, #999); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .meta.warn { color: var(--vscode-editorWarning-foreground, #cca700); white-space: normal; }
        .row-actions { display: flex; align-items: center; gap: 6px; flex: none; }
        .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #444); color: var(--vscode-descriptionForeground, #999); }
        .badge.builtin { opacity: .7; }
        .badge.core { color: var(--vscode-textLink-foreground, #3794ff); border-color: currentColor; opacity: 1; }
        details.builtin-section { margin-top: 8px; }
        details.builtin-section > summary { cursor: pointer; font-size: 13px; color: var(--vscode-descriptionForeground, #999); font-weight: 600; padding: 6px 0; }
        .builtin-show-all { margin-top: 8px; }
        .builtin-list li.row { padding: 7px 10px; }
        .plugin-settings { margin-top: 22px; border-top: 1px solid var(--vscode-panel-border, #444); padding-top: 14px; }
        .plugin-settings h2 { font-size: 14px; margin: 0 0 10px; color: var(--vscode-foreground); }
        .setting-section { margin-bottom: 14px; }
        .setting-section h3 { font-size: 13px; margin: 0 0 6px; }
        .setting-section h3 small, .setting-section p { color: var(--vscode-descriptionForeground, #999); font-size: 11px; font-weight: 400; }
        .setting-section p { margin: 0 0 8px; }
        .setting-field { display: flex; flex-direction: column; gap: 3px; margin: 0 0 9px; font-size: 12px; }
        .setting-field small { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
        .setting-field input[type="text"], .setting-field input[type="number"], .setting-field select {
          padding: 4px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
          border-radius: 4px; background: var(--vscode-input-background, #2d2d2d); color: var(--vscode-input-foreground, #ddd);
          font: inherit; font-size: 12px; max-width: 420px;
        }
        .setting-field input[type="checkbox"] { align-self: flex-start; }
        @media (max-width: 620px) {
          body { padding: 12px 12px 20px; }
          h1 { font-size: 15px; }
          .toolbar { gap: 6px; }
          .toolbar button { padding: 5px 8px; }
          .filter { max-width: none; }
          li.plugin-card { flex-direction: column; align-items: stretch; gap: 9px; padding: 10px 11px; }
          .plugin-card-main { width: 100%; }
          .plugin-card-title { flex-wrap: wrap; gap: 4px 8px; }
          .plugin-card-title strong { overflow-wrap: anywhere; line-height: 1.35; }
          .plugin-card-actions { justify-content: flex-start; width: 100%; }
          .plugin-card-actions button { flex: 0 0 auto; }
          .meta, .path { white-space: normal; overflow-wrap: anywhere; }
          li.row { flex-direction: column; align-items: stretch; gap: 8px; }
          .row-actions { flex-wrap: wrap; justify-content: flex-start; }
        }
      </style></head><body>
      <h1>插件管理</h1>
      <p class="hint">已安装插件放在最前面；点“打开”直接进入插件贡献的视图/命令。核心扩展（UBOVM Core）始终启用。安装/禁用后需要重新加载窗口。</p>
      <div class="toolbar">
        <button type="button" class="primary" data-action="marketplace">打开插件市场</button>
        <button type="button" class="ghost" data-action="install">从 VSIX 安装…</button>
        <button type="button" class="ghost" data-action="open-plugin">打开插件…</button>
        <button type="button" class="ghost" data-action="manager-more">更多操作…</button>
      </div>
      <input id="plugin-filter" class="filter" type="search" placeholder="搜索插件名称或 ID…" autocomplete="off" value="${escapeHtml(view.filter || '')}">
      <section class="plugin-section">
        <h2>已安装插件 <small>${pluginRows.length}</small></h2>
        ${pluginCards ? `<ul class="plugin-cards">${pluginCards}</ul>` : '<p class="empty">还没有安装第三方插件。可从 VSIX、URL 或 Open VSX 安装，安装后重新加载窗口。</p>'}
      </section>
      <details class="builtin-section">
        <summary>内置扩展（${builtinRows.length}）</summary>
        <ul class="builtin-list">${builtinRowsHtml}</ul>
        ${builtinRows.length > BUILTIN_PREVIEW ? `<button type="button" class="ghost builtin-show-all" id="show-all-builtins">显示全部 ${builtinRows.length} 个内置扩展</button>` : ''}
      </details>
      ${settingsHtml(sections)}
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const initialView = ${JSON.stringify({ scrollTop: Number(view.scrollTop) || 0, filter: String(view.filter || '') })};
        let builtinsExpanded = false;
        let viewTimer;
        const postViewState = () => {
          clearTimeout(viewTimer);
          viewTimer = setTimeout(() => {
            vscode.postMessage({
              type: 'manager-view',
              scrollTop: document.scrollingElement?.scrollTop || window.scrollY || 0,
              filter: document.getElementById('plugin-filter')?.value || ''
            });
          }, 120);
        };
        window.addEventListener('scroll', postViewState, { passive: true });
        document.addEventListener('click', event => {
          const button = event.target.closest('[data-action]');
          if (!button) return;
          vscode.postMessage({ type: button.dataset.action, id: button.dataset.id || '' });
        });
        document.getElementById('show-all-builtins')?.addEventListener('click', event => {
          builtinsExpanded = true;
          document.querySelectorAll('[data-builtin-extra]').forEach(item => { item.hidden = false; });
          event.currentTarget.hidden = true;
        });
        document.addEventListener('input', event => {
          if (event.target.id !== 'plugin-filter') return;
          const query = event.target.value.trim().toLowerCase();
          document.querySelectorAll('[data-search]').forEach(item => {
            if (query) item.hidden = !item.dataset.search.includes(query);
            else item.hidden = item.hasAttribute('data-builtin-extra') && !builtinsExpanded;
          });
          postViewState();
        });
        document.addEventListener('change', event => {
          const input = event.target.closest('[data-setting-plugin]');
          if (!input) return;
          vscode.postMessage({
            type: 'setting',
            pluginId: input.dataset.settingPlugin,
            sectionId: input.dataset.settingSection,
            key: input.dataset.settingKey,
            value: input.type === 'checkbox' ? input.checked : input.value
          });
        });
        if (initialView.filter) {
          const filter = document.getElementById('plugin-filter');
          filter.value = initialView.filter;
          filter.dispatchEvent(new Event('input', { bubbles: true }));
        }
        requestAnimationFrame(() => {
          if (initialView.scrollTop > 0) {
            (document.scrollingElement || document.documentElement).scrollTop = initialView.scrollTop;
          }
        });
      </script>
    </body></html>`;
  }

  async function renderManagerPanel() {
    const rows = await extensionRows();
    if (!managerPanel) return;
    const sections = registry?.settingsState?.() || [];
    const fingerprint = JSON.stringify({
      rows: rows.map(row => [row.id, row.version, row.active, row.disabled, row.builtin, row.ubovm]),
      sections
    });
    if (fingerprint === managerFingerprint) return;
    managerFingerprint = fingerprint;
    managerPanel.webview.html = managerHtml(rows, sections, managerView);
  }

  function refreshManagerPanel() {
    extensionRowsCache = undefined;
    clearTimeout(managerRefreshTimer);
    managerRefreshTimer = setTimeout(() => {
      void renderManagerPanel().catch(error => log('刷新插件管理面板失败：' + (error?.message || error)));
    }, 60);
  }

  async function removeExtensionFiles(target) {
    const root = userExtensionsDirectory();
    const allowedRoots = [root, disabledExtensionsDirectory(), disabledBuiltinExtensionsDirectory()];
    const absolute = path.resolve(target);
    const safe = allowedRoots.some(allowed => {
      const relative = path.relative(path.resolve(allowed), absolute);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!safe) throw new Error(`拒绝删除扩展目录外的路径：${target}`);
    await rm(absolute, { recursive: true, force: true });
  }

  async function uninstallExtension(id) {
    const target = (vscode.extensions.all || []).find(extension => extension.id === id)
      || (await listDisabledExtensions()).find(item => item.id === id);
    if (!target) throw new Error('扩展不存在');
    if (target.id === 'ubovm.ubovm-core' || target.core || target.builtin) {
      await vscode.window.showWarningMessage('内置扩展不能卸载。');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(`确定卸载 ${id}？`, { modal: true }, '卸载');
    if (confirmed !== '卸载') return;
    if (target.disabled) {
      try {
        await removeExtensionFiles(target.extensionPath);
        const folderName = target.folderName || path.basename(target.extensionPath || '');
        const state = await readExtensionState();
        state.disabled = state.disabled.filter(name => name !== folderName);
        state.disabledBuiltin = state.disabledBuiltin.filter(name => name !== folderName);
        await writeExtensionState(state);
        await vscode.window.showInformationMessage('扩展已删除，重新加载窗口后生效。');
        refreshManagerPanel();
        return;
      } catch (error) {
        log('删除已禁用扩展失败：' + (error?.message || error));
        await vscode.window.showErrorMessage('删除扩展失败：' + (error?.message || error));
        return;
      }
    }
    try {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
      await vscode.window.showInformationMessage('插件已卸载，重新加载窗口后生效。');
      refreshManagerPanel();
    } catch (error) {
      log('卸载扩展失败：' + (error?.message || error));
      const fallback = await vscode.window.showWarningMessage(
        `扩展管理器无法卸载该插件。是否直接删除扩展目录？\n${target.extensionPath}`,
        { modal: true },
        '删除目录'
      );
      if (fallback !== '删除目录') return;
      try {
        await removeExtensionFiles(target.extensionPath);
        await vscode.window.showInformationMessage('扩展目录已删除，重新加载窗口后生效。');
        refreshManagerPanel();
      } catch (removeError) {
        log('删除扩展目录失败：' + (removeError?.message || removeError));
        await vscode.window.showErrorMessage('删除扩展目录失败：' + (removeError?.message || removeError));
      }
    }
  }

  function showManagerPanel() {
    if (managerPanel) {
      managerPanel.reveal();
      refreshManagerPanel();
      return;
    }
    managerFingerprint = '';
    managerPanel = vscode.window.createWebviewPanel(
      'ubovm.pluginManager',
      '插件管理',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    managerPanel.onDidDispose(() => { managerPanel = undefined; managerFingerprint = ''; });
    // Paint a lightweight shell synchronously so opening the panel never shows
    // an empty white webview while extension folders are scanned.
    managerPanel.webview.html = '<!doctype html><html><body style="margin:0;padding:24px;font:13px var(--vscode-font-family,system-ui);color:var(--vscode-descriptionForeground,#888);background:var(--vscode-editor-background,#1e1e1e)">正在加载插件…</body></html>';
    managerPanel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'install') return installVsix();
      if (message.type === 'install-url') return installFromUrl();
      if (message.type === 'repair-platform') return repairPlatformExtension();
      if (message.type === 'check-updates') return checkExtensionUpdates();
      if (message.type === 'open-plugin') return openPluginPicker();
      if (message.type === 'marketplace') return openPluginMarketplace();
      if (message.type === 'search-openvsx') return openPluginMarketplace();
      if (message.type === 'extension-actions') return showExtensionActions();
      if (message.type === 'open-extension') return openExtension(message.id);
      if (message.type === 'extension-menu') return showExtensionMenu(message.id);
      if (message.type === 'manager-more') return showManagerMore();
      if (message.type === 'logs') return openLogsFolder();
      if (message.type === 'log-content') return openExtensionHostLog();
      if (message.type === 'diagnose') return diagnoseExtensions();
      if (message.type === 'webview-devtools') {
        try { await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools'); }
        catch (error) { await vscode.window.showErrorMessage('无法打开 Webview 控制台：' + (error?.message || error)); }
        return;
      }
      if (message.type === 'folder') return openFolder();
      if (message.type === 'manager-view') {
        managerView = {
          scrollTop: Math.max(0, Number(message.scrollTop) || 0),
          filter: typeof message.filter === 'string' ? message.filter.slice(0, 200) : ''
        };
        return;
      }
      if (message.type === 'refresh') return refreshManagerPanel();
      if (message.type === 'reload') return vscode.commands.executeCommand('workbench.action.reloadWindow');
      if (message.type === 'activate-extension') {
        const extension = vscode.extensions.getExtension(message.id);
        if (!extension) {
          await vscode.window.showErrorMessage('找不到该扩展。');
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `正在激活 ${message.id}…` },
            () => extension.activate()
          );
          await vscode.window.showInformationMessage(`扩展已激活：${message.id}`);
          log(`已激活扩展 ${message.id}`);
        } catch (error) {
          log('激活扩展失败：' + (error?.message || error));
          await vscode.window.showErrorMessage(`激活 ${message.id} 失败：${error?.message || error}`);
        }
        refreshManagerPanel();
        return;
      }
      if (message.type === 'setting') {
        try { await registry.updateSetting(message.pluginId, message.sectionId, message.key, message.value); }
        catch (error) {
          log('保存插件设置失败：' + (error?.message || error));
          await vscode.window.showErrorMessage('保存插件设置失败：' + (error?.message || error));
        }
        return;
      }
      if (message.type === 'disable-extension' || message.type === 'enable-extension') {
        try { await setExtensionEnabled(message.id, message.type === 'enable-extension'); }
        catch (error) {
          log('切换扩展启用状态失败：' + (error?.message || error));
          await vscode.window.showErrorMessage('切换扩展启用状态失败：' + (error?.message || error));
        }
        refreshManagerPanel();
        return;
      }
      if (message.type === 'open-folder') {
        const target = (vscode.extensions.all || []).find(extension => extension.id === message.id)
          || (await listDisabledExtensions()).find(item => item.id === message.id);
        if (target?.extensionPath) await vscode.env.openExternal(vscode.Uri.file(target.extensionPath));
        return;
      }
      if (message.type === 'uninstall') return uninstallExtension(message.id);
    });
    refreshManagerPanel();
  }

  async function installFile(uri) {
    let installed = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在安装插件…' },
        () => vscode.commands.executeCommand('workbench.extensions.installExtension', uri)
      );
      installed = true;
    } catch (error) {
      log('安装 VSIX 失败：' + (error?.message || error));
      const choice = await vscode.window.showWarningMessage(
        '扩展安装命令不可用或失败：' + (error?.message || error) + '。是否使用内置解压安装？',
        { modal: true },
        '解压安装'
      );
      if (choice === '解压安装') {
        try { await manualInstall(uri.fsPath); }
        catch (installError) {
          log('解压安装失败：' + (installError?.message || installError));
          await vscode.window.showErrorMessage('解压安装失败：' + (installError?.message || installError));
        }
        return;
      }
      await vscode.window.showInformationMessage('已取消安装。也可以手动把 VSIX 解压到扩展目录后重启。');
      return;
    }
    if (!installed) return;
    await repairExecutableIntegrity(userExtensionsDirectory()).catch(() => {});
    refreshManagerPanel();
    await promptReload('插件已安装完成。需要重新加载窗口后启用插件。');
  }

  async function repairPlatformExtension(requestedExtension) {
    if (typeof fetch !== 'function') {
      await vscode.window.showErrorMessage('当前运行时没有 fetch，无法重新下载平台包。');
      return;
    }
    const platform = `${process.platform}-${process.arch}`;
    let extension = requestedExtension;
    if (!extension) {
      const candidates = (vscode.extensions.all || [])
        .filter(item => !isBuiltin(item) && item.id !== 'ubovm.ubovm-core')
        .map(item => ({
          label: item.packageJSON?.displayName || item.id,
          description: `${item.id}@${item.packageJSON?.version || '?'}`,
          detail: item.extensionPath,
          extension: item
        }));
      if (!candidates.length) {
        await vscode.window.showInformationMessage('没有可重装的用户扩展。');
        return;
      }
      const picked = await vscode.window.showQuickPick(candidates, {
        placeHolder: `选择要按 ${platform} 重新安装的扩展`,
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!picked) return;
      extension = picked.extension;
    }
    const [namespace, name] = String(extension.id).split('.');
    if (!namespace || !name) {
      await vscode.window.showErrorMessage('扩展 ID 无效。');
      return;
    }
    let detail;
    try {
      const response = await fetch(`https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/latest`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      detail = await response.json();
    } catch (error) {
      await vscode.window.showErrorMessage('查询 Open VSX 失败：' + (error?.message || error));
      return;
    }
    const version = detail?.version || extension.packageJSON?.version;
    const download = detail?.downloads?.[platform] || detail?.downloads?.universal;
    if (!version || typeof download !== 'string' || !/^https:\/\//i.test(download)) {
      await vscode.window.showErrorMessage(`Open VSX 没有 ${platform} 平台的 ${extension.id} 安装包。`);
      return;
    }
    const source = extension.extensionPath;
    const root = userExtensionsDirectory();
    const relative = path.relative(root, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      await vscode.window.showErrorMessage('扩展目录不在用户扩展目录内，拒绝替换。');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将删除并重装 ${extension.id}@${version}\n平台：${platform}\n来源：${download}\n当前目录：${source}\n继续？`,
      { modal: true },
      '重装'
    );
    if (confirmed !== '重装') return;
    const target = path.join(tmpdir(), `ubovm-repair-${randomUUID()}.vsix`);
    try {
      await downloadToFile(download, target);
      await rm(source, { recursive: true, force: true });
      await manualInstall(target);
    } catch (error) {
      log('重装平台包失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('重装平台包失败：' + (error?.message || error));
    } finally {
      await unlink(target).catch(() => {});
    }
  }

  function compareVersions(left, right) {
    const normalize = value => String(value || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 4).map(part => Number.parseInt(part, 10) || 0);
    const a = normalize(left);
    const b = normalize(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
    }
    return 0;
  }

  async function checkExtensionUpdates() {
    if (typeof fetch !== 'function') {
      await vscode.window.showErrorMessage('当前运行时没有 fetch，无法检查 Open VSX 更新。');
      return;
    }
    const platform = `${process.platform}-${process.arch}`;
    const extensions = (vscode.extensions.all || []).filter(item => !isBuiltin(item) && item.id !== 'ubovm.ubovm-core');
    if (!extensions.length) {
      await vscode.window.showInformationMessage('没有已安装的第三方插件。');
      return;
    }
    const updates = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在检查 Open VSX 更新…' },
      async () => {
        for (const extension of extensions) {
          const [namespace, name] = String(extension.id).split('.');
          if (!namespace || !name) continue;
          try {
            const response = await fetch(`https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/latest`, {
              headers: { accept: 'application/json' }
            });
            if (!response.ok) continue;
            const detail = await response.json();
            const installed = extension.packageJSON?.version || '0.0.0';
            if (detail?.version && compareVersions(detail.version, installed) > 0) {
              updates.push({
                label: extension.packageJSON?.displayName || extension.id,
                description: `${installed} → ${detail.version}`,
                detail: `${extension.id} · ${detail.downloads?.[platform] ? '有当前平台包' : '通用/其他平台'}`,
                extension
              });
            }
          } catch { /* offline or unpublished: leave the extension alone */ }
        }
      }
    );
    if (!updates.length) {
      await vscode.window.showInformationMessage('已安装插件都是最新版本。');
      return;
    }
    const picked = await vscode.window.showQuickPick(updates, {
      placeHolder: `发现 ${updates.length} 个可用更新`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;
    await repairPlatformExtension(picked.extension);
  }

  async function installVsix() {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: '安装插件',
      filters: { 'VS Code 扩展': ['vsix'] }
    });
    if (!picked?.length) return;
    return installFile(picked[0]);
  }

  async function installFromUrl() {
    if (typeof fetch !== 'function') {
      await vscode.window.showErrorMessage('当前运行时没有 fetch，无法从 URL 安装。请下载 VSIX 后本地安装。');
      return;
    }
    const url = await vscode.window.showInputBox({
      prompt: '输入 VSIX 文件的 https 地址',
      placeHolder: 'https://example.com/extension.vsix',
      validateInput: value => /^https:\/\//i.test(String(value || '')) ? undefined : '只支持 https URL'
    });
    if (!url) return;
    try { await downloadAndInstall(url, 'vsix'); }
    catch (error) {
      log('从 URL 安装 VSIX 失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('从 URL 安装插件失败：' + (error?.message || error));
    }
  }

  const MAX_VSIX_BYTES = 2 * 1024 * 1024 * 1024;

  async function downloadToFile(url, target, maxBytes = MAX_VSIX_BYTES) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response?.ok) throw new Error(`HTTP ${response?.status || '?'}`);
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > maxBytes) throw new Error(`VSIX 超过 ${Math.round(maxBytes / 1024 / 1024)}MB（${Math.round(declared / 1024 / 1024)}MB）`);
    try {
      if (response.body && typeof Readable.fromWeb === 'function') {
        // Stream to disk: large platform VSIX files must not be buffered whole
        // in the extension host's memory.
        await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`VSIX 超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
        await writeFile(target, buffer);
      }
      const size = (await stat(target)).size;
      if (!size) throw new Error('下载内容为空');
      if (size > maxBytes) throw new Error(`VSIX 超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
  }

  async function downloadAndInstall(url, label = 'vsix') {
    if (!/^https:\/\//i.test(String(url || ''))) throw new Error('只支持 https 下载地址');
    const target = path.join(tmpdir(), `ubovm-${label}-${randomUUID()}.vsix`);
    try {
      await downloadToFile(url, target);
      await installFile(vscode.Uri.file(target));
    } finally {
      await unlink(target).catch(() => {});
    }
  }

  function engineCompatible(range) {
    const current = String(vscode.version || '0.0.0').split('.').map(Number);
    if (![0, 1, 2].every(index => Number.isFinite(current[index]))) return true;
    const match = /^(\^|~|>=)?\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(range || ''));
    if (!match) return true;
    const [, operator, majorText, minorText] = match;
    const major = Number(majorText), minor = Number(minorText);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
    if (operator === '^' || operator === '~') return current[0] === major && current[1] >= minor;
    if (operator === '>=') return current[0] > major || (current[0] === major && current[1] >= minor);
    return current[0] === major && current[1] === minor;
  }

  /** Resolve the platform-specific VSIX instead of Open VSX's default download. */
  async function resolveOpenVsxDownload(item, platform) {
    const direct = item?.downloads?.[platform];
    if (typeof direct === 'string' && /^https:\/\//i.test(direct)) return direct;
    const namespace = encodeURIComponent(item?.namespace || '');
    const name = encodeURIComponent(item?.name || '');
    const version = encodeURIComponent(item?.version || 'latest');
    if (!namespace || !name) throw new Error('Open VSX 返回的扩展信息不完整');
    const response = await fetch(`https://open-vsx.org/api/${namespace}/${name}/${version}`, {
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const detail = await response.json();
    const download = detail?.downloads?.[platform] || detail?.downloads?.universal || detail?.files?.download;
    if (typeof download !== 'string' || !/^https:\/\//i.test(download)) {
      throw new Error(`Open VSX 没有适用于 ${platform} 的安装包`);
    }
    return download;
  }

  /** Search Open VSX and install a compatible extension without the workbench gallery. */
  async function searchOpenVsx() {
    if (typeof fetch !== 'function') {
      await vscode.window.showErrorMessage('当前运行时没有 fetch，无法搜索 Open VSX。');
      return;
    }
    const platform = `${process.platform}-${process.arch}`;
    const query = await vscode.window.showInputBox({
      prompt: '搜索 Open VSX 扩展',
      placeHolder: '例如 security、python、git、docker',
      value: 'security'
    });
    if (!query) return;
    let data;
    try {
      const searchUrl = targetPlatform => {
        const params = new URLSearchParams({
          query,
          size: '30',
          includeAllVersions: 'false'
        });
        // Ask for the current platform first so extensions with native binaries
        // install a compatible build; fall back to the universal feed below.
        if (targetPlatform) params.set('targetPlatform', targetPlatform);
        return `https://open-vsx.org/api/-/search?${params.toString()}`;
      };
      let response = await fetch(searchUrl(platform), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
      if (!Array.isArray(data?.extensions) || !data.extensions.length) {
        response = await fetch(searchUrl(''), { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      }
    } catch (error) {
      log('Open VSX 搜索失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('Open VSX 搜索失败：' + (error?.message || error));
      return;
    }
    const items = (Array.isArray(data?.extensions) ? data.extensions : [])
      .filter(item => engineCompatible(item?.engines?.vscode))
      .map(item => ({
        label: item.displayName || item.name || '未命名扩展',
        description: `${item.namespace}.${item.name}@${item.version || '?'}`,
        detail: `${(item.description || '').slice(0, 180)} · engines.vscode ${item?.engines?.vscode || '?'} · ${platform}`,
        extension: item
      }));
    if (!items.length) {
      await vscode.window.showInformationMessage('没有找到与当前 IDE 版本兼容的 Open VSX 扩展。');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Open VSX 搜索结果（${items.length} 个兼容扩展）`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;
    let download;
    try {
      download = await resolveOpenVsxDownload(picked.extension, platform);
    } catch (error) {
      log('解析 Open VSX 平台包失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('无法获取当前平台的安装包：' + (error?.message || error));
      return;
    }
    const install = await vscode.window.showWarningMessage(
      `安装 ${picked.description}？\n平台：${platform}\n下载地址：${download}`,
      { modal: true },
      '安装'
    );
    if (install !== '安装') return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在下载 ${picked.label}…` },
        () => downloadAndInstall(download, 'openvsx')
      );
    } catch (error) {
      log('Open VSX 安装失败：' + (error?.message || error));
      await vscode.window.showErrorMessage('Open VSX 安装失败：' + (error?.message || error));
    }
  }

  async function showInstalled() {
    const summaries = new Map((registry?.uiState?.().tools || []).map(item => [item.pluginId, item]));
    const items = [];
    for (const extension of vscode.extensions.all || []) {
      const pkg = extension.packageJSON || {};
      const builtin = isBuiltin(extension);
      const pluginTools = summaries.get(extension.id);
      items.push({
        label: pkg.displayName || pkg.name || extension.id,
        description: `${extension.id} · v${pkg.version || '?'}`,
        detail: `${builtin ? '内置扩展' : '已安装扩展'} · ${extension.isActive ? '已激活' : '未激活'}${pluginTools ? ' · 已注册 UBOVM 工具' : ''} · ${extension.extensionPath}`,
        extension
      });
    }
    items.sort((a, b) => Number(b.extension.id === 'ubovm.ubovm-core') - Number(a.extension.id === 'ubovm.ubovm-core')
      || a.extension.id.localeCompare(b.extension.id));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '已安装的 VS Code 扩展；选择后可打开目录或卸载',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: '打开插件管理面板', id: 'view' },
        { label: '打开扩展目录', id: 'folder' },
        { label: '卸载该扩展', id: 'uninstall' }
      ],
      { placeHolder: picked.label }
    );
    if (!action) return;
    if (action.id === 'folder') return openFolder();
    if (action.id === 'view') return showManagerPanel();
    return uninstallExtension(picked.extension.id);
  }

  // Existing marketplace-installed plugins predate the install-time label
  // repair. Fix bundled executables in the background so CLI-backed plugins
  // can write their normal user state directories after a restart.
  if (process.platform === 'win32') {
    void repairExecutableIntegrity(userExtensionsDirectory())
      .then(count => { if (count) log(`已修复 ${count} 个插件可执行文件完整性标签。`); })
      .catch(() => {});
  }

  return { installVsix, installFromUrl, searchOpenVsx, showInstalled, openPluginPicker, openPluginMarketplace, openFolder, showExtensionView, showManagerPanel, extensionsDirectory };
}

module.exports = { createPluginManager, repairExecutableIntegrity };
