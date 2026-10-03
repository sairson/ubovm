import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDataPaths, findLegacyRoot, initializeUserSettings, normalizeDataArguments, prepareDataPaths, resolveDataPaths } from '../data-paths.mjs';

function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'ubovm-data-paths-'));
  assert.equal(path.dirname(root), temporaryRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('standalone installation initializes defaults once without replacing user settings', t => {
  const paths = prepareDataPaths({ home: fixture(t) });
  const filename = path.join(paths.userData, 'User', 'settings.json');
  initializeUserSettings(paths, { 'workbench.colorTheme': 'UBOVM Light' });
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8'))['workbench.colorTheme'], 'UBOVM Light');
  const custom = '// Keep my settings\n{ "editor.fontSize": 18 }\n';
  fs.writeFileSync(filename, custom);
  initializeUserSettings(paths, { 'editor.fontSize': 14 });
  assert.equal(fs.readFileSync(filename, 'utf8'), custom);
});

test('data profiles are isolated below the user home and reject path escapes', () => {
  const home = path.resolve('example-home');
  const portablePaths = new Set();
  for (const profile of ['desktop', 'source', 'smoke']) {
    const paths = resolveDataPaths({ home, profile });
    assert.equal(paths.portable, path.join(home, '.ubovm', profile));
    for (const key of ['userData', 'sessionData', 'extensions', 'sharedData', 'tmp', 'logs', 'crashes']) {
      const relative = path.relative(paths.portable, paths[key]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }
    portablePaths.add(paths.portable);
  }
  assert.equal(portablePaths.size, 3);
  assert.throws(() => resolveDataPaths({ profile: '../desktop' }), /Unsupported/);
});

test('bootstrap redirects stale environment, CLI overrides and Electron before upstream launch', t => {
  const home = fixture(t);
  const env = { VSCODE_PORTABLE: 'old-project/.data', VSCODE_APPDATA: 'external', VSCODE_EXTENSIONS: 'external-extensions' };
  const argv = ['app.exe', 'workspace', '--extensions-dir=old', '--extensions-dir', 'another', '--user-data-dir=external',
    '--shared-data-dir', 'external-shared', '--crash-reporter-directory=external-crashes', '--logsPath=external-logs',
    '--extensions-download-dir', 'downloads', '--disk-cache-dir=cache', '--log-file=external-log'];
  const appPaths = {};
  const switches = new Map();
  const app = {
    setPath(name, value) { appPaths[name] = value; },
    setAppLogsPath(value) { appPaths.logs = value; },
    commandLine: { removeSwitch(name) { switches.delete(name); }, appendSwitch(name, value) { switches.set(name, value); } }
  };
  const paths = configureDataPaths({ app, env, argv, home });
  assert.equal(env.UBOVM_DATA_PROFILE, 'desktop');
  assert.equal(env.VSCODE_PORTABLE, paths.portable);
  assert.equal(env.VSCODE_EXTENSIONS, paths.extensions);
  assert.equal(env.VSCODE_APPDATA, undefined);
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(env[key], paths.tmp);
  assert.deepEqual(appPaths, { userData: paths.userData, sessionData: paths.userData, temp: paths.tmp, crashDumps: paths.crashes, logs: paths.logs });
  assert.equal(switches.get('user-data-dir'), paths.userData);
  assert.equal(switches.get('disk-cache-dir'), path.join(paths.userData, 'Cache'));
  assert.equal(switches.get('log-file'), path.join(paths.logs, 'electron.log'));
  assert.equal(argv.filter(arg => arg.startsWith('--extensions-dir')).length, 1);
  assert.deepEqual(argv.slice(0, 2), ['app.exe', 'workspace']);
  for (const arg of argv.slice(2)) {
    const value = arg.slice(arg.indexOf('=') + 1);
    assert.ok(!path.relative(paths.portable, value).startsWith('..'), arg);
  }
  assert.ok(fs.existsSync(paths.tmp));
  assert.ok(fs.existsSync(paths.userData));
});

test('normalizing paths preserves positional arguments and does not enable crash reporting', () => {
  const paths = resolveDataPaths();
  const argv = ['app.exe', '--new-window', '--extensions-dir', '--disable-extensions', '--', '--log-file=literal-workspace-name'];
  const normalized = normalizeDataArguments(argv, paths);
  assert.deepEqual(normalized.slice(-2), ['--', '--log-file=literal-workspace-name']);
  assert.ok(normalized.includes('--disable-extensions'));
  assert.ok(normalized.includes('--new-window'));
  assert.ok(!normalized.some(arg => arg.startsWith('--crash-reporter-directory=')));
  assert.deepEqual(normalizeDataArguments(normalized, paths), normalized);
});

test('direct runtime launch discovers and migrates the legacy checkout profile', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  const appPath = path.join(checkout, '.runtime', 'version', 'resources', 'app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.mkdirSync(path.join(checkout, 'resources'), { recursive: true });
  const legacyData = path.join(checkout, '.data', 'desktop', 'user-data', 'User');
  fs.mkdirSync(legacyData, { recursive: true });
  fs.mkdirSync(path.join(checkout, 'build'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'build', 'build.bat'), '');
  fs.writeFileSync(path.join(checkout, 'resources', 'app.json'), '{}');
  fs.writeFileSync(path.join(legacyData, 'settings.json'), '{"saved":true}');
  assert.equal(findLegacyRoot(appPath), checkout);
  const paths = prepareDataPaths({ home, legacyRoot: findLegacyRoot(appPath) });
  assert.equal(fs.readFileSync(path.join(paths.userData, 'User', 'settings.json'), 'utf8'), '{"saved":true}');
  assert.ok(fs.existsSync(path.join(legacyData, 'settings.json')));
  fs.writeFileSync(path.join(paths.userData, 'User', 'settings.json'), '{"saved":"new"}');
  prepareDataPaths({ home, legacyRoot: checkout });
  assert.equal(fs.readFileSync(path.join(paths.userData, 'User', 'settings.json'), 'utf8'), '{"saved":"new"}');
});

test('legacy discovery ignores unrelated parent .data folders', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.data'));
  assert.equal(findLegacyRoot(path.join(root, 'resources', 'app')), undefined);
});

test('preparing a standalone profile rejects junctions in managed data directories', t => {
  const root = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  const directories = ['', 'desktop', path.join('desktop', 'user-data'),
    path.join('desktop', 'user-data', 'User'), path.join('desktop', 'user-data', 'User', 'workspaceStorage'),
    path.join('desktop', 'user-data', 'logs'), path.join('desktop', 'extensions'), path.join('desktop', 'tmp')];
  for (const [index, relative] of directories.entries()) {
    const home = path.join(root, `home-${index}`);
    const linked = path.join(home, '.ubovm', relative);
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => prepareDataPaths({ home }), { code: 'UNSAFE_DATA_PATH' }, relative || '.ubovm');
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  }
});
