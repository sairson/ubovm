import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPythonReadiness } from './readiness.mjs';

const execFileAsync = promisify(execFile);

// Windows sandbox state lives under %LOCALAPPDATA%\sandbox-runtime. An
// interrupted elevated ACL pass can leave .acl-init.lock owned by the sandbox
// account, which then fails with EACCES for the normal desktop user. Repair the
// directory ACL before retrying install instead of asking the user to reinstall.
async function repairWindowsSandboxAcl() {
  if (process.platform !== 'win32') return;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const directory = path.join(local, 'sandbox-runtime');
  const lock = path.join(directory, '.acl-init.lock');
  await mkdir(directory, { recursive: true }).catch(() => {});
  try {
    await access(lock, fsConstants.R_OK | fsConstants.W_OK);
    return;
  } catch (error) {
    // Missing lock is normal; only an existing but inaccessible lock needs repair.
    if (error?.code === 'ENOENT') return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  const trustee = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  for (const args of [
    [directory, '/grant', `${trustee}:(OI)(CI)F`, '/T', '/C'],
    [lock, '/grant', `${trustee}:F`, '/C']
  ]) {
    try { await execFileAsync('icacls', args, { windowsHide: true, timeout: 30000 }); }
    catch { /* ownership may require elevation; the setup error stays actionable */ }
  }
  // A stale lock can be dropped after the grant attempt; the runtime recreates it.
  await rm(lock, { force: true }).catch(() => {});
  try {
    await access(lock, fsConstants.F_OK);
    await access(lock, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    // A missing lock is fine: the runtime creates it when needed.
    if (error?.code === 'ENOENT') return;
    throw Object.assign(new Error(
      `Python 沙箱锁文件仍无权限：${lock}\n` +
      '请以管理员身份执行：\n' +
      `  takeown /f "${directory}" /r /d y\n` +
      `  icacls "${directory}" /grant "${trustee}:(OI)(CI)F" /T /C\n` +
      '然后运行“UBOVM: 初始化 Python 沙箱”。'
    ), { code: 'PYTHON_SANDBOX_ACL_DENIED' });
  }
}

const ready = state => Boolean(state.user?.provisioned && state.user?.credPresent && state.user?.sid
  && ['installed', 'cannot-read'].includes(state.wfp?.state));

// Keep installation outside cancellable execution children: elevated setup may
// outlive a cancelled script. The lease stays held until installation settles.
export function createPythonSetup({ backend, lease, platform, now = () => performance.now(), readyCacheMs = 60000 }) {
  let pending, readyResult, readyUntil = 0, previousFailure;
  return function setup({ automatic = false } = {}) {
    if (pending) return pending;
    if (automatic && readyResult && now() < readyUntil) return Promise.resolve(readyResult);
    // Never reuse a successful probe after a failed explicit recheck. Cached
    // readiness expires so external account/service changes are detected.
    readyResult = undefined;
    let attemptedInstall = false;
    pending = (async () => {
      if (platform !== 'win32') return { message: platform === 'linux'
        ? 'Linux 需要安装 bubblewrap、socat 和 ripgrep；默认使用内置 Python，可在设置中指定解释器。'
        : 'macOS 使用系统 sandbox-exec；默认使用内置 Python，可在设置中指定解释器。' };
      const release = await lease(AbortSignal.timeout(120000));
      try {
        await repairWindowsSandboxAcl();
        const srtWin = backend.resolveSrtWin({ path: backend.VENDORED_SRT_WIN_EXE });
        let state = await backend.checkWindowsSandboxStatusAsync({ srtWin });
        if (ready(state)) {
          await verifyPythonReadiness(backend, state, srtWin);
          return { ready: true, message: 'Python 沙箱已就绪，进程启动及网络隔离探测通过。' };
        }
        if (automatic && previousFailure) {
          if (previousFailure instanceof Error) throw previousFailure;
          return previousFailure;
        }
        attemptedInstall = true;
        await repairWindowsSandboxAcl();
        const result = await backend.installWindowsSandboxAsync({ srtWin });
        if (result.cancelled) return { cancelled: true, message: '已取消 Python 沙箱初始化。可通过“UBOVM: 初始化 Python 沙箱”重试。' };
        state = await backend.checkWindowsSandboxStatusAsync({ srtWin });
        if (!ready(state)) throw new Error('Python 沙箱初始化后仍未就绪，请通过“UBOVM: 初始化 Python 沙箱”重试。');
        await verifyPythonReadiness(backend, state, srtWin);
        return { ready: true, message: 'Python 沙箱已自动准备完成，默认使用内置 Python，可在设置中指定解释器。' };
      } finally { await release(); }
    })();
    // A cancelled/failed automatic attempt is remembered to avoid repeated UAC
    // prompts. The explicit setup command can retry it.
    pending.then(result => {
      readyResult = result.ready ? result : undefined;
      readyUntil = result.ready ? now() + readyCacheMs : 0;
      previousFailure = result.cancelled ? result : undefined; pending = undefined;
    }, error => {
      // Lease contention and status/probe failures did not prompt for UAC.
      // They must remain retryable instead of poisoning automatic installation.
      if (attemptedInstall) previousFailure = error;
      pending = undefined;
    });
    return pending;
  };
}

export async function waitForPythonSetup(setup, signal) {
  signal?.throwIfAborted();
  let cancel;
  const aborted = signal && new Promise((_, reject) => {
    cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    const result = await (aborted ? Promise.race([setup({ automatic: true }), aborted]) : setup({ automatic: true }));
    signal?.throwIfAborted();
    if (result.cancelled) throw Object.assign(new Error(result.message), { code: 'PYTHON_SANDBOX_SETUP_CANCELLED' });
    return result;
  } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}
