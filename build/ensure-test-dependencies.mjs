import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'node_modules');

async function findRuntimeModules() {
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const roots = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules' && full.endsWith(path.join('resources', 'app', 'ubovm', 'node_modules'))) roots.push(full);
      else await walk(full, depth + 1);
    }
  }
  await walk(runtimeRoot, 0);
  return roots[0] || '';
}

try {
  await fs.access(path.join(destination, 'playwright-core', 'package.json'));
  console.log('[UBOVM] Test dependencies are ready.');
} catch {
  const source = await findRuntimeModules();
  if (!source) {
    console.error('[UBOVM] Test dependencies are missing. Run npm ci or npm run setup first.');
    process.exitCode = 1;
  } else {
    await fs.cp(source, destination, { recursive: true, errorOnExist: false });
    console.log(`[UBOVM] Reused bundled test dependencies from ${path.relative(projectRoot, source)}.`);
  }
}
