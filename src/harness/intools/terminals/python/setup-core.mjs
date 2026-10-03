import { verifyPythonReadiness } from './readiness.mjs';

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
