import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalProcess } from '../../shared/process/local-process.mjs';
import { contained } from '../../shared/common.mjs';
import { pythonPolicy, pythonCommand, privatePythonPaths, workspacePrivatePythonPaths, omitMissingPythonDenyPaths, pythonAllowsAnyHost } from './policy.mjs';
import { validatePythonPaths, preparePythonOutput, removeEmptyPythonOutput } from './files.mjs';
import { acquirePythonLease } from './lease.mjs';
import { grantPythonHelper, assertPythonAclCleanup } from './readiness.mjs';

const harnessRoot = fileURLToPath(new URL('../../../', import.meta.url));
const failure = (code, message) => Object.assign(new Error(message), { code });
async function defaultSandboxBackend() {
  return import('@anthropic-ai/sandbox-runtime');
}
function defaultProtectedRuntimePaths() {
  return [harnessRoot, process.execPath,
    dirname(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))))))];
}

// Dependencies are injectable only in this internal module for lifecycle tests.
// The registered AI tool never accepts a backend or an isolation override.
export async function executePythonRequest(request, signal, observer = () => {}, dependencies = {}) {
  const { backend = await defaultSandboxBackend(), run = runLocalProcess, lease = acquirePythonLease, platform = process.platform,
    protectedRuntimePaths = defaultProtectedRuntimePaths() } = dependencies;
  const manager = backend.SandboxManager;
  let release, controlDirectory, tempRoot, result, error, initialized = false, prepared = false, cleanupConfirmed = true;
  let phase = 'queued', failedPhase, sandboxUserSid, srtWin, executionExitCode = null, outputPathChanged = false;
  const notify = message => {
    // A disconnected IPC channel or a failed progress observer must never skip
    // the finally block's ACL reset, temporary-file removal, or lease release.
    try { Promise.resolve(observer(message)).catch(() => {}); } catch { /* observer */ }
  };
  const setPhase = value => { phase = value; notify({ type: 'phase', phase }); };
  try {
    setPhase('queued'); release = await lease(signal); signal.throwIfAborted();
    setPhase('preflight'); await validatePythonPaths(request);
    if (!manager.isSupportedPlatform()) throw failure('PYTHON_SANDBOX_UNAVAILABLE', 'Python sandbox is unsupported on this platform');
    if (platform === 'win32') {
      srtWin = backend.resolveSrtWin({ path: backend.VENDORED_SRT_WIN_EXE });
      const state = await backend.checkWindowsSandboxStatusAsync({ srtWin });
      sandboxUserSid = state.user?.sid;
      if (!state.user?.provisioned || !state.user?.credPresent || !sandboxUserSid || !['installed', 'cannot-read'].includes(state.wfp?.state))
        throw failure('PYTHON_SANDBOX_UNAVAILABLE', 'Python sandbox is not provisioned. Use the IDE Python sandbox setup command.');
    } else {
      const deps = await manager.checkDependenciesAsync();
      if (deps.errors.length || deps.warnings.length) throw failure('PYTHON_SANDBOX_UNAVAILABLE', [...deps.errors, ...deps.warnings].join('; '));
    }
    signal.throwIfAborted();
    if ([...request.readRoots, ...protectedRuntimePaths].some(path => contained(path, request.outputDirectory)))
      throw failure('PYTHON_UNSAFE_RUNTIME_LOCATION', 'Python output directory overlaps a protected interpreter or IDE runtime. Move the workspace outside that directory.');
    setPhase('preparing'); await preparePythonOutput(request); prepared = true;
    notify({ type: 'prepared', outputDirectory: request.outputDirectory });
    tempRoot = await realpath(tmpdir()); controlDirectory = await mkdtemp(join(tempRoot, 'ubovm-python-control-'));
    // Windows grants the sandbox account read on the live workspace. A private
    // copy would hide original paths, omit most of a large tree, and fail the
    // copy budget — Python then cannot open the files the rest of the IDE sees.
    let executionRequest = request;
    if (request.code !== undefined) {
      // A real entrypoint lets Python register __main__, resolve tracebacks,
      // and re-import guarded code in multiprocessing spawn children. Keep
      // AI source read-only alongside the trusted payload, never in outputs.
      const codeFile = join(controlDirectory, 'ai-code.py');
      await writeFile(codeFile, request.code, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      executionRequest = { ...executionRequest, code: undefined, codeFile };
    }
    const payload = join(controlDirectory, 'request.json');
    await writeFile(payload, JSON.stringify(executionRequest), { mode: 0o600 });
    const privatePaths = await privatePythonPaths([executionRequest.workspace, controlDirectory, ...request.readRoots], undefined, { signal });
    const workspacePrivatePaths = await workspacePrivatePythonPaths(executionRequest.workspace, { signal });
    const policy = pythonPolicy({ ...executionRequest, controlDirectory, privatePaths, workspacePrivatePaths, protectedRuntimePaths }, platform);
    await omitMissingPythonDenyPaths(policy, platform, { signal });
    if (platform === 'win32') policy.windows = { srtWin: { path: backend.VENDORED_SRT_WIN_EXE } };
    initialized = true;
    if (platform === 'win32') grantPythonHelper(backend, sandboxUserSid, srtWin);
    await manager.initialize(policy, pythonAllowsAnyHost(executionRequest.allowedDomains) ? async () => true : undefined); signal.throwIfAborted();
    const shell = platform === 'win32' ? 'powershell' : '/bin/sh';
    const descriptor = await manager.wrapWithSandboxArgv(pythonCommand(request.executable, payload, platform), shell, undefined, signal, executionRequest.cwd);
    signal.throwIfAborted(); await validatePythonPaths(request, { requireOutput: true });
    setPhase('running');
    result = await run({ executable: descriptor.argv[0], args: descriptor.argv.slice(1), env: descriptor.env,
      cwd: executionRequest.cwd, timeout: request.timeout, maxOutputBytes: request.maxOutputBytes, label: 'Sandboxed Python', captureOutput: false },
    signal, update => notify({ type: 'output', text: update.content[0].text }));
    executionExitCode = result?.details.exit_code ?? null;
  } catch (caught) {
    error = caught; failedPhase = phase; executionExitCode = caught.details?.exit_code ?? null;
    if (caught.details?.process_closed === false) {
      cleanupConfirmed = false;
      error = failure('PYTHON_PROCESS_CLEANUP_UNCONFIRMED', `${caught.message}\nPython process or output pipes did not close before the shutdown deadline.`);
    }
    outputPathChanged = caught.code === 'PYTHON_PATH_CHANGED';
  }
  finally {
    setPhase('cleanup');
    const cleanupError = caught => {
      cleanupConfirmed = false;
      error = failure('PYTHON_CLEANUP_FAILED', `${error ? `${error.message}\n` : ''}Python sandbox cleanup failed: ${caught.message}`);
    };
    if (initialized) {
      // reset() logs native ACL failures instead of throwing. Inspect outcomes
      // explicitly so a completed script cannot be reported as fully cleaned up.
      if (platform === 'win32') {
        for (const [operation, cleanup] of [['revoke', backend.revokeWindowsAcl], ['restore', backend.restoreWindowsAcl]]) {
          try {
            const outcomes = cleanup({ sandboxUserSid, srtWin });
            assertPythonAclCleanup(outcomes, operation);
          } catch (caught) { cleanupError(caught); }
        }
      }
      try { await manager.reset(); } catch (caught) { cleanupError(caught); }
    }
    if (controlDirectory) {
      try {
        if (!contained(tempRoot, controlDirectory) || controlDirectory === tempRoot) throw new Error('Invalid control directory');
        await rm(controlDirectory, { recursive: true, force: true });
      } catch (caught) { cleanupError(caught); }
    }
    if (error && prepared) {
      try { if (await removeEmptyPythonOutput(request)) prepared = false; } catch (caught) { cleanupError(caught); }
    }
    try { await release?.(); } catch (caught) { cleanupError(caught); }
  }
  return { ...(error ? { error: String(error.message).slice(0, 8192), errorCode: error.code ?? 'PYTHON_EXECUTION_FAILED' } : {}),
    exitCode: executionExitCode,
    outputDirectory: prepared && !outputPathChanged ? request.outputDirectory : null, cleanupConfirmed, phase: failedPhase ?? 'cleanup' };
}
