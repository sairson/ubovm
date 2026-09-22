'use strict';

const filesystem = require('node:fs/promises');
const path = require('node:path');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Host-only actions for explicit message copy/link clicks. */
function createMessageActions(vscode, { fs = filesystem } = {}) {
  async function copyText(text) {
    // Match the HTML preview's source bound so every accepted preview can be
    // copied through the same host action without truncation.
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('复制内容过长或格式无效。');
    await vscode.env.clipboard.writeText(text);
  }

  async function openMessageLink(href, rootIndex) {
    if (typeof href !== 'string' || !href.trim() || href.length > 8192 || /[\x00-\x1f\x7f]/.test(href)) throw new Error('链接格式无效。');
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (rootIndex !== undefined && (!Number.isSafeInteger(rootIndex) || rootIndex < 0 || rootIndex >= folders.length)) throw new Error('工作区索引无效。');
    if (/^(https?:|mailto:)/i.test(href)) {
      if (rootIndex !== undefined) throw new Error('工作区索引只适用于本地文件链接。');
      let target; try { target = new URL(href); } catch { throw new Error('链接格式无效。'); }
      if (!['http:', 'https:', 'mailto:'].includes(target.protocol)) throw new Error('此链接协议不受支持。');
      if (target.username || target.password) throw new Error('链接不能包含登录凭据。');
      if (!await vscode.env.openExternal(vscode.Uri.parse(target.href))) throw new Error('无法打开此链接。');
      return;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) throw new Error('此链接协议不受支持。');
    // Split URL syntax before decoding, preserving a literal # in a file name
    // encoded as %23. Decode only once; decoded schemes never become URLs.
    const fragmentIndex = href.indexOf('#');
    let value, fragment;
    try {
      value = decodeURIComponent(fragmentIndex < 0 ? href : href.slice(0, fragmentIndex));
      fragment = decodeURIComponent(fragmentIndex < 0 ? '' : href.slice(fragmentIndex + 1));
    } catch { throw new Error('文件链接格式无效。'); }
    const location = value.match(/^(.*?):(\d+)(?::(\d+))?$/);
    const anchor = fragment.match(/^L?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
    const line = Number(anchor?.[1] || location?.[2] || 1), column = Number(anchor ? anchor[2] || 1 : location?.[3] || 1);
    if (location) value = location[1];
    if (!value || /[\x00-\x1f\x7f]/.test(value) || value.replace(/^[a-z]:[\\/]/i, '').includes(':') ||
        ![line, column].every(position => Number.isSafeInteger(position) && position >= 1 && position <= 10000000)) throw new Error('文件链接格式无效。');
    // Select the lexical workspace before resolving it. Removing inaccessible
    // roots first would shift the tool's stable workspace index to another root.
    const selected = rootIndex === undefined ? folders : [folders[rootIndex]];
    const available = await Promise.allSettled(selected.map(async folder => ({
      lexical: path.resolve(folder.uri.fsPath), canonical: await fs.realpath(folder.uri.fsPath),
    })));
    const roots = available.filter(result => result.status === 'fulfilled').map(result => result.value);
    let directory = false;
    for (const root of roots) {
      const requested = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root.lexical, value);
      // Reject traversal, other drives, and external UNC paths before touching
      // them. Canonical verification below also prevents symlink escapes.
      if (!roots.some(root => inside(root.lexical, requested) || inside(root.canonical, requested))) continue;
      let candidate;
      try { candidate = await fs.realpath(requested); }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
      if (!roots.some(root => inside(root.canonical, candidate))) continue;
      let info;
      try { info = await fs.stat(candidate); }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
      if (!info.isFile()) { directory = true; continue; }
      await vscode.window.showTextDocument(vscode.Uri.file(candidate), { viewColumn: vscode.ViewColumn.Two, preview: false, selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1) });
      return;
    }
    throw new Error(directory ? '链接必须指向工作区中的文件。' : '未找到工作区内的对应文件。');
  }
  return { copyText, openMessageLink };
}

module.exports = { createMessageActions };
