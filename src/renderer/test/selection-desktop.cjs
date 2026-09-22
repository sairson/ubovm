'use strict';
const assert = require('node:assert/strict');

exports.checkSelectionDesktop = async vscode => {
  const core = await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
  await vscode.commands.executeCommand('ubovm.openAssistant');
  const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const outside = true;\nconst selected = "中文";\nconst last = false;\n' });
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
  editor.selection = new vscode.Selection(1, 0, 2, 0);
  const sessionId = core.assistantState().conversation.id;
  await vscode.commands.executeCommand('ubovm.attachSelection');
  const state = core.assistantState();
  assert.equal(state.context.fileSource, 'selection');
  assert.equal(state.context.selectionLabel, 'L2');
  assert.equal(state.conversation.id, sessionId);
  assert.equal(state.messages.length, 0, 'Attaching must not send a message');
  editor.selection = new vscode.Selection(0, 0, 0, 1);
  assert.equal(core.assistantState().context.selectionLabel, 'L2', 'Attachment must retain the captured range');
  await vscode.commands.executeCommand('ubovm.newChat');
  assert.notEqual(core.assistantState().context.fileSource, 'selection', 'Selection belongs only to the original conversation');
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString());
  // Untitled documents are test-owned; revert to avoid a save prompt on close.
  if (tabs.length) { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert'); }
  return { selectedRange: 'L2', automaticSend: false, sessionIsolation: true };
};
