'use strict';
const names = { light: 'UBOVM Light', dark: 'UBOVM Dark' };
function readTheme(vscode) {
  const kind = vscode.window.activeColorTheme.kind;
  return { mode: [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(kind) ? 'dark' : 'light', name: vscode.workspace.getConfiguration().get('workbench.colorTheme') };
}
async function setTheme(vscode, mode) {
  if (!Object.hasOwn(names, mode)) throw new Error('主题必须为 light 或 dark');
  const config = vscode.workspace.getConfiguration();
  for (const [key, value] of [['window.autoDetectColorScheme', false], ['workbench.colorTheme', names[mode]]]) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    if (config.inspect(key)?.workspaceValue !== undefined) await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}
module.exports = { readTheme, setTheme };
