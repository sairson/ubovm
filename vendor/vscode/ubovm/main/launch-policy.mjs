// Code OSS owns the single-instance IPC lock and forwards later launches to
// its primary process. Select reuse before its CLI parser without adding a
// competing Electron lock (which would swallow file/open-url requests).
export function normalizeLaunchArguments(argv) {
  const separator = argv.indexOf('--');
  const end = separator < 0 ? argv.length : separator;
  const switches = argv.slice(1, end);
  const explicit = new Set(['--new-window', '-n', '--reuse-window', '-r', '--wait', '-w', '--diff', '-d', '--merge', '-m',
    '--profile', '--profile-temp', '--extensionDevelopmentPath', '--extensionTestsPath', '--agents', '--open-url', '--add', '--remove']);
  if (switches.some(value => explicit.has(value.split('=')[0]))) return [...argv];
  return [...argv.slice(0, end), '--reuse-window', ...argv.slice(end)];
}
