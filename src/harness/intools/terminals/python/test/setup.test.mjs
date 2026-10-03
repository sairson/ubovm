import test from 'node:test';
import assert from 'node:assert/strict';
import { createPythonSetup, waitForPythonSetup } from '../setup-core.mjs';
const installed = { user: { provisioned: true, credPresent: true, sid: 'test' }, wfp: { state: 'installed' } };
function fixture(options = {}) {
  const counts = { install: 0, released: 0 }; let state = {};
  const backend = { resolveSrtWin: () => ({}), checkWindowsSandboxStatusAsync: async () => state,
    grantWindowsAcl: () => {}, revokeWindowsAcl: () => [], verifyWindowsWfpEgress: async () => {},
    installWindowsSandboxAsync: async () => { counts.install++; state = installed; return {}; } };
  const setup = createPythonSetup({ backend, platform: 'win32', lease: async () => () => counts.released++, ...options });
  return { counts, backend, setup, setState: value => { state = value; } };
}
test('concurrent automatic setup installs once, checks readiness and releases the lease', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.setup({ automatic: true })));
  assert(results.every(result => result.ready)); assert.deepEqual(f.counts, { install: 1, released: 1 });
  await f.setup({ automatic: true }); assert.equal(f.counts.install, 1);
});
test('ready sandbox does not rotate credentials through reinstallation', async () => {
  const f = fixture(); f.setState(installed); await f.setup(); assert.equal(f.counts.install, 0);
});
test('cancelled automatic setup does not reprompt; external successful setup is recognized', async () => {
  const f = fixture(); f.backend.installWindowsSandboxAsync = async () => { f.counts.install++; return { cancelled: true }; };
  assert((await f.setup({ automatic: true })).cancelled);
  assert((await f.setup({ automatic: true })).cancelled); assert.equal(f.counts.install, 1);
  f.setState(installed); assert((await f.setup({ automatic: true })).ready);
});
test('failed verification is closed and an explicit command can retry setup', async () => {
  const f = fixture(); f.backend.installWindowsSandboxAsync = async () => { f.counts.install++; return {}; };
  await assert.rejects(f.setup({ automatic: true }), /仍未就绪/);
  await assert.rejects(f.setup({ automatic: true }), /仍未就绪/); assert.equal(f.counts.install, 1);
  f.backend.installWindowsSandboxAsync = async () => { f.counts.install++; f.setState(installed); return {}; };
  assert((await f.setup()).ready); assert.equal(f.counts.install, 2);
});
test('cancelling one waiter does not release the install lease or abort another waiter', async () => {
  const f = fixture(), controller = new AbortController(); let finish;
  f.backend.installWindowsSandboxAsync = () => new Promise(resolve => { finish = () => { f.setState(installed); resolve({}); }; });
  const first = waitForPythonSetup(f.setup, controller.signal), second = waitForPythonSetup(f.setup);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('stop waiting'));
  await assert.rejects(first, /stop waiting/); assert.equal(f.counts.released, 0);
  finish(); assert((await second).ready); assert.equal(f.counts.released, 1);
});

test('installed state requires helper execution permission and a successful behavioral probe', async () => {
  const f = fixture(); f.setState(installed); const calls = [];
  f.backend.VENDORED_SRT_WIN_EXE = 'C:/private/helper.exe';
  f.backend.grantWindowsAcl = options => { calls.push('grant'); assert.deepEqual(options.read, ['C:/private/helper.exe']); assert.deepEqual(options.write, []); };
  f.backend.verifyWindowsWfpEgress = async () => { calls.push('verify'); };
  f.backend.revokeWindowsAcl = () => { calls.push('revoke'); return [{ status: 'revoked' }]; };
  assert((await f.setup()).ready); assert.deepEqual(calls, ['grant', 'verify', 'revoke']); assert.equal(f.counts.install, 0);
});

test('failed behavioral probe never reports ready and still revokes helper permissions', async () => {
  const f = fixture(); f.setState(installed); let revoked = 0;
  f.backend.verifyWindowsWfpEgress = async () => { throw new Error('probe denied'); };
  f.backend.revokeWindowsAcl = () => { revoked++; return []; };
  await assert.rejects(f.setup(), /probe denied/); assert.equal(revoked, 1); assert.equal(f.counts.released, 1);
});

test('unconfirmed probe permission cleanup prevents ready status', async () => {
  const f = fixture(); f.setState(installed); f.backend.revokeWindowsAcl = () => undefined;
  await assert.rejects(f.setup(), /权限清理未确认/); assert.equal(f.counts.released, 1);
});

test('probe does not report ready when another session still holds helper permissions', async () => {
  const f = fixture(); f.setState(installed);
  f.backend.revokeWindowsAcl = () => [{ status: 'stillHeld' }];
  await assert.rejects(f.setup(), error => error.code === 'PYTHON_ACL_CLEANUP_UNCONFIRMED' && /stillHeld/.test(error.message));
  assert.equal(f.counts.released, 1);
});

test('partially failed helper grants are revoked before releasing the setup lease', async () => {
  const f = fixture(); f.setState(installed); let revoked = false;
  f.backend.grantWindowsAcl = () => { throw new Error('partial grant'); };
  f.backend.revokeWindowsAcl = () => { revoked = true; return []; };
  await assert.rejects(f.setup(), /partial grant/); assert(revoked); assert.equal(f.counts.released, 1);
});

test('expired readiness is rechecked once for concurrent callers', async () => {
  let clock = 0, probes = 0;
  const f = fixture({ now: () => clock, readyCacheMs: 100 }); f.setState(installed);
  f.backend.verifyWindowsWfpEgress = async () => { probes++; };
  await f.setup({ automatic: true });
  clock = 99; await f.setup({ automatic: true }); assert.equal(probes, 1);
  clock = 100;
  await Promise.all(Array.from({ length: 20 }, () => f.setup({ automatic: true })));
  assert.equal(probes, 2); assert.equal(f.counts.released, 2);
});

test('failed explicit recheck invalidates previously cached readiness', async () => {
  const f = fixture(); f.setState(installed); await f.setup({ automatic: true });
  f.backend.verifyWindowsWfpEgress = async () => { throw new Error('service unavailable'); };
  await assert.rejects(f.setup(), /service unavailable/);
  await assert.rejects(f.setup({ automatic: true }), /service unavailable/);
  f.backend.verifyWindowsWfpEgress = async () => {};
  assert((await f.setup({ automatic: true })).ready);
  assert.equal(f.counts.install, 0);
});

test('a transient lease failure does not permanently suppress automatic installation', async () => {
  let calls = 0;
  const f = fixture({ lease: async () => {
    if (++calls === 1) throw new Error('lease timed out');
    return () => {};
  } });
  await assert.rejects(f.setup({ automatic: true }), /lease timed out/);
  assert((await f.setup({ automatic: true })).ready); assert.equal(f.counts.install, 1);
});

test('status check failures remain retryable without an explicit setup command', async () => {
  const f = fixture(), check = f.backend.checkWindowsSandboxStatusAsync;
  f.backend.checkWindowsSandboxStatusAsync = async () => { throw new Error('status unavailable'); };
  await assert.rejects(f.setup({ automatic: true }), /status unavailable/);
  f.backend.checkWindowsSandboxStatusAsync = check;
  assert((await f.setup({ automatic: true })).ready); assert.equal(f.counts.install, 1);
});
