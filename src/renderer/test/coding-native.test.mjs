import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('selection, editing, search and validation work in an isolated native workbench', { timeout: 65000 }, async () => {
  const cache = path.join(root, '.cache');
  await fs.mkdir(cache, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(cache, 'coding-native-'));
  const workspace = path.join(fixture, 'workspace'), extension = path.join(fixture, 'extension'), home = path.join(fixture, 'home');
  await Promise.all([workspace, extension, home].map(directory => fs.mkdir(directory)));
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'coding-native-test', publisher: 'ubovm', version: '0.0.1', engines: { vscode: '^1.100.0' } }));
  const resultFile = path.join(fixture, 'result.json');
  const helper = path.join(root, 'src/renderer/test/coding-desktop.cjs');
  const selectionHelper = path.join(root, 'src/renderer/test/selection-desktop.cjs');
  const intelligenceHelper = path.join(root, 'src/renderer/test/workspace-intelligence-desktop.cjs');
  const entry = path.join(extension, 'run.cjs');
  await fs.writeFile(entry, `
const fs = require('node:fs/promises');
exports.run = async () => {
  const vscode = require('vscode');
  try {
    await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    const selection = await require(${JSON.stringify(selectionHelper)}).checkSelectionDesktop(vscode);
    const result = await require(${JSON.stringify(helper)}).checkCodingDesktop(vscode, ${JSON.stringify(workspace)});
    const intelligence = await require(${JSON.stringify(intelligenceHelper)}).checkWorkspaceIntelligence(vscode, ${JSON.stringify(workspace)});
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true, selection, intelligence, ...result }));
  } catch (error) {
    await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ok: false, error: error.stack }));
    throw error;
  }
};`);
  const config = JSON.parse(await fs.readFile(path.join(root, 'resources/app.json'), 'utf8'));
  const executable = path.resolve(root, config.core.runtime.directory, config.core.runtime.executable);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
  Object.assign(env, { USERPROFILE: home, UBOVM_DATA_PROFILE: 'smoke' });
  const child = spawn(executable, ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${entry}`, workspace], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-10000); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Native coding test timed out. Fixture: ${fixture}\n${output}`)); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(() => JSON.stringify({ ok: false, error: output })));
  assert.equal(report.ok, true, report.error || output);
  assert.equal(code, 0, output);
  // Keep the isolated result/profile for reproducible diagnosis; no user profile is changed.
});
