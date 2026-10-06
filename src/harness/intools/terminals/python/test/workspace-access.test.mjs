import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executePythonRequest } from '../runner-core.mjs';
import { contained } from '../../../shared/common.mjs';

async function fixture(t) {
  const root = await realpath(tmpdir()), directory = await mkdtemp(join(root, 'ubovm-python-access-'));
  t.after(() => {
    const child = relative(root, directory);
    assert(child && !child.startsWith('..') && !isAbsolute(child));
    return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  return { request: { workspace, cwd: workspace, executable: process.execPath, readRoots: [], code: 'print(1)', arguments: [],
    outputDirectory: join(workspace, '.ubovm-python-output', `run-${randomUUID()}`), timeout: 5, maxOutputBytes: 1024 } };
}

test('readonly sandbox grants the live workspace instead of a private copy', async t => {
  const { request } = await fixture(t);
  await writeFile(join(request.workspace, 'data.csv'), 'a,b');
  const calls = [];
  const backend = {
    VENDORED_SRT_WIN_EXE: 'test-helper', resolveSrtWin: () => ({}), grantWindowsAcl: () => {},
    checkWindowsSandboxStatusAsync: async () => ({ user: { provisioned: true, credPresent: true, sid: 'fixture' }, wfp: { state: 'installed' } }),
    revokeWindowsAcl: () => [], restoreWindowsAcl: () => [],
    SandboxManager: {
      isSupportedPlatform: () => true,
      initialize: async policy => {
        const payload = JSON.parse(await readFile(join(policy.filesystem.allowRead[1], 'request.json'), 'utf8'));
        assert.equal(payload.workspace, request.workspace);
        assert.equal(payload.cwd, request.cwd);
        assert(policy.filesystem.allowRead.includes(request.workspace));
        assert(contained(policy.filesystem.allowRead[1], payload.codeFile));
        assert.equal(await readFile(join(payload.workspace, 'data.csv'), 'utf8'), 'a,b');
      },
      wrapWithSandboxArgv: async () => ({ argv: ['fixture'] }),
      reset: async () => {}
    }
  };
  const result = await executePythonRequest(request, new AbortController().signal, undefined, {
    backend, platform: 'win32', protectedRuntimePaths: [],
    lease: async () => () => {},
    run: async options => {
      calls.push(options.cwd);
      return { details: { exit_code: 0 } };
    }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.snapshot, undefined);
  assert.deepEqual(calls, [request.cwd]);
});
