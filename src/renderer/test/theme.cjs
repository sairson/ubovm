const test=require('node:test'),assert=require('node:assert/strict');
const {setTheme,readTheme}=require('../host/theme.cjs');
function mock(){const calls=[];const config={get:()=> 'UBOVM Dark',inspect:k=>({workspaceValue:k==='workbench.colorTheme'?'Existing':undefined}),update:async(...args)=>calls.push(args)};return {calls,workspace:{getConfiguration:()=>config},window:{activeColorTheme:{kind:2}},ColorThemeKind:{Dark:2,HighContrast:3},ConfigurationTarget:{Global:1,Workspace:2}};}
test('theme changes the global IDE setting and existing workspace override',async()=>{const api=mock();await setTheme(api,'dark');assert.deepEqual(api.calls,[['window.autoDetectColorScheme',false,1],['workbench.colorTheme','UBOVM Dark',1],['workbench.colorTheme','UBOVM Dark',2]]);assert.deepEqual(readTheme(api),{mode:'dark',name:'UBOVM Dark'});});
test('invalid theme cannot write configuration',async()=>{const api=mock();await assert.rejects(setTheme(api,'invalid'));assert.equal(api.calls.length,0);});

test('source startup honors the saved theme even when the splash uses the opposite mode', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const patch = fs.readFileSync(path.resolve(__dirname, '../../../resources/theme-startup.patch'), 'utf8');
  const code = patch.split('\n').filter(line => /^[ +]/.test(line) && !line.startsWith('+++'))
    .map(line => line.slice(1)).join('\n');
  const initialize = new Function('extDevLoc', code + '\n}; return initializeColorTheme();');
  const themes = [
    { id: 'dark-id', settingsId: 'UBOVM Dark', type: 'dark' },
    { id: 'light-id', settingsId: 'UBOVM Light', type: 'light' }
  ];
  for (const [saved, splash, expected] of [
    ['UBOVM Light', 'dark', 'light-id'],
    ['UBOVM Dark', 'light', 'dark-id'],
    ['Other Theme', 'light', 'light-id'],
    ['Other Theme', 'hcDark', 'dark-id']
  ]) {
    const service = {
      colorThemeRegistry: { findThemeByExtensionLocation: () => themes },
      settings: { colorTheme: saved }, currentColorTheme: { type: splash },
      setColorTheme: async id => id
    };
    assert.equal(await initialize.call(service, 'extension'), expected);
  }
});

test('native title bar exposes one theme action and the webview has no duplicate', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '../../..');
  const patch = fs.readFileSync(path.join(root, 'resources/minimal-ui.patch'), 'utf8').split('diff --git')[1];
  const code = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const menu = new Function('id', 'result', code + '\nreturn result;');
  const items = menu({ id: 'TitleBar' }, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].command.id, 'ubovm.toggleTheme');
  assert.equal(items[0].command.icon.id, 'color-mode');
  assert.equal(items[0].group, 'navigation');
  assert.equal(menu({ id: 'TitleBar' }, items).length, 1);
  assert.equal(menu({ id: 'EditorTitle' }, []).length, 0);
  const { renderWebview } = require('../host/webview.cjs');
  assert(!renderWebview().includes('id="theme-toggle"'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/package.json')));
  assert(manifest.contributes.commands.some(c => c.command === 'ubovm.toggleTheme'));
});
