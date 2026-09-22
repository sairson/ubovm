'use strict';

const vscode = require('vscode');
const { normalize: normalizeError, text: errorText } = require('./webview/errors.js');
const { readFileSync, existsSync } = require('node:fs');
const { open } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { homedir } = require('node:os');
const { createSessions } = require('./harness/sessions.cjs');
const { createDefaultWorkspace } = require('./harness/default-workspace.cjs');
const { createModelConfiguration } = require('./harness/config/model-config.cjs');
const { createSettingsConfiguration, readSSHConfiguration, resolveSSHTestProfile, readSSHStatus, sshConfigurationStatus } = require('./harness/config/settings-config.cjs');
const { createSSHConnectionTest } = require('./host/ssh-connection-test.cjs');
const { createHarnessService } = require('./harness/harness-service.cjs');
const { createWorkspaceSearch } = require('./harness/workspace-search.cjs');
const { createWorkspaceValidation } = require('./harness/workspace-validation.cjs');
const { captureSelection } = require('./harness/selection-context.cjs');
const { createCodingService } = require('./harness/coding-service.cjs');
const { copyText, openMessageLink } = require('./harness/message-actions.cjs').createMessageActions(vscode);
const { renderWebview } = require('./host/webview.cjs');
const { createBlackboardSidebar } = require('./host/blackboard-sidebar.cjs');
const { createExecutionPublisher } = require('./host/state-publisher.cjs');
const { createTerminalService } = require('./host/terminal-service.cjs');
const { readTheme, setTheme } = require('./host/theme.cjs');

let shutdownHarness = async () => {};

const UI_REVISION = 7;
const UI_KEYS = [
  'workbench.colorTheme', 'window.autoDetectColorScheme', 'window.titleBarStyle',
  'window.menuBarVisibility', 'window.commandCenter', 'window.density.editorTabHeight',
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
async function activate(context) {
  let welcome;
  let welcomeReady = false;
  let openingConversation;
  let maintainingLayout = false;
  let sideGroupSized = false;
  let shuttingDown = false;
  let layoutTimer;
  let sessionsView;
  let settingsPage = '', settingsSection = 'model';
  const settingsNavigation = [['model', '模型', 'settings-gear'], ['ssh', 'SSH 连接', 'remote'], ['web', '浏览器与搜索', 'globe'], ['summary', '上下文与摘要', 'note'], ['reason', '思考Agent', 'list-tree'], ['worker', '执行Agent', 'play']];
  const sidebarChanged = new vscode.EventEmitter();
  let publishedMode;
  let conversationSearch;
  let folderCheckTimer;
  let folderCheckRevision = 0;
  let explorerReady = false;
  let explorerWorkspace;
  const sessionExplorer = require('./host/session-explorer.cjs').createSessionExplorer(vscode, { onDidChangeFiles: scheduleFolderCheck });
  context.subscriptions.push(sessionExplorer);
  const fileContexts = new Map();
  let messageQueue = Promise.resolve();
  let harness;
  let executionPublisher;
  let settingsOpenRevision = 0;
  let recovering = true;
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
  const modelConfiguration = createModelConfiguration(vscode, context);
  const settingsConfiguration = createSettingsConfiguration(vscode, context);
  const output = vscode.window.createOutputChannel('UBOVM');
  context.subscriptions.push(new vscode.Disposable(() => { shuttingDown = true; clearTimeout(layoutTimer); clearTimeout(recoveryTimer); releaseFirstPaint(); executionPublisher?.dispose(); void shutdownHarness().catch(error => output.appendLine(String(error))); }), output);
  const sessions = createSessions(vscode, context, publishState, { isBusy: id => harness?.isBusy(id) === true, createWorkspace: createDefaultWorkspace });
  const blackboardSidebar = createBlackboardSidebar(vscode, {
    onSelect: (id, sessionId) => welcome?.webview.postMessage({ type: 'selectBlackboardNode', id, sessionId }),
    onClose: () => welcome?.webview.postMessage({ type: 'closeBlackboardDetails' })
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ubovm.blackboardDetails', blackboardSidebar));
  executionPublisher = createExecutionPublisher({
    currentId: () => sessions.summary().id,
    canPublish: () => !shuttingDown && welcomeReady && welcome?.visible === true && !settingsPage,
    readExecution: () => assistantExecution(sessions.summary()),
    postMessage: message => welcome.webview.postMessage(message),
    onError: error => output.appendLine(String(error))
  });
  const sdkCandidates = [process.env.UBOVM_HARNESS_ENTRY, path.resolve(__dirname, '../harness/index.mjs'), path.join(vscode.env.appRoot, 'ubovm/harness/index.mjs')].filter(Boolean);
  const sdkPath = sdkCandidates.find(candidate => existsSync(candidate));
  const browserInstaller = require('./host/browser-install.cjs').createBrowserInstaller({ sdkPath: sdkPath ?? sdkCandidates[0] });
  let browserInstallOperation;
  function installBrowser(notifyError = true) {
    if (browserInstallOperation) return browserInstallOperation;
    browserInstallOperation = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在下载并安装内置浏览器…', cancellable: false }, async () => {
      try {
        const executablePath = await browserInstaller.install(text => output.append(text));
        output.appendLine('内置浏览器已就绪：' + executablePath);
        void vscode.window.showInformationMessage('内置浏览器已安装，将在下一次运行时自动使用（已有外部浏览器配置优先）。');
        return { ok: true, message: '内置浏览器已安装，将在下一次运行时生效。' };
      } catch (error) {
        output.appendLine(String(error));
        if (notifyError) void vscode.window.showErrorMessage('内置浏览器安装失败：' + errorText(error));
        return { ok: false, message: errorText(error), failure: normalizeError(error, 'settingsInstallBrowser') };
      }
    }).finally(() => { browserInstallOperation = undefined; });
    return browserInstallOperation;
  }
  const sshConnectionTest = createSSHConnectionTest({ loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'ssh-commands-execute.mjs')).href) });
  context.subscriptions.push(sshConnectionTest);
  const terminalService = createTerminalService(vscode, {
    readConfiguration: () => readSSHConfiguration(vscode, context),
    loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'ssh-commands-execute.mjs')).href),
    openSettings: () => openSettings('settings', 'ssh')
  });
  context.subscriptions.push(terminalService, ...terminalService.register());
  const search = createWorkspaceSearch(vscode, { workspaceFolders: sessionFolders });
  const validation = createWorkspaceValidation(vscode, context, { changes: id => coding.changes(id), workspaceFolders: sessionFolders });
  const coding = createCodingService(vscode, context, { beforeEdit: validation.capture, workspaceFolders: sessionFolders });
  context.subscriptions.push(coding, validation);
  const toolApprovals = require('./host/tool-approvals.cjs').createToolApprovals({ onChange: () => publishState() });
  context.subscriptions.push(toolApprovals);
  harness = createHarnessService({
    requestToolApproval: request => toolApprovals.request(request),
    sdkPath: sdkPath ?? sdkCandidates[0],
    storageDirectory: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'harness'),
    workspaceRoots: id => sessionFolders(id).map(folder => folder.uri.fsPath),
    readConfiguration: async () => {
      const configuration = await modelConfiguration.read();
      const ssh = sshConfigurationStatus(configuration.intools?.ssh);
      if (!ssh.configured) throw new Error(ssh.error);
      return browserInstaller.configure(configuration);
    },
    additionalTools: conversationId => [...coding.tools(conversationId), ...search.tools(conversationId), ...validation.tools(conversationId)],
    onChange: id => {
      const current = sessions.summary();
      executionPublisher.schedule(sessions.goalSummaries().some(goal => goal.id === id) ? current.id : id);
    },
    onMessage: (conversationId, message) => sessions.appendMessage(conversationId, message),
  });
  shutdownHarness = () => harness.close();
  // The session snapshot is already in memory. Do not hold UI registration
  // behind disk writes, SDK imports or execution-history recovery.
  messageQueue = sessions.ready.then(() => firstPaint).then(async () => {
    if (shuttingDown) return;
    try { await coding.recover(); } catch (error) { output.appendLine('代码修改状态恢复失败：' + error.message); }
    try {
      await require('./harness/config/skills-catalog.cjs').installBundledSkills(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'agents', 'skills'));
    } catch (error) { output.appendLine('内置 Skills 释放失败：' + error.message); }
    if (!shuttingDown) await restoreExecution();
  }).finally(() => { recovering = false; if (!shuttingDown) publishState(); });
  void messageQueue.catch(error => output.appendLine('会话初始化失败：' + String(error)));
  const sidebarProvider = {
    onDidChangeTreeData: sidebarChanged.event,
    getChildren: element => settingsPage ? (element ? [] : settingsPage === 'settings' ? settingsNavigation : [[settingsPage, settingsPage === 'mcp' ? 'MCP 服务' : 'Skills', settingsPage === 'mcp' ? 'plug' : 'book']]) : sessions.provider.getChildren(element),
    getTreeItem(entry) {
      if (!Array.isArray(entry)) return sessions.provider.getTreeItem(entry);
      const [key, label, icon] = entry, item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = 'settings-' + key; item.iconPath = new vscode.ThemeIcon(icon);
      item.description = key === settingsSection ? '当前' : '';
      item.accessibilityInformation = { label: key === settingsSection ? `${label}，当前设置` : label };
      item.command = { command: 'ubovm.selectSettings', title: label, arguments: [key] };
      return item;
    }
  };
  context.subscriptions.push(sidebarChanged, sessions.provider.onDidChangeTreeData(() => { if (!settingsPage) sidebarChanged.fire(); }));
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
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
      openLabel: '选择工作空间', title: '为当前会话选择工作空间',
      defaultUri: sessions.current().workspace ? vscode.Uri.file(sessions.current().workspace) : vscode.workspace.workspaceFolders?.[0]?.uri });
    if (!uris?.length) return;
    if (uris[0].scheme !== 'file') throw new Error('请选择本地工作空间目录。');
    if (!((await vscode.workspace.fs.stat(uris[0])).type & vscode.FileType.Directory)) throw new Error('工作空间必须是目录。');
    return updateSession(id, async () => {
      assertIdle(id);
      const previous = sessions.get(id)?.workspace;
      const samePath = previous && (process.platform === 'win32' ? path.resolve(previous).toLowerCase() === path.resolve(uris[0].fsPath).toLowerCase() : path.resolve(previous) === path.resolve(uris[0].fsPath));
      if (samePath) {
        await vscode.commands.executeCommand('workbench.view.explorer');
        return;
      }
      await harness.releaseWorkspace(id);
      await sessions.setWorkspace(uris[0].fsPath, id);
      fileContexts.delete(id);
      await restoreExecution();
    });
  }

  function workspaceName() {
    return sessions.current().workspace || '选择工作空间（必选）';
  }

  function assistantState() {
    const conversation = sessions.current();
    const editor = vscode.window.activeTextEditor;
    const attached = fileContexts.get(conversation.id);
    const activeFile = attached !== null && editor?.document.uri.scheme === 'file' ? vscode.workspace.asRelativePath(editor.document.uri) : '';
    const file = attached?.label || activeFile;
    const execution = assistantExecution(conversation);
    return {
      type: 'state', nativeBlackboardSidebar: true, theme: readTheme(vscode), recovering, messages: conversation.messages, conversation: { id: conversation.id, title: conversation.title, legacyDraftId: conversation.legacyDraftId },
      mode: conversation.mode, goal: conversation.goal, conversationIds: sessions.ids(),
      context: { workspace: workspaceName(), workspaceConfigured: Boolean(conversation.workspace), file, fileSource: attached?.kind === 'selection' ? 'selection' : attached ? 'attached' : activeFile ? 'active' : null,
        selectionLabel: attached?.rangeLabel || '' },
      toolApprovals: toolApprovals.snapshot(conversation.id),
      requireToolApproval: (vscode.workspace.getConfiguration('ubovm').inspect('worker')?.globalValue?.requireToolApproval ?? true) !== false,
      provider: modelConfiguration.status(), ssh: readSSHStatus(vscode), execution: { ...execution, mode: conversation.mode }, busy: execution.busy
    };
  }

  function assistantExecution(conversation) {
    const execution = harness?.state(conversation.id) ?? { status: 'idle', busy: false, workers: [], streamText: '', canResume: false };
    if (restoreErrors.has(conversation.id)) execution.error = { message: restoreErrors.get(conversation.id) };
    const explorationRuns = sessions.goalSummaries().map(goal => {
      const run = harness?.runtimeSummary(goal.id) || {};
      return { ...goal, status: run.status || 'idle', phase: run.phase, busy: run.busy === true,
        workerCount: run.workerCount || 0, activeWorkers: run.activeWorkers || 0,
        error: restoreErrors.get(goal.id) || (typeof run.error === 'string' ? run.error : run.error?.message) || '' };
    });
    return { ...execution, mode: conversation.mode, explorationRuns };
  }

  function publishState() {
    executionPublisher?.clear();
    const state = assistantState();
    const currentWorkspace = sessions.current().workspace || '';
    if (explorerReady && explorerWorkspace !== currentWorkspace) {
      explorerWorkspace = currentWorkspace;
      void sessionExplorer.sync(currentWorkspace).catch(error => {
        if (explorerWorkspace === currentWorkspace) explorerWorkspace = undefined;
        output.appendLine('文件树同步失败：' + errorText(error));
      });
      scheduleFolderCheck();
    }
    blackboardSidebar.setSession(state.mode === 'goal' ? state.conversation.id : '');
    const title = state.mode === 'goal' ? '探索工作台' : '协助对话';
    if (welcome && welcome.title !== title) welcome.title = title;
    if (sessionsView) {
      const sidebarTitle = settingsPage ? (settingsPage === 'settings' ? '系统配置' : '扩展管理') : state.mode === 'goal' ? '探索' : '协助';
      const description = settingsPage ? '' : `${sessions.summary().historyCount}`;
      if (sessionsView.title !== sidebarTitle) sessionsView.title = sidebarTitle;
      if (sessionsView.description !== description) sessionsView.description = description;
    }
    if (publishedMode !== state.mode) {
      publishedMode = state.mode;
      void vscode.commands.executeCommand('setContext', 'ubovm.mode', state.mode);
    }
    if (welcomeReady && welcome?.visible === true) void welcome.webview.postMessage(state);
    return state;
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
    return updateSession(expectedSessionId, async () => { await sessions.setMode(mode, expectedSessionId); await restoreExecution(); });
  }

  function assertIdle(id = sessions.current().id) {
    if (harness.isBusy(id)) throw new Error('请先停止当前执行，再修改目标或验收项。');
  }

  function assertCanRun(id = sessions.current().id) {
    if (!sessions.get(id)?.workspace) throw new Error('请先点击顶部的“选择工作空间”，为当前会话配置工作空间。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再运行模型和工具。');
    if (!modelConfiguration.status().configured) throw new Error('请先点击“配置模型”，填写模型地址和凭据。');
    const ssh = readSSHStatus(vscode);
    if (!ssh.configured) throw new Error(ssh.error);
    if (harness.isBusy(id)) throw new Error('当前会话正在运行，请等待完成或先停止。');
    restoreErrors.delete(id);
  }

  async function restoreExecution() {
    if (!harness) return;
    const conversation = sessions.current();
    try {
      await harness.restore({ conversationId: conversation.id, mode: conversation.mode, goal: conversation.goal });
      restoreErrors.delete(conversation.id);
    } catch (error) { restoreErrors.set(conversation.id, error.message || String(error)); output.appendLine(String(error)); }
  }

  async function executionContext(conversation) {
    const editor = vscode.window.activeTextEditor;
    const attached = fileContexts.get(conversation.id);
    if (attached?.kind === 'selection') return { workspace: workspaceName(), ...structuredClone(attached.snapshot) };
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

  function submitPrompt(text, expectedSessionId, approvalMode) {
    if (approvalMode !== undefined && !['auto', 'manual'].includes(approvalMode)) return Promise.reject(new Error('无效的工具执行方式。'));
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(new Error('请先输入消息内容。'));
    if (text.length > 8000) return Promise.reject(new Error('请将每条消息控制在 8000 个字符以内。'));
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      const conversation = sessions.current();
      assertCanRun(conversation.id);
      if (conversation.mode === 'goal' && !conversation.goal) throw new Error('请先保存目标，再开始执行。');
      if (conversation.mode === 'goal' && harness.state(conversation.id).canResume) throw new Error('此目标有待恢复的执行，请先点击“继续执行”。');
      const context = await executionContext(conversation);
      await sessions.appendMessage(conversation.id, { role: 'user', text: text.trim() });
      await harness.start({ conversationId: conversation.id, mode: conversation.mode, goal: conversation.goal,
        text: text.trim(), approvalMode, messages: sessions.get(conversation.id).messages, context });
      await openAssistant();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  function runGoal(expectedSessionId) {
    return updateSession(expectedSessionId, async () => {
      const conversation = sessions.current(); assertCanRun(conversation.id);
      if (conversation.mode !== 'goal' || !conversation.goal) throw new Error('请先在探索模式保存一个目标。');
      await harness.start({ conversationId: conversation.id, mode: 'goal', goal: conversation.goal,
        messages: conversation.messages, context: await executionContext(conversation) });
    });
  }

  function cancelRun(expectedSessionId) {
    assertCurrentSession(expectedSessionId);
    harness.cancel(sessions.current().id);
    return publishState();
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
    if (input === undefined) return openSettings('settings', modelConfiguration.status().configured && !readSSHStatus(vscode).configured ? 'ssh' : 'model');
    const result = await modelConfiguration.configure(input);
    publishState(); return result;
  }

  async function openSettings(page = 'settings', section = 'model') {
    await openWelcome();
    const panel = welcome;
    const revision = ++settingsOpenRevision;
    const requestId = `settings-open-${revision}`;
    await panel.webview.postMessage({ type: 'settingsLoading', page, section, requestId });
    try {
      const data = await settingsConfiguration.snapshot();
      data.browserInstallation = browserInstaller.status();
      if (revision === settingsOpenRevision && panel === welcome) await panel.webview.postMessage({ type: 'openSettings', page, data, requestId });
    } catch (error) {
      if (revision === settingsOpenRevision && panel === welcome) await panel.webview.postMessage({ type: 'settingsLoadError', page, requestId, error: errorText(error), failure: normalizeError(error, 'settingsRead') });
      output.appendLine(String(error));
    }
  }

  function newChat(expectedSessionId) {
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      await sessions.create();
      await restoreExecution();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  function selectConversation(id) {
    const operation = messageQueue.then(async () => {
      await sessions.select(id);
      await restoreExecution();
      await openAssistant();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  async function deleteConversation(target) {
    const id = typeof target === 'string' ? target : target?.id;
    const conversation = sessions.get(id);
    if (!conversation) return;
    if (harness.isBusy(id)) { await vscode.window.showWarningMessage('此会话正在运行，请先停止后再删除。'); return; }
    const label = conversation.mode === 'goal' ? '探索会话' : '会话';
    const choice = await vscode.window.showWarningMessage(`删除${label}“${conversation.title}”？`, {
      modal: true, detail: '将删除此会话的消息、草稿和本地执行记录。工作区文件不会被删除。此操作无法撤销。'
    }, '删除');
    if (choice !== '删除') return;
    const operation = messageQueue.then(async () => {
      if (!sessions.get(id)) return;
      if (harness.isBusy(id)) throw new Error('此会话正在运行，请先停止后再删除。');
      const wasCurrent = sessions.current().id === id;
      // Persist the list first. A storage failure must leave the conversation
      // and its execution history untouched.
      await sessions.remove(id);
      fileContexts.delete(id); restoreErrors.delete(id);
      try { await harness.remove(id); await coding.remove(id); await validation.remove(id); }
      catch (error) {
        output.appendLine(String(error));
        void vscode.window.showWarningMessage('会话已从列表删除，但本地执行记录清理失败：' + (error.message || String(error)));
      }
      if (wasCurrent) await restoreExecution();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
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

  async function attachFile(expectedSessionId) {
    assertCurrentSession(expectedSessionId);
    const sessionId = sessions.current().id;
    assertIdle(sessionId);
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

  function searchConversations() {
    if (conversationSearch) { conversationSearch.show(); return; }
    const mode = sessions.current().mode;
    const picker = vscode.window.createQuickPick();
    conversationSearch = picker;
    picker.title = mode === 'goal' ? '搜索探索会话' : '搜索协助会话';
    picker.placeholder = '搜索标题、消息、目标或笔记；Enter 打开，Esc 取消';
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    const refresh = () => {
      if (sessions.current().mode !== mode) { picker.hide(); return; }
      const query = picker.value.trim().toLocaleLowerCase();
      picker.items = sessions.search(query).map(session => {
        const fields = [session.goal?.objective, ...session.messages.map(item => item.text),
          ...(session.goal?.criteria || []).map(item => item.text), ...(session.goal?.notes || []).map(item => item.text)].filter(Boolean);
        const preview = fields.find(text => query && text.toLocaleLowerCase().includes(query)) || fields[0] || '尚无内容';
        return { label: session.title, description: session.id === sessions.current().id ? '当前会话' : '',
          detail: preview.replace(/\s+/g, ' ').slice(0, 120), alwaysShow: true, sessionId: session.id };
      });
    };
    const subscriptions = [picker.onDidChangeValue(refresh), sessions.provider.onDidChangeTreeData(refresh),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        if (!selected) return;
        picker.hide();
        void selectConversation(selected.sessionId).catch(error => vscode.window.showErrorMessage(`UBOVM：${errorText(error)}`));
      }), picker.onDidHide(() => {
        conversationSearch = undefined;
        subscriptions.forEach(subscription => subscription.dispose());
        picker.dispose();
      })];
    refresh();
    picker.show();
  }

  async function refreshEmptyFolder() {
    const revision = ++folderCheckRevision;
    const folders = sessionFolders(sessions.current().id);
    // A previous check can still be awaiting the command bridge after the
    // session/workspace has changed. Do not let that stale result restore the
    // "no workspace" welcome view over the newly selected workspace.
    if (shuttingDown || revision !== folderCheckRevision) return;
    await vscode.commands.executeCommand('setContext', 'ubovm.noWorkspace', folders.length === 0);
    if (shuttingDown || revision !== folderCheckRevision) return;
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
    const name = await vscode.window.showInputBox({ title: '新建文件', prompt: '在当前文件夹中创建文件', placeHolder: '例如：README.md',
      validateInput: value => !value.trim() || /[\\/:*?"<>|]/.test(value) || /^\.{1,2}$/.test(value.trim()) || /[. ]$/.test(value)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) ? '请输入有效的文件名。' : undefined });
    if (!name) return;
    const uri = vscode.Uri.joinPath(root, name.trim());
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('文件创建失败，请检查目标文件夹权限并重试。');
    await refreshEmptyFolder();
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Two, preview: false });
  }

  async function onMessage(message, target = welcome) {
    if (!message || typeof message.action !== 'string') return;
    const requestId = typeof message.requestId === 'string' && message.requestId.length <= 100 ? message.requestId : undefined;
    if (message.action === 'settingsInstallBrowser') {
      let result;
      try { result = { ...await installBrowser(false), installation: browserInstaller.status() }; }
      catch (error) { result = { ok: false, message: errorText(error), failure: normalizeError(error, message.action) }; }
      await target?.webview.postMessage({ type: 'settingsBrowserInstallResult', ...result });
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
    if (['settingsRead', 'settingsSave'].includes(message.action)) {
      if (!requestId) return;
      try {
        const data = message.action === 'settingsSave'
          ? await settingsConfiguration.save(message.section, message.value, message.revision)
          : await settingsConfiguration.snapshot();
        data.browserInstallation = browserInstaller.status();
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: true, data, saved: message.action === 'settingsSave' });
        publishState();
      } catch (error) {
        await target?.webview.postMessage({ type: 'settingsResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      }
      return;
    }
    try {
      const goalActions = ['setMode', 'saveGoal', 'toggleGoalCriterion', 'addGoalNote', 'prompt', 'runGoal', 'cancelRun', 'resumeRun', 'newChat', 'selectWorkspace', 'attachFile', 'clearFileContext', 'toolApproval'];
      if (goalActions.includes(message.action) && typeof message.sessionId !== 'string') {
        throw new Error('缺少会话标识，请重新打开当前会话后重试。');
      }
      const commands = { folder: 'workbench.action.files.openFolder', terminal: 'ubovm.openTerminal', source: 'ubovm.openSource',
        toggleSessions: 'workbench.action.toggleAuxiliaryBar', toggleFiles: 'workbench.action.toggleSidebarVisibility' };
      if (Object.hasOwn(commands, message.action)) await vscode.commands.executeCommand(commands[message.action]);
      else if (message.action === 'setTheme') { await setTheme(vscode, message.theme); }
      else if (message.action === 'blackboardDetail') {
        if (message.sessionId !== sessions.current().id || sessions.current().mode !== 'goal') return;
        blackboardSidebar.setSession(message.sessionId);
        await blackboardSidebar.update(message.detail ? { ...message.detail, sessionId: message.sessionId } : null, message.reveal === true);
      }
      else if (message.action === 'ready') { welcomeReady = true; publishState(); }
      else if (message.action === 'toolApproval') {
        assertCurrentSession(message.sessionId);
        if (!toolApprovals.respond({ id: message.approvalId, conversationId: message.sessionId, decision: message.decision })) throw new Error('该审核已处理或失效，请查看最新状态。');
      }
      else if (message.action === 'contentReady') {
        await vscode.commands.executeCommand('setContext', 'ubovm.contentReady', true);
        clearTimeout(recoveryTimer);
        releaseFirstPaint();
      }
      else if (message.action === 'prompt') await submitPrompt(message.text, message.sessionId, message.approvalMode);
      else if (message.action === 'selectWorkspace') await chooseWorkspace(message.sessionId);
      else if (message.action === 'newChat') await newChat(message.sessionId);
      else if (message.action === 'setMode') await setMode(message.mode, message.sessionId);
      else if (message.action === 'openExploration') {
        if (!sessions.goalSummaries().some(goal => goal.id === message.goalSessionId)) throw Object.assign(new Error('探索记录不存在或已删除，请刷新会话列表。'), { code: 'SESSION_NOT_FOUND' });
        await selectConversation(message.goalSessionId);
      }
      else if (message.action === 'saveGoal') await saveGoal(message.goal, message.sessionId);
      else if (message.action === 'toggleGoalCriterion') await toggleGoalCriterion(message.criterionId, message.done, message.sessionId);
      else if (message.action === 'addGoalNote') await addGoalNote(message.text, message.sessionId);
      else if (message.action === 'attachFile') await attachFile(message.sessionId);
      else if (message.action === 'clearFileContext') await clearFileContext(message.sessionId);
      else if (message.action === 'runGoal') await runGoal(message.sessionId);
      else if (message.action === 'cancelRun') await cancelRun(message.sessionId);
      else if (message.action === 'resumeRun') await resumeRun(message.sessionId);
      else if (message.action === 'openSettings') await configureModel();
      else if (message.action === 'openMcp') await openSettings('mcp');
      else if (message.action === 'openSkills') await openSettings('skills');
      else if (message.action === 'settingsNavigation') {
        const previousPage = settingsPage, previousSection = settingsSection;
        settingsPage = ['settings', 'mcp', 'skills'].includes(message.page) ? message.page : '';
        settingsSection = settingsNavigation.some(([key]) => key === message.section) ? message.section : settingsPage;
        await vscode.commands.executeCommand('setContext', 'ubovm.settingsPage', settingsPage);
        if (previousPage !== settingsPage || previousSection !== settingsSection) { sidebarChanged.fire(); publishState(); }
        if (settingsPage && previousPage !== settingsPage) await vscode.commands.executeCommand('workbench.view.extension.ubovm-sessions');
      }
      else if (message.action === 'copyText') await copyText(message.text);
      else if (message.action === 'reviewCodeChanges') {
        const id = message.sessionId || sessions.summary().id;
        if (sessions.current().mode !== 'assist' || sessions.get(id)?.mode !== 'assist') throw Object.assign(new Error('请在协助模式的有效会话中查看代码更改。'), { code: 'INVALID_SESSION_MODE' });
        assertCurrentSession(id);
        await coding.review(id);
      }
      else if (message.action === 'validateCodeChanges') await validation.review(message.sessionId || sessions.summary().id);
      else if (message.action === 'openMessageLink') await openMessageLink(message.href, message.rootIndex);
      else throw Object.assign(new Error('此操作不可用，请重新打开页面后重试。'), { code: 'UNSUPPORTED_ACTION' });
      if (requestId) await target?.webview.postMessage({ type: 'uiResult', requestId, ok: true });
    } catch (error) {
      output.appendLine(String(error));
      if (requestId) await target?.webview.postMessage({ type: 'uiResult', requestId, ok: false, error: errorText(error), failure: normalizeError(error, message.action) });
      publishState();
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

  function bindConversation(panel) {
    // A late serializer must not replace the live singleton or leave a second
    // CannotClose editor behind after a startup/command race.
    if (welcome && welcome !== panel) { panel.dispose(); return false; }
    if (boundPanels.has(panel)) return true;
    boundPanels.add(panel);
    welcome = panel;
    welcomeReady = false;
    panel.title = '对话';
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    const subscription = panel.webview.onDidReceiveMessage(message => {
      if (panel !== welcome) return;
      return onMessage(message, panel).catch(error => output.appendLine(errorText(error)));
    });
    let panelVisible = panel.visible;
    const visibilitySubscription = panel.onDidChangeViewState(() => {
      if (welcome !== panel || panelVisible === panel.visible) return;
      panelVisible = panel.visible;
      if (panel.visible && welcomeReady) publishState();
      else executionPublisher.clear();
    });
    panel.onDidDispose(() => {
      subscription.dispose();
      visibilitySubscription.dispose();
      if (welcome === panel) { welcome = undefined; welcomeReady = false; executionPublisher.clear(); }
      // Normal UI closing is blocked by the core CannotClose capability.
      // Recover only if an extension/lifecycle operation disposes the webview.
      if (!shuttingDown) scheduleLayout();
    });
    panel.webview.html = renderWebview({ version: vscode.version, workspaceName: workspaceName() });
    return true;
  }

  async function lockConversation() {
    welcome.reveal(vscode.ViewColumn.One, false);
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    await vscode.commands.executeCommand('workbench.action.pinEditor');
  }

  async function reloadConversation() {
    if (!welcome) return openWelcome();
    const panel = welcome;
    welcomeReady = false;
    executionPublisher.clear();
    await vscode.commands.executeCommand('setContext', 'ubovm.contentReady', false);
    if (welcome !== panel || shuttingDown) return;
    // A fresh nonce forces a real webview reload while sessions and runs stay
    // in the extension host. Do not dispose the fixed editor or reset its data.
    panel.webview.html = renderWebview({ version: vscode.version, workspaceName: workspaceName() });
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
        await focusColumn(restored.group.viewColumn);
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', restored.index);
        // Restored webviews resolve lazily. Wait for their registered serializer
        // instead of creating another panel while restoration is in flight.
        for (let attempt = 0; !welcome && !shuttingDown && attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!welcome) throw new Error('主对话正在恢复，请稍后重试。');
        return true;
      }
      if (await resumeRestored()) {
        scheduleLayout();
        publishState();
        return { viewType: welcome.viewType, reused: true };
      }
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      if (await resumeRestored()) {
        scheduleLayout();
        publishState();
        return { viewType: welcome.viewType, reused: true };
      }
      // The primary group is reserved. Existing files are moved to the fixed
      // right file area by maintainLayout after the conversation is created.
      if (await resumeRestored()) {
        scheduleLayout();
        publishState();
        return { viewType: welcome.viewType, reused: true };
      }
      const panel = vscode.window.createWebviewPanel('ubovm.welcome', '对话', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
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

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('ubovm.welcome', {
      async deserializeWebviewPanel(panel) {
        if (bindConversation(panel)) scheduleLayout();
      }
    }),
    registerCommand('ubovm.openWelcome', () => openWelcome()),
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
    registerCommand('ubovm.newChat', async () => { await newChat(); return openAssistant(); }),
    registerCommand('ubovm.selectConversation', selectConversation),
    registerCommand('ubovm.deleteConversation', deleteConversation),
    registerCommand('ubovm.searchConversations', searchConversations),
    registerCommand('ubovm.hideSessions', () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')),
    registerCommand('ubovm.hideFiles', () => vscode.commands.executeCommand('workbench.action.closeSidebar')),
    registerCommand('ubovm.createFirstFile', createFirstFile),
    registerCommand('ubovm.selectWorkspace', () => chooseWorkspace()),
    registerCommand('ubovm.submitPrompt', submitPrompt),
    registerCommand('ubovm.setMode', setMode),
    registerCommand('ubovm.saveGoal', saveGoal),
    registerCommand('ubovm.toggleGoalCriterion', toggleGoalCriterion),
    registerCommand('ubovm.addGoalNote', addGoalNote),
    registerCommand('ubovm.configureModel', configureModel),
    registerCommand('ubovm.openSettings', () => openSettings()),
    registerCommand('ubovm.installBrowser', installBrowser),
    registerCommand('ubovm.selectSettings', section => welcome?.webview.postMessage({ type: 'settingsSection', section })),
    registerCommand('ubovm.closeSettings', () => welcome?.webview.postMessage({ type: 'closeSettings' })),
    registerCommand('ubovm.openMcp', () => openSettings('mcp')),
    registerCommand('ubovm.openSkills', () => openSettings('skills')),
    registerCommand('ubovm.runGoal', runGoal),
    registerCommand('ubovm.cancelRun', cancelRun),
    registerCommand('ubovm.resumeRun', resumeRun),
    registerCommand('ubovm.resetLayout', async () => {
      await applyUiPreset(true);
      await vscode.commands.executeCommand(sessions.current().workspace ? 'workbench.view.explorer' : 'workbench.action.closeSidebar');
      await hideUnusedViews();
      await vscode.commands.executeCommand('workbench.view.extension.ubovm-sessions');
      await openWelcome(); scheduleLayout();
    }),
    registerCommand('ubovm.reloadConversation', reloadConversation),
    registerCommand('ubovm.openTerminal', () => terminalService.open()),
    registerCommand('ubovm.openLocalTerminal', () => terminalService.open('local')),
    registerCommand('ubovm.selectTerminal', () => terminalService.select()),
    registerCommand('ubovm.openSource', openSource),
    registerCommand('ubovm.showRuntimeInfo', showRuntimeInfo),
    vscode.window.onDidChangeActiveTextEditor(publishState),
    vscode.window.onDidChangeActiveColorTheme(() => welcome?.webview.postMessage({ type: 'themeState', theme: readTheme(vscode) })),
    vscode.window.tabGroups.onDidChangeTabs(scheduleLayout),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleLayout),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleFolderCheck),
    vscode.workspace.onDidCreateFiles(scheduleFolderCheck),
    vscode.workspace.onDidDeleteFiles(scheduleFolderCheck),
    vscode.workspace.onDidRenameFiles(scheduleFolderCheck),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('ubovm')) publishState(); }),
    context.secrets.onDidChange(() => publishState()),
    new vscode.Disposable(() => { clearTimeout(folderCheckTimer); conversationSearch?.hide(); welcome?.dispose(); })
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
