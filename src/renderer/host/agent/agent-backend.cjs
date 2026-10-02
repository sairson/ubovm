'use strict';
const path = require('node:path');
const { existsSync } = require('node:fs');

// Only the IDE host resolves the packaged backend. Browser code never loads it.
function backendModule(name) {
  const entries = [process.env.UBOVM_HARNESS_ENTRY, path.resolve(__dirname, '../../../harness/index.mjs')].filter(Boolean);
  if (!entries.some(entry => existsSync(entry))) {
    const vscode = require('vscode');
    entries.push(path.join(vscode.env.appRoot, 'ubovm/harness/index.mjs'));
  }
  const entry = entries.find(candidate => existsSync(candidate));
  if (!entry) throw new Error('Agent backend is not installed');
  return require(path.join(path.dirname(entry), 'ide/runtime', name));
}
module.exports = { backendModule };
