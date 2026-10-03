import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateSourceInputs(root) {
  const required = ['.npmrc', '.nvmrc', '.git-blame-ignore-revs', 'package.json', 'package-lock.json',
    'build/npm/dirs.ts', 'build/npm/preinstall.ts', 'build/npm/postinstall.ts', 'build/npm/installStateHash.ts'];
  const missing = required.filter(file => {
    try { return !statSync(path.join(root, file)).isFile(); } catch { return true; }
  });
  if (missing.length) throw new Error(`Source installation inputs missing before npm installation:\n${missing.join('\n')}\nKeep these files when trimming the pinned source checkout.`);
}

export async function isSourceInstallCurrent(root) {
  validateSourceInputs(root);
  const { dirs } = await import(pathToFileURL(path.join(root, 'build/npm/dirs.ts')).href);
  validateInstallDirectories(root, dirs);
  const { isUpToDate } = await import(pathToFileURL(path.join(root, 'build/npm/installStateHash.ts')).href);
  return isUpToDate();
}

export function validateInstallDirectories(root, dirs) {
  const failures = [];
  for (const dir of dirs) {
    const target = path.resolve(root, dir);
    const relative = path.relative(root, target);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      failures.push(`Install directory escapes source root: ${dir}`);
      continue;
    }
    try {
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
      if (!statSync(path.join(target, 'package.json')).isFile()) throw new Error('missing package.json');
    } catch {
      failures.push(`Missing install directory or package.json: ${target}`);
    }
  }
  if (failures.length) throw new Error(`Source dependency check failed before npm installation:\n${failures.join('\n')}\nRestore the missing files from the pinned source checkout; do not create empty directories.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = path.resolve(process.argv[2] || 'vendor/vscode');
    if (process.argv.includes('--check-state')) {
      process.exitCode = await isSourceInstallCurrent(root) ? 0 : 1;
    } else {
      validateSourceInputs(root);
      const { dirs } = await import(pathToFileURL(path.join(root, 'build/npm/dirs.ts')).href);
      validateInstallDirectories(root, dirs);
      console.log(`[UBOVM] Verified ${dirs.length} source dependency directories.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
