// This is the application's real Electron main process entry.
// Code OSS owns BrowserWindow, preload, IPC, lifecycle, and the extension host.
// Bootstrap it before app.ready; do not await app.whenReady() here.
import { app, Tray, Menu, nativeImage, dialog, powerMonitor } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configureDataPaths, discardRestoredWorkbenchSession, findLegacyRoot, initializeUserSettings } from './data-paths.mjs';
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
  // Escape hatch for machines where the DirectComposition-only window surface
  // still stops presenting. It changes the native render path, so it stays
  // opt-in instead of becoming the default for every Windows GPU.
  if (process.env.UBOVM_DISABLE_DIRECT_COMPOSITION === '1') {
    app.commandLine.appendSwitch('disable-direct-composition');
  }
}
// Skia Graphite can stop presenting the window surface after idle; only the
// native caption buttons remain until a resize. VS Code disables this backend
// for the same failure (microsoft/vscode#263554). It is a no-op where Graphite
// is already disabled, so keep the guard on every platform.
app.commandLine.appendSwitch('disable-skia-graphite');

const dataPaths = configureDataPaths({ app, legacyRoot: findLegacyRoot(app.getAppPath()) });
process.argv.splice(0, process.argv.length, ...normalizeLaunchArguments(process.argv));
const configuration = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
initializeUserSettings(dataPaths, configuration.settings);
discardRestoredWorkbenchSession(dataPaths);
installWindowRendering({ app, powerMonitor });
// Keep the compositor diagnosis in the launcher log. Without this, a blank
// window report cannot tell whether Graphite or hardware compositing was in use.
app.whenReady().then(() => {
  try {
    const status = app.getGPUFeatureStatus();
    console.log('[UBOVM] GPU feature status:', JSON.stringify({
      gpuCompositing: status.gpu_compositing,
      rasterization: status.rasterization,
      skiaGraphite: status.skia_graphite,
      directComposition: process.env.UBOVM_DISABLE_DIRECT_COMPOSITION === '1' ? 'disabled' : 'default'
    }));
  } catch (error) {
    console.warn('[UBOVM] GPU feature status unavailable.', error);
  }
}).catch(() => {});

// Resolve the mark from this module. An absolute path breaks Windows icons
// when the install directory contains spaces.
function loadPackagedIcon() {
  // ICO is the Windows taskbar/tray source. PNG is the fallback when a runtime
  // cannot decode an ICO buffer. Read bytes instead of a filesystem path: this
  // checkout lives under a directory name that contains spaces.
  for (const relativePath of [
    '../../resources/win32/code.ico',
    '../../extensions/ubovm-core/media/app-icon.ico',
    '../../extensions/ubovm-core/media/app-icon.png'
  ]) {
    try {
      const image = nativeImage.createFromBuffer(readFileSync(new URL(relativePath, import.meta.url)));
      if (!image.isEmpty()) return image;
    } catch { /* packaged layouts keep the mark in one of these relative places */ }
  }
  return undefined;
}
const windowIcon = loadPackagedIcon();
installBackgroundMode({ app, Tray, Menu, nativeImage, dialog, icon: windowIcon });

// Apply the product mark to every window, including auxiliary editor windows.
app.on('browser-window-created', (_event, window) => {
  if (process.platform !== 'darwin' && windowIcon) window.setIcon(windowIcon);
});

process.env.UBOVM_MAIN_ENTRY = 'src/main/index.mjs';
// The extension host inherits a relocatable SDK path. A development launcher
// may explicitly select the source SDK before entering this bootstrap.
process.env.UBOVM_HARNESS_ENTRY ||= path.join(app.getAppPath(), 'ubovm/harness/index.mjs');
console.log('[UBOVM] Electron main → Code OSS');
await import(pathToFileURL(path.join(app.getAppPath(), 'out/main.js')).href);
