import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { migrateLegacyProfile } from './data-migration.mjs';

const profiles = new Set(['desktop', 'source', 'smoke']);

// Installed executables do not pass through build.bat's first-run setup.
// Create defaults once, preserving existing settings (including JSONC) verbatim.
export function initializeUserSettings(paths, defaults) {
  const settings = path.join(paths.userData, 'User', 'settings.json');
  try { fs.writeFileSync(settings, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function assertDataDirectory(directory) {
  let info;
  try { info = fs.lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`UBOVM 数据目录必须是真实目录，不能是链接：${directory}`), { code: 'UNSAFE_DATA_PATH' });
  }
}

export function resolveDataPaths({ home = homedir(), profile = 'desktop' } = {}) {
  if (!profiles.has(profile)) {
    throw new Error(`Unsupported UBOVM data profile: ${profile}`);
  }
  const root = path.resolve(home, '.ubovm');
  const portable = path.join(root, profile);
  const userData = path.join(portable, 'user-data');
  return {
    root, profile, portable, userData,
    sessionData: userData,
    extensions: path.join(portable, 'extensions'),
    extensionDownloads: path.join(userData, 'CachedExtensionVSIXs'),
    sharedData: path.join(portable, 'shared-data'),
    tmp: path.join(portable, 'tmp'),
    logs: path.join(userData, 'logs'),
    crashes: path.join(portable, 'crashes')
  };
}

export function prepareDataPaths({ home, profile, legacyRoot } = {}) {
  const paths = resolveDataPaths({ home, profile });
  const directories = [paths.root, paths.portable, paths.userData,
    path.join(paths.userData, 'User'), path.join(paths.userData, 'User', 'globalStorage'),
    path.join(paths.userData, 'User', 'workspaceStorage'), paths.extensions,
    paths.extensionDownloads, paths.sharedData, paths.tmp, paths.logs, paths.crashes];
  // Validate every managed ancestor even for a standalone installation, where
  // no legacy migration runs. mkdir({ recursive: true }) otherwise follows
  // existing junctions and silently sends persistence outside this profile.
  for (const directory of directories) assertDataDirectory(directory);
  // Migrate before making the destination: its existence is the signal that
  // there is already a profile which must never be overwritten by old data.
  if (legacyRoot) {
    migrateLegacyProfile({
      source: path.join(path.resolve(legacyRoot), '.data', paths.profile),
      destination: paths.portable
    });
  }
  for (const directory of directories) {
    assertDataDirectory(directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  return paths;
}

// A downloaded runtime lives below <project>/.runtime/<version>/resources/app.
// Restrict discovery to an actual UBOVM checkout rather than trusting a parent
// directory named .data next to an independently installed application.
export function findLegacyRoot(appPath) {
  let candidate = path.resolve(appPath);
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(candidate, 'build.bat')) &&
        fs.existsSync(path.join(candidate, 'resources', 'app.json')) &&
        fs.existsSync(path.join(candidate, '.data'))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return undefined;
}

// Code OSS accepts several path overrides that take precedence over portable
// mode. Normalize duplicate / equals-form switches before its argument parser
// runs, while preserving positional file arguments after the `--` separator.
export function normalizeDataArguments(argv, paths) {
  const fixed = {
    'user-data-dir': paths.userData,
    'extensions-dir': paths.extensions,
    'shared-data-dir': paths.sharedData
  };
  const optional = {
    'extensions-download-dir': paths.extensionDownloads,
    'crash-reporter-directory': paths.crashes,
    logsPath: paths.logs,
    'disk-cache-dir': path.join(paths.userData, 'Cache'),
    'log-file': path.join(paths.logs, 'electron.log')
  };
  const overrides = { ...fixed, ...optional };
  const seen = new Set();
  const result = [argv[0]];
  let rest = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest = argv.slice(i);
      break;
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match || !Object.hasOwn(overrides, match[1])) {
      result.push(arg);
      continue;
    }
    seen.add(match[1]);
    if (match[2] === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (Object.hasOwn(fixed, name) || seen.has(name)) result.push(`--${name}=${value}`);
  }
  return [...result, ...rest];
}

export function configureDataPaths({ app, env = process.env, argv = process.argv, home, legacyRoot } = {}) {
  const paths = prepareDataPaths({ home, profile: env.UBOVM_DATA_PROFILE || 'desktop', legacyRoot });
  env.UBOVM_DATA_PROFILE = paths.profile;
  env.VSCODE_PORTABLE = paths.portable;
  env.VSCODE_EXTENSIONS = paths.extensions;
  delete env.VSCODE_APPDATA;
  env.TMP = paths.tmp;
  env.TEMP = paths.tmp;
  env.TMPDIR = paths.tmp;

  argv.splice(0, argv.length, ...normalizeDataArguments(argv, paths));

  // Electron determines several of these defaults before Code OSS has had a
  // chance to enable portable mode. Set all of them before importing its main.
  app.setPath('userData', paths.userData);
  app.setPath('sessionData', paths.sessionData);
  app.setPath('temp', paths.tmp);
  app.setPath('crashDumps', paths.crashes);
  app.setAppLogsPath(paths.logs);
  const separator = argv.indexOf('--');
  const switches = separator < 0 ? argv : argv.slice(0, separator);
  for (const name of ['user-data-dir', 'disk-cache-dir', 'log-file']) {
    const arg = switches.find(value => value.startsWith(`--${name}=`));
    if (arg) {
      app.commandLine.removeSwitch(name);
      app.commandLine.appendSwitch(name, arg.slice(name.length + 3));
    }
  }
  return paths;
}
