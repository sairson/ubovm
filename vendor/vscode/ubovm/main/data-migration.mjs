import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const profiles = new Set(['desktop', 'source', 'smoke']);
const fail = (code, message) => Object.assign(new Error(message), { code });
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function assertDirectory(directory) {
  const info = stat(directory);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw fail('UNSAFE_DATA_PATH', `数据目录必须是真实目录，不能是链接：${directory}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    // Access denied still means the database may have a live owner.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
function assertInactive(source) {
  const lock = path.join(source, 'user-data', 'code.lock');
  if (!stat(lock)) return;
  if (stat(lock).isSymbolicLink()) throw fail('UNSAFE_DATA_PATH', `不能读取链接形式的进程锁：${lock}`);
  const raw = fs.readFileSync(lock, 'utf8').trim();
  const pid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 0) throw fail('INVALID_PROFILE_LOCK', `旧数据目录的进程锁无法识别：${lock}`);
  if (alive(pid)) throw fail('PROFILE_IN_USE', `旧数据目录仍由进程 ${pid} 使用。请保存编辑并关闭使用该目录的 UBOVM 窗口后重试：${source}`);
}
function inventory(root) {
  const entries = [];
  const walk = relative => {
    const directory = path.join(root, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if ((!relative && entry.name === 'tmp') || name === path.join('user-data', 'code.lock') || ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) continue;
      const file = path.join(root, name), info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw fail('UNSAFE_DATA_PATH', `旧数据含链接，请先处理后再迁移：${file}`);
      if (info.isSocket()) continue;
      if (info.isDirectory()) { entries.push({ name, directory: true }); walk(name); }
      else if (info.isFile()) entries.push({ name, size: info.size, mtime: info.mtimeMs });
      else throw fail('UNSAFE_DATA_PATH', `旧数据含不支持的文件类型：${file}`);
    }
  };
  walk('');
  return entries;
}
function digest(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** One-time verified copy. Old profiles remain intact; an existing target wins. */
export function migrateLegacyProfile({ source, destination }) {
  source = path.resolve(source); destination = path.resolve(destination);
  const profile = path.basename(destination), parent = path.dirname(destination);
  if (!profiles.has(profile) || path.basename(source) !== profile || path.basename(path.dirname(source)) !== '.data' || path.basename(parent) !== '.ubovm' || inside(source, destination) || inside(destination, source) || source === destination) {
    throw fail('UNSAFE_DATA_PATH', '仅允许从项目 .data/<profile> 迁移到 ~/.ubovm/<profile>。');
  }
  assertDirectory(parent); assertDirectory(destination);
  if (stat(destination)) return { status: 'existing', source, destination };
  assertDirectory(path.dirname(source)); assertDirectory(source);
  if (!stat(source)) return { status: 'missing', source, destination };
  assertInactive(source);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, '.' + profile + '-migration.lock');
  if (stat(lock)) {
    if (stat(lock).isSymbolicLink()) throw fail('UNSAFE_DATA_PATH', `迁移锁不能是链接：${lock}`);
    const owner = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(owner) || owner <= 0 || alive(owner)) throw fail('MIGRATION_IN_PROGRESS', `数据迁移正在进行或锁需检查，请稍后重试：${lock}`);
    fs.unlinkSync(lock);
  }
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('MIGRATION_IN_PROGRESS', '另一个 UBOVM 进程正在迁移数据，请稍后重试。'); throw error; }
  let staging;
  try {
    fs.writeFileSync(lockFd, String(process.pid)); fs.fsyncSync(lockFd);
    // A concurrent preparation may have finished before our lock was acquired.
    if (stat(destination)) { assertDirectory(destination); return { status: 'existing', source, destination }; }
    assertInactive(source);
    const before = inventory(source);
    staging = fs.mkdtempSync(path.join(parent, '.' + profile + '-migration-'));
    let files = 0, bytes = 0;
    for (const entry of before) {
      const from = path.join(source, entry.name), to = path.join(staging, entry.name);
      if (entry.directory) { fs.mkdirSync(to); continue; }
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (digest(from) !== digest(to)) throw fail('MIGRATION_VERIFY_FAILED', `文件迁移校验失败：${entry.name}`);
      const fd = fs.openSync(to, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      files++; bytes += entry.size;
    }
    assertInactive(source);
    if (JSON.stringify(before) !== JSON.stringify(inventory(source))) throw fail('PROFILE_CHANGED', '旧数据在复制期间发生变化，未切换目录。请关闭 UBOVM 后重试。');
    fs.writeFileSync(path.join(staging, '.ubovm-migration.json'), JSON.stringify({ version: 1, source, migratedAt: new Date().toISOString(), files, bytes }) + '\n', { flag: 'wx', mode: 0o600 });
    if (stat(destination)) throw fail('MIGRATION_CONFLICT', `目标目录已出现，未覆盖：${destination}`);
    fs.renameSync(staging, destination);
    staging = undefined;
    return { status: 'migrated', source, destination, files, bytes };
  } finally {
    // Only the freshly created sibling staging directory may be removed.
    if (staging && inside(parent, path.resolve(staging)) && path.basename(staging).startsWith('.' + profile + '-migration-')) fs.rmSync(staging, { recursive: true, force: true });
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
