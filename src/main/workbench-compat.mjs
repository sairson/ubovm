// Workbench compatibility shims for third-party extension view containers.
//
// UBOVM's UI patches intentionally keep only a few built-in panes visible. That
// also hid extension-contributed webview views and panels. This module is
// applied by the Electron main process before Code OSS imports its workbench,
// so it works for an existing packaged runtime without a rebuild as well.
//
// The replacements are deliberately conservative: they only append a
// `startsWith('workbench.view.extension.')` allowance to existing checks and
// leave the file untouched when the expected minified patterns are absent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function allowExtensionContainers(source) {
  const extensionPrefix = 'workbench.view.extension.';
  let next = source;

  // `id !== "terminal" && id !== "workbench.view.extension.ubovm-workers"`
  next = next.replace(
    /([A-Za-z_$][\w$]*)!=="terminal"&&\1!=="workbench\.view\.extension\.ubovm-workers"(?!&&!\1\.startsWith\("workbench\.view\.extension\."\))/g,
    `$1!=="terminal"&&$1!=="workbench.view.extension.ubovm-workers"&&!$1.startsWith("${extensionPrefix}")`
  );

  // `id === "terminal" || id === "workbench.view.extension.ubovm-workers"`
  next = next.replace(
    /([A-Za-z_$][\w$]*)==="terminal"\|\|\1==="workbench\.view\.extension\.ubovm-workers"(?!\|\|\1\.startsWith\("workbench\.view\.extension\."\))/g,
    `$1==="terminal"||$1==="workbench.view.extension.ubovm-workers"||$1.startsWith("${extensionPrefix}")`
  );

  // `item.id === "terminal" || item.id === "...workers"`
  next = next.replace(
    /([A-Za-z_$][\w$]*)\.id==="terminal"\|\|\1\.id==="workbench\.view\.extension\.ubovm-workers"(?!\|\|\1\.id\.startsWith\("workbench\.view\.extension\."\))/g,
    `$1.id==="terminal"||$1.id==="workbench.view.extension.ubovm-workers"||$1.id.startsWith("${extensionPrefix}")`
  );

  return next;
}

export function ensureWorkbenchExtensionViews(appRoot, logger = console) {
  if (!appRoot || typeof appRoot !== 'string') return false;
  const file = path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch { return false; }
  const patched = allowExtensionContainers(source);
  try {
    if (patched !== source) fs.writeFileSync(file, patched);
    // The workbench is covered by product.json checksums. Recompute the digest
    // whenever it differs, including after a previous manual patch.
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
    for (const name of ['product.json', 'product.ubovm-base.json']) {
      const productFile = path.join(appRoot, name);
      try {
        const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
        if (!product.checksums || typeof product.checksums !== 'object') product.checksums = {};
        if (product.checksums['vs/workbench/workbench.desktop.main.js'] === digest) continue;
        product.checksums['vs/workbench/workbench.desktop.main.js'] = digest;
        fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n');
      } catch { /* product file may not exist in a development runtime */ }
    }
    if (patched !== source) logger.log?.('[UBOVM] Enabled extension view containers in the workbench.');
    return patched !== source;
  } catch (error) {
    logger.warn?.('[UBOVM] Unable to patch workbench extension views:', error?.message || error);
    return false;
  }
}
