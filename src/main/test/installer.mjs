// Explicit integration test: build the installer first, then run this on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cache = path.join(root, '.cache');
function run(file, args, env = process.env, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out: ' + file + '\n' + output)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(file + ' exited ' + code + '\n' + output)); });
  });
}

test('installer installs standalone app, launches packaged SDK and uninstalls without removing user data', { skip: process.platform !== 'win32', timeout: 900000 }, async () => {
  const registration = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{5F9DB052-9F61-4EB3-97F2-7625BBF49C23}_is1';
  const resume = process.env.UBOVM_INSTALLER_TEST_RESUME;
  const registered = spawnSync('reg.exe', ['query', registration, '/v', 'InstallLocation'], { windowsHide: true, encoding: 'utf8' });
  if (!resume) assert.notEqual(registered.status, 0, 'Existing UBOVM installation: do not replace it with the test install');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const installer = path.join(root, 'dist', `UBOVM-Setup-${version}-x64.exe`);
  const fixture = resume ? path.resolve(resume) : await fs.mkdtemp(path.join(cache, 'installer-smoke-'));
  assert.equal(path.dirname(fixture), path.resolve(cache));
  assert(path.basename(fixture).startsWith('installer-smoke-'));
  const installed = path.join(fixture, 'installed'), home = path.join(fixture, 'home'), extension = path.join(fixture, 'probe');
  if (resume && registered.status === 0) assert(registered.stdout.toLowerCase().includes(installed.toLowerCase()), 'Cannot resume an unrelated installation');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(extension, { recursive: true });
  const resultFile = path.join(fixture, 'result.json');
  let hasInstall = false;
  try {
    if (resume) {
      const deadline = Date.now() + 600000;
      while (!(await fs.readFile(path.join(fixture, 'install.log'), 'utf8')).includes('Installation process succeeded.')) {
        assert(Date.now() < deadline, 'Resumed installation did not finish');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else await run(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=', '/DIR=' + installed, '/LOG=' + path.join(fixture, 'install.log')]);
    hasInstall = true;
    const executable = path.join(installed, 'UBOVM.exe');
    await fs.access(executable);
    await fs.access(path.join(installed, 'resources/app/ubovm/node_modules/ssh2/package.json'));
    await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'installer-probe', publisher: 'ubovm-test', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
    await fs.writeFile(path.join(extension, 'extension.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = async () => {
  const report = {};
  try {
    const core = await vscode.extensions.getExtension('ubovm.ubovm-core').activate();
    report.runtime = core.runtimeInfo();
    report.sdk = process.env.UBOVM_HARNESS_ENTRY;
    report.theme = vscode.workspace.getConfiguration('workbench').get('colorTheme');
    report.ok = true;
  } catch (error) { report.error = error.stack; }
  finally {
    fs.writeFileSync(process.env.UBOVM_INSTALLER_PROBE_RESULT, JSON.stringify(report));
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'UBOVM_HARNESS_ENTRY'].includes(key)));
    Object.assign(env, { USERPROFILE: home, HOME: home, UBOVM_DATA_PROFILE: 'smoke', UBOVM_INSTALLER_PROBE_RESULT: resultFile });
    await run(executable, ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--extensionDevelopmentPath=' + extension], env, 60000);
    const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    assert.equal(result.ok, true, result.error);
    assert.equal(path.resolve(result.sdk), path.join(installed, 'resources/app/ubovm/harness/index.mjs'));
    assert.equal(result.theme, 'UBOVM Light');
    const settings = path.join(home, '.ubovm/smoke/user-data/User/settings.json');
    const before = await fs.readFile(settings, 'utf8');
    // Electron's main process can exit before the OS releases child-module
    // mappings. Avoid racing an immediate test uninstall with that teardown.
    await run('powershell.exe', ['-NoProfile', '-Command', `
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
do {
  $ready = $true
  foreach ($name in @('UBOVM.exe', 'ffmpeg.dll')) {
    try {
      $stream = [IO.File]::Open((Join-Path $env:UBOVM_TEST_INSTALL_DIR $name), 'Open', 'ReadWrite', 'None')
      $stream.Dispose()
    } catch { $ready = $false }
  }
  if ($ready) { exit 0 }
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Test application files are still in use'
`], { ...process.env, UBOVM_TEST_INSTALL_DIR: installed }, 65000);
    await run(path.join(installed, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(fixture, 'uninstall.log')]);
    hasInstall = false;
    assert.equal(await fs.readFile(settings, 'utf8'), before);
    await assert.rejects(fs.access(executable), { code: 'ENOENT' });
    await fs.writeFile(path.join(cache, 'installer-smoke-result.json'), JSON.stringify({ ok: true, fixture, ...result }, null, 2));
  } finally {
    if (hasInstall) await run(path.join(installed, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  }
});
