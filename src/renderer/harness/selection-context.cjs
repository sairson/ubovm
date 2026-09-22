'use strict';

/** Capture synchronously, before revealing the conversation changes editor focus. */
function captureSelection(vscode, editor = vscode.window.activeTextEditor) {
  if (!editor || !['file', 'untitled', 'ubovm-diff'].includes(editor.document.uri.scheme)) throw new Error('请先在代码编辑器中选中要添加的代码。');
  const selections = (editor.selections ?? [editor.selection]).filter(selection => selection && !selection.isEmpty);
  if (!selections.length) throw new Error('请先选中要添加的代码。');
  if (selections.length > 20) throw new Error('一次最多添加 20 个选区，请缩小选择范围。');
  const document = editor.document;
  const ranges = selections.map(selection => ({
    startLine: selection.start.line + 1, startColumn: selection.start.character + 1,
    endLine: selection.end.line + 1, endColumn: selection.end.character + 1,
    content: document.getText(selection)
  }));
  const content = ranges.map(range => range.content).join('\n\n');
  if (content.length > 16000) throw new Error('选中代码超过 16,000 字符，请缩小选择范围后重试。');
  const file = document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
  const label = document.uri.scheme === 'file' ? vscode.workspace.asRelativePath(document.uri) : document.fileName || file;
  const rangeLabel = ranges.map(range => {
    const end = range.endColumn === 1 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
    return end === range.startLine ? `L${range.startLine}` : `L${range.startLine}–${end}`;
  }).join(', ');
  const snapshot = { source: 'selection', file, languageId: document.languageId, version: document.version,
    unsaved: document.isDirty, ranges, content, truncated: false, rangeEndExclusive: true };
  // Leave room for workspace metadata in the collaboration context envelope.
  if (JSON.stringify(snapshot).length > 28000) throw new Error('选区上下文过大，请缩小选择范围后重试。');
  return { kind: 'selection', label, path: file, rangeLabel, snapshot };
}

module.exports = { captureSelection };
