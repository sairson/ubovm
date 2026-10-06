'use strict';

// Executed by the real desktop extension host via --extensionTestsPath.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const vscode = require('vscode');
const { startLoopbackModel } = require('./loopback-model.cjs');

const COMMANDS = [
  'ubovm.openWelcome', 'ubovm.openTerminal', 'ubovm.openLocalTerminal', 'ubovm.selectTerminal', 'ubovm.openSource', 'ubovm.showRuntimeInfo',
  'ubovm.openAssistant', 'ubovm.newChat', 'ubovm.selectConversation', 'ubovm.submitPrompt', 'ubovm.resetLayout',
  'ubovm.searchConversations', 'ubovm.deleteConversation', 'ubovm.hideSessions', 'ubovm.hideFiles',
  'ubovm.newProject', 'ubovm.openProject', 'ubovm.manageProjects', 'ubovm.newProjectConversation', 'ubovm.changeProjectWorkspace', 'ubovm.renameProject', 'ubovm.deleteProject',
  'ubovm.configureModel', 'ubovm.runGoal', 'ubovm.cancelRun', 'ubovm.resumeRun', 'ubovm.reviewCodeChanges',
  'ubovm.openBrowser'
];

// Keep the focused desktop suite on the same assertions and cleanup paths as
// the full smoke run; it must not depend on model or conversation fixtures.
const TERMINAL_CHECKS = new Set([
  'desktop-extension-host', 'extension-activation', 'registered-commands',
  'ssh-terminal-profile-configuration', 'interactive-ssh-terminal-command',
  'native-new-terminal-defaults-to-local', 'local-terminal-command', 'terminal-process-execution'
]);

function assertInside(root, target, label = 'UBOVM_SMOKE_WORKSPACE') {
  const relative = path.relative(root, target);
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    `Smoke path must be inside ${label}: ${target}`);
}

async function timeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out after ${ms} ms`);
}

function conversationTabs() {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview &&
      ['ubovm.welcome', 'mainThreadWebview-ubovm.welcome'].includes(tab.input.viewType));
}

async function waitForMarker(file, expected) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.replace(/^\uFEFF/, '').trim() === expected) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The integrated terminal did not produce its marker file within 25 seconds.');
}

async function startLoopbackSSH() {
  const { Server, utils } = require(require.resolve('ssh2', { paths: [__dirname, path.dirname(process.env.UBOVM_HARNESS_ENTRY || __filename)] }));
  const key = utils.generateKeyPairSync('ed25519');
  const fingerprint = createHash('sha256').update(utils.parseKey(key.private).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const password = randomBytes(24).toString('hex');
  const clients = new Set(), sessions = [], errors = [];
  const server = new Server({ hostKeys: [key.private] }, client => {
    clients.add(client);
    client.on('error', error => errors.push(error.message));
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'smoke' && context.password === password) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const record = { pty: null, shell: false, input: '', resizes: [], closed: false };
      sessions.push(record);
      accept().on('pty', (accept, _reject, info) => {
        record.pty = info;
        accept();
      }).on('window-change', (accept, _reject, info) => {
        record.resizes.push(info);
        accept?.();
      }).on('shell', accept => {
        record.shell = true;
        const stream = accept();
        stream.on('data', data => { record.input += data.toString(); });
        stream.on('error', error => errors.push(error.message));
        stream.once('close', () => { record.closed = true; });
        // xterm answers this cursor-position request only after it receives and
        // parses remote output, giving us a real bidirectional terminal check.
        stream.write('UBOVM_SMOKE_SSH_READY\r\n\x1b[6n');
      });
    }));
  });
  server.on('error', error => errors.push(error.message));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    sessions, errors,
    profile: { id: 'smoke-loopback', name: 'Smoke loopback SSH', host: '127.0.0.1', port: server.address().port,
      username: 'smoke', password, host_key_sha256: `SHA256:${fingerprint}` },
    close: () => new Promise((resolve, reject) => {
      for (const client of clients) client.end();
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function run() {
  const terminalOnly = process.env.UBOVM_SMOKE_TERMINAL_ONLY === '1';
  assert(process.env.UBOVM_SMOKE_WORKSPACE, 'Set UBOVM_SMOKE_WORKSPACE to an isolated local workspace.');
  const workspace = await fs.realpath(path.resolve(process.env.UBOVM_SMOKE_WORKSPACE));
  const resultPath = path.resolve(process.env.UBOVM_SMOKE_RESULT || path.join(workspace, 'smoke-result.json'));
  assertInside(workspace, resultPath);
  const resultParent = await fs.realpath(path.dirname(resultPath));
  if (resultParent !== workspace) assertInside(workspace, resultParent);
  try {
    const existing = await fs.lstat(resultPath);
    assert(existing.isFile() && !existing.isSymbolicLink(), 'Smoke result must be a regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const result = {
    ok: false,
    suite: terminalOnly ? 'terminal' : 'full',
    startedAt: new Date().toISOString(),
    workspace,
    entryPoint: process.env.UBOVM_MAIN_ENTRY || null,
    vscode: vscode.version,
    node: process.versions.node,
    electron: process.versions.electron || null,
    platform: process.platform,
    checks: []
  };
  let temp;
  let modelFixture;
  let sshFixture;
  const originalSettings = new Map();
  const terminals = [];
  let failure;
  let mainConversation;
  let conversationClosed = false;
  const tabEvents = vscode.window.tabGroups.onDidChangeTabs(event => {
    if (mainConversation && event.closed.includes(mainConversation)) conversationClosed = true;
  });

  async function focusConversation() {
    await vscode.commands.executeCommand('ubovm.openAssistant');
    await waitUntil(() => vscode.window.tabGroups.activeTabGroup.activeTab === mainConversation,
      'Main conversation focus');
  }

  async function completedExecution(sessionId) {
    const core = vscode.extensions.getExtension('ubovm.ubovm-core').exports;
    const state = await waitUntil(() => {
      const current = core.assistantState();
      return current.conversation.id === sessionId && !current.execution.busy &&
        ['completed', 'failed', 'interrupted'].includes(current.execution.status) && current;
    }, `Harness completion for ${sessionId}`, 30000);
    assert.equal(state.execution.status, 'completed', JSON.stringify(state.execution.error));
    return state;
  }

  async function assertConversationPreserved(action) {
    // A renderer round trip and short event drain distinguish a native veto
    // from disposing the panel and recreating an identical-looking replacement.
    await vscode.commands.executeCommand('vscode.getEditorLayout');
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(conversationClosed, false, `${action} disposed the original conversation.`);
    const tabs = conversationTabs();
    assert.equal(tabs.length, 1, `${action} must leave exactly one conversation.`);
    assert.equal(tabs[0], mainConversation, `${action} recreated or replaced the conversation.`);
    assert.equal(mainConversation.group.viewColumn, vscode.ViewColumn.One,
      `${action} moved the conversation out of the main column.`);
    assert.equal(mainConversation.group.activeTab, mainConversation,
      `${action} covered the conversation with another editor.`);
  }

  function assertGroupsPreserved(expected, action) {
    const actual = vscode.window.tabGroups.all;
    assert.equal(actual.length, expected.length, `${action} changed the editor group count.`);
    for (let index = 0; index < expected.length; index++) {
      assert.equal(actual[index], expected[index], `${action} replaced or reordered editor group ${index + 1}.`);
    }
  }

  async function check(name, action) {
    if (terminalOnly && !TERMINAL_CHECKS.has(name)) return;
    const started = Date.now();
    try {
      const details = await action();
      result.checks.push({ name, ok: true, elapsedMs: Date.now() - started, ...(details ? { details } : {}) });
    } catch (error) {
      result.checks.push({ name, ok: false, elapsedMs: Date.now() - started, error: String(error.stack || error) });
      throw error;
    }
  }

  try {
    await check('desktop-extension-host', async () => {
      assert.equal(vscode.env.uiKind, vscode.UIKind.Desktop, 'Expected a native desktop workbench.');
      assert.equal(process.env.UBOVM_MAIN_ENTRY, 'src/main/index.mjs', 'Expected the UBOVM Electron main entry to launch the workbench.');
      assert.match(process.versions.node, /^\d+\./);
      const openFolders = await Promise.all((vscode.workspace.workspaceFolders || [])
        .filter(folder => folder.uri.scheme === 'file')
        .map(folder => fs.realpath(folder.uri.fsPath)));
      assert(openFolders.some(folder => folder === workspace), 'Smoke workspace must be opened in the workbench.');
      assert(vscode.workspace.isTrusted, 'The isolated smoke workspace must be trusted.');
      return { application: vscode.env.appName, appRoot: vscode.env.appRoot, electron: result.electron };
    });

    await check('extension-activation', async () => {
      const extension = vscode.extensions.getExtension('ubovm.ubovm-core');
      assert(extension, 'The UBOVM Core extension must be installed or loaded in development mode.');
      await timeout(extension.activate(), 20000, 'Extension activation');
      assert(extension.isActive);
      assert.equal(typeof extension.exports.runtimeInfo, 'function');
      return { extensionPath: extension.extensionPath, version: extension.packageJSON.version };
    });

    await check('coding-agent-native-diff', () => require('./helpers/coding-desktop.cjs').checkCodingDesktop(vscode, workspace));

    await check('persistence-under-user-home', async () => {
      const { persistence } = vscode.extensions.getExtension('ubovm.ubovm-core').exports.runtimeInfo();
      const expectedRoot = path.join(homedir(), '.ubovm');
      assert.equal(persistence.root, expectedRoot);
      const actualRoot = await fs.realpath(expectedRoot);
      assert.equal(persistence.profile, process.env.VSCODE_PORTABLE);
      assertInside(actualRoot, await fs.realpath(persistence.profile), '~/.ubovm');
      for (const [name, location] of Object.entries(persistence)) {
        if (name === 'root') continue;
        assert.equal(typeof location, 'string', `${name} must expose its persistence path.`);
        assertInside(expectedRoot, location, '~/.ubovm');
      }
      // Code OSS uses in-memory workbench storage with --extensionTestsPath,
      // so state.vscdb need not exist here. Validate existing directory paths
      // without reading state or credentials; a normal launch tests disk state.
      for (const name of ['workspaceStorage', 'globalStorage', 'logs']) {
        let existing = persistence[name];
        for (;;) {
          try {
            assertInside(actualRoot, await fs.realpath(existing), '~/.ubovm');
            assert((await fs.stat(existing)).isDirectory(), `${name} must resolve to a directory.`);
            break;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            existing = path.dirname(existing);
            assertInside(expectedRoot, existing, '~/.ubovm');
          }
        }
      }
      return { paths: persistence, workbenchStorage: 'in-memory-during-extension-tests' };
    });

    await check('registered-commands', async () => {
      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of COMMANDS) assert(registered.has(command), `Missing command: ${command}`);
      return COMMANDS;
    });

    await check('minimal-workbench-ui-configuration', async () => {
      const configuration = vscode.workspace.getConfiguration();
      const expected = {
        'workbench.activityBar.location': 'top',
        'window.menuBarVisibility': 'hidden',
        'window.commandCenter': false,
        'workbench.browser.showInTitleBar': true,
        'workbench.navigationControl.enabled': false,
        'workbench.editor.editorActionsLocation': 'hidden',
        'workbench.editor.enablePreview': false,
        'workbench.editor.enablePreviewFromQuickOpen': false,
        'workbench.editor.enablePreviewFromCodeNavigation': false,
        'workbench.statusBar.visible': false,
        'workbench.layoutControl.enabled': true,
        'workbench.layoutControl.type': 'toggles'
      };
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(configuration.get(key), value, `Unexpected workbench setting: ${key}`);
      }
      // Visibility is a UI concern: hidden native commands may remain registered
      // for programmatic use. These assertions verify the effective settings.
      return expected;
    });

    await check('main-conversation-panel', async () => {
      const first = await timeout(vscode.commands.executeCommand('ubovm.openAssistant'), 15000, 'Main conversation');
      assert.equal(first.location, 'main');
      mainConversation = await waitUntil(() => {
        const tabs = conversationTabs();
        return tabs.length === 1 && tabs[0].group.viewColumn === vscode.ViewColumn.One && tabs[0];
      }, 'Conversation tab in the first column');
      const second = await vscode.commands.executeCommand('ubovm.openWelcome');
      assert.equal(second.reused, true, 'Opening conversation twice should reuse its existing panel.');
      await focusConversation();
      await assertConversationPreserved('Opening conversation');
      return { viewType: first.viewType, location: first.location, column: 1, reused: second.reused };
    });

    await check('session-tree-and-sidebar-configuration', async () => {
      const extension = vscode.extensions.getExtension('ubovm.ubovm-core');
      const configuration = vscode.workspace.getConfiguration();
      assert.equal(configuration.get('workbench.sideBar.location'), 'right');
      assert.equal(configuration.get('workbench.secondarySideBar.defaultVisibility'), 'visible');
      assert.equal(configuration.get('chat.disableAIFeatures'), true);
      assert.equal(configuration.get('workbench.editor.restoreEditors'), false);
      assert.equal(configuration.get('window.restoreWindows'), 'one');
      assert.equal(configuration.get('files.hotExit'), 'onExit');
      assert.equal(configuration.get('terminal.integrated.enablePersistentSessions'), false);
      const contributions = extension.packageJSON.contributes;
      const container = contributions.viewsContainers?.secondarySidebar?.find(item => item.id === 'ubovm-sessions');
      assert(container, 'Sessions must contribute a native secondary side bar container.');
      const view = contributions.views?.[container.id]?.find(item => item.id === 'ubovm.sessions');
      assert(view && (!view.type || view.type === 'tree'), 'Sessions must contribute a native TreeView.');
      assert.equal(typeof extension.exports.conversationList, 'function');
      const commands = new Set(await vscode.commands.getCommands(true));
      assert(commands.has('ubovm.sessions.focus'), 'The native sessions view must be registered.');
      assert(!contributions.viewsContainers?.activitybar?.some(item => item.id === 'ubovm-browser'), 'Browser sidebar container must be removed.');
      await vscode.commands.executeCommand('ubovm.sessions.focus', { preserveFocus: true });
      await focusConversation();
      await assertConversationPreserved('Opening the sessions tree');
      // These are native registration/configuration checks, not pixel-position assertions.
      return { primarySideBar: 'right', sessionsContainer: 'secondarySidebar', nativeTreeView: true, browserSidebar: false, builtInChatDisabled: true };
    });

    await check('main-conversation-cannot-manually-split', async () => {
      await focusConversation();
      const originalGroups = [...vscode.window.tabGroups.all];
      const blockedCommands = [
        'workbench.action.splitEditorRight',
        'workbench.action.newGroupBelow',
        'workbench.action.editorLayoutThreeColumns'
      ];
      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of blockedCommands) {
        assert(registered.has(command), `Native split command must exist before testing its veto: ${command}`);
        await focusConversation();
        await vscode.commands.executeCommand(command);
        await assertConversationPreserved(command);
        assertGroupsPreserved(originalGroups, command);
      }
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}, {}, {}]
      });
      await assertConversationPreserved('Three-group layout API');
      assertGroupsPreserved(originalGroups, 'Three-group layout API');
      return { nativeCommandsRegistered: true, blockedCommands, rejectsThreeGroupLayout: true, sameGroups: true, sameConversationPanel: true };
    });

    temp = await fs.mkdtemp(path.join(workspace, '.ubovm-smoke-'));
    assertInside(workspace, await fs.realpath(temp));
    await check('file-defaults-right-and-editor-write-read-save', async () => {
      const uri = vscode.Uri.file(path.join(temp, 'editor-smoke.txt'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Code OSS editor smoke\n', 'utf8'));
      await focusConversation();
      // Do not supply a viewColumn: this verifies native locked-group routing.
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      const textEditor = await waitUntil(() => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.toString() === uri.toString() && editor;
      }, 'Default file open');
      assert.equal(textEditor.viewColumn, vscode.ViewColumn.Two, 'A file opened from the main conversation must use the right column.');
      await assertConversationPreserved('Opening a file');
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(1, 0), 'UBOVM_EDITOR_OK\n');
      assert(await vscode.workspace.applyEdit(edit), 'WorkspaceEdit failed.');
      assert(await document.save(), 'Document save failed.');
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      assert.equal(content, 'Code OSS editor smoke\nUBOVM_EDITOR_OK\n');
      if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      return { opened: true, column: 2, edited: true, saved: true };
    });

    await check('explicit-main-column-file-is-routed-right', async () => {
      const uri = vscode.Uri.file(path.join(temp, 'explicit-main-column.txt'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Explicit first-column routing smoke\n', 'utf8'));
      await focusConversation();
      // Explicit targeting bypasses native group locking; the layout guard
      // must move this editor without replacing or recreating the conversation.
      await timeout(vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: false }),
        10000, 'Explicit first-column file open');
      const rightTab = await waitUntil(() => {
        const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
          .find(candidate => candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === uri.toString());
        return tab?.group.viewColumn === vscode.ViewColumn.Two &&
          mainConversation.group.viewColumn === vscode.ViewColumn.One &&
          mainConversation.group.activeTab === mainConversation && tab;
      }, 'Explicit first-column file migration to the right');
      await assertConversationPreserved('Explicit first-column file routing');
      await vscode.window.tabGroups.close(rightTab, true);
      return { requestedColumn: 1, actualColumn: 2, sameConversationPanel: true, mainConversationVisible: true };
    });

    await check('right-file-cannot-preview-or-manually-split', async () => {
      const uri = vscode.Uri.file(path.join(temp, 'no-preview-or-split.txt'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Persistent right-side file editor\n', 'utf8'));
      await focusConversation();
      // Explicit preview:true verifies the core open path, not just the default
      // value of the preview setting used by Explorer and Quick Open.
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      const rightTab = await waitUntil(() => {
        const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
          .find(candidate => candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === uri.toString());
        return tab?.group.viewColumn === vscode.ViewColumn.Two && tab;
      }, 'Persistent right-side file tab');
      assert.equal(rightTab.isPreview, false, 'Explicit preview:true must still open a persistent file tab.');
      await assertConversationPreserved('Opening a file with preview:true');
      assert.equal(vscode.window.tabGroups.all.length, 2, 'Expected only the conversation group and one file group.');
      const originalGroups = [...vscode.window.tabGroups.all];
      const originalTabs = originalGroups.flatMap(group => group.tabs);
      const blockedCommands = [
        'workbench.action.splitEditor',
        'workbench.action.splitEditorRight',
        'workbench.action.splitEditorDown',
        'workbench.action.splitEditorInGroup',
        'workbench.action.newGroupBelow',
        'workbench.action.editorLayoutThreeColumns'
      ];
      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of blockedCommands) {
        assert(registered.has(command), `Native split command must exist before testing its veto: ${command}`);
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await waitUntil(() => vscode.window.tabGroups.activeTabGroup.activeTab === rightTab, 'Right file focus');
        await vscode.commands.executeCommand(command);
        await assertConversationPreserved(command);
        assertGroupsPreserved(originalGroups, command);
        assert.deepEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs), originalTabs,
          `${command} duplicated or replaced a file editor.`);
        assert(rightTab.input instanceof vscode.TabInputText, `${command} changed the file into a split editor.`);
        assert.equal(rightTab.isPreview, false, `${command} changed the file into a preview tab.`);
      }
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}, {}, {}]
      });
      await assertConversationPreserved('Three-group layout API with a file open');
      assertGroupsPreserved(originalGroups, 'Three-group layout API with a file open');
      const layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
      assert.equal(layout.orientation, 0, 'The two editor groups must remain side by side.');
      assert.equal(layout.groups.length, 2);
      assert(layout.groups.every(group => !group.groups?.length), 'Editor groups must not contain nested splits.');
      await vscode.window.tabGroups.close(rightTab, true);
      return { requestedPreview: true, actualPreview: false, blockedCommands, twoHorizontalGroups: true, sameConversationPanel: true };
    });

    await check('runtime-info-command', async () => {
      const info = await vscode.commands.executeCommand('ubovm.showRuntimeInfo');
      assert.equal(info.extension, 'ubovm.ubovm-core');
      assert.equal(info.entryPoint, 'src/main/index.mjs');
      assert.equal(info.vscode, vscode.version);
      assert.equal(info.uiKind, 'desktop');
      assert.equal(info.node, process.versions.node);
      return info;
    });

    await check('local-model-configuration-and-unconfigured-rejection', async () => {
      const settings = vscode.workspace.getConfiguration('ubovm');
      const values = { model: {}, reason: {}, worker: {}, contextSummary: true, mcp: { servers: [] }, skills: { directories: [] }, intools: { allowedTools: ['note', 'todo'] } };
      for (const [key, value] of Object.entries(values)) {
        originalSettings.set(key, structuredClone(settings.inspect(key)?.globalValue));
        await settings.update(key, value, vscode.ConfigurationTarget.Global);
      }
      await vscode.commands.executeCommand('ubovm.setMode', 'assist');
      await vscode.commands.executeCommand('ubovm.newChat');
      const core = vscode.extensions.getExtension('ubovm.ubovm-core').exports;
      const before = structuredClone(core.assistantState().messages);
      await assert.rejects(() => vscode.commands.executeCommand('ubovm.submitPrompt', 'UNCONFIGURED_MUST_NOT_SAVE'), /配置模型/);
      assert.deepEqual(core.assistantState().messages, before, 'Unconfigured requests must not create placeholder replies or save a user message');
      const file = path.join(temp, 'harness-evidence.txt');
      await fs.writeFile(file, 'UBOVM_HARNESS_WORKSPACE_EVIDENCE\n', 'utf8');
      modelFixture = await startLoopbackModel({ readPath: path.relative(workspace, file), marker: 'UBOVM_HARNESS_WORKSPACE_EVIDENCE' });
      const configured = await vscode.commands.executeCommand('ubovm.configureModel', modelFixture.model);
      assert.equal(configured.configured, true);
      const stored = vscode.workspace.getConfiguration('ubovm').inspect('model').globalValue;
      assert.equal(stored.provider, 'smoke');
      assert.equal(stored.apiKey, undefined, 'Credentials must not appear in model settings');
      assert(!JSON.stringify(core.assistantState()).includes('fixture-key'), 'Webview state must not contain credentials');
      return { unconfiguredRejected: true, noPlaceholderReply: true, localProvider: true, secretExcludedFromSettingsAndState: true };
    });

    await check('main-conversation-multiple-local-sessions', async () => {
      const extension = vscode.extensions.getExtension('ubovm.ubovm-core');
      await vscode.commands.executeCommand('ubovm.setMode', 'assist');
      const view = await timeout(vscode.commands.executeCommand('ubovm.openAssistant'), 15000, 'Main conversation');
      assert.equal(view.location, 'main');
      await vscode.commands.executeCommand('ubovm.newChat');
      assert.equal(extension.exports.assistantState().messages.length, 0);
      const text = '<script>UI_SMOKE</script> 帮我解释当前项目';
      const accepted = await vscode.commands.executeCommand('ubovm.submitPrompt', text);
      const firstId = accepted.conversation.id;
      const state = await completedExecution(firstId);
      assert.equal(typeof firstId, 'string');
      assert(firstId.length > 0);
      assert.equal(state.messages[0].text, text);
      assert.equal(state.messages[0].role, 'user');
      assert.equal(state.provider.connected, true);
      assert.equal(state.messages[1].text, 'SMOKE_ASSIST_REPLY ' + text);
      assert.equal(extension.exports.assistantState().messages.length, 2);
      const firstMessages = structuredClone(state.messages);

      await vscode.commands.executeCommand('ubovm.newChat');
      const empty = extension.exports.assistantState();
      const secondId = empty.conversation.id;
      assert.notEqual(secondId, firstId, 'New chat must create a separate conversation.');
      assert.equal(empty.messages.length, 0, 'A new conversation must start empty.');
      const secondText = 'UI_SMOKE_SECOND_SESSION 只属于第二个会话';
      await vscode.commands.executeCommand('ubovm.submitPrompt', secondText);
      const second = await completedExecution(secondId);
      assert.equal(second.conversation.id, secondId);
      assert.deepEqual(second.messages.filter(message => message.role === 'user').map(message => message.text), [secondText]);
      const secondMessages = structuredClone(second.messages);

      const restored = await vscode.commands.executeCommand('ubovm.selectConversation', firstId);
      assert.equal(restored.conversation.id, firstId);
      assert.deepEqual(restored.messages, firstMessages, 'Selecting a conversation must restore its original messages.');
      const conversations = extension.exports.conversationList();
      assert(Array.isArray(conversations));
      assert.deepEqual(conversations.find(conversation => conversation.id === firstId)?.messages, firstMessages);
      assert.deepEqual(conversations.find(conversation => conversation.id === secondId)?.messages, secondMessages);
      const selectedSecond = await vscode.commands.executeCommand('ubovm.selectConversation', secondId);
      assert.equal(selectedSecond.conversation.id, secondId);
      assert.deepEqual(selectedSecond.messages, secondMessages, 'Switching back must not mix messages across conversations.');
      await assertConversationPreserved('Creating and switching conversations');
      return { location: view.location, localConversation: true, providerConnected: true, actualHttpModelReplies: true, distinctSessions: true, messagesIsolated: true, samePanel: true };
    });

    await check('conversation-modes-and-isolated-goals', async () => {
      const core = vscode.extensions.getExtension('ubovm.ubovm-core').exports;
      const commands = ['ubovm.setMode', 'ubovm.saveGoal', 'ubovm.toggleGoalCriterion', 'ubovm.addGoalNote'];
      const registered = new Set(await vscode.commands.getCommands(true));
      for (const command of commands) assert(registered.has(command), `Missing mode/goal command: ${command}`);
      const before = core.assistantState();
      const assistId = before.conversation.id;
      const assistMessages = structuredClone(before.messages);
      const previousGoals = structuredClone(core.conversationList('goal'));
      assert.equal(before.mode, 'assist');
      assert(assistMessages.length > 0, 'Mode switching must be tested with existing assist messages.');

      function assertModeList(mode, currentId) {
        const list = core.conversationList();
        assert(list.length > 0 && list.every(conversation => conversation.mode === mode),
          `The current list must contain only ${mode} conversations.`);
        assert(list.some(conversation => conversation.id === currentId));
        assert.deepEqual(list, core.conversationList(mode));
      }

      function workspaceSnapshot() {
        return structuredClone({ assist: core.conversationList('assist'), goal: core.conversationList('goal') });
      }

      try {
        const goalMode = await vscode.commands.executeCommand('ubovm.setMode', 'goal', assistId);
        assert.equal(goalMode.mode, 'goal');
        assert.notEqual(goalMode.conversation.id, assistId, 'Goal mode must use its own conversation.');
        const previousGoal = previousGoals.find(conversation => conversation.id === goalMode.conversation.id);
        assert.deepEqual(goalMode.messages, previousGoal?.messages || [],
          'Entering goal mode must restore its own messages instead of copying assist messages.');
        assertModeList('goal', goalMode.conversation.id);
        const assistBeforeGoals = structuredClone(core.conversationList('assist'));
        assert(assistBeforeGoals.every(conversation => conversation.mode === 'assist'));
        assert.deepEqual(assistBeforeGoals.find(conversation => conversation.id === assistId)?.messages, assistMessages);
        assert.equal(core.assistantState().conversation.id, goalMode.conversation.id,
          'Reading another mode list must not switch the active conversation.');

        // Use a fresh goal even when this isolated smoke workspace was tested before.
        await vscode.commands.executeCommand('ubovm.newChat');
        const first = core.assistantState();
        const firstId = first.conversation.id;
        assert.notEqual(firstId, goalMode.conversation.id);
        assert.equal(first.mode, 'goal');
        assert.equal(first.goal, null);
        assert.deepEqual(first.messages, []);
        assertModeList('goal', firstId);
        assert.deepEqual(core.conversationList('assist'), assistBeforeGoals,
          'Creating a goal conversation must not add or mutate assist conversations.');

        const objective = 'UI_SMOKE_GOAL_FIRST 验证目标与当前会话关联';
        const criterionTexts = ['保留原有对话', '完成目标检查'];
        const saved = await vscode.commands.executeCommand('ubovm.saveGoal', {
          objective, criteria: criterionTexts.map(text => ({ text }))
        }, firstId);
        assert.equal(saved.goal.objective, objective);
        assert.deepEqual(saved.goal.criteria.map(item => item.text), criterionTexts);
        assert(saved.goal.criteria.every(item => typeof item.id === 'string' && item.id && item.done === false));
        assert.equal(new Set(saved.goal.criteria.map(item => item.id)).size, 2, 'Criteria need distinct stable IDs.');
        assert.deepEqual(saved.goal.notes, []);
        assert(Number.isFinite(saved.goal.createdAt) && Number.isFinite(saved.goal.updatedAt));
        const criterionId = saved.goal.criteria[0].id;
        const checked = await vscode.commands.executeCommand('ubovm.toggleGoalCriterion', criterionId, true, firstId);
        assert.equal(checked.goal.criteria.find(item => item.id === criterionId)?.done, true);
        assert.equal(checked.goal.criteria[1].done, false, 'Completing one criterion must not complete another.');

        const noteText = 'UI_SMOKE_GOAL_NOTE 这条记录只属于第一个目标';
        const noted = await vscode.commands.executeCommand('ubovm.addGoalNote', noteText, firstId);
        assert.equal(noted.goal.notes.length, 1);
        assert.equal(noted.goal.notes[0].text, noteText);
        assert.equal(typeof noted.goal.notes[0].id, 'string');
        assert(noted.goal.notes[0].id && Number.isFinite(noted.goal.notes[0].createdAt));
        assert.equal(noted.goal.createdAt, saved.goal.createdAt);
        assert(noted.goal.updatedAt >= noted.goal.createdAt);
        assert.deepEqual(noted.messages, [], 'Goal metadata must not create conversation messages.');
        const firstGoal = structuredClone(noted.goal);
        const goalText = 'UI_SMOKE_GOAL_MESSAGE 这条消息只属于目标工作区';
        await vscode.commands.executeCommand('ubovm.submitPrompt', goalText, firstId);
        const goalReply = await completedExecution(firstId);
        assert.equal(goalReply.conversation.id, firstId);
        assert.equal(goalReply.mode, 'goal');
        assert.deepEqual(goalReply.messages.filter(message => message.role === 'user').map(message => message.text), [goalText]);
        assert.deepEqual(goalReply.goal, firstGoal, 'A goal conversation message must preserve goal progress.');
        const firstMessages = structuredClone(goalReply.messages);
        assert.deepEqual(core.conversationList('assist'), assistBeforeGoals,
          'Goal messages and metadata must remain outside the assist workspace.');

        const assist = await vscode.commands.executeCommand('ubovm.setMode', 'assist', firstId);
        assert.equal(assist.mode, 'assist');
        assert.equal(assist.conversation.id, assistId, 'Assist mode must restore its last selected conversation.');
        assert.deepEqual(assist.messages, assistMessages);
        assertModeList('assist', assistId);
        const beforeRejectedWrites = workspaceSnapshot();
        await assert.rejects(() => vscode.commands.executeCommand('ubovm.selectConversation', firstId),
          'Selecting a conversation from another mode must be rejected.');
        const rejectedWrites = [
          // Correct session ID: goal editing is unavailable in assist mode.
          ['ubovm.saveGoal', { objective: 'ASSIST_GOAL_MUST_NOT_SAVE', criteria: [] }, assistId],
          ['ubovm.toggleGoalCriterion', criterionId, false, assistId],
          ['ubovm.addGoalNote', 'ASSIST_NOTE_MUST_NOT_SAVE', assistId],
          // The former goal ID is stale after switching modes.
          ['ubovm.setMode', 'goal', firstId],
          ['ubovm.submitPrompt', 'STALE_GOAL_MESSAGE_MUST_NOT_SAVE', firstId],
          ['ubovm.saveGoal', { objective: 'STALE_GOAL_MUST_NOT_SAVE', criteria: [] }, firstId],
          ['ubovm.toggleGoalCriterion', criterionId, false, firstId],
          ['ubovm.addGoalNote', 'STALE_NOTE_MUST_NOT_SAVE', firstId]
        ];
        for (const [command, ...args] of rejectedWrites) {
          await assert.rejects(() => vscode.commands.executeCommand(command, ...args),
            `${command} must reject an unavailable goal operation or stale session ID.`);
        }
        assert.deepEqual(workspaceSnapshot(), beforeRejectedWrites,
          'Rejected cross-mode writes and selection must not mutate either workspace.');
        assert.equal(core.assistantState().mode, 'assist');
        assert.equal(core.assistantState().conversation.id, assistId);

        const resumedGoal = await vscode.commands.executeCommand('ubovm.setMode', 'goal', assistId);
        assert.equal(resumedGoal.conversation.id, firstId, 'Goal mode must restore its last selected conversation.');
        assert.deepEqual(resumedGoal.messages, firstMessages);
        assert.deepEqual(resumedGoal.goal, firstGoal);
        assertModeList('goal', firstId);
        await assert.rejects(() => vscode.commands.executeCommand('ubovm.selectConversation', assistId),
          'Selecting an assist conversation from goal mode must be rejected.');

        await vscode.commands.executeCommand('ubovm.newChat');
        const second = core.assistantState();
        const secondId = second.conversation.id;
        assert.notEqual(secondId, firstId);
        assert.equal(second.mode, 'goal', 'A new conversation must inherit the current mode.');
        assert.equal(second.goal, null, 'A new conversation must start without a goal.');
        assert.deepEqual(second.messages, []);
        const secondSaved = await vscode.commands.executeCommand('ubovm.saveGoal', {
          objective: 'UI_SMOKE_GOAL_SECOND 独立的第二个目标', criteria: [{ text: '第二个会话的检查' }]
        }, secondId);
        const secondGoal = structuredClone(secondSaved.goal);
        assert.deepEqual(secondGoal.notes, [], 'The first conversation note must not leak into the second.');
        assert.equal(secondGoal.criteria[0].done, false);
        assertModeList('goal', secondId);
        assert.deepEqual(core.conversationList('assist'), assistBeforeGoals);
        const sessionsBeforeStaleWrite = workspaceSnapshot();
        await assert.rejects(() => vscode.commands.executeCommand('ubovm.addGoalNote', 'STALE_SAME_MODE_NOTE', firstId),
          'A previous conversation ID must also be rejected within the same mode.');
        assert.deepEqual(workspaceSnapshot(), sessionsBeforeStaleWrite);
        assert.equal(core.assistantState().conversation.id, secondId);

        const restored = await vscode.commands.executeCommand('ubovm.selectConversation', firstId);
        assert.equal(restored.mode, 'goal');
        assert.deepEqual(restored.goal, firstGoal, 'Selecting a conversation must restore its goal and progress.');
        assert.deepEqual(restored.messages, firstMessages);
        const secondStored = core.conversationList().find(conversation => conversation.id === secondId);
        assert.deepEqual(secondStored.goal, secondGoal, 'The second conversation must retain its independent goal.');
        assert.deepEqual(secondStored.messages, []);
        const finalAssist = await vscode.commands.executeCommand('ubovm.setMode', 'assist', firstId);
        assert.equal(finalAssist.mode, 'assist');
        assert.equal(finalAssist.conversation.id, assistId);
        assert.deepEqual(finalAssist.messages, assistMessages);
        assertModeList('assist', assistId);
        await assertConversationPreserved('Switching independent workspaces and saving isolated goals');
        return { independentModes: true, modeListsFiltered: true, lastConversationsRestored: true,
          messagesIsolated: true, criteriaAndNotesSaved: true, goalsIsolated: true,
          crossModeSelectionRejected: true, assistGoalWritesRejected: true,
          staleWritesRejected: true, samePanel: true, finalMode: 'assist' };
      } finally {
        const current = core.assistantState();
        if (current.mode !== 'assist') {
          await vscode.commands.executeCommand('ubovm.setMode', 'assist', current.conversation.id);
        }
      }
    });

    await check('running-assist-remains-isolated-when-switching-sessions', async () => {
      const core = vscode.extensions.getExtension('ubovm.ubovm-core').exports;
      await vscode.commands.executeCommand('ubovm.newChat');
      const firstId = core.assistantState().conversation.id;
      const held = modelFixture.holdNext('assist');
      await vscode.commands.executeCommand('ubovm.submitPrompt', 'SMOKE_BACKGROUND_ASSIST', firstId);
      await timeout(held.arrived, 15000, 'Local assistant provider request');
      assert.equal(core.assistantState().execution.busy, true);
      await vscode.commands.executeCommand('ubovm.newChat', firstId);
      const second = core.assistantState();
      assert.notEqual(second.conversation.id, firstId);
      assert.equal(second.execution.busy, false);
      assert.deepEqual(second.messages, []);
      held.release();
      await waitUntil(() => core.conversationList('assist').find(session => session.id === firstId)?.messages.some(message => message.role === 'assistant'), 'Background assistant reply', 30000);
      assert.equal(core.assistantState().conversation.id, second.conversation.id);
      assert.deepEqual(core.assistantState().messages, [], 'Background reply must not leak into the active session');
      await vscode.commands.executeCommand('ubovm.selectConversation', firstId);
      const completed = await completedExecution(firstId);
      assert.deepEqual(completed.messages.map(message => message.text), ['SMOKE_BACKGROUND_ASSIST', 'SMOKE_ASSIST_REPLY SMOKE_BACKGROUND_ASSIST']);
      return { backgroundExecution: true, repliesRoutedToOrigin: true, selectedSessionUnaffected: true };
    });

    await check('desktop-reason-worker-tool-cancel-resume', async () => {
      const core = vscode.extensions.getExtension('ubovm.ubovm-core').exports;
      const assistId = core.assistantState().conversation.id;
      await vscode.commands.executeCommand('ubovm.setMode', 'goal', assistId);
      await vscode.commands.executeCommand('ubovm.newChat');
      const firstId = core.assistantState().conversation.id;
      const objective = 'SMOKE_REAL_HARNESS 从工作区文件读取证据并记录可恢复结果';
      await vscode.commands.executeCommand('ubovm.saveGoal', { objective, criteria: [{ text: '保留真实工具证据' }] }, firstId);
      const held = modelFixture.holdNext('replan');
      const accepted = await vscode.commands.executeCommand('ubovm.runGoal', firstId);
      assert(accepted.execution.busy, 'runGoal must acknowledge while the background agent is active');
      const blockedRequest = await timeout(held.arrived, 30000, 'Worker replan after workspace tool');
      const during = core.assistantState();
      assert(during.execution.workers.some(worker => worker.status === 'running'));
      assert(during.execution.activities.some(item => item.label === 'read_workspace_file' && item.status === 'completed'));
      assert.equal(during.execution.middleware.contextSummary, true);
      await assert.rejects(() => vscode.commands.executeCommand('ubovm.saveGoal', { objective: 'MUST_NOT_REPLACE_RUNNING_GOAL', criteria: [] }, firstId), /停止/);
      await vscode.commands.executeCommand('ubovm.newChat', firstId);
      const second = core.assistantState();
      const secondId = second.conversation.id;
      assert.notEqual(secondId, firstId);
      assert.equal(second.execution.busy, false);
      assert.deepEqual(second.messages, []);
      await assert.rejects(() => vscode.commands.executeCommand('ubovm.cancelRun', firstId), 'A stale ID must not cancel another selected session');
      await vscode.commands.executeCommand('ubovm.selectConversation', firstId);
      await vscode.commands.executeCommand('ubovm.cancelRun', firstId);
      const interrupted = await waitUntil(() => {
        const current = core.assistantState();
        return !current.execution.busy && current.execution.status === 'interrupted' && current;
      }, 'Cancellation and checkpoint close', 15000);
      await waitUntil(() => blockedRequest.aborted, 'Provider HTTP request aborted', 10000);
      assert.equal(interrupted.execution.canResume, true);
      assert(interrupted.execution.blackboard.nodes.some(node => node.intent && node.attempts.at(-1)?.status === 'interrupted'));
      assert.deepEqual(interrupted.messages, [], 'Cancelled internal protocol text must not become an assistant reply');
      const reads = () => modelFixture.requests.filter(item => item.phase === 'execute' && !item.body.messages.some(message => message.role === 'tool')).length;
      const readsBeforeResume = reads();
      await vscode.commands.executeCommand('ubovm.resumeRun', firstId);
      const resumed = await completedExecution(firstId);
      assert.equal(reads(), readsBeforeResume, 'Resume must reuse the completed tool ledger without replaying the workspace read');
      const completedWorker = resumed.execution.blackboard.nodes.find(node => node.intent?.status === 'completed');
      assert(completedWorker, 'The shared blackboard must contain a completed Worker');
      assert.match(completedWorker.fact.content, /UBOVM_HARNESS_WORKSPACE_EVIDENCE/);
      assert.equal(completedWorker.attempts.length, 2);
      assert.deepEqual(resumed.messages.map(message => message.text), ['SMOKE_GOAL_COMPLETE UBOVM_HARNESS_WORKSPACE_EVIDENCE']);
      const requestsBeforeCachedRun = modelFixture.requests.length;
      await vscode.commands.executeCommand('ubovm.runGoal', firstId);
      await completedExecution(firstId);
      assert.equal(modelFixture.requests.length, requestsBeforeCachedRun, 'A completed persisted goal must reuse its result');
      await vscode.commands.executeCommand('ubovm.selectConversation', secondId);
      assert.deepEqual(core.assistantState().messages, [], 'Goal execution must not write to another session');
      await vscode.commands.executeCommand('ubovm.setMode', 'assist', secondId);
      assert.equal(core.assistantState().conversation.id, assistId);
      assert(!modelFixture.requests.some(item => item.error), JSON.stringify(modelFixture.requests.filter(item => item.error)));
      return { actualHttpProvider: true, reasonAndWorker: true, workspaceToolRead: true, summaryMiddlewareEnabled: true,
        interruptedRequestAborted: true, checkpointsResumed: true, completedToolNotReplayed: true, persistedResultReused: true, backgroundSessionIsolated: true };
    });

    await check('main-conversation-cannot-close', async () => {
      await focusConversation();
      // The tab API closes even a pinned tab, so this exercises CannotClose
      // independently of the normal sticky-tab keyboard protection.
      await vscode.window.tabGroups.close(mainConversation, true);
      await assertConversationPreserved('Tab API close');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await assertConversationPreserved('Close active editor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await assertConversationPreserved('Close all editors');
      await vscode.commands.executeCommand('workbench.action.closeAllGroups');
      await assertConversationPreserved('Close all groups');
      await vscode.commands.executeCommand('workbench.action.closeEditorsAndGroup');
      await assertConversationPreserved('Close editors and group');
      return { samePanel: true, nativeCloseVeto: true, survivesCloseAll: true };
    });

    await check('ssh-terminal-profile-configuration', async () => {
      const extension = vscode.extensions.getExtension('ubovm.ubovm-core');
      const profiles = extension.packageJSON.contributes.terminal.profiles;
      assert(profiles.some(profile => profile.id === 'ubovm.ssh' && profile.title === 'UBOVM SSH'));
      assert(profiles.some(profile => profile.id === 'ubovm.local' && profile.title === '当前系统终端'));
      const os = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
      assert.equal(vscode.workspace.getConfiguration('terminal.integrated').get(`defaultProfile.${os}`), '当前系统终端');
      sshFixture = await startLoopbackSSH();
      const settings = vscode.workspace.getConfiguration('ubovm');
      if (!originalSettings.has('intools')) originalSettings.set('intools', structuredClone(settings.inspect('intools')?.globalValue));
      await settings.update('intools', {
        ...settings.inspect('intools')?.globalValue,
        ssh: { profiles: [sshFixture.profile], defaultId: sshFixture.profile.id }
      }, vscode.ConfigurationTarget.Global);
      return { defaultProfile: '当前系统终端', localProfile: '当前系统终端', pinnedLoopbackHost: true };
    });

    for (const command of ['ubovm.openTerminal']) {
      await check('interactive-ssh-terminal-command', async () => {
        const before = new Set(vscode.window.terminals);
        const sessionIndex = sshFixture.sessions.length;
        await timeout(vscode.commands.executeCommand(command), 15000, command);
        const terminal = await waitUntil(() => vscode.window.terminals.find(item => !before.has(item)), 'SSH terminal creation');
        terminals.push(terminal);
        terminal.show();
        const session = await waitUntil(() => sshFixture.sessions[sessionIndex]?.shell && sshFixture.sessions[sessionIndex], 'SSH PTY shell');
        assert.equal(session.pty.term, 'xterm-256color');
        assert(session.pty.cols > 0 && session.pty.rows > 0, 'SSH must request real PTY dimensions.');
        await waitUntil(() => /\x1b\[\d+;\d+R/.test(session.input), 'Remote output rendered by xterm');
        terminal.sendText('UBOVM_SSH_STDIN', false);
        terminal.sendText('\x03', false);
        await waitUntil(() => session.input.includes('UBOVM_SSH_STDIN') && session.input.includes('\x03'), 'SSH stdin and Ctrl+C');
        const resizeCount = session.resizes.length;
        await vscode.commands.executeCommand('workbench.action.terminal.resizePaneUp');
        const resized = await waitUntil(() => session.resizes.length > resizeCount && session.resizes.at(-1), 'SSH PTY resize');
        assert(resized.cols > 0 && resized.rows > 0);
        terminal.dispose();
        await waitUntil(() => session.closed, 'SSH shell closed with terminal');
        assert.deepEqual(sshFixture.errors, [], 'The loopback SSH server must not encounter transport errors.');
        return { command, pty: true, shell: true, remoteOutputRendered: true, stdin: true, ctrlC: true, resize: true, closed: true };
      });
    }

    await check('native-new-terminal-defaults-to-local', async () => {
      const before = new Set(vscode.window.terminals);
      const sessions = sshFixture.sessions.length;
      await vscode.commands.executeCommand('workbench.action.terminal.new');
      const terminal = await waitUntil(() => vscode.window.terminals.find(item => !before.has(item)), 'Local terminal creation');
      terminals.push(terminal);
      const pid = await timeout(terminal.processId, 20000, 'Default local shell startup');
      assert(Number.isInteger(pid) && pid > 0);
      assert.equal(terminal.creationOptions.shellPath, vscode.env.shell);
      assert.equal(sshFixture.sessions.length, sessions, 'Default terminal must not connect to SSH');
      terminal.dispose();
      // The next check immediately reopens: close delivery can still be pending.
      return { name: terminal.name, pid, localDefault: true };
    });

    await check('local-terminal-command', async () => {
      const terminal = await vscode.commands.executeCommand('ubovm.openLocalTerminal');
      assert(terminal, 'The terminal command did not create a terminal.');
      terminals.push(terminal);
      const pid = await timeout(terminal.processId, 20000, 'Integrated terminal startup');
      assert(Number.isInteger(pid) && pid > 0, 'Expected a real terminal process.');
      terminal.dispose();
      return { name: terminal.name, pid };
    });

    await check('terminal-process-execution', async () => {
      const marker = 'UBOVM_TERMINAL_OK';
      const markerPath = path.join(temp, 'terminal-marker.txt');
      let shellPath;
      let shellArgs;
      if (process.platform === 'win32') {
        shellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const quotedPath = markerPath.replace(/'/g, "''");
        const command = `[System.IO.File]::WriteAllText('${quotedPath}', '${marker}'); Write-Output '${marker}'; exit 0`;
        shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
      } else {
        shellPath = '/bin/sh';
        const quotedPath = "'" + markerPath.replace(/'/g, "'\\''") + "'";
        shellArgs = ['-c', `printf '%s' '${marker}' > ${quotedPath}; printf '%s\\n' '${marker}'`];
      }
      const terminal = vscode.window.createTerminal({ name: 'UBOVM Smoke', cwd: temp, shellPath, shellArgs });
      terminals.push(terminal);
      terminal.show(true);
      await waitForMarker(markerPath, marker);
      return { shellPath, marker, executedByIntegratedTerminal: true };
    });

    await check('main-conversation-cannot-move-or-merge', async () => {
      const uri = vscode.Uri.file(path.join(temp, 'move-target.txt'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Right editor group\n', 'utf8'));
      await focusConversation();
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      const rightTab = await waitUntil(() => vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()), 'Right editor tab');
      assert.equal(rightTab.group.viewColumn, vscode.ViewColumn.Two);
      await focusConversation();
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: 2 });
      await assertConversationPreserved('Move active editor to the right');
      await focusConversation();
      // Unlike closeEditorsAndGroup, closeGroup tries to merge nonempty groups.
      await vscode.commands.executeCommand('workbench.action.closeGroup');
      await assertConversationPreserved('Merge/remove the conversation group');
      await vscode.window.tabGroups.close(rightTab, true);
      return { samePanel: true, column: 1, crossGroupMoveVeto: true, groupMergeVeto: true };
    });

    if (terminalOnly) assert.deepEqual(result.checks.map(check => check.name).sort(), [...TERMINAL_CHECKS].sort(),
      'The terminal desktop suite must execute every focused check.');
    result.ok = true;
  } catch (error) {
    failure = error;
    result.error = String(error.stack || error);
  } finally {
    tabEvents.dispose();
    for (const terminal of terminals) terminal.dispose();
    const settingsCleanupErrors = [];
    if (sshFixture) {
      try { await sshFixture.close(); } catch (error) { settingsCleanupErrors.push(error); }
    }
    if (modelFixture) {
      // This endpoint is unique to the test: delete only its fixture credential.
      try { await vscode.commands.executeCommand('ubovm.configureModel', { ...modelFixture.model, apiKey: '' }); }
      catch (error) { settingsCleanupErrors.push(error); }
      try { await modelFixture.close(); } catch (error) { settingsCleanupErrors.push(error); }
    }
    for (const [key, value] of originalSettings) {
      try { await vscode.workspace.getConfiguration('ubovm').update(key, value, vscode.ConfigurationTarget.Global); }
      catch (error) { settingsCleanupErrors.push(error); }
    }
    if (settingsCleanupErrors.length) {
      const error = new AggregateError(settingsCleanupErrors, 'Could not close smoke fixtures or restore settings and credentials');
      result.ok = false;
      result.settingsCleanupError = String(error);
      failure ||= error;
    }
    if (temp) {
      try {
        assertInside(workspace, await fs.realpath(temp));
        // Terminal disposal is asynchronous; Windows may still hold its cwd.
        await fs.rm(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
      } catch (error) {
        result.ok = false;
        result.cleanupError = String(error);
        failure ||= error;
      }
    }
    result.finishedAt = new Date().toISOString();
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`UBOVM_SMOKE_RESULT=${resultPath}`);
  }
  if (failure) throw failure;
}

module.exports = { run };
