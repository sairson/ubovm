'use strict';

// Coalesce streamed publications and serialize root changes so a slow switch
// cannot overwrite a newer session's explorer. Keep window storage unchanged.
function createSessionExplorer(vscode, { onDidChangeFiles, onError = () => {} } = {}) {
  if (onDidChangeFiles !== undefined && typeof onDidChangeFiles !== 'function') throw new TypeError('Invalid file observer');
  if (typeof onError !== 'function') throw new TypeError('Invalid explorer error observer');
  let desired = '', applied, pending;
  let watcher, subscriptions = [];
  let disposed = false;
  let initialized = false;
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Observers cannot interrupt synchronization. */ }
  };
  function releaseWatcher() {
    const previous = watcher, listeners = subscriptions;
    watcher = undefined; subscriptions = [];
    for (const item of [...listeners, previous]) {
      try { Promise.resolve(item?.dispose()).catch(report); } catch (error) { report(error); }
    }
  }
  return {
    sync(workspace) {
      const next = workspace || '';
      if (disposed) return Promise.resolve();
      if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') return Promise.reject(new TypeError('Invalid explorer workspace'));
      if (!pending && applied === next) return Promise.resolve();
      desired = next;
      if (pending) return pending;
      const operation = Promise.resolve().then(async () => {
        while (!disposed && applied !== desired) {
        const next = desired;
        try {
        // Instantiate the lazy service without revealing a view. Session root
        // updates must not change visibility or replace the active Worker tab.
        if (!initialized) {
          await vscode.commands.executeCommand('_ubovm.initializeExplorer');
          initialized = true;
          if (disposed) return;
          if (desired !== next) continue;
        }
        // The command can change the tree before its promise settles. Invalidate
        // the old root even on failure, or A -> B -> A may incorrectly skip A.
        applied = undefined;
        releaseWatcher();
        await vscode.commands.executeCommand('_ubovm.setExplorerWorkspace', next);
        if (disposed) return;
        if (desired !== next) continue;
        if (next && onDidChangeFiles) {
          watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(next), '*'));
          const currentWatcher = watcher;
          const changed = event => {
            if (!disposed && watcher === currentWatcher && desired === next) {
              try { Promise.resolve(onDidChangeFiles(event)).catch(report); } catch (error) { report(error); }
            }
          };
          subscriptions.push(watcher.onDidCreate(changed));
          subscriptions.push(watcher.onDidDelete(changed));
        }
        applied = next;
        } catch (error) {
          releaseWatcher();
          if (disposed) return;
          if (desired === next) throw error;
          report(error);
        }
        }
      }).finally(() => { if (pending === operation) pending = undefined; });
      pending = operation;
      return operation;
    },
    dispose() { disposed = true; releaseWatcher(); }
  };
}

module.exports = { createSessionExplorer };
