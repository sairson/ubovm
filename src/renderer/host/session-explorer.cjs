'use strict';

// Coalesce streamed publications and serialize root changes so a slow switch
// cannot overwrite a newer session's explorer. Keep window storage unchanged.
function createSessionExplorer(vscode, { onDidChangeFiles } = {}) {
  let desired = '', applied, pending;
  let watcher;
  let disposed = false;
  let initialized = false;
  return {
    sync(workspace) {
      const next = workspace || '';
      if (disposed) return Promise.resolve();
      if (pending && desired === next) return pending;
      if (!pending && applied === next) return Promise.resolve();
      desired = next;
      const operation = (pending || Promise.resolve()).catch(() => {}).then(async () => {
        if (disposed || desired !== next || applied === next) return;
        // The core registers the session-root command in the lazily created
        // ExplorerService. A fresh profile has not necessarily opened Explorer.
        if (!initialized) {
          await vscode.commands.executeCommand('workbench.view.explorer');
          initialized = true;
          if (disposed || desired !== next) return;
        }
        // The command can change the tree before its promise settles. Invalidate
        // the old root even on failure, or A -> B -> A may incorrectly skip A.
        applied = undefined;
        watcher?.dispose();
        watcher = undefined;
        await vscode.commands.executeCommand('_ubovm.setExplorerWorkspace', next);
        if (disposed || desired !== next) return;
        if (next && onDidChangeFiles) {
          watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(next), '*'));
          watcher.onDidCreate(onDidChangeFiles);
          watcher.onDidDelete(onDidChangeFiles);
        }
        await vscode.commands.executeCommand(next ? 'workbench.view.explorer' : 'workbench.action.closeSidebar');
        applied = next;
      });
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = undefined; }).catch(() => {});
      return operation;
    },
    dispose() { disposed = true; watcher?.dispose(); }
  };
}

module.exports = { createSessionExplorer };
