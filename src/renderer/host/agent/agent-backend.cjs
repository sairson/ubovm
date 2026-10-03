'use strict';
const path = require('node:path');
const { existsSync } = require('node:fs');

// Only the IDE host resolves the packaged harness. Browser code never loads it.
// Source layout: src/harness. Packaged layout: <appRoot>/ubovm/harness.
function harnessEntry() {
  const entries = [process.env.UBOVM_HARNESS_ENTRY, path.resolve(__dirname, '../../../harness/index.mjs')].filter(Boolean);
  if (!entries.some(entry => existsSync(entry))) {
    const vscode = require('vscode');
    entries.push(path.join(vscode.env.appRoot, 'ubovm/harness/index.mjs'));
  }
  const entry = entries.find(candidate => existsSync(candidate));
  if (!entry) throw new Error('Agent backend is not installed');
  return entry;
}

function backendModule(name) {
  return require(path.join(path.dirname(harnessEntry()), 'ide/runtime', name));
}

function harnessModule(name) {
  return require(path.join(path.dirname(harnessEntry()), name));
}

module.exports = { backendModule, harnessModule, harnessEntry };
