import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('menu, command and keyboard policies preserve file search and replacement', () => {
  const patch = readFileSync(new URL('../../../resources/patches/file-search.patch', import.meta.url), 'utf8');
  const policies = [...patch.matchAll(/const fileSearch = (\/.*\/);/g)].map(match => Function(`return ${match[1]}`)());
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    for (const command of ['workbench.action.quickOpen', 'workbench.action.findInFiles', 'workbench.action.replaceInFiles', 'workbench.view.search', 'filesExplorer.findInFolder', 'filesExplorer.findInWorkspace', 'actions.find', 'editor.action.startFindReplaceAction', 'search.action.replaceAllInFile', 'search.action.replaceAll', 'search.action.refreshSearchResults']) {
      assert(policy.test(command), command);
    }
    for (const command of ['workbench.action.debug.start', 'workbench.action.openSettings', 'workbench.view.extensions']) assert.equal(policy.test(command), false, command);
    const model = readFileSync(new URL('../../../vendor/vscode/src/vs/editor/contrib/find/browser/findModel.ts', import.meta.url), 'utf8');
    const commands = model.match(/export const FIND_IDS = \{([\s\S]*?)\n\};/)[1];
    for (const match of commands.matchAll(/:\s*'([^']+)'/g)) assert(policy.test(match[1]), `native find operation: ${match[1]}`);
    for (const command of ['toggleSearchCaseSensitive', 'toggleSearchWholeWord', 'toggleSearchRegex', 'toggleSearchPreserveCase', 'workbench.action.toggleSearchOnType', 'workbench.action.search.toggleQueryDetails', 'closeReplaceInFilesWidget']) assert(policy.test(command), command);
  }
  const manifest = JSON.parse(readFileSync(new URL('../../renderer/package.json', import.meta.url), 'utf8'));
  const entries = manifest.contributes.menus['view/title'].filter(item => item.when === 'view == workbench.explorer.fileView');
  for (const command of ['workbench.action.quickOpen', 'workbench.action.findInFiles', 'workbench.action.replaceInFiles']) assert(entries.some(item => item.command === command));
});
