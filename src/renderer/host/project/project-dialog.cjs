'use strict';

function withCenteredProjectDialog(vscode, run) {
  const commands = vscode.commands;
  const centering = Promise.resolve(commands?.executeCommand?.('workbench.action.alignQuickInputCenter')).catch(() => {});
  let result;
  try { result = run(); }
  catch (error) {
    return centering.finally(() => {}).then(() => Promise.reject(error));
  }
  return Promise.resolve(result).finally(async () => {
    await centering;
    try { await commands?.executeCommand?.('workbench.action.alignQuickInputTop'); }
    catch { /* Ignore restore failures so dialog teardown still completes. */ }
  });
}

module.exports = { withCenteredProjectDialog };
