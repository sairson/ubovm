'use strict';

const { mkdir } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

function defaultWorkspacePath(id, root = path.join(homedir(), '.ubovm', 'workspace')) {
  // Legacy session IDs are arbitrary strings; never interpret them as paths.
  const directory = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id : createHash('sha256').update(id).digest('hex');
  return path.resolve(root, directory);
}

async function createDefaultWorkspace(id, root) {
  const workspace = defaultWorkspacePath(id, root);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function ensureDefaultWorkspace(session, root) {
  if (!session.workspace) return;
  const expected = defaultWorkspacePath(session.id, root);
  const actual = path.resolve(session.workspace);
  const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  // Only recreate the directory owned by this session, never a selected project.
  if (same) await createDefaultWorkspace(session.id, root);
}

module.exports = { createDefaultWorkspace, ensureDefaultWorkspace };
