'use strict';

const { mkdir } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function createDefaultWorkspace(id, root = path.join(homedir(), '.ubovm', 'workspace')) {
  // Legacy session IDs are arbitrary strings; never interpret them as paths.
  const directory = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id : createHash('sha256').update(id).digest('hex');
  const workspace = path.resolve(root, directory);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

module.exports = { createDefaultWorkspace };
