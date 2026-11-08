import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { protectPayload, verifyPayload } from '../../../build/protect.mjs';
import { buildAsar, readAsar, encryptAsar, decryptAsar, keyFromSecret } from '../../../build/asar.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ubovm-protect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload');
  const appRoot = path.join(payload, 'resources', 'app');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(path.join(appRoot, 'package.json'), '{"name":"VSCodium","main":"./ubovm/main/index.mjs"}');
  const write = (relative, content) => {
    const target = path.join(appRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  return { root, payload, appRoot, write };
}

test('ASAR container round-trips files and encrypted bytes', () => {
  const files = new Map([
    ['ubovm/main/index.mjs', Buffer.from('export const value = 1;\n')],
    ['ubovm/harness/index.mjs', Buffer.from('export const harness = 2;\n')],
    ['extensions/ubovm-core/media/icon.svg', Buffer.from('<svg/>')]
  ]);
  const asar = buildAsar(files);
  const parsed = readAsar(asar);
  assert.deepEqual([...parsed.keys()].sort(), [...files.keys()].sort());
  for (const [name, data] of files) assert.deepEqual(parsed.get(name), data);
  const key = keyFromSecret('unit-test-key');
  const container = encryptAsar(asar, key);
  assert.notDeepEqual(container.subarray(0, 8), asar.subarray(0, 8));
  assert.deepEqual(readAsar(decryptAsar(container, key)), parsed);
  assert.throws(() => decryptAsar(container, keyFromSecret('wrong-key')));
});

test('protected payload keeps only encrypted archives, stubs and runtime data', async t => {
  const { payload, appRoot, write } = fixture(t);
  write('ubovm/main/index.mjs', '// main comment\nimport { x } from "./util.mjs";\nexport const value = x + 1;\n');
  write('ubovm/main/util.mjs', 'export const x = 41; // internal value\n');
  write('ubovm/app.json', '{"settings":{}}\n');
  write('ubovm/harness/index.mjs', 'export function createHarness() { return { ok: true }; }\n');
  write('ubovm/harness/README.md', '# internals\n');
  write('ubovm/harness/index.d.mts', 'export declare function createHarness(): unknown;\n');
  write('ubovm/harness/test/secret.test.mjs', 'export const leaked = true;\n');
  write('ubovm/harness/agents/skills/alpha/SKILL.md', '# Alpha skill\n');
  write('ubovm/harness/intools/example/tool.py', 'print("tool")\n');
  write('ubovm/.harness-source.json', '{"digest":"abc"}\n');
  write('extensions/ubovm-core/package.json', '{"name":"ubovm-core","main":"./extension.cjs"}');
  write('extensions/ubovm-core/extension.cjs', '// extension comment\nconst fs = require("node:fs");\nfunction activate(context) { context.subscriptions.push({ dispose() {} }); }\nmodule.exports = { activate };\n');
  write('extensions/ubovm-core/host/worker.cjs', 'const value = "worker";\nmodule.exports = { value };\n');
  write('extensions/ubovm-core/harness/adapter.cjs', 'module.exports = { adapter: true };\n');
  write('extensions/ubovm-core/webview/app.js', '// webview comment\n(() => { const label = "hello"; window.ubovmLabel = label; })();\n');
  write('extensions/ubovm-core/webview/styles.css', '/* surface */\n:root { --ink: #111111; }\n');
  write('extensions/ubovm-core/media/icon.svg', '<svg></svg>');
  write('extensions/ubovm-core/themes/NOTICE.md', '# theme notice\n');
  write('extensions/ubovm-core/themes/ubovm-dark.json', '{"name":"dark"}');
  write('extensions/ubovm-core/l10n/bundle.l10n.en.json', '{}');
  write('extensions/ubovm-core/README.md', '# design docs\n');
  write('extensions/ubovm-core/test/leak.mjs', 'export const leaked = true;\n');
  write('extensions/ubovm-core/workbench/workbench.css', '.x { color: red; }\n');

  const report = await protectPayload(payload);
  assert.equal(report.alreadyProtected, false);
  assert.equal(report.archives.length, 2, JSON.stringify(report.archives));

  // Encrypted ASAR archives and tiny stubs replace the source trees.
  for (const archive of ['ubovm/ubovm.pak', 'extensions/ubovm-core/core.pak']) {
    const file = path.join(appRoot, archive);
    assert.equal(existsSync(file), true, archive + ' must exist');
    assert.ok(statSync(file).size > 100, archive + ' must not be empty');
  }
  assert.equal(existsSync(path.join(appRoot, 'ubovm', 'main', 'util.mjs')), false);
  assert.equal(existsSync(path.join(appRoot, 'ubovm', 'harness')), false);
  assert.equal(existsSync(path.join(appRoot, 'extensions', 'ubovm-core', 'host')), false);
  assert.equal(existsSync(path.join(appRoot, 'extensions', 'ubovm-core', 'harness')), false);
  assert.equal(existsSync(path.join(appRoot, 'extensions', 'ubovm-core', 'webview')), false);
  const mainStub = readFileSync(path.join(appRoot, 'ubovm', 'main', 'index.mjs'), 'utf8');
  assert.match(mainStub, /materialize/);
  assert.match(mainStub, /UBOVM_HARNESS_ENTRY/);
  const extensionStub = readFileSync(path.join(appRoot, 'extensions', 'ubovm-core', 'extension.cjs'), 'utf8');
  assert.match(extensionStub, /materialize/);
  assert.ok(extensionStub.length < 4000);
  // Files Code OSS scans before the extension runs stay readable.
  for (const kept of [
    'extensions/ubovm-core/package.json', 'extensions/ubovm-core/themes/NOTICE.md',
    'extensions/ubovm-core/themes/ubovm-dark.json', 'extensions/ubovm-core/l10n/bundle.l10n.en.json',
    'extensions/ubovm-core/media/icon.svg'
  ]) assert.equal(existsSync(path.join(appRoot, kept)), true, kept + ' must stay readable');
  for (const removed of [
    'ubovm/harness/README.md', 'ubovm/harness/index.d.mts', 'ubovm/harness/test',
    'ubovm/.harness-source.json', 'extensions/ubovm-core/README.md',
    'extensions/ubovm-core/test', 'extensions/ubovm-core/workbench'
  ]) assert.equal(existsSync(path.join(appRoot, removed)), false, removed + ' must not ship');

  // The runtime loader decrypts the main archive into a cache tree.
  const loader = createRequire(import.meta.url)(path.join(appRoot, 'ubovm', 'protected', 'runtime.cjs'));
  assert.equal(typeof loader.materialize, 'function');
  const cache = path.join(tmpdir(), 'ubovm-protect-test-' + process.pid + '-' + Date.now());
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const root = loader.materialize(path.join(appRoot, 'ubovm', 'ubovm.pak'), 'main', cache);
  const extractedMain = readFileSync(path.join(root, 'ubovm', 'main', 'index.mjs'), 'utf8');
  assert.match(extractedMain, /value/);
  assert.equal(existsSync(path.join(root, 'ubovm', 'harness', 'agents', 'skills', 'alpha', 'SKILL.md')), true);
  // A second materialize reuses the extracted cache.
  assert.equal(loader.materialize(path.join(appRoot, 'ubovm', 'ubovm.pak'), 'main', cache), root);

  assert.deepEqual(await verifyPayload(payload), []);
  // Any development file written back into the payload is detected.
  write('ubovm/leaked-notes.md', '# internals\n');
  assert.deepEqual(await verifyPayload(payload), ['ubovm/leaked-notes.md']);
});

test('protection is idempotent and reports the archive step', async t => {
  const { payload, appRoot, write } = fixture(t);
  write('ubovm/main/index.mjs', '// comment\nexport const value = 1;\n');
  write('ubovm/harness/index.mjs', 'export const harness = 1;\n');
  write('extensions/ubovm-core/package.json', '{"name":"ubovm-core","main":"./extension.cjs"}');
  write('extensions/ubovm-core/extension.cjs', '// comment\nmodule.exports = { activate() {} };\n');
  write('extensions/ubovm-core/host/agent.cjs', 'module.exports = {};\n');
  const first = await protectPayload(payload);
  assert.ok(first.archives.some(entry => entry.archive === 'ubovm/ubovm.pak'));
  assert.ok(first.archives.some(entry => entry.archive === 'extensions/ubovm-core/core.pak'));
  assert.ok(first.bytesAfter > 0);
  assert.ok(first.bytesAfter < first.bytesBefore);
  const marker = JSON.parse(readFileSync(path.join(appRoot, '.ubovm-protected.json'), 'utf8'));
  assert.equal(marker.format, 'asar-aes-256-gcm');
  assert.equal(marker.archives.length, 2);
  const second = await protectPayload(payload);
  assert.equal(second.alreadyProtected, true);
  assert.deepEqual(await verifyPayload(payload), []);
});
