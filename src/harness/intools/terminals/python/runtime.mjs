import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function bundledPythonCandidates({ platform = process.platform, arch = process.arch, moduleURL = import.meta.url } = {}) {
  const executable = platform === 'win32' ? 'python.exe' : 'bin/python3';
  return [
    // Installed: resources/app/ubovm/{harness,runtime/python}.
    join(fileURLToPath(new URL('../../../../runtime/python/', moduleURL)), executable),
    // Source checkout: .runtime/python-<platform>-<arch>.
    join(fileURLToPath(new URL(`../../../../../.runtime/python-${platform}-${arch}/`, moduleURL)), executable)
  ];
}
