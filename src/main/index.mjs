// This is the application's real Electron main process entry.
// Code OSS owns BrowserWindow, preload, IPC, lifecycle, and the extension host.
// Bootstrap it before app.ready; do not await app.whenReady() here.
import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configureDataPaths, findLegacyRoot, initializeUserSettings } from './data-paths.mjs';

// The executable can be opened without build.bat, so data isolation belongs in
// the actual Electron entry rather than only in the development launcher.
const dataPaths = configureDataPaths({ app, legacyRoot: findLegacyRoot(app.getAppPath()) });
const configuration = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
initializeUserSettings(dataPaths, configuration.settings);

// Apply the product mark to every window, including auxiliary editor windows.
app.on('browser-window-created', (_event, window) => {
  const icon = path.join(app.getAppPath(), 'extensions/ubovm-core/media/app-icon.png');
  if (process.platform !== 'darwin' && existsSync(icon)) window.setIcon(icon);
});

process.env.UBOVM_MAIN_ENTRY = 'src/main/index.mjs';
// The extension host inherits a relocatable SDK path. A development launcher
// may explicitly select the source SDK before entering this bootstrap.
process.env.UBOVM_HARNESS_ENTRY ||= path.join(app.getAppPath(), 'ubovm/harness/index.mjs');
console.log('[UBOVM] Electron main → Code OSS');
await import(pathToFileURL(path.join(app.getAppPath(), 'out/main.js')).href);
