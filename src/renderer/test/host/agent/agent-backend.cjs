'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

test('harnessModule resolves packaged appRoot when sibling src/harness is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ubovm-backend-'));
  const extensionHost = path.join(root, 'extensions', 'ubovm-core', 'host', 'agent');
  const packagedHarness = path.join(root, 'ubovm', 'harness');
  fs.mkdirSync(extensionHost, { recursive: true });
  fs.mkdirSync(packagedHarness, { recursive: true });
  fs.writeFileSync(path.join(packagedHarness, 'index.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(packagedHarness, 'assist-evidence.cjs'),
    "'use strict'; module.exports = { marker: 'packaged-assist-evidence' };\n");
  fs.copyFileSync(
    path.resolve(__dirname, '../../../host/agent/agent-backend.cjs'),
    path.join(extensionHost, 'agent-backend.cjs')
  );

  const previousEntry = process.env.UBOVM_HARNESS_ENTRY;
  delete process.env.UBOVM_HARNESS_ENTRY;
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function mockRequire(id) {
    if (id === 'vscode') return { env: { appRoot: root } };
    return originalRequire.apply(this, arguments);
  };
  try {
    const backend = require(path.join(extensionHost, 'agent-backend.cjs'));
    assert.equal(backend.harnessModule('assist-evidence.cjs').marker, 'packaged-assist-evidence');
    assert.equal(
      path.normalize(backend.harnessEntry()),
      path.normalize(path.join(packagedHarness, 'index.mjs'))
    );
  } finally {
    Module.prototype.require = originalRequire;
    if (previousEntry === undefined) delete process.env.UBOVM_HARNESS_ENTRY;
    else process.env.UBOVM_HARNESS_ENTRY = previousEntry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
