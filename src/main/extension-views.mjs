// Move third-party activity-bar view containers into the secondary sidebar.
//
// VS Code's activity bar can only show one container at a time: opening a
// second plugin replaces the first. The secondary sidebar supports multiple
// pinned containers, which gives each extension a persistent tab. UBOVM owns
// the extension host, so relocate user-installed extension manifests before
// Code OSS scans them; VSIX updates are re-relocated on the next launch.
import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function restoreExtensionViewContainers(extensionsRoot, logger = console) {
  if (!extensionsRoot || !fs.existsSync(extensionsRoot)) return { restored: [] };
  const restored = [];
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const manifestPath = path.join(extensionsRoot, entry.name, 'package.json');
    const backup = manifestPath + '.ubovm-backup';
    if (!fs.existsSync(backup)) continue;
    try {
      fs.copyFileSync(backup, manifestPath);
      fs.rmSync(backup, { force: true });
      restored.push(entry.name);
    } catch (error) {
      logger.warn?.('[UBOVM] Unable to restore extension manifest:', entry.name, error?.message || error);
    }
  }
  if (restored.length) logger.log?.(`[UBOVM] Restored extension view manifests: ${restored.join(', ')}`);
  return { restored };
}

export function relocateExtensionViewContainers(extensionsRoot, logger = console) {
  if (!extensionsRoot || !fs.existsSync(extensionsRoot)) return { relocated: [] };
  const relocated = [];
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const manifestPath = path.join(extensionsRoot, entry.name, 'package.json');
    let manifest;
    try { manifest = readJson(manifestPath); }
    catch { continue; }
    if (!manifest || typeof manifest !== 'object') continue;
    const containers = manifest.contributes?.viewsContainers;
    if (!containers || typeof containers !== 'object') continue;
    const activity = Array.isArray(containers.activitybar) ? containers.activitybar : [];
    if (!activity.length) continue;
    const secondary = Array.isArray(containers.secondarySidebar) ? containers.secondarySidebar : [];
    const secondaryIds = new Set(secondary.map(item => item?.id).filter(Boolean));
    // Only relocate when ids are unambiguous; otherwise leave the plugin alone.
    if (activity.some(item => !item?.id || secondaryIds.has(item.id))) continue;
    containers.secondarySidebar = [...secondary, ...activity];
    delete containers.activitybar;
    try {
      const backup = manifestPath + '.ubovm-backup';
      if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      relocated.push(manifest.publisher && manifest.name ? `${manifest.publisher}.${manifest.name}` : entry.name);
    } catch (error) {
      logger.warn?.('[UBOVM] Unable to relocate extension views:', entry.name, error?.message || error);
    }
  }
  if (relocated.length) logger.log?.(`[UBOVM] Moved extension views to the secondary sidebar: ${relocated.join(', ')}`);
  return { relocated };
}
