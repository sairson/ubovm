// This is the application's real Electron main process entry.
// Code OSS owns BrowserWindow, preload, IPC, lifecycle, and the extension host.
// Bootstrap it before app.ready; do not await app.whenReady() here.
import { app, Tray, Menu, nativeImage, dialog, powerMonitor } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configureDataPaths, checkDataPathsWritable, discardRestoredWorkbenchSession, findLegacyRoot, initializeUserSettings } from './data-paths.mjs';
import { reconcileExtensionState } from './extension-state.mjs';
import { ensureWorkbenchExtensionViews } from './workbench-compat.mjs';
import { restoreExtensionViewContainers } from './extension-views.mjs';
import { prepareExtensionDataDirectories, repairExtensionExecutableIntegrity } from './extension-permissions.mjs';
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
// Restore manifests moved by an earlier view-relocation experiment. The
// activity-bar tab strip now supplies the tabs, so extensions keep their
// contributed location.
try { restoreExtensionViewContainers(dataPaths.extensions, console); } catch (error) { console.warn('[UBOVM] Extension view restore failed:', error?.message || error); }
try { prepareExtensionDataDirectories(console); } catch (error) { console.warn('[UBOVM] Extension data permission repair failed:', error?.message || error); }
// Code OSS only reports a generic "Unable to write program user data" dialog when
// its per-session log directory cannot be created. Probe the same operation now
// and name the real blocker (restricted launch token or security software)
// instead of surfacing that dialog with no actionable fix.
const dataWritability = checkDataPathsWritable(dataPaths);
if (!dataWritability.writable) {
  const message = [
    `UBOVM 无法写入用户数据目录：${dataPaths.logs}`,
    '',
    `系统错误：${dataWritability.message || dataWritability.code || '未知错误'}`,
    '',
    '请从普通 PowerShell 窗口或资源管理器启动 UBOVM，不要从受限或沙箱终端启动。',
    '若仍失败，请打开安全软件（如火绒）的防护日志与信任区，确认是否拦截 VSCodium.exe，并把该程序加入信任。'
  ].join('\n');
  try { dialog.showErrorBox('UBOVM 无法写入用户数据', message); } catch { /* best effort */ }
  process.exit(1);
}
try { repairExtensionExecutableIntegrity(dataPaths.extensions, console); } catch (error) { console.warn('[UBOVM] Extension executable repair failed:', error?.message || error); }
// Extension enable/disable is recorded by the extension host and applied here,
// before Code OSS scans the extensions directory.
try { reconcileExtensionState(dataPaths, console); } catch (error) { console.warn('[UBOVM] Extension state reconcile failed:', error?.message || error); }
// Keep extension-contributed webview views/panels reachable even when the
// packaged workbench was built from an older UBOVM UI patch set.
try { ensureWorkbenchExtensionViews(app.getAppPath(), console); } catch (error) { console.warn('[UBOVM] Workbench extension view patch failed:', error?.message || error); }
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
  // ICO is the Windows taskbar/tray source. macOS and Linux use PNG, because a
  // menu-bar/StatusNotifier host cannot be relied on to decode an ICO buffer.
  // Read bytes instead of a filesystem path: this checkout lives under a
  // directory name that contains spaces.
  const candidates = process.platform === 'win32'
    ? ['../../resources/win32/code.ico', '../../extensions/ubovm-core/media/app-icon.ico', '../../extensions/ubovm-core/media/app-icon.png']
    : ['../../extensions/ubovm-core/media/app-icon-70.png', '../../extensions/ubovm-core/media/app-icon.png'];
  for (const relativePath of candidates) {
    try {
      const image = nativeImage.createFromBuffer(readFileSync(new URL(relativePath, import.meta.url)));
      if (!image.isEmpty()) return image;
    } catch { /* packaged layouts keep the mark in one of these relative places */ }
  }
  return undefined;
}
const windowIcon = loadPackagedIcon();
// A menu-bar entry is drawn at its native pixel size; keep it compact off Windows.
function trayIconFor(icon) {
  if (!icon || process.platform === 'win32') return icon;
  try { return icon.resize({ width: 18, height: 18 }); } catch { return icon; }
}
installBackgroundMode({ app, Tray, Menu, nativeImage, dialog, icon: trayIconFor(windowIcon) });

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
