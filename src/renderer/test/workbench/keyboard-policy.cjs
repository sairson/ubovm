const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const patch = readFileSync(require('node:path').join(__dirname, '../../../../resources/patches/keyboard-policy.patch'), 'utf8');
const policy = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
const dispatch = new Function('resolveResult', policy + '\nreturn false;');

test('upstream workbench and IDE shortcuts are consumed before executing commands', () => {
  for (const commandId of ['workbench.action.showCommands', 'workbench.action.quickOpen', 'workbench.action.files.openFolder', 'workbench.action.toggleSidebarVisibility', 'workbench.action.terminal.toggleTerminal', 'workbench.action.splitEditor', 'workbench.action.closeWindow', 'workbench.action.openSettings', 'editor.action.revealDefinition', 'editor.action.formatDocument', 'editor.action.rename', 'actions.find', 'editor.action.startFindReplaceAction', 'workbench.view.explorer', 'workbench.action.debug.start']) {
    const service = { _currentlyDispatchingCommandId: commandId };
    assert.equal(dispatch.call(service, { commandId }), true, commandId);
    assert.equal(service._currentlyDispatchingCommandId, null);
  }
});
test('UBOVM shortcuts and basic editing remain available', () => {
  for (const commandId of ['ubovm.openAssistant', 'ubovm.attachSelection', 'ubovm.newChat', 'ubovm.openBrowser', 'workbench.action.browser.focusUrlInput', 'workbench.action.browser.goBack', 'type', 'undo', 'redo', 'cursorLeft', 'deleteLeft', 'tab', 'editor.action.clipboardCopyAction', 'editor.action.clipboardCutAction', 'editor.action.clipboardPasteAction', 'editor.action.selectAll', 'workbench.action.files.save', 'workbench.action.files.saveAll', 'workbench.action.files.saveAs']) {
    assert.equal(dispatch.call({}, { commandId }), false, commandId);
  }
});
