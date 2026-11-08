// Third-party CLIs launched by extensions often write under %USERPROFILE%\\.local.
// When an earlier elevated or sandboxed run created those directories with a
// restrictive ACL, the extension host gets EPERM even though the path exists.
// Probe first (the common case is healthy) and repair only when a write fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function canWrite(directory) {
  const probe = path.join(directory, `.ubovm-write-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

function grant(directory, logger) {
  if (process.platform !== 'win32') return false;
  const user = os.userInfo().username;
  let changed = false;
  for (const args of [
    [directory, '/grant', `${user}:(OI)(CI)F`, '/T', '/C', '/Q'],
    [directory, '/setintegritylevel', 'Medium', '/T', '/C', '/Q']
  ]) {
    try {
      execFileSync('icacls', args, { windowsHide: true, stdio: 'ignore', timeout: 15000 });
      changed = true;
    } catch (error) {
      logger.warn?.(`[UBOVM] icacls failed for ${directory}:`, error?.message || error);
    }
  }
  return changed;
}

export function repairExtensionExecutableIntegrity(extensionsRoot, logger = console) {
  if (process.platform !== 'win32' || !extensionsRoot || !fs.existsSync(extensionsRoot)) return { repaired: [] };
  let lowIntegrity = false;
  try {
    const output = execFileSync('icacls', [extensionsRoot, '/C', '/Q'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    lowIntegrity = /Low Mandatory Level/i.test(output);
  } catch { return { repaired: [] }; }
  if (!lowIntegrity) return { repaired: [] };
  const repaired = [];
  const pending = [{ dir: extensionsRoot, depth: 0 }];
  while (pending.length) {
    const { dir, depth } = pending.pop();
    if (depth > 3) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push({ full, dir: full, depth: depth + 1 });
      else if (entry.isFile() && /\.(exe|cmd|bat)$/i.test(entry.name)) {
        try {
          execFileSync('icacls', [full, '/setintegritylevel', 'Medium'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
          repaired.push(full);
        } catch { /* best effort */ }
      }
    }
  }
  if (repaired.length) logger.log?.(`[UBOVM] Relabelled ${repaired.length} extension executable(s) to Medium integrity.`);
  return { repaired };
}

export function prepareExtensionDataDirectories(logger = console) {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dirs = [
    path.join(home, '.local', 'state', 'kilo'),
    path.join(home, '.local', 'share', 'kilo'),
    path.join(home, '.local', 'state'),
    path.join(home, '.local', 'share'),
    path.join(home, '.cache', 'kilo'),
    // The installer and update helpers extract into these directories. Repair
    // them too, otherwise a stale ACL can make a later setup fail with error 5.
    path.join(localAppData, 'Temp'),
    process.env.TEMP || '',
    process.env.TMP || ''
  ].filter(Boolean);
  const repaired = [];
  for (const directory of dirs) {
    try { fs.mkdirSync(directory, { recursive: true }); }
    catch (error) {
      logger.warn?.(`[UBOVM] Cannot create ${directory}:`, error?.message || error);
      continue;
    }
    if (canWrite(directory)) continue;
    if (grant(directory, logger)) repaired.push(directory);
  }
  if (repaired.length) {
    logger.log?.(`[UBOVM] Repaired extension data permissions: ${repaired.join(', ')}`);
  }
  return { repaired };
}
