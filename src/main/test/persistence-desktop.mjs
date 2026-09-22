// Run explicitly after build.bat setup. Uses only the isolated ~/.ubovm/smoke profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cache = path.join(root, '.cache');
function inside(parent, target) {
  const relative = path.relative(parent, target);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), target);
}

test('normal desktop restart keeps real workspace state, conversation and encrypted credentials under ~/.ubovm', { timeout: 100000 }, async t => {
  await fs.mkdir(cache, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(cache, 'home-storage-probe-'));
  t.after(async () => { inside(cache, fixture); await fs.rm(fixture, { recursive: true, force: true }); });
  const extension = path.join(fixture, 'extension'), workspace = path.join(fixture, 'workspace');
  await fs.mkdir(extension); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'README.md'), '# Local persistence test\n');
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'ubovm-home-storage-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(extension, 'extension.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs/promises');
exports.activate = async context => {
  const result = { ok: false };
  try {
    const core = await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    const assert = require('node:assert/strict');
    const marker = process.env.UBOVM_PROBE_MARKER;
    if (process.env.UBOVM_PROBE_STAGE === 'write') {
      await context.workspaceState.update('marker', marker);
      await context.globalState.update('marker', marker);
      await context.secrets.store('probe-secret', marker);
    } else {
      assert.equal(context.workspaceState.get('marker'), marker);
      assert.equal(context.globalState.get('marker'), marker);
      assert.equal(await context.secrets.get('probe-secret'), marker);
      assert.equal(core.assistantState().conversation.id, process.env.UBOVM_PROBE_CONVERSATION);
      await context.workspaceState.update('marker', undefined);
      await context.globalState.update('marker', undefined);
      await context.secrets.delete('probe-secret');
    }
    result.conversation = core.assistantState().conversation.id;
    result.persistence = core.runtimeInfo().persistence;
    result.ok = true;
  } catch (error) { result.error = error.stack; }
  finally {
    await fs.writeFile(process.env.UBOVM_PROBE_RESULT, JSON.stringify(result));
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
`);
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const executable = path.resolve(root, config.core.runtime.directory, config.core.runtime.executable);
  const profile = path.join(homedir(), '.ubovm', 'smoke');
  const marker = 'local-storage-test-' + path.basename(fixture);
  let conversation;
  const reports = [];
  for (const stage of ['write', 'read']) {
    const resultFile = path.join(fixture, stage + '.json');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
    Object.assign(env, { UBOVM_DATA_PROFILE: 'smoke', UBOVM_PROBE_STAGE: stage, UBOVM_PROBE_MARKER: marker, UBOVM_PROBE_RESULT: resultFile, UBOVM_PROBE_CONVERSATION: conversation || '' });
    const child = spawn(executable, ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--extensionDevelopmentPath=' + extension, workspace], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Persistence probe timed out: ' + output)); }, 45000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exit, 0, output);
    const report = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    assert.equal(report.ok, true, report.error || output);
    const actualProfile = await fs.realpath(profile);
    assert.equal(path.resolve(report.persistence.profile).toLowerCase(), path.resolve(profile).toLowerCase());
    for (const key of ['workspaceState', 'globalState']) {
      inside(actualProfile, await fs.realpath(report.persistence[key]));
      const info = await fs.stat(report.persistence[key]);
      assert(info.isFile() && info.size > 0, key + ' must really be on disk after a normal shutdown');
    }
    conversation = report.conversation;
    reports.push({ stage, ok: true, persistence: report.persistence });
  }
  await fs.writeFile(path.join(cache, 'persistence-desktop-result.json'), JSON.stringify({ ok: true, checks: reports }, null, 2));
});
