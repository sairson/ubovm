import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('native goal notebook stays visible when switching views', { timeout: 65000 }, async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.cache/goal-notes-'));
  const workspace = path.join(fixture, 'window');
  const extension = path.join(fixture, 'extension'), home = path.join(fixture, 'home');
  await Promise.all([workspace, extension, home].map(folder => fs.mkdir(folder)));
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'goal-notes-test', publisher: 'ubovm', version: '0.0.1', engines: { vscode: '^1.100.0' } }));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const resultFile = path.join(fixture, 'result.json'), entry = path.join(extension, 'run.cjs');
  await fs.writeFile(entry, `
const fs = require('node:fs/promises'), assert = require('node:assert/strict');
exports.run = async () => {
  const vscode = require('vscode');
  let browser;
  try {
    await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    await vscode.commands.executeCommand('workbench.view.explorer');
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright-core'))});
    browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench'));
    assert(page, 'native workbench page'); page.setDefaultTimeout(10000);

    await vscode.commands.executeCommand('ubovm.openAssistant');

    const cdp=await browser.newBrowserCDPSession();
    const targets=(await cdp.send('Target.getTargets')).targetInfos;
    const target=targets.find(t=>t.type!=='service_worker' && t.type!=='worker' && (t.url.startsWith('vscode-webview:') || t.type==='iframe'));
    assert(target,JSON.stringify(targets));
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    let sequence=0;
    const evaluate=expression=>new Promise(async(resolve,reject)=>{
      const id=++sequence;
      const handler=e=>{const m=JSON.parse(e.message);if(e.sessionId===sessionId&&m.id===id){cdp.off('Target.receivedMessageFromTarget',handler);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}};
      cdp.on('Target.receivedMessageFromTarget',handler);
      await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}})});
    });


    await new Promise(resolve=>setTimeout(resolve,1000));
    const state={type:'state',mode:'goal',conversation:{id:'notebook-test',title:'Notebook'},goal:{objective:'Notebook navigation',criteria:[],notes:[]},context:{workspace:'fixture',workspaceConfigured:true},execution:{status:'idle'},messages:[],busy:false};
    const loaded=await evaluate("(()=>{const w=document.getElementById('active-frame').contentWindow;w.notebookErrors=[];w.addEventListener('error',e=>w.notebookErrors.push(e.message));w.dispatchEvent(new w.MessageEvent('message',{data:"+JSON.stringify(state)+"}));return true})()");
    assert(!loaded.exceptionDetails,JSON.stringify(loaded));
    await new Promise(resolve=>setTimeout(resolve,100));
    for(let index=0;index<3;index++) {
      const clicked=await evaluate("document.getElementById('active-frame').contentDocument.getElementById('goal-tab-notes').click()");
      assert(!clicked.exceptionDetails,JSON.stringify(clicked));
      await new Promise(resolve=>setTimeout(resolve,250));
      const info=await evaluate("(()=>{const d=document.getElementById('active-frame').contentDocument,n=d.getElementById('goal-notes'),r=n.getBoundingClientRect();return {height:r.height,width:r.width,top:r.top,hidden:n.hidden,emptyVisible:d.getElementById('notes-empty').getBoundingClientRect().height>0,errors:d.defaultView.notebookErrors}})()");
      const layout=info.result.value;
      assert(layout&&!layout.hidden&&layout.height>200&&layout.width>200&&layout.emptyVisible,JSON.stringify(info));
      assert.deepEqual(layout.errors,[]);
      await page.screenshot({path: ${JSON.stringify(path.join(fixture,'notes-actual.png'))}});
      await evaluate("document.getElementById('active-frame').contentDocument.getElementById('goal-tab-overview').click()");
    }
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  } finally { await browser?.close(); }
};`);
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, UBOVM_DATA_PROFILE: 'smoke' });
  const child = spawn(path.resolve(root, config.core.runtime.directory, config.core.runtime.executable), ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + entry, workspace], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Notebook test timed out: ' + output)); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(() => JSON.stringify({ ok: false, error: output })));
  assert.equal(report.ok, true, report.error);
  assert.equal(code, 0, output);
});
