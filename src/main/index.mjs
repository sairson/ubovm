// This is the application's real Electron main process entry.
// Code OSS owns BrowserWindow, preload, IPC, lifecycle, and the extension host.
// Bootstrap it before app.ready; do not await app.whenReady() here.
import { app, Tray, Menu, nativeImage, dialog, powerMonitor } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configureDataPaths, findLegacyRoot, initializeUserSettings } from './data-paths.mjs';
import { installBackgroundMode } from './background.mjs';
import { normalizeLaunchArguments } from './launch-policy.mjs';
import { installWindowRendering } from './window-rendering.mjs';

// The executable can be opened without build/build.bat, so data isolation belongs in
// the actual Electron entry rather than only in the development launcher.
// Avoid native occlusion and idle renderer sleeping, which leave a blank
// compositor after the window sits unused. Keep Chromium's other features.
if (process.platform === 'win32') {
  const features = app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean);
  app.commandLine.appendSwitch('disable-features', [...new Set([...features, 'CalculateNativeWinOcclusion'])].join(','));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
const dataPaths = configureDataPaths({ app, legacyRoot: findLegacyRoot(app.getAppPath()) });
process.argv.splice(0, process.argv.length, ...normalizeLaunchArguments(process.argv));
const configuration = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
initializeUserSettings(dataPaths, configuration.settings);
installWindowRendering({ app, powerMonitor });
installBackgroundMode({ app, Tray, Menu, nativeImage, dialog,
  icon: path.join(app.getAppPath(), 'resources/win32/code.ico') });

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
