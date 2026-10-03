// The packaged helper may live inside a private user profile. The native WFP
// probe starts this same executable as the sandbox user, before normal runtime
// filesystem grants exist. Grant only this executable, never its parent tree.
export function grantPythonHelper(backend, sandboxUserSid, srtWin) {
  backend.grantWindowsAcl({ sandboxUserSid, srtWin, read: [backend.VENDORED_SRT_WIN_EXE], write: [] });
}

export function assertPythonAclCleanup(outcomes, operation) {
  const complete = operation === 'revoke' ? ['revoked', 'alreadyOriginal'] : ['revoked', 'restored', 'alreadyOriginal'];
  const pending = Array.isArray(outcomes) ? outcomes.filter(item => !item || !complete.includes(item.status)) : null;
  if (pending === null || pending.length) {
    const statuses = pending === null ? 'missing native result' : [...new Set(pending.map(item => String(item?.status ?? 'invalid result')))].join(', ').slice(0, 512);
    throw Object.assign(new Error(`Python 沙箱权限清理未确认 (${operation}: ${statuses})${pending?.some(item => item?.status === 'stillHeld') ? '；权限仍由其他会话持有，未执行全局强制回收。' : ''}`),
      { code: 'PYTHON_ACL_CLEANUP_UNCONFIRMED' });
  }
}

// Caller holds the Python lease. Every probe releases its temporary grant,
// including a partially failed grant or a failed behavioral verification.
export async function verifyPythonReadiness(backend, state, srtWin) {
  let failure;
  try {
    grantPythonHelper(backend, state.user.sid, srtWin);
    await backend.verifyWindowsWfpEgress({ srtWin });
  } catch (error) { failure = error; }
  finally {
    const outcomes = backend.revokeWindowsAcl({ sandboxUserSid: state.user.sid, srtWin });
    try { assertPythonAclCleanup(outcomes, 'revoke'); }
    catch (error) { if (failure) error.cause = failure; throw error; }
  }
  if (failure) throw failure;
}
