'use strict';
const { stat } = require('node:fs/promises');

async function droppedFile(vscode, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件附件无效。');
  if (typeof value.uri === 'string') {
    if (value.uri.length > 32768) throw new Error('文件路径过长。');
    const uri = vscode.Uri.parse(value.uri, true);
    if (uri.scheme !== 'file' || !uri.fsPath || uri.query || uri.fragment) throw new Error('当前仅支持本地文件。');
    if (!(await stat(uri.fsPath)).isFile()) throw new Error('请拖入文件，暂不支持文件夹。');
    return { label: vscode.workspace.asRelativePath(uri), path: uri.fsPath };
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255 || /[\x00-\x1f/\\]/u.test(value.name)
    || typeof value.content !== 'string' || value.content.includes('\0') || Buffer.byteLength(value.content) > 64000
    || typeof value.truncated !== 'boolean') throw new Error('文件附件无效或超出文本大小限制。');
  return { kind: 'file-drop', label: value.name + (value.truncated ? '（内容已截断）' : ''),
    snapshot: { file: value.name, content: value.content, truncated: value.truncated } };
}
module.exports = { droppedFile };
