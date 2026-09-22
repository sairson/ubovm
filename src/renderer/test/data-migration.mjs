import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { migrateLegacyProfile } from '../../main/data-migration.mjs';

const cacheRoot = fileURLToPath(new URL('../../../.cache/', import.meta.url));

function fixture(t, profile = 'desktop') {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(cacheRoot, 'data-migration-'));
  const source = path.join(root, '.data', profile);
  const destination = path.join(root, '.ubovm', profile);
  t.after(() => {
    const relative = path.relative(cacheRoot, root);
    assert.ok(relative.startsWith('data-migration-') && !relative.includes(path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, destination };
}

function write(root, relative, content) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function assertFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(root, relative)), Buffer.from(content), relative);
  }
}

function assertNoDestinationOrStaging({ destination }) {
  assert.equal(fs.existsSync(destination), false);
  const parent = path.dirname(destination);
  assert.deepEqual(fs.existsSync(parent) ? fs.readdirSync(parent) : [], []);
}

function mockFs(t, method, implementation) {
  const original = fs[method];
  const mock = t.mock.method(fs, method, implementation(original));
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

for (const profile of ['desktop', 'source', 'smoke']) {
  test(`migrates ${profile} settings, SQLite sidecars, hidden files and extensions byte-for-byte`, t => {
    const paths = fixture(t, profile);
    const files = {
      'user-data/User/settings.json': '{"ubovm.language":"中文","editor.fontSize":15}\r\n',
      'user-data/User/workspaceStorage/workspace-a/state.vscdb': Buffer.concat([
        Buffer.from('SQLite format 3\0'), Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256))
      ]),
      'user-data/User/workspaceStorage/workspace-a/state.vscdb-wal': Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 0xff, 0x80, 0x0a]),
      'user-data/User/workspaceStorage/workspace-a/state.vscdb-shm': Buffer.from([0, 0xff, 0xfe, 0x80, 0x01]),
      'user-data/User/globalStorage/ubovm/assist.sqlite': Buffer.from([0xff, 0, 0x80, 0x0d, 0x0a]),
      'extensions/example.extension/package.json': '{"name":"example.extension"}',
      'extensions/.obsolete': '{}',
      '.profile-metadata': 'hidden profile data',
      'user-data/empty-file': ''
    };
    for (const [relative, content] of Object.entries(files)) write(paths.source, relative, content);
    fs.mkdirSync(path.join(paths.source, 'user-data/empty-directory'), { recursive: true });
    const result = migrateLegacyProfile(paths);
    assert.equal(result.status, 'migrated');
    assert.equal(result.source, paths.source);
    assert.equal(result.destination, paths.destination);
    assert.equal(result.files, Object.keys(files).length);
    assert.equal(result.bytes, Object.values(files).reduce((total, content) => total + Buffer.byteLength(content), 0));
    assertFiles(paths.destination, files);
    assertFiles(paths.source, files);
    assert.equal(fs.statSync(path.join(paths.destination, 'user-data/empty-directory')).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(path.dirname(paths.destination)), [profile]);
  });
}

test('missing source is a no-op and does not create the destination', t => {
  const paths = fixture(t);
  assert.deepEqual(migrateLegacyProfile(paths), {
    status: 'missing', source: paths.source, destination: paths.destination
  });
  assertNoDestinationOrStaging(paths);
});

test('repeated migration preserves the destination and never merges a changed source', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'original settings');
  assert.equal(migrateLegacyProfile(paths).status, 'migrated');
  write(paths.source, 'user-data/User/settings.json', 'changed legacy settings');
  write(paths.source, 'extensions/legacy-new-file', 'must not merge');
  const result = migrateLegacyProfile(paths);
  assert.equal(result.status, 'existing');
  assert.equal(fs.readFileSync(path.join(paths.destination, 'user-data/User/settings.json'), 'utf8'), 'original settings');
  assert.equal(fs.existsSync(path.join(paths.destination, 'extensions/legacy-new-file')), false);
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/User/settings.json'), 'utf8'), 'changed legacy settings');
});

test('pre-existing destination directory is authoritative even when empty', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'legacy data');
  fs.mkdirSync(paths.destination, { recursive: true });
  assert.equal(migrateLegacyProfile(paths).status, 'existing');
  assert.deepEqual(fs.readdirSync(paths.destination), []);
});

test('pre-existing destination file is never replaced by a directory', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'legacy data');
  write(path.dirname(paths.destination), path.basename(paths.destination), 'existing destination');
  assert.throws(() => migrateLegacyProfile(paths), error => error.code === 'UNSAFE_DATA_PATH');
  assert.equal(fs.readFileSync(paths.destination, 'utf8'), 'existing destination');
});

test('active legacy Code OSS PID prevents migrating a profile being written', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/code.lock', String(process.pid));
  write(paths.source, 'user-data/User/settings.json', 'original settings');
  assert.throws(() => migrateLegacyProfile(paths));
  assertNoDestinationOrStaging(paths);
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/code.lock'), 'utf8'), String(process.pid));
});

test('exited legacy PID allows migration and transient files remain only in the backup', t => {
  const paths = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), error => error.code === 'ESRCH');
  const temporary = {
    'user-data/code.lock': String(exited.pid),
    'tmp/unfinished-download': 'incomplete',
    'user-data/SingletonLock': 'old process',
    'user-data/SingletonCookie': 'old cookie',
    'user-data/SingletonSocket': 'old socket'
  };
  for (const [relative, content] of Object.entries(temporary)) write(paths.source, relative, content);
  write(paths.source, 'user-data/User/settings.json', 'persisted settings');
  assert.equal(migrateLegacyProfile(paths).status, 'migrated');
  assert.equal(fs.readFileSync(path.join(paths.destination, 'user-data/User/settings.json'), 'utf8'), 'persisted settings');
  for (const relative of Object.keys(temporary)) assert.equal(fs.existsSync(path.join(paths.destination, relative)), false, relative);
  assertFiles(paths.source, temporary);
});

for (const linkedRoot of [false, true]) {
  test(`rejects ${linkedRoot ? 'source root' : 'nested source'} links without following them`, t => {
    const paths = fixture(t);
    const outside = path.join(paths.root, 'outside-profile');
    write(outside, 'secret.txt', 'outside profile boundary');
    fs.mkdirSync(linkedRoot ? path.dirname(paths.source) : paths.source, { recursive: true });
    const link = linkedRoot ? paths.source : path.join(paths.source, 'linked-folder');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`links unavailable: ${error.code}`);
      throw error;
    }
    assert.throws(() => migrateLegacyProfile(paths));
    assertNoDestinationOrStaging(paths);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside profile boundary');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });
}

test('copy failure after a copied file removes staging and leaves the source available for retry', t => {
  const paths = fixture(t);
  const files = { 'user-data/a.json': 'first file', 'user-data/b.sqlite': Buffer.from([0, 0xff, 4, 5]) };
  for (const [relative, content] of Object.entries(files)) write(paths.source, relative, content);
  let copied = 0;
  mockFs(t, 'copyFileSync', original => (...args) => {
    assert.equal(fs.existsSync(paths.destination), false, 'destination must not become visible until copying finishes');
    if (++copied === 2) throw Object.assign(new Error('injected copy failure'), { code: 'EIO' });
    return original(...args);
  });
  assert.throws(() => migrateLegacyProfile(paths), /injected copy failure/);
  assert.equal(copied, 2);
  assertNoDestinationOrStaging(paths);
  assertFiles(paths.source, files);
});

test('rename failure cleans verified staging without changing the original profile', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'persisted settings');
  mockFs(t, 'renameSync', original => (source, destination, ...args) => {
    if (path.resolve(destination) === paths.destination) throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
    return original(source, destination, ...args);
  });
  assert.throws(() => migrateLegacyProfile(paths), /injected rename failure/);
  assertNoDestinationOrStaging(paths);
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/User/settings.json'), 'utf8'), 'persisted settings');
});

test('same-length copy corruption fails verification before the profile becomes visible', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'good');
  mockFs(t, 'copyFileSync', original => (source, destination, ...args) => {
    original(source, destination, ...args);
    fs.writeFileSync(destination, 'oops');
  });
  assert.throws(() => migrateLegacyProfile(paths));
  assertNoDestinationOrStaging(paths);
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/User/settings.json'), 'utf8'), 'good');
});

test('files added to the source during copying abort migration instead of publishing incomplete history', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'persisted settings');
  mockFs(t, 'copyFileSync', original => (...args) => {
    original(...args);
    write(paths.source, 'user-data/User/workspaceStorage/new-session/state.vscdb', 'concurrent session');
  });
  assert.throws(() => migrateLegacyProfile(paths), error => error.code === 'PROFILE_CHANGED');
  assertNoDestinationOrStaging(paths);
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/User/workspaceStorage/new-session/state.vscdb'), 'utf8'), 'concurrent session');
});

test('a destination created during copying is preserved and the migration reports a conflict', t => {
  const paths = fixture(t);
  write(paths.source, 'user-data/User/settings.json', 'legacy settings');
  mockFs(t, 'copyFileSync', original => (...args) => {
    original(...args);
    write(paths.destination, 'user-data/User/settings.json', 'concurrent destination settings');
  });
  assert.throws(() => migrateLegacyProfile(paths), error => error.code === 'MIGRATION_CONFLICT');
  assert.deepEqual(fs.readdirSync(path.dirname(paths.destination)), ['desktop']);
  assert.equal(fs.readFileSync(path.join(paths.destination, 'user-data/User/settings.json'), 'utf8'), 'concurrent destination settings');
  assert.equal(fs.readFileSync(path.join(paths.source, 'user-data/User/settings.json'), 'utf8'), 'legacy settings');
});
