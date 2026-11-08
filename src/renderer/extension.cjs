'use strict';

const vscode = require('vscode');
const { normalize: normalizeError, text: errorText } = require('./webview/errors.js');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
const { open, readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { homedir } = require('node:os');
const { createSessions, inputMessageIds } = require('./harness/session/sessions.cjs');
const { createDefaultWorkspace, ensureDefaultWorkspace } = require('./harness/workspace/default-workspace.cjs');
const { createModelConfiguration } = require('./harness/config/model-config.cjs');
const { createSettingsConfiguration, hydrateRuntime, readSSHConfiguration, resolveSSHTestProfile, readSSHStatus } = require('./harness/config/settings-config.cjs');
const { createSSHConnectionTest } = require('./host/system/ssh-connection-test.cjs');
const { createModelConnectionTest } = require('./host/system/model-connection-test.cjs');
const { keyFor: modelKeyFor, modelConfig: parseModelConfig } = require('./harness/config/model-config.cjs');
const { createHarnessService } = require('./host/agent/agent-service.cjs');
const { createInstallTools } = require('./host/agent/install-tools.cjs');
const { createWorkspaceSearch } = require('./harness/workspace/workspace-search.cjs');

/**
 * VS Code extensions often call process.cwd() or spawn CLIs that inherit it.
 * The extension host normally starts in the application directory; point it at
 * the first workspace folder so third-party tools see the user's project.
 */
function syncWorkspaceWorkingDirectory() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!folder) return { skipped: true };
  try {
    const resolved = path.resolve(folder);
    if (path.resolve(process.cwd()) !== resolved) process.chdir(resolved);
    process.env.UBOVM_WORKSPACE_ROOT = resolved;
    if (process.platform !== 'win32') process.env.PWD = resolved;
    return { folder: resolved };
  } catch (error) {
    return { folder, error };
  }
}
const { createWorkspaceAudit } = require('./harness/workspace/workspace-audit.cjs');
const { createWorkspaceValidation } = require('./harness/workspace/workspace-validation.cjs');
const { captureSelection } = require('./harness/workspace/selection-context.cjs');
const { createCodingService } = require('./harness/coding/coding-service.cjs');
const { copyText, openMessageLink } = require('./harness/session/message-actions.cjs').createMessageActions(vscode);
const { renderWebview } = require('./host/ui/webview.cjs');
const { createBlackboardSidebar } = require('./host/ui/blackboard-sidebar.cjs');
const { createGoalChatPanel } = require('./host/ui/goal-chat-panel.cjs');
const { createExecutionPublisher } = require('./host/agent/state-publisher.cjs');
const { createTerminalService } = require('./host/system/terminal-service.cjs');
const { readTheme, setTheme } = require('./host/system/theme.cjs');
const { interfaceText, setInterfaceLocale, currentInterfaceLocale } = require('./harness/runtime/interface-text.cjs');
const { imageRoot, saveImage, loadImage, isManagedImage, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } = require('./harness/attachments/image-store.cjs');
const { createPluginRegistry } = require('./host/plugins/plugin-registry.cjs');
const { createPluginManager } = require('./host/plugins/plugin-manager.cjs');

let shutdownHarness = async () => {};
const uiText = (message, ...args) => interfaceText(message, ...args);
function interfaceLocale() {
  return String(vscode.env?.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

const UI_REVISION = 15;
const UI_KEYS = [
  'workbench.colorTheme', 'window.autoDetectColorScheme', 'window.titleBarStyle',
  'workbench.editor.restoreEditors', 'window.restoreWindows', 'files.hotExit',
  'terminal.integrated.enablePersistentSessions', 'workbench.startupEditor',
  'window.menuBarVisibility', 'window.enableMenuBarMnemonics', 'window.customMenuBarAltFocus', 'window.commandCenter', 'window.density.editorTabHeight',
  'workbench.browser.showInTitleBar',
  'workbench.experimental.modernUI', 'workbench.experimental.modernUIUppercaseViewHeaders',
  'workbench.activityBar.location', 'workbench.sideBar.location',
  'workbench.secondarySideBar.defaultVisibility', 'workbench.secondarySideBar.forceMaximized',
  'workbench.secondarySideBar.showLabels', 'workbench.layoutControl.type',
  'workbench.editor.tabSizing', 'workbench.tree.indent', 'workbench.tree.renderIndentGuides',
  'workbench.statusBar.visible', 'breadcrumbs.enabled', 'explorer.compactFolders',
  'workbench.editor.openSideBySideDirection', 'workbench.editor.closeEmptyGroups', 'chat.disableAIFeatures',
  'workbench.navigationControl.enabled', 'workbench.layoutControl.enabled',
  'workbench.editor.editorActionsLocation', 'workbench.editor.enablePreview',
  'workbench.editor.enablePreviewFromQuickOpen', 'workbench.editor.enablePreviewFromCodeNavigation',
  'workbench.editor.dragToOpenWindow', 'editor.glyphMargin'
];

/** @param {import('vscode').ExtensionContext} context */
function publishInterfaceLocale() {
  void vscode.commands.executeCommand('setContext', 'ubovm.interfaceLocale', currentInterfaceLocale() === 'en' ? 'en' : 'zh-CN');
}

async function activate(context) {
  // Activation-to-first-paint timing is written to the UBOVM output channel so a
  // slow start can be measured from a user log instead of guessed.
  const activatedAt = Date.now();
  setInterfaceLocale(context.globalState.get('ubovm.interfaceLocale') === 'en' ? 'en' : 'zh-CN');
  publishInterfaceLocale();
  // The Explorer path bar stays off; undo the short-lived migration that turned
  // breadcrumbs on for builds shipping them as a default.
  if (context.globalState && context.globalState.get('ubovm.breadcrumbsDefault') && !context.globalState.get('ubovm.breadcrumbsDefaultOff')) {
    try {
      const breadcrumbs = vscode.workspace.getConfiguration?.('breadcrumbs');
      if (breadcrumbs?.get?.('enabled') === true) {
        const applied = breadcrumbs.update?.('enabled', false, vscode.ConfigurationTarget?.Global);
        if (applied && typeof applied.catch === 'function') applied.catch(() => {});
      }
    } catch { /* Best effort: a missing migration must not block activation. */ }
    try { void Promise.resolve(context.globalState.update?.('ubovm.breadcrumbsDefaultOff', true)).catch(() => {}); }
    catch { /* Best effort. */ }
  }
  let welcome;
  let welcomeReady = false;
  let lastViewAlive = Date.now();
  let crashRecoveryTimer;
  let crashRecoveryAttempts = 0;
  let crashRecoveryWindowStart = 0;
  let viewRevision = 0;
let restoreRetryAt = 0;
  let readyPublishTimer;
  let editorPublishTimer;
  let visibilityPublishTimer;
  let publishStateTimer;
  let openingConversation;
  let maintainingLayout = false;
  let sideGroupSized = false;
  let shuttingDown = false;
  let layoutTimer;
  let sessionsView;
  let settingsPage = '', settingsSection = 'model';
  const settingsNavigation = [['model', '模型配置', 'settings-gear'], ['ssh', 'SSH 连接', 'remote'], ['web', '浏览器与搜索', 'globe'], ['python', 'Python 执行', 'terminal'], ['summary', '上下文与摘要', 'note'], ['reason', '规划设置', 'list-tree'], ['worker', '任务执行', 'play']];
  const sidebarChanged = new vscode.EventEmitter();
  let publishedMode;
  let publishedRunningModes = '';
  // Undefined keeps the native default view title, which the workbench
  // localizes to the same value as the container title. The merged single-view
  // header then renders exactly once instead of "Container: View". Settings
  // pages set an explicit short page title.
  let publishedSidebarTitle;
  let publishedWorkspaceLabel = '';
  let folderCheckTimer;
  let folderCheckRevision = 0;
  let explorerReady = false;
  let explorerWorkspace;
  const sessionExplorer = require('./host/ui/session-explorer.cjs').createSessionExplorer(vscode, { onDidChangeFiles: scheduleFolderCheck });
  context.subscriptions.push(sessionExplorer);
  const fileContexts = new Map();
  const pendingImages = new Map();
  const attachmentRoot = imageRoot();
  mkdirSync(attachmentRoot, { recursive: true });
  function imageView(image) {
    let uri = '';
    try { uri = welcome?.webview.asWebviewUri(vscode.Uri.file(image.path)).toString() ?? ''; }
    catch { uri = ''; }
    return { ...image, uri };
  }
  let messageQueue = Promise.resolve();
  // Rapid tree/mode clicks used to enqueue a full conversation switch for every
  // event. Collapse them to the latest request so an intermediate snapshot can
  // never leave the old conversation behind a route loader.
  let navigationTicket = 0;
  function navigationAction(run) {
    const ticket = ++navigationTicket;
    const operation = messageQueue.then(async () => {
      if (ticket !== navigationTicket) return undefined;
      return run();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }
  let harness;
  let executionPublisher;
  let settingsOpenRevision = 0;
  let settingsOpening = 0;
  let recovering = true;
  let chromeLockedSessionId;
  let chromeLockWatchdog;
  let switchingTheme = false;
  let recoveryTimer;
  let releaseFirstPaint;
  const firstPaint = new Promise(resolve => { releaseFirstPaint = resolve; });
  function registerCommand(name, handler) {
    return vscode.commands.registerCommand(name, async (...args) => {
      try { return await handler(...args); }
      catch (error) {
        const failure = normalizeError(error, name);
        output.appendLine(name + ': ' + failure.detail);
        throw Object.assign(new Error(errorText(failure)), { code: failure.code });
      }
    });
  }
  const restoreErrors = new Map();
  // Must be initialized before activation can publish its first state: some
  // startup callbacks run synchronously before the lower-level declarations.
  const executionMemoryCache = new Map();
  const EXECUTION_MEMORY_CACHE_LIMIT = 4;
  function rememberExecutionMemory(conversationId, memory) {
    executionMemoryCache.delete(conversationId);
    executionMemoryCache.set(conversationId, memory);
    // Agent memory can be megabytes; retain only the conversations most likely
    // to be shown again instead of one snapshot per historical session.
    while (executionMemoryCache.size > EXECUTION_MEMORY_CACHE_LIMIT) {
      executionMemoryCache.delete(executionMemoryCache.keys().next().value);
    }
  }
  const modelConfiguration = createModelConfiguration(vscode, context);
  const settingsConfiguration = createSettingsConfiguration(vscode, context);
  const output = vscode.window.createOutputChannel('UBOVM');
  // Mirror the output channel into a bounded tail so a support bundle can be
  // exported without asking the user to copy logs manually.
  const diagnosticTail = [];
  const appendOutputLine = output.appendLine.bind(output);
  output.appendLine = value => {
    appendOutputLine(value);
    diagnosticTail.push(String(value ?? ''));
    if (diagnosticTail.length > 400) diagnosticTail.shift();
  };
  // UBOVM renders the right-side-bar tabs through VS Code's composite bar in
  // the pane title row. The workbench only creates that bar while the activity
  // bar location is top/bottom; "hidden" (the activity-bar visibility toggle)
  // silently removes Worker logs / Blackboard / Exploration chat tabs. There is
  // no separate activity bar in this layout, so keep the location on a tabbed
  // position and repair already-persisted "hidden"/"default" profiles.
  const normalizeSidebarTabStrip = async () => {
    try {
      const configuration = vscode.workspace.getConfiguration('workbench');
      const location = configuration.get('activityBar.location');
      if (location !== 'top' && location !== 'bottom') {
        await configuration.update('activityBar.location', 'top', vscode.ConfigurationTarget.Global);
      }
    } catch (error) { output.appendLine('侧栏标签布局：' + String(error)); }
  };
  void normalizeSidebarTabStrip();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('workbench.activityBar.location')) void normalizeSidebarTabStrip();
  }));
  const syncExtensionCwd = () => {
    const result = syncWorkspaceWorkingDirectory();
    if (result.error) output.appendLine('插件工作目录切换失败：' + String(result.error));
    else if (result.folder) output.appendLine('插件工作目录：' + result.folder);
    return result;
  };
  syncExtensionCwd();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(syncExtensionCwd));
  context.subscriptions.push(new vscode.Disposable(() => { shuttingDown = true; try { void ideBrowserHost?.endAgentTask?.(); } catch { /* best effort */ } clearTimeout(layoutTimer); clearTimeout(recoveryTimer); clearTimeout(chromeLockWatchdog); releaseFirstPaint(); executionPublisher?.dispose(); void shutdownHarness().catch(error => output.appendLine(String(error))); }), output);
  // Persist commits are frequent during streaming; coalesce so the host thread
  // is not rebuilding full conversation snapshots on every message write.
  const sessions = createSessions(vscode, context, () => schedulePublishState(), { isBusy: id => harness?.isBusy(id) === true, createWorkspace: createDefaultWorkspace });
  let creatingProject = false;
  let pendingProjectSwitcher = null;
  const blackboardSidebar = createBlackboardSidebar(vscode, {
    onAction: onMessage,
    onSelect: (id, sessionId) => welcome?.webview.postMessage({ type: 'selectBlackboardNode', id, sessionId }),
    onClose: () => welcome?.webview.postMessage({ type: 'closeBlackboardDetails' }),
    onError: error => output.appendLine('黑板详情：' + String(error))
  });
  context.subscriptions.push(blackboardSidebar, vscode.window.registerWebviewViewProvider('ubovm.blackboardDetails', blackboardSidebar, { webviewOptions: { retainContextWhenHidden: true } }));
  const workerPanel = require('./host/ui/worker-panel.cjs').createWorkerPanel(vscode, {
    readState: () => {
      const current = sessions.summary(), execution = assistantExecution(current, { includeLogHistory: false });
      return { sessionId: current.id, workers: execution.workers || [], error: execution.workerViewError?.message };
    },
    onAction: onMessage,
    onError: error => output.appendLine(String(error))
  });
  context.subscriptions.push(workerPanel, vscode.window.registerWebviewViewProvider('ubovm.workerLogs', workerPanel, { webviewOptions: { retainContextWhenHidden: true } }));
  // Exploration chat lives in its own right-side-bar tab next to the file tree,
  // like Copilot Chat. It is a read-only progress Q&A over the goal projection.
  const goalChatPanel = createGoalChatPanel(vscode, {
    onAction: (message, panel) => handleGoalChatPanelAction(message, panel),
    onError: error => output.appendLine('探索对话：' + String(error)),
    // The header button reflects the live sidebar state, so a manual tab switch
    // or a collapsed sidebar must refresh the main page's toggle.
    onVisibilityChange: () => { if (!shuttingDown) schedulePublishState(); }
  });
  context.subscriptions.push(goalChatPanel, vscode.window.registerWebviewViewProvider('ubovm.goalChat', goalChatPanel, { webviewOptions: { retainContextWhenHidden: true } }));
  // The exploration sidebar is a tab strip (Worker logs / Blackboard / chat).
  // Opening a container pins its tab; a profile whose tabs were closed would
  // otherwise silently fall back to a single chat tab. Re-open the three
  // containers once per activation when the exploration surface is in use.
  let explorationSidebarTabsReady = false;
  async function ensureExplorationSidebarTabs({ force = false } = {}) {
    if ((explorationSidebarTabsReady && !force) || shuttingDown) return;
    const restoredKey = 'ubovm.explorationTabsRestoredV1';
    if (!force && context.workspaceState.get(restoredKey) === true) { explorationSidebarTabsReady = true; return; }
    explorationSidebarTabsReady = true;
    let restored = 0;
    for (const id of ['workbench.view.extension.ubovm-workers', 'workbench.view.extension.ubovm-blackboard', 'workbench.view.extension.ubovm-goal-chat']) {
      if (shuttingDown) return;
      try { await vscode.commands.executeCommand(id); restored++; } catch { /* Optional container in older workbench builds. */ }
    }
    // Only remember a complete restore; a workbench without one of the containers
    // should retry on the next activation instead of silently locking the tab strip.
    if (restored === 3) await context.workspaceState.update(restoredKey, true).catch?.(() => {});
  }
  // The complete board and graph are the largest projections and change far less
  // often than the live execution tick (75-750ms). Remember the last revision
  // that was actually delivered and omit them from unchanged ticks; the webview
  // merges the missing keys from its last full execution snapshot. The agenda
  // stays in every tick because Reason's directions can change without a
  // blackboard revision. A revision is only committed after postMessage accepts
  // it (see below): committing at read time would suppress the blackboard for the
  // rest of the run when the delivery then failed, leaving the panel stale.
  const executionHeavyRevision = new Map();
  const executionMemoryRevision = new Map();
  const heavyRevisionOf = execution => [execution?.blackboard?.revision, execution?.graph?.revision].join('|');
  executionPublisher = createExecutionPublisher({
    currentId: () => sessions.summary().id,
    canPublish: () => !shuttingDown && (workerPanel.visible === true || conversationNeedsSnapshot()),
    readExecution: () => {
      const current = sessions.summary();
      const execution = assistantExecution(current, { includeLogHistory: false });
      const revision = heavyRevisionOf(execution);
      if (executionHeavyRevision.get(current.id) === revision) {
        delete execution.blackboard; delete execution.graph;
      }
      // Notes are written by the `note` tool without changing the blackboard
      // revision. Keep publishing memory whenever its own revision changes,
      // otherwise an assist notebook appears empty until the next full state.
      const memoryRevision = execution.memory?.revision ?? null;
      if (execution.memory !== undefined && memoryRevision !== null && executionMemoryRevision.get(current.id) === memoryRevision) delete execution.memory;
      return execution;
    },
    postMessage: message => {
      // Worker delivery owns its own bounded queue. A slow or closing sidebar
      // must not hold the main conversation's streaming publication open.
      if (message.type === 'executionState') {
        void workerPanel.publish({ sessionId: message.conversationId, workers: message.execution.workers || [], error: message.execution.workerViewError?.message });
        // Carry host recovery chrome on execution ticks so a post-restore
        // publish does not need a second full transcript snapshot.
        // Missing heavy projections mean "keep the previous ones" in the webview.
        message = { ...message, recovering, ...(message.execution && !('blackboard' in message.execution) ? { partialExecution: true } : {}) };
      }
      if (!conversationNeedsSnapshot()) return undefined;
      // Full snapshots already carry a revision from publishState; do not burn a second slot.
      const revision = Number.isInteger(message.viewRevision) ? message.viewRevision : ++viewRevision;
      const target = welcome.webview.postMessage({ ...message, viewRevision: revision });
      // Commit only after the conversation bridge accepts the publication. If it
      // rejects or returns false (or the caller later times out on it), the next
      // read must resend the blackboard/graph instead of assuming they arrived.
      const execution = message.execution;
      const conversationId = message.type === 'executionState' ? message.conversationId : message.conversation?.id;
      const carriesHeavy = Boolean(execution && (Object.hasOwn(execution, 'blackboard') || Object.hasOwn(execution, 'graph')));
      const memoryRevision = execution?.memory?.revision;
      const commit = () => {
        if (!conversationId) return;
        if (carriesHeavy) executionHeavyRevision.set(conversationId, heavyRevisionOf(execution));
        if (execution && Object.hasOwn(execution, 'memory') && memoryRevision !== undefined && memoryRevision !== null) executionMemoryRevision.set(conversationId, memoryRevision);
      };
      if (target && typeof target.then === 'function') {
        try { target.then(value => { if (value !== false) commit(); }, () => {}); } catch { /* The next read resends the projection. */ }
      } else if (target !== false) commit();
      return target;
    },
    onError: error => output.appendLine(String(error))
  });
  const sdkCandidates = [process.env.UBOVM_HARNESS_ENTRY, path.resolve(__dirname, '../harness/index.mjs'), path.join(vscode.env.appRoot, 'ubovm/harness/index.mjs')].filter(Boolean);
  const sdkPath = sdkCandidates.find(candidate => existsSync(candidate));
  if (process.platform === 'win32' && sdkPath) {
    // Do not block the IDE's initial paint on native sandbox provisioning.
    void import(pathToFileURL(path.join(path.dirname(sdkPath), 'intools', 'terminals', 'python', 'setup.mjs')).href)
      .then(({ setupPythonSandbox }) => setupPythonSandbox({ automatic: true }))
      .then(result => { output.appendLine('[Python 沙箱] ' + result.message); if (result.cancelled) void vscode.window.showWarningMessage(result.message); })
      .catch(error => {
        output.appendLine('[Python 沙箱自动初始化失败] ' + errorText(error));
        void vscode.window.showWarningMessage('Python 沙箱自动初始化失败：' + errorText(error) + '。可运行“UBOVM: 初始化 Python 沙箱”重试。');
      });
  }
  const { createBrowserInstaller, BROWSER_PATH_KEY } = require('./host/system/browser-install.cjs');
  const { createIdeBrowserHost } = require('./host/system/ide-browser-host.cjs');
  const browserInstaller = createBrowserInstaller({
    sdkPath: sdkPath ?? sdkCandidates[0],
    cachedPath: context.globalState.get(BROWSER_PATH_KEY),
    onReady: executablePath => { void context.globalState.update(BROWSER_PATH_KEY, executablePath); }
  });
  // The browser host reports when an agent drives a page the user cannot see.
  // The conversation shows a floating click-through affordance instead of the
  // browser editor being pulled to the front.
  let browserAgentActivity;
  const ideBrowserHost = createIdeBrowserHost(vscode, {
    onActivity: event => {
      const next = event?.active === true
        ? { pageId: typeof event.pageId === 'string' ? event.pageId : null, url: typeof event.url === 'string' ? event.url : '', title: typeof event.title === 'string' ? event.title : '' }
        : undefined;
      if (JSON.stringify(next ?? null) === JSON.stringify(browserAgentActivity ?? null)) return;
      browserAgentActivity = next;
      try { schedulePublishState(); } catch { /* the next snapshot republishes the state */ }
    }
  });
  context.subscriptions.push({ dispose: () => ideBrowserHost.dispose() });
  // VS Code extensions extend UBOVM through this registry (agent tools and
  // declarative contributions for UBOVM-owned pages). The exported object is
  // read by plugins via vscode.extensions.getExtension('ubovm.ubovm-core').
  const pluginRegistry = createPluginRegistry({
    vscode,
    onChange: () => { try { schedulePublishState(80); } catch { /* next snapshot republishes */ } },
    log: text => output.appendLine(text),
    settings: {
      read: pluginId => context.globalState.get(`ubovm.pluginSettings.${pluginId}`, {}),
      write: (pluginId, value) => context.globalState.update(`ubovm.pluginSettings.${pluginId}`, value)
    },
    state: {
      read: pluginId => context.globalState.get(`ubovm.pluginState.${pluginId}`, {}),
      write: (pluginId, value) => context.globalState.update(`ubovm.pluginState.${pluginId}`, value)
    }
  });
  const pluginManager = createPluginManager({ vscode, context, registry: pluginRegistry, log: text => output.appendLine(text) });
  context.subscriptions.push({ dispose: () => pluginRegistry.dispose() });
  context.subscriptions.push(vscode.extensions.onDidChange(() => {
    // Uninstall/disable must not leave stale tools, slots or settings behind.
    try { pluginRegistry.prune(); } catch { /* next activation retries */ }
  }));
  module.exports.ubovm = pluginRegistry.api;
  module.exports.ubovmApi = pluginRegistry.api;
  // Plugins may ship SKILL.md directories and MCP servers; merge them into the
  // harness config without mutating the user's saved settings.
  function withPluginContributions(configuration) {
    let result = configuration;
    const directories = pluginRegistry.skillDirectories().filter(directory => existsSync(directory));
    if (directories.length) {
      const current = configuration?.skills && typeof configuration.skills === 'object' ? configuration.skills : {};
      const existing = Array.isArray(current.directories) ? current.directories : [];
      result = { ...result, skills: { ...current, directories: [...new Set([...existing, ...directories])] } };
    }
    const servers = pluginRegistry.mcpServers();
    if (servers.length) {
      const current = result?.mcp && typeof result.mcp === 'object' ? result.mcp : {};
      const existing = Array.isArray(current.servers) ? current.servers : [];
      const names = new Set(existing.map(server => server?.name));
      const additions = [];
      for (const server of servers) {
        if (names.has(server.name)) continue;
        names.add(server.name);
        additions.push(server);
      }
      if (additions.length) result = { ...result, mcp: { ...current, servers: [...existing, ...additions] } };
    }
    return result;
  }
  const pluginRunState = new Map();
  let browserInstallOperation;
  let lastBrowserProgressPost = 0;
  function postBrowserProgress(payload, target) {
    const now = Date.now();
    // Heartbeat even without percent so the wizard does not look frozen during
    // indeterminate Playwright phases; percent updates share the same cadence.
    if (now - lastBrowserProgressPost < 400) return;
    lastBrowserProgressPost = now;
    const webview = target?.webview ?? welcome?.webview;
    void webview?.postMessage({ type: 'settingsBrowserInstallProgress', ...payload, installation: browserInstaller.status() });
  }
  function installBrowser(notifyError = true, target) {
    if (browserInstallOperation) return browserInstallOperation;
    browserInstallOperation = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在下载并安装内置浏览器…', cancellable: true }, async (progress, token) => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const cancel = token.onCancellationRequested(() => {
        browserInstaller.cancel('浏览器安装已取消。');
        controller?.abort();
      });
      try {
        const executablePath = await browserInstaller.install({
          signal: controller?.signal,
          onLog: text => output.append(text),
          onProgress: update => {
            progress.report({ message: update.message || (update.percent != null ? `${update.percent}%` : undefined) });
            postBrowserProgress(update, target);
          }
        });
        output.appendLine('内置浏览器已就绪：' + executablePath);
        void vscode.window.showInformationMessage('内置浏览器已安装，可立即使用（已有外部浏览器配置优先）。');
        return { ok: true, message: '内置浏览器已安装，可立即使用。' };
      } catch (error) {
        output.appendLine(String(error));
        if (error?.cancelled) return { ok: false, cancelled: true, message: errorText(error) || '浏览器安装已取消。' };
        if (notifyError) void vscode.window.showErrorMessage('内置浏览器安装失败：' + errorText(error));
        return { ok: false, message: errorText(error), failure: normalizeError(error, 'settingsInstallBrowser') };
      } finally { cancel.dispose(); }
    }).finally(() => { browserInstallOperation = undefined; lastBrowserProgressPost = 0; });
    return browserInstallOperation;
  }
  const sshConnectionTest = createSSHConnectionTest({ loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'terminals', 'ssh-terminal', 'commands.mjs')).href) });
  context.subscriptions.push(sshConnectionTest);
  const modelConnectionTest = createModelConnectionTest({
    loadModelClient: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'index.mjs')).href)
  });
  context.subscriptions.push(modelConnectionTest);
  const terminalService = createTerminalService(vscode, {
    readConfiguration: () => readSSHConfiguration(vscode, context),
    loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'terminals', 'ssh-terminal', 'commands.mjs')).href),
    openSettings: () => openSettings('settings', 'ssh'),
    // Persist a default picked from the terminal flow. The settings save also
    // re-validates the profile ids, so a dropped profile cannot stay default.
    setDefaultProfile: async profileId => {
      const ssh = await readSSHConfiguration(vscode, context);
      await settingsConfiguration.save('ssh', { profiles: ssh.profiles, defaultId: profileId });
      try { schedulePublishState(); } catch { /* the next snapshot republishes it */ }
    }
  });
  context.subscriptions.push(terminalService, ...terminalService.register());
  // A conversation may target one of several configured Linux servers. The
  // override is per conversation and only selects which profile the agent uses;
  // the machine-wide default stays untouched. Matching the settings and
  // terminal UI, a stale default falls back to the first configured profile.
  const sshHostOverrides = new Map();
  function sshSettings() {
    const entry = vscode.workspace.getConfiguration('ubovm').inspect('intools');
    const ssh = (entry?.globalValue ?? entry?.defaultValue)?.ssh;
    const profiles = Array.isArray(ssh?.profiles) ? ssh.profiles : [];
    const defaultId = profiles.some(profile => profile.id === ssh?.defaultId) ? ssh.defaultId : profiles[0]?.id;
    return { profiles, defaultId };
  }
  const sshHostLabel = profile => profile?.name || (profile ? `${profile.username}@${profile.host}` : '');
  function activeSshHost(conversationId) {
    const { profiles, defaultId } = sshSettings();
    const override = conversationId ? sshHostOverrides.get(conversationId) : undefined;
    const activeId = profiles.some(profile => profile.id === override) ? override : defaultId;
    const profile = profiles.find(profile => profile.id === activeId);
    return { profile, activeId, defaultId, sessionScoped: Boolean(profile) && activeId !== defaultId };
  }
  function applySshHostOverride(configuration, conversationId) {
    const ssh = configuration?.intools?.ssh;
    const profiles = Array.isArray(ssh?.profiles) ? ssh.profiles : [];
    if (!profiles.length) return configuration;
    const override = conversationId ? sshHostOverrides.get(conversationId) : undefined;
    const defaultId = profiles.some(profile => profile.id === ssh.defaultId) ? ssh.defaultId : profiles[0].id;
    const activeId = profiles.some(profile => profile.id === override) ? override : defaultId;
    if (activeId === ssh.defaultId) return configuration;
    return { ...configuration, intools: { ...configuration.intools, ssh: { ...ssh, defaultId: activeId } } };
  }
  function sshStatusFor(conversationId) {
    const status = readSSHStatus(vscode);
    if (!status.configured) return status;
    const { profile, sessionScoped } = activeSshHost(conversationId);
    if (!profile) return status;
    return { ...status, active: { id: profile.id, label: sshHostLabel(profile), host: profile.host, port: profile.port ?? 22, scope: sessionScoped ? 'session' : 'global' } };
  }
  /** Command: pick the remote host for the current conversation only. */
  async function selectSshHostForSession() {
    const conversation = sessions.current();
    let ssh;
    try { ssh = await readSSHConfiguration(vscode, context); }
    catch (error) { void vscode.window.showErrorMessage('读取 SSH 配置失败：' + errorText(error)); return; }
    const profiles = ssh?.profiles ?? [];
    if (!profiles.length) return openSettings('settings', 'ssh');
    const defaultId = profiles.some(profile => profile.id === ssh.defaultId) ? ssh.defaultId : profiles[0].id;
    const { activeId, sessionScoped } = activeSshHost(conversation.id);
    const entries = [
      { id: '', label: '$(arrow-left) 跟随全局默认', detail: sshHostLabel(profiles.find(profile => profile.id === defaultId)),
        description: sessionScoped ? '清除本会话指定' : '当前生效' },
      ...profiles.map(profile => ({ id: profile.id, label: (profile.id === activeId ? '$(check) ' : '$(remote) ') + sshHostLabel(profile),
        description: profile.id === defaultId ? '全局默认' : '本会话指定',
        detail: `${profile.username}@${profile.host}:${profile.port ?? 22}` }))
    ];
    const choice = await vscode.window.showQuickPick(entries, { title: '本会话的远程主机',
      placeHolder: '只影响当前会话的 Agent 远程命令；修改全局默认请到「系统配置 → SSH 连接」' });
    if (!choice) return;
    if (!choice.id) sshHostOverrides.delete(conversation.id);
    else sshHostOverrides.set(conversation.id, choice.id);
    schedulePublishState();
    const chosen = choice.id ? profiles.find(profile => profile.id === choice.id) : undefined;
    void vscode.window.showInformationMessage(chosen
      ? `本会话将使用 ${sshHostLabel(chosen)}，下一轮任务生效。`
      : '本会话已跟随全局默认远程主机，下一轮任务生效。');
  }
  // 完全模式 (approvalMode 'full'): tools run with no workspace boundary and no
  // per-call approval. The flag is per conversation and rewritten on every run
  // start, so 自动/人工 always fall back to the confined behaviour.
  const fullAccess = new Map();
  const markFullAccess = (id, approvalMode) => { if (approvalMode === 'full') fullAccess.set(id, true); else fullAccess.delete(id); };
  const unbounded = id => fullAccess.get(id) === true;
  const search = createWorkspaceSearch(vscode, { workspaceFolders: sessionFolders, unbounded });
  const audit = createWorkspaceAudit(vscode, { workspaceFolders: sessionFolders, unbounded });
  const validation = createWorkspaceValidation(vscode, context, { changes: id => coding.changes(id), workspaceFolders: sessionFolders, unbounded });
  const coding = createCodingService(vscode, context, { beforeEdit: validation.capture, workspaceFolders: sessionFolders, unbounded,
    turnId: id => harness?.state(id).runId });
  context.subscriptions.push(coding, validation);
  // Saving a server in settings proves nothing about the connection, and a
  // server that never mounts looks "installed" while no tool exists. Verify the
  // fresh install with the same middleware a turn uses, so the chat and the
  // notification report the real tool count or the actual failure reason.
  const MCP_VERIFY_TIMEOUT_MS = 20_000;
  async function verifyMcpServerConnection(server) {
    const entry = path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'middleware', 'mcp.mjs');
    const { createMcpMiddleware } = await import(pathToFileURL(entry).href);
    // Mirror the product default: MCP certificate validation is off unless the
    // user turns the global switch off in the MCP settings page.
    const insecureTls = vscode.workspace.getConfiguration('ubovm').inspect('mcp')?.globalValue?.insecureTls !== false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('连接验证超时'), { code: 'MCP_TIMEOUT' })), MCP_VERIFY_TIMEOUT_MS);
    let middleware;
    try {
      middleware = await createMcpMiddleware({ servers: [server], connectTimeoutMs: Math.min(MCP_VERIFY_TIMEOUT_MS, 15_000), insecureTls, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      return { connected: false, tools: [], error: controller.signal.aborted ? '连接验证超时（服务器启动或响应过慢）' : errorText(error) };
    }
    try {
      const diagnostic = middleware.diagnostics()[0] ?? {};
      return diagnostic.connected === true
        ? { connected: true, tools: Array.isArray(diagnostic.tools) ? diagnostic.tools : [] }
        : { connected: false, tools: [], error: diagnostic.error ?? '连接失败' };
    } finally {
      clearTimeout(timer);
      await middleware.close().catch(() => {});
    }
  }
  const installTools = createInstallTools({
    settings: settingsConfiguration,
    verifyMcpServer: verifyMcpServerConnection,
    onInstalled: event => {
      const message = event.type === 'skill' ? `已通过对话安装 Skill：${event.name}（下一轮生效）`
        : event.connection?.connected === true ? `已通过对话安装 MCP 服务：${event.name}（已验证连接，${event.connection.tools.length} 个工具可用）`
          : event.connection ? `已通过对话安装 MCP 服务：${event.name}，但连接失败：${event.connection.error}`
            : `已通过对话安装 MCP 服务：${event.name}（下一轮生效）`;
      output.appendLine(message);
      void (event.type === 'mcp' && event.connection && !event.connection.connected ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
      try { schedulePublishState(); } catch { /* publish happens again with the next snapshot */ }
    }
  });
  const toolApprovals = require('./host/agent/tool-approvals.cjs').createToolApprovals({ onChange: () => schedulePublishState() });
  const humanQuestions = require('./host/agent/human-questions.cjs').createHumanQuestions({ onChange: () => schedulePublishState() });
  const stoppedInputQueues = new Set();
  const scheduledInputQueues = new Set();
  // Sessions with a steering round already queued on messageQueue. Steering the
  // waiting inputs is one FIFO pass, so concurrent notifications must not stack.
  const steeringSchedules = new Set();
  // Sessions observed in a steerable run. The transition, not every streamed
  // tick, is what flushes inputs that waited for the handler to register.
  const steeringReady = new Set();
  context.subscriptions.push(toolApprovals, humanQuestions);
  let learningRecovery, learningStartup = Promise.resolve();
  function syncBrowserAgentTaskLock() {
    if (!ideBrowserHost?.endAgentTask) return;
    let busy = false;
    try { busy = sessions.ids().some(sessionId => harness?.isBusy(sessionId) === true); } catch { return; }
    if (!busy) void Promise.resolve(ideBrowserHost.endAgentTask()).catch(() => {});
  }
  const codeSummaryRuns = new Map();
  const backgroundRequestNotices = new Map();
  function notifyBackgroundRequest(request, kind) {
    const target = typeof request?.conversationId === 'string' ? request.conversationId : '';
    if (!target || shuttingDown) return;
    const current = sessions.summary().id;
    if (target === current) return;
    const now = Date.now(), previous = backgroundRequestNotices.get(target) ?? 0;
    if (now - previous < 30000) return;
    backgroundRequestNotices.set(target, now);
    if (backgroundRequestNotices.size > 200) for (const [id, at] of backgroundRequestNotices) if (now - at > 120000) backgroundRequestNotices.delete(id);
    let title = '另一个会话';
    try {
      title = sessions.list('assist').concat(sessions.list('goal')).find(session => session.id === target)?.title || title;
    } catch { /* A missing listing must not block the request. */ }
    void Promise.resolve(vscode.window.showWarningMessage(`会话「${title}」正在等待${kind}，当前页面无法回答。`, '切换过去')).then(choice => {
      if (choice === '切换过去' && !shuttingDown) Promise.resolve(selectConversation(target)).catch(error => output.appendLine('切换会话失败：' + errorText(error)));
    }).catch(() => {});
  }
  harness = createHarnessService({
    onError: error => output.appendLine('Agent 后端连接失败：' + JSON.stringify(error)),
    onCrash: event => scheduleCrashRecovery(event),
    onBackendLog: line => { if (line) output.appendLine('[后端] ' + line); },
    onStall: event => {
      if (event?.stalled) output.appendLine('Agent 后端响应变慢（连接保持中）：' + (event.error?.message || ''));
    },
    onConnectionChange: () => {
      // Soft stall / recover should refresh the connection strip without a probe round-trip.
      if (shuttingDown) return;
      const backend = probeBackend();
      void welcome?.webview.postMessage({ type: 'connectionStatus', unsolicited: true, backend }).catch(error => output.appendLine(errorText(error)));
    },
    beforeSession: async () => { await learningStartup; return learningRecovery?.pause(); },
    requestToolApproval: request => { notifyBackgroundRequest(request, '工具确认'); return toolApprovals.request(request); },
    askHuman: request => { notifyBackgroundRequest(request, '回答'); return humanQuestions.request(request); },
    ideBrowserHost,
    sdkPath: sdkPath ?? sdkCandidates[0],
    storageDirectory: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'harness'),
    workspaceRoots: id => sessionFolders(id).map(folder => folder.uri.fsPath),
    readConfiguration: async id => {
      // SSH is optional: remote tools are filtered out by the harness when no
      // valid default host exists, while chat, editing and local tools still run.
      return withPluginContributions(browserInstaller.configure(applySshHostOverride(await modelConfiguration.read(), id)));
    },
    // The exploration sidebar conversation only reads the chat model; it must
    // not inherit the goal run's SSH readiness gate.
    // The exploration sidebar chat runs a real agent turn on the same toolset as
    // Workers plus the exploration status tools, so it needs the full model /
    // intools / MCP configuration. SSH is not required just to chat; SSH tools
    // report their own configuration error when invoked.
    readChatConfiguration: async id => withPluginContributions({ ...browserInstaller.configure(applySshHostOverride(await modelConfiguration.read(), id)), chatTools: true }),
    additionalTools: conversationId => [...pluginRegistry.agentTools(), ...coding.tools(conversationId), ...search.tools(conversationId), ...audit.tools(conversationId), ...validation.tools(conversationId), ...installTools.tools(conversationId), ...require('./harness/session/goal-tools.cjs').goalTools(sessions, conversationId)],
    onChange: id => {
      sessions.refreshRunning(id);
      publishModeRunning();
      publishGoalChatPanel();
      const current = sessions.summary();
      executionPublisher.schedule(sessions.goalSummaries().some(goal => goal.id === id) ? current.id : id);
      const execution = harness?.state(id);
      // A run becomes steerable only after the agent registers its steering
      // handler. Inputs submitted before that point wait in the queue; deliver
      // them at that transition instead of holding them for the whole turn.
      // Polling only the transition keeps streaming ticks cheap: the queue was
      // already flushed by the submit that arrived while steering was ready.
      if (execution?.busy === true && execution.canSteer === true) {
        if (!steeringReady.has(id)) { steeringReady.add(id); scheduleSteer(id); }
      } else steeringReady.delete(id);
      const completedRun = execution?.runId && !harness.isBusy(id) ? execution.runId + ':' + execution.status : undefined;
      if (completedRun && codeSummaryRuns.get(id) !== completedRun) {
        codeSummaryRuns.set(id, completedRun);
        void coding.recover(id).catch(error => output.appendLine('文件修改状态核对失败：' + errorText(error)))
          .finally(() => { if (!shuttingDown && sessions.summary().id === id) schedulePublishState(); });
      }
      if (harness && !harness.isBusy(id) && harness.state(id).status === 'completed') scheduleInputs(id);
      // UBOVM-specific lifecycle events for plugins. Best-effort and deduped by
      // run state so streaming ticks do not flood plugin handlers.
      const runStatus = execution?.status || 'idle';
      const runBusy = execution?.busy === true;
      const pluginSignature = `${execution?.runId || ''}:${runStatus}:${runBusy}`;
      const previousSignature = pluginRunState.get(id);
      pluginRunState.set(id, pluginSignature);
      if (previousSignature !== pluginSignature) {
        const previousBusy = typeof previousSignature === 'string' && previousSignature.endsWith(':true');
        let type;
        if (runBusy && !previousBusy) type = 'agent.run.started';
        else if (!runBusy && previousBusy) {
          type = runStatus === 'completed' ? 'agent.run.completed'
            : runStatus === 'failed' ? 'agent.run.failed'
              : runStatus === 'interrupted' ? 'agent.run.interrupted'
                : 'agent.run.idle';
        }
        if (type) pluginRegistry.emitAgentEvent({ type, conversationId: id, runId: execution?.runId || '', status: runStatus, busy: runBusy });
      }
      // The browser mask belongs to the whole agent turn, not one tool call:
      // release it only once no conversation is running any more.
      syncBrowserAgentTaskLock();
    },
    onMessage: async (conversationId, message) => {
      try { await coding.recover(conversationId); } catch (error) { output.appendLine('本轮文件记录核对失败：' + errorText(error)); }
      const appended = await sessions.appendMessage(conversationId, message);
      try {
        pluginRegistry.emitAgentEvent({
          type: 'agent.message',
          conversationId,
          role: message?.role || '',
          parts: Array.isArray(message?.parts) ? message.parts.length : 0
        });
      } catch (error) { output.appendLine('插件消息事件分发失败：' + errorText(error)); }
      return appended;
    },
  });
  shutdownHarness = async () => {
    shuttingDown = true;
    await learningStartup;
    try { await learningRecovery?.close(); } finally { await harness.close(); }
  };
  // The session snapshot is already in memory. Do not hold UI registration
  // behind disk writes, SDK imports or execution-history recovery.
  messageQueue = sessions.ready.then(() => firstPaint).then(async () => {
    if (shuttingDown) return;
    try { await coding.recover(); } catch (error) { output.appendLine('代码修改状态恢复失败：' + error.message); }
    try {
      await require('./harness/config/skills-catalog.cjs').installBundledSkills(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'agents', 'skills'));
    } catch (error) { output.appendLine('内置 Skills 释放失败：' + error.message); }
    if (!shuttingDown) await restoreExecution();
    output.appendLine('启动：执行记录恢复阶段完成 ' + (Date.now() - activatedAt) + 'ms');
    // Offline recovery runs after first paint and does not require credentials, SSH, or a new user message.
    if (!shuttingDown) learningStartup = (async () => {
      const saved = vscode.workspace.getConfiguration('ubovm').inspect('intools');
      const configured = (saved?.globalValue ?? saved?.defaultValue)?.knowledge;
      if (configured === false || configured?.background === false) return;
      const learning = { libraryFile: path.join(homedir(), '.ubovm', 'learning', 'knowledge.sqlite'), ...configured };
      if (!learning.libraryFile) return;
      const { startLocalLearningRecovery } = await import(pathToFileURL(sdkPath ?? sdkCandidates[0]).href);
      if (shuttingDown) return;
      learningRecovery = await startLocalLearningRecovery({ ...learning,
        storageDirectory: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'harness'),
        onEvent: event => { if (event.type === 'knowledge.failed') output.appendLine(event.message || '后台学习本地恢复暂未完成，将保留任务。'); } });
    })().catch(() => output.appendLine('后台学习本地恢复暂不可用，未完成任务仍保留。'));
  }).finally(() => {
    recovering = false;
    // Prefer an execution tick so first-paint history is not rebuilt after restore.
    if (shuttingDown) return;
    try {
      const id = typeof sessions.summary === 'function' ? sessions.summary()?.id : undefined;
      if (id && typeof executionPublisher?.schedule === 'function') executionPublisher.schedule(id);
      else publishState();
    } catch (error) {
      try { publishState(); } catch { output.appendLine('会话初始化失败：' + errorText(error)); }
    }
  });
  messageQueue = messageQueue.catch(error => output.appendLine('会话初始化失败：' + String(error)));
  function settingsSidebarItems() {
    const keys = settingsPage === 'initialize'
      ? ['model', 'ssh', 'web']
      : settingsNavigation.map(([key]) => key);
    return keys.map(key => {
      const entry = settingsNavigation.find(([id]) => id === key) || [key, key, 'settings-gear'];
      return { kind: 'setting', id: entry[0], label: entry[1], icon: entry[2] };
    });
  }

  function isCurrentSettingsItem(key) {
    if (!settingsPage) return false;
    if (key === 'model') return ['model', 'reasonModel', 'workerModel', 'summaryModel'].includes(settingsSection);
    return settingsSection === key;
  }

  const sidebarProvider = {
    onDidChangeTreeData: sidebarChanged.event,
    getParent: element => element?.kind === 'setting' ? undefined : sessions.provider.getParent(element),
    getChildren: element => {
      // System config replaces the session tree with selectable preference groups.
      if (settingsPage === 'settings' || settingsPage === 'initialize') {
        return element ? [] : settingsSidebarItems();
      }
      return sessions.provider.getChildren(element);
    },
    getTreeItem: entry => {
      if (entry?.kind === 'setting') {
        const current = isCurrentSettingsItem(entry.id);
        const label = uiText(entry.label);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = 'setting-' + entry.id;
        item.contextValue = 'ubovm.setting';
        item.iconPath = new vscode.ThemeIcon(entry.icon);
        item.tooltip = label + (current ? uiText('（当前）') : '');
        item.accessibilityInformation = { label: `${label}${current ? uiText('，当前设置') : ''}` };
        item.command = { command: 'ubovm.selectSettings', title: label, arguments: [entry.id] };
        return item;
      }
      return sessions.provider.getTreeItem(entry);
    }
  };
  context.subscriptions.push(sidebarChanged, sessions.provider.onDidChangeTreeData(() => sidebarChanged.fire()));
  sessionsView = vscode.window.createTreeView('ubovm.sessions', { treeDataProvider: sidebarProvider, showCollapseAll: false });
  context.subscriptions.push(sessionsView, sessions);
  publishState();

  function sessionFolders(id) {
    const workspace = sessions.get(id)?.workspace;
    return workspace ? [{ uri: vscode.Uri.file(workspace), name: path.basename(workspace), index: 0 }] : [];
  }

  async function chooseWorkspace(expectedSessionId) {
    const id = expectedSessionId ?? sessions.current().id;
    assertCurrentSession(id); assertIdle(id);
    const conversation = sessions.get(id);
    const inProject = Boolean(conversation?.projectId);
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
      openLabel: inProject ? '选择项目目录' : '选择工作空间',
      title: inProject ? '选择项目目录' : '为当前会话选择工作空间',
      defaultUri: conversation?.workspace ? vscode.Uri.file(conversation.workspace) : vscode.workspace.workspaceFolders?.[0]?.uri });
    if (!uris?.length) return;
    if (uris[0].scheme !== 'file') throw new Error(inProject ? '请选择本地项目目录。' : '请选择本地工作空间目录。');
    if (!((await vscode.workspace.fs.stat(uris[0])).type & vscode.FileType.Directory)) throw new Error(inProject ? '项目目录必须是文件夹。' : '工作空间必须是目录。');
    return updateSession(id, async () => {
      assertIdle(id);
      const previous = sessions.get(id)?.workspace;
      // Windows and macOS (default APFS) compare paths case-insensitively.
      const fold = value => process.platform === 'linux' ? path.resolve(value) : path.resolve(value).toLowerCase();
      const samePath = previous && fold(previous) === fold(uris[0].fsPath);
      if (samePath) {
        await vscode.commands.executeCommand('workbench.view.explorer');
        return;
      }
      await harness.releaseWorkspace(id);
      await sessions.setWorkspace(uris[0].fsPath, id);
      fileContexts.delete(id); pendingImages.delete(id);
      await restoreExecution();
    });
  }

  async function revealWorkspace(expectedSessionId) {
    const id = expectedSessionId ?? sessions.current().id;
    const workspace = sessions.get(id)?.workspace;
    if (!workspace) throw new Error('请先选择工作空间。');
    const uri = vscode.Uri.file(workspace);
    let stat;
    try { stat = await vscode.workspace.fs.stat(uri); }
    catch { throw new Error('工作空间目录不存在，请重新选择。'); }
    if (!(stat.type & vscode.FileType.Directory)) throw new Error('工作空间必须是目录。');
    if (!await vscode.env.openExternal(uri)) throw new Error('无法打开文件资源管理器。');
  }

  function workspaceName(conversation = sessions.current()) {
    if (conversation.workspace) return conversation.workspace;
    return conversation.projectId ? '选择项目目录（必选）' : '选择工作空间（必选）';
  }


  function projectCatalog() {
    const currentId = sessions.summary().projectId;
    return sessions.projects().map(project => {
      const members = sessions.projectSessions(project.id);
      const running = members.filter(session => harness?.isBusy(session.id)).length;
      const folder = project.workspace?.split(/[\\/]/).filter(Boolean).pop() || project.workspace || '';
      const updatedAt = members.reduce((latest, session) => Math.max(latest, session.updatedAt || 0), 0);
      return {
        id: project.id, name: project.name, workspace: project.workspace, folder,
        sessionCount: members.length,
        assistCount: members.filter(session => session.mode !== 'goal').length,
        goalCount: members.filter(session => session.mode === 'goal').length,
        running, current: project.id === currentId, updatedAt
      };
    }).sort((left, right) => Number(right.current) - Number(left.current) || (right.updatedAt || 0) - (left.updatedAt || 0) || String(left.name).localeCompare(String(right.name), 'zh'));
  }

  function assistantState() {
    const conversation = sessions.current();
    const messageIds = inputMessageIds(conversation.messages, 'user');
    const editor = vscode.window.activeTextEditor;
    const attached = fileContexts.get(conversation.id);
    const activeFile = attached !== null && editor?.document.uri.scheme === 'file' ? vscode.workspace.asRelativePath(editor.document.uri) : '';
    const file = attached?.label || activeFile;
    const execution = assistantExecution(conversation);
    const modelStatus = modelConfiguration.status();
    const relatedConversations = sessions.related(conversation.id);
    const assistEvidence = conversation.mode !== 'assist' ? [] : (conversation.assistEvidence || []).map(item => ({
      ...item,
      attachedGoalIds: relatedConversations.filter(goal => goal.mode === 'goal' && (goal.sourceEvidenceIds || []).includes(item.id)).map(goal => goal.id)
    }));
    return {
      type: 'state', nativeWorkerPanel: true, nativeBlackboardSidebar: true, theme: readTheme(vscode), recovering, messages: conversation.messages.map((message, index) => message.role === 'user' ? { ...message, id: messageIds[index], ...(message.images?.length ? { images: message.images.map(imageView) } : {}) } : message), inputQueue: publishedInputQueue(conversation), queuePaused: conversation.queuePaused || ['interrupted', 'failed'].includes(harness.state(conversation.id).status), conversation: { id: conversation.id, title: conversation.title, legacyDraftId: conversation.legacyDraftId }, conversationUsage: conversation.usage ?? null,
      mode: conversation.mode, goal: conversation.goal, notes: conversation.notes ?? [], deletedAgentNotes: conversation.deletedAgentNotes ?? [], editedAgentNotes: conversation.editedAgentNotes ?? [], assistEvidence, conversationIds: sessions.ids(), relatedConversations,
      context: { workspace: workspaceName(conversation), workspaceConfigured: Boolean(conversation.workspace), projectId: conversation.projectId || null, file, fileSource: attached?.kind === 'selection' ? 'selection' : attached ? 'attached' : activeFile ? 'active' : null,
         selectionLabel: attached?.rangeLabel || '' },
      toolApprovals: toolApprovals.snapshot(conversation.id), humanQuestions: humanQuestions.snapshot(conversation.id), codeChanges: coding.turnSummary(conversation.id),
      pendingImages: (pendingImages.get(conversation.id) ?? []).map(imageView),
      requireToolApproval: (vscode.workspace.getConfiguration('ubovm').inspect('worker')?.globalValue?.requireToolApproval ?? true) !== false,
      provider: modelStatus, ssh: sshStatusFor(conversation.id), browserAgent: browserAgentActivity ?? null, execution: { ...execution, mode: conversation.mode }, busy: execution.busy,
      plugins: pluginRegistry.uiState(),
      // The header button toggles the native exploration-chat tab, so it mirrors
      // the live sidebar state instead of a local click latch.
      goalChatOpen: goalChatPanel.visible,
      projects: projectCatalog(), modelSelection: { provider: modelStatus.provider, selected: conversation.selectedModelId || '', models: modelStatus.models || [], defaultModel: modelStatus.defaultModel || '', imageInput: (modelStatus.input ?? ['text']).includes('image') }
    };
  }

  function assistantExecution(conversation, { includeLogHistory = true } = {}) {
    let execution = harness?.state(conversation.id) ?? { status: 'idle', busy: false, workers: [], streamText: '', canResume: false };
    // A full snapshot can race the first execution tick. Retain the last Agent
    // memory seen for this conversation so notes/Team state do not disappear
    // from the panel while the harness view is being restored.
    if (execution.memory !== undefined) rememberExecutionMemory(conversation.id, execution.memory);
    else if (executionMemoryCache.has(conversation.id)) {
      const memory = executionMemoryCache.get(conversation.id);
      rememberExecutionMemory(conversation.id, memory);
      execution = { ...execution, memory };
    }
    // Execution ticks only need the live run; the archived log rounds travel with
    // full snapshots (opening/navigating the goal workspace), not every token.
    // The service snapshot can be frozen and shared, so never delete in place.
    if (!includeLogHistory) { execution = { ...execution }; delete execution.logHistory; }
    // The harness owns the run's permission mode, and it is re-read on every run
    // start (including resume/restore). Mirror it so extension-side workspace
    // tools stay unbounded for a resumed 完全模式 run instead of silently
    // reverting to the confined behaviour.
    markFullAccess(conversation.id, execution.approvalMode);
    const explorationRuns = sessions.goalSummaries().map(goal => {
      const run = harness?.runtimeSummary(goal.id) || {};
      return { ...goal, status: run.status || 'idle', phase: run.phase, busy: run.busy === true,
        workerCount: run.workerCount || 0, activeWorkers: run.activeWorkers || 0,
        error: restoreErrors.get(goal.id) || (typeof run.error === 'string' ? run.error : run.error?.message) || '' };
    });
    return { ...execution, ...(restoreErrors.has(conversation.id) ? { error: { message: restoreErrors.get(conversation.id) } } : {}), mode: conversation.mode, explorationRuns };
  }

  function conversationConsumesSnapshot() {
    return welcomeReady && welcome?.visible === true && !settingsPage;
  }

  function conversationNeedsSnapshot() {
    // A chrome lock must still reach the conversation page while settings are
    // closing or the editor is in the background, or the overlay never unlocks.
    return Boolean(welcomeReady && welcome && (chromeLockedSessionId || conversationConsumesSnapshot()));
  }

  function publishSidebarChrome(conversation) {
    const title = uiText(conversation.mode === 'goal' ? '探索工作台' : '协助对话');
    if (welcome && welcome.title !== title) welcome.title = title;
    if (sessionsView) {
      // Normal mode keeps the native default view title (equal to the container
      // title in every locale). Settings pages surface their short page name.
      const sidebarTitle = settingsPage === 'initialize' ? uiText('首次初始化')
        : settingsPage === 'settings' ? uiText('系统配置')
        : settingsPage === 'mcp' ? 'MCP'
        : settingsPage === 'skills' ? 'Skills'
        : settingsPage ? uiText('扩展管理')
        : undefined;
      const count = conversation.historyCount ?? sessions.summary().historyCount;
      const description = settingsPage ? '' : (count ? uiText('{0} 条', count) : '');
      if (publishedSidebarTitle !== sidebarTitle) {
        publishedSidebarTitle = sidebarTitle;
        try { sessionsView.title = sidebarTitle; } catch { /* Older host: keep the previous title. */ }
      }
      if (sessionsView.description !== description) sessionsView.description = description;
    }
    // The sessions compose row (workspace switcher) reads this label instead of
    // guessing from the path; publish only on change to avoid context churn.
    const project = conversation.projectId ? sessions.projects().find(item => item.id === conversation.projectId) : undefined;
    const workspaceLabel = project?.name || (conversation.workspace ? path.basename(conversation.workspace) : '');
    if (publishedWorkspaceLabel !== workspaceLabel) {
      publishedWorkspaceLabel = workspaceLabel;
      void vscode.commands.executeCommand('setContext', 'ubovm.workspaceLabel', workspaceLabel).catch(error => output.appendLine(String(error)));
    }
    if (publishedMode !== conversation.mode) {
      publishedMode = conversation.mode;
      void vscode.commands.executeCommand('setContext', 'ubovm.mode', conversation.mode);
    }
    publishModeRunning();
    blackboardSidebar.setSession(conversation.mode === 'goal' ? conversation.id : '');
  }

  // A run keeps going after the user switches modes, so the top mode switcher
  // needs its own signal: publish only on transitions, never per streamed token.
  function publishModeRunning() {
    if (shuttingDown) return;
    const running = sessions.runningModes().join(',');
    if (running === publishedRunningModes) return;
    publishedRunningModes = running;
    for (const mode of ['assist', 'goal']) {
      void vscode.commands.executeCommand('setContext', 'ubovm.' + mode + 'Running', running.includes(mode))
        .catch(error => output.appendLine(String(error)));
    }
  }

  // Exploration chat projection: the panel belongs to the main goal conversation
  // and lists that conversation's own chat tabs. Every tab is a separate chat
  // conversation persisted under the same goal-chat record.
  function goalChatPanelPayload() {
    const conversation = sessions.current();
    const execution = harness?.state(conversation.id) ?? {};
    const chat = execution.goalChat;
    const threads = Array.isArray(chat?.threads) ? chat.threads : [];
    const model = modelConfiguration.status();
    return {
      sessionId: conversation.id,
      threads: threads.map(thread => ({ id: thread.id, title: thread.title, active: thread.id === chat.activeThreadId, draft: false })),
      activeThreadId: chat?.activeThreadId ?? '',
      mode: conversation.mode,
      available: conversation.mode === 'goal' && Boolean(conversation.goal) && Boolean(conversation.workspace),
      goalMissing: conversation.mode === 'goal' && !conversation.goal,
      open: goalChatPanel.visible,
      chat,
      imageInput: (model.input ?? ['text']).includes('image'),
      modelReady: model.connected !== false && model.configured !== false
    };
  }
  function publishGoalChatPanel() {
    try { goalChatPanel.update(goalChatPanelPayload()); }
    catch (error) { output.appendLine('探索对话状态投影失败：' + errorText(error)); }
  }

  function publishState() {
    if (shuttingDown) return;
    // Restored profiles can reopen the chat view without going through
    // openGoalChat(); keep the exploration tab strip consistent in that path.
    if (goalChatPanel.visible) void ensureExplorationSidebarTabs();
    publishGoalChatPanel();
    const showConversation = conversationNeedsSnapshot();
    const showWorkers = workerPanel.visible === true;
    // While the chat webview is hidden, skip mapping the full message history.
    // Visibility / ready handlers republish a complete snapshot when it returns.
    if (welcomeReady && !showConversation && !showWorkers) {
      const conversation = sessions.summary();
      publishSidebarChrome(conversation);
      return conversation;
    }
    const state = { ...assistantState(), viewRevision: ++viewRevision };
    const currentWorkspace = sessions.summary().workspace || '';
    if (explorerReady && explorerWorkspace !== currentWorkspace) {
      explorerWorkspace = currentWorkspace;
      void sessionExplorer.sync(currentWorkspace).catch(error => {
        if (explorerWorkspace === currentWorkspace) explorerWorkspace = undefined;
        output.appendLine('文件树同步失败：' + errorText(error));
      });
      scheduleFolderCheck();
    }
    void workerPanel.publish({ sessionId: state.conversation.id, workers: state.execution.workers || [], error: state.execution.workerViewError?.message });
    publishSidebarChrome({ id: state.conversation.id, mode: state.mode, historyCount: sessions.summary().historyCount });
    if (showConversation) {
      executionPublisher.publishFull(state);
    }
    return state;
  }

  // Config/secrets/editor/session churn must not rebuild the full snapshot on every tick.
  function schedulePublishState(delay = 48) {
    clearTimeout(publishStateTimer);
    publishStateTimer = setTimeout(() => {
      publishStateTimer = undefined;
      if (!shuttingDown) publishState();
    }, delay);
  }

  // The page, the extension host and the backend can reconnect independently.
  // Every recovery is a snapshot read, never a task replay: the backend owns the
  // execution and its checkpoint, so the host only adopts the authoritative
  // projection (or restores that checkpoint) and repaints.
  let backendHealth = 'idle';
  let backendResyncTimer;
  let backendResyncing;
  let backendResyncAgain = false;
  function scheduleBackendResync(delay = 250) {
    if (shuttingDown) return;
    // Never drop a recovery request because an earlier read is still in flight.
    if (backendResyncing) { backendResyncAgain = true; return; }
    clearTimeout(backendResyncTimer);
    backendResyncTimer = setTimeout(() => {
      backendResyncTimer = undefined;
      void resyncBackend().catch(error => output.appendLine('Agent 状态同步失败：' + errorText(error)));
    }, delay);
  }
  function resyncBackend() {
    // Coalesce: a probing page can ask repeatedly while one read is in flight.
    if (backendResyncing) { backendResyncAgain = true; return backendResyncing; }
    backendResyncAgain = false;
    backendResyncing = (async () => {
      if (!harness || shuttingDown) return;
      const conversation = sessions.current();
      if (!conversation?.id) return;
      // A stalled worker is still live and will publish its own projection; the
      // idle state has no backend session to sync.
      let status = harness.connectionState();
      if (status.status === 'idle' || status.status === 'stalled') return;
      // A dead runtime is respawned through ensureIdle so its retry backoff is
      // respected; a page-ready event must not retry a failing spawn on its own.
      if (status.status === 'disconnected') {
        status = await harness.ensureIdle();
        if (shuttingDown || status?.status !== 'connected') return;
      }
      const snapshot = await harness.authoritative(conversation.id).catch(() => null);
      // Do not queue a checkpoint restore into a worker that just went silent;
      // the stall recovery will request a fresh sync when the worker answers.
      if (!snapshot && !shuttingDown && harness.connectionState().status === 'connected') await restoreExecution();
      if (!shuttingDown) schedulePublishState(0);
    })().catch(error => output.appendLine('Agent 状态同步失败：' + errorText(error))).finally(() => {
      backendResyncing = undefined;
      if (backendResyncAgain && !shuttingDown) { backendResyncAgain = false; scheduleBackendResync(0); }
    });
    return backendResyncing;
  }
  function noteBackendHealth(status) {
    const previous = backendHealth;
    backendHealth = status;
    if (shuttingDown) return;
    if (!['connected', 'idle'].includes(status)) return;
    // A lazily spawned worker is not a recovery. Only re-adopt the backend
    // projection after a stall, a dead runtime or a closed transport.
    if (!['disconnected', 'closed', 'stalled'].includes(previous)) return;
    scheduleBackendResync();
  }

  // Supervised recovery: a crashed backend restarts once and resumes the active
  // goal from its checkpoint. Manual restarts/reloads are excluded by the service.
  function scheduleCrashRecovery(event) {
    if (shuttingDown || !Array.isArray(event?.busyIds) || !event.busyIds.length) return;
    const current = sessions.summary();
    if (current.mode !== 'goal' || !event.busyIds.includes(current.id)) return;
    if (crashRecoveryTimer) return;
    const now = Date.now();
    if (!crashRecoveryWindowStart || now - crashRecoveryWindowStart > 10 * 60_000) {
      crashRecoveryWindowStart = now;
      crashRecoveryAttempts = 0;
    }
    if (++crashRecoveryAttempts > 2) {
      output.appendLine('Agent 后端连续崩溃，已停止自动恢复；请导出诊断信息后继续执行。');
      return;
    }
    output.appendLine('Agent 后端意外退出，正在自动重启并从检查点恢复目标…');
    crashRecoveryTimer = setTimeout(() => {
      crashRecoveryTimer = undefined;
      const target = current.id;
      void updateSession(target, async () => {
        if (shuttingDown) return;
        const execution = harness.state(target);
        if (!(execution.status === 'completed' && execution.canResume && !execution.busy)) assertCanRun(target);
        await harness.resume(target);
        output.appendLine('Agent 后端已重启，目标已从检查点恢复。');
      }).catch(error => output.appendLine('自动恢复未完成：' + errorText(error)));
    }, 1200);
  }
  async function restartAgentBackend() {
    if (!harness) throw new Error('Agent 后端尚未启动。');
    await harness.restart();
    output.appendLine('Agent 后端已重新启动。');
    await resyncBackend();
    schedulePublishState(0);
    return { restarted: true, status: harness.connectionState().status };
  }

  function probeBackend() {
    const backend = harness?.connectionState() ?? { status: 'idle' };
    noteBackendHealth(backend.status);
    // Soft transport stalls keep the worker alive; surface them without looking offline.
    if (backend.status === 'stalled') return { status: 'stalled', recovering: true, error: backend.error };
    // A dead/disconnected runtime must stay disconnected even while a session is
    // still marked busy (launch race). ensureIdle repairs in the background.
    if (backend.status === 'disconnected' && harness) {
      const currentId = sessions.summary()?.id;
      if (currentId && harness.isBusy(currentId)) {
        return { status: 'disconnected', recovering: true, error: backend.error };
      }
    }
    return backend;
  }

  function replyConnectionProbe(probeId, target = welcome) {
    if (typeof probeId !== 'string' || probeId.length > 100) return false;
    const backend = probeBackend();
    // Never await the bridge: a stalled postMessage must not block the extension
    // host or the next inbound heartbeat.
    void target?.webview.postMessage({ type: 'connectionStatus', probeId, backend }).catch(error => output.appendLine(errorText(error)));
    if (harness && (backend.status === 'disconnected' || backend.recovering && backend.status !== 'stalled')) {
      void harness.ensureIdle().then(result => {
        if (shuttingDown || !['connected', 'stalled'].includes(result?.status)) return;
        // A restore that failed while the worker was dead stays latched unless
        // the user navigates away. Retry it once after the runtime recovers so
        // the checkpoint actions become available again.
        const currentId = sessions.summary()?.id;
        if (currentId && restoreErrors.has(currentId) && Date.now() >= restoreRetryAt) {
          restoreRetryAt = Date.now() + 5000;
          void restoreExecution().then(() => schedulePublishState(0));
          return;
        }
        // Coalesce with ready/visibility publishes; never rebuild a full snapshot
        // synchronously on the heartbeat acknowledgement path. A real recovery
        // re-reads the backend projection so the page is never left on a guess.
        if (result?.status === 'connected') scheduleBackendResync(0);
        else schedulePublishState(0);
      }).catch(error => output.appendLine('Agent 空闲恢复：' + errorText(error)));
    }
    return true;
  }

  function runtimeInfo() {
    return {
      application: vscode.env.appName, entryPoint: process.env.UBOVM_MAIN_ENTRY || 'upstream source',
      vscode: vscode.version, electron: process.versions.electron || null, node: process.versions.node,
      platform: process.platform, architecture: process.arch, extension: context.extension.id,
      extensionVersion: context.extension.packageJSON.version, extensionPath: context.extensionPath,
      appRoot: vscode.env.appRoot, uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? 'desktop' : 'web',
      remoteName: vscode.env.remoteName || null,
      persistence: {
        root: path.join(homedir(), '.ubovm'),
        profile: process.env.VSCODE_PORTABLE || null,
        workspaceStorage: context.storageUri?.fsPath ?? null,
        globalStorage: context.globalStorageUri.fsPath,
        logs: context.logUri.fsPath,
        harness: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'harness'),
        workspaceState: context.storageUri ? path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb') : null,
        globalState: path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb')
      },
      workspaces: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath)
    };
  }

  function showRuntimeInfo() {
    const info = runtimeInfo();
    output.clear(); output.appendLine(JSON.stringify(info, null, 2)); output.show(true);
    return info;
  }

  // Support bundle: runtime versions, current backend/session state and the
  // bounded output tail, written next to the other user data. No credentials or
  // settings values are included.
  async function exportDiagnostics() {
    const directory = path.join(homedir(), '.ubovm', 'diagnostics');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, 'ubovm-diagnostics-' + stamp + '.md');
    const session = sessions.summary();
    const lines = [
      '# UBOVM diagnostics', '',
      'Exported: ' + new Date().toISOString(), '',
      '## Runtime', '```json', JSON.stringify(runtimeInfo(), null, 2), '```', '',
      '## Agent backend', '```json', JSON.stringify(harness?.connectionState?.() ?? { status: 'unknown' }, null, 2), '```', '',
      '## Current session',
      '- id: ' + session.id,
      '- mode: ' + session.mode,
      '- workspace: ' + (session.workspace || '(default)'),
      '- history: ' + (session.historyCount ?? 'unknown'),
      '- restore error: ' + (restoreErrors.get(session.id) || 'none'),
      '',
      '## Recent output (tail)', '```text', ...diagnosticTail.slice(-300), '```', ''
    ];
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(lines.join('\n'), 'utf8'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
    return { path: file };
  }

  async function openSource() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const source = vscode.Uri.joinPath(folder.uri, 'vendor', 'vscode');
      try {
        if (((await vscode.workspace.fs.stat(source)).type & vscode.FileType.Directory) !== 0) {
          await vscode.commands.executeCommand('vscode.openFolder', source, { forceNewWindow: true });
          return;
        }
      } catch (error) { if (error?.code !== 'FileNotFound') output.appendLine(String(error)); }
    }
    void vscode.window.showInformationMessage('请先在 UBOVM 项目根目录运行 npm run core -- fetch。');
  }

  async function openAssistant(preserveFocus = false) {
    await openWelcome(preserveFocus);
    publishState();
    return { viewType: 'ubovm.welcome', location: 'main' };
  }

  function assertCurrentSession(expectedSessionId) {
    if (expectedSessionId !== undefined && expectedSessionId !== sessions.current().id) {
      throw new Error('会话已切换，请在当前会话重试。');
    }
  }

  function updateSession(expectedSessionId, mutation) {
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      await mutation();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  function setMode(mode, expectedSessionId) {
    return navigationAction(async () => {
      assertCurrentSession(expectedSessionId);
      const previous = sessions.summary().id;
      await sessions.setMode(mode, expectedSessionId);
      const switched = sessions.summary().id !== previous;
      if (switched) await lockConversationChrome();
      await finishConversationSwitch(switched);
    });
  }

  function assertIdle(id = sessions.current().id) {
    if (harness.isBusy(id)) throw new Error('请先停止当前执行，再修改目标或验收项。');
  }

  function assertCanRun(id = sessions.current().id) {
    if (!sessions.get(id)?.workspace) throw new Error('请先点击顶部的“选择工作空间”，为当前会话配置工作空间。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再运行模型和工具。');
    if (!modelConfiguration.status().configured) throw new Error('请先点击“配置模型”，填写模型地址和凭据。');
    // SSH is deliberately not required here: it only gates SSH/SFTP/deploy tools,
    // which the harness filters out when no valid remote host is configured.
    if (harness.isBusy(id)) throw new Error('当前会话正在运行，请等待完成或先停止。');
    restoreErrors.delete(id);
  }

  async function restoreExecutionFor(conversation) {
    if (!harness || !conversation) return;
    try {
      await ensureDefaultWorkspace(conversation);
      await harness.restore({ conversationId: conversation.id, mode: conversation.mode, goal: conversation.goal, executionBranch: conversation.executionBranch });
      restoreErrors.delete(conversation.id);
    } catch (error) { restoreErrors.set(conversation.id, error.message || String(error)); output.appendLine(String(error)); }
  }

  async function restoreExecution() {
    if (!harness) return;
    return restoreExecutionFor(sessions.current());
  }

  async function executionContext(conversation) {
    await ensureDefaultWorkspace(conversation);
    const editor = vscode.window.activeTextEditor;
    const attached = fileContexts.get(conversation.id);
    if (attached?.kind === 'selection' || attached?.kind === 'file-drop') return { workspace: workspaceName(), ...structuredClone(attached.snapshot) };
    // A removed chip explicitly disables automatic editor context for this
    // conversation until the user selects another file.
    if (attached === null) return { workspace: workspaceName() };
    const relative = editor?.document.uri.scheme === 'file' && conversation.workspace
      ? path.relative(conversation.workspace, editor.document.uri.fsPath) : null;
    const active = relative !== null && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? editor.document.uri.fsPath : undefined;
    const value = { workspace: workspaceName(), file: attached?.path ?? active };
    // A user-selected attachment may be outside the workspace. Send only that
    // file's bounded contents, without granting tools access to its directory.
    const document = attached ? vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.fsPath === attached.path)
      : active ? editor.document : undefined;
    if (document) {
      const text = document.getText();
      value.content = text.slice(0, 64000); value.truncated = text.length > 64000; value.unsaved = document.isDirty;
    } else if (attached) {
      const handle = await open(attached.path, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('上下文附件必须是普通文件。');
        const buffer = Buffer.alloc(Math.min(stat.size, 64000));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        if (text.includes('\0')) throw new Error('当前仅支持文本文件作为上下文。');
        value.content = text; value.truncated = stat.size > bytesRead;
      } finally { await handle.close(); }
    }
    return value;
  }

  function saveGoal(goal, expectedSessionId) {
    return updateSession(expectedSessionId, async () => {
      assertIdle();
      if (!sessions.current().workspace) throw new Error('请先点击顶部的“选择工作空间”，为当前会话配置工作空间。');
      await sessions.saveGoal(goal, expectedSessionId);
      await restoreExecution();
    });
  }

  function toggleGoalCriterion(id, done, expectedSessionId) {
    return updateSession(expectedSessionId, () => { assertIdle(); return sessions.toggleGoalCriterion(id, done, expectedSessionId); });
  }

  function addGoalNote(text, expectedSessionId) {
    return updateSession(expectedSessionId, () => sessions.addGoalNote(text, expectedSessionId));
  }

  function editNote(noteId, text, expectedSessionId) {
    return updateSession(expectedSessionId, () => sessions.editNote(noteId, text, expectedSessionId));
  }

  function editAgentNote(noteId, text, expectedSessionId) {
    return updateSession(expectedSessionId, () => sessions.editAgentNote(noteId, text, expectedSessionId));
  }

  function submitPrompt(text, expectedSessionId, approvalMode) {
    if (approvalMode !== undefined && !['auto', 'manual', 'full'].includes(approvalMode)) return Promise.reject(new Error('无效的工具执行方式。'));
    if (typeof text !== 'string') return Promise.reject(new Error('请先输入消息内容。'));
    const pending = pendingImages.get(expectedSessionId) ?? [];
    if (!text.trim() && !pending.length) return Promise.reject(new Error('请先输入消息内容或添加图片。'));
    if (text.length > 8000) return Promise.reject(new Error('请将每条消息控制在 8000 个字符以内。'));
    const messageText = text.trim() || '请查看并分析这张图片。';
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      const conversation = sessions.current();
      const images = pendingImages.get(conversation.id) ?? [];
      if (conversation.mode === 'assist') {
        const context = await executionContext(conversation);
        // A parked input remembers what its captured context was, so the queue
        // row can explain it and recall can rebuild the composer chip. Only
        // bounded labels live here; the snapshot itself stays on `context`.
        const contextMeta = capturedContextMeta(conversation, context);
        await sessions.updateInputQueue(conversation.id, current => {
          if (current.inputQueue.length >= 20) throw new Error('输入队列最多保留 20 条消息。');
          return { inputQueue: [...current.inputQueue, { id: randomUUID(), text: messageText, approvalMode, modelId: conversation.selectedModelId, context, ...(contextMeta ? { contextMeta } : {}), ...(images.length ? { images } : {}) }],
            queuePaused: current.inputQueue.length ? current.queuePaused : false };
        });
        if (images.length) pendingImages.delete(conversation.id);
        if (!harness.isBusy(conversation.id)) {
          try { await drainInputs(conversation.id, !conversation.inputQueue.length); }
          catch (error) {
            output.appendLine(errorText(error));
            void vscode.window.showErrorMessage('输入已保存，但未能启动执行：' + errorText(error) + '。可取回队列输入或回退该消息后重试。');
          }
        } else {
          // Deliver every waiting input at the next execution boundary. FIFO
          // order is preserved: the head of the queue is steered first, and an
          // input that cannot steer (images) stops the round so the queue keeps
          // its original order for the next turn.
          try { await steerWaitingInputs(conversation.id); }
          catch (error) {
            output.appendLine(errorText(error));
            void vscode.window.showErrorMessage(errorText(error));
          }
        }
        return publishState();
      }
      assertCanRun(conversation.id);
      if (conversation.mode === 'goal' && !conversation.goal) throw new Error('请先保存目标，再开始执行。');
      if (conversation.mode === 'goal' && harness.state(conversation.id).canResume) throw new Error('此目标有待恢复的执行，请先点击“继续执行”。');
      if (conversation.mode === 'goal' && images.length) throw new Error('探索模式的主流程不接受图片；请在右侧「探索对话」中附加图片，或切到协助对话发送。');
      const context = await executionContext(conversation);
      await sessions.appendMessage(conversation.id, { role: 'user', text: messageText, ...(images.length ? { images } : {}) });
      if (images.length) pendingImages.delete(conversation.id);
      markFullAccess(conversation.id, approvalMode);
      await harness.start({ conversationId: conversation.id, mode: conversation.mode, goal: conversation.goal,
        executionBranch: conversation.executionBranch,
        text: messageText, images, approvalMode, messages: sessions.get(conversation.id).messages, context });
      await openAssistant();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  // Queue metadata is deliberately small and content-free: labels are clipped
  // so a long path or range can never bloat the persisted queue, and the state
  // published to the webview only describes what an input carried.
  const CONTEXT_META_LABEL_LIMIT = 120;
  const CONTEXT_META_RANGE_LIMIT = 80;
  function boundedContextMeta(value, limit) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text) return '';
    return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text;
  }
  function attachmentMetaLabel(attached) {
    const label = boundedContextMeta(attached?.label, CONTEXT_META_LABEL_LIMIT);
    if (label) return label;
    // Never drop a queued attachment only because its display label is empty.
    const fallback = attached?.path ?? attached?.snapshot?.file;
    return typeof fallback === 'string' && fallback ? boundedContextMeta(path.basename(fallback), CONTEXT_META_LABEL_LIMIT) : '';
  }
  // Mirrors the context `executionContext()` just captured: an explicit chip
  // wins over the implicit active editor, and an untouched editor is still
  // reported as 'active' so recall can rebuild it as an explicit attachment.
  function capturedContextMeta(conversation, context) {
    const attached = fileContexts.get(conversation.id);
    if (attached && (attached.kind === 'selection' || attached.kind === 'file-drop')) {
      const label = attachmentMetaLabel(attached);
      if (!label) return undefined;
      const range = boundedContextMeta(attached.rangeLabel, CONTEXT_META_RANGE_LIMIT);
      return { label, kind: 'selection', ...(range ? { range } : {}) };
    }
    if (attached) {
      const label = attachmentMetaLabel(attached);
      return label ? { label, kind: 'file' } : undefined;
    }
    if (typeof context?.file === 'string' && context.file) {
      const label = boundedContextMeta(path.basename(context.file), CONTEXT_META_LABEL_LIMIT);
      return label ? { label, kind: 'active' } : undefined;
    }
    return undefined;
  }
  function publishedInputQueue(conversation) {
    return (conversation?.inputQueue ?? []).map(item => ({
      id: item.id,
      text: item.text,
      ...(item.delivery ? { delivery: item.delivery } : {}),
      ...(item.modelId ? { modelId: item.modelId } : {}),
      ...(item.images?.length ? { imageCount: item.images.length } : {}),
      ...(item.approvalMode ? { approvalMode: item.approvalMode } : {}),
      ...(item.contextMeta?.label && item.contextMeta?.kind
        ? { context: { label: item.contextMeta.label, kind: item.contextMeta.kind, ...(item.contextMeta.range ? { range: item.contextMeta.range } : {}) } }
        : {})
    }));
  }
  // Recall ("取回编辑") is lossless by contract: it never replays the input, it
  // only returns its text to the composer (the webview owns the draft) and puts
  // the queued attachments/context back into the host-side composer maps so the
  // original chips appear again and the next send reuses the same snapshot.
  function recallQueuedInput(id, item) {
    if (!item) return;
    const images = (item.images ?? []).filter(image => image && typeof image === 'object' && image.id);
    if (images.length) {
      const pending = pendingImages.get(id) ?? [];
      const known = new Set(pending.map(image => image.id));
      // Existing composer images stay first; only genuinely new ids are added.
      pendingImages.set(id, [...pending, ...images.filter(image => !known.has(image.id))]);
    }
    const context = item.context;
    const meta = item.contextMeta;
    if (typeof context?.file !== 'string' || !context.file || !meta?.label || !meta?.kind) return;
    // Reuse the captured snapshot verbatim instead of re-reading a file that may
    // have changed since the input was queued.
    const descriptor = { kind: meta.kind === 'selection' ? 'selection' : 'file-drop', label: meta.label, path: context.file, ...(meta.range ? { rangeLabel: meta.range } : {}) };
    descriptor.snapshot = structuredClone(context);
    const previous = fileContexts.get(id);
    fileContexts.set(id, descriptor);
    // Recall is authoritative for the recalled input, but replacing a different
    // context the user attached meanwhile must never be silent: the previous
    // chip is gone from the composer, so say so once.
    if (previous && typeof previous === 'object' && (previous.path !== descriptor.path || previous.kind !== descriptor.kind)) {
      try { vscode.window.showWarningMessage?.('已恢复待发送输入的上下文，并替换了输入框中原来的上下文。'); }
      catch { /* Operator notice is advisory; recall already happened. */ }
    }
  }

  function scheduleInputs(id) {
    if (shuttingDown || scheduledInputQueues.has(id) || !sessions.get(id)?.inputQueue?.length) return;
    scheduledInputQueues.add(id);
    const operation = messageQueue.then(() => {
      // Keep one queued dispatch per session. Release the marker when it
      // starts so a completion during dispatch can queue the next input.
      scheduledInputQueues.delete(id);
      return drainInputs(id);
    });
    messageQueue = operation.catch(error => output.appendLine(errorText(error)));
  }

  // While a run is executing, queued inputs should reach that run at its next
  // model/tool boundary instead of waiting for the turn to finish and starting a
  // new one. scheduleInputs remains the fallback for runs that cannot steer
  // (images in the queue, paused queues, interrupted/failed dispatch).
  function scheduleSteer(id) {
    if (shuttingDown || steeringSchedules.has(id)) return;
    if (sessions.modeOf(id) !== 'assist' || typeof harness?.steer !== 'function' || !harness.isBusy(id)) return;
    const conversation = sessions.get(id);
    if (!conversation || conversation.queuePaused || !conversation.inputQueue?.length) return;
    steeringSchedules.add(id);
    const operation = messageQueue.then(() => {
      // Release the marker before the round so an input arriving during it can
      // schedule the next round; the helper itself stops as soon as the queue is
      // empty or the run stops being steerable.
      steeringSchedules.delete(id);
      return steerWaitingInputs(id);
    });
    messageQueue = operation.catch(error => output.appendLine(errorText(error)));
  }

  async function steerWaitingInputs(id) {
    if (shuttingDown || typeof harness?.steer !== 'function') return 0;
    let steered = 0;
    for (;;) {
      if (shuttingDown || stoppedInputQueues.has(id)) return steered;
      const conversation = sessions.get(id);
      if (!conversation || conversation.mode !== 'assist' || conversation.queuePaused) return steered;
      const execution = harness.state(id);
      if (!harness.isBusy(id) || execution.canSteer !== true || !execution.runId) return steered;
      const item = conversation.inputQueue.find(input => !input.delivery);
      // Images cannot be steered into a running turn; stop here so the queue
      // keeps FIFO order and that input still runs as its own turn.
      if (!item || item.images?.length) return steered;
      await steerQueuedInput(id, item.id, execution.runId);
      steered++;
    }
  }

  async function drainInputs(id, explicit = false) {
    if (explicit) stoppedInputQueues.delete(id);
    const conversation = sessions.get(id);
    if (shuttingDown || stoppedInputQueues.has(id) || !conversation || conversation.queuePaused || harness.isBusy(id) || !conversation.inputQueue.length) return;
    if (!explicit && ['interrupted', 'failed'].includes(harness.state(id).status)) return;
    const item = conversation.inputQueue[0];
    if (conversation.inputQueue.some(input => input.delivery)) return;
    try {
      assertCanRun(id);
      await sessions.appendMessage(id, { id: item.id, role: 'user', text: item.text, ...(item.images?.length ? { images: item.images } : {}) });
      markFullAccess(id, item.approvalMode);
      if (shuttingDown || stoppedInputQueues.has(id)) return;
      // Persist the in-flight dispatch before launch. If the process stops (or
      // start fails) the item stays in the queue marked sending; reload converts
      // it to the existing "uncertain" state instead of losing it silently.
      await sessions.updateInputQueue(id, current => ({ inputQueue: current.inputQueue.map(input => input.id === item.id ? { ...input, delivery: 'sending' } : input) }));
      if (shuttingDown || stoppedInputQueues.has(id)) {
        await sessions.updateInputQueue(id, () => ({ queuePaused: true }));
        return;
      }
      await harness.start({ conversationId: id, mode: 'assist', executionBranch: conversation.executionBranch,
        text: item.text, images: item.images, approvalMode: item.approvalMode, modelId: item.modelId, context: item.context, messages: sessions.get(id).messages });
      await sessions.updateInputQueue(id, current => ({ inputQueue: current.inputQueue.filter(input => input.id !== item.id) }));
    } catch (error) {
      await sessions.updateInputQueue(id, () => ({ queuePaused: true }));
      throw error;
    }
    publishState();
  }

  async function steerQueuedInput(id, inputId, runId) {
    const conversation = sessions.get(id);
    const item = conversation?.inputQueue.find(input => input.id === inputId);
    if (!item) throw new Error('该输入已开始执行或已从队列移除。');
    const execution = harness.state(id);
    if (shuttingDown || conversation.mode !== 'assist' || !harness.isBusy(id) || !execution.canSteer || runId !== execution.runId) throw new Error('当前运行已变化或尚未就绪，输入仍保留在队列中。');
    if (item.images?.length) throw new Error('带图片的输入会在下一轮发送，不能立刻引导当前任务。');
    await sessions.beginSteering(id, item.id);
    let accepted;
    try { accepted = !shuttingDown && !stoppedInputQueues.has(id) && await harness.steer(id, { id: item.id, runId: execution.runId, text: item.text, context: item.context }); }
    catch (error) {
      // Only the backend's pre-injection admission checks can certify that
      // nothing was sent. Transport errors remain ambiguous and never replay.
      if (error?.code === 'STEERING_NOT_SENT') {
        await sessions.finishSteering(id, item.id, 'rejected');
        throw error;
      }
      await sessions.finishSteering(id, item.id, 'uncertain');
      throw new Error('无法确认引导是否送达，输入及附件仍保留在队列中。请核实执行结果，取回编辑或删除该条后再继续。' + errorText(error));
    }
    await sessions.finishSteering(id, item.id, accepted ? 'accepted' : 'rejected');
    if (!accepted) throw new Error('Agent 尚未就绪或已结束，输入已保留在队列中，请继续发送或稍后引导。');
  }

  function changeInputQueue(message) {
    return updateSession(message.sessionId, async () => {
      const id = message.sessionId;
      if (message.action === 'steerInput') {
        await steerQueuedInput(id, message.inputId, message.runId);
        publishState();
        return;
      }
      let recalled;
      await sessions.updateInputQueue(id, current => {
        if (message.action === 'resumeInputs') {
          if (current.inputQueue.some(input => input.delivery)) throw new Error('请先核实送达待确认的引导，取回编辑或删除后再继续。');
          return { queuePaused: false };
        }
        const item = current.inputQueue.find(entry => entry.id === message.inputId);
        if (!item) throw new Error('该输入已开始执行或已从队列移除。');
        // Capture the removed row inside the same locked mutation so recall can
        // only ever restore an item that was actually dequeued by this call.
        if (message.action === 'removeInput') recalled = item;
        return { inputQueue: current.inputQueue.filter(entry => entry.id !== message.inputId) };
      });
      // Restore composer attachments only after the removal was persisted: a
      // failed save must leave both the queue row and the host maps untouched.
      if (message.action === 'removeInput' && recalled) recallQueuedInput(id, recalled);
      if (message.action === 'resumeInputs') await drainInputs(id, true);
    });
  }

  function rewindInput(message) {
    assertCurrentSession(message.sessionId);
    const validateTarget = () => {
      const conversation = sessions.get(message.sessionId);
      const messageIds = conversation?.mode === 'assist' ? inputMessageIds(conversation.messages, 'user') : [];
      if (conversation?.mode !== 'assist' || typeof message.messageId !== 'string' || !message.messageId
        || !conversation.messages.some((item, index) => item.role === 'user' && messageIds[index] === message.messageId)) {
        throw new Error('该用户消息已不存在，请刷新对话后再回退。');
      }
    };
    // Reject stale requests before changing the stop latch or cancelling a run.
    // Recheck after serialization, since an earlier rewind can remove the target.
    validateTarget();
    stoppedInputQueues.add(message.sessionId);
    return updateSession(message.sessionId, async () => {
      const id = message.sessionId;
      validateTarget();
      await sessions.updateInputQueue(id, () => ({ queuePaused: true }));
      harness.cancel(id);
      const deadline = Date.now() + 30000;
      while (harness.isBusy(id)) {
        if (Date.now() >= deadline) throw new Error('Agent 仍在停止，请稍后重试回退。');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await sessions.rewindInput(id, message.messageId);
      await restoreExecution();
    });
  }

  function runGoal(expectedSessionId) {
    return updateSession(expectedSessionId, async () => {
      const conversation = sessions.current(); assertCanRun(conversation.id);
      if (conversation.mode !== 'goal' || !conversation.goal) throw new Error('请先在探索模式保存一个目标。');
      await harness.start({ conversationId: conversation.id, mode: 'goal', goal: conversation.goal,
        messages: conversation.messages, context: await executionContext(conversation) });
    });
  }

  async function cancelRun(expectedSessionId) {
    assertCurrentSession(expectedSessionId);
    stoppedInputQueues.add(expectedSessionId);
    harness.cancel(sessions.current().id);
    toolApprovals.cancelConversation(expectedSessionId);
    humanQuestions.cancelConversation(expectedSessionId);
    if (sessions.current().mode === 'assist') await sessions.updateInputQueue(expectedSessionId, () => ({ queuePaused: true }));
    return publishState();
  }

  // Selecting a teammate conversation is a read-only presentation operation;
  // it never starts, wakes or interrupts a member.
  function watchTeamMember(expectedSessionId, name) {
    return updateSession(expectedSessionId, async () => {
      if (sessions.current().mode !== 'assist') throw new Error('团队会话仅在协助模式下可用。');
      await harness.watchTeamMember({ conversationId: sessions.current().id, name: name ?? null });
    });
  }

  // Exploration sidebar conversation: a read-only progress Q&A. Every action
  // belongs to the current goal conversation; chat tabs live inside it.
  function goalChatText(text, hasImages = false) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message && !hasImages) throw new Error('请输入要询问的内容或添加图片。');
    if (message.length > 4000) throw new Error('消息过长，请控制在 4000 字以内。');
    return message;
  }
  // Only the fields the attachment store understands cross the page boundary;
  // a page-supplied host path or preview URL is ignored.
  function goalChatImages(images) {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw new Error('图片数据无效。');
    if (images.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`一条消息最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片。`);
    return images.map(image => {
      if (!image || typeof image !== 'object') throw new Error('图片数据无效。');
      return { name: image.name, mimeType: image.mimeType, data: image.data };
    });
  }
  async function saveGoalChatImages(conversationId, images) {
    const saved = [];
    for (const image of images) {
      const descriptor = await saveImage({ conversationId, name: image.name, mimeType: image.mimeType, data: image.data });
      if (!descriptor || !isManagedImage(descriptor.path)) throw new Error('图片未能保存到附件目录。');
      saved.push(descriptor);
    }
    return saved;
  }
  function assertGoalChatConversation() {
    const conversation = sessions.current();
    if (conversation.mode !== 'goal') throw new Error('探索对话仅用于探索模式。');
    if (!conversation.goal) throw new Error('请先在工作台保存探索目标。');
    return conversation;
  }
  async function goalChatSend(expectedSessionId, text, images) {
    const conversation = assertGoalChatConversation();
    assertCurrentSession(expectedSessionId ?? conversation.id);
    const incoming = goalChatImages(images);
    const message = goalChatText(text, incoming.length > 0);
    // Fail before saving or committing the turn when the configured chat model
    // has no vision input; the backend would otherwise persist the user message
    // and then fail the turn, leaving a message the user has to rewind.
    if (incoming.length && !(modelConfiguration.status().input ?? ['text']).includes('image')) {
      throw Object.assign(new Error('当前模型不支持图片输入，请切换支持视觉的模型后再附加图片。'), { code: 'MODEL_IMAGE_UNSUPPORTED' });
    }
    const saved = await saveGoalChatImages(conversation.id, incoming);
    await harness.goalChatSend(conversation.id, message, saved);
    return publishState();
  }
  async function goalChatCancel(expectedSessionId) {
    const conversation = assertGoalChatConversation();
    assertCurrentSession(expectedSessionId ?? conversation.id);
    harness.goalChatCancel(conversation.id);
    return publishState();
  }
  // A saved user-message image is resolved from the current chat transcript; the
  // page never supplies a path, only the id it was shown.
  async function goalChatImage(imageId) {
    if (typeof imageId !== 'string' || !imageId.trim()) throw new Error('图片标识无效。');
    const conversation = assertGoalChatConversation();
    const execution = harness?.state(conversation.id) ?? {};
    const messages = Array.isArray(execution.goalChat?.messages) ? execution.goalChat.messages : [];
    let descriptor;
    for (const message of messages) {
      if (!Array.isArray(message?.images)) continue;
      descriptor = message.images.find(image => image && image.id === imageId);
      if (descriptor) break;
    }
    if (!descriptor) throw new Error('图片已不存在或不属于当前对话。');
    if (!isManagedImage(descriptor.path)) throw new Error('图片不在附件目录中。');
    const loaded = await loadImage(descriptor.path);
    return {
      uri: `data:${loaded.mimeType};base64,${loaded.data}`,
      name: typeof descriptor.name === 'string' && descriptor.name ? descriptor.name : '图片'
    };
  }

  // The exploration chat page posts its own actions; chat tabs are created,
  // selected and rewound inside the current goal conversation.
  async function handleGoalChatPanelAction(message, panel) {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
    const reply = async (ok, extra = {}) => {
      if (!requestId) return;
      try { await panel.webview.postMessage({ type: 'uiResult', requestId, ok, ...extra }); } catch { /* A disposed page cannot receive the result. */ }
    };
    let value = null;
    try {
      const action = message?.action;
      if (action === 'goalChatSend') await goalChatSend(sessions.current().id, message?.text, message?.images);
      else if (action === 'goalChatCancel') await goalChatCancel(sessions.current().id);
      else if (action === 'goalChatImage') value = await goalChatImage(message?.imageId);
      else if (action === 'goalChatRewind') {
        const conversation = assertGoalChatConversation();
        value = await harness.goalChatRewind(conversation.id, message?.messageId);
      }
      else if (action === 'selectGoalChatThread') {
        value = await harness.goalChatSelectThread(assertGoalChatConversation().id, message?.threadId);
      }
      else if (action === 'newGoalChatThread') {
        value = await harness.goalChatNewThread(assertGoalChatConversation().id);
      }
      else if (action === 'deleteGoalChatThread') {
        value = await harness.goalChatDeleteThread(assertGoalChatConversation().id, message?.threadId);
      }
      else if (action === 'copyText') await copyText(message?.text);
      else if (action === 'openMessageLink') await openMessageLink(message?.href, message?.rootIndex);
      else if (action === 'openFiles' || action === 'closeGoalChat') await vscode.commands.executeCommand('ubovm.openFiles');
      else throw Object.assign(new Error('此操作不可用，请重新打开页面后重试。'), { code: 'UNSUPPORTED_ACTION' });
      await reply(true, value ? { value } : {});
      publishGoalChatPanel();
      schedulePublishState();
    } catch (error) {
      output.appendLine(String(error));
      await reply(false, { error: errorText(error), failure: normalizeError(error, message?.action) });
      publishGoalChatPanel();
    }
  }

  async function openGoalChat() {
    const conversation = sessions.current();
    if (conversation.mode !== 'goal' || !conversation.goal) throw new Error('请先在探索模式保存目标，再打开探索对话。');
    publishGoalChatPanel();
    const wasVisible = goalChatPanel.visible;
    // A closed tab would make the sidebar look like a single-page panel; restore
    // the exploration tab strip before deciding whether to reveal/collapse it.
    // The header action is also a recovery path, so it bypasses the one-time flag.
    await ensureExplorationSidebarTabs({ force: !wasVisible });
    // Header button toggles the way the activity-bar view icons do: the first
    // click reveals the chat tab, a second click collapses the right sidebar.
    if (wasVisible) {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      schedulePublishState(120);
      return { open: false };
    }
    await goalChatPanel.show();
    schedulePublishState(120);
    return { open: true };
  }

  function resumeRun(expectedSessionId) {
    return updateSession(expectedSessionId, async () => {
      const conversation = sessions.current();
      const execution = harness.state(conversation.id);
      // Restoring a completed result only commits its saved message. It does
      // not need credentials or permission to execute workspace tools.
      if (execution.status === 'completed' && execution.canResume && !execution.busy) restoreErrors.delete(conversation.id);
      else assertCanRun(conversation.id);
      await harness.resume(conversation.id);
    });
  }

  async function configureModel(input) {
    if (input === undefined) return openSettings('settings', 'model');
    const result = await modelConfiguration.configure(input);
    publishState(); return result;
  }

  async function openSettings(page = 'settings', section = 'model') {
    // Only the model is required to start. SSH/optional sections stay reachable
    // directly (for example from the terminal host picker) even before a model
    // is configured.
    if (page === 'settings' && section === 'model' && !modelConfiguration.status().configured) {
      page = 'initialize';
      section = 'model';
    }
    const revision = ++settingsOpenRevision;
    settingsOpening = revision;
    try {
      await openWelcome();
      const panel = welcome;
      // Creating/revealing an editor does not mean its message listeners exist.
      // Only the newest navigation may proceed after the webview handshake.
      for (let attempt = 0; !welcomeReady && attempt < 200; attempt++) {
        if (revision !== settingsOpenRevision || panel !== welcome || shuttingDown) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (revision !== settingsOpenRevision || panel !== welcome || shuttingDown) return;
      if (!welcomeReady) throw new Error('面板加载超时，请重新打开设置重试。');
      const requestId = `settings-open-${revision}`;
      await panel.webview.postMessage({ type: 'settingsLoading', page, section, requestId });
      try {
        const data = await settingsConfiguration.snapshot({ includeSkills: page === 'skills' });
        data.browserInstallation = browserInstaller.status();
        if (revision === settingsOpenRevision && panel === welcome) await panel.webview.postMessage({ type: 'openSettings', page, data, requestId });
      } catch (error) {
        if (revision === settingsOpenRevision && panel === welcome) await panel.webview.postMessage({ type: 'settingsLoadError', page, requestId, error: errorText(error), failure: normalizeError(error, 'settingsRead') });
        output.appendLine(String(error));
      }
    } finally { if (settingsOpening === revision) settingsOpening = 0; }
  }

  async function lockConversationChrome() {
    const locked = sessions.summary().id;
    chromeLockedSessionId = locked;
    clearTimeout(chromeLockWatchdog);
    chromeLockWatchdog = setTimeout(() => {
      chromeLockWatchdog = undefined;
      if (shuttingDown || chromeLockedSessionId !== locked) return;
      // First escape hatch: republish so the webview can ack contentReady again.
      publishState();
      chromeLockWatchdog = setTimeout(() => {
        chromeLockWatchdog = undefined;
        if (shuttingDown || chromeLockedSessionId !== locked) return;
        // Second escape hatch: never leave native chrome locked forever when
        // paint acknowledgement is lost under load.
        chromeLockedSessionId = undefined;
        void vscode.commands.executeCommand('setContext', 'ubovm.contentReady', true)
          .catch(error => output.appendLine(errorText(error)));
      }, 1600);
    }, 1600);
    if (settingsPage) {
      ++settingsOpenRevision;
      settingsOpening = 0;
      settingsPage = '';
      settingsSection = 'model';
      sidebarChanged.fire();
      await vscode.commands.executeCommand('setContext', 'ubovm.settingsPage', '');
      await welcome?.webview.postMessage({ type: 'closeSettings' });
    }
    // Do not await workbench context updates; the first snapshot must leave
    // immediately. Watchdogs still unlock if paint acknowledgement is lost.
    void vscode.commands.executeCommand('setContext', 'ubovm.contentReady', false)
      .catch(error => output.appendLine(errorText(error)));
  }

  async function finishConversationSwitch(restore) {
    try {
      // Sidebar focus can leave the webview panel in the background after rapid
      // navigation. Reveal it before publishing so the state is not skipped by
      // the "panel hidden" fast path.
      if (welcome) welcome.reveal(welcome.viewColumn || vscode.ViewColumn.One, true);
      publishState();
      if (restore) {
        await restoreExecution();
        // History already painted; restore only needs an execution delta.
        executionPublisher.schedule(sessions.summary().id);
      }
      await revealCurrentInSessionsTree();
    } catch (error) {
      try { publishState(); } catch { /* Keep the original navigation failure. */ }
      throw error;
    }
  }

  function newChat(expectedSessionId, projectId) {
    return navigationAction(async () => {
      assertCurrentSession(expectedSessionId);
      await sessions.create(undefined, projectId);
      await lockConversationChrome();
      return finishConversationSwitch(true);
    });
  }


  function projectSwitcherMessage(options = {}) {
    const query = typeof options.query === 'string' ? options.query : '';
    const create = options.create === true;
    return {
      type: create ? 'openProjectSwitcherCreate' : 'openProjectSwitcher',
      ...(query ? { query } : {}),
      ...(create ? { create: true } : {})
    };
  }

  async function openProjectSwitcher(options = {}) {
    if (creatingProject) return;
    const opts = typeof options === 'string' ? { query: options } : (options && typeof options === 'object' ? options : {});
    await openAssistant(false);
    if (welcomeReady && welcome) {
      pendingProjectSwitcher = null;
      await welcome.webview.postMessage(projectSwitcherMessage(opts));
      try { welcome.reveal(welcome.viewColumn ?? vscode.ViewColumn.Active, false); } catch { /* Focus best-effort. */ }
      return;
    }
    pendingProjectSwitcher = { create: opts.create === true, query: typeof opts.query === 'string' ? opts.query : '' };
  }

  function openProject(id) {
    return navigationAction(async () => {
      const previous = sessions.summary().id;
      await sessions.selectProject(id);
      const switched = sessions.summary().id !== previous;
      if (switched) await lockConversationChrome();
      await openAssistant();
      await finishConversationSwitch(switched);
    });
  }

  function selectConversation(id, sourceId) {
    return navigationAction(async () => {
      const alreadySelected = sessions.summary().id === id;
      if (sourceId !== undefined) await sessions.openRelated(sourceId, id);
      else await sessions.select(id, { crossMode: true });
      if (!alreadySelected) await lockConversationChrome();
      await openWelcome();
      await finishConversationSwitch(!alreadySelected);
    });
  }

  async function revealCurrentInSessionsTree() {
    const view = typeof sessionsView === 'undefined' ? undefined : sessionsView;
    if (!view || shuttingDown) return;
    const current = sessions.current?.() || sessions.get?.(sessions.summary().id);
    if (!current?.id) return;
    try {
      if (current.projectId) {
        const project = sessions.projects?.().find(item => item.id === current.projectId);
        if (project) await view.reveal({ ...project, kind: 'project' }, { expand: true, select: false, focus: false });
      }
      const element = current.projectId
        ? { id: current.id, title: current.title, mode: current.mode, projectId: current.projectId, messageCount: current.messages?.length || 0, updatedAt: current.updatedAt }
        : current;
      await view.reveal(element, { select: true, focus: false });
    } catch (error) {
      if (typeof output !== 'undefined') output.appendLine('会话树定位：' + errorText(error));
    }
  }

  async function deleteConversation(target) {
    const id = typeof target === 'string' ? target : target?.id;
    const conversation = sessions.get(id);
    if (!conversation) return;
    if (harness.isBusy(id)) {
      await postConversationUi({
        type: 'showUbomAlert',
        title: '无法删除',
        message: '此会话正在运行，请先停止后再删除。'
      });
      return;
    }
    await postConversationUi({
      type: 'openConversationDelete',
      conversationId: id,
      title: conversation.title,
      mode: conversation.mode
    });
  }

  async function deleteProject(target, options = {}) {
    const id = typeof target === 'string' ? target : target?.id;
    const project = sessions.projects().find(item => item.id === id);
    if (!project) return;
    const members = () => sessions.projectSessions(id);
    if (members().some(session => harness.isBusy(session.id))) {
      await postConversationUi({
        type: 'showUbomAlert',
        title: '无法删除',
        message: '项目中有会话正在运行，请先停止后再删除。'
      });
      return;
    }
    if (options.confirmed === true) {
      const expectedSessionIds = members().map(session => session.id);
      const operation = messageQueue.then(() => removeProject(id, { expectedSessionIds }));
      messageQueue = operation.catch(() => {});
      return operation;
    }
    await postConversationUi({ type: 'openProjectDelete', projectId: id });
  }

  async function ensureConversationUi() {
    await openAssistant(false);
    if (welcomeReady && welcome) return welcome;
    for (let attempt = 0; attempt < 80 && !shuttingDown; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (welcomeReady && welcome) return welcome;
    }
    throw new Error('对话页面尚未就绪，请稍后重试。');
  }

  async function postConversationUi(message) {
    const panel = await ensureConversationUi();
    await panel.webview.postMessage(message);
    try { panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false); } catch { /* Focus best-effort. */ }
    return panel;
  }

  async function removeConversation(id) {
    if (!sessions.get(id)) return;
    if (harness.isBusy(id)) throw new Error('此会话正在运行，请先停止后再删除。');
    const wasCurrent = sessions.current().id === id;
    await sessions.remove(id);
    toolApprovals.cancelConversation(id);
    humanQuestions.cancelConversation(id);
    fileContexts.delete(id); pendingImages.delete(id); restoreErrors.delete(id); sshHostOverrides.delete(id); executionMemoryCache.delete(id);
    try { await harness.remove(id); await coding.remove(id); codeSummaryRuns.delete(id); await validation.remove(id); }
    catch (error) {
      output.appendLine(String(error));
      await postConversationUi({
        type: 'showUbomAlert',
        title: '清理未完成',
        message: '会话已从列表删除，但本地执行记录清理失败：' + (error.message || String(error))
      }).catch(() => {});
    }
    if (wasCurrent) await restoreExecution();
    return publishState();
  }

  async function removeProject(id, { expectedSessionIds } = {}) {
    const members = () => sessions.projectSessions(id);
    if (!sessions.projects().some(item => item.id === id)) return;
    if (members().some(session => harness.isBusy(session.id))) {
      throw new Error('项目中有会话正在运行，请先停止后再删除。');
    }
    const removed = members();
    const sessionIds = expectedSessionIds || removed.map(session => session.id);
    const wasCurrent = removed.some(session => session.id === sessions.current().id);
    await sessions.removeProject(id, { expectedSessionIds: sessionIds });
    let cleanupFailed = false;
    for (const session of removed) {
      fileContexts.delete(session.id); pendingImages.delete(session.id); restoreErrors.delete(session.id); codeSummaryRuns.delete(session.id); sshHostOverrides.delete(session.id);
      const results = await Promise.allSettled([harness.remove(session.id), coding.remove(session.id), validation.remove(session.id)]);
      for (const result of results) if (result.status === 'rejected') { cleanupFailed = true; output.appendLine(String(result.reason)); }
    }
    if (cleanupFailed) {
      await postConversationUi({
        type: 'showUbomAlert',
        title: '清理未完成',
        message: '项目已从列表删除，但部分本地执行记录清理失败。'
      }).catch(() => {});
    }
    if (wasCurrent) await restoreExecution();
    return publishState();
  }

  async function attachSelection() {
    const sessionId = sessions.current().id;
    assertIdle(sessionId);
    const selected = captureSelection(vscode);
    const operation = messageQueue.then(async () => {
      if (!sessions.get(sessionId)) throw new Error('原会话已不存在，请重新添加选中代码。');
      assertIdle(sessionId);
      fileContexts.set(sessionId, selected);
      publishState();
    });
    messageQueue = operation.catch(() => {});
    await operation;
    if (sessions.current().id === sessionId) {
      await openAssistant();
      await welcome?.webview.postMessage({ type: 'focusInput', sessionId });
    }
  }

  async function attachFile(expectedSessionId, attachment) {
    assertCurrentSession(expectedSessionId);
    const sessionId = sessions.current().id;
    assertIdle(sessionId);
    if (attachment !== undefined) {
      const operation = messageQueue.then(async () => {
        assertCurrentSession(sessionId); assertIdle(sessionId);
        const selected = await require('./harness/workspace/dropped-file.cjs').droppedFile(vscode, attachment);
        assertCurrentSession(sessionId); assertIdle(sessionId);
        fileContexts.set(sessionId, selected);
        return publishState();
      });
      messageQueue = operation.catch(() => {});
      return operation;
    }
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: '添加上下文', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
    if (!uris?.[0]) return publishState();
    const uri = uris[0];
    if (uri.scheme !== 'file' || !uri.fsPath) throw new Error('当前仅支持本地文本文件作为上下文。');
    const operation = messageQueue.then(() => {
      // The picker can outlive a tab switch or a submitted message. Commit to
      // its original session only, after any queued execution has started.
      if (!sessions.get(sessionId)) throw new Error('原会话已不存在，请重新选择上下文文件。');
      assertIdle(sessionId);
      fileContexts.set(sessionId, { label: vscode.workspace.asRelativePath(uri), path: uri.fsPath });
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  function clearFileContext(expectedSessionId) {
    return updateSession(expectedSessionId, () => {
      assertIdle();
      fileContexts.set(sessions.current().id, null);
    });
  }

  async function attachImage(expectedSessionId, image) {
    assertCurrentSession(expectedSessionId);
    const sessionId = sessions.current().id;
    const current = pendingImages.get(sessionId) ?? [];
    if (current.length >= MAX_IMAGES_PER_MESSAGE) throw new Error(`一条消息最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片。`);
    if (!image || typeof image !== 'object') throw new Error('图片数据无效。');
    const saved = await saveImage({ conversationId: sessionId, name: image.name, mimeType: image.mimeType, data: image.data });
    if (!saved || !isManagedImage(saved.path)) throw new Error('图片未能保存到附件目录。');
    if (!current.some(item => item.id === saved.id)) pendingImages.set(sessionId, [...current, saved]);
    return publishState();
  }

  async function attachImagePath(expectedSessionId, uri) {
    assertCurrentSession(expectedSessionId);
    const sessionId = sessions.current().id;
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('仅支持本地图片文件。');
    const parsed = vscode.Uri.parse(uri);
    if (parsed.scheme !== 'file' || !parsed.fsPath) throw new Error('仅支持本地图片文件。');
    const current = pendingImages.get(sessionId) ?? [];
    if (current.length >= MAX_IMAGES_PER_MESSAGE) throw new Error(`一条消息最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片。`);
    const info = await stat(parsed.fsPath);
    if (!info.isFile()) throw new Error('请选择普通图片文件。');
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB。`);
    const buffer = await readFile(parsed.fsPath);
    const saved = await saveImage({ conversationId: sessionId, name: path.basename(parsed.fsPath), data: buffer.toString('base64') });
    if (!saved || !isManagedImage(saved.path)) throw new Error('图片未能保存到附件目录。');
    if (!current.some(item => item.id === saved.id)) pendingImages.set(sessionId, [...current, saved]);
    return publishState();
  }

  function removeImage(expectedSessionId, imageId) {
    assertCurrentSession(expectedSessionId);
    const sessionId = sessions.current().id;
    const current = pendingImages.get(sessionId) ?? [];
    const next = current.filter(image => image.id !== imageId);
    if (next.length === current.length) return publishState();
    if (next.length) pendingImages.set(sessionId, next); else pendingImages.delete(sessionId);
    return publishState();
  }

  async function searchConversations() {
    const mode = sessions.current().mode;
    const items = sessions.search('').map(session => {
      const fields = [session.goal?.objective, ...session.messages.map(item => item.text),
        ...(session.goal?.criteria || []).map(item => item.text), ...(session.goal?.notes || []).map(item => item.text)].filter(Boolean);
      const preview = fields[0] || '尚无内容';
      return {
        id: session.id,
        label: session.title,
        description: session.id === sessions.current().id ? '当前会话' : '',
        detail: preview.replace(/\s+/g, ' ').slice(0, 120),
        searchText: fields.join('\n').replace(/\s+/g, ' ').slice(0, 4000)
      };
    });
    await postConversationUi({ type: 'openConversationSearch', mode, items });
  }

  async function refreshEmptyFolder() {
    const revision = ++folderCheckRevision;
    const folders = sessionFolders(sessions.current().id);
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', folders.length === 0);
    let empty = false;
    if (folders.length === 1) {
      try { empty = (await vscode.workspace.fs.readDirectory(folders[0].uri)).length === 0; }
      catch { /* Keep the native explorer available on unavailable/remote roots. */ }
    }
    if (!shuttingDown && revision === folderCheckRevision) await vscode.commands.executeCommand('setContext', 'ubovm.emptyFolder', empty);
  }

  function scheduleFolderCheck() {
    clearTimeout(folderCheckTimer);
    folderCheckTimer = setTimeout(() => void refreshEmptyFolder().catch(error => output.appendLine(String(error))), 100);
  }

  async function createFirstFile() {
    const root = sessionFolders(sessions.current().id)[0]?.uri;
    if (!root) return chooseWorkspace();
    if (!vscode.workspace.isTrusted) return vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    // Same inline Explorer create path as the toolbar / empty-folder welcome CTA.
    return vscode.commands.executeCommand('explorer.newFile');
  }

  async function onMessage(message, target = welcome) {
    if (!message || typeof message.action !== 'string') return;
    if (message.action === 'connectionProbe') {
      // Always answer the heartbeat first. Spawning a worker must never stall the probe
      // or the UI will declare a false disconnect while the user is clicking around.
      replyConnectionProbe(message.probeId, target);
      return;
    }
    const requestId = typeof message.requestId === 'string' && message.requestId.length <= 100 ? message.requestId : undefined;
    if (message.action === 'settingsInstallBrowser') {
      let result;
      try { result = { ...await installBrowser(false, target), installation: browserInstaller.status() }; }
      catch (error) { result = { ok: false, message: errorText(error), failure: normalizeError(error, message.action) }; }
      await target?.webview.postMessage({ type: 'settingsBrowserInstallResult', ...result });
      return;
    }
    if (message.action === 'settingsCancelBrowserInstall') {
      browserInstaller.cancel('浏览器安装已取消。');
      await target?.webview.postMessage({ type: 'settingsBrowserStatus', installation: browserInstaller.status() });
      return;
    }
    if (message.action === 'settingsBrowserStatus') {
      await target?.webview.postMessage({ type: 'settingsBrowserStatus', installation: browserInstaller.status() });
      return;
    }
    if (message.action === 'settingsBrowserLogs') { output.show(true); return; }
    if (message.action === 'settingsTestSSH' && requestId) {
      const target = welcome;
      void (async () => {
        try {
          const profile = await resolveSSHTestProfile(vscode, context, message.profile);
          const result = await sshConnectionTest.test(profile);
          await target?.webview.postMessage({ type: 'settingsSSHTestResult', requestId, ...result });
        } catch (error) {
          await target?.webview.postMessage({ type: 'settingsSSHTestResult', requestId, ok: false, message: errorText(error), failure: normalizeError(error, message.action) });
        }
      })().catch(() => {});
      return;
    }
    if (message.action === 'settingsTestMcp' && requestId) {
      const target = welcome;
      void (async () => {
        try {
          const name = typeof message.name === 'string' ? message.name : '';
          const entry = vscode.workspace.getConfiguration('ubovm').inspect('mcp');
          const mcp = { ...(entry?.globalValue ?? entry?.defaultValue ?? {}) };
          const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
          const server = servers.find(item => item && item.name === name);
          if (!server) throw new Error('未找到这个 MCP 服务，请先保存配置后再测试。');
          // Credentials live in the secret store keyed by the server identity;
          // hydrate them only inside the host, then force-enable this one server
          // so a saved-but-disabled entry can still be verified.
          const hydrated = await hydrateRuntime({ mcp: { ...mcp, servers: [{ ...server, enabled: true }] } }, context);
          const result = await verifyMcpServerConnection(hydrated.mcp.servers[0]);
          await target?.webview.postMessage({ type: 'settingsMcpTestResult', requestId, ...result });
        } catch (error) {
          await target?.webview.postMessage({ type: 'settingsMcpTestResult', requestId, connected: false, tools: [], ok: false, message: errorText(error), failure: normalizeError(error, message.action) });
        }
      })().catch(() => {});
      return;
    }
    if (message.action === 'settingsTestModel' && requestId) {
      const target = welcome;
      void (async () => {
        try {
          const draft = { ...(message.model || {}) };
          const model = parseModelConfig(draft);
          let apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
          // Password managers sometimes fill the secret box with non-Latin1 text.
          // HTTP Authorization headers cannot carry those characters; prefer the
          // saved key instead of failing the probe with a ByteString error.
          if (apiKey && [...apiKey].some(char => char.charCodeAt(0) > 255)) apiKey = '';
          if (!apiKey) apiKey = await context.secrets.get(modelKeyFor(model)) || '';
          const result = await modelConnectionTest.test({ ...model, apiKey });
          await target?.webview.postMessage({ type: 'settingsModelTestResult', requestId, ...result });
        } catch (error) {
          await target?.webview.postMessage({ type: 'settingsModelTestResult', requestId, ok: false, message: errorText(error), failure: normalizeError(error, message.action) });
        }
      })().catch(() => {});
      return;
    }
    if (message.action === 'settingsInstallSkill') {
      if (!requestId) return;
      try {
        const { installSkill } = require('./harness/config/skills-install.cjs');
        const { defaultDirectory } = require('./harness/config/skills-catalog.cjs');
        const installed = await installSkill({
          url: message.url,
          ...(message.name ? { name: message.name } : {}),
          overwrite: message.overwrite === true
        }, { destination: defaultDirectory });
        const data = await settingsConfiguration.snapshot({ includeSkills: true });
        data.browserInstallation = browserInstaller.status();
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: true, data, saved: false, installed,
          message: `已安装 Skill：${installed.name}。下一轮对话即可按需加载。` });
        publishState();
      } catch (error) {
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      }
      return;
    }
    if (message.action === 'settingsUninstallSkill') {
      if (!requestId) return;
      try {
        const { removeSkill } = require('./harness/config/skills-install.cjs');
        const { defaultDirectory } = require('./harness/config/skills-catalog.cjs');
        const removed = await removeSkill(message.name, { destination: defaultDirectory });
        const data = await settingsConfiguration.snapshot({ includeSkills: true });
        data.browserInstallation = browserInstaller.status();
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: true, data, saved: false, uninstalled: true,
          message: `已删除 Skill：${removed.name}。` });
        publishState();
      } catch (error) {
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      }
      return;
    }
    if (['settingsRead', 'settingsSave'].includes(message.action)) {
      if (!requestId) return;
      try {
        const data = message.action === 'settingsSave'
          ? await settingsConfiguration.save(message.section, message.value, message.revision)
          : await settingsConfiguration.snapshot({ includeSkills: message.page === 'skills' });
        data.browserInstallation = browserInstaller.status();
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: true, data, saved: message.action === 'settingsSave' });
        publishState();
      } catch (error) {
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      }
      return;
    }
    try {
      const goalActions = ['openRelatedConversation', 'setMode', 'setModel', 'saveGoal', 'toggleGoalCriterion', 'addGoalNote', 'editNote', 'editAgentNote', 'attachAssistEvidence', 'prompt', 'runGoal', 'cancelRun', 'interruptCommand', 'backgroundCommand', 'resumeRun', 'newChat', 'selectWorkspace', 'attachFile', 'attachImage', 'attachImagePath', 'removeImage', 'clearFileContext', 'toolApproval', 'answerQuestion'];
      if (goalActions.includes(message.action) && typeof message.sessionId !== 'string') {
        throw new Error('缺少会话标识，请重新打开当前会话后重试。');
      }
      const commands = { folder: 'workbench.action.files.openFolder', terminal: 'ubovm.openLocalTerminal', browser: 'ubovm.openBrowser', source: 'ubovm.openSource',
        openFiles: 'ubovm.openFiles', toggleSessions: 'workbench.action.toggleAuxiliaryBar', toggleFiles: 'workbench.action.toggleSidebarVisibility', manageProjects: 'ubovm.manageProjects',
        managePlugins: 'ubovm.showInstalledPlugins', openPlugin: 'ubovm.openPlugin', marketplace: 'ubovm.openPluginMarketplace' };
      if (Object.hasOwn(commands, message.action)) await vscode.commands.executeCommand(commands[message.action]);
      else if (message.action === 'reloadConversation' && target === welcome) await reloadConversation();
      else if (message.action === 'refreshBlackboard') await refreshBlackboard(message.sessionId);
      else if (message.action === 'exportGoalGraph') await exportGoalGraph(message.sessionId);
      else if (message.action === 'restartWindow') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      else if (message.action === 'setInterfaceLocale') {
        const next = message.locale === 'en' ? 'en' : 'zh-CN';
        try { await context.globalState.update('ubovm.interfaceLocale', next); } catch { /* The page still keeps its own language choice. */ }
        if (message.active !== true || currentInterfaceLocale() === next) return;
        setInterfaceLocale(next);
        publishInterfaceLocale();
        sidebarChanged.fire();
        try { publishSidebarChrome(sessions.summary()); } catch { /* Chrome is published again with the next snapshot. */ }
        blackboardSidebar.applyLanguage();
        workerPanel.applyLanguage();
        goalChatPanel.applyLanguage();
        return;
      }
      else if (message.action === 'setTheme') { await setTheme(vscode, message.theme); }
      else if (message.action === 'blackboardDetail') {
        if (message.sessionId !== sessions.current().id || sessions.current().mode !== 'goal') return;
        blackboardSidebar.setSession(message.sessionId);
        await blackboardSidebar.update(message.detail ? { ...message.detail, sessionId: message.sessionId } : null, message.reveal === true);
      }
      else if (message.action === 'ready') {
        const firstReady = !welcomeReady;
        welcomeReady = true;
        void welcome?.webview?.postMessage?.({ type: 'locale', locale: interfaceLocale() });
        // Coalesce rapid ready storms from visibility + probe reconnect into one snapshot.
        // A chrome lock cannot wait on that debounce or the overlay stays up.
        clearTimeout(readyPublishTimer);
        if (chromeLockedSessionId) publishState();
        else {
          readyPublishTimer = setTimeout(() => {
            readyPublishTimer = undefined;
            if (!shuttingDown) publishState();
          }, 32);
        }
        // A (re)connected page syncs from the backend projection instead of
        // trusting host-cached state; this is a read, never a task replay. The
        // first paint during startup is already covered by the activation restore.
        if (harness && (!firstReady || !recovering) && harness.connectionState().status !== 'idle') scheduleBackendResync(80);
        if (pendingProjectSwitcher && welcome) {
          const pending = pendingProjectSwitcher;
          pendingProjectSwitcher = null;
          await welcome.webview.postMessage(projectSwitcherMessage(pending));
        }
        if (firstReady && !settingsOpening && !modelConfiguration.status().configured) await openSettings();
      }
      else if (message.action === 'toolApproval') {
        if (!sessions.get(message.sessionId)) throw new Error('该审核所属会话已不存在。');
        if (!toolApprovals.respond({ id: message.approvalId, conversationId: message.sessionId, decision: message.decision })) throw new Error('该审核已处理或失效，请查看最新状态。');
      }
      else if (message.action === 'answerQuestion') {
        if (!sessions.get(message.sessionId)) throw new Error('该提问所属会话已不存在。');
        if (!humanQuestions.respond({ id: message.questionId, conversationId: message.sessionId, selected: message.selected, custom: message.custom, cancelled: message.cancelled })) throw new Error('请选择至少一个选项，或填写一条回答后再提交。');
      }
      else if (message.action === 'firstPaint') {
        clearTimeout(recoveryTimer);
        output.appendLine('启动：扩展激活 → 页面首次绘制 ' + (Date.now() - activatedAt) + 'ms');
        releaseFirstPaint();
      }
      else if (message.action === 'contentReady') {
        // A conversation/project lock must be unlocked by that conversation.
        // Settings/initialize paint has no sessionId and must not clear it.
        if (chromeLockedSessionId) {
          if (message.sessionId !== chromeLockedSessionId) return;
        } else if (message.sessionId && message.sessionId !== sessions.current().id) return;
        chromeLockedSessionId = undefined;
        clearTimeout(chromeLockWatchdog);
        chromeLockWatchdog = undefined;
        await vscode.commands.executeCommand('setContext', 'ubovm.contentReady', true);
        clearTimeout(recoveryTimer);
        releaseFirstPaint();
      }
      else if (message.action === 'prompt') await submitPrompt(message.text, message.sessionId, message.approvalMode);
      else if (message.action === 'setModel') await updateSession(message.sessionId, () => sessions.setModel(message.sessionId, message.modelId));
      else if (message.action === 'removeInput' || message.action === 'resumeInputs' || message.action === 'steerInput') await changeInputQueue(message);
      else if (message.action === 'rewindInput') await rewindInput(message);
      else if (message.action === 'selectWorkspace') await chooseWorkspace(message.sessionId);
      else if (message.action === 'revealWorkspace') await revealWorkspace(message.sessionId);
      else if (message.action === 'closeWorkerPanel') await vscode.commands.executeCommand('workbench.view.explorer');
      else if (message.action === 'newChat') await newChat(message.sessionId);
      else if (message.action === 'setMode') await setMode(message.mode, message.sessionId);
      else if (message.action === 'openRelatedConversation') {
        await selectConversation(message.targetId, message.sessionId);
      }
      else if (message.action === 'attachAssistEvidence') {
        assertCurrentSession(message.sessionId);
        if (sessions.current().mode !== 'assist') throw new Error('请在协助模式中选择要附加的证据。');
        if (typeof message.goalId !== 'string' || !message.goalId) throw new Error('请选择关联探索目标。');
        if (!Array.isArray(message.evidenceIds) || !message.evidenceIds.length) throw new Error('请选择要附加的证据。');
        await sessions.attachAssistEvidenceToGoal(message.sessionId, message.goalId, message.evidenceIds);
        publishState();
      }
      else if (message.action === 'openExploration') {
        if (!sessions.goalSummaries().some(goal => goal.id === message.goalSessionId)) throw Object.assign(new Error('探索记录不存在或已删除，请刷新会话列表。'), { code: 'SESSION_NOT_FOUND' });
        await selectConversation(message.goalSessionId);
      }
      else if (message.action === 'saveGoal') await saveGoal(message.goal, message.sessionId);
      else if (message.action === 'toggleGoalCriterion') await toggleGoalCriterion(message.criterionId, message.done, message.sessionId);
      else if (message.action === 'addGoalNote') await addGoalNote(message.text, message.sessionId);
      else if (message.action === 'editNote') await editNote(message.noteId, message.text, message.sessionId);
      else if (message.action === 'editAgentNote') await editAgentNote(message.noteId, message.text, message.sessionId);
      else if (message.action === 'attachFile') await attachFile(message.sessionId, message.attachment);
      else if (message.action === 'attachImage') await attachImage(message.sessionId, message.image);
      else if (message.action === 'attachImagePath') await attachImagePath(message.sessionId, message.uri);
      else if (message.action === 'removeImage') await removeImage(message.sessionId, message.imageId);
      else if (message.action === 'clearFileContext') await clearFileContext(message.sessionId);
      else if (message.action === 'runGoal') await runGoal(message.sessionId);
      else if (message.action === 'cancelRun') await cancelRun(message.sessionId);
      else if (message.action === 'interruptCommand' || message.action === 'backgroundCommand') {
        assertCurrentSession(message.sessionId);
        await harness[message.action](message.sessionId, message.commandId);
        publishState();
      }
      else if (message.action === 'resumeRun') await resumeRun(message.sessionId);
      else if (message.action === 'goalChatSend') await goalChatSend(message.sessionId, message.text, message.images);
      else if (message.action === 'goalChatCancel') await goalChatCancel(message.sessionId);
      else if (message.action === 'openGoalChat') await openGoalChat();
      else if (message.action === 'openSettings') {
        if (message.section === 'reason') await openSettings('settings', 'reason');
        else await configureModel();
      }
      else if (message.action === 'openMcp') await openSettings('mcp');
      else if (message.action === 'openSkills') await openSettings('skills');
      else if (message.action === 'settingsNavigation') {
        const previousPage = settingsPage, previousSection = settingsSection;
        settingsPage = ['settings', 'initialize', 'mcp', 'skills'].includes(message.page) ? message.page : '';
        settingsSection = settingsNavigation.some(([key]) => key === message.section) ? message.section : settingsPage;
        if (previousPage !== settingsPage) await vscode.commands.executeCommand('setContext', 'ubovm.settingsPage', settingsPage);
        if (previousPage !== settingsPage || previousSection !== settingsSection) sidebarChanged.fire();
        // A settings-tab change needs only a sidebar selection update. Building
        // and transmitting the entire chat history here makes long chats stutter.
        if (previousPage !== settingsPage) publishState();
        if (settingsPage && previousPage !== settingsPage) await vscode.commands.executeCommand('workbench.view.extension.ubovm-sessions');
        if (!settingsPage && ['assist', 'goal'].includes(message.mode) && typeof message.sessionId === 'string') {
          await setMode(message.mode, message.sessionId);
        }
      }
      else if (message.action === 'pluginAction') {
        try { await pluginRegistry.invokeSlot(message.pluginId, message.slot, message.contributionId); }
        catch (error) {
          output.appendLine('插件操作失败：' + errorText(error));
          await vscode.window.showErrorMessage('插件操作失败：' + errorText(error));
        }
      }
      else if (message.action === 'openWorker') await workerPanel.show(message.workerId, message.sessionId);
      else if (message.action === 'watchTeamMember') await watchTeamMember(message.sessionId, message.name);
      else if (message.action === 'copyText') await copyText(message.text);
      else if (['openTurnFile', 'reviewCodeTurnFile', 'undoCodeTurn'].includes(message.action)) {
        const id = message.sessionId;
        assertCurrentSession(id);
        if (sessions.get(id)?.mode !== 'assist' || typeof message.turnId !== 'string' || message.turnId.length > 200) throw new Error('修改记录所属会话无效。');
        if (message.action === 'undoCodeTurn') {
          if (harness.isBusy(id)) throw new Error('请等待本轮执行结束后再撤销文件修改。');
          try { await coding.undoTurn(id, message.turnId, message.revision); } finally { publishState(); }
        } else {
          if (typeof message.fileId !== 'string') throw new Error('请选择有效的文件记录。');
          await coding.showTurnFile(id, message.turnId, message.fileId, message.action === 'openTurnFile');
        }
      }
      else if (message.action === 'reviewCodeChanges') {
        const id = message.sessionId || sessions.summary().id;
        if (sessions.current().mode !== 'assist' || sessions.get(id)?.mode !== 'assist') throw Object.assign(new Error('请在协助模式的有效会话中查看代码更改。'), { code: 'INVALID_SESSION_MODE' });
        assertCurrentSession(id);
        await coding.review(id);
      }
      else if (message.action === 'validateCodeChanges') await validation.review(message.sessionId || sessions.summary().id);
      else if (message.action === 'openMessageLink') await openMessageLink(message.href, message.rootIndex);
      else if (message.action === 'projectSwitcherOpen') {
        if (typeof message.projectId !== 'string' || !message.projectId) throw new Error('请选择要打开的项目。');
        await openProject(message.projectId);
      }
      else if (message.action === 'projectSwitcherRename') {
        if (typeof message.projectId !== 'string' || !message.projectId) throw new Error('请选择要重命名的项目。');
        const name = typeof message.name === 'string' ? message.name.trim() : '';
        if (!name || name.length > 60) throw new Error('请输入 1–60 个字符的项目名称。');
        await sessions.renameProject(message.projectId, name);
        publishState();
      }
      else if (message.action === 'projectSwitcherDelete') {
        if (typeof message.projectId !== 'string' || !message.projectId) throw new Error('请选择要删除的项目。');
        if (message.confirmed !== true) throw new Error('请先确认删除项目。');
        await deleteProject({ id: message.projectId }, { confirmed: true });
      }
      else if (message.action === 'confirmConversationDelete') {
        if (message.confirmed !== true) return;
        if (typeof message.conversationId !== 'string' || !message.conversationId) throw new Error('请选择要删除的会话。');
        const operation = messageQueue.then(() => removeConversation(message.conversationId));
        messageQueue = operation.catch(() => {});
        await operation;
      }
      else if (message.action === 'selectConversationFromSearch') {
        if (typeof message.conversationId !== 'string' || !message.conversationId) throw new Error('请选择要打开的会话。');
        await selectConversation(message.conversationId);
      }
      else if (message.action === 'projectSwitcherCreate') {
        if (creatingProject) throw new Error('正在创建项目，请稍候。');
        const name = typeof message.name === 'string' ? message.name.trim() : '';
        if (!name || name.length > 60) throw new Error('请输入 1–60 个字符的项目名称。');
        creatingProject = true;
        const projectMode = sessions.activeMode();
        try {
          let folder;
          if (message.folderMode === 'browse') {
            const workspace = sessions.current().workspace;
            const folderName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'project';
            const suggested = workspace ? path.join(path.dirname(workspace), folderName) : path.resolve(folderName);
            const defaultUri = vscode.Uri.file(path.dirname(path.resolve(suggested)));
            const uris = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
              openLabel: '选择项目目录', title: '新建项目 · 选择项目目录', defaultUri, ignoreFocusOut: true });
            if (!uris?.length) throw Object.assign(new Error('已取消创建项目。'), { code: 'CANCELLED' });
            folder = uris[0];
          } else {
            const suggestedPath = typeof message.suggestedPath === 'string' ? message.suggestedPath.trim() : '';
            if (!suggestedPath || (!path.isAbsolute(suggestedPath) && !path.win32.isAbsolute(suggestedPath))) {
              throw new Error('建议目录无效，请改用浏览选择目录。');
            }
            folder = vscode.Uri.file(path.normalize(suggestedPath));
          }
          if (folder.scheme !== 'file') throw new Error('请选择本地项目目录。');
          const existing = sessions.projectForWorkspace(folder.fsPath);
          if (existing) { await openProject(existing.id); return; }
          const operation = messageQueue.then(async () => {
            if (sessions.activeMode() !== projectMode) throw new Error('模式已切换，请在当前模式中重新新建项目。');
            await vscode.workspace.fs.createDirectory(folder);
            if (!((await vscode.workspace.fs.stat(folder)).type & vscode.FileType.Directory)) throw new Error('项目目录已不可用，请重新输入。');
            await sessions.createProject(name, folder.fsPath);
            await lockConversationChrome();
            await openAssistant();
            await finishConversationSwitch(true);
          });
          messageQueue = operation.catch(() => {});
          await operation;
        } finally { creatingProject = false; }
      }

      else if (message.action === 'restartBackend') await restartAgentBackend();

      else throw Object.assign(new Error('此操作不可用，请重新打开页面后重试。'), { code: 'UNSUPPORTED_ACTION' });
      if (requestId) await target?.webview.postMessage({ type: 'uiResult', requestId, ok: true });
    } catch (error) {
      output.appendLine(String(error));
      if (requestId) await target?.webview.postMessage({ type: 'uiResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      schedulePublishState();
      if (!requestId) void vscode.window.showErrorMessage(`UBOVM：${errorText(error)}`);
    }
  }

  const boundPanels = new WeakSet();
  const preparedPanels = new WeakSet();
  let layoutPending = false;

  function restoredConversation() {
    for (const group of vscode.window.tabGroups.all) {
      const index = group.tabs.findIndex(isConversation);
      if (index !== -1) return { group, index };
    }
  }

  async function focusColumn(column) {
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    for (let index = 1; index < column; index++) {
      await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    }
  }

  function bindConversation(panel, { freshSession = false } = {}) {
    // A late serializer must not replace the live singleton or leave a second
    // CannotClose editor behind after a startup/command race.
    if (welcome && welcome !== panel) { panel.dispose(); return false; }
    if (boundPanels.has(panel)) return true;
    boundPanels.add(panel);
    welcome = panel;
    welcomeReady = false;
    panel.title = '对话';
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(attachmentRoot)] };
    const subscription = panel.webview.onDidReceiveMessage(message => {
      if (panel !== welcome) return;
      // Fast-lane heartbeats before any async onMessage work so UI clicks cannot
      // queue probes behind snapshot rebuilds.
      if (message?.action === 'viewAlive') { lastViewAlive = Date.now(); return; }
      if (message?.action === 'connectionProbe') {
        replyConnectionProbe(message.probeId, panel);
        return;
      }
      return onMessage(message, panel).catch(error => output.appendLine(errorText(error)));
    });
    let aliveGuard;
    panel.webview.html = renderWebview({ version: vscode.version, workspaceName: workspaceName(), freshSession });
    lastViewAlive = Date.now();
    // A crashed/blank webview cannot post messages, so no amount of republishing
    // recovers it. Reload the HTML when a visible panel has been silent for a
    // full minute; sessions and runs live in the extension host and are retained.
    aliveGuard = setInterval(() => {
      if (shuttingDown || welcome !== panel || !panel.visible || !welcomeReady) return;
      if (Date.now() - lastViewAlive < 60000) return;
      lastViewAlive = Date.now();
      output.appendLine('界面无响应，正在自动重新加载 Webview。');
      void reloadConversation().catch(error => output.appendLine(errorText(error)));
    }, 15000);
    let panelVisible = panel.visible;
    const visibilitySubscription = panel.onDidChangeViewState(() => {
      if (welcome !== panel || panelVisible === panel.visible) return;
      panelVisible = panel.visible;
      if (panel.visible && welcomeReady) {
        // Tab/focus churn must not republish the full conversation on every flicker.
        clearTimeout(visibilityPublishTimer);
        visibilityPublishTimer = setTimeout(() => {
          visibilityPublishTimer = undefined;
          if (!shuttingDown && welcome === panel && panel.visible && welcomeReady) publishState();
        }, 120);
      } else if (!workerPanel.visible) executionPublisher.clear();
    });
    panel.onDidDispose(() => {
      clearInterval(aliveGuard);
      subscription.dispose();
      visibilitySubscription.dispose();
      if (welcome === panel) {
        welcome = undefined; welcomeReady = false; executionPublisher.clear({ resetTransport: true });
        ++settingsOpenRevision; settingsOpening = 0;
        settingsPage = ''; settingsSection = 'model'; sidebarChanged.fire();
        void vscode.commands.executeCommand('setContext', 'ubovm.settingsPage', '').catch(error => output.appendLine(errorText(error)));
      }
      // Normal UI closing is blocked by the core CannotClose capability.
      // Recover only if an extension/lifecycle operation disposes the webview.
      if (!shuttingDown) scheduleLayout();
    });
    return true;
  }

  async function lockConversation() {
    welcome.reveal(vscode.ViewColumn.One, false);
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    await vscode.commands.executeCommand('workbench.action.pinEditor');
  }

  async function exportGoalGraph(id = sessions.summary().id) {
    const session = sessions.summary();
    const execution = harness?.state?.(id) ?? {};
    const nodes = Array.isArray(execution.blackboard?.nodes) ? execution.blackboard.nodes : [];
    const intents = nodes.filter(node => node?.kind === 'intent');
    const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
    const clip = (value, max) => {
      const text = String(value ?? '');
      return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
    };
    const compactNode = (node, factChars) => ({
      ...node,
      ...(node?.fact ? { fact: { ...node.fact, content: clip(node.fact.content, factChars) } } : {}),
      ...(Array.isArray(node?.attempts) ? { attempts: node.attempts.slice(-20).map(attempt => ({
        ...attempt,
        ...(attempt?.error ? { error: clip(attempt.error, 1000) } : {})
      })) } : {})
    });
    const compactWorkers = workers => (Array.isArray(workers) ? workers : []).map(worker => ({
      ...worker,
      ...(typeof worker?.streamText === 'string' ? { streamText: clip(worker.streamText, 2000) } : {}),
      ...(Array.isArray(worker?.parts) ? { parts: worker.parts.slice(-40).map(part => ({
        ...part,
        ...(typeof part?.text === 'string' ? { text: clip(part.text, 2000) } : {}),
        ...(typeof part?.output === 'string' ? { output: clip(part.output, 2000) } : {})
      })) } : {})
    }));
    const buildPayload = (exportNodes, factChars, exportWorkers) => ({
      generatedAt: new Date().toISOString(),
      goal: session.goal ?? null,
      conversationId: id,
      signals: {
        facts: nodes.filter(node => node?.kind === 'fact').length,
        intents: intents.length,
        running: intents.filter(node => ['running', 'dispatched', 'claimed'].includes(node?.intent?.status)).length,
        blocked: intents.filter(node => node?.intent?.status === 'blocked').length,
        failed: intents.filter(node => ['failed', 'interrupted'].includes(node?.intent?.status)).length,
        ...(execution.autonomy ? { autonomy: execution.autonomy } : {})
      },
      blackboard: execution.blackboard
        ? { ...execution.blackboard, nodes: exportNodes,
            ...(exportNodes.length < nodes.length ? { truncated: true, omittedNodes: nodes.length - exportNodes.length } : {}) }
        : null,
      workers: exportWorkers,
      result: execution.result ?? null
    });
    let exportNodes = nodes.map(node => compactNode(node, 4000));
    let exportWorkers = compactWorkers(execution.workers);
    let payload = buildPayload(exportNodes, 4000, exportWorkers);
    let text = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_BYTES) {
      // Fall back to a compact projection instead of refusing or hanging on a
      // multi-hundred-MB clipboard/string buffer.
      exportNodes = nodes.map(node => compactNode(node, 1000));
      exportWorkers = compactWorkers(execution.workers).map(worker => ({ ...worker, parts: [] }));
      payload = buildPayload(exportNodes, 1000, exportWorkers);
      text = JSON.stringify(payload, null, 2);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_BYTES) {
      // Extremely large boards: keep the actionable frontier and a recent tail.
      const openStatuses = new Set(['pending', 'running', 'failed', 'interrupted', 'blocked']);
      const selected = new Map();
      for (const node of nodes) {
        if (node?.kind === 'intent' && openStatuses.has(node.intent?.status)) selected.set(node.id, node);
      }
      for (const node of nodes.slice(-400)) selected.set(node.id, node);
      if (nodes[0]) selected.set(nodes[0].id, nodes[0]);
      exportNodes = [...selected.values()].map(node => compactNode(node, 1000));
      payload = buildPayload(exportNodes, 1000, []);
      payload.export = { truncated: true, reason: 'export-size-limit', totalNodes: nodes.length, exportedNodes: exportNodes.length };
      text = JSON.stringify(payload, null, 2);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(base, 'ubovm-graph-' + stamp + '.json')),
      saveLabel: '导出图谱',
      filters: { JSON: ['json'] }
    });
    if (!target) return { cancelled: true };
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage((payload.export?.truncated || payload.blackboard?.truncated ? '已导出精简图谱 JSON：' : '已导出图谱 JSON：') + target.fsPath);
    return { path: target.fsPath, bytes: Buffer.byteLength(text, 'utf8'), truncated: Boolean(payload.export?.truncated || payload.blackboard?.truncated) };
  }
  async function refreshBlackboard(id) {
    // Invalidate the delivered-projection memo so the next publication carries
    // the blackboard and graph again even when the backend revision did not
    // change: the webview may have missed the last heavy tick, and a full
    // snapshot alone is not enough if a retry then omits the projection.
    executionHeavyRevision.delete(id);
    executionMemoryRevision.delete(id);
    // Re-read the backend-owned projection; never rebuild the graph from a
    // lossy UI copy. A stalled/dead backend keeps the last state instead.
    let loaded = null;
    try { if (harness && typeof harness.authoritative === 'function') loaded = await harness.authoritative(id); }
    catch { /* Keep the current projection. */ }
    // A restored/older exploration may not be loaded in the backend yet: its
    // checkpoint restore failed, timed out, or was never started for this
    // conversation. Without this fallback refresh re-published the same
    // board-less projection forever and the blackboard stayed empty.
    // Only the current conversation is restored: a stale refresh click from a
    // previous session must not load an unrelated backend session.
    if (!loaded && !shuttingDown && sessions.summary().id === id) {
      output.appendLine('黑板刷新：该探索会话尚未加载到后端，正在按检查点重新读取…');
      try { await restoreExecutionFor(sessions.current()); } catch { /* restoreExecutionFor records the failure. */ }
    }
    publishState();
  }
  async function reloadConversation() {
    if (!welcome) return openWelcome();
    const panel = welcome;
    ++settingsOpenRevision;
    settingsOpening = 0;
    settingsPage = ''; settingsSection = 'model';
    sidebarChanged.fire();
    welcomeReady = false;
    executionPublisher.clear({ resetTransport: true });
    await vscode.commands.executeCommand('setContext', 'ubovm.settingsPage', '');
    await vscode.commands.executeCommand('setContext', 'ubovm.contentReady', false);
    if (welcome !== panel || shuttingDown) return;
    // A fresh nonce forces a real webview reload while sessions and runs stay
    // in the extension host. Do not dispose the fixed editor or reset its data.
    panel.webview.html = renderWebview({ version: vscode.version, workspaceName: workspaceName() });
    lastViewAlive = Date.now();
    panel.reveal(panel.viewColumn || vscode.ViewColumn.One, false);
  }

  async function openWelcome(preserveFocus = false) {
    if (welcome) {
      // Cross-group moves are vetoed by the core. Layout recovery moves the
      // owning group, while reveal always addresses the panel's current group.
      welcome.reveal(welcome.viewColumn || vscode.ViewColumn.One, preserveFocus);
      scheduleLayout();
      publishState();
      return { viewType: welcome.viewType, reused: true };
    }
    if (openingConversation) return openingConversation;
    openingConversation = (async () => {
      async function resumeRestored() {
        if (welcome) return true;
        const restored = restoredConversation();
        if (!restored) return false;
        const skipRestore = vscode.workspace.getConfiguration().get('workbench.editor.restoreEditors') === false;
        await focusColumn(restored.group.viewColumn);
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', restored.index);
        // Restored webviews resolve lazily. Wait for their registered serializer
        // instead of creating another CannotClose panel while restoration is in flight.
        const attempts = skipRestore ? 20 : 100;
        for (let attempt = 0; !welcome && !shuttingDown && attempt < attempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (welcome) return true;
        if (skipRestore) return false;
        throw new Error('主对话正在恢复，请稍后重试。');
      }
      if (await resumeRestored()) {
        scheduleLayout();
        publishState();
        return { viewType: welcome.viewType, reused: true };
      }
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      if (welcome) {
        scheduleLayout();
        publishState();
        return { viewType: welcome.viewType, reused: true };
      }
      const panel = vscode.window.createWebviewPanel('ubovm.welcome', '对话', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(attachmentRoot)], retainContextWhenHidden: true });
      bindConversation(panel);
      await lockConversation();
      preparedPanels.add(panel);
      scheduleLayout();
      return { viewType: panel.viewType, reused: false };
    })();
    try { return await openingConversation; }
    finally {
      openingConversation = undefined;
      if (layoutPending) { layoutPending = false; scheduleLayout(); }
    }
  }

  function isConversation(tab) {
    return tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('ubovm.welcome');
  }

  function scheduleLayout() {
    if (shuttingDown) return;
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => void maintainLayout().catch(error => output.appendLine(String(error))), 40);
  }

  async function maintainLayout() {
    if (shuttingDown) return;
    if (maintainingLayout || openingConversation) { layoutPending = true; return; }
    maintainingLayout = true;
    try {
      if (!welcome) await openWelcome();
      if (!welcome || shuttingDown) return;
      const owner = restoredConversation()?.group;
      if (owner && owner.viewColumn !== vscode.ViewColumn.One) {
        await focusColumn(owner.viewColumn);
        // Keep the same group identity so the core canMove protection remains
        // intact even for a session restored with the conversation on the right.
        for (let remaining = vscode.window.tabGroups.all.length; remaining > 0; remaining--) {
          const previous = restoredConversation()?.group.viewColumn;
          if (!previous || previous === vscode.ViewColumn.One) break;
          await vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupLeft');
          for (let attempt = 0; restoredConversation()?.group.viewColumn === previous && attempt < 40; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          if (restoredConversation()?.group.viewColumn === previous) throw new Error('无法恢复主对话所在的编辑器组。');
        }
        await lockConversation();
        preparedPanels.add(welcome);
      } else if (!preparedPanels.has(welcome)) {
        await lockConversation();
        preparedPanels.add(welcome);
      }
      const firstGroup = () => vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One);
      // Restored files can be inactive behind the conversation. Drain a bounded
      // snapshot so those tabs cannot later replace the main conversation.
      const misplaced = (firstGroup()?.tabs || []).filter(tab => !isConversation(tab));
      if (misplaced.length > 100) throw new Error('主区域中的文件标签过多，无法自动恢复布局。');
      async function waitForTabChange(predicate, failure) {
        for (let attempt = 0; !predicate() && !shuttingDown && attempt < 80; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (shuttingDown) return false;
        if (!predicate()) throw new Error(failure);
        return true;
      }
      for (const tab of misplaced) {
        if (!firstGroup()?.tabs.includes(tab)) continue;
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const index = firstGroup()?.tabs.indexOf(tab) ?? -1;
        if (index === -1) continue;
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
        if (!await waitForTabChange(
          () => !firstGroup()?.tabs.includes(tab) || firstGroup()?.activeTab === tab,
          `无法激活需要移到右侧的文件：${tab.label}`
        )) return;
        // Core routing may already have moved the file during activation.
        if (!firstGroup()?.tabs.includes(tab)) continue;
        await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
        if (!await waitForTabChange(
          () => !firstGroup()?.tabs.includes(tab),
          `无法将文件移到右侧编辑区：${tab.label}`
        )) return;
      }
      if (misplaced.length) welcome.reveal(vscode.ViewColumn.One, true);
      if (vscode.window.tabGroups.all.length === 1) sideGroupSized = false;
      if (!sideGroupSized && vscode.window.tabGroups.all.length === 2) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.68 }, { size: 0.32 }] });
        sideGroupSized = true;
      }
    } finally {
      maintainingLayout = false;
      if (layoutPending) { layoutPending = false; scheduleLayout(); }
    }
  }

  async function applyUiPreset(force = false) {
    if (!force && context.globalState.get('uiRevision', 0) >= UI_REVISION) return;
    const candidates = [path.join(vscode.env.appRoot, 'ubovm/app.json'), path.resolve(__dirname, '../../resources/app.json')];
    let settings;
    for (const file of candidates) {
      try { settings = JSON.parse(readFileSync(file, 'utf8')).settings; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!settings) throw new Error('缺少界面配置，请运行 npm run setup。');
    const configuration = vscode.workspace.getConfiguration();
    for (const key of UI_KEYS) {
      if (!force && ['workbench.colorTheme', 'window.autoDetectColorScheme'].includes(key) && configuration.inspect(key)?.globalValue !== undefined) continue;
      if (key in settings && configuration.get(key) !== settings[key]) {
        await configuration.update(key, settings[key], vscode.ConfigurationTarget.Global);
      }
    }
    await context.globalState.update('uiRevision', UI_REVISION);
  }

  async function hideUnusedViews() {
    // Native removeView commands only hide a currently visible view, so this
    // also works for existing profiles without toggling hidden views back on.
    const available = new Set(await vscode.commands.getCommands(true));
    for (const view of ['outline', 'timeline', 'workbench.explorer.openEditorsView', 'npm']) {
      if (available.has(`${view}.removeView`)) await vscode.commands.executeCommand(`${view}.removeView`);
    }
  }

  async function openIntegratedBrowser(url) {
    const explicit = typeof url === 'string' && url.trim() ? url.trim() : '';
    // Clicking the floating prompt opens the page the agent is working on; a
    // plain toolbar click keeps the previous "open or focus" behavior.
    const target = explicit || browserAgentActivity?.url || '';
    try {
      const pages = typeof ideBrowserHost.listPages === 'function' ? ideBrowserHost.listPages() : [];
      const column = vscode.ViewColumn.Two;
      if (target) {
        await ideBrowserHost.open(target, { preserveFocus: false, viewColumn: column });
      } else if (pages.length) {
        const active = pages.find(item => item.active) || pages[0];
        if (typeof ideBrowserHost.reveal === 'function') {
          await ideBrowserHost.reveal(active.url || 'about:blank', { preserveFocus: false, force: true, pageId: active.id });
        } else {
          await ideBrowserHost.open(active.url || 'about:blank', { preserveFocus: false, viewColumn: column });
        }
      } else {
        await ideBrowserHost.open('', { preserveFocus: false, viewColumn: column, startBlank: true });
      }
      await vscode.commands.executeCommand('workbench.action.browser.focusUrlInput');
    } catch (error) {
      output.appendLine('打开内置浏览器：' + errorText(error));
      await vscode.window.showErrorMessage(`无法打开内置浏览器：${errorText(error)}`);
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('ubovm.welcome', {
      async deserializeWebviewPanel(panel) {
        if (bindConversation(panel, { freshSession: true })) scheduleLayout();
      }
    }),
    registerCommand('ubovm.openWelcome', () => openWelcome()),
    // Native maximization retains group identity, dirty buffers and the grid's
    // saved sizes. Forward the title-menu context so inactive file groups work.
    registerCommand('ubovm.expandFileEditor', (...args) => vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup', ...args)),
    registerCommand('ubovm.restoreFileEditor', (...args) => vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup', ...args)),
    registerCommand('ubovm.attachSelection', async () => {
      try { await attachSelection(); }
      catch (error) { await vscode.window.showErrorMessage(`UBOVM：${errorText(error)}`); }
    }),
    registerCommand('ubovm.reviewCodeChanges', async () => {
      if (sessions.current().mode !== 'assist') return;
      try { await coding.review(sessions.summary().id); }
      catch (error) { await vscode.window.showErrorMessage(`UBOVM：${errorText(error)}`); }
    }),
    registerCommand('ubovm.validateCodeChanges', async () => {
      try { await validation.review(sessions.summary().id); }
      catch (error) { await vscode.window.showErrorMessage(`UBOVM：${errorText(error)}`); }
    }),
    registerCommand('ubovm.toggleTheme', async () => {
      if (switchingTheme) return;
      switchingTheme = true;
      try { await setTheme(vscode, readTheme(vscode).mode === 'dark' ? 'light' : 'dark'); }
      catch (error) { void vscode.window.showErrorMessage(`主题切换失败：${errorText(error)}`); }
      finally { switchingTheme = false; }
    }),
    registerCommand('ubovm.openAssistant', async () => {
      const result = await openAssistant();
      await welcome?.webview.postMessage({ type: 'focusInput' });
      return result;
    }),
    registerCommand('ubovm.newChat', async () => { await newChat(); const result = await openAssistant(); await welcome?.webview.postMessage({ type: 'focusInput' }); return result; }),
    registerCommand('ubovm.newProject', async options => {
      if (creatingProject) return;
      const suggestedName = typeof options?.suggestedName === 'string' ? options.suggestedName.trim().slice(0, 60) : '';
      return openProjectSwitcher({ create: true, ...(suggestedName ? { query: suggestedName } : {}) });
    }),
    registerCommand('ubovm.newProjectConversation', async entry => { await newChat(undefined, entry.id); const result = await openAssistant(); await welcome?.webview.postMessage({ type: 'focusInput' }); return result; }),
    registerCommand('ubovm.openProject', entry => openProject(typeof entry === 'string' ? entry : entry?.id)),
    registerCommand('ubovm.changeProjectWorkspace', async entry => {
      const projectId = typeof entry === 'string' ? entry : entry?.id;
      if (!projectId || !sessions.projects().some(project => project.id === projectId)) throw new Error('项目已不存在。');
      if (sessions.current().projectId !== projectId) await openProject(projectId);
      return chooseWorkspace(sessions.current().id);
    }),
    registerCommand('ubovm.renameProject', async entry => {
      const project = sessions.projects().find(item => item.id === entry.id);
      if (!project) return;
      await postConversationUi({ type: 'openProjectRename', projectId: project.id });
    }),
    registerCommand('ubovm.deleteProject', entry => deleteProject(entry)),
    registerCommand('ubovm.manageProjects', () => creatingProject ? undefined : openProjectSwitcher()),
    registerCommand('ubovm.newGoal', async () => {
      if (sessions.current().mode !== 'goal') throw new Error('请先切换到探索模式。');
      await newChat(sessions.current().id);
      return openAssistant();
    }),
    registerCommand('ubovm.selectConversation', selectConversation),
    registerCommand('ubovm.showMoreSessions', (projectId, mode) => sessions.showMoreSessions(projectId, mode)),
    registerCommand('ubovm.deleteConversation', deleteConversation),
    registerCommand('ubovm.searchConversations', searchConversations),
    registerCommand('ubovm.hideSessions', () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')),
    registerCommand('ubovm.hideFiles', () => vscode.commands.executeCommand('workbench.action.closeSidebar')),
    registerCommand('ubovm.openFiles', async () => {
      // Always reveal the Explorer, even after its last tab was closed. Some
      // workbench builds resolve openView without activating the target view, so
      // explicitly invoke the Explorer command as well.
      try { await vscode.commands.executeCommand('workbench.action.openView', 'workbench.view.explorer'); } catch { /* older workbench */ }
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.action.focusSideBar');
    }),
    registerCommand('ubovm.createFirstFile', createFirstFile),
    registerCommand('ubovm.selectWorkspace', () => chooseWorkspace()),
    registerCommand('ubovm.revealWorkspace', () => revealWorkspace()),
    registerCommand('ubovm.submitPrompt', submitPrompt),
    registerCommand('ubovm.setMode', setMode),
    registerCommand('ubovm.saveGoal', saveGoal),
    registerCommand('ubovm.toggleGoalCriterion', toggleGoalCriterion),
    registerCommand('ubovm.addGoalNote', addGoalNote),
    registerCommand('ubovm.configureModel', configureModel),
    registerCommand('ubovm.openSettings', () => openSettings()),
    registerCommand('ubovm.installBrowser', installBrowser),
    registerCommand('ubovm.openBrowser', url => openIntegratedBrowser(url)),
    registerCommand('ubovm.setupPythonSandbox', async () => {
      const { setupPythonSandbox } = await import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'terminals', 'python', 'setup.mjs')).href);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在初始化 Python 沙箱', cancellable: false }, () => setupPythonSandbox());
      await vscode.window.showInformationMessage(result.message);
    }),
    registerCommand('ubovm.selectSettings', section => welcome?.webview.postMessage({ type: 'settingsSection', section })),
    registerCommand('ubovm.closeSettings', mode => {
      ++settingsOpenRevision;
      return welcome?.webview.postMessage({ type: 'closeSettings',
        ...(['assist', 'goal'].includes(mode) ? { mode, sessionId: sessions.current().id } : {}) });
    }),
    registerCommand('ubovm.openMcp', () => openSettings('mcp')),
    registerCommand('ubovm.openSkills', () => openSettings('skills')),
    registerCommand('ubovm.runGoal', runGoal),
    registerCommand('ubovm.cancelRun', cancelRun),
    registerCommand('ubovm.resumeRun', resumeRun),
    registerCommand('ubovm.resetLayout', async () => {
      await applyUiPreset(true);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await hideUnusedViews();
      await vscode.commands.executeCommand('workbench.view.extension.ubovm-sessions');
      await openWelcome(); scheduleLayout();
    }),
    registerCommand('ubovm.reloadConversation', reloadConversation),
    registerCommand('ubovm.restartAgentBackend', restartAgentBackend),
    registerCommand('ubovm.openTerminal', () => terminalService.openRemote()),
    registerCommand('ubovm.selectSshHost', () => selectSshHostForSession()),
    registerCommand('ubovm.openLocalTerminal', () => terminalService.switchTo('local')),
    registerCommand('ubovm.selectTerminal', () => terminalService.select()),
    registerCommand('ubovm.openSource', openSource),
    registerCommand('ubovm.installVsixPlugin', () => pluginManager.installVsix()),
    registerCommand('ubovm.installPluginFromUrl', () => pluginManager.installFromUrl()),
    registerCommand('ubovm.searchOpenVsxPlugin', () => pluginManager.openPluginMarketplace()),
    registerCommand('ubovm.openPluginMarketplace', () => pluginManager.openPluginMarketplace()),
    registerCommand('ubovm.openPlugin', () => pluginManager.openPluginPicker()),
    registerCommand('ubovm.showInstalledPlugins', () => pluginManager.showManagerPanel()),
    registerCommand('ubovm.openPluginsFolder', () => pluginManager.openFolder()),
    registerCommand('ubovm.showRuntimeInfo', showRuntimeInfo),
    registerCommand('ubovm.exportDiagnostics', exportDiagnostics),
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Editor focus must not storm full conversation snapshots while the user clicks around files.
      clearTimeout(editorPublishTimer);
      editorPublishTimer = setTimeout(() => {
        editorPublishTimer = undefined;
        if (!shuttingDown && conversationConsumesSnapshot()) publishState();
      }, 250);
    }),
    vscode.window.onDidChangeWindowState(state => {
      // Visibility/probe already coalesce a full ready resync; only nudge the page for focus restore.
      if (!state?.focused || shuttingDown || !welcomeReady || !welcome) return;
      void welcome.webview.postMessage({ type: 'windowFocused' }).catch(error => output.appendLine(errorText(error)));
    }),
    vscode.window.onDidChangeActiveColorTheme(() => welcome?.webview.postMessage({ type: 'themeState', theme: readTheme(vscode) })),
    vscode.window.tabGroups.onDidChangeTabs(scheduleLayout),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleLayout),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleFolderCheck),
    vscode.workspace.onDidCreateFiles(scheduleFolderCheck),
    vscode.workspace.onDidDeleteFiles(scheduleFolderCheck),
    vscode.workspace.onDidRenameFiles(scheduleFolderCheck),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('ubovm')) schedulePublishState(); }),
    context.secrets.onDidChange(() => schedulePublishState()),
    new vscode.Disposable(() => {
      clearTimeout(folderCheckTimer);
      clearTimeout(readyPublishTimer);
      clearTimeout(editorPublishTimer);
      clearTimeout(visibilityPublishTimer);
      clearTimeout(publishStateTimer);
      welcome?.dispose();
    })
  );

  void refreshEmptyFolder().catch(error => output.appendLine(String(error)));

  const status = vscode.window.createStatusBarItem('ubovm.runtime', vscode.StatusBarAlignment.Right, 10);
  status.name = 'UBOVM'; status.text = '$(sparkle) UBOVM'; status.tooltip = '打开助手 · Ctrl+L'; status.command = 'ubovm.openAssistant';
  status.show(); context.subscriptions.push(status);
  // Show navigation independently of settings migration and filesystem work.
  // Otherwise a failed or pending Explorer operation leaves the native Chat
  // container selected, which has no content when built-in AI is disabled.
  void vscode.commands.executeCommand('workbench.view.extension.ubovm-sessions')
    .catch(error => output.appendLine('会话栏初始化失败: ' + String(error)));
  // Each launch starts with the right-hand tools closed. Explicit file/Worker
  // navigation may reveal them later; streaming state never opens them.
  void vscode.commands.executeCommand('workbench.action.closeSidebar')
    .catch(error => output.appendLine('工具栏初始化失败: ' + String(error)));
  void (async () => {
    await applyUiPreset();
    if (shuttingDown) return;
    explorerReady = true;
    await sessionExplorer.sync(sessions.current().workspace);
    await refreshEmptyFolder();
    await hideUnusedViews();
  })().catch(error => output.appendLine(String(error)));
  // Restoration/serialization must run after activation to avoid re-entry.
  scheduleLayout();
  // Recovery must still start if the webview is hidden or fails to acknowledge.
  recoveryTimer = setTimeout(releaseFirstPaint, 1500);
  output.appendLine(`UBOVM 已激活 · Code OSS ${vscode.version}`);
  return { runtimeInfo, assistantState, conversationList: mode => sessions.list(mode) };
}

module.exports = { activate, deactivate: () => shutdownHarness() };
