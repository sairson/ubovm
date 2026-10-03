'use strict';

const vscode = require('vscode');
const { normalize: normalizeError, text: errorText } = require('./webview/errors.js');
const { readFileSync, existsSync } = require('node:fs');
const { open } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { homedir } = require('node:os');
const { createSessions, inputMessageIds } = require('./harness/session/sessions.cjs');
const { createDefaultWorkspace, ensureDefaultWorkspace } = require('./harness/workspace/default-workspace.cjs');
const { createModelConfiguration } = require('./harness/config/model-config.cjs');
const { createSettingsConfiguration, readSSHConfiguration, resolveSSHTestProfile, readSSHStatus, sshConfigurationStatus } = require('./harness/config/settings-config.cjs');
const { createSSHConnectionTest } = require('./host/system/ssh-connection-test.cjs');
const { createHarnessService } = require('./host/agent/agent-service.cjs');
const { createWorkspaceSearch } = require('./harness/workspace/workspace-search.cjs');
const { createWorkspaceAudit } = require('./harness/workspace/workspace-audit.cjs');
const { createWorkspaceValidation } = require('./harness/workspace/workspace-validation.cjs');
const { captureSelection } = require('./harness/workspace/selection-context.cjs');
const { createCodingService } = require('./harness/coding/coding-service.cjs');
const { copyText, openMessageLink } = require('./harness/session/message-actions.cjs').createMessageActions(vscode);
const { renderWebview } = require('./host/ui/webview.cjs');
const { createBlackboardSidebar } = require('./host/ui/blackboard-sidebar.cjs');
const { createExecutionPublisher } = require('./host/agent/state-publisher.cjs');
const { createTerminalService } = require('./host/system/terminal-service.cjs');
const { readTheme, setTheme } = require('./host/system/theme.cjs');

let shutdownHarness = async () => {};

const UI_REVISION = 10;
const UI_KEYS = [
  'workbench.colorTheme', 'window.autoDetectColorScheme', 'window.titleBarStyle',
  'window.menuBarVisibility', 'window.enableMenuBarMnemonics', 'window.customMenuBarAltFocus', 'window.commandCenter', 'window.density.editorTabHeight',
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
  let viewRevision = 0;
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
  const settingsNavigation = [['model', '模型', 'settings-gear'], ['ssh', 'SSH 连接', 'remote'], ['web', '浏览器与搜索', 'globe'], ['python', 'Python 执行', 'terminal'], ['summary', '上下文与摘要', 'note'], ['reason', '思考Agent', 'list-tree'], ['worker', '执行Agent', 'play']];
  const sidebarChanged = new vscode.EventEmitter();
  let publishedMode;
  let folderCheckTimer;
  let folderCheckRevision = 0;
  let explorerReady = false;
  let explorerWorkspace;
  const sessionExplorer = require('./host/ui/session-explorer.cjs').createSessionExplorer(vscode, { onDidChangeFiles: scheduleFolderCheck });
  context.subscriptions.push(sessionExplorer);
  const fileContexts = new Map();
  let messageQueue = Promise.resolve();
  let harness;
  let executionPublisher;
  let settingsOpenRevision = 0;
  let settingsOpening = 0;
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
      const current = sessions.summary(), execution = assistantExecution(current);
      return { sessionId: current.id, workers: execution.workers || [], error: execution.workerViewError?.message };
    },
    onAction: onMessage,
    onError: error => output.appendLine(String(error))
  });
  context.subscriptions.push(workerPanel, vscode.window.registerWebviewViewProvider('ubovm.workerLogs', workerPanel, { webviewOptions: { retainContextWhenHidden: true } }));
  executionPublisher = createExecutionPublisher({
    currentId: () => sessions.summary().id,
    canPublish: () => !shuttingDown && (workerPanel.visible || welcomeReady && welcome?.visible === true && !settingsPage),
    readExecution: () => assistantExecution(sessions.summary()),
    postMessage: message => {
      // Worker delivery owns its own bounded queue. A slow or closing sidebar
      // must not hold the main conversation's streaming publication open.
      if (message.type === 'executionState') void workerPanel.publish({ sessionId: message.conversationId, workers: message.execution.workers || [], error: message.execution.workerViewError?.message });
      if (!(welcomeReady && welcome?.visible === true && !settingsPage)) return undefined;
      // Full snapshots already carry a revision from publishState; do not burn a second slot.
      const revision = Number.isInteger(message.viewRevision) ? message.viewRevision : ++viewRevision;
      return welcome.webview.postMessage({ ...message, viewRevision: revision });
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
  const browserInstaller = require('./host/system/browser-install.cjs').createBrowserInstaller({ sdkPath: sdkPath ?? sdkCandidates[0] });
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
  const sshConnectionTest = createSSHConnectionTest({ loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'terminals', 'ssh-terminal', 'commands.mjs')).href) });
  context.subscriptions.push(sshConnectionTest);
  const terminalService = createTerminalService(vscode, {
    readConfiguration: () => readSSHConfiguration(vscode, context),
    loadSSH: () => import(pathToFileURL(path.join(path.dirname(sdkPath ?? sdkCandidates[0]), 'intools', 'terminals', 'ssh-terminal', 'commands.mjs')).href),
    openSettings: () => openSettings('settings', 'ssh')
  });
  context.subscriptions.push(terminalService, ...terminalService.register());
  const search = createWorkspaceSearch(vscode, { workspaceFolders: sessionFolders });
  const audit = createWorkspaceAudit(vscode, { workspaceFolders: sessionFolders });
  const validation = createWorkspaceValidation(vscode, context, { changes: id => coding.changes(id), workspaceFolders: sessionFolders });
  const coding = createCodingService(vscode, context, { beforeEdit: validation.capture, workspaceFolders: sessionFolders,
    turnId: id => harness?.state(id).runId });
  context.subscriptions.push(coding, validation);
  const toolApprovals = require('./host/agent/tool-approvals.cjs').createToolApprovals({ onChange: () => schedulePublishState() });
  const stoppedInputQueues = new Set();
  const scheduledInputQueues = new Set();
  context.subscriptions.push(toolApprovals);
  let learningRecovery, learningStartup = Promise.resolve();
  const codeSummaryRuns = new Map();
  harness = createHarnessService({
    onError: error => output.appendLine('Agent 后端连接失败：' + JSON.stringify(error)),
    beforeSession: async () => { await learningStartup; return learningRecovery?.pause(); },
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
    additionalTools: conversationId => [...coding.tools(conversationId), ...search.tools(conversationId), ...audit.tools(conversationId), ...validation.tools(conversationId), ...require('./harness/session/goal-tools.cjs').goalTools(sessions, conversationId)],
    onChange: id => {
      sessions.refreshRunning(id);
      const current = sessions.summary();
      executionPublisher.schedule(sessions.goalSummaries().some(goal => goal.id === id) ? current.id : id);
      const execution = harness?.state(id);
      const completedRun = execution?.runId && !harness.isBusy(id) ? execution.runId + ':' + execution.status : undefined;
      if (completedRun && codeSummaryRuns.get(id) !== completedRun) {
        codeSummaryRuns.set(id, completedRun);
        void coding.recover(id).catch(error => output.appendLine('文件修改状态核对失败：' + errorText(error)))
          .finally(() => { if (!shuttingDown && sessions.summary().id === id) schedulePublishState(); });
      }
      if (harness && !harness.isBusy(id) && harness.state(id).status === 'completed') scheduleInputs(id);
    },
    onMessage: async (conversationId, message) => {
      try { await coding.recover(conversationId); } catch (error) { output.appendLine('本轮文件记录核对失败：' + errorText(error)); }
      return sessions.appendMessage(conversationId, message);
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
  }).finally(() => { recovering = false; if (!shuttingDown) publishState(); });
  messageQueue = messageQueue.catch(error => output.appendLine('会话初始化失败：' + String(error)));
  const sidebarProvider = {
    onDidChangeTreeData: sidebarChanged.event,
    getChildren: element => sessions.provider.getChildren(element),
    getTreeItem: entry => sessions.provider.getTreeItem(entry)
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
    const relatedConversations = sessions.related(conversation.id);
    const assistEvidence = conversation.mode !== 'assist' ? [] : (conversation.assistEvidence || []).map(item => ({
      ...item,
      attachedGoalIds: relatedConversations.filter(goal => goal.mode === 'goal' && (goal.sourceEvidenceIds || []).includes(item.id)).map(goal => goal.id)
    }));
    return {
      type: 'state', nativeWorkerPanel: true, nativeBlackboardSidebar: true, theme: readTheme(vscode), recovering, messages: conversation.messages.map((message, index) => message.role === 'user' ? { ...message, id: messageIds[index] } : message), inputQueue: conversation.inputQueue?.map(({ id, text, delivery }) => ({ id, text, delivery })), queuePaused: conversation.queuePaused || ['interrupted', 'failed'].includes(harness.state(conversation.id).status), conversation: { id: conversation.id, title: conversation.title, legacyDraftId: conversation.legacyDraftId },
      mode: conversation.mode, goal: conversation.goal, assistEvidence, conversationIds: sessions.ids(), relatedConversations,
      context: { workspace: workspaceName(conversation), workspaceConfigured: Boolean(conversation.workspace), projectId: conversation.projectId || null, file, fileSource: attached?.kind === 'selection' ? 'selection' : attached ? 'attached' : activeFile ? 'active' : null,
        selectionLabel: attached?.rangeLabel || '' },
      toolApprovals: toolApprovals.snapshot(conversation.id), codeChanges: coding.turnSummary(conversation.id),
      requireToolApproval: (vscode.workspace.getConfiguration('ubovm').inspect('worker')?.globalValue?.requireToolApproval ?? true) !== false,
      provider: modelConfiguration.status(), ssh: readSSHStatus(vscode), execution: { ...execution, mode: conversation.mode }, busy: execution.busy,
      projects: projectCatalog()
    };
  }

  function assistantExecution(conversation) {
    const execution = harness?.state(conversation.id) ?? { status: 'idle', busy: false, workers: [], streamText: '', canResume: false };
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

  function publishSidebarChrome(conversation) {
    const title = conversation.mode === 'goal' ? '探索工作台' : '协助对话';
    if (welcome && welcome.title !== title) welcome.title = title;
    if (sessionsView) {
      const sidebarTitle = settingsPage ? (settingsPage === 'initialize' ? '首次初始化' : settingsPage === 'settings' ? '系统配置' : '扩展管理') : conversation.mode === 'goal' ? '探索' : '协助';
      const description = settingsPage ? '' : `${conversation.historyCount ?? sessions.summary().historyCount}`;
      if (sessionsView.title !== sidebarTitle) sessionsView.title = sidebarTitle;
      if (sessionsView.description !== description) sessionsView.description = description;
    }
    if (publishedMode !== conversation.mode) {
      publishedMode = conversation.mode;
      void vscode.commands.executeCommand('setContext', 'ubovm.mode', conversation.mode);
    }
    blackboardSidebar.setSession(conversation.mode === 'goal' ? conversation.id : '');
  }

  function publishState() {
    if (shuttingDown) return;
    const showConversation = conversationConsumesSnapshot();
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

  function probeBackend() {
    const backend = harness?.connectionState() ?? { status: 'idle' };
    // A busy session with a flapping worker is degraded, not an IDE disconnect.
    // Keep the probe green and let ensureIdle repair in the background.
    if (backend.status === 'disconnected' && harness) {
      const currentId = sessions.summary()?.id;
      if (currentId && harness.isBusy(currentId)) return { status: 'connected', recovering: true };
    }
    return backend;
  }

  function replyConnectionProbe(probeId, target = welcome) {
    if (typeof probeId !== 'string' || probeId.length > 100) return false;
    const backend = probeBackend();
    // Never await the bridge: a stalled postMessage must not block the extension
    // host or the next inbound heartbeat.
    void target?.webview.postMessage({ type: 'connectionStatus', probeId, backend }).catch(error => output.appendLine(errorText(error)));
    if (harness && (backend.status === 'disconnected' || backend.recovering)) {
      void harness.ensureIdle().then(result => {
        if (shuttingDown || result?.status !== 'connected') return;
        const currentId = sessions.summary()?.id;
        if (currentId && harness.state(currentId).canResume) publishState();
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
      await ensureDefaultWorkspace(conversation);
      await harness.restore({ conversationId: conversation.id, mode: conversation.mode, goal: conversation.goal, executionBranch: conversation.executionBranch });
      restoreErrors.delete(conversation.id);
    } catch (error) { restoreErrors.set(conversation.id, error.message || String(error)); output.appendLine(String(error)); }
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

  function submitPrompt(text, expectedSessionId, approvalMode) {
    if (approvalMode !== undefined && !['auto', 'manual'].includes(approvalMode)) return Promise.reject(new Error('无效的工具执行方式。'));
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(new Error('请先输入消息内容。'));
    if (text.length > 8000) return Promise.reject(new Error('请将每条消息控制在 8000 个字符以内。'));
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      const conversation = sessions.current();
      if (conversation.mode === 'assist') {
        const context = await executionContext(conversation);
        await sessions.updateInputQueue(conversation.id, current => {
          if (current.inputQueue.length >= 20) throw new Error('输入队列最多保留 20 条消息。');
          return { inputQueue: [...current.inputQueue, { id: randomUUID(), text: text.trim(), approvalMode, context }],
            queuePaused: current.inputQueue.length ? current.queuePaused : false };
        });
        if (!harness.isBusy(conversation.id)) {
          try { await drainInputs(conversation.id, !conversation.inputQueue.length); }
          catch (error) {
            output.appendLine(errorText(error));
            void vscode.window.showErrorMessage('输入已保存，但未能启动执行：' + errorText(error) + '。可取回队列输入或回退该消息后重试。');
          }
        }
        return publishState();
      }
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

  async function drainInputs(id, explicit = false) {
    if (explicit) stoppedInputQueues.delete(id);
    const conversation = sessions.get(id);
    if (shuttingDown || stoppedInputQueues.has(id) || !conversation || conversation.queuePaused || harness.isBusy(id) || !conversation.inputQueue.length) return;
    if (!explicit && ['interrupted', 'failed'].includes(harness.state(id).status)) return;
    const item = conversation.inputQueue[0];
    if (conversation.inputQueue.some(input => input.delivery)) return;
    try {
      assertCanRun(id);
      await sessions.appendMessage(id, { id: item.id, role: 'user', text: item.text });
      if (shuttingDown || stoppedInputQueues.has(id)) return;
      // Commit dequeue before launch: a later persistence failure must never
      // make an accepted model/tool execution eligible for automatic replay.
      await sessions.updateInputQueue(id, current => ({ inputQueue: current.inputQueue.filter(input => input.id !== item.id) }));
      if (shuttingDown || stoppedInputQueues.has(id)) {
        await sessions.updateInputQueue(id, current => ({ inputQueue: [item, ...current.inputQueue], queuePaused: true }));
        return;
      }
      await harness.start({ conversationId: id, mode: 'assist', executionBranch: conversation.executionBranch,
        text: item.text, approvalMode: item.approvalMode, context: item.context, messages: sessions.get(id).messages });
    } catch (error) {
      await sessions.updateInputQueue(id, () => ({ queuePaused: true }));
      throw error;
    }
    publishState();
  }

  function changeInputQueue(message) {
    return updateSession(message.sessionId, async () => {
      const id = message.sessionId;
      if (message.action === 'steerInput') {
        const conversation = sessions.get(id);
        const item = conversation?.inputQueue.find(input => input.id === message.inputId);
        if (!item) throw new Error('该输入已开始执行或已从队列移除。');
        const execution = harness.state(id);
        if (shuttingDown || conversation.mode !== 'assist' || !harness.isBusy(id) || !execution.canSteer || message.runId !== execution.runId) throw new Error('当前运行已变化或尚未就绪，输入仍保留在队列中。');
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
        if (!accepted) {
          throw new Error('Agent 尚未就绪或已结束，输入已保留在队列中，请继续发送或稍后引导。');
        }
        publishState();
        return;
      }
      await sessions.updateInputQueue(id, current => {
        if (message.action === 'resumeInputs') {
          if (current.inputQueue.some(input => input.delivery)) throw new Error('请先核实送达待确认的引导，取回编辑或删除后再继续。');
          return { queuePaused: false };
        }
        if (!current.inputQueue.some(item => item.id === message.inputId)) throw new Error('该输入已开始执行或已从队列移除。');
        return { inputQueue: current.inputQueue.filter(item => item.id !== message.inputId) };
      });
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
    if (sessions.current().mode === 'assist') await sessions.updateInputQueue(expectedSessionId, () => ({ queuePaused: true }));
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
    if (page === 'settings' && (!modelConfiguration.status().configured || !readSSHStatus(vscode).configured)) {
      page = 'initialize';
      section = modelConfiguration.status().configured ? 'ssh' : 'model';
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

  function newChat(expectedSessionId, projectId) {
    const operation = messageQueue.then(async () => {
      assertCurrentSession(expectedSessionId);
      await sessions.create(undefined, projectId);
      await restoreExecution();
      return publishState();
    });
    messageQueue = operation.catch(() => {});
    return operation;
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
    const operation = messageQueue.then(async () => {
      const previous = sessions.summary().id;
      await sessions.selectProject(id);
      await openAssistant();
      if (sessions.summary().id !== previous) await restoreExecution();
      await publishState();
      await revealCurrentInSessionsTree();
    });
    messageQueue = operation.catch(() => {});
    return operation;
  }

  function selectConversation(id, sourceId) {
    const operation = messageQueue.then(async () => {
      const alreadySelected = sessions.summary().id === id;
      if (sourceId !== undefined) await sessions.openRelated(sourceId, id);
      else await sessions.select(id, { crossMode: true });
      await openWelcome();
      if (!alreadySelected) await restoreExecution();
      await publishState();
      await revealCurrentInSessionsTree();
    });
    messageQueue = operation.catch(() => {});
    return operation;
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
    fileContexts.delete(id); restoreErrors.delete(id);
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
      fileContexts.delete(session.id); restoreErrors.delete(session.id); codeSummaryRuns.delete(session.id);
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
      const goalActions = ['openRelatedConversation', 'setMode', 'saveGoal', 'toggleGoalCriterion', 'addGoalNote', 'attachAssistEvidence', 'prompt', 'runGoal', 'cancelRun', 'interruptCommand', 'backgroundCommand', 'resumeRun', 'newChat', 'selectWorkspace', 'attachFile', 'clearFileContext', 'toolApproval'];
      if (goalActions.includes(message.action) && typeof message.sessionId !== 'string') {
        throw new Error('缺少会话标识，请重新打开当前会话后重试。');
      }
      const commands = { folder: 'workbench.action.files.openFolder', terminal: 'ubovm.openLocalTerminal', source: 'ubovm.openSource',
        toggleSessions: 'workbench.action.toggleAuxiliaryBar', toggleFiles: 'workbench.action.toggleSidebarVisibility', manageProjects: 'ubovm.manageProjects' };
      if (Object.hasOwn(commands, message.action)) await vscode.commands.executeCommand(commands[message.action]);
      else if (message.action === 'reloadConversation' && target === welcome) await reloadConversation();
      else if (message.action === 'setTheme') { await setTheme(vscode, message.theme); }
      else if (message.action === 'blackboardDetail') {
        if (message.sessionId !== sessions.current().id || sessions.current().mode !== 'goal') return;
        blackboardSidebar.setSession(message.sessionId);
        await blackboardSidebar.update(message.detail ? { ...message.detail, sessionId: message.sessionId } : null, message.reveal === true);
      }
      else if (message.action === 'ready') {
        const firstReady = !welcomeReady;
        welcomeReady = true;
        // Coalesce rapid ready storms from visibility + probe reconnect into one snapshot.
        clearTimeout(readyPublishTimer);
        readyPublishTimer = setTimeout(() => {
          readyPublishTimer = undefined;
          if (!shuttingDown) publishState();
        }, 32);
        if (pendingProjectSwitcher && welcome) {
          const pending = pendingProjectSwitcher;
          pendingProjectSwitcher = null;
          await welcome.webview.postMessage(projectSwitcherMessage(pending));
        }
        if (firstReady && !settingsOpening && (!modelConfiguration.status().configured || !readSSHStatus(vscode).configured)) await openSettings();
      }
      else if (message.action === 'toolApproval') {
        assertCurrentSession(message.sessionId);
        if (!toolApprovals.respond({ id: message.approvalId, conversationId: message.sessionId, decision: message.decision })) throw new Error('该审核已处理或失效，请查看最新状态。');
      }
      else if (message.action === 'firstPaint') {
        clearTimeout(recoveryTimer);
        releaseFirstPaint();
      }
      else if (message.action === 'contentReady') {
        if (message.sessionId && message.sessionId !== sessions.current().id) return;
        await vscode.commands.executeCommand('setContext', 'ubovm.contentReady', true);
        clearTimeout(recoveryTimer);
        releaseFirstPaint();
      }
      else if (message.action === 'prompt') await submitPrompt(message.text, message.sessionId, message.approvalMode);
      else if (message.action === 'removeInput' || message.action === 'resumeInputs' || message.action === 'steerInput') await changeInputQueue(message);
      else if (message.action === 'rewindInput') await rewindInput(message);
      else if (message.action === 'selectWorkspace') await chooseWorkspace(message.sessionId);
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
      else if (message.action === 'attachFile') await attachFile(message.sessionId, message.attachment);
      else if (message.action === 'clearFileContext') await clearFileContext(message.sessionId);
      else if (message.action === 'runGoal') await runGoal(message.sessionId);
      else if (message.action === 'cancelRun') await cancelRun(message.sessionId);
      else if (message.action === 'interruptCommand' || message.action === 'backgroundCommand') {
        assertCurrentSession(message.sessionId);
        await harness[message.action](message.sessionId, message.commandId);
        publishState();
      }
      else if (message.action === 'resumeRun') await resumeRun(message.sessionId);
      else if (message.action === 'openSettings') await configureModel();
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
      else if (message.action === 'openWorker') await workerPanel.show(message.workerId, message.sessionId);
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
            await openAssistant();
            publishState();
            await restoreExecution();
            await publishState();
          });
          messageQueue = operation.catch(() => {});
          await operation;
        } finally { creatingProject = false; }
      }

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
      // Fast-lane heartbeats before any async onMessage work so UI clicks cannot
      // queue probes behind snapshot rebuilds.
      if (message?.action === 'connectionProbe') {
        replyConnectionProbe(message.probeId, panel);
        return;
      }
      return onMessage(message, panel).catch(error => output.appendLine(errorText(error)));
    });
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
    registerCommand('ubovm.newChat', async () => { await newChat(); return openAssistant(); }),
    registerCommand('ubovm.newProject', async options => {
      if (creatingProject) return;
      const suggestedName = typeof options?.suggestedName === 'string' ? options.suggestedName.trim().slice(0, 60) : '';
      return openProjectSwitcher({ create: true, ...(suggestedName ? { query: suggestedName } : {}) });
    }),
    registerCommand('ubovm.newProjectConversation', async entry => { await newChat(undefined, entry.id); return openAssistant(); }),
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
    registerCommand('ubovm.openTerminal', () => terminalService.switchTo('ssh')),
    registerCommand('ubovm.openLocalTerminal', () => terminalService.switchTo('local')),
    registerCommand('ubovm.selectTerminal', () => terminalService.select()),
    registerCommand('ubovm.openSource', openSource),
    registerCommand('ubovm.showRuntimeInfo', showRuntimeInfo),
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
