import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { resolveStorageDirectory, DEFAULT_MAX_DIRECTORY } = createRequire(import.meta.url)('../ide/runtime/storage-path.cjs');

async function exists(target) {
  try { await stat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-storage-path-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const base = path.join(root, '557c69b34d4dd24fd1a98b23735be02e', 'goal-3edb5b10282c5145fba3dbdadf03e960');
  const workspaceKey = '59143c31479d18c133766c4720ada62a';
  return { root, base, workspaceKey, compact: path.join(root, 'w-' + workspaceKey.slice(0, 16)) };
}

test('a short legacy workspace directory (< MAX_PATH) is kept for compatibility', async t => {
  const { root, base, workspaceKey } = await workspace(t);
  const legacy = `${base}-workspace-${workspaceKey}`;
  await mkdir(legacy, { recursive: true });
  // Even with a mismatch the legacy directory stays when it is safe: existing
  // sessions should not be moved unnecessarily.
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: true, maxDirectory: 10_000 });
  assert.equal(result.directory, legacy);
  assert.equal(result.migrated, false);
});

test('a long legacy workspace directory is migrated to the short suffix and keeps its files', async t => {
  const { root, base, workspaceKey } = await workspace(t);
  const legacy = `${base}-workspace-${workspaceKey}`;
  const short = `${base}-w${workspaceKey.slice(0, 16)}`;
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'goal-chat.json'), '{"schemaVersion":2,"threads":[]}');
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: true, maxDirectory: legacy.length - 1 });
  assert.equal(result.directory, short);
  assert.equal(result.migrated, true);
  assert.equal(await exists(legacy), false, 'the long directory was renamed away');
  assert.match(await readFile(path.join(short, 'goal-chat.json'), 'utf8'), /schemaVersion/);
  assert.ok(short.length <= legacy.length - 20, 'the short layout saves path budget');
});

test('the short workspace layout is reused once migrated', async t => {
  const { root, base, workspaceKey } = await workspace(t);
  const short = `${base}-w${workspaceKey.slice(0, 16)}`;
  await mkdir(short, { recursive: true });
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: true });
  assert.equal(result.directory, short);
  assert.equal(result.migrated, false);
});

test('a too-long short directory is moved to the compact hash layout, keeping files', async t => {
  const { root, base, workspaceKey, compact } = await workspace(t);
  const short = `${base}-w${workspaceKey.slice(0, 16)}`;
  await mkdir(short, { recursive: true });
  await writeFile(path.join(short, 'goal-chat.json'), '{"schemaVersion":2}');
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: true, maxDirectory: short.length - 1, compactDirectory: compact });
  assert.equal(result.directory, compact);
  assert.equal(result.migrated, true);
  assert.equal(await exists(short), false);
  assert.match(await readFile(path.join(compact, 'goal-chat.json'), 'utf8'), /schemaVersion/);
});

test('a fresh mismatched scope uses the 16-char suffix instead of the full workspace key', async t => {
  const { root, base, workspaceKey } = await workspace(t);
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: true });
  assert.equal(result.directory, `${base}-w${workspaceKey.slice(0, 16)}`);
  assert.equal(result.migrated, false);
  assert.equal(result.directory.length < `${base}-workspace-${workspaceKey}`.length, true);
});

test('a fresh matching scope stays on the base directory when it fits', async t => {
  const { root, base, workspaceKey } = await workspace(t);
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: false });
  assert.equal(result.directory, base);
});

test('when no directory exists and the short path is too long, the compact hash is used', async t => {
  const { root, base, workspaceKey, compact } = await workspace(t);
  const result = await resolveStorageDirectory({ root, base, workspaceKey, mismatched: false, maxDirectory: base.length - 1, compactDirectory: compact });
  assert.equal(result.directory, compact);
  assert.equal(result.migrated, false);
});

test('path budget tolerates every SQLite sidecar for a short directory', () => {
  // assist.sqlite-journal is the longest sidecar; the full path must stay under
  // the Windows MAX_PATH limit (250 chars used as the conservative budget).
  assert.ok(DEFAULT_MAX_DIRECTORY + 1 + 'assist.sqlite-journal'.length <= 250);
  assert.equal(DEFAULT_MAX_DIRECTORY, 228);
});

test('invalid workspace keys are rejected', async t => {
  const { root, base } = await workspace(t);
  await assert.rejects(resolveStorageDirectory({ root, base, workspaceKey: '../../etc', mismatched: true }), { name: 'TypeError' });
});
