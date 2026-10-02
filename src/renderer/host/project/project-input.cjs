'use strict';
const path = require('node:path');
const { withCenteredProjectDialog } = require('./project-dialog.cjs');

function directoryError(value) {
  const directory = value.trim();
  if (!directory || !path.isAbsolute(directory)) return '请输入项目目录的完整路径。';
  if (process.platform === 'win32' && /[<>"|?*\x00-\x1f]/.test(directory)) return '目录包含不允许的字符。';
}

async function resolveProjectFolder(vscode, folder) {
  if (folder.scheme !== 'file') throw new Error('请选择本地项目目录。');
  const error = directoryError(folder.fsPath); if (error) throw new Error(error);
  try {
    const stat = await vscode.workspace.fs.stat(folder);
    if (!(stat.type & vscode.FileType.Directory)) throw new Error('该路径是文件，请选择文件夹。');
  } catch (failure) {
    if (failure.message === '该路径是文件，请选择文件夹。') throw failure;
    if (failure.code !== 'FileNotFound' && failure.code !== 'ENOENT') {
      throw new Error('无法访问该目录：' + (failure.message || String(failure)));
    }
  }
  return folder;
}

async function readProjectInput(vscode, { workspace, suggestedName = '' } = {}) {
  return withCenteredProjectDialog(vscode, async () => {
    const name = await vscode.window.showInputBox({ title: '新建项目', step: 1, totalSteps: 2,
      prompt: '输入项目名称，下一步选择项目目录', value: suggestedName.trim().slice(0, 60), ignoreFocusOut: true,
      validateInput: value => !value.trim() || value.trim().length > 60 ? '请输入 1–60 个字符的项目名称。' : undefined });
    if (name === undefined) return;
    const trimmedName = name.trim();
    const folderName = trimmedName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'project';
    const suggested = workspace ? path.join(path.dirname(workspace), folderName) : path.resolve(folderName);
    const suggestedItem = {
      label: '$(new-folder) 使用建议目录',
      description: suggested,
      detail: '不存在时会在创建项目时自动建立',
      action: 'suggested'
    };
    const browseItem = {
      label: '$(folder-opened) 浏览选择其他目录…',
      detail: '打开文件夹对话框，选择已有目录作为项目目录',
      action: 'browse'
    };
    const choice = await vscode.window.showQuickPick([suggestedItem, browseItem], {
      title: '新建项目 · 选择项目目录', placeHolder: '选择建议目录，或浏览其他位置', ignoreFocusOut: true
    });
    if (!choice) return;
    if (choice.action === 'suggested') {
      return { name: trimmedName, folder: await resolveProjectFolder(vscode, vscode.Uri.file(path.normalize(suggested))) };
    }
    const defaultUri = vscode.Uri.file(path.dirname(path.resolve(suggested)));
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
      openLabel: '选择项目目录', title: '新建项目 · 选择项目目录', defaultUri, ignoreFocusOut: true });
    if (!uris?.length) return;
    return { name: trimmedName, folder: await resolveProjectFolder(vscode, uris[0]) };
  });
}

module.exports = { readProjectInput, directoryError };
